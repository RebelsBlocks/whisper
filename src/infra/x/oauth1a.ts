import crypto from 'crypto';
import { config } from '../../config/index.js';

export type OAuth1aToken = { key: string; secret: string };

type RequestTokenResponse = {
  oauth_token: string;
  oauth_token_secret: string;
  oauth_callback_confirmed?: string;
};

type AccessTokenResponse = {
  oauth_token: string;
  oauth_token_secret: string;
  user_id?: string;
  screen_name?: string;
};

// In-memory store for the one-time connect flow (request token -> callback -> access token).
// This is intentionally ephemeral: if the server restarts mid-flow, the operator can restart.
const pendingRequestSecrets = new Map<string, string>();

function rfc3986Encode(v: string): string {
  return encodeURIComponent(v).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function nonce(): string {
  // ASCII-only nonce (docs requirement)
  return crypto.randomBytes(16).toString('hex');
}

function baseUrlOf(rawUrl: string): string {
  const u = new URL(rawUrl);
  return `${u.protocol}//${u.host}${u.pathname}`;
}

function normalizedParamString(params: Array<[string, string]>): string {
  // Percent-encode keys/values first, then sort.
  const enc = params.map(([k, v]) => [rfc3986Encode(k), rfc3986Encode(v)] as [string, string]);
  enc.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  return enc.map(([k, v]) => `${k}=${v}`).join('&');
}

function signHmacSha1(baseString: string, consumerSecret: string, tokenSecret?: string): string {
  const key = `${rfc3986Encode(consumerSecret)}&${rfc3986Encode(tokenSecret ?? '')}`;
  return crypto.createHmac('sha1', key).update(baseString).digest('base64');
}

function buildOAuth1aHeader(params: Record<string, string>): string {
  const parts = Object.entries(params)
    .filter(([k]) => k.startsWith('oauth_'))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${rfc3986Encode(k)}="${rfc3986Encode(v)}"`);
  return `OAuth ${parts.join(', ')}`;
}

function parseForm(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const sp = new URLSearchParams(text);
  for (const [k, v] of sp.entries()) out[k] = v;
  return out;
}

function oauthHeader(
  method: 'GET' | 'POST',
  url: string,
  token?: OAuth1aToken,
  opts?: {
    extraOAuthParams?: Record<string, string>;
    queryParams?: Record<string, string>;
    bodyParams?: Record<string, string>;
  }
): string {
  if (!config.xConsumerKey || !config.xConsumerSecret) {
    throw new Error('X consumer credentials not configured (X_CONSUMER_KEY, X_CONSUMER_SECRET)');
  }

  const ts = Math.floor(Date.now() / 1000).toString();
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: config.xConsumerKey,
    oauth_nonce: nonce(),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: ts,
    oauth_version: '1.0',
    ...(token ? { oauth_token: token.key } : {}),
    ...(opts?.extraOAuthParams ?? {}),
  };

  const params: Array<[string, string]> = [];

  // URL query
  const u = new URL(url);
  for (const [k, v] of u.searchParams.entries()) params.push([k, v]);
  // Explicit query params (if caller builds URL separately)
  if (opts?.queryParams) for (const [k, v] of Object.entries(opts.queryParams)) params.push([k, v]);
  // Body params (x-www-form-urlencoded only; JSON bodies are excluded by spec)
  if (opts?.bodyParams) for (const [k, v] of Object.entries(opts.bodyParams)) params.push([k, v]);
  // OAuth params (excluding signature)
  for (const [k, v] of Object.entries(oauthParams)) params.push([k, v]);

  const base = baseUrlOf(url);
  const paramString = normalizedParamString(params);
  const baseString = `${method.toUpperCase()}&${rfc3986Encode(base)}&${rfc3986Encode(paramString)}`;
  const signature = signHmacSha1(baseString, config.xConsumerSecret, token?.secret);
  oauthParams.oauth_signature = signature;

  return buildOAuth1aHeader(oauthParams);
}

export async function startXOAuth1aConnectFlow(callbackUrl: string): Promise<{
  authorizeUrl: string;
  requestToken: string;
}> {
  const url = 'https://api.twitter.com/oauth/request_token';
  const header = oauthHeader('POST', url, undefined, { extraOAuthParams: { oauth_callback: callbackUrl } });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: header,
      Accept: 'application/x-www-form-urlencoded',
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`X request_token failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const parsed = parseForm(text) as unknown as RequestTokenResponse;
  if (!parsed.oauth_token || !parsed.oauth_token_secret) {
    throw new Error(`X request_token invalid response: ${text.slice(0, 200)}`);
  }

  pendingRequestSecrets.set(parsed.oauth_token, parsed.oauth_token_secret);

  // Docs example uses api.x.com for authorize URL.
  const authorizeUrl = `https://api.x.com/oauth/authorize?oauth_token=${encodeURIComponent(parsed.oauth_token)}`;
  return { authorizeUrl, requestToken: parsed.oauth_token };
}

export async function finishXOAuth1aConnectFlow(oauthToken: string, oauthVerifier: string): Promise<{
  accessToken: string;
  accessTokenSecret: string;
  userId?: string;
  screenName?: string;
}> {
  const requestSecret = pendingRequestSecrets.get(oauthToken);
  if (!requestSecret) {
    throw new Error('Unknown or expired oauth_token (restart /auth/x/start)');
  }
  pendingRequestSecrets.delete(oauthToken);

  const url = 'https://api.twitter.com/oauth/access_token';
  const header = oauthHeader('POST', url, { key: oauthToken, secret: requestSecret }, { bodyParams: { oauth_verifier: oauthVerifier } });

  // Send oauth_verifier in body (form-encoded). oauth_token is already in the OAuth header.
  const body = new URLSearchParams({ oauth_verifier: oauthVerifier }).toString();

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: header,
      Accept: 'application/x-www-form-urlencoded',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`X access_token failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const parsed = parseForm(text) as unknown as AccessTokenResponse;
  if (!parsed.oauth_token || !parsed.oauth_token_secret) {
    throw new Error(`X access_token invalid response: ${text.slice(0, 200)}`);
  }

  return {
    accessToken: parsed.oauth_token,
    accessTokenSecret: parsed.oauth_token_secret,
    userId: parsed.user_id,
    screenName: parsed.screen_name,
  };
}

export function buildOAuth1aAuthHeader(method: 'GET' | 'POST', url: string, token: OAuth1aToken): string {
  return oauthHeader(method, url, token);
}


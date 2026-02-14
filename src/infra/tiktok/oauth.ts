/**
 * TikTok Login Kit OAuth (PKCE). Used by /auth/tiktok/start and /auth/tiktok/callback.
 * No third-party tunnel: redirect_uri is your own server (e.g. https://your-whisper.fly.dev/auth/tiktok/callback).
 */
import { createHash, randomBytes } from 'crypto';
import { config } from '../../config/index.js';

// [Manage User Access Tokens] Desktop: use v2 auth + token management API
// https://developers.tiktok.com/doc/login-kit-manage-user-access-tokens
// https://developers.tiktok.com/doc/oauth-user-access-token-management
const AUTH_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const STATE_TTL_MS = 10 * 60 * 1000; // 10 min

type Pending = { codeVerifier: string; createdAt: number };
const pendingByState = new Map<string, Pending>();

function pruneOld(): void {
  const now = Date.now();
  for (const [state, p] of pendingByState) {
    if (now - p.createdAt > STATE_TTL_MS) pendingByState.delete(state);
  }
}

function generateCodeVerifier(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  let s = '';
  for (let i = 0; i < 64; i++) s += chars[randomBytes(1)[0]! % chars.length];
  return s;
}

function codeChallenge(verifier: string): string {
  // RFC 7636: BASE64URL-ENCODE(SHA256(verifier))
  return createHash('sha256')
    .update(verifier)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function startTikTokAuth(redirectUri: string): { authorizeUrl: string; state: string } {
  if (!config.tiktokClientKey || !config.tiktokClientSecret) {
    throw new Error('TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET required');
  }
  pruneOld();
  const state = randomBytes(16).toString('hex');
  const codeVerifier = generateCodeVerifier();
  const codeChallengeStr = codeChallenge(codeVerifier);
  pendingByState.set(state, { codeVerifier, createdAt: Date.now() });

  const scope = config.tiktokScope || 'user.info.basic';
  const params = new URLSearchParams({
    client_key: config.tiktokClientKey,
    scope,
    response_type: 'code',
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallengeStr,
    code_challenge_method: 'S256',
  });
  const authorizeUrl = `${AUTH_URL}?${params.toString()}`;
  return { authorizeUrl, state };
}

export async function finishTikTokAuth(
  state: string,
  code: string,
  redirectUri: string
): Promise<{ accessToken: string; refreshToken: string; openId: string }> {
  const pending = pendingByState.get(state);
  pendingByState.delete(state);
  if (!pending) throw new Error('Invalid or expired state; restart /auth/tiktok/start');
  if (Date.now() - pending.createdAt > STATE_TTL_MS) {
    throw new Error('State expired; restart /auth/tiktok/start');
  }

  const body = new URLSearchParams({
    client_key: config.tiktokClientKey!,
    client_secret: config.tiktokClientSecret!,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    code_verifier: pending.codeVerifier,
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`TikTok token exchange failed (${res.status}): ${JSON.stringify(json).slice(0, 200)}`);
  }
  const accessToken = json.access_token as string;
  const refreshToken = json.refresh_token as string;
  const openId = json.open_id as string;
  if (!accessToken || !refreshToken || !openId) {
    throw new Error('TikTok response missing token fields');
  }
  return { accessToken, refreshToken, openId };
}

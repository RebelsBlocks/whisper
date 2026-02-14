import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { buildOAuth1aAuthHeader, type OAuth1aToken } from './oauth1a.js';

export type XPostResult = {
  tweetId?: string;
  url?: string;
  elapsedMs?: number;
};

export type XMeResult = {
  userId: string;
  username?: string;
  name?: string;
};

// Use api.twitter.com for OAuth 1.0a signing compatibility.
// In practice X may serve v2 on api.x.com too, but OAuth signatures are host-sensitive.
const API_BASE = 'https://api.twitter.com';

// Serialize publishes from a single signer to avoid nonce/timestamp weirdness and to control rate.
let publishQueue: Promise<void> = Promise.resolve();

function getUserTokenOrThrow(): OAuth1aToken {
  if (!config.xAccessToken || !config.xAccessTokenSecret) {
    throw new Error('X user token not configured (X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET)');
  }
  return { key: config.xAccessToken, secret: config.xAccessTokenSecret };
}

function isXConfigured(): boolean {
  return Boolean(config.xConsumerKey && config.xConsumerSecret && config.xAccessToken && config.xAccessTokenSecret);
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3, baseDelayMs = 500): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const delay = baseDelayMs * Math.max(1, i + 1);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

export async function getXMe(): Promise<XMeResult> {
  if (!config.xConsumerKey || !config.xConsumerSecret) {
    throw new Error('X consumer credentials not configured (X_CONSUMER_KEY, X_CONSUMER_SECRET)');
  }
  const token = getUserTokenOrThrow();

  const url = `${API_BASE}/2/users/me`;
  const auth = buildOAuth1aAuthHeader('GET', url, token);

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: auth,
      Accept: 'application/json',
    },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`X users/me failed (${res.status}): ${JSON.stringify(json).slice(0, 200)}`);
  }
  const data = (json as any)?.data;
  if (!data?.id) {
    throw new Error(`X users/me invalid response: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return { userId: String(data.id), username: data.username, name: data.name };
}

export async function checkXConnection(): Promise<{ ok: boolean; me?: XMeResult; error?: string }> {
  if (!isXConfigured()) {
    return { ok: false, error: 'X OAuth 1.0a env not set' };
  }
  try {
    const me = await getXMe();
    return { ok: true, me };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export async function postTweet(text: string): Promise<XPostResult> {
  // Keep local dev simple: if not configured, no-op.
  if (!isXConfigured()) return {};

  const jobFn = async (): Promise<XPostResult> => {
    const start = Date.now();
    const token = getUserTokenOrThrow();

    const url = `${API_BASE}/2/tweets`;

    const doPost = async (): Promise<XPostResult> => {
      // OAuth 1.0a requires a fresh nonce/timestamp per request; generate header per attempt.
      const auth = buildOAuth1aAuthHeader('POST', url, token);
      const ac = new AbortController();
      const timeout = setTimeout(() => ac.abort(), 12_000);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: auth,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ text }),
          signal: ac.signal,
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(`X post tweet failed (${res.status}): ${JSON.stringify(json).slice(0, 200)}`);
        }
        const tweetId = (json as any)?.data?.id;
        if (!tweetId) {
          throw new Error(`X post tweet missing id: ${JSON.stringify(json).slice(0, 200)}`);
        }
        return {
          tweetId: String(tweetId),
          url: `https://x.com/i/web/status/${tweetId}`,
          elapsedMs: Date.now() - start,
        };
      } finally {
        clearTimeout(timeout);
      }
    };

    return await withRetry(doPost, 3, 500);
  };

  // Enqueue job to run sequentially; keep queue alive even if job fails.
  const queued = publishQueue.then(jobFn);
  publishQueue = queued.then(
    () => undefined,
    () => undefined,
  );

  try {
    return await queued;
  } catch (err) {
    logger.warn('x_publish_failed', { err: String(err) });
    throw err;
  }
}

export async function postTweetWithMedia(text: string, mediaIds: string[]): Promise<XPostResult> {
  if (!isXConfigured()) return {};

  const jobFn = async (): Promise<XPostResult> => {
    const start = Date.now();
    const token = getUserTokenOrThrow();
    const url = `${API_BASE}/2/tweets`;

    const doPost = async (): Promise<XPostResult> => {
      const auth = buildOAuth1aAuthHeader('POST', url, token);
      const ac = new AbortController();
      const timeout = setTimeout(() => ac.abort(), 12_000);
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: auth,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ text, media: { media_ids: mediaIds } }),
          signal: ac.signal,
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(`X post tweet failed (${res.status}): ${JSON.stringify(json).slice(0, 200)}`);
        }
        const tweetId = (json as any)?.data?.id;
        if (!tweetId) {
          throw new Error(`X post tweet missing id: ${JSON.stringify(json).slice(0, 200)}`);
        }
        return {
          tweetId: String(tweetId),
          url: `https://x.com/i/web/status/${tweetId}`,
          elapsedMs: Date.now() - start,
        };
      } finally {
        clearTimeout(timeout);
      }
    };

    return await withRetry(doPost, 3, 500);
  };

  const queued = publishQueue.then(jobFn);
  publishQueue = queued.then(
    () => undefined,
    () => undefined,
  );

  try {
    return await queued;
  } catch (err) {
    logger.warn('x_publish_failed', { err: String(err) });
    throw err;
  }
}


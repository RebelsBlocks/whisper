import { config } from '../../config/index.js';
import { buildOAuth1aAuthHeader, type OAuth1aToken } from './oauth1a.js';

export type XMediaUploadResult = {
  mediaIdString: string;
  expiresAfterSecs?: number;
};

function getUserTokenOrThrow(): OAuth1aToken {
  if (!config.xAccessToken || !config.xAccessTokenSecret) {
    throw new Error('X user token not configured (X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET)');
  }
  return { key: config.xAccessToken, secret: config.xAccessTokenSecret };
}

function isXConfigured(): boolean {
  return Boolean(config.xConsumerKey && config.xConsumerSecret && config.xAccessToken && config.xAccessTokenSecret);
}

export async function uploadTweetImage(bytes: Uint8Array, mimeType: string): Promise<XMediaUploadResult> {
  // Keep local dev simple: if not configured, no-op is not safe here because we need the media id.
  if (!isXConfigured()) {
    throw new Error('X OAuth 1.0a env not set');
  }

  const token = getUserTokenOrThrow();
  const url = 'https://upload.twitter.com/1.1/media/upload.json';

  // For multipart/form-data uploads, OAuth signature should be based on URL + oauth params (no body params).
  const auth = buildOAuth1aAuthHeader('POST', url, token);

  const form = new FormData();
  form.append('media_category', 'TWEET_IMAGE');
  // Convert to Buffer to satisfy TS BlobPart typing (and avoid SharedArrayBuffer unions).
  const buf = Buffer.from(bytes);
  const blob = new Blob([buf], { type: mimeType || 'image/png' });
  form.append('media', blob, 'image.png');

  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), config.xMediaUploadTimeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: auth,
        Accept: 'application/json',
      },
      body: form,
      signal: ac.signal,
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`X media upload failed (${res.status}): ${JSON.stringify(json).slice(0, 200)}`);
    }

    const mediaIdString = (json as any)?.media_id_string || (json as any)?.media_id?.toString?.();
    if (!mediaIdString) {
      throw new Error(`X media upload missing media_id_string: ${JSON.stringify(json).slice(0, 200)}`);
    }

    return {
      mediaIdString: String(mediaIdString),
      expiresAfterSecs: (json as any)?.expires_after_secs,
    };
  } finally {
    clearTimeout(timeout);
  }
}


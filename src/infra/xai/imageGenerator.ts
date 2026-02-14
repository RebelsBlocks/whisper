import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import type { PlayerBehaviorTag } from '../../domain/playerBehavior.js';

export type GeneratedImage = {
  bytes: Uint8Array;
  mimeType: string;
};

export type BatchImageBrief = {
  /** Primary batch vibe (most frequent tag across the whole batch). */
  primaryTag: PlayerBehaviorTag;
  /** Secondary batch vibe (2nd most frequent tag across the whole batch). */
  secondaryTag: PlayerBehaviorTag;
  /** Max players observed in any round in this batch (1..3). */
  tableMaxPlayers: number;
  /** Cast to depict (typically 1..3). */
  cast: Array<{
    accountId: string;
    handle: string;
    dominantTag?: PlayerBehaviorTag;
  }>;
  topGainer?: { accountId: string; handle: string; delta: number };
  topLoser?: { accountId: string; handle: string; delta: number };
};

function dataUrlToBytes(dataUrl: string): GeneratedImage {
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) throw new Error('Invalid data URL');
  const mimeType = m[1] || 'application/octet-stream';
  const b64 = m[2] || '';
  const buf = Buffer.from(b64, 'base64');
  return { bytes: buf, mimeType };
}

async function fetchBytes(url: string): Promise<GeneratedImage> {
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), Math.min(20_000, config.xaiTimeoutMs));
  try {
    const res = await fetch(url, { method: 'GET', signal: ac.signal });
    if (!res.ok) throw new Error(`xAI image download failed (${res.status})`);
    const ab = await res.arrayBuffer();
    const ct = res.headers.get('content-type') || 'image/png';
    return { bytes: new Uint8Array(ab), mimeType: ct };
  } finally {
    clearTimeout(timeout);
  }
}

function vibeSceneForTag(tag: PlayerBehaviorTag): string {
  switch (tag) {
    case 'MASTER':
      return `a coven of forest mages and druids in quiet control`;
    case 'GREEDY':
      return `orcish raiders and hoarders obsessed with perfection and loot`;
    case 'UNLUCKY':
      return `a tragic cursed gathering under choking mist and dying fire`;
    case 'LUCKY':
      return `a blessed fey-lit gathering with warm sparks and gentle charm`;
    case 'INDIFFERENT':
      return `cold moonlit hunters and detached silhouettes`;
    default:
      return `a mysterious forest gathering`;
  }
}

export function buildXaiImagePromptFromBatch(brief: BatchImageBrief): string {
  // Keep it concise: we want the model to obey composition + text constraints.
  return [
    // Art bible
    `Create a vivid, high-contrast cinematic illustration of Blackjack in the Dark Forest at night.`,
    `Setting: a misty forest clearing; the blackjack "table" is a meadow of moss/grass. Old carved wood frame/border with knots, cracks, moss. Firelight + moonlight, volumetric fog, drifting leaves, smoke, embers.`,
    `Absolutely no casino, no neon, no modern poker room, no roulette, no tuxedo crowd, no city interior.`,
    `No text, no letters, no numbers, no glyphs, no watermarks, no logos.`,

    // Batch vibe (primary + secondary)
    `Batch vibe: PRIMARY=${brief.primaryTag} (${vibeSceneForTag(brief.primaryTag)}). SECONDARY=${brief.secondaryTag} (${vibeSceneForTag(
      brief.secondaryTag
    )}).`,
    `Composition: ${Math.max(1, Math.min(3, brief.tableMaxPlayers || 2))} warriors at the clearing, dramatic focus on cards on the moss.`,

    // Optional: subtle blessing/curse anchors
    brief.topGainer
      ? `Subtle blessing: one warrior has slightly warmer firelight and calmer posture.`
      : ``,
    brief.topLoser
      ? `Subtle curse: one warrior has colder shadow and thicker mist near their hands.`
      : ``,
  ]
    .filter(Boolean)
    .join(' ');
}

async function generateImageFromPromptOnce(prompt: string): Promise<GeneratedImage> {
  if (!config.xaiApiKey) {
    throw new Error('xAI key not configured (XAI_API_KEY or X_API_KEY)');
  }

  const url = `${config.xaiBaseUrl.replace(/\/+$/, '')}/images/generations`;
  const p = String(prompt ?? '').trim();
  if (!p) throw new Error('xAI image prompt is empty');

  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), config.xaiTimeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.xaiApiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model: config.xaiImageModel,
        prompt: p,
        n: 1,
        // OpenAI-compatible field; xAI may return either b64_json or url.
        response_format: 'b64_json',
        // Some providers support aspect ratio; if ignored, fine.
        aspect_ratio: config.xaiImageAspectRatio,
      }),
      signal: ac.signal,
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const retryAfter = res.headers.get('retry-after');
      const extra = retryAfter ? ` retry-after=${retryAfter}` : '';
      throw new Error(`xAI image generation failed (${res.status})${extra}: ${JSON.stringify(json).slice(0, 200)}`);
    }

    const first = (json as any)?.data?.[0];
    const b64 = first?.b64_json;
    const imgUrl = first?.url;

    if (typeof b64 === 'string' && b64.length > 0) {
      const bytes = Buffer.from(b64, 'base64');
      return { bytes, mimeType: 'image/png' };
    }

    if (typeof imgUrl === 'string' && imgUrl.length > 0) {
      return await fetchBytes(imgUrl);
    }

    const dataUrl = first?.image_url;
    if (typeof dataUrl === 'string' && dataUrl.startsWith('data:')) {
      return dataUrlToBytes(dataUrl);
    }

    throw new Error(`xAI image generation returned no image: ${JSON.stringify(json).slice(0, 200)}`);
  } finally {
    clearTimeout(timeout);
  }
}

function parseRetryAfterMs(v: string | null): number | undefined {
  if (!v) return undefined;
  const s = v.trim();
  // seconds
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  // HTTP date
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return Math.max(0, t - Date.now());
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function jitter(ms: number): number {
  const j = Math.floor(Math.random() * 250);
  return ms + j;
}

export async function generateImageFromPrompt(prompt: string): Promise<GeneratedImage> {
  // Same retry policy as lore path.
  const maxAttempts = 5;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await generateImageFromPromptOnce(prompt);
    } catch (err) {
      lastErr = err;
      const msg = String(err);
      const is429 = msg.includes('(429)');
      const retryAfterMatch = msg.match(/retry-after=([^: ]+)/i);
      const retryAfterMs = parseRetryAfterMs(retryAfterMatch?.[1] ?? null);

      if (!is429 || attempt === maxAttempts) break;

      const base = Math.min(30_000, 1000 * 2 ** (attempt - 1)); // 1s,2s,4s,8s,16s (capped)
      const delay = jitter(retryAfterMs ?? base);
      logger.warn('xai_rate_limited', { attempt, maxAttempts, delayMs: delay });
      await sleep(delay);
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function checkXaiConnection(): Promise<{ ok: boolean; error?: string }> {
  if (!config.xaiApiKey) {
    return { ok: false, error: 'X_API_KEY not set' };
  }

  const url = `${config.xaiBaseUrl.replace(/\/+$/, '')}/api-key`;
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), Math.min(10_000, config.xaiTimeoutMs));

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.xaiApiKey}`,
        Accept: 'application/json',
      },
      signal: ac.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `xAI /api-key failed (${res.status}): ${text.slice(0, 120)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  } finally {
    clearTimeout(timeout);
  }
}


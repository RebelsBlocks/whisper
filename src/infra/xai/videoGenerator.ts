import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';

const POLL_INTERVAL_MS = 5_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;

export type VideoGenerationResult = {
  videoBytes: Buffer;
  mimeType: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Generate a short video from a single image using xAI image-to-video (e.g. grok-imagine-video).
 * Image-only: no text prompt by default (config.xaiVideoMotionPrompt). Set XAI_VIDEO_MOTION_PROMPT in .env to add optional motion hint.
 */
export async function generateVideoFromImage(
  imageBytes: Uint8Array | Buffer,
  imageMimeType: string,
  motionPrompt?: string
): Promise<VideoGenerationResult> {
  if (!config.xaiApiKey) {
    throw new Error('xAI key not configured (XAI_API_KEY or X_API_KEY)');
  }

  const baseUrl = config.xaiBaseUrl.replace(/\/+$/, '');
  const prompt = (motionPrompt ?? config.xaiVideoMotionPrompt).trim();
  const buf = Buffer.isBuffer(imageBytes) ? imageBytes : Buffer.from(imageBytes);
  const imageUrl = `data:${imageMimeType};base64,${buf.toString('base64')}`;

  const body: Record<string, unknown> = {
    model: config.xaiVideoModel,
    image_url: imageUrl,
    duration: config.xaiVideoDuration,
    aspect_ratio: config.xaiVideoAspectRatio,
    resolution: config.xaiVideoResolution,
  };
  // xAI image-to-video: prompt optional; when empty we send minimal so API accepts (image-only animation).
  body.prompt = prompt || 'animate';

  const startUrl = `${baseUrl}/videos/generations`;
  const acStart = new AbortController();
  const startTimeout = setTimeout(() => acStart.abort(), Math.min(30_000, config.xaiVideoTimeoutMs));

  let requestId: string;
  try {
    const res = await fetch(startUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.xaiApiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: acStart.signal,
    });

    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(
        `xAI video start failed (${res.status}): ${JSON.stringify(json).slice(0, 300)}`
      );
    }

    requestId = typeof json.request_id === 'string' ? json.request_id : (json as any).id;
    if (!requestId) {
      throw new Error(`xAI video start missing request_id: ${JSON.stringify(json).slice(0, 200)}`);
    }
  } finally {
    clearTimeout(startTimeout);
  }

  logger.info('xai_video_started', { requestId, duration: config.xaiVideoDuration });

  // Poll until done or timeout
  const deadline = Date.now() + config.xaiVideoTimeoutMs;
  let videoUrl: string | undefined;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    const getUrl = `${baseUrl}/videos/${requestId}`;
    const acGet = new AbortController();
    const getTimeout = setTimeout(() => acGet.abort(), 15_000);

    try {
      const res = await fetch(getUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${config.xaiApiKey}`,
          Accept: 'application/json',
        },
        signal: acGet.signal,
      });

      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        logger.warn('xai_video_poll_error', { requestId, status: res.status });
        continue;
      }

      const status = (json.status as string) ?? (json as any).state;
      if (status === 'done' || status === 'completed') {
        const data = json as any;
        videoUrl = data.video?.url ?? data.video_url ?? data.output?.[0]?.url;
        if (videoUrl) break;
      }
      if (status === 'expired' || status === 'failed') {
        throw new Error(`xAI video ${status}: ${JSON.stringify(json).slice(0, 200)}`);
      }
    } finally {
      clearTimeout(getTimeout);
    }
  }

  if (!videoUrl) {
    throw new Error(`xAI video timeout after ${config.xaiVideoTimeoutMs}ms (request_id=${requestId})`);
  }

  // Download MP4 (URL is short-lived)
  const acDown = new AbortController();
  const downTimeout = setTimeout(() => acDown.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(videoUrl, { method: 'GET', signal: acDown.signal });
    if (!res.ok) {
      throw new Error(`xAI video download failed (${res.status})`);
    }
    const ab = await res.arrayBuffer();
    const videoBytes = Buffer.from(ab);
    logger.info('xai_video_downloaded', { requestId, size: videoBytes.length });
    return { videoBytes, mimeType: 'video/mp4' };
  } finally {
    clearTimeout(downTimeout);
  }
}

import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';

const TIKTOK_API_BASE = 'https://open.tiktokapis.com';
const CHUNK_SIZE_MIN = 5 * 1024 * 1024; // 5 MB
const CHUNK_SIZE_MAX = 64 * 1024 * 1024; // 64 MB

export type CreatorInfo = {
  creatorUsername?: string;
  creatorNickname?: string;
  privacyLevelOptions: string[];
  maxVideoPostDurationSec: number;
};

export type InitDirectPostResult = {
  publishId: string;
  uploadUrl: string;
};

export type PublishStatus = 'PROCESSING_UPLOAD' | 'PUBLISH_COMPLETE' | 'FAILED' | string;

function getAccessToken(): string {
  if (!config.tiktokAccessToken) {
    throw new Error('TikTok access token not configured (TIKTOK_ACCESS_TOKEN)');
  }
  return config.tiktokAccessToken;
}

export async function queryCreatorInfo(): Promise<CreatorInfo> {
  const token = getAccessToken();
  const url = `${TIKTOK_API_BASE}/v2/post/publish/creator_info/query/`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify({}),
  });

  const json = (await res.json().catch(() => ({}))) as {
    data?: {
      creator_username?: string;
      creator_nickname?: string;
      privacy_level_options?: string[];
      max_video_post_duration_sec?: number;
    };
    error?: { code?: string; message?: string };
  };

  if (!res.ok || json.error?.code !== 'ok') {
    throw new Error(
      `TikTok creator_info failed (${res.status}): ${json.error?.message ?? JSON.stringify(json).slice(0, 200)}`
    );
  }

  const d = json.data ?? {};
  return {
    creatorUsername: d.creator_username,
    creatorNickname: d.creator_nickname,
    privacyLevelOptions: Array.isArray(d.privacy_level_options) ? d.privacy_level_options : [],
    maxVideoPostDurationSec: typeof d.max_video_post_duration_sec === 'number' ? d.max_video_post_duration_sec : 300,
  };
}

export async function initDirectPostVideo(options: {
  title: string;
  videoSize: number;
  privacyLevel?: string;
  disableComment?: boolean;
  disableDuet?: boolean;
  disableStitch?: boolean;
  isAigc?: boolean;
}): Promise<InitDirectPostResult> {
  const token = getAccessToken();
  const url = `${TIKTOK_API_BASE}/v2/post/publish/video/init/`;

  const videoSize = options.videoSize;
  let chunkSize: number;
  let totalChunkCount: number;
  if (videoSize < CHUNK_SIZE_MIN) {
    chunkSize = videoSize;
    totalChunkCount = 1;
  } else {
    chunkSize = CHUNK_SIZE_MIN;
    totalChunkCount = Math.ceil(videoSize / chunkSize);
  }

  const body = {
    post_info: {
      title: options.title.slice(0, 2200),
      privacy_level: options.privacyLevel ?? config.tiktokPrivacyLevel,
      disable_comment: options.disableComment ?? config.tiktokDisableComment,
      disable_duet: options.disableDuet ?? false,
      disable_stitch: options.disableStitch ?? false,
      brand_content_toggle: false,
      is_aigc: options.isAigc ?? true,
    },
    source_info: {
      source: 'FILE_UPLOAD',
      video_size: videoSize,
      chunk_size: chunkSize,
      total_chunk_count: totalChunkCount,
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify(body),
  });

  const json = (await res.json().catch(() => ({}))) as {
    data?: { publish_id?: string; upload_url?: string };
    error?: { code?: string; message?: string };
  };

  if (!res.ok || json.error?.code !== 'ok') {
    throw new Error(
      `TikTok video/init failed (${res.status}): ${json.error?.message ?? JSON.stringify(json).slice(0, 300)}`
    );
  }

  const publishId = json.data?.publish_id;
  const uploadUrl = json.data?.upload_url;
  if (!publishId || !uploadUrl) {
    throw new Error(`TikTok video/init missing publish_id or upload_url: ${JSON.stringify(json.data)}`);
  }

  return { publishId, uploadUrl };
}

export async function uploadVideoChunk(
  uploadUrl: string,
  chunk: Buffer,
  contentRange: { start: number; end: number; total: number }
): Promise<void> {
  const rangeHeader = `bytes ${contentRange.start}-${contentRange.end}/${contentRange.total}`;

  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Range': rangeHeader,
      'Content-Length': String(chunk.length),
    },
    body: new Uint8Array(chunk),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`TikTok upload chunk failed (${res.status}): ${text.slice(0, 200)}`);
  }
}

/**
 * Upload full video (single or multiple chunks). Chunks 5–64 MB; file <5 MB = 1 chunk.
 */
export async function uploadVideo(uploadUrl: string, videoBytes: Buffer): Promise<void> {
  const total = videoBytes.length;
  if (total < CHUNK_SIZE_MIN) {
    await uploadVideoChunk(uploadUrl, videoBytes, { start: 0, end: total - 1, total });
    return;
  }

  const chunkSize = CHUNK_SIZE_MIN;
  let offset = 0;
  let index = 0;
  while (offset < total) {
    const end = Math.min(offset + chunkSize, total);
    const chunk = videoBytes.subarray(offset, end);
    await uploadVideoChunk(uploadUrl, Buffer.from(chunk), { start: offset, end: end - 1, total });
    logger.info('tiktok_upload_chunk', { index: index + 1, start: offset, end: end - 1, total });
    offset = end;
    index++;
  }
}

export async function getPublishStatus(publishId: string): Promise<{
  status: PublishStatus;
  failReason?: string;
  publiclyAvailablePostId?: unknown[];
}> {
  const token = getAccessToken();
  const url = `${TIKTOK_API_BASE}/v2/post/publish/status/fetch/`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
    },
    body: JSON.stringify({ publish_id: publishId }),
  });

  const json = (await res.json().catch(() => ({}))) as {
    data?: { status?: string; fail_reason?: string; publicaly_available_post_id?: unknown[] };
    error?: { code?: string; message?: string };
  };

  if (!res.ok) {
    throw new Error(
      `TikTok status/fetch failed (${res.status}): ${json.error?.message ?? JSON.stringify(json).slice(0, 200)}`
    );
  }

  const d = json.data ?? {};
  return {
    status: (d.status as PublishStatus) ?? 'UNKNOWN',
    failReason: d.fail_reason,
    publiclyAvailablePostId: d.publicaly_available_post_id,
  };
}

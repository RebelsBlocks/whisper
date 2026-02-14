import * as dotenv from 'dotenv';

dotenv.config();

const nearNetworkId = process.env.NEAR_NETWORK_ID || process.env.NEAR_NETWORK || '';
const defaultSocialContractId = nearNetworkId === 'testnet' ? 'v1.social08.testnet' : 'social.near';
const defaultNodeUrl = nearNetworkId === 'testnet' ? 'https://rpc.testnet.fastnear.com' : 'https://free.rpc.fastnear.com';

export const config = {
  port: Number(process.env.PORT || 8787),

  // Auth between blackjack-backend -> whisper-server
  whisperToken: process.env.WHISPER_TOKEN || '',

  // Auth for operator-only endpoints (connect flows, manual triggers)
  // Keep this separate from WHISPER_TOKEN so backend auth doesn't grant operator access.
  whisperOperatorToken: process.env.WHISPER_OPERATOR_TOKEN || '',

  // Blackjack backend URL for webhook (round result comment delivery)
  blackjackBackendUrl: process.env.BLACKJACK_BACKEND_URL || '',

  // Logging / behavior toggles
  logFullPayload: process.env.WHISPER_LOG_FULL !== '0', // default: true

  // Lore-only publishing. If disabled, lore worker will still run but won't publish to NEAR.
  publishLoreToNearSocial: process.env.WHISPER_PUBLISH_NEAR === '1' || process.env.WHISPER_PUBLISH_NEAR === 'true', // default: false

  // Publish lore to X (single tweet)
  publishLoreToX: process.env.WHISPER_PUBLISH_X === '1' || process.env.WHISPER_PUBLISH_X === 'true', // default: false

  // X campaign: optional image generation/upload. Default: disabled (text-only posts).
  xEnableImages:
    process.env.WHISPER_X_ENABLE_IMAGES === '1' ||
    process.env.WHISPER_X_ENABLE_IMAGES === 'true' ||
    process.env.WHISPER_X_ENABLE_IMAGES === 'yes',

  // X media upload timeout (multipart upload can hang if X is slow).
  xMediaUploadTimeoutMs: Number(
    process.env.WHISPER_X_MEDIA_UPLOAD_TIMEOUT_MS || process.env.X_MEDIA_UPLOAD_TIMEOUT_MS || 25_000
  ),

  // X OAuth 1.0a user context (3-legged flow). Use these to sign requests to X API v2.
  // These secrets should be stored in env/secret manager and never logged.
  xConsumerKey: process.env.X_CONSUMER_KEY || process.env.Consumer_Key || '',
  xConsumerSecret: process.env.X_CONSUMER_SECRET || process.env.Secret_Key || '',
  // Access token + secret are not the same as the app-only Bearer token.
  // Accept a few legacy/env variants to reduce friction.
  xAccessToken:
    process.env.X_ACCESS_TOKEN ||
    (process.env as any).ACCESS_TOKEN ||
    (process.env as any).Access_Token ||
    '',
  xAccessTokenSecret:
    process.env.X_ACCESS_TOKEN_SECRET ||
    (process.env as any).ACCESS_TOKEN_SECRET ||
    (process.env as any).Access_Token_Secret ||
    (process.env as any).Access_Token_Secret_Key ||
    '',
  // Callback URL used only for the one-time connect flow (request_token -> authorize -> callback).
  xOauthCallbackUrl: process.env.X_OAUTH_CALLBACK_URL || '',

  // xAI (Grok) API for image generation (OpenAI-compatible)
  // NOTE: env naming is a bit overloaded with "X". Support both XAI_API_KEY and legacy X_API_KEY.
  xaiApiKey: process.env.XAI_API_KEY || process.env.X_API_KEY || '',
  xaiBaseUrl: process.env.XAI_BASE_URL || 'https://api.x.ai/v1',
  xaiImageModel: process.env.XAI_IMAGE_MODEL || 'grok-imagine-image',
  xaiImageAspectRatio: process.env.XAI_IMAGE_ASPECT_RATIO || '16:9',
  xaiTimeoutMs: Number(process.env.XAI_TIMEOUT_MS || 60_000),

  // NEAR Social publish (can be enabled when keys exist)
  nearNetworkId,
  nearAccountId: process.env.NEAR_ACCOUNT_ID || '',
  nearPrivateKey: process.env.NEAR_PRIVATE_KEY || '',
  nearNodeUrl: process.env.NEAR_NODE_URL || defaultNodeUrl,
  nearSocialContractId: process.env.NEAR_SOCIAL_CONTRACT_ID || defaultSocialContractId,

  // NEAR RPC resilience (hardcoded; NEAR is fast)
  // RPC can be slow/overloaded; 5s is often too aggressive for tx finality/outcome.
  nearRpcTimeoutMs: 20_000,
  nearPublishMaxAttempts: 3,
  nearPublishBaseDelayMs: 500,

  // NEAR AI (OpenAI-compatible) for lore generation
  nearAiApiKey: process.env.NEAR_AI_KEY || '',
  nearAiBaseUrl: process.env.NEAR_AI_BASE_URL || 'https://cloud-api.near.ai/v1',
  nearAiModel: process.env.NEAR_AI_MODEL || 'Qwen/Qwen3-30B-A3B-Instruct-2507',
  nearAiTimeoutMs: Number(process.env.NEAR_AI_TIMEOUT_MS || 60_000),

  // NEAR AI per-step tuning (Analyzer vs Lore Writer)
  nearAiAnalyzerMaxTokens: Number(process.env.NEAR_AI_ANALYZER_MAX_TOKENS || 2000),
  // Analyzer over raw JSON can take longer; do not default to an overly aggressive timeout.
  nearAiAnalyzerTimeoutMs: Number(process.env.NEAR_AI_ANALYZER_TIMEOUT_MS || 300_000),
  nearAiLoreWriterMaxTokens: Number(process.env.NEAR_AI_LORE_WRITER_MAX_TOKENS || 800),
  nearAiLoreWriterTimeoutMs: Number(process.env.NEAR_AI_LORE_WRITER_TIMEOUT_MS || 120_000),

  // Round result comment (per-round). No character limit; length guided by prompt. max_tokens = API ceiling only.
  nearAiRoundResultMaxTokens: Number(process.env.NEAR_AI_ROUND_RESULT_MAX_TOKENS || 80),
  nearAiRoundResultTimeoutMs: Number(process.env.NEAR_AI_ROUND_RESULT_TIMEOUT_MS || 15_000),
  nearAiRoundResultTemperature: Number(process.env.NEAR_AI_ROUND_RESULT_TEMPERATURE || 0.9),

  // --- Marketing scheduler (daily X post) ---
  // Defaults are chosen for NEARCON/SF noon alignment:
  // - Europe/Warsaw 20:00 ~= San Francisco 12:00 (depending on DST)
  marketingEnabled:
    process.env.WHISPER_MARKETING_ENABLED === '1' ||
    process.env.WHISPER_MARKETING_ENABLED === 'true' ||
    process.env.WHISPER_MARKETING_ENABLED === 'yes',

  /** Base local time (HH:MM) in marketingTimezone. */
  marketingTime: process.env.WHISPER_MARKETING_TIME || '20:00',

  /** IANA timezone name (e.g. Europe/Warsaw). */
  marketingTimezone: process.env.WHISPER_MARKETING_TIMEZONE || 'Europe/Warsaw',

  /** Total window size centered on marketingTime. Default 60 => T-30..T+30. */
  marketingWindowMinutes: Number(process.env.WHISPER_MARKETING_WINDOW_MINUTES || 60),

  /** Random jitter range around marketingTime. Default 15 => publish in [T-15..T+15]. */
  marketingJitterMinutes: Number(process.env.WHISPER_MARKETING_JITTER_MINUTES || 15),

  // --- TikTok Content Posting (Sandbox first; posty prywatne do audytu) ---
  tiktokPublishEnabled:
    process.env.WHISPER_TIKTOK_PUBLISH === '1' ||
    process.env.WHISPER_TIKTOK_PUBLISH === 'true' ||
    process.env.WHISPER_TIKTOK_PUBLISH === 'yes',
  tiktokClientKey: process.env.TIKTOK_CLIENT_KEY || process.env.CLIENT_KEY || '',
  tiktokClientSecret: process.env.TIKTOK_CLIENT_SECRET || process.env.CLIENT_SECRET || '',
  /**
   * Optional override for OAuth redirect URI.
   * Some TikTok app configs reject localhost/127.0.0.1; in that case use an HTTPS domain (e.g. ngrok)
   * and set this to the exact value registered in TikTok Developer Portal.
   * Example: https://xxxx.ngrok-free.app/auth/tiktok/callback
   */
  tiktokRedirectUri: (process.env.TIKTOK_REDIRECT_URI || '').trim(),
  /** OAuth scope: comma-separated, no spaces. Must match Scopes added in TikTok Developer Portal. video.upload = draft; video.publish = Direct Post (if approved). */
  tiktokScope: (process.env.TIKTOK_SCOPE || 'user.info.basic,video.upload').replace(/\s+/g, '').trim() || 'user.info.basic',
  tiktokAccessToken: process.env.TIKTOK_ACCESS_TOKEN || '',
  tiktokOpenId: process.env.TIKTOK_OPEN_ID || '',
  tiktokPrivacyLevel: process.env.TIKTOK_PRIVACY_LEVEL || 'SELF_ONLY',
  tiktokDisableComment: process.env.TIKTOK_DISABLE_COMMENT !== '0',

  // --- xAI Video (image → video for TikTok). Prompt only here / in videoGenerator; script uses image only. ---
  xaiVideoModel: process.env.XAI_VIDEO_MODEL || 'grok-imagine-video',
  /** Duration in seconds. 3–5 recommended for TikTok; max per API. */
  xaiVideoDuration: Math.min(15, Math.max(1, Number(process.env.XAI_VIDEO_DURATION || 5))),
  xaiVideoAspectRatio: process.env.XAI_VIDEO_ASPECT_RATIO || '9:16',
  xaiVideoResolution: process.env.XAI_VIDEO_RESOLUTION || '480p',
  xaiVideoTimeoutMs: Number(process.env.XAI_VIDEO_TIMEOUT_MS || 600_000),
  /** Optional motion prompt for image-to-video. Empty = animate image only, no text prompt. Set XAI_VIDEO_MOTION_PROMPT in .env to override. */
  xaiVideoMotionPrompt: (process.env.XAI_VIDEO_MOTION_PROMPT ?? '').trim(),
};


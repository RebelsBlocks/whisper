import express from 'express';
import { registerRoutes } from './app/routes.js';
import { config } from './config/index.js';
import { checkNearSocialConnection } from './infra/near/socialPublisher.js';
import { checkXConnection } from './infra/x/postPublisher.js';
import { checkXaiConnection } from './infra/xai/imageGenerator.js';
import { checkNearAiConnection } from './lore/worker/nearAiClient.js';
import { logger } from './utils/logger.js';
import { loreBatcher } from './lore/batcher.js';
import { loreWorker } from './lore/worker/index.js';
import { marketingPoster } from './scheduler/marketingPoster.js';

process.on('unhandledRejection', err => {
  logger.error('unhandled_rejection', { err: String(err) });
});

process.on('uncaughtException', err => {
  logger.error('uncaught_exception', { err: String(err) });
});

const app = express();
registerRoutes(app);

// Bind immediately so Fly/proxy see the port open before any async startup.
const host = '0.0.0.0';
const address = `${host}:${config.port}`;
app.listen({ port: config.port, host }, () => {
  logger.info('server_listening', { port: config.port, address });
});

async function startup(): Promise<void> {
  if (config.publishLoreToNearSocial) {
    try {
      const info = await checkNearSocialConnection();
      logger.info('near_ready', {
        network: info.networkId,
        account: info.accountId,
        socialContract: info.socialContractId,
        keyOnAccount: info.keyIsOnAccount,
        rpcUrl: config.nearNodeUrl,
      });
      if (!info.keyIsOnAccount) {
        logger.warn('near_key_not_on_account', { account: info.accountId });
      }
    } catch (err) {
      logger.warn('near_not_ready', { err: String(err) });
    }
  } else {
    logger.info('near_publish_disabled');
  }

  if (config.nearAiApiKey) {
    try {
      const ai = await checkNearAiConnection();
      if (ai.ok) {
        logger.info('near_ai_ready', { model: ai.model });
      } else {
        logger.warn('near_ai_not_ready', { error: ai.error });
      }
    } catch (err) {
      logger.warn('near_ai_check_failed', { err: String(err) });
    }
  } else {
    logger.info('near_ai_disabled', { reason: 'NEAR_AI_KEY not set' });
  }

  if (config.publishLoreToX) {
    const info = await checkXConnection();
    if (info.ok) {
      logger.info('x_ready', { userId: info.me?.userId, username: info.me?.username });
    } else {
      logger.warn('x_not_ready', { error: info.error });
    }

    if (config.xEnableImages) {
      logger.info('x_images_enabled');
    } else {
      logger.info('x_images_disabled', { reason: 'set WHISPER_X_ENABLE_IMAGES=1 to enable' });
    }
  } else {
    logger.info('x_publish_disabled');
  }

  // xAI is needed only when X image generation is enabled.
  if (config.xEnableImages) {
    if (config.xaiApiKey) {
      const xai = await checkXaiConnection();
      if (xai.ok) {
        logger.info('xai_ready');
      } else {
        logger.warn('xai_not_ready', { error: xai.error });
      }
    } else {
      logger.info('xai_disabled', { reason: 'XAI_API_KEY/X_API_KEY not set' });
    }
  } else if (config.xaiApiKey) {
    logger.info('xai_configured_but_unused', { reason: 'images_disabled' });
  }

  // TikTok: connection only (OAuth + ready check). No pipeline.
  if (config.tiktokClientKey && config.tiktokClientSecret) {
    if (config.tiktokAccessToken) {
      logger.info('tiktok_ready', {});
    } else {
      logger.info('tiktok_credentials_ok_no_token', {
        nextStep:
          'Open GET /auth/tiktok/start with header Authorization: Bearer <WHISPER_OPERATOR_TOKEN>, then add returned TIKTOK_ACCESS_TOKEN to .env',
      });
    }
  } else {
    logger.warn('tiktok_not_configured', { reason: 'TIKTOK_CLIENT_KEY or TIKTOK_CLIENT_SECRET missing in .env' });
  }

  // Worker on-demand: run when a batch is ready (no polling loop).
  loreBatcher.setOnBatchReady(() => loreWorker.scheduleRun());

  // Daily marketing scheduler (independent from lore pipeline).
  try {
    await marketingPoster.start();
  } catch (err) {
    logger.warn('marketing_scheduler_start_failed', { err: String(err) });
  }
}

void startup();

process.on('SIGTERM', () => {
  logger.info('sigterm_received_shutting_down');
  marketingPoster.stop();
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('sigint_received_shutting_down');
  marketingPoster.stop();
  process.exit(0);
});

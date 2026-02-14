import type { Express } from 'express';
import express from 'express';
import { authMiddleware, operatorAuthMiddleware } from './middleware/auth.js';
import { DedupeStore } from '../utils/dedupe.js';
import { RoundSnapshotSchema } from '../domain/roundSnapshot.js';
import { processRoundSnapshot } from './handlers/processRound.js';
import { getLastRoundResult } from './latestRoundResultCache.js';
import { loreBatcher } from '../lore/batcher.js';
import { loreWorker } from '../lore/worker/index.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { finishXOAuth1aConnectFlow, startXOAuth1aConnectFlow } from '../infra/x/oauth1a.js';
import { finishTikTokAuth, startTikTokAuth } from '../infra/tiktok/oauth.js';
import { marketingPoster } from '../scheduler/marketingPoster.js';

export function registerRoutes(app: Express): void {
  app.use(express.json({ limit: '1mb' }));

  const dedupe = new DedupeStore(100); // ring buffer of last 100 rounds

  app.get('/', (_req, res) => {
    res.status(200).send(
      '<!DOCTYPE html><html><body><p>Whisper server.</p><p><a href="/health">/health</a></p><p>TikTok OAuth: GET <a href="/auth/tiktok/start">/auth/tiktok/start</a> with header <code>Authorization: Bearer WHISPER_OPERATOR_TOKEN</code></p></body></html>'
    );
  });

  app.get('/health', (_req, res) => {
    res.status(200).json({ ok: true, ts: Date.now() });
  });

  app.get('/lore/status', (_req, res) => {
    res.status(200).json({ ok: true, ...loreBatcher.status(), worker: loreWorker.getStatus() });
  });

  app.get('/lore/round-result/latest', (_req, res) => {
    const entry = getLastRoundResult();
    if (!entry) {
      return res.status(404).json({ error: 'no_round_result' });
    }
    res.status(200).json(entry);
  });

  app.post('/lore/worker/run-once', authMiddleware, (_req, res) => {
    res.status(202).json({ ok: true });
    void loreWorker.runOnce();
  });

  // --- Marketing scheduler (operator endpoints) ---
  app.get('/scheduler/marketing/status', (_req, res) => {
    res.status(200).json({ ok: true, ...marketingPoster.getStatus() });
  });

  app.post('/scheduler/marketing/post-now', authMiddleware, async (req, res) => {
    const force = String((req.query as any)?.force ?? '') === '1' || String((req.query as any)?.force ?? '') === 'true';
    try {
      const out = await marketingPoster.postNow({ force });
      res.status(200).json({ ok: true, ...out });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // --- X OAuth 1.0a connect flow (operator-only) ---
  // NOTE: We require WHISPER_TOKEN for these endpoints so we don't accidentally leak X tokens publicly.
  app.get('/auth/x/start', authMiddleware, async (req, res) => {
    if (!config.whisperToken) {
      return res.status(400).json({ error: 'WHISPER_TOKEN_required_for_x_connect' });
    }
    const callbackUrl = config.xOauthCallbackUrl;
    if (!callbackUrl) {
      return res.status(400).json({ error: 'X_OAUTH_CALLBACK_URL_not_set' });
    }

    try {
      const { authorizeUrl, requestToken } = await startXOAuth1aConnectFlow(callbackUrl);
      logger.info('x_oauth1a_start', { requestTokenLast6: requestToken.slice(-6) });
      return res.redirect(authorizeUrl);
    } catch (err) {
      logger.warn('x_oauth1a_start_failed', { err: String(err) });
      return res.status(500).json({ error: 'x_oauth1a_start_failed' });
    }
  });

  app.get('/auth/x/callback', authMiddleware, async (req, res) => {
    if (!config.whisperToken) {
      return res.status(400).json({ error: 'WHISPER_TOKEN_required_for_x_connect' });
    }

    const oauthToken = String(req.query.oauth_token || '');
    const oauthVerifier = String(req.query.oauth_verifier || '');
    if (!oauthToken || !oauthVerifier) {
      return res.status(400).json({ error: 'missing_oauth_token_or_verifier' });
    }

    try {
      const out = await finishXOAuth1aConnectFlow(oauthToken, oauthVerifier);
      // Do NOT log secrets. Return them to the authenticated operator so they can store in secret manager.
      return res.status(200).json({
        ok: true,
        screenName: out.screenName,
        userId: out.userId,
        accessToken: out.accessToken,
        accessTokenSecret: out.accessTokenSecret,
        env: {
          X_ACCESS_TOKEN: out.accessToken,
          X_ACCESS_TOKEN_SECRET: out.accessTokenSecret,
        },
      });
    } catch (err) {
      logger.warn('x_oauth1a_callback_failed', { err: String(err) });
      return res.status(500).json({ error: 'x_oauth1a_callback_failed' });
    }
  });

  // --- TikTok Login Kit OAuth (operator-only start; callback is public so TikTok can redirect) ---
  // Redirect URI = your server URL, e.g. https://your-whisper.fly.dev/auth/tiktok/callback. No ngrok.
  app.get('/auth/tiktok/start', operatorAuthMiddleware, async (req, res) => {
    if (!config.tiktokClientKey || !config.tiktokClientSecret) {
      return res.status(400).json({ error: 'TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET required' });
    }
    const baseUrl = `${req.protocol}://${req.get('host') ?? ''}`.replace(/\/$/, '');
    const redirectUri = config.tiktokRedirectUri || `${baseUrl}/auth/tiktok/callback`;
    try {
      const { authorizeUrl } = startTikTokAuth(redirectUri);
      logger.info('tiktok_oauth_start', { redirectUri: redirectUri.slice(0, 50) });
      return res.redirect(authorizeUrl);
    } catch (err) {
      logger.warn('tiktok_oauth_start_failed', { err: String(err) });
      return res.status(500).json({ error: 'tiktok_oauth_start_failed' });
    }
  });

  app.get('/auth/tiktok/callback', async (req, res) => {
    const queryKeys = Object.keys(req.query);
    const code = String(req.query.code ?? '').trim();
    const state = String(req.query.state ?? '').trim();
    logger.info('tiktok_callback_hit', {
      url: '/auth/tiktok/callback',
      queryKeys,
      hasCode: !!code,
      hasState: !!state,
    });
    const error = String(req.query.error ?? '').trim();
    const errorDescription = String(req.query.error_description ?? '').trim();
    if (error) {
      return res.status(400).send(
        `<p>TikTok authorization failed: ${error}</p>${errorDescription ? `<p>${errorDescription}</p>` : ''}<p>Restart: GET /auth/tiktok/start with Authorization: Bearer WHISPER_OPERATOR_TOKEN</p>`
      );
    }

    if (!code || !state) {
      return res.status(400).send(
        '<p>Missing code or state from TikTok. Restart: GET /auth/tiktok/start with Authorization: Bearer WHISPER_OPERATOR_TOKEN</p>'
      );
    }

    const baseUrl = `${req.protocol}://${req.get('host') ?? ''}`.replace(/\/$/, '');
    const redirectUri = config.tiktokRedirectUri || `${baseUrl}/auth/tiktok/callback`;
    try {
      const out = await finishTikTokAuth(state, code, redirectUri);
      return res.status(200).json({
        ok: true,
        accessToken: out.accessToken,
        openId: out.openId,
        refreshToken: out.refreshToken,
        env: {
          TIKTOK_ACCESS_TOKEN: out.accessToken,
          TIKTOK_OPEN_ID: out.openId,
          TIKTOK_REFRESH_TOKEN: out.refreshToken,
        },
      });
    } catch (err) {
      logger.warn('tiktok_oauth_callback_failed', { err: String(err) });
      return res.status(400).send(`<p>TikTok token exchange failed: ${String(err)}</p><p>Restart /auth/tiktok/start</p>`);
    }
  });

  app.post('/events/round-ended', authMiddleware, async (req, res) => {
    const parsed = RoundSnapshotSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_payload', issues: parsed.error.issues });
    }

    const snapshot = parsed.data;
    const dedupeKey = `round:${snapshot.roundNumber}`;
    if (!dedupe.markOnce(dedupeKey)) {
      return res.status(200).json({ ok: true, deduped: true });
    }

    // Fire-and-forget processing: respond quickly, do work in background.
    res.status(202).json({ ok: true });

    Promise.resolve()
      .then(async () => {
        logger.info('round_payload_received', {
          roundNumber: snapshot.roundNumber,
          players: snapshot.players.length,
          dealerCards: snapshot.dealer.cards.length,
        });
        if (config.logFullPayload) {
          logger.info('round_payload_debug', { roundNumber: snapshot.roundNumber, payload: snapshot });
        }
        await processRoundSnapshot(snapshot);
      })
      .catch(err => {
        logger.error('event_processing_failed', { err: String(err) });
      });
  });
}


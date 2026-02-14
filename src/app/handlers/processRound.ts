import type { RoundSnapshot } from '../../domain/roundSnapshot.js';
import { buildRoundDigest } from '../../domain/roundDigest.js';
import { deriveRoundBehaviorsFromDigest, type RoundDerived } from '../../domain/playerBehavior.js';
import { loreBatcher } from '../../lore/batcher.js';
import { writeRoundResultComment } from '../../lore/worker/roundResultWriter.js';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { getLastRoundResult, setLastRoundResult } from '../latestRoundResultCache.js';

const inFlightRoundResults = new Set<number>();

export async function processRoundSnapshot(snapshot: RoundSnapshot): Promise<void> {
  const digest = buildRoundDigest(snapshot);
  const derived = deriveRoundBehaviorsFromDigest(digest);

  // Fire-and-forget: generate round result comment first,
  // so when a lore batch becomes ready on this same snapshot,
  // the NEAR AI queue processes roundResult -> loreWriter -> xNotification.
  void produceRoundResultComment(digest, derived);

  // Ingest snapshot immediately (non-blocking)
  loreBatcher.ingest({
    roundNumber: snapshot.roundNumber,
    ts: snapshot.createdAt,
    receivedAt: Date.now(),
    snapshot,
    derived,
  });
}

async function produceRoundResultComment(
  digest: ReturnType<typeof buildRoundDigest>,
  derived: RoundDerived
): Promise<void> {
  if (!config.nearAiApiKey) return;

  if (digest.players.length === 0) return;

  // If we receive duplicate snapshots for the same round, avoid re-generating/sending.
  const last = getLastRoundResult();
  if (last?.roundNumber === digest.roundNumber) return;

  if (inFlightRoundResults.has(digest.roundNumber)) return;
  inFlightRoundResults.add(digest.roundNumber);

  try {
    const comment = await writeRoundResultComment(digest, derived);
    const trimmed = comment.trim();
    if (trimmed.length === 0) {
      logger.info('round_result_empty', { roundNumber: digest.roundNumber });
    } else {
      logger.info('round_result', { roundNumber: digest.roundNumber, comment: trimmed });
    }
    // Lore generation is decoupled from round-result comments.
    
    // Keep backward compatibility with API endpoint
    setLastRoundResult({ roundNumber: digest.roundNumber, comment: trimmed });
    
    // 🕯️ Fire-and-forget webhook to blackjack backend (elegant event-driven delivery)
    void sendRoundResultToBackend(digest.roundNumber, trimmed);
  } catch (err) {
    logger.warn('round_result_skipped', {
      roundNumber: digest.roundNumber,
      reason: String(err),
    });
  } finally {
    inFlightRoundResults.delete(digest.roundNumber);
  }
}

/**
 * Send round result comment to blackjack backend via webhook (fire-and-forget)
 */
async function sendRoundResultToBackend(roundNumber: number, comment: string): Promise<void> {
  const backendUrl = config.blackjackBackendUrl;
  if (!backendUrl) {
    logger.info('round_result_webhook_skipped', { reason: 'BLACKJACK_BACKEND_URL not set' });
    return;
  }

  const url = `${backendUrl.replace(/\/+$/, '')}/api/webhook/whisper/round-result`;
  const token = config.whisperToken;

  try {
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), 2500);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ roundNumber, comment }),
      signal: ac.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      logger.warn('round_result_webhook_failed', {
        roundNumber,
        status: response.status,
        body: text.slice(0, 200),
      });
    } else {
      logger.info('round_result_webhook_sent', { roundNumber });
    }
  } catch (err) {
    logger.warn('round_result_webhook_error', {
      roundNumber,
      error: String(err),
    });
  }
}


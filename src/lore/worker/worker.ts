import { loreBatcher } from '../batcher.js';
import type { LoreBatch } from '../types.js';
import { logger } from '../../utils/logger.js';
import { publishLoreThread, type LorePublishResult } from './nearLorePublisher.js';
import { publishLoreToXWithText, type XLorePublishResult } from './xLorePublisher.js';
import { config } from '../../config/index.js';
import { writeLoreUnlocked } from './loreWriter.js';
import { publishedLoreStore } from '../publishedLoreStore.js';
import type { PlayerBehaviorTag } from '../../domain/playerBehavior.js';
import { withNearAiPermit, getNearAiClient } from './nearAiClient.js';
import { writeXNotificationFromLoreUnlocked, isValidXNotificationText } from './xNotificationWriter.js';
import { buildXaiImagePromptFromBatch, type BatchImageBrief } from '../../infra/xai/imageGenerator.js';
import { isInMarketingWindowAt, getMarketingPolicy } from '../../scheduler/marketingPolicy.js';

function toFullNearAccountId(accountId: string): string {
  if (!accountId?.trim()) return accountId ?? '';
  const s = accountId.trim();
  if (s.endsWith('.near') || s.endsWith('.testnet')) return s;
  return `${s}.near`;
}

/**
 * Shortens hex / long addresses but keeps human-readable NEAR names.
 * (Copied to avoid importing domain-only helpers here.)
 */
function toHandle(accountId: string): string {
  if (!accountId) return '';
  const s = String(accountId);
  const isHexAddress = s.startsWith('0x') || (s.length >= 40 && !s.includes('.'));
  if (isHexAddress && s.length > 16) return `${s.slice(0, 6)}…${s.slice(-6)}`;
  return s;
}

function truncateText(s: string, maxChars: number): string {
  if (!s) return '';
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}…`;
}

const BEHAVIOR_TAGS: PlayerBehaviorTag[] = ['MASTER', 'GREEDY', 'UNLUCKY', 'LUCKY', 'INDIFFERENT'];

type ChronicleMemoryItem = {
  createdAt: number;
  batchId: string;
  rootKey?: string;
  txHash?: string;
  text: string;
};

type BalanceSummary = {
  accountId: string;
  handle: string;
  roundsPlayed: number;
  firstRound: number;
  lastRound: number;
  /** First seen balance at start-of-round (if available). */
  firstBalanceStart?: number;
  /** Last seen balance at end-of-round (if available). */
  lastBalanceEnd?: number;
  /** Minimum balance seen across start/end values. */
  minBalance?: number;
  /** Maximum balance seen across start/end values. */
  maxBalance?: number;
  /** Delta across the batch: lastBalanceEnd - firstBalanceStart (if both available). */
  delta?: number;
  /** Biggest single-round swing (end - start) observed in the batch (if available). */
  biggestRoundSwing?: { roundNumber: number; swing: number };
};

type SlimRoundPlayer = {
  accountId: string;
  handle: string;
  seatNumber: number;
  behaviorTag?: PlayerBehaviorTag;
};

function toFiniteNumber(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Build JSON payload for lore LLM from batch + chronicle memory (RAM). */
function buildLorePayload(
  batch: LoreBatch,
  chronicleMemory: ChronicleMemoryItem[]
): { payload: string; imagePrompt?: string; xAccountIds: string[] } {
  const rounds = batch.rounds;
  if (!rounds.length) return { payload: '', imagePrompt: undefined, xAccountIds: [] };

  // Build lifecycle summary across the batch so the LLM understands when there are 1/2/3 players.
  const lifecycleByAccount = new Map<
    string,
    { accountId: string; handle: string; firstRound: number; lastRound: number; roundsPlayed: number; seatNumbers: Set<number> }
  >();

  // Balance summary across the batch (optional fields; depends on backend snapshot).
  const balanceByAccount = new Map<string, BalanceSummary>();

  // Per-player behavior summary across the batch.
  const behaviorByAccount = new Map<
    string,
    { accountId: string; handle: string; roundsTagged: number; counts: Partial<Record<PlayerBehaviorTag, number>> }
  >();

  let maxPlayersInAnyRound = 0;

  const roundsJson = rounds.map(r => {
    maxPlayersInAnyRound = Math.max(maxPlayersInAnyRound, r.snapshot.players.length);

    const behaviorBySeat = new Map<number, { tag: PlayerBehaviorTag; tagCounts: Partial<Record<PlayerBehaviorTag, number>> }>();
    for (const b of r.derived?.playerBehaviors ?? []) {
      behaviorBySeat.set(b.seatNumber, { tag: b.tag, tagCounts: b.tagCounts });
    }

    for (const p of r.snapshot.players) {
      const full = toFullNearAccountId(p.accountId);
      const key = full;
      const handle = toHandle(full);
      const existing = lifecycleByAccount.get(key);
      if (!existing) {
        lifecycleByAccount.set(key, {
          accountId: full,
          handle,
          firstRound: r.roundNumber,
          lastRound: r.roundNumber,
          roundsPlayed: 1,
          seatNumbers: new Set([p.seatNumber]),
        });
      } else {
        existing.firstRound = Math.min(existing.firstRound, r.roundNumber);
        existing.lastRound = Math.max(existing.lastRound, r.roundNumber);
        existing.roundsPlayed += 1;
        existing.seatNumbers.add(p.seatNumber);
      }

      // Update balance stats (if present)
      const startNum = toFiniteNumber(p.balanceStart);
      const endNum = toFiniteNumber(p.balanceEnd);

      if (startNum !== undefined || endNum !== undefined) {
        const bs = balanceByAccount.get(key) ?? {
          accountId: full,
          handle,
          roundsPlayed: 0,
          firstRound: r.roundNumber,
          lastRound: r.roundNumber,
        };

        bs.roundsPlayed += 1;
        bs.firstRound = Math.min(bs.firstRound, r.roundNumber);
        bs.lastRound = Math.max(bs.lastRound, r.roundNumber);

        if (startNum !== undefined && bs.firstBalanceStart === undefined) {
          // first seen start-of-round balance (chronological order; rounds[] is chronological)
          bs.firstBalanceStart = startNum;
        }
        if (endNum !== undefined) {
          // keep last end-of-round balance seen (chronological order)
          bs.lastBalanceEnd = endNum;
        }

        for (const v of [startNum, endNum]) {
          if (v === undefined) continue;
          bs.minBalance = bs.minBalance === undefined ? v : Math.min(bs.minBalance, v);
          bs.maxBalance = bs.maxBalance === undefined ? v : Math.max(bs.maxBalance, v);
        }

        if (startNum !== undefined && endNum !== undefined) {
          const swing = endNum - startNum;
          const cur = bs.biggestRoundSwing;
          if (!cur || Math.abs(swing) > Math.abs(cur.swing)) {
            bs.biggestRoundSwing = { roundNumber: r.roundNumber, swing };
          }
        }

        balanceByAccount.set(key, bs);
      }

      // Aggregate behavior stats by handle (from derived, if present).
      const behavior = behaviorBySeat.get(p.seatNumber);
      if (behavior?.tag) {
        const cur = behaviorByAccount.get(full) ?? { accountId: full, handle, roundsTagged: 0, counts: {} };
        cur.roundsTagged += 1;
        cur.counts[behavior.tag] = (cur.counts[behavior.tag] ?? 0) + 1;
        behaviorByAccount.set(full, cur);
      }
    }

    // Slim down per-round payload: keep only identity + behaviorTag.
    const players: SlimRoundPlayer[] = r.snapshot.players.map(p => {
      const full = toFullNearAccountId(p.accountId);
      const handle = toHandle(full);
      const behavior = behaviorBySeat.get(p.seatNumber);

      const out: SlimRoundPlayer = {
        accountId: full,
        handle,
        seatNumber: p.seatNumber,
      };

      if (behavior?.tag) out.behaviorTag = behavior.tag;

      return out;
    });

    return {
      round: r.roundNumber,
      playerCount: r.snapshot.players.length,
      players,
    };
  });

  const playerLifecycle = Array.from(lifecycleByAccount.values())
    .sort((a, b) => a.firstRound - b.firstRound)
    .map(x => ({
      accountId: x.accountId,
      handle: x.handle,
      firstRound: x.firstRound,
      lastRound: x.lastRound,
      roundsPlayed: x.roundsPlayed,
      seatNumbers: Array.from(x.seatNumbers.values()).sort((a, b) => a - b),
    }));

  const balanceSummary = Array.from(balanceByAccount.values())
    .map(b => ({
      ...b,
      delta:
        b.firstBalanceStart !== undefined && b.lastBalanceEnd !== undefined ? b.lastBalanceEnd - b.firstBalanceStart : undefined,
    }))
    .sort((a, b) => a.firstRound - b.firstRound);

  const behaviorSummary = Array.from(behaviorByAccount.values()).sort((a, b) => a.handle.localeCompare(b.handle));

  const cameoAccounts = playerLifecycle
    .filter(p => p.roundsPlayed === 1)
    .map(p => ({ accountId: p.accountId, handle: p.handle }));
  const mustMentionAccounts = playerLifecycle.map(p => ({ accountId: p.accountId, handle: p.handle }));

  const adjectiveByTag: Record<PlayerBehaviorTag, string> = {
    MASTER: 'master',
    GREEDY: 'greedy',
    UNLUCKY: 'unlucky',
    LUCKY: 'lucky',
    INDIFFERENT: 'indifferent',
  };

  function pickDominantFromCounts(counts: Partial<Record<PlayerBehaviorTag, number>>): PlayerBehaviorTag | undefined {
    const priority: PlayerBehaviorTag[] = ['MASTER', 'GREEDY', 'UNLUCKY', 'LUCKY', 'INDIFFERENT'];
    for (const t of priority) {
      if ((counts[t] ?? 0) > 0) return t;
    }
    return undefined;
  }

  const archetypes = behaviorSummary
    .map(b => {
      const dominantTag = pickDominantFromCounts(b.counts);
      return dominantTag
        ? { accountId: b.accountId, handle: b.handle, dominantTag, adjective: adjectiveByTag[dominantTag] }
        : undefined;
    })
    .filter(Boolean);

  const deltas = balanceSummary
    .filter(b => b.delta !== undefined)
    .map(b => ({ accountId: b.accountId, handle: b.handle, delta: b.delta as number }));
  const topGainer = deltas.length ? [...deltas].sort((a, b) => b.delta - a.delta)[0] : undefined;
  const topLoser = deltas.length ? [...deltas].sort((a, b) => a.delta - b.delta)[0] : undefined;

  // Batch vibe (primary/secondary) = top-2 behavior tags by total frequency across this batch.
  const totalCounts: Record<PlayerBehaviorTag, number> = {
    MASTER: 0,
    GREEDY: 0,
    UNLUCKY: 0,
    LUCKY: 0,
    INDIFFERENT: 0,
  };
  for (const b of behaviorSummary) {
    for (const t of BEHAVIOR_TAGS) totalCounts[t] += b.counts[t] ?? 0;
  }
  const tagPriority: Record<PlayerBehaviorTag, number> = {
    MASTER: 0,
    GREEDY: 1,
    UNLUCKY: 2,
    LUCKY: 3,
    INDIFFERENT: 4,
  };
  const top2 = [...BEHAVIOR_TAGS]
    .map(t => ({ tag: t, n: totalCounts[t] ?? 0 }))
    .sort((a, b) => (b.n - a.n) || (tagPriority[a.tag] - tagPriority[b.tag]));
  const primaryTag = (top2[0]?.n ?? 0) > 0 ? top2[0]!.tag : 'INDIFFERENT';
  const secondaryTag = (top2[1]?.n ?? 0) > 0 ? top2[1]!.tag : primaryTag;

  // Cast: prefer top gainer/loser (if any), then highest roundsPlayed.
  const roundsPlayedByAccount = new Map(playerLifecycle.map(p => [p.accountId, p.roundsPlayed] as const));
  const archetypeByAccount = new Map(archetypes.map(a => [a!.accountId, a!] as const));

  const castLimit = Math.max(1, Math.min(3, playerLifecycle.length));
  const castOrder: string[] = [];
  for (const x of [topGainer?.accountId, topLoser?.accountId]) {
    if (x && !castOrder.includes(x)) castOrder.push(x);
  }
  const remaining = [...playerLifecycle]
    .map(p => p.accountId)
    .filter(id => !castOrder.includes(id))
    .sort((a, b) => (roundsPlayedByAccount.get(b) ?? 0) - (roundsPlayedByAccount.get(a) ?? 0));
  for (const id of remaining) {
    if (castOrder.length >= castLimit) break;
    castOrder.push(id);
  }
  const cast = castOrder.map(id => {
    const a = archetypeByAccount.get(id);
    return {
      accountId: id,
      handle: a?.handle ?? (playerLifecycle.find(p => p.accountId === id)?.handle ?? id),
      dominantTag: a?.dominantTag,
    };
  });

  const imageBrief: BatchImageBrief = {
    primaryTag,
    secondaryTag,
    tableMaxPlayers: maxPlayersInAnyRound,
    cast,
    topGainer,
    topLoser,
  };
  const imagePrompt = buildXaiImagePromptFromBatch(imageBrief);

  const totalCount = rounds.length;
  logger.info('lore_payload_built', {
    batchId: batch.id,
    totalRounds: totalCount,
    roundRange: `${rounds[0]?.roundNumber}-${rounds[rounds.length - 1]?.roundNumber}`,
    chronicleMemoryCount: chronicleMemory.length,
    batchUniquePlayers: playerLifecycle.length,
    maxPlayersInAnyRound,
    balanceSummaryPlayers: balanceSummary.length,
    behaviorSummaryPlayers: behaviorSummary.length,
    imageVibe: { primaryTag, secondaryTag, cast: cast.map(c => c.accountId) },
  });

  const payload = JSON.stringify(
    {
      chronicleMemory: {
        count: chronicleMemory.length,
        capacity: publishedLoreStore.maxSize(),
        // chronological order (oldest -> newest)
        items: chronicleMemory.map(m => ({
          createdAt: m.createdAt,
          batchId: m.batchId,
          rootKey: m.rootKey,
          txHash: m.txHash,
          // Keep snippets small so we can fit up to 10 items.
          text: truncateText(m.text, 600),
        })),
      },
      batchSummary: {
        maxPossiblePlayers: 3,
        maxPlayersInAnyRound,
        uniquePlayers: playerLifecycle.map(p => ({ accountId: p.accountId, handle: p.handle })),
        balanceSummary,
        behaviorSummary,
      },
      focus: {
        mustMentionAccounts,
        cameoAccounts,
        archetypes,
        topGainer,
        topLoser,
      },
      rounds: roundsJson,
    },
    null,
    2
  );
  return { payload, imagePrompt, xAccountIds: mustMentionAccounts.map(x => x.accountId) };
}

type LoreWorkerState = {
  busy: boolean;
  lastTickAt?: number;
  lastBatchId?: string;
  lastPublishedNear?: LorePublishResult;
  lastPublishedX?: XLorePublishResult;
  lastError?: string;
};

export class LoreWorker {
  private state: LoreWorkerState;

  constructor() {
    this.state = { busy: false };
  }

  getStatus(): LoreWorkerState {
    return { ...this.state };
  }

  /** Fire-and-forget: process pending batches (called when a batch becomes ready). */
  scheduleRun(): void {
    void this.tick();
  }

  /** Process one batch; used by HTTP /lore/worker/run-once and by scheduleRun. */
  async runOnce(): Promise<void> {
    await this.tick();
  }

  private async tick(): Promise<void> {
    this.state.lastTickAt = Date.now();
    if (this.state.busy) return;

    if (!config.nearAiApiKey) return;

    const batch = loreBatcher.drainPending(1)[0];
    if (!batch) return;

    this.state.busy = true;
    this.state.lastBatchId = batch.id;
    this.state.lastError = undefined;

    try {
      const batchId = batch.id;

      // Payload = batch.rounds (from ring buffer) + roundResultsStore, joined by roundNumber
      const memNewestFirst = publishedLoreStore.listNewestFirst().slice(0, publishedLoreStore.maxSize());
      const memOldestFirst = memNewestFirst.reverse();
      const { payload, imagePrompt, xAccountIds } = buildLorePayload(batch, memOldestFirst);

      // STEP 1+X: One NEAR AI cycle with strict priority:
      // lore -> x-notification (if enabled) must not be interrupted by roundResult of new rounds.
      const { lore, xText } = await withNearAiPermit('lore_cycle', async () => {
        const lore = await writeLoreUnlocked(payload, batchId);

        if (!config.publishLoreToX) {
          return { lore, xText: undefined as string | undefined };
        }

        // Marketing window policy:
        // During marketing window we skip *both* x-notification generation and X publishing for lore batches,
        // so the daily marketing post can own the X channel without back-to-back tweets.
        const marketing = getMarketingPolicy();
        if (marketing.enabled && isInMarketingWindowAt(new Date())) {
          logger.info('x_publish_skipped_marketing_window', {
            batchId,
            window: { startMin: marketing.windowStartMinutes, endMin: marketing.windowEndMinutes, tz: marketing.timezone },
            reason: 'marketing_window',
          });
          return { lore, xText: undefined as string | undefined };
        }

        const client = getNearAiClient();
        // attempt loop is inside unlocked writer; we keep the outer flow deterministic.
        let lastErr: unknown;
        for (let attempt = 1; attempt <= 4; attempt++) {
          try {
            const { text } = await writeXNotificationFromLoreUnlocked(client, lore, batchId, attempt, xAccountIds);
            if (!isValidXNotificationText(text)) continue;
            return { lore, xText: text };
          } catch (e) {
            lastErr = e;
          }
        }
        throw lastErr ?? new Error('x_notification_failed_to_fit_constraints');
      });

      // STEP 2: Publish (optional) — one post
      if (config.publishLoreToNearSocial) {
        const published = await publishLoreThread(batch, [lore]);
        this.state.lastPublishedNear = published;

        // Keep last 10 published lores in RAM for continuity.
        publishedLoreStore.push({
          createdAt: Date.now(),
          batchId,
          rootKey: published.rootKey,
          txHash: published.txHashes[0],
          text: lore,
        });

        logger.info('published_lore_stored', {
          batchId,
          rootKey: published.rootKey,
          storeSize: publishedLoreStore.size(),
          capacity: publishedLoreStore.maxSize(),
        });
      }

      if (config.publishLoreToX && xText) {
        const publishedX = await publishLoreToXWithText(lore, batchId, xText, imagePrompt);
        this.state.lastPublishedX = publishedX;
      }
    } catch (err) {
      this.state.lastError = String(err);
      logger.error('lore_worker_failed', { batchId: batch.id, err: String(err) });
    } finally {
      this.state.busy = false;
      // If more batches are pending, run again (drain until empty).
      if (loreBatcher.status().pendingBatches > 0) {
        void this.tick();
      }
    }
  }
}


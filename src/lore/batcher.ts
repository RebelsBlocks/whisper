import { RingBuffer } from '../utils/ringBuffer.js';
import type { LoreBatch, RoundRecord } from './types.js';
import { logger } from '../utils/logger.js';

type LoreBatcherOptions = {
  roundsCapacity: number; // keep last N rounds
  batchSize: number; // create a batch every N rounds
  pendingCapacity: number; // keep last N pending batches (safety)
};

export class LoreBatcher {
  private rounds: RingBuffer<RoundRecord>;
  private pendingBatches: RingBuffer<LoreBatch>;
  private unbatchedQueue: RoundRecord[] = [];
  private onBatchReady: (() => void) | undefined;

  constructor(private opts: LoreBatcherOptions) {
    this.rounds = new RingBuffer<RoundRecord>(opts.roundsCapacity);
    this.pendingBatches = new RingBuffer<LoreBatch>(opts.pendingCapacity);
  }

  ingest(record: RoundRecord): void {
    const dropped = this.rounds.push(record).dropped;
    if (dropped) {
      logger.info('lore_round_evicted', { roundNumber: dropped.roundNumber, ts: dropped.ts });
    }

    this.unbatchedQueue.push(record);

    logger.info('lore_round_ingested', {
      roundNumber: record.roundNumber,
      ts: record.ts,
      roundsStored: this.rounds.length,
      roundsCapacity: this.rounds.maxSize,
      unbatched: this.unbatchedQueue.length,
      batchSize: this.opts.batchSize,
      pendingBatches: this.pendingBatches.length,
      pendingCapacity: this.pendingBatches.maxSize,
      droppedRound: dropped?.roundNumber,
    });

    while (this.unbatchedQueue.length >= this.opts.batchSize) {
      const rounds = this.unbatchedQueue.splice(0, this.opts.batchSize);
      const tailRound = rounds[rounds.length - 1]!.roundNumber;
      const id = `batch_${rounds[0]!.roundNumber}_${tailRound}_${Date.now()}`;
      const batch: LoreBatch = { id, createdAt: Date.now(), rounds };

      // Lore is generated purely from snapshots + optional chronicle memory.
      // It must not depend on round-result comments (separate prompt/purpose),
      // so we mark batches pending immediately.
      this.pendingBatches.push(batch);

      logger.info('lore_batch_ready', {
        id,
        size: rounds.length,
        fromRound: rounds[0]!.roundNumber,
        toRound: tailRound,
        reason: 'batch_size_reached',
        pending: this.pendingBatches.length,
      });

      this.onBatchReady?.();
    }
  }

  /** Register callback to run when a new batch is ready (worker on-demand). */
  setOnBatchReady(cb: () => void): void {
    this.onBatchReady = cb;
  }

  status(): {
    roundsStored: number;
    roundsCapacity: number;
    unbatched: number;
    batchSize: number;
    pendingBatches: number;
    pendingCapacity: number;
    lastBatchId?: string;
  } {
    const pending = this.pendingBatches.toArray();
    return {
      roundsStored: this.rounds.length,
      roundsCapacity: this.rounds.maxSize,
      unbatched: this.unbatchedQueue.length,
      batchSize: this.opts.batchSize,
      pendingBatches: this.pendingBatches.length,
      pendingCapacity: this.pendingBatches.maxSize,
      lastBatchId: pending.length ? pending[pending.length - 1]!.id : undefined,
    };
  }

  drainPending(n: number): LoreBatch[] {
    return this.pendingBatches.drain(n);
  }
}

export const loreBatcher = new LoreBatcher({
  roundsCapacity: 100, // Keep last 100 rounds (aligned with roundResultsStore capacity)
  batchSize: 20, // Create batch every 20 rounds (20 payloads per batch → 1 lore)
  pendingCapacity: 10, // Keep last 10 pending batches
});


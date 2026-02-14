import type { RoundResultEntry } from './types.js';
import { logger } from '../utils/logger.js';

/**
 * Store for round result comments (keyed by roundNumber).
 * Helper for ring buffer - maintains same capacity (100 entries).
 * Separate from ring buffer - joined at batch context building time.
 * Auto-cleanup: removes oldest entries when capacity is exceeded (FIFO).
 */
class RoundResultsStore {
  private store = new Map<number, RoundResultEntry>();
  private insertionOrder: number[] = []; // Track insertion order for FIFO cleanup
  private readonly capacity: number;

  constructor(capacity: number = 100) {
    // Default capacity: 100 (matches ring buffer capacity)
    this.capacity = capacity;
  }

  set(entry: RoundResultEntry): void {
    // If entry already exists, remove it from insertion order (we'll re-add it)
    if (this.store.has(entry.roundNumber)) {
      const idx = this.insertionOrder.indexOf(entry.roundNumber);
      if (idx >= 0) {
        this.insertionOrder.splice(idx, 1);
      }
    }

    this.store.set(entry.roundNumber, entry);
    this.insertionOrder.push(entry.roundNumber);

    // Auto-cleanup: remove oldest if capacity exceeded
    if (this.store.size > this.capacity) {
      const oldestRoundNumber = this.insertionOrder.shift();
      if (oldestRoundNumber !== undefined) {
        this.store.delete(oldestRoundNumber);
        logger.info('round_result_evicted', {
          roundNumber: oldestRoundNumber,
          reason: 'capacity_exceeded',
        });
      }
    }

    logger.info('round_result_stored', {
      roundNumber: entry.roundNumber,
      storeSize: this.store.size,
      capacity: this.capacity,
    });
  }

  get(roundNumber: number): RoundResultEntry | undefined {
    return this.store.get(roundNumber);
  }

  /**
   * Get multiple round results by roundNumbers.
   * Returns a map for efficient lookup during batch building.
   */
  getMany(roundNumbers: number[]): Map<number, RoundResultEntry> {
    const results = new Map<number, RoundResultEntry>();
    for (const rn of roundNumbers) {
      const entry = this.store.get(rn);
      if (entry) {
        results.set(rn, entry);
      }
    }
    return results;
  }

  size(): number {
    return this.store.size;
  }

  maxSize(): number {
    return this.capacity;
  }

  clear(): void {
    this.store.clear();
    this.insertionOrder = [];
  }
}

export const roundResultsStore = new RoundResultsStore(100);

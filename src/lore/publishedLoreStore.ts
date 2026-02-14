import { RingBuffer } from '../utils/ringBuffer.js';

export type PublishedLoreEntry = {
  createdAt: number;
  batchId: string;
  rootKey?: string;
  txHash?: string;
  text: string;
};

/**
 * In-memory store (ring buffer) for published lore.
 * Keeps last N published entries to provide continuity between chronicles.
 */
class PublishedLoreStore {
  private buf: RingBuffer<PublishedLoreEntry>;

  constructor(private capacity: number = 10) {
    this.buf = new RingBuffer<PublishedLoreEntry>(capacity);
  }

  push(entry: PublishedLoreEntry): void {
    this.buf.push(entry);
  }

  /** Returns newest -> oldest. */
  listNewestFirst(): PublishedLoreEntry[] {
    return this.buf.toArray().reverse();
  }

  latest(): PublishedLoreEntry | undefined {
    const arr = this.buf.toArray();
    return arr.length ? arr[arr.length - 1] : undefined;
  }

  size(): number {
    return this.buf.length;
  }

  maxSize(): number {
    return this.buf.maxSize;
  }
}

export const publishedLoreStore = new PublishedLoreStore(10);


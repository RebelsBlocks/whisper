export class DedupeStore {
  private set = new Set<string>();
  private queue: string[] = [];

  constructor(private capacity: number) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new Error(`Invalid dedupe capacity: ${capacity}`);
    }
  }

  /**
   * Returns true if key is newly added (not seen in recent window). False if duplicate.
   */
  public markOnce(key: string): boolean {
    if (this.set.has(key)) return false;

    this.set.add(key);
    this.queue.push(key);

    // Evict oldest keys past capacity
    while (this.queue.length > this.capacity) {
      const oldest = this.queue.shift();
      if (oldest) this.set.delete(oldest);
    }
    return true;
  }
}


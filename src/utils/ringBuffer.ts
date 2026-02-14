export class RingBuffer<T> {
  private buf: Array<T | undefined>;
  private head = 0; // points to oldest element
  private size = 0;

  constructor(private capacity: number) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new Error(`Invalid ring buffer capacity: ${capacity}`);
    }
    this.buf = new Array<T | undefined>(capacity);
  }

  get length(): number {
    return this.size;
  }

  get maxSize(): number {
    return this.capacity;
  }

  /**
   * Pushes an item. If buffer is full, overwrites the oldest element.
   * Returns the dropped element (if any).
   */
  push(item: T): { dropped?: T } {
    // If full, drop oldest by advancing head.
    let dropped: T | undefined;
    if (this.size === this.capacity) {
      dropped = this.buf[this.head];
      this.buf[this.head] = undefined;
      this.head = (this.head + 1) % this.capacity;
      this.size--;
    }

    const tail = (this.head + this.size) % this.capacity;
    this.buf[tail] = item;
    this.size++;
    return dropped !== undefined ? { dropped } : {};
  }

  /**
   * Returns items in chronological order (oldest -> newest).
   */
  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.size; i++) {
      const idx = (this.head + i) % this.capacity;
      const v = this.buf[idx];
      if (v !== undefined) out.push(v);
    }
    return out;
  }

  /**
   * Removes and returns up to `n` oldest elements, preserving order.
   */
  drain(n: number): T[] {
    if (!Number.isFinite(n) || n <= 0) return [];
    const count = Math.min(n, this.size);
    const out: T[] = [];

    for (let i = 0; i < count; i++) {
      const idx = (this.head + i) % this.capacity;
      const v = this.buf[idx];
      if (v !== undefined) out.push(v);
      this.buf[idx] = undefined;
    }

    this.head = (this.head + count) % this.capacity;
    this.size -= count;
    return out;
  }
}


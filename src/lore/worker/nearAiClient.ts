import OpenAI from 'openai';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';

type ReleaseFn = () => void;
type Waiter = {
  resolve: (release: ReleaseFn) => void;
  reject: (err: unknown) => void;
  timer?: ReturnType<typeof setTimeout>;
};

/**
 * Tiny FIFO semaphore to prevent concurrent NEAR AI calls.
 * This avoids self-contention (e.g. lore + per-round comment in parallel).
 */
class Semaphore {
  private available: number;
  private queue: Waiter[] = [];

  constructor(private readonly capacity: number) {
    this.available = capacity;
  }

  stats(): { capacity: number; available: number; queued: number } {
    return { capacity: this.capacity, available: this.available, queued: this.queue.length };
  }

  acquire(timeoutMs?: number): Promise<ReleaseFn> {
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve(this.makeRelease());
    }

    return new Promise<ReleaseFn>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      if (timeoutMs && timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const idx = this.queue.indexOf(waiter);
          if (idx >= 0) this.queue.splice(idx, 1);
          reject(new Error('NEAR AI queue timeout'));
        }, timeoutMs);
      }
      this.queue.push(waiter);
    });
  }

  private makeRelease(): ReleaseFn {
    let released = false;
    return () => {
      if (released) return;
      released = true;

      this.available += 1;
      const next = this.queue.shift();
      if (!next) return;

      if (next.timer) clearTimeout(next.timer);
      this.available -= 1;
      next.resolve(this.makeRelease());
    };
  }
}

let _nearAiSemaphore: Semaphore | undefined;
function getNearAiSemaphore(): Semaphore {
  if (!_nearAiSemaphore) {
    // Hard-coded single-flight queue: no env knob, deterministic behavior.
    // Prevents self-contention between roundResult vs lore vs x-notification writers.
    _nearAiSemaphore = new Semaphore(1);
  }
  return _nearAiSemaphore;
}

/**
 * Run a NEAR AI call under a global concurrency limit.
 * Keep timeouts/AbortControllers inside `fn` so the timeout doesn't "tick" while waiting in the queue.
 */
export async function withNearAiPermit<T>(
  label: string,
  fn: () => Promise<T>,
  opts?: { queueTimeoutMs?: number }
): Promise<T> {
  const sem = getNearAiSemaphore();
  const queuedBefore = sem.stats().queued;
  const waitStart = Date.now();
  if (queuedBefore > 0) {
    logger.info('near_ai_permit_waiting', { label, queued: queuedBefore });
  }

  const release = await sem.acquire(opts?.queueTimeoutMs);
  const waitedMs = Date.now() - waitStart;
  const s = sem.stats();
  logger.info('near_ai_permit_acquired', {
    label,
    waitedMs,
    queued: s.queued,
    available: s.available,
    capacity: s.capacity,
  });
  try {
    return await fn();
  } finally {
    const heldMs = Date.now() - waitStart;
    release();
    const after = sem.stats();
    logger.info('near_ai_permit_released', {
      label,
      heldMs,
      queued: after.queued,
      available: after.available,
      capacity: after.capacity,
    });
  }
}

/**
 * Singleton OpenAI client instance (reused across all requests).
 * Prevents socket exhaustion and memory leaks from creating new clients on every call.
 */
let _cachedClient: OpenAI | undefined;

export function getNearAiClient(): OpenAI {
  if (!config.nearAiApiKey) {
    throw new Error('NEAR_AI_KEY is not set');
  }
  
  if (!_cachedClient) {
    _cachedClient = new OpenAI({
      baseURL: config.nearAiBaseUrl,
      apiKey: config.nearAiApiKey,
    });
  }
  
  return _cachedClient;
}

/** Check at boot that NEAR AI key is set and API responds. */
export async function checkNearAiConnection(): Promise<{
  ok: boolean;
  model?: string;
  error?: string;
}> {
  if (!config.nearAiApiKey) {
    return { ok: false, error: 'NEAR_AI_KEY not set' };
  }

  const client = getNearAiClient();
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), 10_000);

  try {
    await client.chat.completions.create(
      {
        model: config.nearAiModel,
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 1,
      },
      { signal: ac.signal }
    );
    clearTimeout(timeout);
    return { ok: true, model: config.nearAiModel };
  } catch (err) {
    clearTimeout(timeout);
    return { ok: false, error: String(err) };
  }
}

export function stripCodeFences(text: string): string {
  const t = text.trim();
  const fenced = t.match(/```(?:\w+)?\s*([\s\S]*?)\s*```/i);
  return (fenced?.[1] ?? t).trim();
}


type Level = 'info' | 'warn' | 'error';

function nowIso(): string {
  return new Date().toISOString();
}

function serialize(v: unknown): string {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function log(level: Level, message: string, meta?: Record<string, unknown>): void {
  const base = `[whisper] ${nowIso()} ${level.toUpperCase()} ${message}`;
  const line = meta && Object.keys(meta).length ? `${base} ${serialize(meta)}` : base;

  // eslint-disable-next-line no-console
  if (level === 'error') console.error(line);
  // eslint-disable-next-line no-console
  else if (level === 'warn') console.warn(line);
  // eslint-disable-next-line no-console
  else console.log(line);
}

export const logger = {
  info(message: string, meta?: Record<string, unknown>) {
    log('info', message, meta);
  },
  warn(message: string, meta?: Record<string, unknown>) {
    log('warn', message, meta);
  },
  error(message: string, meta?: Record<string, unknown>) {
    log('error', message, meta);
  },
};


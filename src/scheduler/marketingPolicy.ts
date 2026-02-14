import { config } from '../config/index.js';

type TimeParts = { hour: number; minute: number };

function assertFiniteInt(n: number, label: string): number {
  if (!Number.isFinite(n)) throw new Error(`${label} must be finite`);
  return Math.trunc(n);
}

export function parseHHMM(s: string): TimeParts {
  const m = String(s || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) throw new Error(`Invalid time format (expected HH:MM): ${s}`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`Invalid time value: ${s}`);
  }
  return { hour, minute };
}

export function toMinutesSinceMidnight(t: TimeParts): number {
  return assertFiniteInt(t.hour * 60 + t.minute, 'minutesSinceMidnight');
}

export function getLocalMinutesSinceMidnight(date: Date, timeZone: string): number {
  // Use Intl to avoid adding a heavy timezone dependency.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date);

  const hour = Number(parts.find(p => p.type === 'hour')?.value ?? NaN);
  const minute = Number(parts.find(p => p.type === 'minute')?.value ?? NaN);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    throw new Error(`Failed to resolve local time parts for tz=${timeZone}`);
  }
  return hour * 60 + minute;
}

export function getLocalYMD(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const y = parts.find(p => p.type === 'year')?.value;
  const m = parts.find(p => p.type === 'month')?.value;
  const d = parts.find(p => p.type === 'day')?.value;
  if (!y || !m || !d) throw new Error(`Failed to resolve local date parts for tz=${timeZone}`);
  return `${y}-${m}-${d}`;
}

function isInCircularRange(min: number, start: number, end: number): boolean {
  // Range on a 0..1439 circle. If start<=end => normal range, else wraps midnight.
  if (start <= end) return min >= start && min <= end;
  return min >= start || min <= end;
}

export function getMarketingPolicy() {
  const tz = config.marketingTimezone;
  const base = toMinutesSinceMidnight(parseHHMM(config.marketingTime));

  const windowMinutes = Math.max(0, assertFiniteInt(config.marketingWindowMinutes, 'marketingWindowMinutes'));
  const jitterMinutes = Math.max(0, assertFiniteInt(config.marketingJitterMinutes, 'marketingJitterMinutes'));

  const half = Math.floor(windowMinutes / 2);
  const windowStart = (base - half + 1440) % 1440;
  const windowEnd = (base + half) % 1440;

  return {
    enabled: Boolean(config.marketingEnabled),
    timezone: tz,
    baseTimeHHMM: config.marketingTime,
    baseMinutes: base,
    windowMinutes,
    windowStartMinutes: windowStart,
    windowEndMinutes: windowEnd,
    jitterMinutes,
  };
}

export function isInMarketingWindowAt(date: Date): boolean {
  const p = getMarketingPolicy();
  const nowMin = getLocalMinutesSinceMidnight(date, p.timezone);
  return isInCircularRange(nowMin, p.windowStartMinutes, p.windowEndMinutes);
}

export function pickJitteredPublishMinutes(baseMinutes: number, jitterMinutes: number): number {
  if (jitterMinutes <= 0) return baseMinutes;

  const min = baseMinutes - jitterMinutes;
  const max = baseMinutes + jitterMinutes;
  // Pick integer minute offset in [min..max] but clamp to the same local day (0..1439).
  const picked = Math.floor(min + Math.random() * (max - min + 1));
  return Math.max(0, Math.min(1439, picked));
}


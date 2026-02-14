import cron from 'node-cron';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { withNearAiPermit, getNearAiClient, stripCodeFences } from '../lore/worker/nearAiClient.js';
import { postTweet } from '../infra/x/postPublisher.js';
import { publishedLoreStore } from '../lore/publishedLoreStore.js';
import { getLocalYMD, getMarketingPolicy, pickJitteredPublishMinutes } from './marketingPolicy.js';
import { MARKETING_CONTENT_MESSAGES, type MarketingContentMessage } from './content/marketingContentMessages.js';
import { WARS_OF_CARDS_DOCS_DIGEST } from './content/warsofcardsDocsDigest.js';

type MarketingMemory = {
  /** YYYY-MM-DD in marketingTimezone */
  lastPostedYmd?: string;
  lastPostedAt?: number;
  lastTweetId?: string;
  lastUrl?: string;
  /**
   * Recent successful marketing texts (most recent first).
   * Used to reduce repetition across days.
   */
  recentTexts?: string[];
  /** Theme ids of recent successful posts (most recent first). */
  recentThemeIds?: string[];
};

const MARKETING_RECENT_TEXTS_MAX = 10;

function shuffleInPlace<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j]!;
    arr[j] = tmp!;
  }
}

function normalizeText(s: string): string {
  return String(s || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/www\.\S+/g, '')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstWords(s: string, n: number): string {
  return normalizeText(s)
    .split(' ')
    .filter(Boolean)
    .slice(0, n)
    .join(' ');
}

function firstLongWords(s: string, n: number): string {
  return normalizeText(s)
    .split(' ')
    .filter(Boolean)
    .filter(w => w.length >= 4)
    .slice(0, n)
    .join(' ');
}

function buildDynamicStopwords(texts: string[], maxWords = 14): Set<string> {
  const counts = new Map<string, number>();
  for (const t of texts) {
    const words = normalizeText(t).match(/[\p{L}\p{N}]+/gu) ?? [];
    for (const w of words) {
      const ww = w.toLowerCase();
      if (ww.length < 4) continue;
      counts.set(ww, (counts.get(ww) ?? 0) + 1);
    }
  }
  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  return new Set(sorted.slice(0, Math.max(0, maxWords)).map(([w]) => w));
}

function tokenSet(s: string, stop?: Set<string>): Set<string> {
  const t = normalizeText(s);
  const words = t.match(/[\p{L}\p{N}]+/gu) ?? [];
  const out = new Set<string>();
  for (const w of words) {
    const ww = w.toLowerCase();
    if (ww.length < 4) continue;
    if (stop?.has(ww)) continue;
    out.add(ww);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const uni = a.size + b.size - inter;
  return uni <= 0 ? 0 : inter / uni;
}

function isTooSimilarToRecent(
  candidate: string,
  recentTexts: string[],
  stop?: Set<string>
): { ok: boolean; reason?: string } {
  const c = String(candidate || '').trim();
  if (!c) return { ok: false, reason: 'empty' };

  const c1 = firstLongWords(c, 1);
  const c2 = firstLongWords(c, 2);
  const c4 = firstLongWords(c, 4);
  const cSet = tokenSet(c, stop);

  // Strong n-gram guard: don't reuse the same first 1-2 words as any recent post.
  for (const r of recentTexts) {
    const r1 = firstLongWords(r, 1);
    const r2 = firstLongWords(r, 2);
    const r4 = firstLongWords(r, 4);
    if (c1 && r1 && c1 === r1) return { ok: false, reason: `same_first_word:${c1}` };
    if (c2 && r2 && c2 === r2) return { ok: false, reason: `same_first_two_words:${c2}` };
    if (c4 && r4 && c4 === r4) return { ok: false, reason: `same_first_four_words:${c4}` };
  }

  // Semantic-ish guard: large word overlap => likely same template.
  for (const r of recentTexts) {
    const sim = jaccard(cSet, tokenSet(r, stop));
    if (sim >= 0.62) return { ok: false, reason: `jaccard_${sim.toFixed(2)}` };
  }

  // Catchphrases that were showing up too often in practice.
  if (/spitting\s+verses/i.test(c)) return { ok: false, reason: 'catchphrase_spitting_verses' };

  return { ok: true };
}

function countSentences(text: string): number {
  const t = String(text ?? '').trim();
  if (!t) return 0;
  const matches = t.match(/[.!?]+/g);
  return matches?.length ?? 0;
}

function containsContractLikeIdentifier(text: string): boolean {
  const t = String(text ?? '');
  return (
    /\b[a-z0-9_-]+\.(near|testnet)\b/i.test(t) ||
    /\bblackjack-v\d+\b/i.test(t) ||
    /\bft\.[a-z0-9_-]+\b/i.test(t)
  );
}

function hasDarkForestVibeAnchor(text: string): boolean {
  const t = normalizeText(text);
  return /\b(dark\s+forest|forest|oracle|chronicle|lore|canopy|embers|moss)\b/i.test(t);
}

function hasOnlyNearcon26Hashtag(text: string): boolean {
  const t = String(text ?? '');
  const tags = t.match(/#[A-Za-z0-9_]+/g) ?? [];
  if (tags.length === 0) return true;
  return tags.length === 1 && tags[0] === '#NEARCON26';
}

function hasVisualSeparator(text: string): boolean {
  return String(text ?? '').includes('✦');
}

function lines(text: string): string[] {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
}

function allLinesStartWithSeparator(text: string): boolean {
  const ls = lines(text);
  if (ls.length === 0) return false;
  return ls.every(l => l.startsWith('✦ '));
}

function normalizeHashtagsOnly(text: string): string {
  // Keep at most one hashtag: #NEARCON26 at the very end (if present anywhere).
  const hadNearcon = /#NEARCON26\b/.test(String(text ?? ''));
  let t = String(text ?? '')
    // remove all hashtags
    .replace(/#[A-Za-z0-9_]+/g, '')
    // tidy whitespace but keep line breaks
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (hadNearcon) {
    const ls = t.split(/\r?\n/);
    for (let i = ls.length - 1; i >= 0; i--) {
      if (ls[i].trim()) {
        ls[i] = `${ls[i].trim()} #NEARCON26`;
        return ls.join('\n').trim();
      }
    }
    return `${t} #NEARCON26`.trim();
  }
  return t;
}

// Content-message rotation:
// - Pick from a shuffled bag until exhausted.
// - When exhausted, reshuffle and start a new cycle.
// - Stateless across restarts (RAM only).

function endsWithCleanPunctuation(text: string): boolean {
  // Allow optional trailing #NEARCON26.
  return /[.!?](\s*#NEARCON26)?$/.test(String(text ?? '').trim());
}

function normalizeMarketingText(raw: string): string {
  // Keep line breaks (we want ✦ to begin “paragraphs”).
  let t = String(raw ?? '').trim();
  if (!t) return '';

  // Normalize whitespace around newlines (but do not flatten).
  t = t.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  // Only deterministic “repair” we keep: hashtags normalization.
  // Everything else should be produced by the model (format belongs to the generator, not X publisher).
  t = normalizeHashtagsOnly(t);

  return t;
}

function parseYmdAsUtc(ymd: string): Date | null {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  return Number.isFinite(d.getTime()) ? d : null;
}

function isDateInRangeInclusive(d: Date, startYmd: string, endYmd: string): boolean {
  const s = parseYmdAsUtc(startYmd);
  const e = parseYmdAsUtc(endYmd);
  if (!s || !e) return false;
  return d.getTime() >= s.getTime() && d.getTime() <= e.getTime();
}

function getInnovationSandboxStatusForYmd(todayYmd: string): string {
  const d = parseYmdAsUtc(todayYmd);
  if (!d) return 'Innovation Sandbox: (date unknown)';
  if (isDateInRangeInclusive(d, '2026-01-26', '2026-02-16')) {
    return 'Innovation Sandbox: Builder Sprint is live (virtual-by-default).';
  }
  if (isDateInRangeInclusive(d, '2026-02-16', '2026-02-19')) {
    return 'Innovation Sandbox: Judging week (virtual).';
  }
  if (isDateInRangeInclusive(d, '2026-02-23', '2026-02-24')) {
    return 'Innovation Sandbox: Showcase days (winners featured).';
  }
  return 'Innovation Sandbox: virtual-by-default hackathon.';
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function clampInt(n: number, min: number, max: number): number {
  const v = Math.trunc(n);
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}

function minutesToMs(mins: number): number {
  return mins * 60_000;
}

function toTodayPublishDelayMs(now: Date, publishMinuteLocal: number, tz: string): number {
  // We compute delay by comparing "minutes since midnight in tz" rather than relying on Date math with tz.
  // This is safe enough for <24h timers and avoids adding a timezone lib.
  const nowYmd = getLocalYMD(now, tz);

  // Find minutes since midnight in tz for "now"
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(now);
  const h = Number(parts.find(p => p.type === 'hour')?.value ?? NaN);
  const m = Number(parts.find(p => p.type === 'minute')?.value ?? NaN);
  const s = Number(parts.find(p => p.type === 'second')?.value ?? NaN);
  if (!Number.isFinite(h) || !Number.isFinite(m) || !Number.isFinite(s)) {
    throw new Error(`Failed to resolve local h/m/s for tz=${tz}`);
  }
  const nowMinute = h * 60 + m;
  const nowMsIntoMinute = s * 1000;

  const deltaMinutes = publishMinuteLocal - nowMinute;
  const deltaMs = deltaMinutes * 60_000 - nowMsIntoMinute;
  // If already passed today, return negative.
  if (deltaMs <= 0) return deltaMs;

  // As a sanity guard: never schedule beyond the same local day.
  const maxMsRemainingInDay = minutesToMs(24 * 60 - nowMinute - 1) + (60_000 - nowMsIntoMinute);
  return Math.min(deltaMs, maxMsRemainingInDay);
}

export class MarketingPoster {
  private task: cron.ScheduledTask | null = null;
  private pendingTimer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private lastError?: string;
  private lastPlannedYmd?: string;
  private lastPlannedMinute?: number;
  private stateCache: MarketingMemory = {};
  private themeBag: MarketingContentMessage[] = [];

  getStatus() {
    const p = getMarketingPolicy();
    return {
      enabled: p.enabled,
      timezone: p.timezone,
      baseTimeHHMM: p.baseTimeHHMM,
      windowMinutes: p.windowMinutes,
      windowStartMinutes: p.windowStartMinutes,
      windowEndMinutes: p.windowEndMinutes,
      jitterMinutes: p.jitterMinutes,
      inFlight: this.inFlight,
      lastError: this.lastError,
      lastPlannedYmd: this.lastPlannedYmd,
      lastPlannedMinute: this.lastPlannedMinute,
      lastPosted: this.stateCache,
    };
  }

  async start(): Promise<void> {
    const p = getMarketingPolicy();
    // Stateless by design: keep marketing memory only in RAM.
    // Restarting the server clears marketing memory.
    this.stateCache = {};
    this.themeBag = [];

    if (!p.enabled) {
      logger.info('marketing_scheduler_disabled');
      return;
    }

    // Plan for today on boot (if not already posted).
    await this.planTodayOrTomorrow();

    // Re-plan daily at local midnight in tz (no polling loop).
    this.task = cron.schedule(
      '0 0 * * *',
      async () => {
        await this.planTodayOrTomorrow();
      },
      { timezone: p.timezone }
    );

    logger.info('marketing_scheduler_started', {
      timezone: p.timezone,
      baseTimeHHMM: p.baseTimeHHMM,
      windowMinutes: p.windowMinutes,
      jitterMinutes: p.jitterMinutes,
    });
  }

  stop(): void {
    if (this.task) {
      this.task.stop();
      this.task = null;
    }
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    logger.info('marketing_scheduler_stopped');
  }

  async postNow(opts?: { force?: boolean }): Promise<{ tweetId?: string; url?: string }> {
    return await this.generateAndPost({ force: opts?.force === true, reason: 'manual' });
  }

  private async planTodayOrTomorrow(): Promise<void> {
    const p = getMarketingPolicy();
    const now = new Date();
    const ymd = getLocalYMD(now, p.timezone);

    // If already posted today, do nothing (manual endpoint can still force).
    if (this.stateCache.lastPostedYmd === ymd) {
      logger.info('marketing_already_posted_today', { ymd });
      return;
    }

    // Pick a publish minute in local time.
    const publishMinute = pickJitteredPublishMinutes(p.baseMinutes, p.jitterMinutes);
    this.lastPlannedYmd = ymd;
    this.lastPlannedMinute = publishMinute;

    // Clear any existing pending timer and re-plan.
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }

    const delayMs = toTodayPublishDelayMs(now, publishMinute, p.timezone);
    if (delayMs <= 0) {
      // If the planned time already passed (e.g. server started late), post soon but not immediately,
      // to avoid an accidental burst right after boot.
      const backoffMs = clampInt(30_000, 5_000, 120_000);
      logger.info('marketing_planned_time_passed_posting_soon', { ymd, publishMinute, backoffMs });
      this.pendingTimer = setTimeout(() => void this.generateAndPost({ force: false, reason: 'late_boot' }), backoffMs);
      return;
    }

    logger.info('marketing_planned', { ymd, publishMinute, delayMs });
    this.pendingTimer = setTimeout(() => void this.generateAndPost({ force: false, reason: 'scheduled' }), delayMs);
  }

  private buildPrompt(
    todayYmd: string,
    theme: MarketingContentMessage,
    opts?: { attempt?: number; maxAttempts?: number; rejectHint?: string }
  ): { system: string; user: string } {
    const recent = (this.stateCache.recentTexts ?? []).filter(Boolean).slice(0, MARKETING_RECENT_TEXTS_MAX);
    const recentBlock = recent.length ? recent.map((t, i) => `${i + 1}. ${t}`).join('\n') : '(none)';
    const hackathonStatus = getInnovationSandboxStatusForYmd(todayYmd);
    const latestLore = publishedLoreStore.latest()?.text?.trim() || '';
    const latestLoreOneLine = latestLore.replace(/\s+/g, ' ').slice(0, 220);

    const system = `You are the masked voice of Wars of Cards: the Dark Forest WORLD (not casino/table talk), but social-media-friendly.
Write a short shitpost update from the project (social-media-friendly mask, not an ad).
World-first: hint at rituals, factions, omens, and chronicles — the game mechanics are background texture.
Playful, a bit zadziorny, meme-adjacent. No corporate buzzwords.
Do NOT invent features/guarantees/partnerships.`;

    const attempt = Math.max(1, Math.trunc(opts?.attempt ?? 1));
    const maxAttempts = Math.max(1, Math.trunc(opts?.maxAttempts ?? 1));
    const rejectHint = String(opts?.rejectHint ?? '').trim() || '(none)';

    const user = `Today is ${todayYmd} (local date).
${hackathonStatus}
ATTEMPT: ${attempt}/${maxAttempts}. If attempt > 1, change the opening words and hook style drastically.
REJECTION HINT (why the last attempt was rejected): ${rejectHint}

Write ONE unique X post (text-only). Goal: explain what Wars of Cards is + what's happening right now, without sounding like an ad.

RECENT POSTS (avoid repeating structure/phrases):
${recentBlock}

CONTENT MESSAGE: ${theme.id}
FOCUS: ${theme.focus}

SOURCE (paraphrase this idea payload; do not copy sentences verbatim):
${theme.source}

DOCS DIGEST (more detail; still do not quote as a list; never include addresses):
${WARS_OF_CARDS_DOCS_DIGEST}

LATEST CHRONICLE (optional canon seed; if empty, ignore):
${latestLoreOneLine || '(none)'}

MARKETING MEMORY RULES (mini-series):
- If RECENT POSTS is non-empty, include ONE subtle callback to the most recent post (a running gag / motif), but never copy a full clause.
- Keep callbacks playful and short (3–8 words). No "as we said yesterday".
- Stay consistent with the Dark Forest world vibe, but don't force the same words every day.

Facts you may hint at (keep it casual, not list-y; do NOT lead with mechanics):
- Wars of Cards is a Web3 game world living on NEAR.
- One ritual running now: live multiplayer blackjack (moves can be instant/off-chain; settlement on-chain).
- CARDS token economy with daily claim (no addresses).
- Whisper reacts to round-end events with real-time commentary + periodic chronicles on NEAR Social.
- NEAR AI inference runs on NVIDIA GPUs (don't mention confidential computing / privacy guarantees).
- Poker is in development.

Hard bans:
- No links/URLs.
- No contract/token/account addresses (no ".near", "ft.", "blackjack-v2", etc).

CTA:
- Nudge people to open THIS profile for what’s live + the latest chronicles, but DO NOT say "check this profile" or "visit our profile" explicitly.

Tone mask:
- Dark Forest world vibe (forest/oracle/chronicle/embers/moss) but readable and funny.
- Avoid “dealer / table / casino” words unless it’s a rare, deliberate one-off.`;

    // Append a couple marketing-specific allowances without making the core prompt noisy.
    // Keep them here to avoid re-litigating style rules in other prompts.
    const systemWithExtras =
      system +
      `\n\nMARKETING FORMAT:\n- Output 1–2 short lines.\n- EACH line must start with "✦ " (the symbol begins a new paragraph).\n- 0–3 emojis total.\n- Hashtags: either none OR exactly one hashtag: #NEARCON26 (must be at the very end).\n- No links/URLs (do NOT include "http", "https", or "www").`;

    return { system: systemWithExtras, user };
  }

  private nextThemeForPost(): MarketingContentMessage {
    if (!MARKETING_CONTENT_MESSAGES.length) {
      throw new Error('marketing_no_content_messages_configured');
    }
    if (this.themeBag.length === 0) {
      this.themeBag = [...MARKETING_CONTENT_MESSAGES];
      shuffleInPlace(this.themeBag);
    }
    // Pop one. Retry attempts for the same post keep the same theme.
    return this.themeBag.pop()!;
  }

  // (No separate generateTweetText) — marketing uses content messages + validation loop below.

  private validateMarketingText(text: string): { ok: boolean; reason?: string } {
    const t = String(text ?? '').trim();
    if (!t) return { ok: false, reason: 'empty' };

    // No links/URLs
    if (/(https?:\/\/|www\.)/i.test(t)) return { ok: false, reason: 'contains_url' };

    // No raw contract/token identifiers
    if (containsContractLikeIdentifier(t)) return { ok: false, reason: 'contains_contract_identifier' };

    // ✦ starts a new paragraph: each line must start with it
    const ls = lines(t);
    if (ls.length < 1 || ls.length > 2) return { ok: false, reason: `line_count_${ls.length}` };
    if (!allLinesStartWithSeparator(t)) return { ok: false, reason: 'bad_separator_lines' };

    // Hashtags: only #NEARCON26 (or none)
    if (!hasOnlyNearcon26Hashtag(t)) return { ok: false, reason: 'invalid_hashtag' };
    // If present, hashtag must be at the very end.
    if (/#NEARCON26\b/.test(t) && !/#NEARCON26$/.test(t)) return { ok: false, reason: 'hashtag_not_at_end' };

    // CTA: avoid saying "check this profile" explicitly
    if (/check\s+(this|the)\s+profile/i.test(t)) return { ok: false, reason: 'explicit_check_profile' };
    if (/visit\s+(this|our)\s+profile/i.test(t)) return { ok: false, reason: 'explicit_visit_profile' };

    // Keep Dark Forest narrative cohesion
    if (!hasDarkForestVibeAnchor(t)) return { ok: false, reason: 'missing_dark_forest_anchor' };

    return { ok: true };
  }

  private async generateMarketingTextWithRetries(): Promise<{ text: string; themeId: string }> {
    const p = getMarketingPolicy();
    const todayYmd = getLocalYMD(new Date(), p.timezone);
    const theme = this.nextThemeForPost();

    const maxAttempts = 2;
    let last = '';
    let rejectHint = '(none)';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const { system, user } = this.buildPrompt(todayYmd, theme, { attempt, maxAttempts, rejectHint });
      const client = getNearAiClient();
      const completion = await client.chat.completions.create({
        model: config.nearAiModel,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 1.05,
        max_tokens: 220,
      });

      const raw = completion.choices[0]?.message?.content ?? '';
      const text = normalizeMarketingText(stripCodeFences(String(raw)));
      last = text;

      const v = this.validateMarketingText(text);
      if (v.ok) return { text, themeId: theme.id };

      rejectHint = v.reason ?? 'rejected';
      logger.info('marketing_regen_rejected', { attempt, reason: rejectHint, preview: text.slice(0, 120) });
    }

    // If we couldn't satisfy the validator, return the last attempt but still report the theme.
    return { text: last, themeId: theme.id };
  }

  /**
   * X Premium can support longer posts; we avoid aggressive shortening.
   * Still keep a hard cap as a safety guard against runaway generations.
   */
  private enforceHardCap(text: string): string {
    const HARD_CAP = 25_000;
    const t = String(text ?? '').trim();
    return t.length <= HARD_CAP ? t : t.slice(0, HARD_CAP);
  }

  private async generateAndPost(opts: { force: boolean; reason: string }): Promise<{ tweetId?: string; url?: string }> {
    const p = getMarketingPolicy();
    if (!p.enabled) return {};

    const now = new Date();
    const ymd = getLocalYMD(now, p.timezone);

    if (!opts.force && this.stateCache.lastPostedYmd === ymd) {
      logger.info('marketing_skip_already_posted_today', { ymd, reason: opts.reason });
      return {};
    }

    if (this.inFlight) {
      logger.info('marketing_skip_in_flight', { ymd, reason: opts.reason });
      return {};
    }

    this.inFlight = true;
    this.lastError = undefined;

    try {
      logger.info('marketing_generating', { ymd, reason: opts.reason });

      const draft = await withNearAiPermit('marketing_post', async () => {
        return await this.generateMarketingTextWithRetries();
      });
      const text = this.enforceHardCap(draft.text);

      if (!text.trim()) {
        throw new Error('marketing_empty_text');
      }

      logger.info('marketing_posting_to_x', { ymd, chars: text.length });
      const res = await postTweet(text);

      logger.info('marketing_posted', { ymd, tweetId: res.tweetId, url: res.url });

      const prev = (this.stateCache.recentTexts ?? []).filter(Boolean);
      const nextRecent = [text, ...prev].slice(0, MARKETING_RECENT_TEXTS_MAX);
      const themePrev = (this.stateCache.recentThemeIds ?? []).filter(Boolean);
      // Theme rotation is kept in RAM via themeBag; this list is for introspection/status only.
      const themeNext = [draft.themeId, ...themePrev].slice(0, MARKETING_RECENT_TEXTS_MAX);
      this.stateCache = {
        lastPostedYmd: ymd,
        lastPostedAt: Date.now(),
        lastTweetId: res.tweetId,
        lastUrl: res.url,
        recentTexts: nextRecent,
        recentThemeIds: themeNext,
      };

      return { tweetId: res.tweetId, url: res.url };
    } catch (err) {
      this.lastError = String(err);
      logger.warn('marketing_failed', { ymd, err: String(err) });
      throw err;
    } finally {
      this.inFlight = false;
      // If scheduler is enabled, always plan next day at midnight tick.
      // For manual triggers, do nothing.
      await sleep(0);
    }
  }
}

export const marketingPoster = new MarketingPoster();


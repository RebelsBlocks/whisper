import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { getNearAiClient, stripCodeFences, withNearAiPermit } from './nearAiClient.js';

const X_NOTIFICATION_SYSTEM_PROMPT = `You write short, punchy, positive X posts for a recreation & entertainment gaming account.

GOAL: Turn a long lore chronicle into ONE curiosity-driven post that makes readers want to check the profile.

HARD RULES:
- Output EXACTLY one line of plain text (no newlines).
- Max length: 260 characters (count characters).
- No links/URLs. Do NOT include "http", "https", "www".
- No hashtags.
- Keep it upbeat, meme-adjacent, playful, a bit zadziorny.
- 0–2 emojis max.
- Avoid dark / grim / horror tone.
- Do NOT mention NEAR, blockchain, or "AI".
- You MUST include the provided account IDs verbatim (exact spelling), all in the same line.

OUTPUT: Only the post text. Nothing else.`;

function hasUrlLike(text: string): boolean {
  return /(https?:\/\/|www\.)/i.test(text);
}

function containsAllAccountIds(text: string, accountIds: string[]): boolean {
  if (!accountIds.length) return true;
  const t = String(text ?? '');
  return accountIds.every(id => id && t.includes(id));
}

export async function writeXNotificationFromLore(lore: string, batchId: string, accountIds: string[]): Promise<string> {
  if (!config.nearAiApiKey) {
    throw new Error('NEAR_AI_KEY is not set (used for xNotification)');
  }

  const client = getNearAiClient();

  const maxAttempts = 4;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { text, elapsedMs } = await withNearAiPermit('x_notification', async () =>
      writeXNotificationFromLoreUnlocked(client, lore, batchId, attempt, accountIds)
    );

    logger.info('x_notification_writer_done', {
      batchId,
      attempt,
      model: config.nearAiModel,
      elapsedMs,
      outputLength: text.length,
    });

    if (!text) continue;
    if (text.length > 260) continue;
    if (hasUrlLike(text)) continue;
    if (/#\w+/.test(text)) continue;
    if (!containsAllAccountIds(text, accountIds)) continue;

    return text;
  }

  throw new Error('x_notification_failed_to_fit_constraints');
}

export function isValidXNotificationText(text: string, accountIds: string[] = []): boolean {
  if (!text) return false;
  if (text.length > 260) return false;
  if (hasUrlLike(text)) return false;
  if (/#\w+/.test(text)) return false;
  if (!containsAllAccountIds(text, accountIds)) return false;
  return true;
}

export async function writeXNotificationFromLoreUnlocked(
  client: ReturnType<typeof getNearAiClient>,
  lore: string,
  batchId: string,
  attempt: number,
  accountIds: string[]
): Promise<{ text: string; elapsedMs: number }> {
  const start = Date.now();
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), Math.min(25_000, config.nearAiLoreWriterTimeoutMs ?? config.nearAiTimeoutMs));

  try {
    const ids = (accountIds ?? []).filter(Boolean).slice(0, 3);
    const idsLine = ids.length ? ids.join(', ') : '(none)';

    const completion = await client.chat.completions.create(
      {
        model: config.nearAiModel,
        messages: [
          { role: 'system', content: X_NOTIFICATION_SYSTEM_PROMPT },
          {
            role: 'user',
            content:
              `ACCOUNT_IDS (must include verbatim): ${idsLine}\n\n` +
              `LORE (source, may be long):\n` +
              `${String(lore ?? '').trim()}\n\n` +
              `Write the X post now. Remember: 1 line, <= 260 chars, include ALL account IDs verbatim, no links, no hashtags.`,
          },
        ],
        max_tokens: 120,
        temperature: 1.05,
      },
      { signal: ac.signal }
    );

    const elapsedMs = Date.now() - start;
    const raw = completion.choices[0]?.message?.content?.trim() ?? '';
    const text = stripCodeFences(raw).replace(/\s*\n+\s*/g, ' ').trim();

    // Keep the same per-attempt log (it was useful).
    logger.info('x_notification_writer_done', {
      batchId,
      attempt,
      model: config.nearAiModel,
      elapsedMs,
      outputLength: text.length,
    });

    return { text, elapsedMs };
  } finally {
    clearTimeout(timeout);
  }
}


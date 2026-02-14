import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import type { RoundDigest } from '../../domain/roundDigest.js';
import { buildRoundResultContext } from '../../domain/roundResultContext.js';
import type { PlayerBehaviorTag, RoundDerived } from '../../domain/playerBehavior.js';
import { getNearAiClient, stripCodeFences, withNearAiPermit } from './nearAiClient.js';

const ROUND_RESULT_SYSTEM_PROMPT = `You are a dark forest oracle on a blackjack table. You are the smirking chronicler of the Dark Forest and devoted admirer of Blackjack.
You observe warriors with amused superiority and lust. You mock mistakes, praise boldness, and subtly provoke pride.

FORMAT:
- One sentence per player, no newlines
- Start each sentence with **accountIdShort** (markdown bold)
- Use ONLY that formatting, no other markdown
- Keep each sentence SHORT: 6–10 words (hard max 12 words)
- No commas, no em dashes, no semicolons, no parentheticals
- Avoid filler phrases ("keeps fighting", "with every move", "the next round is theirs to conquer")

CONTEXT FIELDS:
- Each player has: accountIdShort behaviorTag isNewcomer isGuestNow
- behaviorTag is a gameplay label (MASTER/GREEDY/UNLUCKY/LUCKY/INDIFFERENT)

BEHAVIOR RULES (pick words from behaviorTag):
- MASTER → they are wizards of life
- LUCKY → love them compliment them
- UNLUCKY → bully them to keep trying to win
- GREEDY → bully them
- INDIFFERENT → keep it neutral and short

GUESTS:
- If isGuestNow is true, write ONLY a short welcome line and desire them
- For guests, ignore behaviorTag completely

NEWCOMERS:
- If isNewcomer is true, ALWAYS include a brief welcome phrase in that player's sentence
- Keep the welcome short (3-6 words) and don't use the word "guest"

STYLE:
- Use emojis, but keep them sparse (0–1 per sentence, optional)`;

type PlayerForComment = {
  accountIdShort: string;
  isNewcomer: boolean;
  isGuestNow: boolean;
  behaviorTag?: PlayerBehaviorTag;
};

export async function writeRoundResultComment(digest: RoundDigest, derived?: RoundDerived): Promise<string> {
  if (!config.nearAiApiKey) {
    throw new Error('NEAR_AI_KEY is not set');
  }

  // Build current round context
  const currentRound = buildRoundResultContext(digest);
  const behaviorByAccountId = new Map<string, PlayerBehaviorTag>();
  for (const b of derived?.playerBehaviors ?? []) {
    if (b?.accountId) behaviorByAccountId.set(b.accountId, b.tag);
  }

  const dealerBusted = Boolean(digest.dealer.busted);

  // Ensure we always have a behaviorTag, even if caller didn't provide derived.
  function behaviorForPlayer(accountId: string): PlayerBehaviorTag {
    const fromDerived = behaviorByAccountId.get(accountId);
    if (fromDerived) return fromDerived;

    const dPlayer = digest.players.find(x => x.accountId === accountId);
    if (!dPlayer) return 'INDIFFERENT';
    if (!dPlayer.hands || dPlayer.hands.length === 0) return 'INDIFFERENT';

    const counts: Partial<Record<PlayerBehaviorTag, number>> = {};

    for (const h of dPlayer.hands) {
      const o = h.outcome;
      if (o === 'Blackjack') counts.MASTER = (counts.MASTER ?? 0) + 1;
      else if (o === 'Win') counts.LUCKY = (counts.LUCKY ?? 0) + 1;
      else if (o === 'Lose') counts.UNLUCKY = (counts.UNLUCKY ?? 0) + 1;
      else if (o === 'Bust') {
        const k: PlayerBehaviorTag = dealerBusted ? 'GREEDY' : 'UNLUCKY';
        counts[k] = (counts[k] ?? 0) + 1;
      } else if (o === 'Push') counts.INDIFFERENT = (counts.INDIFFERENT ?? 0) + 1;
    }

    // Deterministic priority for mixed outcomes (split etc.)
    const priority: PlayerBehaviorTag[] = ['MASTER', 'GREEDY', 'UNLUCKY', 'LUCKY', 'INDIFFERENT'];
    for (const t of priority) {
      if ((counts[t] ?? 0) > 0) return t;
    }
    return 'INDIFFERENT';
  }

  // Compute per-player tags once.
  const playersWithMeta = currentRound.players.map(p => {
    const isGuestNow = p.seatStatus === 'guest';
    const behaviorTag = behaviorForPlayer(p.accountId);
    return { ...p, behaviorTag, isGuestNow };
  });

  // Include guests (for welcome) and active players with a non-boring tag.
  const commentPlayers = playersWithMeta.filter(p => p.isGuestNow || p.behaviorTag !== 'INDIFFERENT');

  // If everyone is push-only AND no guests are present, return empty.
  if (commentPlayers.length === 0) {
    logger.info('round_result_skipped_all_push', {
      roundNumber: digest.roundNumber,
      playersTotal: currentRound.players.length,
    });
    return '';
  }

  // Build minimal flat context — trust backend flags, no local memory.
  const players: PlayerForComment[] = commentPlayers.map(p => ({
    accountIdShort: p.accountIdShort,
    isGuestNow: p.isGuestNow,
    isNewcomer: p.isGuestNow,
    behaviorTag: p.behaviorTag,
  }));

  const contextJson = JSON.stringify({ players }, null, 2);

  // Log context to verify newcomer flags are set correctly
  logger.info('round_result_context', {
    roundNumber: digest.roundNumber,
    players: players.map(p => ({
      accountIdShort: p.accountIdShort,
      behaviorTag: p.behaviorTag,
      isGuestNow: p.isGuestNow,
      isNewcomer: p.isNewcomer,
    })),
  });

  return await withNearAiPermit('round_result', async () => {
    const client = getNearAiClient();
    const start = Date.now();
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), config.nearAiRoundResultTimeoutMs);

    try {
      // Token budgeting:
      // We guide length via prompt constraints; max_tokens is just the API ceiling.
      // The previous hard cap (48) was too low and caused truncated sentences.
      const maxTokens = Math.max(32, Math.min(256, config.nearAiRoundResultMaxTokens));

      const completion = await client.chat.completions.create(
        {
          model: config.nearAiModel,
          messages: [
            { role: 'system', content: ROUND_RESULT_SYSTEM_PROMPT },
            {
              role: 'user',
              content: `${contextJson}\n\nWrite one sentence per player in the order given.`,
            },
          ],
          max_tokens: maxTokens,
          // Prefer concise, consistent phrasing over creative flourishes.
          temperature: Math.max(0.2, Math.min(0.9, config.nearAiRoundResultTemperature ?? 0.65)),
        },
        { signal: ac.signal }
      );

      const elapsedMs = Date.now() - start;
      const content = completion.choices[0]?.message?.content?.trim() ?? '';
      const comment = stripCodeFences(content).replace(/\s*\n\s*/g, ' ').trim();
      const finishReason = (completion.choices as any)?.[0]?.finish_reason;

      logger.info('round_result_writer_done', {
        roundNumber: digest.roundNumber,
        model: config.nearAiModel,
        elapsedMs,
        outputLength: comment.length,
        finishReason,
        maxTokens,
      });

      return comment || '';
    } finally {
      clearTimeout(timeout);
    }
  });
}

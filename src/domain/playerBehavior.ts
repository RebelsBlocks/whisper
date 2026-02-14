import type { RoundSnapshot } from './roundSnapshot.js';
import { buildRoundDigest, type HandOutcome, type RoundDigest } from './roundDigest.js';

export type PlayerBehaviorTag = 'MASTER' | 'GREEDY' | 'UNLUCKY' | 'LUCKY' | 'INDIFFERENT';

export type PlayerBehavior = {
  accountId: string;
  seatNumber: number;
  tag: PlayerBehaviorTag;
  /** Optional: helps debugging / aggregation. */
  tagCounts: Partial<Record<PlayerBehaviorTag, number>>;
};

export type RoundDerived = {
  dealerBusted?: boolean;
  dealerBlackjack?: boolean;
  playerBehaviors: PlayerBehavior[];
};

function inc(map: Partial<Record<PlayerBehaviorTag, number>>, tag: PlayerBehaviorTag): void {
  map[tag] = (map[tag] ?? 0) + 1;
}

function tagFromHandOutcome(outcome: HandOutcome, dealerBusted: boolean | undefined): PlayerBehaviorTag | undefined {
  if (outcome === 'Blackjack') return 'MASTER';
  if (outcome === 'Push') return 'INDIFFERENT';
  if (outcome === 'Win') return 'LUCKY';
  if (outcome === 'Bust') return dealerBusted ? 'GREEDY' : 'UNLUCKY';
  if (outcome === 'Lose') return 'UNLUCKY';
  return undefined;
}

function pickDominantTag(counts: Partial<Record<PlayerBehaviorTag, number>>): PlayerBehaviorTag {
  // Deterministic priority for mixed outcomes (split, etc.)
  const priority: PlayerBehaviorTag[] = ['MASTER', 'GREEDY', 'UNLUCKY', 'LUCKY', 'INDIFFERENT'];
  for (const t of priority) {
    if ((counts[t] ?? 0) > 0) return t;
  }
  return 'INDIFFERENT';
}

/**
 * Derive simple "behavior tags" per player for a round.
 * This is intentionally lightweight and LLM-friendly.
 */
export function deriveRoundBehaviors(snapshot: RoundSnapshot): RoundDerived {
  const digest = buildRoundDigest(snapshot);
  return deriveRoundBehaviorsFromDigest(digest);
}

/**
 * Same as `deriveRoundBehaviors`, but avoids rebuilding digest when you already have it.
 */
export function deriveRoundBehaviorsFromDigest(digest: RoundDigest): RoundDerived {
  const dealerBusted = digest.dealer.busted;
  const dealerBlackjack = digest.dealer.blackjack;

  const playerBehaviors: PlayerBehavior[] = digest.players.map(p => {
    const tagCounts: Partial<Record<PlayerBehaviorTag, number>> = {};

    for (const h of p.hands) {
      const tag = tagFromHandOutcome(h.outcome, dealerBusted);
      if (tag) inc(tagCounts, tag);
    }

    const tag = pickDominantTag(tagCounts);
    return {
      accountId: p.accountId,
      seatNumber: p.seatNumber,
      tag,
      tagCounts,
    };
  });

  return {
    dealerBusted,
    dealerBlackjack,
    playerBehaviors,
  };
}


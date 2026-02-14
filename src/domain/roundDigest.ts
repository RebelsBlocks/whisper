import type { RoundSnapshot } from './roundSnapshot.js';

type Rank = 'ACE' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '10' | 'JACK' | 'QUEEN' | 'KING';
type Suit = 'HEARTS' | 'DIAMONDS' | 'CLUBS' | 'SPADES';

type DigestCard = { suit: Suit; rank: Rank };

export type HandOutcome = 'Blackjack' | 'Win' | 'Push' | 'Lose' | 'Bust' | 'Unknown';

export type RoundDigest = {
  roundNumber: number;
  ts: number;

  dealer: {
    cards: DigestCard[];
    cardCount: number;
    finalValue?: number;
    totalsByDraw: number[]; // running "best" total after each card, based on ordered cards
    blackjack?: boolean;
    busted?: boolean;
    result?: string;
  };

  players: Array<{
    accountId: string;
    seatNumber: number;
    /** Optional seat status sent by backend ("guest" => welcome mention). */
    seatStatus?: 'active' | 'guest';
    /**
     * Optional hint from backend: player was "guest" in previous round,
     * and should be briefly welcomed when announcing this round's result.
     */
    wasGuestPreviousRound?: boolean;
    balanceStart?: number;
    balanceEnd?: number;
    hadSplit: boolean; // true if player split (any hand); split is only ever from hand 1
    hands: Array<{
      handIndex: number;
      bet: number;
      payout?: number; // gross payout (as sent from backend), not net
      result?: string;
      outcome: HandOutcome;
      cards: DigestCard[];
      cardCount: number;
      finalValue?: number;
      totalsByDraw: number[];
      blackjack: boolean;
      busted: boolean;
      doubled: boolean;
      split: boolean;
    }>;
  }>;
};

function isTenValue(rank: Rank): boolean {
  return rank === '10' || rank === 'JACK' || rank === 'QUEEN' || rank === 'KING';
}

function rankBaseValue(rank: Rank): number {
  if (rank === 'ACE') return 11;
  if (rank === 'JACK' || rank === 'QUEEN' || rank === 'KING') return 10;
  return Number(rank);
}

function bestTotal(cards: Array<{ rank: Rank }>): number {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    if (c.rank === 'ACE') aces++;
    total += rankBaseValue(c.rank);
  }
  // downgrade aces from 11 to 1 until <= 21 or no more aces
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return total;
}

function totalsByDraw(cards: DigestCard[]): number[] {
  const out: number[] = [];
  const seen: DigestCard[] = [];
  for (const c of cards) {
    seen.push(c);
    out.push(bestTotal(seen));
  }
  return out;
}

function detectBlackjack(result: string | undefined, value: number | undefined, cards: Array<{ rank: Rank }> | undefined): boolean {
  if (result && String(result).toLowerCase().includes('blackjack')) return true;
  if (value === 21 && Array.isArray(cards) && cards.length === 2) {
    const r0 = cards[0]?.rank;
    const r1 = cards[1]?.rank;
    if (!r0 || !r1) return false;
    return (r0 === 'ACE' && isTenValue(r1)) || (r1 === 'ACE' && isTenValue(r0));
  }
  return false;
}

function detectBusted(result: string | undefined, value: number | undefined): boolean {
  if (result && String(result).toLowerCase().includes('bust')) return true;
  if (value !== undefined && Number.isFinite(value) && value > 21) return true;
  return false;
}

function normalizeOutcome(result: string | undefined, blackjack: boolean, busted: boolean): HandOutcome {
  if (blackjack) return 'Blackjack';
  if (busted) return 'Bust';
  const r = String(result || '').toLowerCase();
  if (r === 'win') return 'Win';
  if (r === 'lose') return 'Lose';
  if (r === 'push') return 'Push';
  // Some backends use enums like "Blackjack", "Bust", etc.
  if (r.includes('win')) return 'Win';
  if (r.includes('lose')) return 'Lose';
  if (r.includes('push')) return 'Push';
  return 'Unknown';
}

export function buildRoundDigest(snapshot: RoundSnapshot): RoundDigest {
  const players = snapshot.players.map(p => {
    const hands = p.hands.map(h => {
      const bet = Number(h.bet || 0);
      const payout = h.payout;
      const cards = (h.cards || []) as DigestCard[];

      const blackjack = detectBlackjack(h.result, h.handValue, h.cards);
      const busted = detectBusted(h.result, h.handValue);
      const outcome = normalizeOutcome(h.result, blackjack, busted);

      return {
        handIndex: h.handIndex,
        bet,
        payout,
        result: h.result,
        outcome,
        cards,
        cardCount: cards.length,
        finalValue: h.handValue,
        totalsByDraw: totalsByDraw(cards),
        blackjack,
        busted,
        doubled: Boolean(h.hasDoubled),
        split: Boolean(h.hasSplit),
      };
    });

    const hadSplit = hands.some(h => h.split);
    return {
      accountId: p.accountId,
      seatNumber: p.seatNumber,
      seatStatus: p.seatStatus,
      wasGuestPreviousRound: p.wasGuestPreviousRound,
      balanceStart: p.balanceStart,
      balanceEnd: p.balanceEnd,
      hadSplit,
      hands,
    };
  });

  const dealerCards = (snapshot.dealer.cards || []) as DigestCard[];

  const dealerTotals = totalsByDraw(dealerCards);
  const dealerFinalValue = snapshot.dealer.dealerValue ?? (dealerCards.length ? dealerTotals[dealerTotals.length - 1] : undefined);

  return {
    roundNumber: snapshot.roundNumber,
    ts: snapshot.createdAt,
    dealer: {
      cards: dealerCards,
      cardCount: dealerCards.length,
      finalValue: dealerFinalValue,
      totalsByDraw: dealerTotals,
      blackjack: snapshot.dealer.dealerHasBlackjack,
      busted: snapshot.dealer.dealerBusted,
      result: snapshot.dealer.dealerResult,
    },
    players,
  };
}


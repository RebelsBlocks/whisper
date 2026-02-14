import type { RoundDigest } from './roundDigest.js';

/**
 * Shortens hex addresses (0x... or 64-char non-dotted strings) but keeps
 * human-readable NEAR account names intact (e.g. "warrior.testnet").
 */
function shortenAccountId(accountId: string): string {
  if (!accountId) return '';
  
  // Detect hex addresses: starts with 0x OR (long string without dots)
  const isHexAddress = accountId.startsWith('0x') || 
                       (accountId.length >= 40 && !accountId.includes('.'));
  
  // Only shorten hex addresses
  if (isHexAddress && accountId.length > 16) {
    return `${accountId.slice(0, 6)}…${accountId.slice(-6)}`;
  }
  
  // Keep human-readable names as-is (NEAR names, etc.)
  return accountId;
}

export type RoundResultContext = {
  roundNumber: number;
  players: Array<{
    accountId: string; // Full accountId (needed for history lookup)
    accountIdShort: string;
    seatNumber: number;
    /** Optional seat status sent by backend ("guest" => welcome mention). */
    seatStatus?: 'active' | 'guest';
    /** Optional hint from backend; used only for welcoming newcomers in round results. */
    wasGuestPreviousRound?: boolean;
    balanceStart?: number;
    balanceEnd?: number;
    totalBet: number;
    totalPayout: number;
    net: number; // totalPayout - totalBet
    hands: Array<{ bet: number; payout?: number; outcome: string }>;
  }>;
};

export function buildRoundResultContext(digest: RoundDigest): RoundResultContext {
  const players = digest.players.map(p => {
    const totalBet = p.hands.reduce((s, h) => s + h.bet, 0);
    const totalPayout = p.hands.reduce((s, h) => s + (h.payout ?? 0), 0);
    const net = totalPayout - totalBet;
    const hands = p.hands.map(h => ({
      bet: h.bet,
      payout: h.payout,
      outcome: h.outcome,
    }));

    return {
      accountId: p.accountId, // Full accountId for history lookup
      accountIdShort: shortenAccountId(p.accountId),
      seatNumber: p.seatNumber,
      seatStatus: p.seatStatus,
      wasGuestPreviousRound: p.wasGuestPreviousRound,
      balanceStart: p.balanceStart,
      balanceEnd: p.balanceEnd,
      totalBet,
      totalPayout,
      net,
      hands,
    };
  });

  return {
    roundNumber: digest.roundNumber,
    players,
  };
}

import type { RoundDigest } from './roundDigest.js';

function fmtPayout(payout: number | undefined): string {
  if (payout === undefined || payout === null) return 'n/a';
  return String(payout);
}

function suitGlyph(suit: string): string {
  switch (suit) {
    case 'HEARTS':
      return '♥';
    case 'DIAMONDS':
      return '♦';
    case 'CLUBS':
      return '♣';
    case 'SPADES':
      return '♠';
    default:
      return '';
  }
}

function rankShort(rank: string): string {
  if (rank === 'ACE') return 'A';
  if (rank === 'KING') return 'K';
  if (rank === 'QUEEN') return 'Q';
  if (rank === 'JACK') return 'J';
  return rank;
}

function fmtCards(cards: Array<{ rank: string; suit: string }>): string {
  if (!cards.length) return '—';
  return cards.map(c => `${rankShort(c.rank)}${suitGlyph(c.suit)}`).join(' ');
}

function fmtTotalsByDraw(totals: number[]): string {
  if (!totals.length) return '—';
  return totals.join(' → ');
}

export function digestToText(d: RoundDigest): string {
  const lines: string[] = [];
  lines.push(`Round ${d.roundNumber}`);
  lines.push(`Dealer`);
  lines.push(`Cards (${d.dealer.cardCount}): ${fmtCards(d.dealer.cards)}`);
  if (d.dealer.finalValue !== undefined) lines.push(`Final value: ${d.dealer.finalValue}`);
  if (d.dealer.totalsByDraw.length) lines.push(`Totals by draw: ${fmtTotalsByDraw(d.dealer.totalsByDraw)}`);
  if (d.dealer.blackjack !== undefined) lines.push(`Blackjack: ${d.dealer.blackjack ? 'yes' : 'no'}`);
  if (d.dealer.busted !== undefined) lines.push(`Busted: ${d.dealer.busted ? 'yes' : 'no'}`);
  if (d.dealer.result) lines.push(`Result: ${d.dealer.result}`);
  lines.push(`Players`);

  if (d.players.length === 0) {
    lines.push(`(no players in snapshot)`);
  } else {
    for (const p of d.players) {
      const seatLabel = p.hadSplit ? `Seat ${p.seatNumber} — ${p.accountId} (Split)` : `Seat ${p.seatNumber} — ${p.accountId}`;
      lines.push(seatLabel);
      for (const h of p.hands) {
        const betLabel = h.doubled ? `bet ${h.bet} (Doubled)` : `bet ${h.bet}`;
        const resultAddsInfo = h.result && String(h.result).toLowerCase() !== String(h.outcome).toLowerCase();
        const outcomeSuffix = resultAddsInfo ? ` (${h.result})` : '';
        lines.push(
          `Hand ${h.handIndex}: cards ${fmtCards(h.cards)} (value ${h.finalValue ?? '—'}; totals ${fmtTotalsByDraw(
            h.totalsByDraw
          )}) — ${betLabel}, payout ${fmtPayout(h.payout)}, outcome ${h.outcome}${outcomeSuffix}`
        );
      }
    }
  }

  return lines.join('\n');
}

// Backwards-compatible alias (historical name).
export const digestToMarkdown = digestToText;


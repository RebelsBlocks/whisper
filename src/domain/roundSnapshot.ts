import { z } from 'zod';

const CardSchema = z.object({
  suit: z.enum(['HEARTS', 'DIAMONDS', 'CLUBS', 'SPADES']),
  rank: z.enum(['ACE', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'JACK', 'QUEEN', 'KING']),
  isFaceUp: z.boolean().optional(),
});

const HandSchema = z.object({
  handIndex: z.number().int(),
  bet: z.number(),
  cards: z.array(CardSchema),
  hasDoubled: z.boolean(),
  hasSplit: z.boolean(),
  isFinished: z.boolean(),
  result: z.string().optional(),
  payout: z.number().optional(),
  handValue: z.number().optional(),
});

const PlayerSchema = z.object({
  accountId: z.string(),
  seatNumber: z.number().int(),
  /**
   * Optional seat status sent by blackjack backend.
   * - "active": player actually played this round (has hands)
   * - "guest": waiting to join; should be welcomed in round result (no mechanics mentioned)
   */
  seatStatus: z.enum(['active', 'guest']).optional(),
  /**
   * Optional hint from blackjack backend:
   * true => this player should be welcomed in the round result.
   *
   * NOTE: Kept for backward-compatibility with older payload drafts.
   * Prefer sending seatStatus="guest" instead.
   */
  wasGuestPreviousRound: z.boolean().optional(),
  // Optional balances (sent by blackjack backend for better LLM context)
  balanceStart: z.number().optional(),
  balanceEnd: z.number().optional(),
  hands: z.array(HandSchema),
});

export const RoundSnapshotSchema = z.object({
  roundNumber: z.number().int(),
  createdAt: z.number().int(),
  dealer: z.object({
    cards: z.array(CardSchema),
    dealerValue: z.number().int().optional(),
    dealerHasBlackjack: z.boolean().optional(),
    dealerBusted: z.boolean().optional(),
    dealerResult: z.string().optional(),
  }),
  players: z.array(PlayerSchema),
});

export type RoundSnapshot = z.infer<typeof RoundSnapshotSchema>;


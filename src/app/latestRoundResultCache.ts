/**
 * In-memory store for the latest round_result only.
 * GET /lore/round-result/latest always returns this; overwritten on each new round.
 */

export type RoundResultEntry = {
  roundNumber: number;
  comment: string;
};

let lastRoundResult: RoundResultEntry | null = null;

export function setLastRoundResult(entry: RoundResultEntry): void {
  lastRoundResult = entry;
}

export function getLastRoundResult(): RoundResultEntry | null {
  return lastRoundResult;
}

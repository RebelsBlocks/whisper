import type { RoundSnapshot } from '../domain/roundSnapshot.js';
import type { RoundDerived } from '../domain/playerBehavior.js';

export type RoundRecord = {
  roundNumber: number;
  ts: number; // snapshot.createdAt
  receivedAt: number; // when whisper ingested it
  snapshot: RoundSnapshot; // canonical data for LLM (original payload)
  /** Derived, lightweight, LLM-friendly summary (stored in ring buffer). */
  derived?: RoundDerived;
};

export type RoundResultEntry = {
  roundNumber: number;
  comment: string;
  createdAt: number;
};

export type LoreBatch = {
  id: string;
  createdAt: number;
  rounds: RoundRecord[]; // typically 10
};


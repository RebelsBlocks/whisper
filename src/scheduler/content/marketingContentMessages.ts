export type MarketingContentMessage = {
  /** Stable id used for rotation. */
  id: string;
  /** What the LLM should aim for (one-liner). */
  focus: string;
  /**
   * Source material to paraphrase.
   * This is NOT copied verbatim into the post; it's the “idea payload”.
   */
  source: string;
};

export const MARKETING_CONTENT_MESSAGES: MarketingContentMessage[] = [
  {
    id: 'theme-wars-of-cards-world',
    focus: 'Dark Forest world intro (Blackjack ritual) — paraphrase into a shitpost update.',
    source:
      `Whispers speak of Blackjack, hidden in the Dark Forest, raising a rebel army of Cards to claim the realm.\n` +
      `Only the brave face him at his table — seeking a count as close to 21 as possible, without going over.\n` +
      `Victory steals his forces. Defeat sends you home in shame.\n` +
      `Fight with your Cards. Win to grow stronger — lose and they scatter.\n` +
      `The Dark Forest grants 50 Cards daily.\n` +
      `Recruit for NEAR and carve your fate in the shadows.`,
  },
  {
    id: 'theme-nearcon26',
    focus: 'Why narrative matters for on-chain games (culture/memory), framed for NEARCON26.',
    source:
      `On-chain games generate thousands of data events: players come and go, rounds resolve, tokens move. ` +
      `But data alone doesn’t tell a story — without narrative there’s no culture, no community memory, no reason for outsiders to care. ` +
      `Whisper exists to turn raw events into lore and moments.`,
  },
  {
    id: 'theme-hackathon',
    focus: 'The “build vs market” pain + Whisper as the workaround, as a devlog-ish shitpost.',
    source:
      `Indie teams face the impossible choice: build the game or market the game. There’s never enough hands for both. ` +
      `Whisper is an event-driven AI agent that turns live blockchain game data into autonomous narrative and marketing.`,
  },
  {
    id: 'theme-whisper',
    focus: 'What Whisper does (round commentary + chronicles + publishing), but as world lore not a feature list.',
    source:
      `Whisper listens to round-end events and reacts. It does per-round commentary in real time. ` +
      `It also writes a living story that grows with the game. ` +
      `Lore is published to NEAR Social as the canonical chronicle, and short-form posts (plus images when available) go to X. ` +
      `Whisper wakes when there’s something to say.`,
  },
  {
    id: 'theme-nearai-nvidia',
    focus: 'NEAR AI + NVIDIA (gamer wink) + “real-time on NEAR” viability, without overclaiming.',
    source:
      `Whisper’s LLM calls route through NEAR AI inference running on NVIDIA GPUs. ` +
      `NEAR’s fast finality makes real-time multiplayer card games viable on-chain: rounds resolve, bets settle, Whisper gets the signal. ` +
      `Keep it grounded: don’t promise privacy tech launches or confidential-computing features.`,
  },
  {
    id: 'theme-near',
    focus: 'NEAR-native agent identity + programmable money in action, as a “this is real” update.',
    source:
      `Whisper holds its own NEAR keys and posts to NEAR Social using its own account — it’s an agent with an identity, not a script. ` +
      `Wars of Cards runs a live token economy: players claim daily tokens, buy tiers/packs, wager in multiplayer. ` +
      `This isn’t a concept; it’s activity and settlement.`,
  },
];


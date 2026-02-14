/**
 * Compressed “docs digest” for LLM prompts (address-free in outputs).
 * Source: warsofcards.github.io/*.html
 */
export const WARS_OF_CARDS_DOCS_DIGEST = `
Wars of Cards
- Multiplayer card-gaming platform on NEAR: instant multiplayer interactions; financial settlement on-chain (bets/payouts/token transfers).
- Free to play: needs an active NEAR wallet + stable internet.

Getting started (player flow)
- Login via NEAR wallet; Wars of Cards never asks for seed phrase/private keys.
- Blackjack lobby exists; recommended browsers: Chrome/Firefox.
- Storage deposits (example docs values): 0.0123 NEAR (blackjack contract storage) + 0.0013 NEAR (token contract storage).

CARDS economy (high level)
- Claim daily CARDS (docs example: 50 every 24h; amount modifiable by contract owner).
- Minimum bet: 10 CARDS.
- Token packs exist (pricing/sizes modifiable by contract owner).
- Token mechanics: whitelisted permissions; approved game contracts can mint rewards and burn bets.
- Unlimited supply model: circulating supply = total_minted − total_burned.
- Treasury revenue sources (docs): pack purchases + transfer fees on non-whitelisted transfers.

Blackjack gameplay (what makes it “real-time”)
- Seat-based single table up to 3 players; contract handles bookkeeping and token ops; off-chain server handles actual game logic.
- Dealer rules: hits 16-, stands 17+; 6-deck shoe.
- Actions: Hit/Stand are instant off-chain; Split/Double are on-chain (docs: token burn / supply reduction).
- Bet sizes (docs example): 10/30/50/100 CARDS.
- Payouts: Blackjack 3:2; Win 1:1; Push returns bet; Bust loses bet.

Roadmap
- Current: 3-player blackjack + CARDS token contract.
- In development: 7-player Texas Hold’em poker (Q1/Q2 2026).
`.trim();


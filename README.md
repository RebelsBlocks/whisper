# Whisper

Event-driven backend that turns blackjack round data into AI-generated narrative (“lore”) and round summaries. Receives round-end events from a blackjack backend, runs them through LLMs, and optionally publishes to **NEAR Social** and **X (Twitter)**. **TikTok** is prepared (OAuth, config) but not wired into the lore pipeline.

---

## On-demand only

- **Round events** — `POST /events/round-ended` with a round snapshot. Validates, deduplicates, processes in background.
- **Per-round comments** — LLM (NEAR AI) generates a short “weather + heartening” line; sends it back to blackjack backend via webhook.
- **Lore batching** — Every N rounds → batch. Worker: LLM writes lore story → optional X notification + xAI image → publish to NEAR Social and/or X.
- **Daily marketing (X)** — Optional daily text-only post to X at a configured time (NEAR AI). During the marketing window, lore does not post to X (no back-to-back tweets).


---

## Flow

```
Blackjack backend  →  POST /events/round-ended (Bearer WHISPER_TOKEN)  →  Whisper
       →  round digest  →  per-round comment (webhook to backend)
       →  batcher (every N rounds)  →  lore worker  →  LLM  →  NEAR Social / X (± image)
```

Auth: `WHISPER_TOKEN`. NEAR: `near-api-js` + Social contract. X: OAuth 1.0a + optional xAI for images.

---

## Project layout

| Area | Purpose |
|------|--------|
| `src/app/` | Routes, auth, round handler |
| `src/domain/` | Snapshot/digest, player behavior |
| `src/lore/` | Batcher, worker, NEAR AI client, publishers |
| `src/infra/` | NEAR Social, X (OAuth/post/media), xAI |
| `src/config/` | Env-based config |
| `src/scheduler/` | Daily marketing + window policy |

---

## Setup

1. `npm install && npm run build`
2. Create`.env`. Set `WHISPER_TOKEN`, `BLACKJACK_BACKEND_URL`. For NEAR: account, private key, optional `NEAR_AI_KEY`. For X: consumer key/secret + OAuth flow (`/auth/x/start` → callback) for access token/secret. For images: `X_API_KEY`. Production: `WHISPER_LOG_FULL=0`.
3. `npm run dev` or `npm start`. Docker: see `Dockerfile` (port 8787).

---

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | — | Liveness |
| GET | `/lore/status` | — | Batcher + worker status |
| GET | `/lore/round-result/latest` | — | Last round result (debug) |
| POST | `/events/round-ended` | Bearer | Ingest round snapshot |
| POST | `/lore/worker/run-once` | Bearer | Run one lore batch manually |
| GET | `/scheduler/marketing/status` | — | Marketing status |
| POST | `/scheduler/marketing/post-now` | Bearer | Post marketing now  |
| GET | `/auth/x/start` | Bearer | Start X OAuth |
| GET | `/auth/x/callback` | Bearer | X OAuth callback |
| GET | `/auth/tiktok/start` | Bearer (operator) | TikTok OAuth  |

---

Open source. Use, modify, distribute per repo license. Contributions welcome.

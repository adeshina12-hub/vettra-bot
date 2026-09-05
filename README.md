# Web3 Signals Agent — Signals module

Personal AI agent that watches on-chain, social, and news sources, correlates
what it finds, and alerts you (Telegram + dashboard) when something looks
like a real opportunity.

This is the **Signals module** only, built to run standalone for your own
use first. The BD outreach module is intentionally separate — same
architectural pattern (collectors → agent core → storage → outputs), but
its own codebase, since it touches different data (contacts, message
history) with a different privacy bar.

## Architecture

```
collectors/          → onchain.ts, social.ts, news.ts
                        each normalizes source data into RawSignal[]
agent/scorer.ts       → sends new signals to Claude, gets back scored,
                        correlated Opportunity[] with reasoning
storage/db.ts         → Supabase (Postgres) — signals + opportunities,
                        dedup on signal id so you don't re-score old data
bot/alertBot.ts       → handles on-demand Telegram research commands
dashboard/server.ts   → localhost dashboard + JSON API of recent opportunities
index.ts              → orchestrator, runs the pipeline every 15 min (cron)
```

## Setup

1. `npm install`
2. Create a free project at [supabase.com](https://supabase.com), then in
   the SQL Editor run `supabase/schema.sql` once to create the tables.
3. Copy `.env.example` to `.env` and fill in:
   - `ANTHROPIC_API_KEY` — required, this is what scores/reasons about signals
  - `COINGECKO_API_KEY` — recommended for production; create a free CoinGecko Demo API key and add it to the Render service environment
  - `CHAIN_GPT_API_KEY` — optional ChainGPT Web3 LLM key; its model defaults to `general_assistant`
  - `CHAIN_GPT_ENABLED` — enable ChainGPT calls (default `true`)
  - `CHAIN_GPT_RESEARCH_MODEL` — ChainGPT research model (default `general_assistant`)
  - `CHAIN_GPT_AUDIT_MODEL` — ChainGPT audit model (default `smart_contract_auditor`)
  - `GEMINI_MODEL` — Gemini model name (default `gemini-3.6-flash`)
  - `BOT_DAILY_REPORT_LIMIT` — Telegram research reports per user per UTC day (default `5`)
  - `BOT_DAILY_EARLY_SCAN_LIMIT` — Early Projects scans per user per UTC day (default `2`)
  - `BOT_REPORT_CACHE_MINUTES` — completed report cache duration (default `60`)
  - `MONI_DAILY_REQUEST_CAP` — global Moni API calls allowed per UTC day (default `20`)
  - `LLM_DAILY_SPEND_CAP_USD` — application-side estimated LLM reservation cap (default `5`)
  - `LLM_ESTIMATED_CALL_COST_USD` — estimated reservation per provider call (default `0.05`)
  - `BOT_ANALYTICS_ADMIN_CHAT_ID` — Telegram chat ID allowed to run `/analytics`
   - `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` — from your Supabase project's
     Settings → API (use the **service_role** key, not anon/public)
   - `LUNARCRUSH_API_KEY` — free tier, for the social collector
   - `TELEGRAM_ALERT_BOT_TOKEN` / `TELEGRAM_ALERT_CHAT_ID` — create a bot via
     [@BotFather](https://t.me/BotFather), message it once, then use
     `https://api.telegram.org/bot<TOKEN>/getUpdates` to find your chat id
   - On-chain (DexScreener/DeFiLlama) and news (RSS) collectors work with
     zero extra keys
4. Edit `WATCH_TERMS` in `src/index.ts` to the assets/narratives you care about
5. `npm run run:once` — runs the pipeline a single time, good for testing
6. `npm run dev` — runs continuously without Telegram alerts, dashboard at `http://localhost:4000`
7. `npm run bot` — starts the command-only Telegram bot

## Unified Telegram bot

The command-only bot exposes the two project workflows through the configured
Telegram bot:

```text
/research <project name or ticker>
/early [1-10]
/help
```

`/research` calls the TypeScript research pipeline and returns its score,
verdict, strengths, and red flags. `/early` runs the native TypeScript early-
project discovery, enrichment, and LLM scoring path, then returns the highest
scoring candidates with the same chain/category/stage/score/why structure as
the discovery project. It uses Moni, GitHub, and DeFiLlama directly from the
research service. It does not send proactive alerts; responses happen only
after a user command.

The bot records unique users, report events, and most-searched projects in
Supabase. Run `/analytics` from the configured admin chat to view the totals.
Apply the latest `supabase/schema.sql` before enabling these controls. The LLM
reservation cap is an application guard; configure a real spending limit or
usage alert in each provider dashboard for the billing-level cap.

## What's real vs. stubbed right now

- **On-chain**: fully working — DexScreener (price/liquidity/volume moves)
  and DeFiLlama (TVL spikes), both free/keyless.
- **News**: fully working — RSS feeds filtered by catalyst keywords
  (funding, hacks, launches, partnerships, etc).
- **Social**: fully working — backed by [LunarCrush](https://lunarcrush.com/developers)
  (free tier, no OAuth) as the primary source. Two signal types:
  - **Topic volume spikes** — compares each watch term's 24h post count
    against its own rolling baseline (needs a few pipeline runs of history
    before it trusts a baseline enough to flag anything).
  - **Standout posts** — top-engagement posts per term with sentiment and
    author follower count.
  Optionally, set `SORSA_API_KEY` too (100 free requests) and standout posts
  get enriched with the author's **Sorsa Score** — a crypto-specific
  influence rating. This is spent only on posts that already cleared the
  engagement bar, not on every term every cycle, so the free quota lasts.
  Add `LUNARCRUSH_API_KEY` in `.env` to activate the collector at all.
- **AI scoring**: fully working — every new signal batch goes to Claude,
  which groups related signals, scores 0-100, and writes a reasoning that
  includes the biggest reason the call could be wrong.

## Next steps toward productizing

When you're ready to open this to your audience:
1. Add auth + per-user config (watch terms, alert thresholds) to the
   dashboard/API — the storage layer isn't multi-tenant yet by design,
   so this is the first real change needed.
2. Move the SQLite file to Postgres once you have concurrent users.
3. Rate-limit/queue the scoring step — right now it fires one Claude call
   per pipeline run; at scale you'll want per-user batching.

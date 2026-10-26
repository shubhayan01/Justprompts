# JustPrompt — GEO / AEO Prompt Tracker

See how often your brand shows up in **AI answers** (ChatGPT, Claude, Gemini, Perplexity, Llama, DeepSeek) for the questions your customers actually ask — benchmark against competitors, and get a prioritised plan to show up more.

Built to be **accurate and free**: it ships working on free API tiers and lights up paid engines when you add credit.

## The loop

```
Add URLs → mine keywords → suggest buyer prompts → track across LLMs → score & recommend → act ↺
```

1. **Crawl & ingest** — paste your site + competitor URLs (or let it crawl homepages / your sitemap). Pulls titles, headings and body text.
2. **Keyword mining** — free heuristic extraction, optionally refined + clustered by an LLM into themes with search intent.
3. **Prompt engine** — turns keywords into realistic buyer prompts (the questions people ask AI), ranked by commercial intent. Your brand name is deliberately left out so we see if engines surface you *unprompted*.
4. **Multi-LLM tracker** — runs every prompt across your live engines; detects brand & competitor **mentions, citations, rank and sentiment** (deterministic text/citation matching + an LLM judge, merged).
5. **Score & recommend** — share of voice vs competitors, mention/citation rate, average position, per-engine breakdown, the exact prompts where you're losing, a trend line over time, and a prioritised GEO action list.

## Setup

### 1. Get at least one free API key

Put keys in a `.env` file (copy `.env.example`). You only need **one** to start; more unlocks more engines.

| Key | Free? | What it gives you | Get it |
|-----|-------|-------------------|--------|
| `OPENROUTER_API_KEY` | ✅ free + cheap paid | One key → **all** models (GPT, Claude, Gemini, Llama, DeepSeek, Perplexity). Free `:free` models + cheap paid. | https://openrouter.ai/keys |
| `GEMINI_API_KEY` | ✅ free | The only **free source of LIVE web-grounded answers + real citations**. Best for accurate GEO. | https://aistudio.google.com/apikey |
| `GROQ_API_KEY` | ✅ free | Fastest free inference. Powers the analysis work (keyword/prompt/sentiment) + free answer engines. | https://console.groq.com/keys |
| `OPENAI_API_KEY` | 💲 paid | Real ChatGPT (GPT-4o). | https://platform.openai.com/api-keys |
| `ANTHROPIC_API_KEY` | 💲 paid | Real Claude. | https://console.anthropic.com/settings/keys |
| `PERPLEXITY_API_KEY` | 💲 paid | Perplexity (live web). | https://www.perplexity.ai/settings/api |

> **Recommended free combo:** `GEMINI_API_KEY` (live web + citations) + `GROQ_API_KEY` (fast analysis). Add `OPENROUTER_API_KEY` to cover ChatGPT/Claude/DeepSeek-class models too.

```bash
cp .env.example .env    # then paste your key(s)
```

### 2. Run

```bash
npm install
npm start
```

Open **http://localhost:4505**. The UI shows which engines are live (green) and which need a key.

## Deploy on Render

This repo includes a `render.yaml` blueprint. Two ways to ship it:

**A. Blueprint (recommended)**
1. Push this project to a GitHub/GitLab repo (`.env` is gitignored — keys never leave your machine).
2. In Render: **New + → Blueprint**, pick the repo. Render reads `render.yaml` and creates the web service.
3. Open the service's **Environment** tab and set the secret values: at least `GROQ_API_KEY` (or `GEMINI_API_KEY` / `OPENROUTER_API_KEY`), and **`APP_PASSWORD`** (see below).

**B. Manual web service**
- New + → **Web Service** → connect repo. Build `npm install`, Start `npm start`, Health check path `/healthz`.
- Add the same environment variables.

### Must-know for Render
- **Password-protect it.** A public URL spends *your* API quota/credits for anyone who finds it. Set `APP_PASSWORD` and the whole app sits behind an HTTP Basic login (the browser remembers it, so streaming/SSE keeps working). Leave it unset only for a private/internal deploy.
- **Free tier = ephemeral disk + sleep.** Saved projects live in `data/db.json` on local disk, which **resets on every deploy and cold start**, and the free service sleeps after ~15 min idle (first request then takes ~30s to wake). The tool still works fully — you just re-scan. For durable history, use a **paid plan + a Render Disk**: uncomment the `disk:` block and the `DATA_DIR=/data` env var in `render.yaml`.
- `PORT` is provided by Render automatically — the server already reads it.
- Tune `TRACK_CONCURRENCY` (default 4) in the dashboard if you hit rate limits or want faster ranking.

## Accuracy & cost notes

- **Live vs. knowledge:** engines marked **live web** (Gemini grounding, Perplexity) reflect the *real-time web* with real citations — the most faithful GEO signal. Other engines answer from model knowledge, which is still a valid signal ("is my brand baked into the model?").
- **Mention detection** is deterministic first (exact name + domain match in text *and* in citations), then an LLM judge adds rank / recommended / sentiment. The two are merged so nothing is missed.
- **Free tiers have rate limits.** If a run errors with `429`, wait a minute or track fewer prompts/engines at once. Errors are shown per-run, never hidden.
- **Model IDs drift.** Every engine's model is overridable in `.env` (e.g. `GROQ_LLAMA_MODEL=...`, `OR_GPT_MODEL=...`). If an engine errors with "model not found", point it at a current model from that provider.
- All data is stored locally in `data/db.json` — portable and inspectable. Nothing leaves your machine except the API calls you trigger.

## Project layout

```
server.js         Express API + SSE tracking stream + static hosting
src/config.js     Engine registry: logical engines → provider/model bindings, free/live flags
src/providers.js  Unified LLM layer (OpenAI-compatible, Gemini grounding, Anthropic)
src/crawl.js      Server-side crawler + heuristic keyword extraction
src/keywords.js   LLM keyword refinement/clustering
src/prompts.js    Buyer-prompt generation
src/track.js      Multi-engine runner + mention/citation/sentiment detection
src/score.js      Share of voice, metrics, gaps, recommendations
src/store.js      JSON datastore (no native deps)
public/           Cork-board UI (index.html, styles.css, app.js)
```

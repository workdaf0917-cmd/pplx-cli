# pplx-cli

A small CLI that calls the Perplexity API and saves the Markdown answer into your Obsidian "Perplexity知識庫" vault, with monthly budget tracking and automatic `wiki/sources/` summary + `wiki/log.md` updates. Designed to plug into [OpenCLI](https://github.com/jackwener/opencli).

## Features

- **Default model**: `sonar-pro` (override with `--model` or `PPLX_MODEL`).
- **Output**: Markdown with YAML frontmatter, Obsidian-friendly.
- **Auto destinations**:
  - Raw answer → `<PPLX_RAW_DIR>/YYYYMMDD-HHMMSS-<slug>.md`
  - Wiki summary → `<PPLX_WIKI_DIR>/sources/YYYYMMDD-HHMMSS-<slug>.md`
  - Activity log → `<PPLX_WIKI_DIR>/log.md` (appended)
- **Monthly USD budget** (default `$5`): pre-check before each call, blocks if over.
- **Usage ledger**: `~/.pplx/usage.json`, aggregated per month.

## Setup

```bash
cd pplx-cli
cp .env.example .env        # then edit and fill in PPLX_API_KEY and paths
npm install
npm link                    # exposes the `pplx` binary on $PATH
pplx --help
pplx config                 # confirms env is loaded
```

Get a Perplexity API key: https://www.perplexity.ai/settings/api

## Usage

```bash
pplx "What changed in PostgreSQL 17?"
pplx -t "PG17 changes" "What changed in PostgreSQL 17?"
pplx --model sonar-reasoning-pro "Compare Kafka and NATS for IoT ingest"
pplx --print --no-save "quick one-off question"
pplx usage                  # show this month's spend
pplx config                 # show resolved env
```

## Register with OpenCLI

```bash
npm i -g @jackwener/opencli                  # if not already installed
opencli external register pplx \
  --binary "$(which pplx)" \
  --install "cd $(pwd) && npm install && npm link" \
  --desc "Perplexity → Obsidian KB CLI"
opencli pplx --help
```

`external register` makes `opencli pplx <args>` pass through to the local binary (stdio + exit code preserved).

## Pricing config

Defaults match Perplexity's `sonar-pro` rate card at the time of writing:

- `$3 / 1M input tokens`
- `$15 / 1M output tokens`
- `$5 / 1K requests`

If Perplexity changes prices, update `PPLX_PRICE_INPUT_PER_M`, `PPLX_PRICE_OUTPUT_PER_M`, `PPLX_PRICE_REQUEST_PER_K` in `.env`.

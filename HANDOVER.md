# Era Fusion — Handover (for a fresh agentic coding session)

You're taking over **Era Fusion**: a self-hosted, multi-model "fusion" engine that dispatches a prompt to a
panel of frontier models, has a judge **synthesize** one best answer, and **learns each model's per-subject
strengths over time**. Surfaces: OpenAI-compatible server + web dashboard, a `fuse` CLI, and a `/fuse`
agentic skill. Published as the public npm package **`@alexanderollman/llm-fusion`**.

Read [`WORKBOOK.md`](WORKBOOK.md) for the full story and the research rationale. Read [`docs/fusion-flow.html`](docs/fusion-flow.html)
for the visual pipeline. This doc is the operational get-started + what to do next.

---

## Current state (working)

- Engine, server, CLI, web, skill all build and run. Latest commit on `main`.
- **Cross-provider fusion validated** (Opus 4.8 + GPT-5.5 + Gemini 3.5 Flash, judged by Opus).
- **Benchmark harness** works against GPQA-Diamond (objective grading).
- **Optimization techniques shipped** (MoA refine, debate, pairwise rank, confidence, self-consistency, verify),
  composable via `TechniqueConfig`; `standard` tier = base flow, `deep` = all on.
- **Latest benchmark (GPQA-D 11–18):** `fusion-deep` 87.5% > base `fusion` 75% > best single 62.5%. Techniques help on hard items; mechanism confirmed (MoA refine corrected a wrong panelist on item 11).

---

## Repo map

```
packages/
  core/src/
    fusion.ts       # orchestrator: adjudicate → select panel → dispatch → (refine→rank) → judge → (SC→verify) → learn
    adjudicate.ts   # cheap subject + depth (light/standard/deep) classification
    judge.ts        # two-phase judge: analysis (influence + priors + pairwise) then streamed synthesis
    techniques.ts   # MoA refinePanel, pairwiseRank, selectConsistent (self-consistency), verifyAndRevise, parseConfidence
    store.ts        # node:sqlite: runs, contributions (influence→SME), feedback, usage; selectPanel (ε-greedy)
    config.ts       # model registry, providerAuth (api|subscription), TECHNIQUES_OFF/DEEP, resolveTechniques
    providers/      # anthropic.ts, openai.ts, google.ts (depth→tools), cli.ts (subscription CLIs), index.ts
    env.ts          # ~/.era-fusion/.env loader + setProviderKey
  server/src/       # app.ts (routes), server.ts, bin.ts (Hono)
  cli/src/index.ts  # fuse CLI (commander + clack setup wizard); fuse-run.ts launcher
  web/src/          # React dashboard: ChatView, StrengthsView, UsageView, SetupView, api.ts
skills/fuse/        # SKILL.md + scripts/fuse-run.sh (service-first, CLI fallback) + commands/fuse.md
scripts/
  bench/run.mjs     # benchmark harness (systems incl. fusion / fusion-deep), --offset/--limit/--panel/--out/--dry-run
  bench/gpqa_to_jsonl.py   # GPQA CSV → MCQ JSONL
  build-package.sh + gen-release-pkg.mjs  # → ./release (the publishable bundle)
  install.sh        # dev install: build, PATH launchers, install skill
docs/               # ENGINEER_ONBOARDING.md, PUBLISHING.md, fusion-flow.html
```

State lives in **`~/.era-fusion/`**: `config.json` (registry, `providerAuth`, panel), `.env` (keys), `fusion.db` (learning store).

---

## How to run

```bash
npm install && npm run build          # build all workspaces
fuse doctor                           # check providers/keys/CLIs  (--probe to live-check models)
fuse "your question"                  # run a fusion (streams)
fuse serve                            # http://localhost:8787  (Chat · Strengths · Usage · Setup)
npm run pack:release                  # rebuild ./release  (REQUIRED for the global `fuse` to pick up engine changes)
```

Benchmark:
```bash
npm run build:core
node scripts/bench/run.mjs scripts/bench/data/gpqa_diamond.jsonl \
  --systems fusion,fusion-deep,claude-opus-4-8,gpt-5.5,gemini-3.5-flash \
  --panel claude-opus-4-8,gpt-5.5,gemini-3.5-flash --offset 10 --limit 8 --out scripts/bench/data/out.json
node scripts/bench/run.mjs <data.jsonl> --dry-run   # validate, no API calls
```

---

## Environment gotchas (this machine)

- **Node ≥ 22 required** (uses built-in `node:sqlite`; loaded via `createRequire` so bundlers keep the prefix).
- **Auth modes** (`~/.era-fusion/config.json` → `providerAuth`): `anthropic` + `openai` = **subscription** (via `claude` / `codex` CLIs), `google` = **api** (key in `.env`). Subscription = **unmetered $**, tokens **estimated**.
- **Valid model strings:** `gemini-3.5-flash` and `gemini-2.5-pro` work; `gemini-3-*` and `gemini-3.5-pro` **404**. Always `fuse doctor --probe` after changing model IDs.
- **The global `fuse` is symlinked to `~/era-fusion/release`** — after any engine change run `npm run pack:release` or the installed CLI won't see it. (The benchmark uses `packages/core/dist` directly, so `npm run build:core` is enough for benchmarking.)
- **Benchmark data is gated + gitignored:** GPQA lives in `scripts/bench/data/` (needs a Hugging Face token; the dataset is license-gated — accept terms on the dataset page). `release/` and `bench-*.json` are also gitignored.
- **`noLearn: true`** is set for benchmark fusion runs so they don't pollute the SME store.
- **Commit cadence:** the owner expects work committed and pushed to `main` when done (end commit messages with the Co-Authored-By trailer; this session has been pushing directly to `main`).

---

## Open issues / bugs found

1. **Subscription-CLI transient failures score as wrong** — e.g. `claude -p` errored on a benchmark item. The engine keeps a failed panelist as 0-influence (fine), but the *harness baseline* counts it as incorrect, understating that model. Add a retry on subscription-CLI error (harness, and consider engine panel).
2. **Verifier is blind to knowledge gaps** — `verifyAndRevise` runs at `light` depth (no tools), so on all-panel-wrong items (GPQA item 18) it can't catch the error. It needs web/code access on the `deep` tier.
3. **Confident-wrong consensus** — the judge trusted a wrong Opus at influence 0.97 (item 18). The online SME loop would learn this, but it's off during benchmarks; consider confidence calibration.
4. **Usage `$` is unmetered for everything on this setup** — only Gemini is API-billed and it has **no cost metadata** in the registry, so dollar figures read as 0/unmetered. Add `costPer1MIn/Out` for `gemini-3.5-flash` (and `gpt-5.5`) if a real $ number is wanted.

---

## Recommended next steps (prioritized)

1. **Tool-enabled verifier (deep tier).** Let `verifyAndRevise` use web search / code execution (not `light`). Highest-value fix for the all-wrong failure mode. → `techniques.ts`, pass a depth/tools flag.
2. **Retry subscription-CLI errors.** In `scripts/bench/run.mjs` (baselines) and optionally `providers/cli.ts` — one retry on a non-zero exit / empty output. Removes benchmark noise from transient CLI flakiness.
3. **Ablate the techniques.** `fusion-deep` is ~1.9× latency; the visible lift was mostly **MoA refine**. Run refine-only vs pairwise-only vs SC-only vs all-on on items 11–20 to keep only what pays for itself, then set the `deep` preset accordingly. (Add per-technique systems or flags to the harness.)
4. **Fairer, larger GPQA run for a citable number.** Drive baselines at comparable reasoning depth (see #5), then run a bigger slice (e.g. 50–198) to produce a GPQA-D accuracy directly comparable to Sakana Fugu's 95.5.
5. **Investigate `claude -p` reasoning depth.** The Opus subscription path looks under-driven as both baseline and panelist. If it can engage deeper reasoning (effort/think flags), panelist quality — and thus fusion — improves.
6. **Multi-scope decomposition (phase 2).** Adjudicator splits a request into sub-scopes, each its own cross-model panel, then a meta-aggregator. Data model already structured for it.
7. **Derive personas from SME.** Once a model is consistently dominant in a subject, promote it into a named role — the "personas later" plan from the vision.
8. **era-code provisioning + governance.** Wire the `provisionFusion()` step into `~/era-code` (recipe in `docs/PUBLISHING.md`); bootstrap `.era/memory` governance for this repo per house rules.

---

## Quick reference

- Engine flow & techniques: `docs/fusion-flow.html`
- Setup + provider keys: `docs/ENGINEER_ONBOARDING.md`
- Publishing + era-code integration: `docs/PUBLISHING.md`
- Benchmark usage: `scripts/bench/README.md`
- Full project narrative + research: `WORKBOOK.md`
- **Security:** a Hugging Face token was shared in chat to fetch GPQA — it should be rotated; never commit keys (`.env`, `.era-fusion/`, `release/`, `scripts/bench/data/` are gitignored).

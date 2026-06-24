# Era Fusion — Workbook

A running narrative of how this project was conceived, built, tested, researched, and improved.
Newest results at the bottom. Companion docs: [`HANDOVER.md`](HANDOVER.md) (start here if you're
taking over), [`docs/fusion-flow.html`](docs/fusion-flow.html) (visual pipeline),
[`docs/ENGINEER_ONBOARDING.md`](docs/ENGINEER_ONBOARDING.md), [`docs/PUBLISHING.md`](docs/PUBLISHING.md).

---

## 1. The vision

The seed was OpenRouter's ["Fusion beats Frontier"](https://openrouter.ai/blog/announcements/fusion-beats-frontier/):
dispatch a prompt to a **panel of models in parallel**, then a **judge** synthesizes one answer that
beats any single model. The ask here was to recreate that as a product across three surfaces —
a **graphical chat UI**, a **CLI**, and a **command/skill usable inside agentic coding tools**
(Claude Code / OpenCode) — plus one thing OpenRouter (and, we'd later learn, Sakana Fugu) does **not** do:
**learn each model's strengths over time and weight the panel/judge accordingly.**

Decisions locked early (with the user):

- **Direct provider SDKs**, not an aggregator — Anthropic / OpenAI / Google, behind a provider abstraction. Later extended with a **subscription-CLI** backend (`claude` / `codex` / `gemini`) so it works on Pro/Max plans with no API keys.
- **Hybrid learning:** the judge assigns each panelist an **influence** score per run; those accumulate into per-model, **per-subject expertise (SME)**; optional 👍/👎 refines it. SME feeds both panel selection and the judge's prior. This is the "learn strengths over time" twist.
- **Dynamic depth:** a cheap adjudicator reads each request and picks `light` / `standard` / `deep`. Depth is scaled to the scope of work, not fixed.
- **Single scope now, multi-scope later:** one cross-model panel per request for v1; the data model is structured so a request can later decompose into sub-scopes.
- **Harvested diversity, personas deferred:** send the *same* prompt to every model (divergence emerges naturally); personas to be *derived later* from the learned SME, not manufactured up front.
- **Three integration surfaces:** an OpenAI-compatible `/v1/chat/completions` endpoint, a `fuse` CLI, and a `/fuse` skill (service-first, with a CLI-orchestration fallback).

A second reference appeared mid-project — [`fusion-fable`](https://github.com/duolahypercho/fusion-fable),
a pure Claude Code skill that fans the same prompt across local CLIs and synthesizes with the host model.
It reinforced two choices: **harvested (not manufactured) diversity**, and a **service-first / CLI-fallback** skill.

---

## 2. What we first built

A TypeScript **npm-workspaces monorepo** (`46949c5`):

- **`@era-fusion/core`** — the engine. Flow: **adjudicate** (subject + depth) → **select panel**
  (per-subject SME, ε-greedy exploration) → **dispatch** the same prompt in parallel → **two-phase judge**
  → **learn**. The judge is the key bit (see below). Adaptive store on the built-in **`node:sqlite`** (zero native deps).
- **`@era-fusion/server`** — Hono. OpenAI-compatible `/v1/chat/completions` (streaming + not), rich SSE
  `/api/fuse`, plus `/api/feedback`, `/api/strengths`, `/api/usage`, `/api/config` (GET/PUT), `/api/keys`. Serves the UI.
- **`@era-fusion/cli`** — `fuse` (run / `serve` / `stats` / `usage` / `feedback` / `doctor` / `setup` / `config` / `models`), pipe-friendly, plus a `fuse-run` launcher for the skill.
- **`@era-fusion/web`** — React/Vite dashboard: **Chat · Strengths · Usage · Setup**.
- **`skills/fuse`** — the `/fuse` skill + installer for Claude Code & OpenCode.

**The judge is not a vote.** It runs two phases:
**(A) comparative analysis** — consensus, contradictions, gaps, unique insights, and a per-model
**influence** score (informed by the learned SME prior); **(B) generative synthesis** — a *new* answer
built from the strongest correct material, resolving contradictions and filling gaps. Selection is the floor; we synthesize.

Distribution decisions: published as a single bundled **public npm package `@alexanderollman/llm-fusion`**
(`fd13256`, `d64f574`, `39243cb`) that era-code **lazily provisions**; an interactive `fuse setup` wizard with
**per-provider auth** (API key *or* subscription login) (`e79b795`, `3427efc`); usage dashboard + model-setup UI (`d64f574`).

### Fixes that mattered (a forwarded diagnosis)
A real failure was caught and fixed (`0be5365`, `2215575`): in **subscription mode the answer was produced and
persisted but never printed** (CLIs return the whole answer with no token stream; the CLI only printed streamed
tokens) — fixed at the source (emit one `onToken`) plus a CLI backstop. Same pass: refreshed dead **Gemini IDs**
(`gemini-3-*` 404 → `gemini-3.5-flash` + `gemini-2.5-pro`, probed live, `9498eb5`); closed child **stdin** (killed
`claude`'s 3-s warning); **serialized same-CLI calls** (concurrency contention); switched **codex** to
`exec -o <file>` for clean output; and added **estimated token/unmetered-cost** accounting for subscription runs.

---

## 3. First GPQA-Diamond run (items 1–10)

Once cross-provider fusion (Opus 4.8 + GPT-5.5 + Gemini 3.5 Flash, judged by Opus) was validated with smokes,
we built a benchmark harness (`bb780fb`, `ca180a5`) + a GPQA-Diamond CSV→MCQ converter (`f2f6250`, deterministic
per-row shuffle) and ran the first 10 items (objective letter grading, no judge bias):

| System | Accuracy |
|---|---|
| **fusion** | **100%** |
| gpt-5.5 | 100% |
| gemini-3.5-flash | 90% |
| claude-opus-4-8 (the judge model, solo) | 70% |

**Key insight:** fusion got **right every item the judge model got wrong on its own** (items 1, 4, 6).
Proof the synthesis isn't rubber-stamping the judge — it defers to the better-supported panelists.
fusion vs **average** single: +13.3 pts; vs **judge-solo**: +30 pts.

**Caveats we recorded:** (1) we *couldn't* show fusion > **best** single — gpt-5.5 also ceilinged at 100% on
these tractable items; (2) the Opus baseline (70%) was **under-driven** — it ran via subscription `claude -p`
(one-shot, no agentic reasoning) while gpt-5.5 ran via agentic `codex`, so baselines weren't apples-to-apples;
(3) N=10 is a smoke. These pointed at needing harder items and fairer baselines.

---

## 4. Research — Sakana Fugu, and the fusion-optimization literature

**Sakana Fugu** (GA 2026-06-22) is the closest commercial cousin: multiple frontier models behind one
OpenAI-compatible API to beat a single model. But the mechanism differs — Fugu is a **trained ~7B coordinator**
(TRINITY evolved role-assigner + Conductor RL-trained communication topologies; recursive self-call), **hosted**,
with a policy **fixed post-training**. era-fusion's differentiators: **transparent + self-hosted**, **bring-your-own
keys + subscriptions**, and **online per-subject learning at inference** (Fugu doesn't adapt at inference). Fugu's
edges: a cheap single router (vs our always-fan-out N× cost) and **published benchmarks** (GPQA-D 95.5, HLE 47.2/50,
SWE-Bench Pro 59/73.7, LiveCodeBench 92.9/93.2) — the gap that motivated our own harness.

Then the question: *is "panel answers → judge synthesizes" really optimal?* We researched and mapped the literature
to our system, and built what the evidence supported:

| Paper / method | What it showed | What we took, and why |
|---|---|---|
| **Mixture-of-Agents** ([2406.04692](https://arxiv.org/abs/2406.04692)) | Layered proposers→aggregator; models answer **better when shown peers' answers**; the aggregator *synthesizes*, not selects (+8.2% over GPT-4o on AlpacaEval). | **`refineRounds`** — a MoA refinement round where panelists see anonymized peers and revise. The single biggest documented lift, and the thing our blind fan-out lacked. |
| **Rethinking MoA / Self-MoA** ([2502.00674](https://arxiv.org/abs/2502.00674)) | N× of the *single best* model can beat mixing diverse models. | Kept harvested diversity but added **self-consistency** (`selfConsistency`) and noted we should A/B diversity-vs-self-ensemble per subject (not yet done). |
| **LLM-Blender** ([ACL 2023](https://aclanthology.org/2023.acl-long.792/)) | PairRanker (pairwise comparison) + GenFuser; fusing top-K beats selecting one ("selection bottleneck"). | **`pairwiseRank`** — head-to-head comparisons → influence weights fed to the judge, more robust than one-pass scoring. |
| **Selection bottleneck** ([2603.20324](https://arxiv.org/pdf/2603.20324)) | Picking one agent's answer is a systematic bottleneck. | Reinforced "synthesize, don't select" (already our design) and the pairwise weighting. |
| **Multi-agent debate** | Models critiquing each other's answers converge on truth. | **`debate`** — the refine round explicitly resolves the contradictions the judge already detects (cheap, targeted). |
| **Self-Refine / Reflexion** | Verify-and-revise improves correctness. | **`verify`** — a post-synthesis verification pass + one revision. |
| confidence calibration | Confidence-weighted aggregation. | **`confidence`** — panelists self-report; the judge factors it into the prior. |

All six landed as **composable engine stages** (`packages/core/src/techniques.ts`, wired in `fusion.ts`, `99f52fb`),
gated by a `TechniqueConfig` that depth tiers resolve: `standard` = base flow; `deep` (= `TECHNIQUES_DEEP`) turns
everything on. We also produced a visual explainer (`docs/fusion-flow.html`, `9f9bb45`) clarifying synthesis-vs-selection.

---

## 5. Latest result — base vs all-techniques fusion (GPQA-Diamond 11–18)

We A/B'd `fusion` (base) vs `fusion-deep` (all techniques) vs the three baselines on **unseen, harder** items
11–18 (items 1–10 had ceilinged):

| System | Accuracy | Avg latency |
|---|---|---|
| **fusion-deep** (all techniques) | **87.5%** (7/8) | 187 s |
| **fusion** (base) | **75.0%** (6/8) | 100 s |
| claude-opus-4-8 | 62.5%¹ | 40 s |
| gpt-5.5 | 50.0% | 15 s |
| gemini-3.5-flash | 50.0% | 13 s |

¹ includes a transient `claude -p` CLI error on item 11 scored as wrong (understates Opus).

- **fusion-deep beat base fusion by +12.5 pts**, best single by +25, avg single by +33.
- **Mechanism observed (item 11):** base fusion was wrong (only gpt correct; gemini wrong, Opus errored).
  In `fusion-deep` the **MoA refinement round corrected Gemini** (after it saw peers) → 2/3 correct → right synthesis.
  The documented MoA lift, reproduced in our system.
- **Influence weighting calibrated well:** item 14 down-weighted the wrong model (gpt → 0.08) while correct ones sat ~0.9.
- **A real ceiling (item 18):** *every* system wrong; all three panelists were wrong and the judge trusted a
  **confidently-wrong Opus (influence 0.97)**. Fusion can't exceed the panel's collective knowledge when no one is
  right and the techniques don't *derive* the answer; the pure-LLM verifier couldn't catch it either.
- **Cost:** techniques ≈ **1.9× latency**, unmetered $ (subscription). N=8 → numbers directional; the item-11 mechanism is solid evidence.

**Improvements this surfaced (open):** (1) a **tool-enabled verifier** (web/code) for the all-wrong case; (2) **retry
subscription-CLI errors** so transient failures don't score as wrong; (3) **ablate** the techniques to keep only what
pays for itself (the visible lift was mostly MoA refine); (4) distrust **confident-wrong consensus** (the online SME
loop would, but it was off for the benchmark).

See [`HANDOVER.md`](HANDOVER.md) for the prioritized next steps and everything a fresh session needs.

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

## 5. Earlier result — base vs all-techniques fusion (GPQA-Diamond 11–18)

> **Superseded by §6.** The numbers below predate two fixes (model-pinning and judge-anonymization) and a larger run that overturned the headline. Kept as the historical record.


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

## 6. The course-correction (2026-06-24): a wrong model, a lucky slice, and the judge bottleneck

> **⚠️ §6.2–§6.3 are RETRACTED — read §6.6 + §7.** Those accuracy numbers came from a **broken MCQ grader** (first A–H
> letter, including letters inside the reasoning) that differentially understated *verbose* answers — fusion's synthesis
> far more than terse single-model answers. The clean-grader controlled run (§7) **reverses the conclusion**: good judges
> synthesize at **95–96%**, *above* the 94% majority-vote and best single, so synthesis adds value and fusion is
> competitive with frontier. The *mechanisms* in §6.1 (wrong model) and §6.4 (self-preference) still stand; the
> *accuracy verdicts* in §6.2–§6.3 do not.

This session set out to action §5's open list (tool-enabled verifier, CLI retry, ablation, larger run). Building those
forced us to look harder at the harness — and what we found rewrote the story. The short version: **§5's win was an
artifact of two bugs, and once they were fixed, the real bottleneck turned out to be the judge itself.**

### 6.1 The panelists were running the wrong model

The subscription CLI specs invoked `claude -p "<prompt>"` and `codex exec "<prompt>"` **without `--model`**. So a panelist
declared `claude-opus-4-8` actually answered on whatever the logged-in session's *default* model was — likely Sonnet.
The "Opus" baseline and the "Opus" panelist were both under-driven. We pinned every CLI to its registry model
(`claude --model claude-opus-4-8`, `codex exec -m gpt-5.5`); the Anthropic panelist now self-reports as Opus 4.8.

Re-running the **exact same GPQA-D 11–18 slice** after the fix:

| System | Before pinning | After pinning |
|---|---|---|
| `fusion` (base) | 75.0% | **87.5%** |
| `fusion-deep` (all techniques) | 87.5% | **87.5%** |
| best single (`gpt-5.5`) | 62.5% | **75.0%** |

Pinning lifted base fusion (75→87.5) and the best single (62.5→75) — and **erased fusion-deep's apparent edge**. The
"techniques add +12.5 pts" story in §5 was largely the deep tier compensating for under-driven base models. With models
at full strength, base ≈ deep, and deep just costs +40% latency for nothing on this slice. (First ablation signal: the
harness now supports per-technique systems — `fusion-refine|-debate|-pairwise|-confidence|-sc|-verify` + `--depth`.)

### 6.2 The n=8 win didn't survive a bigger sample

n=8 means one item = 12.5 pts. We ran a fresh, larger slice — **GPQA-D 19–34 (16 items, 0 errors)** — and the result
flipped:

| System | 19–34 | Combined 11–34 (24) |
|---|---|---|
| `gpt-5.5` (single) | **87.5%** | **83.3%**  ← best |
| `gemini-3.5-flash` (single) | 81.3% | 70.8% |
| **`fusion`** (Opus judge) | **75.0%** | **79.2%** |
| `claude-opus-4-8` (single) | 62.5% | 54.2% |
| **panel majority-vote (approx)** | **~93.8%** | — |

**On 24 GPQA-D items, fusion (79.2%) does not beat the best single (gpt-5.5 83.3%).** The §5 "+12.5 over best single" was
a lucky slice (gpt-5.5 happened to do badly on 11–18). The honest headline: *as configured, fusion did not beat
frontier on GPQA-D.*

### 6.3 The bottleneck is the judge, not the panel

The damning number is the last row. On 19–34 a **plain majority vote of the three panelists scores ~94%**, but the
influence-weighted **Opus-judge synthesis delivers 75%**. The panel almost always *contains* the right answer — the judge
is *throwing it away*. We dug into the captured per-item influence. In **all four** items where fusion lost but gpt-5.5
was right, the correct answer was sitting in the panel:

- **Judge self-preference** (items 30, 31): the Opus judge weighted the *wrong* `claude-opus-4-8` panelist at
  **0.85–0.92** while the *correct* gpt-5.5 + gemini got **0.08–0.12**. The judge could see each panelist's real model id
  in the transcript — and an Opus judge over-trusts the Opus answer.
- **Synthesis failure with correct inputs** (item 20): gpt-5.5 + gemini were both correct and weighted at **0.95**, yet
  the synthesized answer was still wrong. The synthesis step itself flipped a correct, high-confidence input.
- The judge here (`claude-opus-4-8`) was the **weakest single model** on this set (54%). Using your weakest model to
  adjudicate a stronger panel is self-defeating.

This is the real research finding of the project so far: **harvested diversity works (the panel is ~94% right
collectively); the value is being destroyed at the synthesis/judge layer.**

### 6.4 First fix — anonymize the judge

`refinePanel` already hides model identity from peers ("Solver A/B/C") to keep refinement honest. The judge did not — it
saw `id="claude-opus-4-8" (Claude Opus 4.8)` in the digest, plus model ids in the SME-prior and pairwise blocks. We
**anonymized all of it**: panelists are now "Panelist 1..N" everywhere the judge looks, contributions are keyed by
position and mapped back to modelId internally. Self-preference can't operate on identity it can't see.

**But the validation run refused to give a clean answer — and that itself is the finding.** Re-running 19–34 with the
anonymized judge:

| System | Opus judge (named) | Opus judge (anonymized) |
|---|---|---|
| `gpt-5.5` (single) | 87.5% | 93.8% |
| `gemini-3.5-flash` (single) | 81.3% | 75.0% |
| **`fusion`** | **75.0%** | **68.8%** |
| `claude-opus-4-8` (single) | 62.5% | 56.3% |

*Every* system moved ±6–12 pts between two runs of the **identical configuration** — because the subscription models are
non-deterministic and re-answer on each run. The singles aren't supposed to depend on the judge at all, yet they swung
too. **Run-to-run variance on 16 items dwarfs the effect we were trying to measure**, so a single-slice A/B can't isolate
anonymization. Two consequences:

1. **Evaluation methodology was naive.** Comparing one 8- or 16-item run against another conflates the change under test
   with sampling noise. Real evaluation needs many more items and/or repeated trials per item (majority over k samples),
   and ideally temperature-0 — which the subscription CLIs don't expose. Every headline in §5–§6 carries this caveat.
2. **Identity bias is not the whole story.** On gpqa-31 the anonymized judge *still* weighted a **wrong** panelist at
   **0.96** while the correct one got 0.04. With identity hidden, the judge defaulted to the most confident, elaborate
   answer — which was wrong. The deeper problem is **the judge cannot reliably tell which answer is correct on hard
   items**; anonymization removes one bias vector but not the core discrimination failure.

Anonymization stays (it's strictly correct and removes a real bias with no downside), but it is *not* a proven accuracy
win, and the judge-discrimination gap is now the headline open problem.

### 6.5 What this leaves on the table

The verifier work shipped and is mechanically validated, but on the one hardest item (gpqa-18, a numeric abundance
calculation) the tool-enabled verifier with a *Gemini* judge still PASSed the wrong answer — because Gemini's deep tier
gives web search but **no code execution**, and a calculation needs code, not search. The Anthropic api deep tier *does*
add code execution, but there's no `ANTHROPIC_API_KEY` on this machine to prove it. Open levers, in priority order:

0. **Fix evaluation first (§6.4).** Run-to-run variance is ±6–12 pts on 16 items. Until we average repeated trials over a
   larger set (e.g. 50+ items × k samples, plurality-graded), no single run can adjudicate the levers below. This is the
   prerequisite, not optional.
1. **Stronger / non-self judge** — re-run with `--judge gpt-5.5` (strongest, off-panel-identity) and compare under the
   §6.4 regime. Test of the bottleneck hypothesis, but only meaningful once variance is controlled.
2. **Plurality aggregator for objective tasks** — the ~94% majority-vote ceiling is a standing rebuke to pure synthesis;
   at minimum feed plurality to the judge as a strong prior it must justify overriding. (A product call: it bends the
   deliberate "synthesis over selection" choice.) Note even plurality has a floor — gpqa-33 had 2/3 panelists wrong.
3. **Judge discrimination, not just identity** — gpqa-31 showed the anonymized judge still trusting a confident-wrong
   answer at 0.96. Surface objective signals it can't fake (independent re-derivation via code, cross-checking) rather
   than asking it to introspect on correctness.
4. **Tool-matched verification** — test the verifier with an Anthropic api judge (code execution) on calc-bound items;
   the prompt now tells it to *recompute*, not re-reason.
5. **Confidence calibration** — down-weight confident-but-wrong panelists (the item-18 / item-20 / item-31 failure mode).

The pipeline is sound and the diversity is real; the next gains are in *how the panel's collective knowledge is
aggregated*, not in adding more pre-synthesis techniques.

### 6.6 The grader was broken — and it was differentially penalizing fusion

Building the controlled judge experiment (§7), the first thing the new harness printed was a panel where *every* single
model scored **90–94%** on GPQA-D — not the 37–62% the old harness had been reporting for the same models. That gap was
the tell. The old grader (`run.mjs` `pickLetter`) took the **first** standalone A–H letter in the answer. On a terse
"D" that's fine; on anything that reasons first — "**A** is a distractor, so the answer is C" — it grabs **A** and marks
it wrong.

Re-grading the 149 cached panel answers both ways:

| Grader | Accuracy on identical answers |
|---|---|
| old — first A–H letter | 73.2% |
| new — last `FINAL ANSWER: X` line | 92.6% |
| **the two disagree on** | **23.5% of answers** |

A ~19-point swing, disagreeing on nearly **one answer in four**. And the bias isn't uniform: terse single-model letters
grade fine under both, but **verbose answers are mauled by first-letter grading** — which means **fusion's synthesis
(always verbose) was penalized far more than the single-model baselines (often a bare letter).** That is exactly the
asymmetry that would manufacture a fake "fusion < best single" result.

So §6.2–§6.3 are retracted pending re-measurement: the headline "fusion doesn't beat frontier / the judge is the
bottleneck" rested on a grader that couldn't read fusion's answers. What *survives* independent of grading: the model
was running the wrong identity (§6.1, a process bug, fixed) and the judge saw model ids (§6.4, a real bias, fixed).
The clean-grader, variance-controlled comparison is §7.

**Lesson:** a benchmark number that's implausible in the *good* direction (frontier model "only" 37%) deserves the same
suspicion as one that's implausibly good. The grader is part of the system under test.

The fix: every system now ends with `FINAL ANSWER: <letter>` and is graded on that line (last occurrence). It's baked
into the new `judge-eval.mjs` harness and should be backported to `run.mjs` for any future use.

## 7. Controlled judge comparison (2026-06-26) — in progress

The right way to ask "which model is the best judge" is a **paired** experiment, not randomization: randomizing the judge
across runs where the panel *also* re-samples confounds judge quality with the dominant panel-noise (±6–12 pts). Instead
(`scripts/bench/judge-eval.mjs`):

1. **Snapshot** the panel once and cache it — GPQA-D 1–50, depth `standard`, panel = Opus 4.8 + GPT-5.5 + Gemini 3.5
   Flash. Clean-grader baselines: **gpt-5.5 94% · opus 92% · gemini 90% · majority-vote 94%** (1 transient claude error).
2. **Cross every judge** over the *identical* cached panels with k=3 repeated samples, so any gap is the judge. Judges:
   the 4 in-house models now, with Baseten **GLM 5.2** and **Minimax M3** to be added via the new `openai-compatible`
   provider (they re-use the same cache — cheap and directly comparable). Reported with bootstrap 95% CIs and paired
   diffs vs the best judge.

**Result (4 judges × 50 items × k=3, 0 judge errors, paired over identical cached panels):**

| Judge | Accuracy | 95% CI | vs best judge (paired) |
|---|---|---|---|
| claude-opus-4-8 | **96.0%** | [90.0, 100.0] | — |
| gpt-5.5 | **96.0%** | [90.0, 100.0] | +0.0 [0.0, 0.0] |
| gemini-3.5-flash | **95.3%** | [92.0, 99.3] | −0.7 [−2.7, 2.7] |
| **glm-5.2 (Baseten, open)** | **95.3%** | [88.7, 99.3] | −0.7 (added later over the same cache) |
| gemini-2.5-pro | 87.3% | [76.7, 93.3] | **−8.7 [−18.0, −4.7]** (significant) |

**An open model judges as well as frontier.** GLM-5.2 (added later via the new `openai-compatible` provider, scored over
the *same cached panels* for ~$1.50 with no panel re-run) ties gemini-3.5-flash and is statistically indistinguishable
from Opus/GPT-5.5 — and beats gemini-2.5-pro. Validates both the cheap-add-a-judge workflow and using a cheap open model
as the default synthesizer.

Baselines on the same cache: best single (gpt-5.5) **94%**, **majority-vote 94%**.

Three things fall out, and they overturn §6.2–§6.3:

1. **Synthesis beats voting — the "judge bottleneck" was the grader.** The top three judges synthesize at **95–96%**,
   *above* the 94% majority-vote ceiling and above the best single (94%). So a good judge does *not* destroy the panel's
   knowledge — it adds a little on top of a plain vote. The opposite §6.3 claim was an artifact of grading fusion's
   verbose answers with a first-letter parser. **With correct grading, fusion matches/edges frontier rather than losing
   to it.** (Edge is ~2 pts ≈ 1 item and inside the CIs, so the honest statement is "synthesis ≥ vote ≥ best single," not
   a blowout.)
2. **Judge choice is real and measurable.** `gemini-2.5-pro` is a **significantly worse** judge — −8.7 pts, paired CI
   [−18.0, −4.7] excludes 0 — despite being a "pro" tier. The other three are statistically indistinguishable
   (overlapping CIs, paired diff ≈ 0).
3. **A cheap judge ties the frontier ones.** `gemini-3.5-flash` (95.3%) is within noise of Opus and GPT-5.5 (96%). You do
   not need your most expensive model on the bench to get top-tier synthesis — a cost-relevant result for the default
   `defaultJudge`.

Caveats: n=50, one panel snapshot (k_panel=1), depth `standard` (no tools); the top three are a statistical tie, so
"which of the three is best" needs more items. Bigger N and the Baseten judges (GLM 5.2, Minimax M3) re-use this cache.

**Net:** the project's headline survives — *fusion synthesis is competitive with frontier and beats a plain vote* — once
the model identity (§6.1), the judge's view of identity (§6.4), and above all the **grader (§6.6)** are fixed. The
remaining lever is judge *discrimination* on the hardest items, where even a strong judge occasionally follows a
confident-wrong panelist; that's a tooling/calibration problem, not a "synthesis is worthless" problem.

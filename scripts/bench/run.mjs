#!/usr/bin/env node
/**
 * LLM Fusion Lite benchmark harness.
 *
 * Runs each dataset item through llm-fusion-lite AND each baseline single model,
 * grades every answer, and prints a scorecard (accuracy / mean score, win-rate,
 * latency, cost). This is how we put real numbers behind "fusion beats frontier".
 *
 * Dataset: JSONL, one object per line:
 *   { "id": "q1", "prompt": "…", "answer": "B", "choices": ["A …","B …"] }   ← objective (MCQ / exact)
 *   { "id": "q2", "prompt": "…", "rubric": "what a good answer must contain" } ← judged (LLM grader 0–100)
 *
 * Usage:
 *   node scripts/bench/run.mjs scripts/bench/sample.jsonl
 *   node scripts/bench/run.mjs data.jsonl --systems fusion,claude-opus-4-8,gpt-5.5 --limit 20 --out results.json
 *   node scripts/bench/run.mjs data.jsonl --dry-run            # validate dataset + systems, no API calls
 *
 * Technique ablation — isolate one technique at a time (each is a full preset):
 *   node scripts/bench/run.mjs data.jsonl --depth deep \
 *     --systems fusion,fusion-refine,fusion-pairwise,fusion-sc,fusion-verify,fusion-deep
 *   Fusion variants: fusion · fusion-deep · fusion-refine · fusion-debate ·
 *                    fusion-pairwise · fusion-confidence · fusion-sc · fusion-verify
 *
 * Flags: --systems <csv>  --judge <id>  --offset <n>  --limit <n>  --panel <csv>
 *        --depth <light|standard|deep>  --agentic  --out <file>  --dry-run
 *
 * --agentic runs fusion panelists as tool-using agents in the sandbox container
 * (needs `sandbox/run.sh up`); A/B it against a non-agentic run on tool-sensitive
 * items to measure the tool payoff. See docs/AGENTIC_FUSION.md.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
    fuse,
    loadEnv,
    loadConfig,
    availableAutoPanel,
    getModel,
    getProvider,
    resolveJudge,
    authModeFor,
    TECHNIQUES_OFF,
    TECHNIQUES_DEEP,
    FusionStore
} from "../../packages/core/dist/index.js";

loadEnv();

function parseArgs(argv) {
    const args = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a.startsWith("--")) {
            const key = a.slice(2);
            const next = argv[i + 1];
            if (next === undefined || next.startsWith("--")) args[key] = true;
            else {
                args[key] = next;
                i++;
            }
        } else args._.push(a);
    }
    return args;
}

function readJsonl(path) {
    return readFileSync(path, "utf8")
        .split(/\r?\n/)
        .map(l => l.trim())
        .filter(Boolean)
        .map((l, i) => {
            const o = JSON.parse(l);
            if (!o.id) o.id = `item-${i + 1}`;
            return o;
        });
}

/**
 * Normalize an MCQ answer down to a choice letter. Prefer an explicit
 * "FINAL ANSWER: X" line, else the LAST standalone A–H letter (the committed
 * answer), else a choice-text match. Taking the *first* letter (the old bug)
 * grabbed letters out of the reasoning ("A is a distractor… answer is C" → A),
 * which differentially understated verbose answers like fusion's synthesis.
 */
function pickLetter(text, choices) {
    const t = (text || "").trim();
    const fa = [...t.matchAll(/final answer:\s*\(?([A-H])\)?/gi)];
    if (fa.length) return fa[fa.length - 1][1].toUpperCase();
    const all = [...t.matchAll(/\b([A-H])\b/g)];
    if (all.length) return all[all.length - 1][1].toUpperCase();
    if (Array.isArray(choices)) {
        const idx = choices.findIndex(c => t.toLowerCase().includes(String(c).toLowerCase()));
        if (idx >= 0) return String.fromCharCode(65 + idx);
    }
    return t.toUpperCase();
}

function gradeObjective(answer, gold, choices) {
    const goldNorm = String(gold).trim().toUpperCase();
    if (/^[A-H]$/.test(goldNorm)) return pickLetter(answer, choices) === goldNorm ? 1 : 0;
    // free-form exact-ish: gold appears in the answer (normalized)
    const norm = s => String(s).toLowerCase().replace(/\s+/g, " ").trim();
    return norm(answer).includes(norm(gold)) ? 1 : 0;
}

/** LLM-judge an answer against a rubric; returns 0..1. */
async function judgeScore(item, answer, judge) {
    const provider = getProvider(judge.provider);
    const res = await provider.complete(judge.model, {
        maxTokens: 300,
        depth: "light",
        webSearch: false,
        messages: [
            {
                role: "system",
                content:
                    'You are a strict grader. Score how well the candidate answer satisfies the question and rubric, 0–100. Respond ONLY as JSON: {"score": <0-100>, "reason": "..."}.'
            },
            {
                role: "user",
                content: `QUESTION:\n${item.prompt}\n\nRUBRIC:\n${item.rubric || "Accuracy, completeness, and correctness."}\n\nCANDIDATE ANSWER:\n${answer}`
            }
        ]
    });
    try {
        const j = JSON.parse(res.text.slice(res.text.indexOf("{"), res.text.lastIndexOf("}") + 1));
        return Math.max(0, Math.min(1, (Number(j.score) || 0) / 100));
    } catch {
        return 0;
    }
}

function costOf(spec, usage) {
    if (!spec || !usage) return 0;
    return (
        ((usage.inputTokens ?? 0) / 1e6) * (spec.costPer1MIn ?? 0)
        + ((usage.outputTokens ?? 0) / 1e6) * (spec.costPer1MOut ?? 0)
    );
}

/**
 * Fusion system presets for technique ablation. Each value is a FULL
 * TechniqueConfig (so it fully determines what runs regardless of the depth
 * tier), letting us isolate one technique at a time:
 *   fusion           base pipeline (fan-out → synthesize)
 *   fusion-deep      everything on
 *   fusion-refine    MoA refinement only
 *   fusion-debate    MoA refinement with explicit disagreement resolution
 *   fusion-pairwise  pairwise ranking → judge weights only
 *   fusion-confidence panelist self-confidence only
 *   fusion-sc        self-consistency (2 synthesis samples) only
 *   fusion-verify    post-synthesis verify+revise only (tool-enabled at --depth deep)
 * `undefined` means "no override" → the engine's depth-derived default.
 */
const FUSION_PRESETS = {
    "fusion": undefined,
    "fusion-deep": TECHNIQUES_DEEP,
    "fusion-refine": { ...TECHNIQUES_OFF, refineRounds: 1 },
    "fusion-debate": { ...TECHNIQUES_OFF, refineRounds: 1, debate: true },
    "fusion-pairwise": { ...TECHNIQUES_OFF, pairwiseRank: true },
    "fusion-confidence": { ...TECHNIQUES_OFF, confidence: true },
    "fusion-sc": { ...TECHNIQUES_OFF, selfConsistency: 2 },
    "fusion-verify": { ...TECHNIQUES_OFF, verify: true }
};

async function runSystem(system, item, config, store, panel, depth, agentic) {
    const t0 = Date.now();
    if (system.startsWith("fusion")) {
        if (!(system in FUSION_PRESETS)) {
            return {
                answer: "",
                latencyMs: 0,
                costUsd: 0,
                error: `unknown fusion variant ${system} (try: ${Object.keys(FUSION_PRESETS).join(", ")})`
            };
        }
        const techniques = FUSION_PRESETS[system];
        const r = await fuse(
            { prompt: item.prompt, panel, noLearn: true, techniques, depth, agentic },
            { config, store }
        );
        return { answer: r.finalAnswer, latencyMs: Date.now() - t0, costUsd: r.usage.estCostUsd ?? 0, result: r };
    }
    const spec = getModel(config, system);
    if (!spec) return { answer: "", latencyMs: 0, costUsd: 0, error: `unknown model ${system}` };
    const provider = getProvider(spec.provider);
    const callOnce = () =>
        provider.complete(spec.model, {
            messages: [{ role: "user", content: item.prompt }],
            depth: "standard",
            webSearch: false
        });
    // One retry on a transient baseline failure (empty/errored) so flaky
    // subscription-CLI or API hiccups don't get scored as a wrong answer and
    // understate the model. (Subscription calls also retry once inside the engine.)
    let res = await callOnce();
    if ((res.error || !res.text) && !/abort/i.test(res.error || "")) {
        res = await callOnce();
    }
    // Subscription calls are unmetered (flat plan); only meter API-mode models.
    const costUsd = authModeFor(spec.provider, config) === "subscription" ? 0 : costOf(spec, res.usage);
    return { answer: res.text, latencyMs: Date.now() - t0, costUsd, error: res.error };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const datasetPath = args._[0];
    if (!datasetPath) {
        console.error(
            "usage: node scripts/bench/run.mjs <dataset.jsonl> [--systems csv] [--judge id] [--offset n] [--limit n] [--panel csv] [--depth light|standard|deep] [--out file] [--dry-run]"
        );
        process.exit(1);
    }
    const config = loadConfig();
    let items = readJsonl(datasetPath);
    if (args.offset) items = items.slice(parseInt(args.offset, 10));
    if (args.limit) items = items.slice(0, parseInt(args.limit, 10));

    const available = availableAutoPanel(config);
    const systems =
        args.systems ?
            String(args.systems)
                .split(",")
                .map(s => s.trim())
        :   ["fusion", ...available];
    const panel =
        args.panel ?
            String(args.panel)
                .split(",")
                .map(s => s.trim())
        :   undefined;
    const depth = args.depth ? String(args.depth) : undefined; // force a depth tier for fusion systems (light|standard|deep)
    if (depth && !["light", "standard", "deep"].includes(depth)) {
        console.error(`Invalid --depth ${depth} (expected light|standard|deep)`);
        process.exit(1);
    }
    const agentic = !!args.agentic; // run fusion panelists as tool-using agents in the sandbox
    const judge = resolveJudge(config, args.judge);

    console.error(`Dataset: ${datasetPath} — ${items.length} items`);
    console.error(`Systems: ${systems.join(", ")}`);
    console.error(
        `Judge:   ${judge.id}   |  available models: ${available.join(", ") || "none"}`
            + (depth ? `  |  depth=${depth}` : "")
            + (agentic ? `  |  AGENTIC` : "")
            + `\n`
    );

    if (args["dry-run"]) {
        const objective = items.filter(i => i.answer != null).length;
        console.error(
            `Dry run OK. ${objective} objective + ${items.length - objective} judged items. No API calls made.`
        );
        return;
    }

    const store = new FusionStore();
    const agg = Object.fromEntries(systems.map(s => [s, { n: 0, score: 0, latency: 0, cost: 0, errors: 0 }]));
    const detail = [];

    for (const item of items) {
        const row = { id: item.id, scores: {} };
        for (const sys of systems) {
            let res;
            try {
                res = await runSystem(sys, item, config, store, panel, depth, agentic);
            } catch (e) {
                res = { answer: "", latencyMs: 0, costUsd: 0, error: e instanceof Error ? e.message : String(e) };
            }
            const score =
                res.error || !res.answer ? 0
                : item.answer != null ? gradeObjective(res.answer, item.answer, item.choices)
                : await judgeScore(item, res.answer, judge);
            const a = agg[sys];
            a.n++;
            a.score += score;
            a.latency += res.latencyMs;
            a.cost += res.costUsd;
            if (res.error) a.errors++;
            row.scores[sys] = { score, latencyMs: res.latencyMs, costUsd: res.costUsd, error: res.error ?? null };
            // Capture fusion internals: per-panelist correctness + judge influence, so
            // we can see whether the judge weighted the right panelist.
            if (sys.startsWith("fusion") && res.result) {
                const contrib = Object.fromEntries(
                    (res.result.analysis?.contributions ?? []).map(c => [c.modelId, c.score])
                );
                row.fusion = (res.result.panel ?? []).map(p => ({
                    modelId: p.modelId,
                    influence: contrib[p.modelId] ?? null,
                    correct: item.answer != null ? gradeObjective(p.text, item.answer, item.choices) : null,
                    error: p.error ?? null
                }));
            }
            console.error(
                `  ${item.id} · ${sys.padEnd(20)} ${(score * 100).toFixed(0).padStart(3)}%  ${res.error ? "ERR " + res.error.slice(0, 40) : ""}`
            );
        }
        detail.push(row);
    }
    store.close();

    // Scorecard
    console.log("\n=== Scorecard ===");
    console.log("system".padEnd(22) + "n".padEnd(5) + "score".padEnd(9) + "avg ms".padEnd(9) + "cost");
    const ranked = systems
        .map(s => ({ s, ...agg[s], mean: agg[s].n ? agg[s].score / agg[s].n : 0 }))
        .sort((a, b) => b.mean - a.mean);
    for (const r of ranked) {
        console.log(
            r.s.padEnd(22)
                + String(r.n).padEnd(5)
                + `${(r.mean * 100).toFixed(1)}%`.padEnd(9)
                + String(Math.round(r.latency / Math.max(1, r.n))).padEnd(9)
                + (r.cost > 0 ? `$${r.cost.toFixed(4)}` : "unmetered")
        );
    }

    // Did fusion beat the best single model?
    const singles = ranked.filter(r => !r.s.startsWith("fusion"));
    const fusionVariants = ranked.filter(r => r.s.startsWith("fusion"));
    if (fusionVariants.length && singles.length) {
        const best = singles[0];
        const avg = singles.reduce((a, b) => a + b.mean, 0) / singles.length;
        const judgeSolo = singles.find(r => r.s === judge.id);
        const d = x => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)} pts`;
        console.log("");
        for (const fv of fusionVariants) {
            console.log(
                `${fv.s}: ${(fv.mean * 100).toFixed(1)}%  ·  vs best single (${best.s}) ${d(fv.mean - best.mean)}  ·  vs avg single ${d(fv.mean - avg)}`
                    + (judgeSolo ? `  ·  vs judge-solo ${d(fv.mean - judgeSolo.mean)}` : "")
            );
        }
    }

    const out = args.out || `bench-results-${items.length}items.json`;
    writeFileSync(out, JSON.stringify({ dataset: datasetPath, systems, judge: judge.id, agg, detail }, null, 2));
    console.log(`\nWrote ${out}`);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});

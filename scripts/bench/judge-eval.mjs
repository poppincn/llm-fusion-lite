#!/usr/bin/env node
/**
 * Judge-comparison harness — a paired (blocked) experiment to find the strongest
 * synthesis judge while controlling the dominant noise source (panel re-sampling).
 *
 * Why two phases: the engine re-queries the panel on every run, and those answers
 * swing ±6-12 pts run-to-run (subscription models are non-deterministic). Comparing
 * judges across separate runs confounds judge quality with panel noise. Instead we
 *   1) SNAPSHOT the panel once and cache it, then
 *   2) cross EVERY candidate judge over the IDENTICAL cached panel answers.
 * Panel noise is differenced out; any accuracy gap is the judge (plus judge sampling
 * noise, which k repeated judge samples averages down). Bonus: the cache yields each
 * single model's and the panel's majority-vote accuracy for free, and a judge added
 * later (e.g. a Baseten model) is evaluated against the same cache — cheap + comparable.
 *
 * Usage:
 *   # Phase 1 — snapshot panels to a reusable cache (the expensive, one-time part):
 *   node scripts/bench/judge-eval.mjs snapshot <data.jsonl> \
 *     --panel claude-opus-4-8,gpt-5.5,gemini-3.5-flash --offset 0 --limit 50 \
 *     --depth standard --k-panel 1 --out scripts/bench/data/panels.json
 *
 *   # Phase 2 — cross a judge roster over the cache (cheap; rerun anytime, add judges):
 *   node scripts/bench/judge-eval.mjs judges scripts/bench/data/panels.json \
 *     --judges claude-opus-4-8,gpt-5.5,gemini-2.5-pro,gemini-3.5-flash \
 *     --k-judge 3 --out scripts/bench/data/judges.json
 *
 * Only objective (MCQ / letter-answer) datasets are supported here — grading must be
 * deterministic for a clean comparison.
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
    loadEnv,
    loadConfig,
    getModel,
    getProvider,
    runJudgeAnalysis,
    runJudgeSynthesis
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

/** Append an explicit, parseable answer-line instruction so verbose syntheses grade fairly. */
function gradedPrompt(item) {
    return `${item.prompt}\n\nEnd your response with a line in exactly this format:\nFINAL ANSWER: <letter>`;
}

/**
 * Extract the committed MCQ letter. Prefer the LAST "FINAL ANSWER: X" (handles
 * verbose syntheses that discuss distractors first); fall back to the last
 * standalone A-H letter. First-letter grabbing (the old harness) systematically
 * mis-scored verbose answers, biasing against fusion.
 */
function extractLetter(text) {
    const t = String(text || "");
    const fa = [...t.matchAll(/final answer:\s*\(?([A-H])\)?/gi)];
    if (fa.length) return fa[fa.length - 1][1].toUpperCase();
    const any = [...t.matchAll(/\b([A-H])\b/g)];
    if (any.length) return any[any.length - 1][1].toUpperCase();
    return (t.trim().slice(0, 1) || "").toUpperCase();
}

function gradeLetter(text, gold) {
    return extractLetter(text) === String(gold).trim().toUpperCase() ? 1 : 0;
}

/** Plurality of non-error panel letters; ties or all-error count as wrong. */
function majorityCorrect(panelLetters, gold) {
    const counts = {};
    for (const l of panelLetters) if (l) counts[l] = (counts[l] || 0) + 1;
    let best = null,
        n = 0,
        tie = false;
    for (const k in counts) {
        if (counts[k] > n) {
            n = counts[k];
            best = k;
            tie = false;
        } else if (counts[k] === n) tie = true;
    }
    if (!best || tie) return 0;
    return best === String(gold).trim().toUpperCase() ? 1 : 0;
}

async function complete(spec, prompt, depth, signal) {
    return getProvider(spec.provider).complete(spec.model, {
        messages: [{ role: "user", content: prompt }],
        depth,
        webSearch: false,
        signal
    });
}

// ─────────────────────────────── Phase 1: snapshot ───────────────────────────────
async function snapshot(args) {
    const config = loadConfig();
    const datasetPath = args._[1];
    if (!datasetPath) throw new Error("snapshot needs a dataset path");
    let items = readJsonl(datasetPath).filter(i => i.answer != null); // objective only
    if (args.offset) items = items.slice(parseInt(args.offset, 10));
    if (args.limit) items = items.slice(0, parseInt(args.limit, 10));

    const panelIds = (args.panel ? String(args.panel) : "claude-opus-4-8,gpt-5.5,gemini-3.5-flash")
        .split(",")
        .map(s => s.trim());
    const panelSpecs = panelIds.map(id => getModel(config, id)).filter(Boolean);
    const depth = args.depth ? String(args.depth) : "standard";
    const kPanel = args["k-panel"] ? parseInt(args["k-panel"], 10) : 1;

    console.error(
        `SNAPSHOT — ${items.length} items × ${kPanel} panel sample(s) × ${panelSpecs.length} models @ depth=${depth}`
    );
    console.error(`Panel: ${panelSpecs.map(s => s.id).join(", ")}\n`);

    const out = { dataset: datasetPath, panel: panelIds, depth, kPanel, createdAtItems: items.length, items: [] };
    for (const item of items) {
        const snapshots = [];
        for (let s = 0; s < kPanel; s++) {
            const responses = await Promise.all(
                panelSpecs.map(async spec => {
                    const res = await complete(spec, gradedPrompt(item), depth);
                    const letter = res.error ? "" : extractLetter(res.text);
                    return {
                        modelId: spec.id,
                        label: spec.label,
                        text: res.text || "",
                        error: res.error ?? null,
                        letter,
                        correct: res.error ? 0 : gradeLetter(res.text, item.answer),
                        usage: res.usage ?? null,
                        latencyMs: res.latencyMs
                    };
                })
            );
            snapshots.push({ panel: responses });
            const mark = responses
                .map(r => `${r.modelId.split("-")[0]}:${r.error ? "ERR" : r.letter}${r.correct ? "✓" : ""}`)
                .join(" ");
            console.error(`  ${item.id} s${s + 1}  ${mark}  (gold ${item.answer})`);
        }
        out.items.push({
            id: item.id,
            prompt: item.prompt,
            answer: item.answer,
            choices: item.choices ?? null,
            snapshots
        });
    }
    const outPath = args.out || "scripts/bench/data/panels.json";
    writeFileSync(outPath, JSON.stringify(out, null, 2));
    console.error(`\nWrote ${outPath} (${out.items.length} items).`);
    summarizeCache(out);
}

/** Single-model + majority-vote accuracy straight from the cache. */
function summarizeCache(cache) {
    const perModel = {};
    let majTotal = 0,
        majCorrect = 0,
        n = 0;
    for (const it of cache.items) {
        for (const snap of it.snapshots) {
            n++;
            const letters = snap.panel.map(p => p.letter);
            majTotal++;
            majCorrect += majorityCorrect(letters, it.answer);
            for (const p of snap.panel) {
                const m = (perModel[p.modelId] ??= { n: 0, c: 0, err: 0 });
                m.n++;
                m.c += p.correct;
                if (p.error) m.err++;
            }
        }
    }
    console.error(`\n— Cache baselines (${n} item-snapshots) —`);
    for (const [id, m] of Object.entries(perModel))
        console.error(`  ${id.padEnd(20)} ${((m.c / m.n) * 100).toFixed(1)}%  (errors ${m.err})`);
    console.error(`  ${"panel majority-vote".padEnd(20)} ${((majCorrect / majTotal) * 100).toFixed(1)}%`);
}

// ─────────────────────────────── Phase 2: judges ───────────────────────────────
function bootstrapCI(perItem, B = 2000) {
    const n = perItem.length;
    if (!n) return { mean: 0, lo: 0, hi: 0 };
    const mean = perItem.reduce((a, b) => a + b, 0) / n;
    // Deterministic pseudo-random resampling (no Math.random; seed via index mixing).
    const means = [];
    for (let b = 0; b < B; b++) {
        let s = 0;
        let seed = (b * 2654435761) >>> 0;
        for (let i = 0; i < n; i++) {
            seed = (seed * 1103515245 + 12345) >>> 0;
            s += perItem[seed % n];
        }
        means.push(s / n);
    }
    means.sort((a, b) => a - b);
    return { mean, lo: means[Math.floor(0.025 * B)], hi: means[Math.floor(0.975 * B)] };
}

async function judges(args) {
    const config = loadConfig();
    const cachePath = args._[1];
    if (!cachePath) throw new Error("judges needs a cache path (from `snapshot`)");
    const cache = JSON.parse(readFileSync(cachePath, "utf8"));
    const judgeIds = (args.judges ? String(args.judges) : config.defaultJudge).split(",").map(s => s.trim());
    const judgeSpecs = judgeIds.map(id => getModel(config, id)).filter(Boolean);
    const kJudge = args["k-judge"] ? parseInt(args["k-judge"], 10) : 3;

    console.error(
        `JUDGES — ${judgeSpecs.length} judges × ${cache.items.length} items × ${kJudge} sample(s) over cached panels`
    );
    console.error(`Judges: ${judgeSpecs.map(s => s.id).join(", ")}\n`);

    // perItem[judgeId] = array of per-item mean correctness (averaged over snapshots×kJudge)
    const perItem = Object.fromEntries(judgeSpecs.map(s => [s.id, []]));
    const detail = [];

    for (const it of cache.items) {
        const prompt = [{ role: "user", content: gradedPrompt(it) }];
        const row = { id: it.id, gold: it.answer, judges: {} };
        // Build all (judge × snapshot × sample) tasks; api judges run parallel, subscription
        // CLIs serialize on their per-bin lock inside the provider.
        const tasks = [];
        for (const judge of judgeSpecs) {
            for (const snap of it.snapshots) {
                const panel = snap.panel.map(p => ({
                    modelId: p.modelId,
                    label: p.label,
                    text: p.text,
                    error: p.error,
                    provider: getModel(config, p.modelId)?.provider,
                    model: getModel(config, p.modelId)?.model,
                    latencyMs: p.latencyMs ?? 0,
                    usage: p.usage ?? undefined
                }));
                for (let k = 0; k < kJudge; k++) {
                    tasks.push(
                        (async () => {
                            try {
                                const analysis = await runJudgeAnalysis(judge, prompt, panel, {});
                                const synth = await runJudgeSynthesis(judge, prompt, panel, analysis, {
                                    maxTokens: 4096
                                });
                                return {
                                    judgeId: judge.id,
                                    correct: synth.error ? 0 : gradeLetter(synth.text, it.answer),
                                    error: synth.error ?? null
                                };
                            } catch (e) {
                                return {
                                    judgeId: judge.id,
                                    correct: 0,
                                    error: e instanceof Error ? e.message : String(e)
                                };
                            }
                        })()
                    );
                }
            }
        }
        const results = await Promise.all(tasks);
        for (const judge of judgeSpecs) {
            const mine = results.filter(r => r.judgeId === judge.id);
            const mean = mine.reduce((a, b) => a + b.correct, 0) / Math.max(1, mine.length);
            perItem[judge.id].push(mean);
            row.judges[judge.id] = { mean, samples: mine.length, errors: mine.filter(r => r.error).length };
        }
        detail.push(row);
        console.error(
            `  ${it.id}  `
                + judgeSpecs.map(j => `${j.id.split("-")[0]}:${(row.judges[j.id].mean * 100).toFixed(0)}%`).join(" ")
        );
    }

    // Aggregate + CIs
    console.log("\n=== Judge scorecard (paired over identical cached panels) ===");
    console.log("judge".padEnd(22) + "acc".padEnd(8) + "95% CI");
    const ranked = judgeSpecs.map(s => ({ id: s.id, ...bootstrapCI(perItem[s.id]) })).sort((a, b) => b.mean - a.mean);
    for (const r of ranked)
        console.log(
            r.id.padEnd(22)
                + `${(r.mean * 100).toFixed(1)}%`.padEnd(8)
                + `[${(r.lo * 100).toFixed(1)}, ${(r.hi * 100).toFixed(1)}]`
        );

    // Paired diff vs the top judge (bootstrap of the per-item difference)
    if (ranked.length > 1) {
        const top = ranked[0];
        console.log(`\nPaired vs best judge (${top.id}):`);
        for (const r of ranked.slice(1)) {
            const diffs = perItem[top.id].map((v, i) => v - perItem[r.id][i]);
            const ci = bootstrapCI(diffs);
            const sig = ci.lo > 0 ? "  (significant: CI excludes 0)" : "";
            console.log(
                `  ${top.id} − ${r.id}: +${(ci.mean * 100).toFixed(1)} pts  CI [${(ci.lo * 100).toFixed(1)}, ${(ci.hi * 100).toFixed(1)}]${sig}`
            );
        }
    }

    console.log("");
    summarizeCache(cache);

    const outPath = args.out || "scripts/bench/data/judges.json";
    writeFileSync(
        outPath,
        JSON.stringify({ cache: cachePath, judges: judgeIds, kJudge, perItem, detail, ranked }, null, 2)
    );
    console.log(`\nWrote ${outPath}`);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const cmd = args._[0];
    if (cmd === "snapshot") return snapshot(args);
    if (cmd === "judges") return judges(args);
    console.error("usage: node scripts/bench/judge-eval.mjs <snapshot|judges> ...  (see header)");
    process.exit(1);
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});

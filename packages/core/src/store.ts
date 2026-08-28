/**
 * Adaptive store: persists per-run judge contribution scores + user feedback,
 * and computes per-model, per-category strengths used to select panels over time.
 * Backed by the built-in node:sqlite (no native deps).
 */
import { createRequire } from "node:module";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { dbPath } from "./config.js";
import type { FusionResult } from "./types.js";

// Load node:sqlite via createRequire so bundlers (esbuild/tsup) don't rewrite
// the specifier — they don't yet recognize this newer builtin. The type import
// above is erased at compile time, so there is no static `node:sqlite` import.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync: SqliteDatabase } = nodeRequire("node:sqlite") as typeof import("node:sqlite");

export interface ModelStrength {
    modelId: string;
    category: string;
    /** Blended score in [0,1]: judge contributions + user feedback. */
    score: number;
    /** Mean judge contribution credit (0..1). */
    avgContribution: number;
    /** Mean user feedback in [-1,1] (0 if none). */
    feedbackScore: number;
    runs: number;
    feedbackCount: number;
}

export interface PanelPick {
    modelId: string;
    score: number;
    reason: "exploit" | "explore" | "default";
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  prompt TEXT NOT NULL,
  judge_model TEXT NOT NULL,
  final_answer TEXT NOT NULL,
  web_search INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS contributions (
  run_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  score REAL NOT NULL,
  reason TEXT,
  category TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  model_id TEXT,
  rating INTEGER NOT NULL,
  category TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS usage (
  run_id TEXT NOT NULL,
  role TEXT NOT NULL,
  model_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  estimated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contrib_model_cat ON contributions(model_id, category);
CREATE INDEX IF NOT EXISTS idx_feedback_model_cat ON feedback(model_id, category);
CREATE INDEX IF NOT EXISTS idx_feedback_run ON feedback(run_id);
CREATE INDEX IF NOT EXISTS idx_usage_provider ON usage(provider);
CREATE INDEX IF NOT EXISTS idx_usage_model ON usage(model_id);
`;

export interface ProviderUsage {
    provider: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    /** True if any of this provider's token counts are estimated (subscription). */
    estimated: boolean;
}

export interface ModelUsage {
    modelId: string;
    provider: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    estimated: boolean;
}

export interface UsageTotals {
    runs: number;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    /** True if any usage in the total is estimated. */
    estimated: boolean;
}

export interface UsageReport {
    totals: UsageTotals;
    byProvider: ProviderUsage[];
    byModel: ModelUsage[];
}

export class FusionStore {
    private db: DatabaseSync;

    constructor(path = dbPath()) {
        const dir = dirname(path);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        this.db = new SqliteDatabase(path);
        this.db.exec(SCHEMA);
        // Migrate older DBs created before the `estimated` column existed.
        try {
            this.db.exec(`ALTER TABLE usage ADD COLUMN estimated INTEGER NOT NULL DEFAULT 0`);
        } catch {
            // column already exists
        }
    }

    close(): void {
        this.db.close();
    }

    /** Persist a completed fusion run and its judge contribution scores. */
    recordRun(result: FusionResult): void {
        const promptText = result.prompt.map(m => `${m.role}: ${m.content}`).join("\n");
        this.db
            .prepare(
                `INSERT OR REPLACE INTO runs (id, category, prompt, judge_model, final_answer, web_search, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
                result.id,
                result.category,
                promptText,
                result.judgeModelId,
                result.finalAnswer,
                result.webSearch ? 1 : 0,
                result.createdAt
            );

        const insert = this.db.prepare(
            `INSERT INTO contributions (run_id, model_id, score, reason, category, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
        );
        for (const c of result.analysis.contributions) {
            insert.run(result.id, c.modelId, clamp01(c.score), c.reason ?? "", result.category, result.createdAt);
        }

        const insertUsage = this.db.prepare(
            `INSERT INTO usage (run_id, role, model_id, provider, input_tokens, output_tokens, cost_usd, estimated, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        for (const u of result.usageBreakdown ?? []) {
            insertUsage.run(
                result.id,
                u.role,
                u.modelId,
                u.provider,
                Math.round(u.inputTokens) || 0,
                Math.round(u.outputTokens) || 0,
                u.costUsd || 0,
                u.estimated ? 1 : 0,
                result.createdAt
            );
        }
    }

    /** Aggregate provider/model usage for the dashboard. */
    getUsage(): UsageReport {
        const totalsRow = this.db
            .prepare(
                `SELECT COUNT(DISTINCT run_id) AS runs, COUNT(*) AS calls,
                COALESCE(SUM(input_tokens),0) AS inTok, COALESCE(SUM(output_tokens),0) AS outTok,
                COALESCE(SUM(cost_usd),0) AS cost, COALESCE(MAX(estimated),0) AS est
         FROM usage`
            )
            .get() as { runs: number; calls: number; inTok: number; outTok: number; cost: number; est: number };

        const byProvider = (
            this.db
                .prepare(
                    `SELECT provider, COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS inTok,
                  COALESCE(SUM(output_tokens),0) AS outTok, COALESCE(SUM(cost_usd),0) AS cost,
                  COALESCE(MAX(estimated),0) AS est
           FROM usage GROUP BY provider ORDER BY cost DESC`
                )
                .all() as Array<{
                provider: string;
                calls: number;
                inTok: number;
                outTok: number;
                cost: number;
                est: number;
            }>
        ).map(r => ({
            provider: r.provider,
            calls: r.calls,
            inputTokens: r.inTok,
            outputTokens: r.outTok,
            costUsd: r.cost,
            estimated: r.est > 0
        }));

        const byModel = (
            this.db
                .prepare(
                    `SELECT model_id, provider, COUNT(*) AS calls, COALESCE(SUM(input_tokens),0) AS inTok,
                  COALESCE(SUM(output_tokens),0) AS outTok, COALESCE(SUM(cost_usd),0) AS cost,
                  COALESCE(MAX(estimated),0) AS est
           FROM usage GROUP BY model_id, provider ORDER BY cost DESC`
                )
                .all() as Array<{
                model_id: string;
                provider: string;
                calls: number;
                inTok: number;
                outTok: number;
                cost: number;
                est: number;
            }>
        ).map(r => ({
            modelId: r.model_id,
            provider: r.provider,
            calls: r.calls,
            inputTokens: r.inTok,
            outputTokens: r.outTok,
            costUsd: r.cost,
            estimated: r.est > 0
        }));

        return {
            totals: {
                runs: totalsRow.runs,
                calls: totalsRow.calls,
                inputTokens: totalsRow.inTok,
                outputTokens: totalsRow.outTok,
                costUsd: totalsRow.cost,
                estimated: totalsRow.est > 0
            },
            byProvider,
            byModel
        };
    }

    /**
     * Record user feedback. rating: +1 (good) / -1 (bad).
     * If modelId omitted, applies to every panelist of the run.
     */
    recordFeedback(runId: string, rating: 1 | -1, modelId?: string): void {
        const run = this.db.prepare(`SELECT category FROM runs WHERE id = ?`).get(runId) as
            { category?: string } | undefined;
        const category = run?.category ?? "other";
        if (modelId) {
            this.db
                .prepare(`INSERT INTO feedback (run_id, model_id, rating, category, created_at) VALUES (?, ?, ?, ?, ?)`)
                .run(runId, modelId, rating, category, new Date().toISOString());
            return;
        }
        const models = this.db
            .prepare(`SELECT DISTINCT model_id FROM contributions WHERE run_id = ?`)
            .all(runId) as Array<{ model_id: string }>;
        const insert = this.db.prepare(
            `INSERT INTO feedback (run_id, model_id, rating, category, created_at) VALUES (?, ?, ?, ?, ?)`
        );
        const now = new Date().toISOString();
        for (const m of models) insert.run(runId, m.model_id, rating, category, now);
    }

    /** Per-(model, category) blended strength. Optionally filter to one category. */
    getStrengths(category?: string): ModelStrength[] {
        const contribRows = this.db
            .prepare(
                `SELECT model_id, category, AVG(score) AS avg_score, COUNT(*) AS runs
         FROM contributions ${category ? "WHERE category = ?" : ""}
         GROUP BY model_id, category`
            )
            .all(...(category ? [category] : [])) as Array<{
            model_id: string;
            category: string;
            avg_score: number;
            runs: number;
        }>;

        const fbRows = this.db
            .prepare(
                `SELECT model_id, category, AVG(rating) AS avg_rating, COUNT(*) AS cnt
         FROM feedback ${category ? "WHERE category = ?" : ""}
         GROUP BY model_id, category`
            )
            .all(...(category ? [category] : [])) as Array<{
            model_id: string;
            category: string;
            avg_rating: number;
            cnt: number;
        }>;

        const fbMap = new Map<string, { avg: number; cnt: number }>();
        for (const r of fbRows) {
            fbMap.set(`${r.model_id}::${r.category}`, { avg: r.avg_rating, cnt: r.cnt });
        }

        return contribRows.map(r => {
            const fb = fbMap.get(`${r.model_id}::${r.category}`);
            const feedbackScore = fb ? fb.avg : 0;
            return {
                modelId: r.model_id,
                category: r.category,
                avgContribution: r.avg_score,
                feedbackScore,
                runs: r.runs,
                feedbackCount: fb?.cnt ?? 0,
                score: blendScore(r.avg_score, feedbackScore)
            };
        });
    }

    /** Aggregate score for one model in one category (with global fallback). */
    private scoreFor(modelId: string, category: string): { score: number; runs: number } {
        const cat = this.db
            .prepare(`SELECT AVG(score) AS s, COUNT(*) AS n FROM contributions WHERE model_id = ? AND category = ?`)
            .get(modelId, category) as { s: number | null; n: number };
        const global = this.db
            .prepare(`SELECT AVG(score) AS s, COUNT(*) AS n FROM contributions WHERE model_id = ?`)
            .get(modelId) as { s: number | null; n: number };

        const fbCat = this.db
            .prepare(`SELECT AVG(rating) AS r FROM feedback WHERE model_id = ? AND category = ?`)
            .get(modelId, category) as { r: number | null };

        const runs = cat.n ?? 0;
        // Blend category-specific with global when category data is sparse.
        let base: number;
        if (runs >= 3) {
            base = cat.s ?? 0.5;
        } else if ((global.n ?? 0) > 0) {
            const w = runs / 3; // ramp toward category-specific as it accumulates
            base = (cat.s ?? global.s ?? 0.5) * w + (global.s ?? 0.5) * (1 - w);
        } else {
            base = 0.5; // unseen model: neutral prior
        }
        return { score: blendScore(base, fbCat.r ?? 0), runs };
    }

    /**
     * Learned subject-matter expertise priors for a set of models in a subject.
     * Used to inform (not dictate) the influence-weighted judge.
     */
    subjectExpertise(modelIds: string[], subject: string): { modelId: string; score: number; runs: number }[] {
        return modelIds.map(id => {
            const { score, runs } = this.scoreFor(id, subject);
            return { modelId: id, score, runs };
        });
    }

    /**
     * Pick a panel for a category from the available model ids using the learned
     * scores, with ε-greedy exploration so under-tried models keep getting a shot.
     */
    selectPanel(availableIds: string[], category: string, size: number, explorationRate = 0.15): PanelPick[] {
        if (availableIds.length <= size) {
            return availableIds.map(id => ({
                modelId: id,
                score: this.scoreFor(id, category).score,
                reason: "default" as const
            }));
        }

        const scored = availableIds.map(id => {
            const { score, runs } = this.scoreFor(id, category);
            return { id, score, runs };
        });

        // Exploit: highest scores first.
        scored.sort((a, b) => b.score - a.score);
        const picks: PanelPick[] = [];
        const used = new Set<string>();

        // Reserve an exploration slot (ε chance) for the least-tried candidate.
        let exploreSlots = 0;
        if (size >= 2 && deterministicChance(category + availableIds.join(","), explorationRate)) {
            exploreSlots = 1;
        }

        for (const s of scored) {
            if (picks.length >= size - exploreSlots) break;
            picks.push({ modelId: s.id, score: s.score, reason: "exploit" });
            used.add(s.id);
        }

        if (exploreSlots > 0) {
            const underTried = scored.filter(s => !used.has(s.id)).sort((a, b) => a.runs - b.runs)[0];
            if (underTried) {
                picks.push({ modelId: underTried.id, score: underTried.score, reason: "explore" });
                used.add(underTried.id);
            }
            // Backfill if exploration found nothing new.
            for (const s of scored) {
                if (picks.length >= size) break;
                if (!used.has(s.id)) {
                    picks.push({ modelId: s.id, score: s.score, reason: "exploit" });
                    used.add(s.id);
                }
            }
        }

        return picks.slice(0, size);
    }

    recentRuns(limit = 20): Array<{ id: string; category: string; judge_model: string; created_at: string }> {
        return this.db
            .prepare(`SELECT id, category, judge_model, created_at FROM runs ORDER BY created_at DESC LIMIT ?`)
            .all(limit) as Array<{ id: string; category: string; judge_model: string; created_at: string }>;
    }
}

function clamp01(n: number): number {
    if (Number.isNaN(n)) return 0;
    return Math.max(0, Math.min(1, n));
}

/** Blend judge contribution (0..1) with feedback (-1..1) into a [0,1] score. */
function blendScore(contribution: number, feedback: number): number {
    return clamp01(contribution + 0.2 * feedback);
}

/**
 * Deterministic pseudo-random gate (Math.random is unavailable in some harness
 * contexts and non-reproducible). Hash the key into [0,1) and compare to ε.
 */
function deterministicChance(key: string, probability: number): boolean {
    let h = 2166136261;
    for (let i = 0; i < key.length; i++) {
        h ^= key.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    const v = ((h >>> 0) % 1000) / 1000;
    return v < probability;
}

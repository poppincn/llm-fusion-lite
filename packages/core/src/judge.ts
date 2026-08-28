/**
 * Two-phase judge:
 *  A) structured comparative analysis (consensus / contradictions / gaps /
 *     unique insights + per-panelist contribution credit) — feeds learning.
 *  B) streamed final answer, grounded in the analysis and panel responses.
 */
import type { FusionConfig } from "./config.js";
import { getModel } from "./config.js";
import { getProvider } from "./providers/index.js";
import type { ChatMessage, CompletionResult, JudgeAnalysis, ModelSpec, PanelResponse } from "./types.js";

function promptText(messages: ChatMessage[]): string {
    return messages.map(m => `[${m.role}] ${m.content}`).join("\n\n");
}

/**
 * Anonymized panel transcript for the judge. Crucially, the model identity
 * (id/label) is HIDDEN — panelists are just "Panelist 1..N" by position — so the
 * judge weighs answers on merit, not provider. (When the judge sees real ids it
 * exhibits self-preference: an Opus judge over-trusts the Opus panelist even when
 * it is wrong. `refinePanel` already anonymizes peers for the same reason.)
 */
function panelDigest(panel: PanelResponse[]): string {
    return panel
        .map((p, i) => {
            const conf = p.confidence != null ? ` [self-confidence ${(p.confidence * 100).toFixed(0)}%]` : "";
            const head = `### Panelist ${i + 1}${conf}`;
            if (p.error) return `${head}\n[ERROR: ${p.error}] (no response)`;
            const cites =
                p.citations?.length ?
                    `\nSources: ${p.citations
                        .map(c => c.url)
                        .slice(0, 5)
                        .join(", ")}`
                :   "";
            return `${head}\n${p.text}${cites}`;
        })
        .join("\n\n");
}

const ANALYSIS_SCHEMA_HINT = `Return ONLY a JSON object with this exact shape (no markdown, no prose outside the JSON):
{
  "summary": "one sentence on overall panel agreement",
  "consensus": ["points all/most panelists agree on"],
  "contradictions": ["direct disagreements between panelists"],
  "gaps": ["important things no panelist covered well"],
  "uniqueInsights": [{"panelist": 1, "insight": "something only this panelist contributed"}],
  "contributions": [{"panelist": 1, "score": 0.0, "reason": "why this credit"}]
}
"panelist" is the panelist's NUMBER (1-based, matching "Panelist N" above). "contributions" MUST include one entry for EVERY panelist number, with score in [0,1] reflecting how much that panelist's response advanced the best final answer (accuracy, unique correct insight, coverage). A panelist that was wrong or unhelpful gets a low score; one that drove the answer gets a high score. Judge purely on the merits of each answer — you do NOT know which model produced which.`;

/** Tolerant JSON extraction (handles stray prose / code fences). */
function extractJson(text: string): unknown {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fenced ? fenced[1] : text;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("no JSON object found");
    return JSON.parse(candidate.slice(start, end + 1));
}

/**
 * Resolve a judge-supplied panelist reference to a real modelId. The judge sees
 * anonymized "Panelist N", so it returns a 1-based `panelist` number; we map it
 * back by position. A legacy `modelId` string is still accepted as a fallback.
 */
function resolveModelId(ref: { panelist?: unknown; modelId?: unknown }, panel: PanelResponse[]): string | undefined {
    const idx = Number(ref.panelist);
    if (Number.isInteger(idx) && idx >= 1 && idx <= panel.length) return panel[idx - 1].modelId;
    if (typeof ref.modelId === "string" && panel.some(p => p.modelId === ref.modelId)) return ref.modelId;
    return undefined;
}

function normalizeAnalysis(raw: unknown, panel: PanelResponse[]): JudgeAnalysis {
    const r = (raw ?? {}) as {
        summary?: unknown;
        consensus?: unknown;
        contradictions?: unknown;
        gaps?: unknown;
        uniqueInsights?: Array<{ panelist?: unknown; modelId?: unknown; insight?: unknown }>;
        contributions?: Array<{ panelist?: unknown; modelId?: unknown; score?: unknown; reason?: unknown }>;
    };
    const contributions =
        Array.isArray(r.contributions) ?
            r.contributions
                .map(c => ({ modelId: resolveModelId(c, panel), score: c.score, reason: c.reason }))
                .filter((c): c is { modelId: string; score: unknown; reason: unknown } => !!c.modelId)
        :   [];
    // Ensure every panelist has a contribution entry.
    for (const p of panel) {
        if (!contributions.find(c => c.modelId === p.modelId)) {
            contributions.push({
                modelId: p.modelId,
                score: p.error ? 0 : 0.5,
                reason: p.error ? "no response" : "no explicit credit assigned"
            });
        }
    }
    return {
        summary: typeof r.summary === "string" ? r.summary : "",
        consensus: arr(r.consensus),
        contradictions: arr(r.contradictions),
        gaps: arr(r.gaps),
        uniqueInsights:
            Array.isArray(r.uniqueInsights) ?
                r.uniqueInsights
                    .map(u => ({ modelId: resolveModelId(u, panel), insight: String(u.insight ?? "") }))
                    .filter((u): u is { modelId: string; insight: string } => !!u.modelId)
            :   [],
        contributions: contributions.map(c => ({
            modelId: c.modelId,
            score: Math.max(0, Math.min(1, Number(c.score) || 0)),
            reason: String(c.reason ?? "")
        }))
    };
}

function arr(v: unknown): string[] {
    return Array.isArray(v) ? v.map(String) : [];
}

export interface JudgePrior {
    modelId: string;
    score: number;
    runs: number;
}

function priorsBlock(subject: string, priors: JudgePrior[], panel: PanelResponse[]): string {
    // Keyed by anonymized panelist number (not modelId) so the prior can't leak
    // model identity and reintroduce self-preference.
    const indexById = new Map(panel.map((p, i) => [p.modelId, i + 1]));
    const known = priors
        .filter(p => indexById.has(p.modelId) && p.runs > 0)
        .map(p => ({ n: indexById.get(p.modelId)!, score: p.score, runs: p.runs }))
        .sort((a, b) => a.n - b.n);
    if (!known.length) {
        return `No prior subject-matter track record yet for these panelists in "${subject}". Judge purely on the merits of each response.`;
    }
    const lines = known
        .map(p => `- Panelist ${p.n}: expertise ${p.score.toFixed(2)} (over ${p.runs} prior runs)`)
        .join("\n");
    return `Learned subject-matter expertise in "${subject}" (0..1, from past runs) — use as a soft prior to break ties when responses are otherwise comparable, but ALWAYS let the actual evidence and correctness in THIS request override the prior:\n${lines}`;
}

export async function runJudgeAnalysis(
    judge: ModelSpec,
    prompt: ChatMessage[],
    panel: PanelResponse[],
    opts: {
        subject?: string;
        priors?: JudgePrior[];
        pairwise?: Map<string, number>;
        agentic?: boolean;
        signal?: AbortSignal;
    } = {}
): Promise<JudgeAnalysis> {
    const provider = getProvider(judge.provider);
    const priorText = priorsBlock(opts.subject ?? "this subject", opts.priors ?? [], panel);
    const indexById = new Map(panel.map((p, i) => [p.modelId, i + 1]));
    const rankText =
        opts.pairwise && opts.pairwise.size ?
            `\n\nPairwise-ranking strength (0..1, from head-to-head comparisons of these answers — a strong corroborating signal):\n`
            + [...opts.pairwise]
                .filter(([id]) => indexById.has(id))
                .sort((a, b) => b[1] - a[1])
                .map(([id, w]) => `- Panelist ${indexById.get(id)}: ${w.toFixed(2)}`)
                .join("\n")
        :   "";
    // In agentic mode the judge runs as a tool-using agent: it should INDEPENDENTLY
    // verify each panelist's key claims (compute/search) rather than defer to the
    // most confident-sounding answer — the failure mode where the panel holds the
    // right answer but the judge picks a confident-wrong one.
    const verifyClause =
        opts.agentic ?
            `You have shell, code-execution, and web tools. Do NOT trust confident phrasing: independently CHECK each panelist's key quantitative/factual claims by running code or searching, and assign influence from what you verified, not from tone. `
        :   "";
    const res = await provider.complete(judge.model, {
        maxTokens: 4096,
        webSearch: false,
        depth: "light",
        agentic: opts.agentic,
        reasoningEffort: judge.reasoningEffort,
        signal: opts.signal,
        messages: [
            {
                role: "system",
                content: `You are an impartial judge comparing answers from a panel of AI models to one user request. Produce a precise structured comparison. ${verifyClause}For each panelist, assess its INFLUENCE on the best possible final answer — how much its response should drive the synthesis (correctness, unique correct insight, coverage). ${ANALYSIS_SCHEMA_HINT}`
            },
            {
                role: "user",
                content: `USER REQUEST:\n${promptText(prompt)}\n\n${priorText}${rankText}\n\nPANEL RESPONSES:\n${panelDigest(panel)}`
            }
        ]
    });
    if (res.error) {
        // Degrade gracefully: neutral analysis so the run can still synthesize.
        return normalizeAnalysis({ summary: "judge analysis unavailable" }, panel);
    }
    try {
        return normalizeAnalysis(extractJson(res.text), panel);
    } catch {
        return normalizeAnalysis({ summary: "judge analysis parse failed" }, panel);
    }
}

export async function runJudgeSynthesis(
    judge: ModelSpec,
    prompt: ChatMessage[],
    panel: PanelResponse[],
    analysis: JudgeAnalysis,
    opts: { maxTokens?: number; agentic?: boolean; onToken?: (t: string) => void; signal?: AbortSignal }
): Promise<CompletionResult> {
    const provider = getProvider(judge.provider);
    const analysisBlock = [
        analysis.summary && `Summary: ${analysis.summary}`,
        analysis.consensus.length && `Consensus:\n- ${analysis.consensus.join("\n- ")}`,
        analysis.contradictions.length && `Contradictions (resolve these):\n- ${analysis.contradictions.join("\n- ")}`,
        analysis.gaps.length && `Gaps (address if you can):\n- ${analysis.gaps.join("\n- ")}`,
        analysis.uniqueInsights.length
            && `Unique insights worth keeping:\n- ${analysis.uniqueInsights.map(u => `${u.insight}`).join("\n- ")}`
    ]
        .filter(Boolean)
        .join("\n\n");

    const verifyClause =
        opts.agentic ?
            " You have shell, code-execution, and web tools — where panelists disagree or make a quantitative/factual claim, INDEPENDENTLY recompute or look it up and let your own verified result decide, rather than following the more confident-sounding panelist."
        :   "";
    return provider.complete(judge.model, {
        maxTokens: opts.maxTokens ?? 8192,
        webSearch: false,
        depth: "light",
        agentic: opts.agentic,
        reasoningEffort: judge.reasoningEffort,
        signal: opts.signal,
        onToken: opts.onToken,
        messages: [
            {
                role: "system",
                content:
                    "You are a synthesizer. Multiple AI models answered the user's request, and a judge compared them. Write the single best possible final answer for the user, grounded in the strongest, correct material from the panel. Resolve contradictions in favor of the better-supported claim, incorporate unique correct insights, and fix gaps."
                    + verifyClause
                    + " Do not mention the panel, the models, or that this is a synthesis — just answer the user directly and excellently."
            },
            {
                role: "user",
                content: `USER REQUEST:\n${promptText(prompt)}\n\nJUDGE'S COMPARATIVE ANALYSIS:\n${analysisBlock}\n\nPANEL RESPONSES:\n${panelDigest(panel)}\n\nNow write the final answer for the user.`
            }
        ]
    });
}

export function resolveJudge(config: FusionConfig, judgeId?: string): ModelSpec {
    const id = judgeId ?? config.defaultJudge;
    const spec = getModel(config, id);
    if (!spec) throw new Error(`Judge model "${id}" not found in config.`);
    return spec;
}

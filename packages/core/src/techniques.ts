/**
 * Optional fusion techniques layered on the base fan-out → synthesize pipeline.
 * Each is a focused, provider-agnostic stage the engine composes by config:
 *  - refinePanel    : Mixture-of-Agents — panelists revise after seeing peers
 *  - pairwiseRank   : LLM-Blender-style pairwise ranking → influence weights
 *  - verifyAndRevise: post-synthesis verification + one revision
 *  - selectConsistent: universal self-consistency over N synthesis samples
 *  - parseConfidence: extract a panelist's self-reported confidence
 */
import type { FusionConfig } from "./config.js";
import { getModel } from "./config.js";
import { getProvider } from "./providers/index.js";
import type { ChatMessage, Depth, ModelSpec, PanelResponse } from "./types.js";

function promptText(messages: ChatMessage[]): string {
    return messages.map(m => `[${m.role}] ${m.content}`).join("\n\n");
}

function extractJson(text: string): unknown {
    const s = text.indexOf("{");
    const e = text.lastIndexOf("}");
    if (s === -1 || e === -1) throw new Error("no json");
    return JSON.parse(text.slice(s, e + 1));
}

/** Parse a trailing "Confidence: 80%" (or 0–1) from a panelist answer → 0..1. */
export function parseConfidence(text: string): number | undefined {
    const m =
        text.match(/confidence\s*[:=]\s*(\d{1,3})\s*%/i) || text.match(/confidence\s*[:=]\s*(0?\.\d+|1(?:\.0+)?)\b/i);
    if (!m) return undefined;
    const raw = parseFloat(m[1]);
    if (Number.isNaN(raw)) return undefined;
    return raw > 1 ? Math.min(1, raw / 100) : Math.max(0, Math.min(1, raw));
}

/** Anonymous peer label so refinement isn't biased by model identity. */
function peerLabel(i: number): string {
    return `Solver ${String.fromCharCode(65 + i)}`;
}

/**
 * Mixture-of-Agents refinement round: each panelist sees every (anonymized)
 * answer and produces an improved one. `debate` makes it explicitly resolve
 * disagreements. Failed/errored panelists are kept as-is.
 */
export async function refinePanel(
    prompt: ChatMessage[],
    panel: PanelResponse[],
    config: FusionConfig,
    opts: { debate: boolean; signal?: AbortSignal }
): Promise<PanelResponse[]> {
    const peerBlock = panel.map((p, i) => `${peerLabel(i)}:\n${p.error ? "(no answer)" : p.text}`).join("\n\n");

    return Promise.all(
        panel.map(async (p, idx) => {
            const spec = getModel(config, p.modelId);
            if (!spec || p.error || !p.text) return p; // keep errored/missing as-is
            const sys =
                `You are ${peerLabel(idx)}. Independent solvers answered the same question. `
                + `Review ALL answers (including your own), spot errors and stronger reasoning`
                + (opts.debate ? ", and where solvers disagree decide which is correct and why" : "")
                + `, then write YOUR improved, final answer. Do not mention the other solvers.`;
            const res = await getProvider(spec.provider).complete(spec.model, {
                depth: "light",
                webSearch: false,
                signal: opts.signal,
                messages: [
                    { role: "system", content: sys },
                    {
                        role: "user",
                        content: `QUESTION:\n${promptText(prompt)}\n\nANSWERS:\n${peerBlock}\n\nYour improved final answer:`
                    }
                ]
            });
            if (res.error || !res.text) return p; // keep prior answer on failure
            return { ...p, text: res.text, refined: true, usage: res.usage, latencyMs: p.latencyMs + res.latencyMs };
        })
    );
}

/**
 * Pairwise-rank panel answers (every unordered pair, judged) and return a
 * normalized 0..1 weight per modelId (wins / max wins). Robust alternative to
 * the judge's one-pass scoring.
 */
export async function pairwiseRank(
    prompt: ChatMessage[],
    panel: PanelResponse[],
    judge: ModelSpec,
    signal?: AbortSignal
): Promise<Map<string, number>> {
    const valid = panel.filter(p => !p.error && p.text);
    const wins = new Map<string, number>(valid.map(p => [p.modelId, 0]));
    if (valid.length < 2) return wins;

    const pairs: Array<[PanelResponse, PanelResponse]> = [];
    for (let i = 0; i < valid.length; i++) for (let j = i + 1; j < valid.length; j++) pairs.push([valid[i], valid[j]]);

    const provider = getProvider(judge.provider);
    await Promise.all(
        pairs.map(async ([a, b]) => {
            const res = await provider.complete(judge.model, {
                maxTokens: 200,
                depth: "light",
                webSearch: false,
                signal,
                messages: [
                    {
                        role: "system",
                        content: `Compare two candidate answers. Reply ONLY JSON {"winner":"A"|"B"}. Pick the more correct, complete, better-supported one.`
                    },
                    {
                        role: "user",
                        content: `QUESTION:\n${promptText(prompt)}\n\nANSWER A:\n${a.text}\n\nANSWER B:\n${b.text}`
                    }
                ]
            });
            let winner = a;
            try {
                const j = extractJson(res.text) as { winner?: string };
                if (
                    String(j.winner ?? "A")
                        .toUpperCase()
                        .startsWith("B")
                )
                    winner = b;
            } catch {
                /* default to A on parse failure */
            }
            wins.set(winner.modelId, (wins.get(winner.modelId) ?? 0) + 1);
        })
    );

    const max = Math.max(1, ...wins.values());
    const out = new Map<string, number>();
    for (const [k, v] of wins) out.set(k, v / max);
    return out;
}

/**
 * Universal self-consistency: given N synthesis candidates, pick the one most
 * consistent with the others (the majority view). Returns the chosen index.
 */
export async function selectConsistent(
    prompt: ChatMessage[],
    candidates: string[],
    judge: ModelSpec,
    signal?: AbortSignal
): Promise<number> {
    if (candidates.length <= 1) return 0;
    const list = candidates.map((c, i) => `### Candidate ${i + 1}\n${c}`).join("\n\n");
    const res = await getProvider(judge.provider).complete(judge.model, {
        maxTokens: 200,
        depth: "light",
        webSearch: false,
        signal,
        messages: [
            {
                role: "system",
                content: `Several candidate answers to one question are given. Pick the single best, most-consistent-with-the-majority, most correct one. Reply ONLY JSON {"choice": <1-based index>}.`
            },
            { role: "user", content: `QUESTION:\n${promptText(prompt)}\n\n${list}` }
        ]
    });
    try {
        const j = extractJson(res.text) as { choice?: number };
        const idx = (Number(j.choice) || 1) - 1;
        return idx >= 0 && idx < candidates.length ? idx : 0;
    } catch {
        return 0;
    }
}

/**
 * Verify the synthesized answer; if the verifier flags real problems, revise
 * once. Returns the (possibly revised) answer plus pass/revise status.
 *
 * On the `deep` tier the verifier runs at the run's depth with tools enabled, so
 * it can independently check factual/quantitative claims via web search + code
 * execution (where the judge's provider supports it). This is the key lever on
 * the all-panel-wrong failure mode, where a light, tool-blind verifier rubber-
 * stamps a confident-but-wrong consensus. Light/standard tiers stay tool-free.
 */
export async function verifyAndRevise(
    prompt: ChatMessage[],
    finalAnswer: string,
    judge: ModelSpec,
    opts: {
        depth?: Depth;
        webSearch?: boolean;
        /**
         * Whether the judge provider will actually honor hosted tools at `deep`
         * depth. True for api-mode Anthropic/Google; false for subscription CLIs,
         * which ignore the depth/webSearch flags entirely. Defaults to true.
         */
        tools?: boolean;
        maxTokens?: number;
        onToken?: (t: string) => void;
        signal?: AbortSignal;
    }
): Promise<{ passed: boolean; revised: boolean; answer: string }> {
    const provider = getProvider(judge.provider);
    const depth = opts.depth ?? "light";
    // Tools only on the deep tier, only when the run hasn't disabled web search,
    // only when the judge's provider offers grounding, and only when the caller
    // confirms the provider will honor hosted tools (api mode, not a CLI).
    const useTools = depth === "deep" && opts.webSearch !== false && opts.tools !== false && provider.supportsWebSearch;
    const checkTools =
        useTools ?
            " For any numeric or quantitative claim, RE-DERIVE it yourself by running code — do not trust the answer's arithmetic or reasoning. For factual or current-events claims, check them with web search. Base your verdict on YOUR independent results, not the candidate's own explanation."
        :   "";
    // An agentic, tool-using check needs room for tool turns; a tool-free one is cheap.
    const checkMaxTokens = useTools ? 8000 : 600;

    const check = await provider.complete(judge.model, {
        maxTokens: checkMaxTokens,
        depth,
        webSearch: useTools,
        signal: opts.signal,
        messages: [
            {
                role: "system",
                content: `You are a verifier. Check the candidate answer for factual errors, logical flaws, miscalculations, or unsupported claims.${checkTools} Reply ONLY JSON {"verdict":"PASS"|"REVISE","issues":"..."}. PASS if it is sound.`
            },
            { role: "user", content: `QUESTION:\n${promptText(prompt)}\n\nCANDIDATE ANSWER:\n${finalAnswer}` }
        ]
    });

    let verdict = "PASS";
    let issues = "";
    try {
        const j = extractJson(check.text) as { verdict?: string; issues?: string };
        verdict = String(j.verdict ?? "PASS").toUpperCase();
        issues = String(j.issues ?? "");
    } catch {
        /* treat unparseable as PASS */
    }
    if (verdict !== "REVISE" || !issues.trim()) {
        return { passed: true, revised: false, answer: finalAnswer };
    }

    const rev = await provider.complete(judge.model, {
        maxTokens: opts.maxTokens ?? 8192,
        depth,
        webSearch: useTools,
        signal: opts.signal,
        onToken: opts.onToken,
        messages: [
            {
                role: "system",
                content: `Revise the answer to fix the verifier's issues. Keep what is correct.${useTools ? " Use web search and code execution to confirm corrections where helpful." : ""} Output ONLY the corrected final answer.`
            },
            {
                role: "user",
                content: `QUESTION:\n${promptText(prompt)}\n\nPREVIOUS ANSWER:\n${finalAnswer}\n\nVERIFIER ISSUES:\n${issues}\n\nCorrected final answer:`
            }
        ]
    });
    return { passed: false, revised: !rev.error, answer: rev.error ? finalAnswer : rev.text };
}

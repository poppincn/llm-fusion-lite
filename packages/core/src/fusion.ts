/** The fusion engine: classify → select panel → dispatch → judge → learn. */
import { randomUUID } from "node:crypto";
import type { FusionConfig } from "./config.js";
import { authModeFor, getModel, loadConfig, resolveTechniques } from "./config.js";
import { adjudicate } from "./adjudicate.js";
import {
  parseConfidence,
  refinePanel,
  pairwiseRank,
  selectConsistent,
  verifyAndRevise,
} from "./techniques.js";
import { getProvider } from "./providers/index.js";
import { resolveJudge, runJudgeAnalysis, runJudgeSynthesis } from "./judge.js";
import type { FusionStore } from "./store.js";
import type {
  ChatMessage,
  FuseOptions,
  FusionEvent,
  FusionResult,
  FusionUsage,
  ModelSpec,
  PanelResponse,
} from "./types.js";

function toMessages(prompt: string | ChatMessage[]): ChatMessage[] {
  if (typeof prompt === "string") return [{ role: "user", content: prompt }];
  return prompt;
}

/**
 * Model ids eligible for auto-selection whose provider is configured —
 * api-mode (key set) or subscription-mode (CLI on PATH), per the registry.
 */
export function availableAutoPanel(config: FusionConfig): string[] {
  return config.autoPanel.filter((id) => {
    const spec = getModel(config, id);
    return spec && !spec.excludeFromAuto && getProvider(spec.provider).isConfigured();
  });
}

function costOf(spec: ModelSpec | undefined, inTok: number, outTok: number): number {
  if (!spec) return 0;
  return (inTok / 1e6) * (spec.costPer1MIn ?? 0) + (outTok / 1e6) * (spec.costPer1MOut ?? 0);
}

function estimateCost(panel: PanelResponse[], judge: ModelSpec, judgeOut: number, judgeIn: number, config: FusionConfig): number {
  let cost = 0;
  for (const p of panel) {
    // Subscription calls are unmetered (flat plan) — exclude from metered cost.
    if (authModeFor(p.provider, config) === "subscription") continue;
    const spec = getModel(config, p.modelId);
    if (!spec) continue;
    cost += ((p.usage?.inputTokens ?? 0) / 1e6) * (spec.costPer1MIn ?? 0);
    cost += ((p.usage?.outputTokens ?? 0) / 1e6) * (spec.costPer1MOut ?? 0);
  }
  if (authModeFor(judge.provider, config) !== "subscription") {
    cost += (judgeIn / 1e6) * (judge.costPer1MIn ?? 0);
    cost += (judgeOut / 1e6) * (judge.costPer1MOut ?? 0);
  }
  return cost;
}

export interface FuseDeps {
  config?: FusionConfig;
  store?: FusionStore;
}

/**
 * Run a full fusion. Emits progress via opts.onEvent and returns the result.
 * Pass a FusionStore in deps to enable adaptive panel selection + learning.
 */
export async function fuse(opts: FuseOptions, deps: FuseDeps = {}): Promise<FusionResult> {
  const config = deps.config ?? loadConfig();
  const store = deps.store;
  const emit = (e: FusionEvent) => opts.onEvent?.(e);
  const messages = toMessages(opts.prompt);
  const webSearch = opts.webSearch ?? config.webSearch;

  try {
    // 1. Adjudicate scope: subject + dynamic depth
    const adj = await adjudicate(messages, config, opts.signal);
    const category = opts.category ?? adj.subject;
    const depth = opts.depth ?? adj.depth;
    const tech = resolveTechniques(opts.techniques, depth, config);
    emit({ type: "category", category });
    emit({ type: "depth", depth, rationale: adj.rationale });

    // 2. Panel selection
    const available = availableAutoPanel(config);
    if (available.length === 0) {
      throw new Error(
        "No usable models. Set ANTHROPIC_API_KEY (and optionally OPENAI_API_KEY / GOOGLE_API_KEY).",
      );
    }
    let panelIds: string[];
    if (opts.panel && opts.panel.length) {
      panelIds = opts.panel.filter((id) => {
        const spec = getModel(config, id);
        return spec && getProvider(spec.provider).isConfigured();
      });
      if (!panelIds.length) panelIds = available.slice(0, opts.panelSize ?? config.panelSize);
    } else {
      const size = Math.min(opts.panelSize ?? config.panelSize, available.length);
      panelIds = store
        ? store.selectPanel(available, category, size, config.explorationRate).map((p) => p.modelId)
        : available.slice(0, size);
    }

    const panelSpecs = panelIds
      .map((id) => getModel(config, id))
      .filter((s): s is ModelSpec => !!s);
    emit({
      type: "panel_selected",
      panel: panelSpecs.map((s) => ({ id: s.id, label: s.label })),
    });

    // 3. Dispatch panel in parallel (optionally asking for self-confidence)
    const panelMessages = tech.confidence
      ? [
          ...messages,
          {
            role: "system" as const,
            content: 'End your answer with a final line exactly like "Confidence: 75%" — your calibrated confidence that it is correct.',
          },
        ]
      : messages;
    let panel: PanelResponse[] = await Promise.all(
      panelSpecs.map(async (spec) => {
        emit({ type: "panel_start", modelId: spec.id, label: spec.label });
        const provider = getProvider(spec.provider);
        const res = await provider.complete(spec.model, {
          messages: panelMessages,
          maxTokens: opts.maxTokens,
          webSearch: webSearch && (spec.webSearch ?? false),
          depth,
          signal: opts.signal,
          onToken: (t) => emit({ type: "panel_token", modelId: spec.id, token: t }),
        });
        const pr: PanelResponse = {
          ...res,
          modelId: spec.id,
          label: spec.label,
          confidence: tech.confidence ? parseConfidence(res.text) : undefined,
        };
        emit({ type: "panel_done", response: pr });
        return pr;
      }),
    );

    const judge = resolveJudge(config, opts.judge);

    // 3b. Mixture-of-Agents refinement: panelists revise after seeing peers.
    for (let r = 0; r < tech.refineRounds; r++) {
      emit({ type: "refine_round", round: r + 1, total: tech.refineRounds });
      panel = await refinePanel(messages, panel, config, { debate: tech.debate, signal: opts.signal });
      for (const p of panel) emit({ type: "panel_done", response: p });
    }

    // 3c. Pairwise ranking → influence weights for the judge.
    let pairwise: Map<string, number> | undefined;
    if (tech.pairwiseRank) {
      pairwise = await pairwiseRank(messages, panel, judge, opts.signal);
      emit({ type: "rank", weights: [...pairwise].map(([modelId, weight]) => ({ modelId, weight })) });
    }

    // 4. Judge — phase A (influence-weighted analysis, informed by learned SME)
    const priors = store
      ? store.subjectExpertise(panel.map((p) => p.modelId), category)
      : [];
    if (priors.length) emit({ type: "sme_priors", subject: category, priors });
    emit({ type: "judge_start", judgeModelId: judge.id });
    const analysis = await runJudgeAnalysis(judge, messages, panel, {
      subject: category,
      priors,
      pairwise,
      signal: opts.signal,
    });
    emit({ type: "analysis", analysis });

    // 5. Judge — phase B (synthesis). Stream live only when no post-processing
    // (self-consistency / verify) could change the answer afterward.
    const synthMaxTokens = opts.maxTokens ? Math.max(opts.maxTokens, 4096) : 8192;
    const streamLive = tech.selfConsistency <= 1 && !tech.verify;
    let finalAnswer: string;
    let judgeIn = 0;
    let judgeOut = 0;

    if (tech.selfConsistency > 1) {
      emit({ type: "self_consistency", samples: tech.selfConsistency });
      const samples = await Promise.all(
        Array.from({ length: tech.selfConsistency }, () =>
          runJudgeSynthesis(judge, messages, panel, analysis, { maxTokens: synthMaxTokens, signal: opts.signal }),
        ),
      );
      const idx = await selectConsistent(messages, samples.map((s) => s.text), judge, opts.signal);
      finalAnswer = samples[idx].text;
      for (const s of samples) {
        judgeIn += s.usage?.inputTokens ?? 0;
        judgeOut += s.usage?.outputTokens ?? 0;
      }
    } else {
      const synth = await runJudgeSynthesis(judge, messages, panel, analysis, {
        maxTokens: synthMaxTokens,
        signal: opts.signal,
        onToken: streamLive ? (t) => emit({ type: "answer_token", token: t }) : undefined,
      });
      finalAnswer = synth.text;
      judgeIn = synth.usage?.inputTokens ?? 0;
      judgeOut = synth.usage?.outputTokens ?? 0;
    }

    // 5b. Verification + one revision.
    let verification: { passed: boolean; revised: boolean } | undefined;
    if (tech.verify) {
      const v = await verifyAndRevise(messages, finalAnswer, judge, { maxTokens: synthMaxTokens, signal: opts.signal });
      if (v.revised) finalAnswer = v.answer;
      verification = { passed: v.passed, revised: v.revised };
      emit({ type: "verify", passed: v.passed, revised: v.revised });
    }

    // Emit the final answer once if it wasn't streamed live.
    if (!streamLive) emit({ type: "answer_token", token: finalAnswer });

    // 6. Usage + result
    const usage: FusionUsage = {
      inputTokens:
        panel.reduce((a, p) => a + (p.usage?.inputTokens ?? 0), 0) + judgeIn,
      outputTokens:
        panel.reduce((a, p) => a + (p.usage?.outputTokens ?? 0), 0) + judgeOut,
      estCostUsd: estimateCost(panel, judge, judgeOut, judgeIn, config),
    };

    // Subscription-mode calls report no real usage/cost: tokens are estimated
    // and cost is unmetered (flat plan), so zero the $ and flag it estimated.
    const usageBreakdown = [
      ...panel.map((p) => {
        const sub = authModeFor(p.provider, config) === "subscription";
        const inTok = p.usage?.inputTokens ?? 0;
        const outTok = p.usage?.outputTokens ?? 0;
        return {
          role: "panel" as const,
          modelId: p.modelId,
          provider: p.provider,
          inputTokens: inTok,
          outputTokens: outTok,
          costUsd: sub ? 0 : costOf(getModel(config, p.modelId), inTok, outTok),
          estimated: sub,
        };
      }),
      {
        role: "judge" as const,
        modelId: judge.id,
        provider: judge.provider,
        inputTokens: judgeIn,
        outputTokens: judgeOut,
        costUsd: authModeFor(judge.provider, config) === "subscription" ? 0 : costOf(judge, judgeIn, judgeOut),
        estimated: authModeFor(judge.provider, config) === "subscription",
      },
    ];

    const result: FusionResult = {
      id: randomUUID(),
      category,
      depth,
      prompt: messages,
      panel,
      analysis,
      finalAnswer,
      judgeModelId: judge.id,
      webSearch,
      createdAt: new Date().toISOString(),
      usage,
      usageBreakdown,
      techniques: tech,
      verification,
    };

    // 7. Learn
    if (store && !opts.noLearn) {
      try {
        store.recordRun(result);
      } catch {
        // never fail a run because persistence hiccupped
      }
    }

    emit({ type: "done", result });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({ type: "error", message });
    throw err;
  }
}

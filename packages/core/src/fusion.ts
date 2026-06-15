/** The fusion engine: classify → select panel → dispatch → judge → learn. */
import { randomUUID } from "node:crypto";
import type { FusionConfig } from "./config.js";
import { apiKeyFor, getModel, loadConfig } from "./config.js";
import { adjudicate } from "./adjudicate.js";
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

/** Model ids eligible for auto-selection that have a configured API key. */
export function availableAutoPanel(config: FusionConfig): string[] {
  return config.autoPanel.filter((id) => {
    const spec = getModel(config, id);
    return spec && !spec.excludeFromAuto && !!apiKeyFor(spec.provider);
  });
}

function estimateCost(panel: PanelResponse[], judge: ModelSpec, judgeOut: number, judgeIn: number, config: FusionConfig): number {
  let cost = 0;
  for (const p of panel) {
    const spec = getModel(config, p.modelId);
    if (!spec) continue;
    cost += ((p.usage?.inputTokens ?? 0) / 1e6) * (spec.costPer1MIn ?? 0);
    cost += ((p.usage?.outputTokens ?? 0) / 1e6) * (spec.costPer1MOut ?? 0);
  }
  cost += (judgeIn / 1e6) * (judge.costPer1MIn ?? 0);
  cost += (judgeOut / 1e6) * (judge.costPer1MOut ?? 0);
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
        return spec && !!apiKeyFor(spec.provider);
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

    // 3. Dispatch panel in parallel
    const panel: PanelResponse[] = await Promise.all(
      panelSpecs.map(async (spec) => {
        emit({ type: "panel_start", modelId: spec.id, label: spec.label });
        const provider = getProvider(spec.provider);
        const res = await provider.complete(spec.model, {
          messages,
          maxTokens: opts.maxTokens,
          webSearch: webSearch && (spec.webSearch ?? false),
          depth,
          signal: opts.signal,
          onToken: (t) => emit({ type: "panel_token", modelId: spec.id, token: t }),
        });
        const pr: PanelResponse = { ...res, modelId: spec.id, label: spec.label };
        emit({ type: "panel_done", response: pr });
        return pr;
      }),
    );

    // 4. Judge — phase A (influence-weighted analysis, informed by learned SME)
    const judge = resolveJudge(config, opts.judge);
    const priors = store
      ? store.subjectExpertise(panel.map((p) => p.modelId), category)
      : [];
    if (priors.length) emit({ type: "sme_priors", subject: category, priors });
    emit({ type: "judge_start", judgeModelId: judge.id });
    const analysis = await runJudgeAnalysis(judge, messages, panel, {
      subject: category,
      priors,
      signal: opts.signal,
    });
    emit({ type: "analysis", analysis });

    // 5. Judge — phase B (streamed synthesis)
    const synth = await runJudgeSynthesis(judge, messages, panel, analysis, {
      maxTokens: opts.maxTokens ? Math.max(opts.maxTokens, 4096) : 8192,
      signal: opts.signal,
      onToken: (t) => emit({ type: "answer_token", token: t }),
    });
    const finalAnswer = synth.text;

    // 6. Usage + result
    const judgeIn = synth.usage?.inputTokens ?? 0;
    const judgeOut = synth.usage?.outputTokens ?? 0;
    const usage: FusionUsage = {
      inputTokens:
        panel.reduce((a, p) => a + (p.usage?.inputTokens ?? 0), 0) + judgeIn,
      outputTokens:
        panel.reduce((a, p) => a + (p.usage?.outputTokens ?? 0), 0) + judgeOut,
      estCostUsd: estimateCost(panel, judge, judgeOut, judgeIn, config),
    };

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

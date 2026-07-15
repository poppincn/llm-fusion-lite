/** The fusion engine: classify → select panel → dispatch → judge → learn. */
import { randomUUID } from "node:crypto";
import type { FusionConfig } from "./config.js";
import { authModeFor, getModel, loadConfig, resolveTechniques } from "./config.js";
import { formatMissingCredentials, preflightCredentials } from "./credentials.js";
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
    // 0. Empty-prompt guard — never spend inference on a blank request. This is
    // the deterministic gate that keeps the adjudicator/panel from running on
    // whitespace and returning garbage or an opaque provider 4xx.
    const promptText = messages.map((m) => m.content).join("").trim();
    if (!promptText) {
      throw new Error("Empty prompt: provide a non-empty question or task before running fusion.");
    }

    // 0b. Credential preflight — verify credentials BEFORE any model call
    // (including the cheap adjudicator pre-pass). We never dispatch to a provider
    // that has no API key or an unauthenticated CLI.
    //
    // Agentic runs execute inside the sandbox container using ITS credentials
    // (passed at `sandbox/run.sh up`), not the host's API keys or CLI logins, so
    // host-side preflight doesn't apply — fall back to registry eligibility there.
    let readyIds: Set<string>;
    if (opts.agentic) {
      const eligible = availableAutoPanel(config);
      if (eligible.length === 0) {
        throw new Error("No models eligible for the agentic panel. Check the registry and that the sandbox is up.");
      }
      readyIds = new Set(eligible);
    } else {
      const preflight = await preflightCredentials(config, opts.panel, opts.signal);
      emit({
        type: "preflight",
        strict: preflight.strict,
        ready: preflight.ready.map((r) => r.modelId),
        missing: preflight.missing.map((m) => ({ modelId: m.modelId, reason: m.reason })),
      });
      if (!preflight.ok) {
        const detail = formatMissingCredentials(preflight.missing);
        throw new Error(
          preflight.strict
            ? `Missing credentials for selected panel model(s):\n${detail}\n\nConfigure them, or drop them from --panel.`
            : `No models have usable credentials. Configure at least one provider:\n${detail}\n\nRun \`fuse setup\` or \`fuse doctor\` for guidance.`,
        );
      }
      readyIds = new Set(preflight.ready.map((r) => r.modelId));
    }

    // 1. Adjudicate scope: subject + dynamic depth
    const adj = await adjudicate(messages, config, opts.signal);
    const category = opts.category ?? adj.subject;
    const depth = opts.depth ?? adj.depth;
    const tech = resolveTechniques(opts.techniques, depth, config);
    emit({ type: "category", category });
    emit({ type: "depth", depth, rationale: adj.rationale });

    // 2. Panel selection — restricted to models that passed credential preflight.
    let panelIds: string[];
    if (opts.panel && opts.panel.length) {
      // Explicit panel is strict: preflight already guaranteed every id is ready
      // (or threw). Filter defensively so we never dispatch an uncredentialed one.
      panelIds = opts.panel.filter((id) => readyIds.has(id));
      if (!panelIds.length) {
        throw new Error("Selected panel has no models with usable credentials.");
      }
    } else {
      // Adaptive: choose from the credentialed auto-panel subset only.
      const available = [...readyIds];
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

    // 2b. Resolve + credential-check the judge BEFORE dispatch, so synthesis
    // never dies on an unauthenticated judge. If the configured judge lacks
    // credentials, fall back to the first credentialed panelist.
    let judge = resolveJudge(config, opts.judge);
    if (!opts.agentic && !readyIds.has(judge.id)) {
      const jp = await preflightCredentials(config, [judge.id], opts.signal);
      if (!jp.ok) {
        const fallback = panelSpecs[0];
        if (!fallback) {
          throw new Error(
            `Judge "${judge.id}" lacks usable credentials and no credentialed panelist is available to substitute.`,
          );
        }
        emit({
          type: "preflight",
          strict: true,
          ready: [fallback.id],
          missing: [{ modelId: judge.id, reason: `${jp.missing[0]?.reason ?? "no credentials"} — falling back to ${fallback.id} as judge` }],
        });
        judge = fallback;
      }
    }

    // 3. Dispatch panel in parallel (optionally asking for self-confidence).
    // In agentic mode, nudge panelists to actually USE their tools — models
    // otherwise reason quantitative/factual steps in their head and get them
    // wrong (observed on GPQA-D calc items even with bash available).
    const extraSys: ChatMessage[] = [];
    if (opts.agentic) {
      extraSys.push({
        role: "system",
        content:
          "You are running as an agent in a sandbox with a shell. Ground EVERY claim with these preinstalled tools instead of relying on memory or mental math:\n" +
          "- `python3` (numpy, scipy, sympy, mpmath) — compute any arithmetic/formula/unit-or-log conversion EXACTLY; never do multi-digit math in your head.\n" +
          "- `websearch \"<query>\"` — web search for facts or current information.\n" +
          "- `fetchurl <url>` — fetch a page's readable text to confirm a source.\n" +
          "Actually run them. Only commit to a final answer after verifying its key quantitative and factual steps with a tool.",
      });
    }
    if (tech.confidence) {
      extraSys.push({
        role: "system",
        content: 'End your answer with a final line exactly like "Confidence: 75%" — your calibrated confidence that it is correct.',
      });
    }
    const panelMessages = extraSys.length ? [...messages, ...extraSys] : messages;
    let panel: PanelResponse[] = await Promise.all(
      panelSpecs.map(async (spec) => {
        emit({ type: "panel_start", modelId: spec.id, label: spec.label });
        const provider = getProvider(spec.provider);
        const res = await provider.complete(spec.model, {
          messages: panelMessages,
          maxTokens: opts.maxTokens,
          webSearch: webSearch && (spec.webSearch ?? false),
          depth,
          agentic: opts.agentic,
          reasoningEffort: spec.reasoningEffort,
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
      agentic: opts.agentic,
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
          runJudgeSynthesis(judge, messages, panel, analysis, { maxTokens: synthMaxTokens, agentic: opts.agentic, signal: opts.signal }),
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
        agentic: opts.agentic,
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
      const v = await verifyAndRevise(messages, finalAnswer, judge, {
        depth,
        webSearch,
        // Subscription CLIs ignore depth/tool flags, so only promise hosted
        // tool use to the verifier when the judge runs in api mode.
        tools: authModeFor(judge.provider, config) === "api",
        maxTokens: synthMaxTokens,
        signal: opts.signal,
      });
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

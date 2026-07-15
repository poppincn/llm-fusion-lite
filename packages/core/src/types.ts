/** Shared message + provider + fusion types for the Era Fusion engine. */

export type Role = "system" | "user" | "assistant";

export interface ChatMessage {
  role: Role;
  content: string;
}

export type ProviderName = "anthropic" | "openai" | "google" | "openai-compatible";

/**
 * How a provider authenticates and is invoked:
 *  - api          : the provider's official SDK with an API key (default).
 *  - subscription : the provider's CLI (claude / codex / gemini) run as a
 *                   subprocess, using the user's logged-in Pro/Max plan — no
 *                   API key. CLI calls report no token usage (cost shows $0).
 */
export type ProviderAuthMode = "api" | "subscription";

/**
 * How deeply each panelist runs, chosen per-request by the adjudicator:
 *  - light    : single completion, no tools
 *  - standard : single completion + native web search
 *  - deep     : agentic loop with hosted tools (web search + web fetch +
 *               server-side code execution where available)
 */
export type Depth = "light" | "standard" | "deep";

/** A panelist/judge model the engine can call, as declared in config. */
export interface ModelSpec {
  /** Stable id used everywhere (panel config, store keys). */
  id: string;
  provider: ProviderName;
  /** Provider-native model string passed to the SDK. */
  model: string;
  /** Human-friendly label for UIs. */
  label: string;
  /** Whether to request the provider's native web search/grounding. */
  webSearch?: boolean;
  /** Optional cost metadata (USD per 1M tokens) for reporting. */
  costPer1MIn?: number;
  costPer1MOut?: number;
  /** Exclude from default adaptive panel selection (still callable explicitly). */
  excludeFromAuto?: boolean;
  /**
   * For provider "openai-compatible" only: the OpenAI-compatible Chat Completions
   * base URL (e.g. Baseten/OpenRouter/vLLM). Lets you add models like GLM 5.2 or
   * Minimax M3 without a bespoke provider.
   */
  baseURL?: string;
  /**
   * For provider "openai-compatible": the env var holding this endpoint's API key
   * (default "BASETEN_API_KEY"). Per-model so several endpoints can coexist.
   */
  apiKeyEnv?: string;
}

export interface Citation {
  url: string;
  title?: string;
}

export interface CompletionOptions {
  messages: ChatMessage[];
  maxTokens?: number;
  webSearch?: boolean;
  /**
   * Depth tier. Providers map this to their tool set + budget:
   * light = no tools; standard = web search; deep = agentic loop with
   * web search + web fetch + (where available) server-side code execution.
   */
  depth?: Depth;
  signal?: AbortSignal;
  /** Streaming token callback (best-effort; not every provider streams every block). */
  onToken?: (token: string) => void;
  /**
   * Run this call as a full tool-using AGENT inside the disposable sandbox
   * container (bash/file/code-exec/web via the provider's CLI), instead of a
   * plain completion. Only the CLI-backed providers support it. See
   * docs/AGENTIC_FUSION.md.
   */
  agentic?: boolean;
}

/**
 * Optional fusion techniques layered on top of the base fan-out → synthesize
 * pipeline. Each is independently toggleable; depth tiers pick sensible presets.
 */
export interface TechniqueConfig {
  /** Mixture-of-Agents: rounds where panelists see peers' answers and revise. */
  refineRounds: number;
  /** Refine rounds explicitly resolve detected disagreements (debate flavor). */
  debate: boolean;
  /** Pairwise-rank candidates to weight the judge instead of one-pass scoring. */
  pairwiseRank: boolean;
  /** Panelists emit a self-confidence the judge factors in. */
  confidence: boolean;
  /** Sample the synthesis N times and pick the most consistent (1 = off). */
  selfConsistency: number;
  /** Verify the synthesized answer and revise once if it fails. */
  verify: boolean;
}

export interface CompletionResult {
  text: string;
  /** provider-native model string actually used */
  model: string;
  provider: ProviderName;
  usage?: { inputTokens?: number; outputTokens?: number };
  citations?: Citation[];
  latencyMs: number;
  /** Set when the call failed; text will be empty. */
  error?: string;
  /**
   * Coarse failure classification, set only when `error` is present.
   *  - auth        : the provider/CLI is unauthenticated (missing key or login).
   *  - timeout     : the call exceeded its time budget.
   *  - unavailable : the provider/CLI/binary could not be reached at all.
   *  - other       : any other runtime failure.
   * `auth` failures are non-retryable and surface as a clear "skipped —
   * unauthenticated" warning rather than a silent empty answer.
   */
  errorKind?: "auth" | "timeout" | "unavailable" | "other";
  /** Tools the agent invoked, when run in agentic mode (e.g. [{name:"Bash"}]). */
  toolCalls?: { name: string }[];
  /** Provider-reported real USD cost for this call, when available (e.g. agentic Claude). */
  costUsd?: number;
}

export interface Provider {
  name: ProviderName;
  supportsWebSearch: boolean;
  /** True if the provider has a usable API key configured. */
  isConfigured(): boolean;
  complete(modelString: string, opts: CompletionOptions): Promise<CompletionResult>;
}

/** A single panelist's response, tagged with its config id. */
export interface PanelResponse extends CompletionResult {
  modelId: string;
  label: string;
  /** Self-reported confidence 0..1, when the confidence technique is on. */
  confidence?: number;
  /** True if this answer came out of a MoA refinement round. */
  refined?: boolean;
}

/** Structured comparative analysis produced by the judge (phase A). */
export interface JudgeAnalysis {
  consensus: string[];
  contradictions: string[];
  gaps: string[];
  uniqueInsights: { modelId: string; insight: string }[];
  /**
   * Per-panelist contribution credit in [0,1]: how much this model's response
   * advanced the final answer (accuracy, unique insight, coverage). Feeds the
   * adaptive store.
   */
  contributions: { modelId: string; score: number; reason: string }[];
  /** One-line note on overall panel agreement, for UIs. */
  summary: string;
}

export interface FusionUsage {
  inputTokens: number;
  outputTokens: number;
  /** Rough USD estimate when cost metadata is available. */
  estCostUsd?: number;
}

/** Per-call usage line (one per panelist + one for the judge), for accounting. */
export interface UsageRow {
  role: "panel" | "judge";
  modelId: string;
  provider: ProviderName;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Tokens are estimated (subscription CLIs report none) and cost is unmetered. */
  estimated?: boolean;
}

export interface FusionResult {
  id: string;
  /** Subject/category the adjudicator assigned (drives per-subject SME). */
  category: string;
  /** Depth tier the adjudicator chose for this run. */
  depth: Depth;
  prompt: ChatMessage[];
  panel: PanelResponse[];
  analysis: JudgeAnalysis;
  finalAnswer: string;
  judgeModelId: string;
  webSearch: boolean;
  createdAt: string;
  usage: FusionUsage;
  /** Per-call usage breakdown (panelists + judge) for the usage dashboard. */
  usageBreakdown: UsageRow[];
  /** Which optional techniques ran for this fusion. */
  techniques: TechniqueConfig;
  /** Verification outcome, when the verify technique ran. */
  verification?: { passed: boolean; revised: boolean };
}

/** Progress events emitted during a fusion run (for CLI/web streaming). */
export type FusionEvent =
  | {
      /** Credential preflight verdict, emitted before any model call. */
      type: "preflight";
      /** Explicit panel (strict) vs adaptive (best-effort) selection. */
      strict: boolean;
      /** Model ids with usable credentials that the run will use. */
      ready: string[];
      /** Model ids skipped for missing/unauthenticated credentials, with reason. */
      missing: { modelId: string; reason?: string }[];
    }
  | { type: "category"; category: string }
  | { type: "depth"; depth: Depth; rationale: string }
  | {
      type: "sme_priors";
      subject: string;
      priors: { modelId: string; score: number; runs: number }[];
    }
  | { type: "panel_selected"; panel: { id: string; label: string }[] }
  | { type: "panel_start"; modelId: string; label: string }
  | { type: "panel_token"; modelId: string; token: string }
  | { type: "panel_done"; response: PanelResponse }
  | { type: "refine_round"; round: number; total: number }
  | { type: "rank"; weights: { modelId: string; weight: number }[] }
  | { type: "judge_start"; judgeModelId: string }
  | { type: "analysis"; analysis: JudgeAnalysis }
  | { type: "self_consistency"; samples: number }
  | { type: "verify"; passed: boolean; revised: boolean }
  | { type: "answer_token"; token: string }
  | { type: "done"; result: FusionResult }
  | { type: "error"; message: string };

export interface FuseOptions {
  prompt: string | ChatMessage[];
  /** Explicit panel of model ids. Defaults to adaptive selection. */
  panel?: string[];
  /** Number of panelists when auto-selecting. */
  panelSize?: number;
  /** Judge model id. Defaults to config.defaultJudge. */
  judge?: string;
  /** Request native web search where supported. Defaults to config.webSearch. */
  webSearch?: boolean;
  /** Override category classification. */
  category?: string;
  /** Override the adjudicated depth tier. */
  depth?: Depth;
  /** Override which optional techniques run (else derived from depth/config). */
  techniques?: Partial<TechniqueConfig>;
  maxTokens?: number;
  onEvent?: (event: FusionEvent) => void;
  signal?: AbortSignal;
  /** Skip writing to the adaptive store (e.g. for transient evals). */
  noLearn?: boolean;
  /**
   * Run panelists as tool-using agents in the sandbox container (see
   * docs/AGENTIC_FUSION.md). CLI-backed providers only; others fall back to a
   * normal completion.
   */
  agentic?: boolean;
}

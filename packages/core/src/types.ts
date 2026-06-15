/** Shared message + provider + fusion types for the Era Fusion engine. */

export type Role = "system" | "user" | "assistant";

export interface ChatMessage {
  role: Role;
  content: string;
}

export type ProviderName = "anthropic" | "openai" | "google";

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
}

/** Progress events emitted during a fusion run (for CLI/web streaming). */
export type FusionEvent =
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
  | { type: "judge_start"; judgeModelId: string }
  | { type: "analysis"; analysis: JudgeAnalysis }
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
  maxTokens?: number;
  onEvent?: (event: FusionEvent) => void;
  signal?: AbortSignal;
  /** Skip writing to the adaptive store (e.g. for transient evals). */
  noLearn?: boolean;
}

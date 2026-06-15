// Shared domain types for the Era Fusion web UI.

export type Role = "user" | "assistant" | "system";

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface Citation {
  url: string;
  title?: string;
}

export interface PanelResponse {
  modelId: string;
  label: string;
  text: string;
  provider: string;
  latencyMs: number;
  error?: string;
  citations?: Citation[];
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

export interface UniqueInsight {
  modelId: string;
  insight: string;
}

export interface Contribution {
  modelId: string;
  score: number;
  reason: string;
}

export interface JudgeAnalysis {
  summary: string;
  consensus: string[];
  contradictions: string[];
  gaps: string[];
  uniqueInsights: UniqueInsight[];
  contributions: Contribution[];
}

export interface FusionUsage {
  inputTokens: number;
  outputTokens: number;
  estCostUsd?: number;
}

export interface FusionResult {
  id: string;
  category: string;
  finalAnswer: string;
  judgeModelId: string;
  webSearch: boolean;
  createdAt: string;
  panel: PanelResponse[];
  analysis: JudgeAnalysis;
  usage: FusionUsage;
}

export interface PanelMember {
  id: string;
  label: string;
}

// --- SSE event discriminated union ---

export interface CategoryEvent {
  type: "category";
  category: string;
}

export interface PanelSelectedEvent {
  type: "panel_selected";
  panel: PanelMember[];
}

export interface PanelStartEvent {
  type: "panel_start";
  modelId: string;
  label: string;
}

export interface PanelTokenEvent {
  type: "panel_token";
  modelId: string;
  token: string;
}

export interface PanelDoneEvent {
  type: "panel_done";
  response: PanelResponse;
}

export interface JudgeStartEvent {
  type: "judge_start";
  judgeModelId: string;
}

export interface AnalysisEvent {
  type: "analysis";
  analysis: JudgeAnalysis;
}

export interface AnswerTokenEvent {
  type: "answer_token";
  token: string;
}

export interface DoneEvent {
  type: "done";
  result: FusionResult;
}

export interface ErrorEvent {
  type: "error";
  message: string;
}

export type FusionEvent =
  | CategoryEvent
  | PanelSelectedEvent
  | PanelStartEvent
  | PanelTokenEvent
  | PanelDoneEvent
  | JudgeStartEvent
  | AnalysisEvent
  | AnswerTokenEvent
  | DoneEvent
  | ErrorEvent;

// --- Request body for /api/fuse ---

export interface FuseRequest {
  prompt?: string;
  messages?: ChatMessage[];
  panel?: string[];
  judge?: string;
  panel_size?: number;
  web_search?: boolean;
}

// --- /api/config ---

export type ProviderName = "anthropic" | "openai" | "google";

export interface ConfigModel {
  id: string;
  provider: string;
  model?: string;
  label: string;
  webSearch?: boolean;
  costPer1MIn?: number;
  costPer1MOut?: number;
  excludeFromAuto?: boolean;
}

export interface FusionConfig {
  models: ConfigModel[];
  autoPanel: string[];
  available: string[];
  defaultJudge: string;
  classifierModel: string;
  categories: string[];
  panelSize: number;
  webSearch: boolean;
  explorationRate: number;
  providers: string[];
}

/** Partial config accepted by PUT /api/config. */
export interface ConfigUpdate {
  models?: ConfigModel[];
  autoPanel?: string[];
  defaultJudge?: string;
  classifierModel?: string;
  panelSize?: number;
  webSearch?: boolean;
  explorationRate?: number;
  categories?: string[];
}

// --- /api/usage ---

export interface UsageTotals {
  runs: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface UsageByProvider {
  provider: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface UsageByModel {
  modelId: string;
  provider: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface Usage {
  totals: UsageTotals;
  byProvider: UsageByProvider[];
  byModel: UsageByModel[];
}

// --- /api/strengths ---

export interface ModelStrength {
  modelId: string;
  category: string;
  score: number;
  avgContribution: number;
  feedbackScore: number;
  runs: number;
  feedbackCount: number;
}

// --- /api/runs ---

export interface RunSummary {
  id: string;
  category: string;
  judge_model: string;
  created_at: string;
}

export type Rating = 1 | -1;

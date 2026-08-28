// Shared domain types for the LLM Fusion Lite web UI.

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
    usage?: { inputTokens?: number; outputTokens?: number };
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

export type ProviderName = "anthropic" | "openai" | "google" | "openai-compatible";

export interface ProviderDef {
    id: string;
    name: string;
    adapter: ProviderName;
    baseURL?: string;
    apiKeyHeader?: string;
    headers?: Record<string, string>;
    extraParams?: Record<string, unknown>;
    /** Server-computed: the instance's key env var is set. */
    keySet?: boolean;
}

export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ConfigModel {
    id: string;
    provider: string;
    providerId?: string;
    model?: string;
    label: string;
    webSearch?: boolean;
    costPer1MIn?: number;
    costPer1MOut?: number;
    excludeFromAuto?: boolean;
    reasoningEffort?: ReasoningEffort;
    baseURL?: string;
    apiKeyHeader?: string;
    headers?: Record<string, string>;
    extraParams?: Record<string, unknown>;
}

export interface GatewayConfig {
    /** Effective public OpenAI-compatible base URL. */
    baseURL: string;
    /** True when baseURL is inferred from the current browser origin. */
    baseURLAuto: boolean;
    model: string;
    apiKeySet: boolean;
    apiKeyHint?: string;
}

export interface GatewayUpdate {
    /** Empty resets the public URL to automatic detection. */
    baseURL?: string;
    model?: string;
    /** Empty disables gateway authentication. */
    apiKey?: string;
}

export interface FusionConfig {
    gateway: GatewayConfig;
    providers: ProviderDef[];
    models: ConfigModel[];
    autoPanel: string[];
    available: string[];
    defaultJudge: string;
    classifierModel: string;
    categories: string[];
    panelSize: number;
    webSearch: boolean;
    explorationRate: number;
    providersConfigured: string[];
}

/** Partial config accepted by PUT /api/config. */
export interface ConfigUpdate {
    gateway?: GatewayUpdate;
    providers?: ProviderDef[];
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
    estimated?: boolean;
}

export interface UsageByProvider {
    provider: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    estimated?: boolean;
}

export interface UsageByModel {
    modelId: string;
    provider: string;
    calls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    estimated?: boolean;
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

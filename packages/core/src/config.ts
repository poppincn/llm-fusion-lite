/** Configuration loading: model registry, defaults, paths, API keys. */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type {
    Depth,
    GatewayConfig,
    ModelSpec,
    ProviderAuthMode,
    ProviderDef,
    ProviderName,
    TechniqueConfig
} from "./types.js";

/** Base pipeline only: fan-out → synthesize. No extra techniques. */
export const TECHNIQUES_OFF: TechniqueConfig = {
    refineRounds: 0,
    debate: false,
    pairwiseRank: false,
    confidence: false,
    selfConsistency: 1,
    verify: false
};

/** Everything on — used for the `deep` tier and the benchmark's max-quality run. */
export const TECHNIQUES_DEEP: TechniqueConfig = {
    refineRounds: 1,
    debate: true,
    pairwiseRank: true,
    confidence: true,
    selfConsistency: 2,
    verify: true
};

export interface FusionConfig {
    /** All models the engine knows about. */
    models: ModelSpec[];
    /** Model ids eligible for adaptive auto-panel selection. */
    autoPanel: string[];
    /** Default judge/synthesizer model id. */
    defaultJudge: string;
    /** Model id used for cheap prompt categorization. */
    classifierModel: string;
    /** Default panel size when auto-selecting. */
    panelSize: number;
    /** Request native web search by default. */
    webSearch: boolean;
    /** ε for ε-greedy exploration in panel selection (0..1). */
    explorationRate: number;
    /** Category taxonomy used by the classifier. */
    categories: string[];
    /**
     * Per-provider auth mode. Absent provider ⇒ "api" (SDK + key). Set a provider
     * to "subscription" to call its CLI (claude / codex / gemini) instead.
     */
    providerAuth?: Partial<Record<ProviderName, ProviderAuthMode>>;
    /**
     * User-defined provider instances (one per backend + extras). When absent,
     * one default instance per built-in adapter is synthesized at load.
     */
    providers?: ProviderDef[];
    /** OpenAI-compatible gateway exposed to external agents. */
    gateway?: GatewayConfig;
    /** Default optional techniques (when depth doesn't dictate otherwise). */
    techniques?: TechniqueConfig;
}

/**
 * Resolve effective techniques: explicit override wins; else `deep` depth turns
 * everything on; else the config default (or off).
 */
export function resolveTechniques(
    override: Partial<TechniqueConfig> | undefined,
    depth: Depth,
    config: FusionConfig
): TechniqueConfig {
    const base: TechniqueConfig = depth === "deep" ? TECHNIQUES_DEEP : (config.techniques ?? TECHNIQUES_OFF);
    return override ? { ...base, ...override } : base;
}

export const DEFAULT_CATEGORIES = [
    "coding",
    "math",
    "reasoning",
    "research",
    "factual",
    "writing",
    "creative",
    "analysis",
    "other"
];

/** One default provider instance per built-in adapter. */
export const DEFAULT_PROVIDERS: ProviderDef[] = [
    { id: "anthropic", name: "Anthropic", adapter: "anthropic" },
    { id: "openai", name: "OpenAI", adapter: "openai" },
    { id: "google", name: "Google", adapter: "google" },
    { id: "custom", name: "Custom (ChatCompletion)", adapter: "openai-compatible", apiKeyEnv: "BASETEN_API_KEY" }
];

export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = { baseURL: "", model: "fusion" };

/**
 * Default registry. Anthropic models work with just ANTHROPIC_API_KEY.
 * OpenAI/Google entries activate when their keys are present — edit the
 * `model` strings in your config.json to match models you have access to.
 */
export const DEFAULT_MODELS: ModelSpec[] = [
    {
        id: "claude-fable-5",
        provider: "anthropic",
        model: "claude-fable-5",
        label: "Claude Fable 5",
        webSearch: true,
        costPer1MIn: 10,
        costPer1MOut: 50
        // Anthropic's most capable model. Thinking is always on; depth is controlled
        // via reasoningEffort (output_config.effort). Defaults to "high".
    },
    {
        id: "claude-opus-4-8",
        provider: "anthropic",
        model: "claude-opus-4-8",
        label: "Claude Opus 4.8",
        webSearch: true,
        costPer1MIn: 5,
        costPer1MOut: 25
    },
    {
        id: "claude-sonnet-4-6",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
        webSearch: true,
        costPer1MIn: 3,
        costPer1MOut: 15
    },
    {
        id: "claude-haiku-4-5",
        provider: "anthropic",
        model: "claude-haiku-4-5",
        label: "Claude Haiku 4.5",
        webSearch: false,
        costPer1MIn: 1,
        costPer1MOut: 5
        // used as the classifier; usable as a panelist too
    },
    {
        id: "gpt-5.6-sol",
        provider: "openai",
        model: "gpt-5.6-sol",
        label: "GPT-5.6 (Sol)",
        webSearch: true
        // OpenAI's GPT-5.6 "Sol" — frontier tier of the sol/terra/luna family.
        // Reasoning effort → reasoning.effort.
    },
    { id: "gpt-5.5", provider: "openai", model: "gpt-5.5", label: "GPT-5.5", webSearch: true },
    // Default to broadly-available GA Gemini IDs (gemini-3-* 404 on standard keys).
    // Bump `model` to a gemini-3 string if your key has access. Run `fuse doctor --probe`
    // to verify a model actually answers before relying on it.
    { id: "gemini-2.5-pro", provider: "google", model: "gemini-2.5-pro", label: "Gemini 2.5 Pro", webSearch: true },
    {
        id: "gemini-3.5-flash",
        provider: "google",
        model: "gemini-3.5-flash",
        label: "Gemini 3.5 Flash",
        webSearch: true
    }
];

export const DEFAULT_CONFIG: FusionConfig = {
    models: DEFAULT_MODELS,
    autoPanel: [
        "claude-fable-5",
        "claude-opus-4-8",
        "claude-sonnet-4-6",
        "gpt-5.6-sol",
        "gpt-5.5",
        "gemini-2.5-pro",
        "gemini-3.5-flash"
    ],
    defaultJudge: "claude-opus-4-8",
    classifierModel: "claude-haiku-4-5",
    panelSize: 3,
    webSearch: true,
    explorationRate: 0.15,
    categories: DEFAULT_CATEGORIES,
    providerAuth: {},
    providers: DEFAULT_PROVIDERS,
    gateway: DEFAULT_GATEWAY_CONFIG
};

export function fusionHome(): string {
    const env = process.env.LLM_FUSION_LITE_HOME;
    if (env) return resolve(env.replace(/^~(?=$|\/)/, homedir()));
    return join(homedir(), ".llm-fusion-lite");
}

export function configPath(): string {
    return join(fusionHome(), "config.json");
}

export function dbPath(): string {
    return join(fusionHome(), "fusion.db");
}

function ensureHome(): void {
    const home = fusionHome();
    if (!existsSync(home)) mkdirSync(home, { recursive: true });
}

let cached: FusionConfig | null = null;

/** Load config from disk (creating a default file on first run), merged with defaults. */
export function loadConfig(force = false): FusionConfig {
    if (cached && !force) return cached;
    ensureHome();
    const path = configPath();
    if (!existsSync(path)) {
        writeFileSync(path, JSON.stringify(DEFAULT_CONFIG, null, 2));
        cached = structuredClone(DEFAULT_CONFIG);
        return cached;
    }
    try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<FusionConfig>;
        const merged: FusionConfig = {
            ...DEFAULT_CONFIG,
            ...raw,
            gateway: { ...DEFAULT_GATEWAY_CONFIG, ...(raw.gateway ?? {}) }
        };
        if (!raw.models) merged.models = DEFAULT_MODELS;
        // Legacy configs predate provider instances — synthesize defaults only
        // when the field is ABSENT. An explicit empty array is user intent
        // (all providers deleted) and must be preserved.
        if (raw.providers === undefined) merged.providers = defaultProvidersFor(merged);
        cached = materializeConfig(merged);
        return cached;
    } catch {
        cached = structuredClone(DEFAULT_CONFIG);
        return cached;
    }
}

/**
 * One default instance per built-in adapter, inheriting endpoint config from
 * legacy openai-compatible models that carry it directly on the model spec.
 */
export function defaultProvidersFor(config: FusionConfig): ProviderDef[] {
    const customModel = config.models.find(m => m.provider === "openai-compatible");
    return [
        { id: "anthropic", name: "Anthropic", adapter: "anthropic" },
        { id: "openai", name: "OpenAI", adapter: "openai" },
        { id: "google", name: "Google", adapter: "google" },
        {
            id: "custom",
            name: "Custom (ChatCompletion)",
            adapter: "openai-compatible",
            apiKeyEnv: customModel?.apiKeyEnv ?? "BASETEN_API_KEY",
            baseURL: customModel?.baseURL,
            apiKeyHeader: customModel?.apiKeyHeader,
            headers: customModel?.headers,
            extraParams: customModel?.extraParams
        }
    ];
}

/**
 * Merge provider-instance config onto models: every model gets its provider's
 * endpoint/credential fields (model-level values act as fallbacks) and the
 * provider's adapter. An empty providers list is preserved (deleted on
 * purpose); legacy-config synthesis happens in loadConfig. Pure — for tests.
 */
export function materializeConfig(config: FusionConfig): FusionConfig {
    const providers = config.providers ?? [];
    const byId = new Map(providers.map(p => [p.id, p]));
    const byAdapter = (adapter: ProviderName) => providers.find(p => p.adapter === adapter);

    const models = config.models.map(m => {
        const label = m.label?.trim() || m.model?.trim() || m.id;
        const def = (m.providerId && byId.get(m.providerId)) || byAdapter(m.provider);
        if (!def) return { ...m, label };
        return {
            ...m,
            label,
            provider: def.adapter,
            providerId: m.providerId ?? def.id,
            baseURL: def.baseURL ?? m.baseURL,
            apiKeyEnv: def.apiKeyEnv ?? m.apiKeyEnv,
            apiKeyHeader: def.apiKeyHeader ?? m.apiKeyHeader,
            headers: def.headers ?? m.headers,
            extraParams: def.extraParams ?? m.extraParams
        };
    });
    const modelIds = new Set(models.map(model => model.id));
    const fallbackModelId = models[0]?.id ?? "";
    const defaultJudge = modelIds.has(config.defaultJudge) ? config.defaultJudge : fallbackModelId;
    const classifierModel = modelIds.has(config.classifierModel) ? config.classifierModel : defaultJudge;
    return { ...config, providers, models, defaultJudge, classifierModel };
}

export function saveConfig(config: FusionConfig): void {
    ensureHome();
    const materialized = materializeConfig(config);
    writeFileSync(configPath(), JSON.stringify(materialized, null, 2));
    cached = materialized;
}

export function getModel(config: FusionConfig, id: string): ModelSpec | undefined {
    return config.models.find(m => m.id === id);
}

export function apiKeyFor(provider: ProviderName): string | undefined {
    switch (provider) {
        case "anthropic":
            return process.env.ANTHROPIC_API_KEY;
        case "openai":
            return process.env.OPENAI_API_KEY;
        case "google":
            return process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
        case "openai-compatible":
            // Per-model key (via ModelSpec.apiKeyEnv); BASETEN_API_KEY is the default.
            return process.env.BASETEN_API_KEY;
    }
}

/** API key for a specific model spec (per-model env for openai-compatible). */
export function apiKeyForModel(spec?: ModelSpec): string | undefined {
    if (!spec) return undefined;
    if (spec.apiKeyEnv) return process.env[spec.apiKeyEnv];
    if (spec.provider === "openai-compatible") return process.env.BASETEN_API_KEY;
    return apiKeyFor(spec.provider);
}

/** Resolve a provider's auth mode (defaults to "api" when unset). */
export function authModeFor(provider: ProviderName, config?: FusionConfig): ProviderAuthMode {
    return (config ?? loadConfig()).providerAuth?.[provider] ?? "api";
}

/** Persist a provider's auth mode to config.json. */
export function setProviderAuthMode(provider: ProviderName, mode: ProviderAuthMode): void {
    const config = loadConfig();
    const providerAuth = { ...(config.providerAuth ?? {}), [provider]: mode };
    saveConfig({ ...config, providerAuth });
}

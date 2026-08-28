import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import {
    fuse,
    loadConfig,
    saveConfig,
    writeEnvVar,
    FusionStore,
    availableAutoPanel,
    configuredProviders,
    DEFAULT_GATEWAY_CONFIG,
    type ChatMessage,
    type FusionConfig,
    type FusionEvent,
    type FusionResult,
    type ModelSpec,
    type ProviderDef,
    type ProviderName
} from "@llm-fusion-lite/core";

export interface AppOptions {
    store?: FusionStore;
    /** Absolute path to the built web UI (index.html + assets). */
    publicDir?: string;
}

interface OpenAIMessage {
    role: string;
    content: string | Array<{ type?: string; text?: string }>;
}

interface GatewayUpdate {
    baseURL?: string;
    model?: string;
    apiKey?: string;
}

type ConfigUpdateBody = Omit<Partial<FusionConfig>, "gateway"> & { gateway?: GatewayUpdate };

function normalizeMessages(messages: OpenAIMessage[]): ChatMessage[] {
    return messages.map(m => {
        let content = "";
        if (typeof m.content === "string") content = m.content;
        else if (Array.isArray(m.content)) content = m.content.map(p => p.text ?? "").join("");
        const role =
            m.role === "assistant" ? "assistant"
            : m.role === "system" || m.role === "developer" ? "system"
            : "user";
        return { role, content } as ChatMessage;
    });
}

/** Ordered SSE writer: serializes writes so token order is preserved. */
function orderedWriter(stream: { writeSSE: (m: { data: string; event?: string }) => Promise<void> }) {
    let chain: Promise<void> = Promise.resolve();
    return {
        write(data: string, event?: string) {
            chain = chain.then(() => stream.writeSSE({ data, event }));
        },
        flush() {
            return chain;
        }
    };
}

export function createApp(opts: AppOptions = {}): Hono {
    const app = new Hono();
    const store = opts.store ?? new FusionStore();
    app.use("/api/*", cors());
    app.use("/v1/*", cors({ allowHeaders: ["Content-Type", "Authorization", "X-API-Key"] }));
    app.use("/v1/*", async (c, next) => {
        if (c.req.method === "OPTIONS") return next();
        const apiKeyHash = loadConfig().gateway?.apiKeyHash;
        if (!apiKeyHash) return next();
        const apiKey = requestApiKey(c.req.header("Authorization"), c.req.header("X-API-Key"));
        if (apiKey && verifyGatewayApiKey(apiKey, apiKeyHash)) return next();
        c.header("WWW-Authenticate", 'Bearer realm="LLM Fusion Lite"');
        return c.json(
            { error: { message: "Invalid or missing API key", type: "authentication_error", code: "invalid_api_key" } },
            401
        );
    });

    function configResponse(requestURL: string) {
        const config = loadConfig();
        // Provider instances own endpoint/credential config — strip those fields
        // from models (the engine re-merges them at load) so the dashboard edits
        // them in one place.
        const models = config.models.map(m =>
            m.providerId ?
                {
                    ...m,
                    baseURL: undefined,
                    apiKeyEnv: undefined,
                    apiKeyHeader: undefined,
                    headers: undefined,
                    extraParams: undefined
                }
            :   m
        );
        return {
            gateway: publicGatewayConfig(config, requestURL),
            providers: (config.providers ?? []).map(p => ({
                id: p.id,
                name: p.name,
                adapter: p.adapter,
                baseURL: p.baseURL,
                apiKeyHeader: p.apiKeyHeader,
                headers: p.headers,
                extraParams: p.extraParams,
                keySet: !!process.env[p.apiKeyEnv ?? DEFAULT_KEY_ENV[p.adapter]]
            })),
            models,
            autoPanel: config.autoPanel,
            available: availableAutoPanel(config),
            defaultJudge: config.defaultJudge,
            classifierModel: config.classifierModel,
            categories: config.categories,
            panelSize: config.panelSize,
            webSearch: config.webSearch,
            explorationRate: config.explorationRate,
            providersConfigured: configuredProviders()
        };
    }

    app.get("/health", c =>
        c.json({ ok: true, providers: configuredProviders(), panel: availableAutoPanel(loadConfig()) })
    );

    // --- OpenAI-compatible model list ---
    app.get("/v1/models", c => {
        const config = loadConfig();
        const model = config.gateway?.model || DEFAULT_GATEWAY_CONFIG.model;
        const data = [{ id: model, object: "model", owned_by: "llm-fusion-lite" }];
        return c.json({ object: "list", data });
    });

    // --- OpenAI-compatible chat completions (fusion under the hood) ---
    app.post("/v1/chat/completions", async c => {
        const body = await c.req.json<{
            model?: string;
            messages: OpenAIMessage[];
            stream?: boolean;
            panel?: string[];
            judge?: string;
            panel_size?: number;
            web_search?: boolean;
        }>();
        const gatewayModel = loadConfig().gateway?.model || DEFAULT_GATEWAY_CONFIG.model;
        const modelName = body.model || gatewayModel;
        if (modelName !== gatewayModel) {
            return c.json(
                {
                    error: {
                        message: `The model '${modelName}' does not exist`,
                        type: "invalid_request_error",
                        code: "model_not_found"
                    }
                },
                404
            );
        }
        const messages = normalizeMessages(body.messages ?? []);
        const created = Math.floor(Date.now() / 1000);

        const fuseOpts = {
            prompt: messages,
            panel: body.panel,
            judge: body.judge,
            panelSize: body.panel_size,
            webSearch: body.web_search
        };

        if (body.stream) {
            return streamSSE(c, async stream => {
                const w = orderedWriter(stream);
                let id = "chatcmpl-pending";
                let started = false;
                try {
                    await fuse(
                        {
                            ...fuseOpts,
                            onEvent: (e: FusionEvent) => {
                                if (e.type === "done") id = e.result.id;
                                if (e.type === "answer_token") {
                                    if (!started) {
                                        started = true;
                                        w.write(JSON.stringify(chunk(id, created, modelName, { role: "assistant" })));
                                    }
                                    w.write(JSON.stringify(chunk(id, created, modelName, { content: e.token })));
                                }
                            }
                        },
                        { store }
                    );
                    w.write(JSON.stringify(chunk(id, created, modelName, {}, "stop")));
                    w.write("[DONE]");
                    await w.flush();
                } catch (err) {
                    w.write(JSON.stringify({ error: { message: err instanceof Error ? err.message : String(err) } }));
                    await w.flush();
                }
            });
        }

        try {
            const result = await fuse(fuseOpts, { store });
            return c.json({
                id: result.id,
                object: "chat.completion",
                created,
                model: modelName,
                choices: [
                    { index: 0, message: { role: "assistant", content: result.finalAnswer }, finish_reason: "stop" }
                ],
                usage: {
                    prompt_tokens: result.usage.inputTokens,
                    completion_tokens: result.usage.outputTokens,
                    total_tokens: result.usage.inputTokens + result.usage.outputTokens
                },
                fusion: fusionMeta(result)
            });
        } catch (err) {
            return c.json({ error: { message: err instanceof Error ? err.message : String(err) } }, 500);
        }
    });

    // --- Rich SSE for the web UI: streams every FusionEvent ---
    app.post("/api/fuse", async c => {
        const body = await c.req.json<{
            prompt?: string;
            messages?: OpenAIMessage[];
            panel?: string[];
            judge?: string;
            panel_size?: number;
            web_search?: boolean;
        }>();
        const messages =
            body.messages ? normalizeMessages(body.messages) : [{ role: "user" as const, content: body.prompt ?? "" }];

        return streamSSE(c, async stream => {
            const w = orderedWriter(stream);
            try {
                await fuse(
                    {
                        prompt: messages,
                        panel: body.panel,
                        judge: body.judge,
                        panelSize: body.panel_size,
                        webSearch: body.web_search,
                        onEvent: e => w.write(JSON.stringify(e), e.type)
                    },
                    { store }
                );
                w.write("[DONE]", "end");
                await w.flush();
            } catch (err) {
                w.write(
                    JSON.stringify({ type: "error", message: err instanceof Error ? err.message : String(err) }),
                    "error"
                );
                await w.flush();
            }
        });
    });

    // --- Feedback (hybrid learning, user half) ---
    app.post("/api/feedback", async c => {
        const body = await c.req.json<{ runId: string; rating: 1 | -1; modelId?: string }>();
        if (!body.runId || (body.rating !== 1 && body.rating !== -1)) {
            return c.json({ error: "runId and rating (1 or -1) required" }, 400);
        }
        store.recordFeedback(body.runId, body.rating, body.modelId);
        return c.json({ ok: true });
    });

    // --- Learned strengths dashboard data ---
    app.get("/api/strengths", c => {
        const category = c.req.query("category") || undefined;
        return c.json({ strengths: store.getStrengths(category) });
    });

    app.get("/api/runs", c => {
        const limit = Number(c.req.query("limit") ?? 20);
        return c.json({ runs: store.recentRuns(limit) });
    });

    app.get("/api/config", c => c.json(configResponse(c.req.url)));

    // --- Edit settings + model registry (dashboard "Setup") ---
    app.put("/api/config", async c => {
        const body = await c.req.json<ConfigUpdateBody>();
        const config = loadConfig();
        const next: FusionConfig = { ...config };
        if (Array.isArray(body.providers)) {
            const currentProviders = new Map((config.providers ?? []).map(provider => [provider.id, provider]));
            next.providers = (body.providers as ProviderDef[]).map(provider => ({
                ...provider,
                apiKeyEnv: currentProviders.get(provider.id)?.apiKeyEnv
            }));
        }
        if (Array.isArray(body.models)) next.models = body.models as ModelSpec[];
        if (Array.isArray(body.autoPanel)) next.autoPanel = body.autoPanel;
        if (Array.isArray(body.categories)) next.categories = body.categories;
        if (typeof body.defaultJudge === "string") next.defaultJudge = body.defaultJudge;
        if (typeof body.classifierModel === "string") next.classifierModel = body.classifierModel;
        if (typeof body.panelSize === "number") next.panelSize = body.panelSize;
        if (typeof body.webSearch === "boolean") next.webSearch = body.webSearch;
        if (typeof body.explorationRate === "number") next.explorationRate = body.explorationRate;
        if (body.gateway) {
            const current = { ...DEFAULT_GATEWAY_CONFIG, ...(config.gateway ?? {}) };
            const gateway = { ...current };
            if (typeof body.gateway.baseURL === "string") {
                const baseURL = normalizeGatewayBaseURL(body.gateway.baseURL);
                if (baseURL instanceof Error) return c.json({ error: baseURL.message }, 400);
                gateway.baseURL = baseURL;
            }
            if (typeof body.gateway.model === "string") {
                const model = body.gateway.model.trim();
                if (!model || model.length > 128) {
                    return c.json({ error: "gateway model must be 1-128 characters" }, 400);
                }
                gateway.model = model;
            }
            if (typeof body.gateway.apiKey === "string") {
                const apiKey = body.gateway.apiKey.trim();
                if (apiKey) {
                    gateway.apiKeyHash = hashGatewayApiKey(apiKey);
                    gateway.apiKeyHint = `••••${apiKey.slice(-4)}`;
                } else {
                    delete gateway.apiKeyHash;
                    delete gateway.apiKeyHint;
                }
            }
            next.gateway = gateway;
        }
        saveConfig(next);
        return c.json({ ok: true, config: configResponse(c.req.url) });
    });

    // --- Set a provider API key (internal env name, never exposed to the browser) ---
    app.post("/api/keys", async c => {
        const body = await c.req.json<{ providerId: string; key: string }>();
        if (!body.key) return c.json({ error: "key required" }, 400);
        const config = loadConfig();
        const provider = config.providers?.find(item => item.id === body.providerId);
        if (!provider) return c.json({ error: "provider not found" }, 404);
        const apiKeyEnv = provider.apiKeyEnv ?? internalProviderKeyEnv(provider.id);
        writeEnvVar(apiKeyEnv, body.key.trim());
        saveConfig({
            ...config,
            providers: config.providers?.map(item => (item.id === provider.id ? { ...item, apiKeyEnv } : item))
        });
        return c.json({ ok: true, config: configResponse(c.req.url) });
    });

    // --- Provider/model usage totals (dashboard "Usage") ---
    app.get("/api/usage", c => c.json(store.getUsage()));

    // --- Static web UI (SPA) ---
    if (opts.publicDir) {
        const root = opts.publicDir;
        app.get("/*", async (c, next) => {
            if (c.req.path.startsWith("/api") || c.req.path.startsWith("/v1")) return next();
            const served = await serveFile(root, c.req.path);
            if (served) return c.body(Uint8Array.from(served.body), 200, { "Content-Type": served.type });
            const index = await serveFile(root, "/index.html");
            if (index) return c.body(Uint8Array.from(index.body), 200, { "Content-Type": "text/html" });
            return next();
        });
    }

    return app;
}

/** Default key env var per adapter, used for provider key-set reporting. */
const DEFAULT_KEY_ENV: Record<ProviderName, string> = {
    "anthropic": "ANTHROPIC_API_KEY",
    "openai": "OPENAI_API_KEY",
    "google": "GOOGLE_API_KEY",
    "openai-compatible": "BASETEN_API_KEY"
};

function internalProviderKeyEnv(providerId: string): string {
    const normalized = providerId.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
    return `LLM_FUSION_LITE_PROVIDER_${normalized}_API_KEY`;
}

function publicGatewayConfig(config: FusionConfig, requestURL: string) {
    const gateway = { ...DEFAULT_GATEWAY_CONFIG, ...(config.gateway ?? {}) };
    const configuredBaseURL = gateway.baseURL?.trim() ?? "";
    return {
        baseURL: configuredBaseURL || `${new URL(requestURL).origin}/v1`,
        baseURLAuto: !configuredBaseURL,
        model: gateway.model,
        apiKeySet: Boolean(gateway.apiKeyHash),
        apiKeyHint: gateway.apiKeyHint
    };
}

function normalizeGatewayBaseURL(value: string): string | Error {
    const trimmed = value.trim().replace(/\/+$/, "");
    if (!trimmed) return "";
    try {
        const url = new URL(trimmed);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            return new Error("gateway baseURL must use http or https");
        }
        return url.toString().replace(/\/+$/, "");
    } catch {
        return new Error("gateway baseURL must be a valid URL");
    }
}

function hashGatewayApiKey(apiKey: string): string {
    const salt = randomBytes(16).toString("hex");
    const digest = createHash("sha256").update(`${salt}:${apiKey}`).digest("hex");
    return `sha256:${salt}:${digest}`;
}

function verifyGatewayApiKey(apiKey: string, encoded: string): boolean {
    const [scheme, salt, expectedHex] = encoded.split(":");
    if (scheme !== "sha256" || !salt || !expectedHex) return false;
    const actual = Buffer.from(createHash("sha256").update(`${salt}:${apiKey}`).digest("hex"));
    const expected = Buffer.from(expectedHex);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function requestApiKey(authorization?: string, headerKey?: string): string | undefined {
    const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    return bearer || headerKey?.trim() || undefined;
}

const MIME: Record<string, string> = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2"
};

async function serveFile(root: string, reqPath: string): Promise<{ body: Buffer; type: string } | null> {
    const rel = normalize(decodeURIComponent(reqPath))
        .replace(/^(\.\.[/\\])+/, "")
        .replace(/^[/\\]+/, "");
    const pagePath =
        !rel || rel === "." ? "index.html"
        : reqPath.endsWith("/") ? join(rel, "index.html")
        : rel;
    const full = join(root, pagePath);
    if (!full.startsWith(root)) return null;
    try {
        const s = await stat(full);
        if (!s.isFile()) return null;
        const body = await readFile(full);
        return { body, type: MIME[extname(full)] ?? "application/octet-stream" };
    } catch {
        return null;
    }
}

function chunk(
    id: string,
    created: number,
    model: string,
    delta: Record<string, string>,
    finish: string | null = null
) {
    return {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finish }]
    };
}

function fusionMeta(result: FusionResult) {
    return {
        run_id: result.id,
        category: result.category,
        judge: result.judgeModelId,
        panel: result.panel.map(p => ({
            id: p.modelId,
            label: p.label,
            error: p.error ?? null,
            latency_ms: p.latencyMs
        })),
        analysis: result.analysis,
        usage: result.usage
    };
}

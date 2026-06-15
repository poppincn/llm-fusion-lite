import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { readFile, stat } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import {
  fuse,
  loadConfig,
  saveConfig,
  setProviderKey,
  FusionStore,
  availableAutoPanel,
  configuredProviders,
  type ChatMessage,
  type FusionConfig,
  type FusionEvent,
  type FusionResult,
  type ModelSpec,
  type ProviderName,
} from "@era-fusion/core";

export interface AppOptions {
  store?: FusionStore;
  /** Absolute path to the built web UI (index.html + assets). */
  publicDir?: string;
}

interface OpenAIMessage {
  role: string;
  content: string | Array<{ type?: string; text?: string }>;
}

function normalizeMessages(messages: OpenAIMessage[]): ChatMessage[] {
  return messages.map((m) => {
    let content = "";
    if (typeof m.content === "string") content = m.content;
    else if (Array.isArray(m.content))
      content = m.content.map((p) => p.text ?? "").join("");
    const role =
      m.role === "assistant" ? "assistant" : m.role === "system" || m.role === "developer" ? "system" : "user";
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
    },
  };
}

export function createApp(opts: AppOptions = {}): Hono {
  const app = new Hono();
  const store = opts.store ?? new FusionStore();
  app.use("/api/*", cors());
  app.use("/v1/*", cors());

  function configResponse() {
    const config = loadConfig();
    return {
      models: config.models,
      autoPanel: config.autoPanel,
      available: availableAutoPanel(config),
      defaultJudge: config.defaultJudge,
      classifierModel: config.classifierModel,
      categories: config.categories,
      panelSize: config.panelSize,
      webSearch: config.webSearch,
      explorationRate: config.explorationRate,
      providers: configuredProviders(),
    };
  }

  app.get("/health", (c) =>
    c.json({ ok: true, providers: configuredProviders(), panel: availableAutoPanel(loadConfig()) }),
  );

  // --- OpenAI-compatible model list ---
  app.get("/v1/models", (c) => {
    const config = loadConfig();
    const data = [
      { id: "fusion", object: "model", owned_by: "era-fusion" },
      ...config.models.map((m) => ({ id: m.id, object: "model", owned_by: m.provider })),
    ];
    return c.json({ object: "list", data });
  });

  // --- OpenAI-compatible chat completions (fusion under the hood) ---
  app.post("/v1/chat/completions", async (c) => {
    const body = await c.req.json<{
      model?: string;
      messages: OpenAIMessage[];
      stream?: boolean;
      panel?: string[];
      judge?: string;
      panel_size?: number;
      web_search?: boolean;
    }>();
    const messages = normalizeMessages(body.messages ?? []);
    const created = Math.floor(Date.now() / 1000);
    const modelName = body.model || "fusion";

    const fuseOpts = {
      prompt: messages,
      panel: body.panel,
      judge: body.judge,
      panelSize: body.panel_size,
      webSearch: body.web_search,
    };

    if (body.stream) {
      return streamSSE(c, async (stream) => {
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
                    w.write(
                      JSON.stringify(chunk(id, created, modelName, { role: "assistant" })),
                    );
                  }
                  w.write(JSON.stringify(chunk(id, created, modelName, { content: e.token })));
                }
              },
            },
            { store },
          );
          w.write(JSON.stringify(chunk(id, created, modelName, {}, "stop")));
          w.write("[DONE]");
          await w.flush();
        } catch (err) {
          w.write(
            JSON.stringify({ error: { message: err instanceof Error ? err.message : String(err) } }),
          );
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
          {
            index: 0,
            message: { role: "assistant", content: result.finalAnswer },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: result.usage.inputTokens,
          completion_tokens: result.usage.outputTokens,
          total_tokens: result.usage.inputTokens + result.usage.outputTokens,
        },
        fusion: fusionMeta(result),
      });
    } catch (err) {
      return c.json(
        { error: { message: err instanceof Error ? err.message : String(err) } },
        500,
      );
    }
  });

  // --- Rich SSE for the web UI: streams every FusionEvent ---
  app.post("/api/fuse", async (c) => {
    const body = await c.req.json<{
      prompt?: string;
      messages?: OpenAIMessage[];
      panel?: string[];
      judge?: string;
      panel_size?: number;
      web_search?: boolean;
    }>();
    const messages = body.messages
      ? normalizeMessages(body.messages)
      : [{ role: "user" as const, content: body.prompt ?? "" }];

    return streamSSE(c, async (stream) => {
      const w = orderedWriter(stream);
      try {
        await fuse(
          {
            prompt: messages,
            panel: body.panel,
            judge: body.judge,
            panelSize: body.panel_size,
            webSearch: body.web_search,
            onEvent: (e) => w.write(JSON.stringify(e), e.type),
          },
          { store },
        );
        w.write("[DONE]", "end");
        await w.flush();
      } catch (err) {
        w.write(
          JSON.stringify({ type: "error", message: err instanceof Error ? err.message : String(err) }),
          "error",
        );
        await w.flush();
      }
    });
  });

  // --- Feedback (hybrid learning, user half) ---
  app.post("/api/feedback", async (c) => {
    const body = await c.req.json<{ runId: string; rating: 1 | -1; modelId?: string }>();
    if (!body.runId || (body.rating !== 1 && body.rating !== -1)) {
      return c.json({ error: "runId and rating (1 or -1) required" }, 400);
    }
    store.recordFeedback(body.runId, body.rating, body.modelId);
    return c.json({ ok: true });
  });

  // --- Learned strengths dashboard data ---
  app.get("/api/strengths", (c) => {
    const category = c.req.query("category") || undefined;
    return c.json({ strengths: store.getStrengths(category) });
  });

  app.get("/api/runs", (c) => {
    const limit = Number(c.req.query("limit") ?? 20);
    return c.json({ runs: store.recentRuns(limit) });
  });

  app.get("/api/config", (c) => c.json(configResponse()));

  // --- Edit settings + model registry (dashboard "Setup") ---
  app.put("/api/config", async (c) => {
    const body = await c.req.json<Partial<FusionConfig>>();
    const config = loadConfig();
    const next: FusionConfig = { ...config };
    if (Array.isArray(body.models)) next.models = body.models as ModelSpec[];
    if (Array.isArray(body.autoPanel)) next.autoPanel = body.autoPanel;
    if (Array.isArray(body.categories)) next.categories = body.categories;
    if (typeof body.defaultJudge === "string") next.defaultJudge = body.defaultJudge;
    if (typeof body.classifierModel === "string") next.classifierModel = body.classifierModel;
    if (typeof body.panelSize === "number") next.panelSize = body.panelSize;
    if (typeof body.webSearch === "boolean") next.webSearch = body.webSearch;
    if (typeof body.explorationRate === "number") next.explorationRate = body.explorationRate;
    saveConfig(next);
    return c.json({ ok: true, config: configResponse() });
  });

  // --- Set a provider API key (writes ~/.era-fusion/.env + live env) ---
  app.post("/api/keys", async (c) => {
    const body = await c.req.json<{ provider: ProviderName; key: string }>();
    const valid: ProviderName[] = ["anthropic", "openai", "google"];
    if (!valid.includes(body.provider) || !body.key) {
      return c.json({ error: "provider (anthropic|openai|google) and key required" }, 400);
    }
    setProviderKey(body.provider, body.key.trim());
    return c.json({ ok: true, providers: configuredProviders() });
  });

  // --- Provider/model usage totals (dashboard "Usage") ---
  app.get("/api/usage", (c) => c.json(store.getUsage()));

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

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

async function serveFile(
  root: string,
  reqPath: string,
): Promise<{ body: Buffer; type: string } | null> {
  const rel = normalize(decodeURIComponent(reqPath)).replace(/^(\.\.[/\\])+/, "");
  const full = join(root, rel === "/" ? "/index.html" : rel);
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
  finish: string | null = null,
) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}

function fusionMeta(result: FusionResult) {
  return {
    run_id: result.id,
    category: result.category,
    judge: result.judgeModelId,
    panel: result.panel.map((p) => ({
      id: p.modelId,
      label: p.label,
      error: p.error ?? null,
      latency_ms: p.latencyMs,
    })),
    analysis: result.analysis,
    usage: result.usage,
  };
}

import type { CompletionOptions, CompletionResult, ModelSpec, Provider } from "../types.js";
import { loadConfig } from "../config.js";
import { runToolLoop, type ToolLoopEndpoint } from "./agent-loop.js";
import { sandboxAvailable } from "./sandbox.js";

/**
 * Bound concurrent requests to hosted open-model endpoints, which rate-limit
 * (e.g. Baseten GLM at 120 req/min). One permit per complete() call: agentic
 * loops fire several requests internally but sequentially, so capping concurrent
 * loops caps concurrent requests. Tune with ERA_FUSION_OAI_CONCURRENCY (default 4).
 */
const MAX_CONCURRENCY = Math.max(1, Number(process.env.ERA_FUSION_OAI_CONCURRENCY) || 4);
let active = 0;
const waiters: Array<() => void> = [];
function acquire(): Promise<void> {
  return new Promise((resolve) => {
    if (active < MAX_CONCURRENCY) { active++; resolve(); } else waiters.push(resolve);
  });
}
function release(): void {
  const next = waiters.shift();
  if (next) next(); // hand the permit to the next waiter (active unchanged)
  else active--;
}

/** Per-request timeout for custom endpoints (ms). */
const REQUEST_TIMEOUT_MS = 300_000;

function withTimeout(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/**
 * Build the HTTP headers for a custom endpoint: the API key in the configured
 * auth header (default `Authorization` → `Bearer <key>`; any other header name
 * carries the raw key), plus per-model extra headers. The auth header always
 * wins over an extra header of the same name.
 */
export function customEndpointHeaders(spec: ModelSpec, apiKey: string): Record<string, string> {
  const authHeader = spec.apiKeyHeader ?? "Authorization";
  const authValue = authHeader === "Authorization" ? `Bearer ${apiKey}` : apiKey;
  return { ...(spec.headers ?? {}), [authHeader]: authValue };
}

/**
 * Generic OpenAI-compatible Chat Completions provider — for any endpoint that
 * speaks the OpenAI chat API (Ollama, vLLM, OpenRouter, Baseten, private
 * gateways, …). Unlike the first-party `openai` provider (which uses the
 * Responses API + hosted tools), this one targets the lowest-common-denominator
 * chat endpoint over plain fetch so any compatible server works out of the box.
 *
 * Config: register the model with `provider: "openai-compatible"`, a `baseURL`,
 * and optionally `apiKeyEnv` (the env var holding the key; default
 * BASETEN_API_KEY). Keyless local endpoints (Ollama) ignore the auth header —
 * point `apiKeyEnv` at any env var and give it any value:
 *   { id: "llama-local", provider: "openai-compatible", model: "llama3.1",
 *     label: "Llama (local)", baseURL: "http://localhost:11434/v1",
 *     apiKeyEnv: "OLLAMA_API_KEY" }
 *
 * No native web search (depth tiers collapse to a single completion); these
 * endpoints don't expose hosted tools uniformly.
 */
export class OpenAICompatibleProvider implements Provider {
  name = "openai-compatible" as const;
  supportsWebSearch = false;

  /** Find the registered spec for a provider-native model string. */
  private specFor(modelString: string): ModelSpec | undefined {
    return loadConfig().models.find((m) => m.provider === this.name && m.model === modelString);
  }

  private keyEnvOf(spec?: ModelSpec): string {
    return spec?.apiKeyEnv || "BASETEN_API_KEY";
  }

  /** Configured if any registered openai-compatible model has its key env set. */
  isConfigured(): boolean {
    return loadConfig().models.some(
      (m) => m.provider === this.name && !!m.baseURL && !!process.env[this.keyEnvOf(m)],
    );
  }

  async complete(modelString: string, opts: CompletionOptions): Promise<CompletionResult> {
    await acquire();
    try {
      return await this.run(modelString, opts);
    } finally {
      release();
    }
  }

  private async run(modelString: string, opts: CompletionOptions): Promise<CompletionResult> {
    const start = Date.now();
    const spec = this.specFor(modelString);
    const fail = (message: string): CompletionResult => ({
      text: "", model: modelString, provider: this.name, latencyMs: Date.now() - start, error: message,
    });
    const baseURL = spec?.baseURL?.replace(/\/+$/, "");
    if (!spec || !baseURL) return fail(`openai-compatible model "${modelString}" has no baseURL in config`);
    const keyEnv = this.keyEnvOf(spec);
    const apiKey = process.env[keyEnv];
    if (!apiKey) return fail(`${keyEnv} is not set`);
    const endpoint: ToolLoopEndpoint = {
      baseURL,
      headers: { "Content-Type": "application/json", ...customEndpointHeaders(spec, apiKey) },
    };
    const messages = opts.messages.map((m) => ({ role: m.role, content: m.content }));
    const depth = opts.depth ?? "light";
    const maxTokens = opts.maxTokens ?? (depth === "deep" ? 16000 : depth === "standard" ? 6000 : 2048);

    // Agentic: drive a function-calling loop with the same sandbox tools the CLI
    // agents use (python/websearch/fetchurl). Requires the sandbox container.
    if (opts.agentic) {
      if (!sandboxAvailable()) return fail("agentic mode needs the sandbox container — run `sandbox/run.sh up`");
      try {
        const r = await runToolLoop(endpoint, modelString, messages, {
          maxTokens,
          extraParams: spec.extraParams,
          signal: opts.signal,
        });
        if (r.text) opts.onToken?.(r.text);
        return { text: r.text, model: modelString, provider: this.name, usage: r.usage, toolCalls: r.toolCalls, latencyMs: Date.now() - start };
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }

    // Engine-set fields (model/messages/max_tokens) win over per-model extraParams.
    const body: Record<string, unknown> = {
      ...(spec.extraParams ?? {}),
      model: modelString,
      messages,
      max_tokens: maxTokens,
    };

    try {
      const { text, usage } = opts.onToken
        ? await chatStream(endpoint, { ...body, stream: true, stream_options: { include_usage: true } }, opts.onToken, opts.signal)
        : await chatOnce(endpoint, body, opts.signal);
      return { text, model: modelString, provider: this.name, usage, latencyMs: Date.now() - start };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }
}

async function chatOnce(
  endpoint: ToolLoopEndpoint,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ text: string; usage?: { inputTokens?: number; outputTokens?: number } }> {
  const res = await fetch(`${endpoint.baseURL}/chat/completions`, {
    method: "POST",
    headers: endpoint.headers,
    body: JSON.stringify(body),
    signal: withTimeout(signal),
  });
  if (!res.ok) throw new Error(await readError(res));
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const usage = data.usage
    ? { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens }
    : undefined;
  return { text: (data.choices?.[0]?.message?.content ?? "").trim(), usage };
}

async function chatStream(
  endpoint: ToolLoopEndpoint,
  body: Record<string, unknown>,
  onToken: (token: string) => void,
  signal?: AbortSignal,
): Promise<{ text: string; usage?: { inputTokens?: number; outputTokens?: number } }> {
  const res = await fetch(`${endpoint.baseURL}/chat/completions`, {
    method: "POST",
    headers: endpoint.headers,
    body: JSON.stringify(body),
    signal: withTimeout(signal),
  });
  if (!res.ok) throw new Error(await readError(res));
  if (!res.body) throw new Error("chat completions stream returned no body");

  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let usage: { inputTokens?: number; outputTokens?: number } | undefined;
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    for (;;) {
      const nl = buffer.indexOf("\n");
      if (nl === -1) break;
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let obj: {
        choices?: Array<{ delta?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      try {
        obj = JSON.parse(payload);
      } catch {
        continue;
      }
      const delta = obj.choices?.[0]?.delta?.content;
      if (delta) {
        text += delta;
        onToken(delta);
      }
      if (obj.usage) usage = { inputTokens: obj.usage.prompt_tokens, outputTokens: obj.usage.completion_tokens };
    }
  }
  return { text: text.trim(), usage };
}

async function readError(res: Response): Promise<string> {
  let detail = "";
  try {
    detail = (await res.text()).slice(0, 300);
  } catch {
    /* ignore */
  }
  return `chat completions request failed (${res.status})${detail ? `: ${detail}` : ""}`;
}

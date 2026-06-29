import OpenAI from "openai";
import type { CompletionOptions, CompletionResult, ModelSpec, Provider } from "../types.js";
import { loadConfig } from "../config.js";
import { runOpenAIToolLoop } from "./agent-loop.js";
import { sandboxAvailable } from "./sandbox.js";

/**
 * Generic OpenAI-compatible Chat Completions provider — for any endpoint that
 * speaks the OpenAI chat API (Baseten, OpenRouter, Together, vLLM, …). Unlike the
 * first-party `openai` provider (which uses the Responses API + hosted tools),
 * this one targets the lowest-common-denominator chat endpoint so open models
 * like GLM 5.2 or Minimax M3 work out of the box.
 *
 * Config: register the model with `provider: "openai-compatible"`, a `baseURL`,
 * and optionally `apiKeyEnv` (the env var holding the key; default BASETEN_API_KEY):
 *   { id: "glm-5.2", provider: "openai-compatible", model: "zai-org/GLM-5.2",
 *     label: "GLM 5.2", baseURL: "https://inference.baseten.co/v1",
 *     apiKeyEnv: "BASETEN_API_KEY" }
 *
 * No native web search (depth tiers collapse to a single completion); these
 * endpoints don't expose hosted tools uniformly.
 */
export class OpenAICompatibleProvider implements Provider {
  name = "openai-compatible" as const;
  supportsWebSearch = false;
  private clients = new Map<string, OpenAI>();

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

  private clientFor(spec: ModelSpec): OpenAI {
    const key = `${spec.baseURL}|${this.keyEnvOf(spec)}`;
    let c = this.clients.get(key);
    if (!c) {
      c = new OpenAI({ baseURL: spec.baseURL, apiKey: process.env[this.keyEnvOf(spec)] });
      this.clients.set(key, c);
    }
    return c;
  }

  async complete(modelString: string, opts: CompletionOptions): Promise<CompletionResult> {
    const start = Date.now();
    const spec = this.specFor(modelString);
    const fail = (message: string): CompletionResult => ({
      text: "", model: modelString, provider: this.name, latencyMs: Date.now() - start, error: message,
    });
    if (!spec?.baseURL) return fail(`openai-compatible model "${modelString}" has no baseURL in config`);
    if (!process.env[this.keyEnvOf(spec)]) return fail(`${this.keyEnvOf(spec)} is not set`);

    const messages = opts.messages.map((m) => ({ role: m.role, content: m.content }));
    const depth = opts.depth ?? "light";
    const maxTokens = opts.maxTokens ?? (depth === "deep" ? 16000 : depth === "standard" ? 6000 : 2048);

    // Agentic: drive a function-calling loop with the same sandbox tools the CLI
    // agents use (python/websearch/fetchurl). Requires the sandbox container.
    if (opts.agentic) {
      if (!sandboxAvailable()) return fail("agentic mode needs the sandbox container — run `sandbox/run.sh up`");
      try {
        const r = await runOpenAIToolLoop(this.clientFor(spec), modelString, messages, { maxTokens, signal: opts.signal });
        if (r.text) opts.onToken?.(r.text);
        return { text: r.text, model: modelString, provider: this.name, usage: r.usage, toolCalls: r.toolCalls, latencyMs: Date.now() - start };
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }

    try {
      const stream = await this.clientFor(spec).chat.completions.create(
        {
          model: modelString,
          messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
          max_tokens: maxTokens,
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: opts.signal },
      );

      let text = "";
      let usage: { inputTokens?: number; outputTokens?: number } | undefined;
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) { text += delta; opts.onToken?.(delta); }
        if (chunk.usage) usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens };
      }

      return { text: text.trim(), model: modelString, provider: this.name, usage, latencyMs: Date.now() - start };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
  }
}

import OpenAI from "openai";
import type {
  Citation,
  CompletionOptions,
  CompletionResult,
  Provider,
} from "../types.js";
import { apiKeyFor, authModeFor } from "../config.js";
import { cliAvailable, cliComplete } from "./cli.js";
import { sandboxComplete } from "./sandbox.js";

export class OpenAIProvider implements Provider {
  name = "openai" as const;
  supportsWebSearch = true;
  private client: OpenAI | null = null;

  isConfigured(): boolean {
    return authModeFor(this.name) === "subscription"
      ? cliAvailable(this.name)
      : !!apiKeyFor(this.name);
  }

  private getClient(): OpenAI {
    if (!this.client) {
      this.client = new OpenAI({ apiKey: apiKeyFor("openai") });
    }
    return this.client;
  }

  async complete(
    modelString: string,
    opts: CompletionOptions,
  ): Promise<CompletionResult> {
    if (opts.agentic) {
      return sandboxComplete(this.name, modelString, opts);
    }
    if (authModeFor(this.name) === "subscription") {
      return cliComplete(this.name, modelString, opts);
    }
    const start = Date.now();
    const system = opts.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const input = opts.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));

    const depth = opts.depth ?? (opts.webSearch ? "standard" : "light");
    const useTools = depth !== "light" && opts.webSearch !== false;
    const maxTokens = opts.maxTokens ?? (depth === "deep" ? 16000 : depth === "standard" ? 6000 : 2048);

    try {
      // Responses API runs hosted tools (web search) in a server-side agentic loop.
      const stream = this.getClient().responses.stream(
        {
          model: modelString,
          ...(system ? { instructions: system } : {}),
          input: input as unknown as string,
          max_output_tokens: maxTokens,
          ...(useTools ? { tools: [{ type: "web_search" }] } : {}),
        } as Parameters<OpenAI["responses"]["stream"]>[0],
        { signal: opts.signal },
      );

      for await (const event of stream) {
        if (
          (event as { type?: string }).type === "response.output_text.delta" &&
          opts.onToken
        ) {
          opts.onToken((event as { delta?: string }).delta ?? "");
        }
      }

      const final = await stream.finalResponse();
      const text = (final.output_text ?? "").trim();
      const citations = extractCitations(final);

      return {
        text,
        model: modelString,
        provider: this.name,
        usage: {
          inputTokens: final.usage?.input_tokens,
          outputTokens: final.usage?.output_tokens,
        },
        citations,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      return {
        text: "",
        model: modelString,
        provider: this.name,
        latencyMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

function extractCitations(final: unknown): Citation[] {
  const out: Citation[] = [];
  const seen = new Set<string>();
  const output = (final as { output?: unknown[] }).output;
  if (!Array.isArray(output)) return out;
  for (const item of output) {
    const content = (item as { content?: unknown[] }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const annotations = (block as { annotations?: unknown[] }).annotations;
      if (!Array.isArray(annotations)) continue;
      for (const a of annotations as Array<{ type?: string; url?: string; title?: string }>) {
        if (a.url && !seen.has(a.url)) {
          seen.add(a.url);
          out.push({ url: a.url, title: a.title });
        }
      }
    }
  }
  return out;
}

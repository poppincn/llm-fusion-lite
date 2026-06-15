import { GoogleGenAI } from "@google/genai";
import type {
  Citation,
  CompletionOptions,
  CompletionResult,
  Provider,
} from "../types.js";
import { apiKeyFor } from "../config.js";

export class GoogleProvider implements Provider {
  name = "google" as const;
  supportsWebSearch = true;
  private client: GoogleGenAI | null = null;

  isConfigured(): boolean {
    return !!apiKeyFor("google");
  }

  private getClient(): GoogleGenAI {
    if (!this.client) {
      this.client = new GoogleGenAI({ apiKey: apiKeyFor("google") });
    }
    return this.client;
  }

  async complete(
    modelString: string,
    opts: CompletionOptions,
  ): Promise<CompletionResult> {
    const start = Date.now();
    const systemInstruction = opts.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const contents = opts.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      }));

    const depth = opts.depth ?? (opts.webSearch ? "standard" : "light");
    const useSearch = depth !== "light" && opts.webSearch !== false;
    const maxTokens = opts.maxTokens ?? (depth === "deep" ? 16000 : depth === "standard" ? 6000 : 2048);

    try {
      const stream = await this.getClient().models.generateContentStream({
        model: modelString,
        contents,
        config: {
          ...(systemInstruction ? { systemInstruction } : {}),
          maxOutputTokens: maxTokens,
          ...(useSearch ? { tools: [{ googleSearch: {} }] } : {}),
          ...(opts.signal ? { abortSignal: opts.signal } : {}),
        },
      });

      let text = "";
      let last: unknown = null;
      for await (const chunk of stream) {
        const t = (chunk as { text?: string }).text;
        if (t) {
          text += t;
          opts.onToken?.(t);
        }
        last = chunk;
      }

      const usage = (last as { usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } })
        ?.usageMetadata;

      return {
        text: text.trim(),
        model: modelString,
        provider: this.name,
        usage: {
          inputTokens: usage?.promptTokenCount,
          outputTokens: usage?.candidatesTokenCount,
        },
        citations: extractCitations(last),
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

function extractCitations(chunk: unknown): Citation[] {
  const out: Citation[] = [];
  const seen = new Set<string>();
  const candidates = (chunk as { candidates?: unknown[] })?.candidates;
  if (!Array.isArray(candidates)) return out;
  for (const c of candidates) {
    const groundingChunks = (
      c as { groundingMetadata?: { groundingChunks?: unknown[] } }
    )?.groundingMetadata?.groundingChunks;
    if (!Array.isArray(groundingChunks)) continue;
    for (const g of groundingChunks as Array<{ web?: { uri?: string; title?: string } }>) {
      const uri = g.web?.uri;
      if (uri && !seen.has(uri)) {
        seen.add(uri);
        out.push({ url: uri, title: g.web?.title });
      }
    }
  }
  return out;
}

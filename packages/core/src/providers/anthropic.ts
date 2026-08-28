import Anthropic from "@anthropic-ai/sdk";
import type { Citation, CompletionOptions, CompletionResult, Provider } from "../types.js";
import { apiKeyFor, apiKeyForModel, authModeFor, loadConfig } from "../config.js";
import { modelCredentialReady } from "../credentials.js";
import { cliAvailable, cliComplete } from "./cli.js";
import { sandboxComplete } from "./sandbox.js";

/** Split ChatMessages into an Anthropic system string + user/assistant turns. */
function splitMessages(messages: CompletionOptions["messages"]) {
    const system = messages
        .filter(m => m.role === "system")
        .map(m => m.content)
        .join("\n\n");
    const turns = messages
        .filter(m => m.role !== "system")
        .map(m => ({ role: m.role as "user" | "assistant", content: m.content }));
    return { system, turns };
}

export class AnthropicProvider implements Provider {
    name = "anthropic" as const;
    supportsWebSearch = true;
    private clients = new Map<string, Anthropic>();

    isConfigured(): boolean {
        if (authModeFor(this.name) === "subscription") return cliAvailable(this.name);
        return loadConfig().models.some(m => m.provider === this.name && modelCredentialReady(m));
    }

    private getClient(apiKey: string): Anthropic {
        let c = this.clients.get(apiKey);
        if (!c) {
            c = new Anthropic({ apiKey });
            this.clients.set(apiKey, c);
        }
        return c;
    }

    async complete(modelString: string, opts: CompletionOptions): Promise<CompletionResult> {
        if (opts.agentic) {
            return sandboxComplete(this.name, modelString, opts);
        }
        if (authModeFor(this.name) === "subscription") {
            return cliComplete(this.name, modelString, opts);
        }
        const start = Date.now();
        const { system, turns } = splitMessages(opts.messages);
        const depth = opts.depth ?? (opts.webSearch ? "standard" : "light");
        // Per-provider key env (multiple Anthropic instances coexist).
        const spec = loadConfig().models.find(m => m.provider === this.name && m.model === modelString);
        const apiKey = apiKeyForModel(spec) ?? apiKeyFor(this.name) ?? "";

        // Map depth → hosted tool set + budget. On "deep", the SDK runs an agentic
        // server-side loop across web search, web fetch, and sandboxed code execution.
        const tools: Array<Record<string, unknown>> = [];
        if (depth !== "light" && opts.webSearch !== false) {
            tools.push({ type: "web_search_20260209", name: "web_search", max_uses: 8 });
        }
        if (depth === "deep") {
            tools.push({ type: "web_fetch_20260209", name: "web_fetch", max_uses: 8 });
            tools.push({ type: "code_execution_20260120", name: "code_execution" });
        }
        const maxTokens =
            opts.maxTokens
            ?? (depth === "deep" ? 16000
            : depth === "standard" ? 6000
            : 2048);

        try {
            // Built loosely + cast: newer fields (adaptive thinking, web_fetch/code_execution
            // tools) may post-date the installed SDK's static types but are valid at runtime.
            const params: Record<string, unknown> = { model: modelString, max_tokens: maxTokens, messages: turns };
            if (system) params.system = system;
            if (tools.length) params.tools = tools;
            if (depth === "deep") params.thinking = { type: "adaptive" };
            // Reasoning effort → output_config.effort (GA, no beta header). Effort is
            // rejected on Haiku (and pre-4.6 Sonnet), so skip it there; every other
            // registry model (Fable 5 / Opus 4.x / Sonnet 4.6) accepts low..max.
            if (!/haiku/i.test(modelString)) {
                params.output_config = { effort: opts.reasoningEffort ?? "high" };
            }

            const stream = this.getClient(apiKey).messages.stream(
                params as unknown as Parameters<Anthropic["messages"]["stream"]>[0],
                { signal: opts.signal }
            );

            if (opts.onToken) {
                stream.on("text", t => opts.onToken!(t));
            }

            const msg = await stream.finalMessage();

            let text = "";
            const citations: Citation[] = [];
            for (const block of msg.content) {
                if (block.type === "text") {
                    text += block.text;
                    const blockCitations = (block as { citations?: unknown[] }).citations;
                    if (Array.isArray(blockCitations)) {
                        for (const c of blockCitations as Array<{ url?: string; title?: string }>) {
                            if (c.url) citations.push({ url: c.url, title: c.title });
                        }
                    }
                } else if (block.type === "web_search_tool_result") {
                    const content = (block as { content?: unknown }).content;
                    if (Array.isArray(content)) {
                        for (const r of content as Array<{ url?: string; title?: string }>) {
                            if (r.url) citations.push({ url: r.url, title: r.title });
                        }
                    }
                }
            }

            return {
                text: text.trim(),
                model: modelString,
                provider: this.name,
                usage: { inputTokens: msg.usage?.input_tokens, outputTokens: msg.usage?.output_tokens },
                citations: dedupeCitations(citations),
                latencyMs: Date.now() - start
            };
        } catch (err) {
            return {
                text: "",
                model: modelString,
                provider: this.name,
                latencyMs: Date.now() - start,
                error: err instanceof Error ? err.message : String(err)
            };
        }
    }
}

function dedupeCitations(citations: Citation[]): Citation[] {
    const seen = new Set<string>();
    const out: Citation[] = [];
    for (const c of citations) {
        if (seen.has(c.url)) continue;
        seen.add(c.url);
        out.push(c);
    }
    return out;
}

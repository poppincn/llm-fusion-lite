/**
 * Provider-agnostic function-calling agent loop for OpenAI-compatible models
 * (Baseten GLM, OpenRouter, vLLM, …) that have no first-party CLI agent. Gives
 * them the SAME grounding tools the CLI agents get — python/websearch/fetchurl —
 * executed inside the sandbox container (never on the host). The model requests
 * tools via standard OpenAI tool-calling over plain fetch; we run them and feed
 * results back until it answers.
 */
import { execInSandbox } from "./sandbox.js";

const MAX_ITERS = 8;
const REQUEST_TIMEOUT_MS = 300_000;

const TOOLS = [
    {
        type: "function" as const,
        function: {
            name: "python",
            description:
                "Run Python 3 code (numpy, scipy, sympy, mpmath available) in a sandbox and return stdout. Use for ANY exact/large computation instead of mental math.",
            parameters: {
                type: "object",
                properties: { code: { type: "string", description: "Python source to execute" } },
                required: ["code"]
            }
        }
    },
    {
        type: "function" as const,
        function: {
            name: "websearch",
            description:
                "Web search; returns the top results as title / url / snippet. Use to ground factual or current-information claims.",
            parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
        }
    },
    {
        type: "function" as const,
        function: {
            name: "fetchurl",
            description:
                "Fetch a URL and return its readable text (truncated). Use to confirm a source found via websearch.",
            parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] }
        }
    }
];

async function runTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    switch (name) {
        case "python":
            return execInSandbox(["python3", "-c", String(args.code ?? "")], { signal, timeoutMs: 60_000 });
        case "websearch":
            return execInSandbox(["websearch", String(args.query ?? "")], { signal, timeoutMs: 45_000 });
        case "fetchurl":
            return execInSandbox(["fetchurl", String(args.url ?? "")], { signal, timeoutMs: 30_000 });
        default:
            return `error: unknown tool ${name}`;
    }
}

export interface ToolLoopResult {
    text: string;
    toolCalls: { name: string }[];
    usage: { inputTokens: number; outputTokens: number };
}

/** The endpoint the loop talks to (headers already include auth). */
export interface ToolLoopEndpoint {
    baseURL: string;
    headers: Record<string, string>;
}

function withTimeout(signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

interface ChatMessageDelta {
    content?: string | null;
    tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
}

/** One non-streaming chat completion over plain fetch. Throws on HTTP errors. */
async function chatOnce(
    endpoint: ToolLoopEndpoint,
    model: string,
    messages: unknown[],
    body: Record<string, unknown>,
    signal?: AbortSignal
): Promise<{ message: ChatMessageDelta; inputTokens: number; outputTokens: number }> {
    const res = await fetch(`${endpoint.baseURL}/chat/completions`, {
        method: "POST",
        headers: endpoint.headers,
        body: JSON.stringify({ model, messages, ...body }),
        signal: withTimeout(signal)
    });
    if (!res.ok) {
        let detail = "";
        try {
            detail = (await res.text()).slice(0, 200);
        } catch {
            /* ignore */
        }
        throw new Error(`tool loop request failed (${res.status})${detail ? `: ${detail}` : ""}`);
    }
    const data = (await res.json()) as {
        choices?: Array<{ message?: ChatMessageDelta }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
        message: data.choices?.[0]?.message ?? {},
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0
    };
}

/**
 * Drive an OpenAI-compatible model through a tool-using loop. Never throws on
 * tool errors (a bad tool result is fed back to the model).
 */
export async function runToolLoop(
    endpoint: ToolLoopEndpoint,
    model: string,
    baseMessages: Array<{ role: string; content: string }>,
    opts: { maxTokens?: number; signal?: AbortSignal; extraParams?: Record<string, unknown> } = {}
): Promise<ToolLoopResult> {
    const messages: Array<Record<string, unknown>> = [
        {
            role: "system",
            content:
                "You have sandboxed tools: `python` (exact computation), `websearch`, and `fetchurl`. Ground every quantitative or factual claim by CALLING a tool — never do multi-digit math in your head or guess current facts. Call tools as needed, then give the final answer."
        },
        ...baseMessages
    ];
    const toolCalls: { name: string }[] = [];
    let inputTokens = 0;
    let outputTokens = 0;

    // Engine-set fields (tools/max_tokens) win over per-model extraParams.
    const toolsBody = {
        ...(opts.extraParams ?? {}),
        tools: TOOLS,
        tool_choice: "auto",
        max_tokens: opts.maxTokens ?? 4096
    };

    for (let i = 0; i < MAX_ITERS; i++) {
        const {
            message,
            inputTokens: inTok,
            outputTokens: outTok
        } = await chatOnce(endpoint, model, messages, toolsBody, opts.signal);
        inputTokens += inTok;
        outputTokens += outTok;
        messages.push(message as Record<string, unknown>);
        const calls = message.tool_calls ?? [];
        if (!calls.length) {
            return { text: (message.content ?? "").trim(), toolCalls, usage: { inputTokens, outputTokens } };
        }
        for (const tc of calls) {
            if (tc.type && tc.type !== "function") continue;
            const name = tc.function?.name ?? "";
            let args: Record<string, unknown> = {};
            try {
                args = JSON.parse(tc.function?.arguments || "{}");
            } catch {
                /* leave empty */
            }
            toolCalls.push({ name: name || "unknown" });
            const out = await runTool(name, args, opts.signal);
            messages.push({
                role: "tool",
                tool_call_id: tc.id ?? `call-${toolCalls.length}`,
                content: out.slice(0, 4000)
            });
        }
    }

    // Out of iterations — force a final answer with no further tools.
    const fin = await chatOnce(endpoint, model, messages, { max_tokens: opts.maxTokens ?? 4096 }, opts.signal);
    inputTokens += fin.inputTokens;
    outputTokens += fin.outputTokens;
    return { text: (fin.message.content ?? "").trim(), toolCalls, usage: { inputTokens, outputTokens } };
}

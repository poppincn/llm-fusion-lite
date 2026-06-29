/**
 * Provider-agnostic function-calling agent loop for OpenAI-compatible models
 * (Baseten GLM, OpenRouter, …) that have no first-party CLI agent. Gives them the
 * SAME grounding tools the CLI agents get — python/websearch/fetchurl — executed
 * inside the sandbox container (never on the host). The model requests tools via
 * standard OpenAI tool-calling; we run them and feed results back until it answers.
 */
import type OpenAI from "openai";
import { execInSandbox } from "./sandbox.js";

const MAX_ITERS = 8;

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "python",
      description: "Run Python 3 code (numpy, scipy, sympy, mpmath available) in a sandbox and return stdout. Use for ANY exact/large computation instead of mental math.",
      parameters: { type: "object", properties: { code: { type: "string", description: "Python source to execute" } }, required: ["code"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "websearch",
      description: "Web search; returns the top results as title / url / snippet. Use to ground factual or current-information claims.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "fetchurl",
      description: "Fetch a URL and return its readable text (truncated). Use to confirm a source found via websearch.",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    },
  },
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

/** Drive an OpenAI-compatible model through a tool-using loop. Never throws on tool errors. */
export async function runOpenAIToolLoop(
  client: OpenAI,
  model: string,
  baseMessages: Array<{ role: string; content: string }>,
  opts: { maxTokens?: number; signal?: AbortSignal } = {},
): Promise<ToolLoopResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages: any[] = [
    {
      role: "system",
      content:
        "You have sandboxed tools: `python` (exact computation), `websearch`, and `fetchurl`. Ground every quantitative or factual claim by CALLING a tool — never do multi-digit math in your head or guess current facts. Call tools as needed, then give the final answer.",
    },
    ...baseMessages,
  ];
  const toolCalls: { name: string }[] = [];
  let inputTokens = 0;
  let outputTokens = 0;

  for (let i = 0; i < MAX_ITERS; i++) {
    const res = await client.chat.completions.create(
      {
        model,
        messages,
        tools: TOOLS,
        tool_choice: "auto",
        max_tokens: opts.maxTokens ?? 4096,
      },
      { signal: opts.signal },
    );
    inputTokens += res.usage?.prompt_tokens ?? 0;
    outputTokens += res.usage?.completion_tokens ?? 0;
    const msg = res.choices?.[0]?.message;
    if (!msg) break;
    messages.push(msg);
    const calls = msg.tool_calls ?? [];
    if (!calls.length) {
      return { text: (msg.content ?? "").trim(), toolCalls, usage: { inputTokens, outputTokens } };
    }
    for (const tc of calls) {
      if (tc.type !== "function") continue;
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.function.arguments || "{}"); } catch { /* leave empty */ }
      toolCalls.push({ name: tc.function.name });
      const out = await runTool(tc.function.name, args, opts.signal);
      messages.push({ role: "tool", tool_call_id: tc.id, content: out.slice(0, 4000) });
    }
  }

  // Out of iterations — force a final answer with no further tools.
  const fin = await client.chat.completions.create(
    { model, messages, max_tokens: opts.maxTokens ?? 4096 },
    { signal: opts.signal },
  );
  inputTokens += fin.usage?.prompt_tokens ?? 0;
  outputTokens += fin.usage?.completion_tokens ?? 0;
  return { text: (fin.choices?.[0]?.message?.content ?? "").trim(), toolCalls, usage: { inputTokens, outputTokens } };
}

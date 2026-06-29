/**
 * Agentic execution backend: run a panelist as a full tool-using agent inside
 * the disposable sandbox container (see docs/AGENTIC_FUSION.md), via the
 * provider's CLI. Each call runs in a fresh /work/<uuid> dir so parallel
 * panelists don't collide and nothing persists. The container holds the agent
 * CLIs + runtimes + tools; the host never executes the agent's bash/file actions.
 *
 * Auth inside the box comes from the keys passed at `sandbox/run.sh up` (codex is
 * pre-registered there). This backend never throws — failures return a result
 * with `error` set, like cliComplete.
 */
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { CompletionOptions, CompletionResult, ProviderName } from "../types.js";

/** Container name (override with ERA_FUSION_SANDBOX). */
function containerName(): string {
  return process.env.ERA_FUSION_SANDBOX || "era-fusion-sandbox";
}

const AGENT_TIMEOUT_MS = 300_000; // agents loop over tools; allow more than a plain call

/** Fold chat messages into a single prompt string for a one-shot agent run. */
function foldPrompt(messages: CompletionOptions["messages"]): string {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const turns = messages.filter((m) => m.role !== "system");
  if (!system && turns.length === 1 && turns[0].role === "user") return turns[0].content;
  const parts: string[] = [];
  if (system) parts.push(system);
  for (const t of turns) parts.push(`${t.role}: ${t.content}`);
  return parts.join("\n\n");
}

/** Build the in-container shell script (runs in a fresh workdir) + parser per provider. */
function agentSpec(provider: ProviderName, model: string): {
  script: string;
  parse: (stdout: string) => { text: string; toolCalls: { name: string }[]; costUsd?: number };
} | null {
  const runDir = `/work/run-${randomUUID()}`;
  const cd = `mkdir -p ${runDir} && cd ${runDir} &&`;
  switch (provider) {
    case "anthropic":
      // stream-json gives structured tool_use events + a final result line.
      return {
        script: `${cd} claude -p --model ${model} --permission-mode bypassPermissions --output-format stream-json --verbose "$1"`,
        parse: parseClaudeStreamJson,
      };
    case "openai":
      return {
        script: `${cd} codex exec --color never -m ${model} --skip-git-repo-check --sandbox workspace-write "$1"`,
        parse: (out) => ({ text: stripChrome(out), toolCalls: [] }), // codex transcript; best-effort text
      };
    case "google":
      return {
        script: `export GEMINI_API_KEY="\${GEMINI_API_KEY:-$GOOGLE_API_KEY}" GEMINI_CLI_TRUST_WORKSPACE=true; ${cd} gemini -m ${model} --yolo -p "$1"`,
        parse: (out) => ({ text: stripChrome(out), toolCalls: [] }),
      };
    default:
      return null; // openai-compatible (Baseten) has no CLI agent — caller falls back
  }
}

/**
 * Defensively strip CLI chrome that can leak onto stdout (gemini-cli/codex emit
 * most of it to stderr, but be robust). Gemini/codex give a plain final answer,
 * not a structured stream, so we keep the meaningful lines and drop known noise.
 */
function stripChrome(out: string): string {
  const noise = /^(YOLO mode|Both GOOGLE_API_KEY|Approval mode|Warning:|\[STARTUP\]|Loaded cached|Data collection|Using GOOGLE_API_KEY|warning:|Reading additional input|OpenAI Codex|tokens used|\d+ tokens|exec\b)/i;
  return out
    .split(/\r?\n/)
    .filter((l) => !noise.test(l.trim()))
    .join("\n")
    .trim();
}

/** Parse Claude Code stream-json: final text + tool_use names + real reported cost. */
function parseClaudeStreamJson(stdout: string): { text: string; toolCalls: { name: string }[]; costUsd?: number } {
  const toolCalls: { name: string }[] = [];
  let text = "";
  let costUsd: number | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    let obj: { type?: string; result?: string; total_cost_usd?: number; message?: { content?: Array<{ type?: string; name?: string }> } };
    try { obj = JSON.parse(s); } catch { continue; }
    if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
      for (const block of obj.message!.content!) {
        if (block.type === "tool_use" && block.name) toolCalls.push({ name: block.name });
      }
    } else if (obj.type === "result") {
      if (typeof obj.result === "string") text = obj.result;
      if (typeof obj.total_cost_usd === "number") costUsd = obj.total_cost_usd;
    }
  }
  return { text: text.trim(), toolCalls, costUsd };
}

/**
 * Run a command inside the sandbox container and return its combined output
 * (truncated). Used by the function-calling agent loop to execute model-requested
 * tools (python/websearch/fetchurl) in isolation — never on the host. Never throws.
 */
export function execInSandbox(argv: string[], opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "docker",
      ["exec", "-w", "/work", containerName(), ...argv],
      { timeout: opts.timeoutMs ?? 60_000, maxBuffer: 16 * 1024 * 1024, signal: opts.signal },
      (err, stdout, stderr) => {
        let out = (stdout ?? "").trim();
        const e = (stderr ?? "").trim();
        if (e) out += (out ? "\n" : "") + `[stderr] ${e}`;
        resolve(out || (err ? `error: ${err.message}` : "(no output)"));
      },
    );
  });
}

/** True if the sandbox container is running. (ESM-safe: uses the imported execFileSync.) */
export function sandboxAvailable(): boolean {
  try {
    const out = execFileSync("docker", ["ps", "--filter", `name=^/${containerName()}$`, "--format", "{{.Names}}"], {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
    return out.split(/\r?\n/).includes(containerName());
  } catch {
    return false;
  }
}

/** Run a panelist as an agent in the sandbox. Never throws. */
export function sandboxComplete(
  provider: ProviderName,
  modelString: string,
  opts: CompletionOptions,
): Promise<CompletionResult> {
  const start = Date.now();
  const spec = agentSpec(provider, modelString);
  const fail = (message: string): CompletionResult => ({
    text: "", model: modelString, provider, latencyMs: Date.now() - start, error: message,
  });
  if (!spec) return Promise.resolve(fail(`provider ${provider} has no sandbox agent CLI`));
  const prompt = foldPrompt(opts.messages);
  if (opts.signal?.aborted) return Promise.resolve(fail("aborted before start"));

  return new Promise<CompletionResult>((resolve) => {
    let settled = false;
    const done = (r: CompletionResult) => {
      if (settled) return;
      settled = true;
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      resolve(r);
    };
    const child = execFile(
      "docker",
      ["exec", containerName(), "bash", "-lc", spec.script, "_", prompt],
      { timeout: AGENT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        const out = stdout ?? "";
        const { text, toolCalls, costUsd } = spec.parse(out);
        if (!text) {
          done(fail(err ? `sandbox agent failed: ${err.message}` : "sandbox agent produced no answer"));
          return;
        }
        // Subscription/agent CLIs report no token usage; estimate ~4 chars/token.
        const est = (s: string) => Math.max(1, Math.ceil(s.length / 4));
        done({
          text, model: modelString, provider,
          usage: { inputTokens: est(prompt), outputTokens: est(text) },
          toolCalls, costUsd, latencyMs: Date.now() - start,
        });
      },
    );
    try { child.stdin?.end(); } catch { /* ignore */ }
    const onAbort = () => { child.kill(); done(fail("aborted")); };
    if (opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => done(fail(e.message)));
  });
}

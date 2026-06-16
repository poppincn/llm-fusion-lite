/**
 * Subscription-mode backend: call a provider's official CLI as a subprocess,
 * using the user's logged-in Pro/Max plan instead of an API key.
 *
 * Known limitation: CLI invocations report NO token usage, so
 * CompletionResult.usage is left undefined and cost metrics show $0/unmetered.
 * If a subscription provider is used as the judge, its JSON-structured judge
 * output is best-effort (CLIs are less reliable at strict JSON) — keep the
 * judge on an api/Anthropic model when possible.
 */
import { execFile, execFileSync } from "node:child_process";
import type {
  CompletionOptions,
  CompletionResult,
  ProviderName,
} from "../types.js";

interface CliSpec {
  /** Executable name expected on PATH. */
  bin: string;
  /** npm package that provides the CLI. */
  pkg: string;
  /** Build the argv (after the bin) that runs a one-shot prompt. */
  buildArgs(prompt: string): string[];
}

/** Per-provider CLI wiring (grounded against the published packages). */
export const CLI_SPECS: Record<ProviderName, CliSpec> = {
  anthropic: {
    bin: "claude",
    pkg: "@anthropic-ai/claude-code",
    buildArgs: (prompt) => ["-p", prompt],
  },
  openai: {
    bin: "codex",
    pkg: "@openai/codex",
    buildArgs: (prompt) => ["exec", prompt],
  },
  google: {
    bin: "gemini",
    pkg: "@google/gemini-cli",
    buildArgs: (prompt) => ["-p", prompt],
  },
};

/** Hard cap on a single CLI subprocess (ms). */
const CLI_TIMEOUT_MS = 180_000;

/** True if the provider's CLI is resolvable on PATH. */
export function cliAvailable(provider: ProviderName): boolean {
  const { bin } = CLI_SPECS[provider];
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [bin], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/** Flatten chat messages into a single prompt string for a one-shot CLI call. */
function foldPrompt(messages: CompletionOptions["messages"]): string {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const turns = messages.filter((m) => m.role !== "system");

  // Single plain user turn with no system → pass the content verbatim.
  if (!system && turns.length === 1 && turns[0].role === "user") {
    return turns[0].content;
  }

  const parts: string[] = [];
  if (system) parts.push(system);
  for (const t of turns) parts.push(`${t.role}: ${t.content}`);
  return parts.join("\n\n");
}

/**
 * Run a provider CLI as a subprocess and return its stdout as the completion.
 * Honors opts.signal (kills the child on abort) and a ~180s timeout. Never
 * throws — failures are returned as a result with an `error` and empty text.
 */
export async function cliComplete(
  provider: ProviderName,
  modelString: string,
  opts: CompletionOptions,
): Promise<CompletionResult> {
  const start = Date.now();
  const { bin, buildArgs } = CLI_SPECS[provider];
  const prompt = foldPrompt(opts.messages);

  const fail = (message: string): CompletionResult => ({
    text: "",
    model: modelString,
    provider,
    usage: undefined,
    latencyMs: Date.now() - start,
    error: message,
  });

  if (opts.signal?.aborted) return fail("aborted before start");

  return new Promise<CompletionResult>((resolve) => {
    let settled = false;
    const done = (result: CompletionResult) => {
      if (settled) return;
      settled = true;
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const child = execFile(
      bin,
      buildArgs(prompt),
      { timeout: CLI_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        const text = (stdout ?? "").trim();
        if (err) {
          // Treat any stdout we captured as salvageable only if non-empty and
          // the process still exited cleanly; otherwise surface the error.
          if (text && (err as { code?: number }).code === 0) {
            done({
              text,
              model: modelString,
              provider,
              usage: undefined,
              latencyMs: Date.now() - start,
            });
            return;
          }
          done(fail(err.message));
          return;
        }
        if (!text) {
          done(fail(`${bin} produced no output`));
          return;
        }
        done({
          text,
          model: modelString,
          provider,
          usage: undefined,
          latencyMs: Date.now() - start,
        });
      },
    );

    const onAbort = () => {
      child.kill();
      done(fail("aborted"));
    };
    if (opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true });

    child.on("error", (e) => done(fail(e.message)));
  });
}

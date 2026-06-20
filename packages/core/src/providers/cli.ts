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

/**
 * Per-binary serialization. Two concurrent subprocesses of the same subscription
 * CLI (e.g. an Opus and a Sonnet panelist both via `claude`) can contend on the
 * single logged-in session and one dies. Run same-bin calls one at a time.
 */
const binLocks = new Map<string, Promise<void>>(); // at most 3 keys (claude/codex/gemini)
async function withBinLock<T>(bin: string, fn: () => Promise<T>): Promise<T> {
  const prev = binLocks.get(bin) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  binLocks.set(bin, prev.then(() => gate)); // next caller waits for prev, then this gate
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

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

  // Subscription CLIs return the whole answer at once (no token stream). Emit it
  // as a single onToken event so streaming consumers (CLI stdout, server SSE,
  // web UI) still receive it — otherwise the answer is produced but never shown.
  const ok = (text: string): CompletionResult => {
    if (text) opts.onToken?.(text);
    return { text, model: modelString, provider, usage: undefined, latencyMs: Date.now() - start };
  };

  if (opts.signal?.aborted) return fail("aborted before start");

  return withBinLock(bin, () => new Promise<CompletionResult>((resolve) => {
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
            done(ok(text));
            return;
          }
          done(fail(err.message));
          return;
        }
        if (!text) {
          done(fail(`${bin} produced no output`));
          return;
        }
        done(ok(text));
      },
    );

    // Close the child's stdin so CLIs that probe for piped input (e.g. `claude`)
    // don't block waiting on it and emit a "no stdin data received" warning.
    try {
      child.stdin?.end();
    } catch {
      // ignore
    }

    const onAbort = () => {
      child.kill();
      done(fail("aborted"));
    };
    if (opts.signal) opts.signal.addEventListener("abort", onAbort, { once: true });

    child.on("error", (e) => done(fail(e.message)));
  }));
}

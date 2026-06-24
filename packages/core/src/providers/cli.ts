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
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
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
  /**
   * Build the argv (after the bin) that runs a one-shot prompt. `model` is the
   * registry's provider-native model string, passed through so the CLI runs the
   * model the panel asked for rather than the session default. `outFile`, when
   * provided, is a path the CLI should write its final message to (used for CLIs
   * whose stdout is a noisy transcript rather than just the answer).
   */
  buildArgs(prompt: string, model: string, outFile?: string): string[];
  /** When true, cliComplete passes a temp file and reads the answer from it. */
  usesOutFile?: boolean;
}

/**
 * Per-provider CLI wiring (grounded against the published packages).
 *
 * Each spec pins `--model` to the registry's model string. Without it the CLI
 * runs the logged-in session's DEFAULT model, so a panelist declared as
 * "claude-opus-4-8" could silently answer on Sonnet — understating it as both a
 * panelist and a benchmark baseline. The installed `claude`/`codex` CLIs accept
 * the registry strings (e.g. `claude --model claude-opus-4-8`) directly.
 */
export const CLI_SPECS: Record<ProviderName, CliSpec> = {
  anthropic: {
    bin: "claude",
    pkg: "@anthropic-ai/claude-code",
    buildArgs: (prompt, model) => ["-p", "--model", model, prompt],
  },
  openai: {
    // `codex exec` renders a transcript to stdout and the final message can be
    // missed; `-o <file>` captures exactly the final answer. `--color never`
    // keeps it clean. (Framing goes to stderr, which we ignore.)
    bin: "codex",
    pkg: "@openai/codex",
    usesOutFile: true,
    buildArgs: (prompt, model, outFile) =>
      ["exec", "--color", "never", "-m", model, ...(outFile ? ["-o", outFile] : []), prompt],
  },
  google: {
    bin: "gemini",
    pkg: "@google/gemini-cli",
    buildArgs: (prompt, model) => ["-m", model, "-p", prompt],
  },
};

/** Rough token estimate (~4 chars/token) for CLIs that report no usage. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

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

/** Sleep that resolves early if the abort signal fires. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

/**
 * Run a provider CLI with one retry on transient failure. Subscription CLIs
 * occasionally die for non-deterministic reasons (session contention, a flaky
 * one-shot) — counting that as a wrong/empty answer understates the model both
 * as a panelist and as a benchmark baseline. A genuine abort is not retried.
 */
export async function cliComplete(
  provider: ProviderName,
  modelString: string,
  opts: CompletionOptions,
): Promise<CompletionResult> {
  const res = await cliAttempt(provider, modelString, opts);
  if (!res.error || opts.signal?.aborted || /abort/i.test(res.error)) return res;
  await delay(750, opts.signal);
  if (opts.signal?.aborted) return res;
  return cliAttempt(provider, modelString, opts);
}

/**
 * Run a provider CLI as a subprocess and return its stdout as the completion.
 * Honors opts.signal (kills the child on abort) and a ~180s timeout. Never
 * throws — failures are returned as a result with an `error` and empty text.
 */
async function cliAttempt(
  provider: ProviderName,
  modelString: string,
  opts: CompletionOptions,
): Promise<CompletionResult> {
  const start = Date.now();
  const spec = CLI_SPECS[provider];
  const { bin } = spec;
  const prompt = foldPrompt(opts.messages);
  const inputTokensEst = estimateTokens(prompt);
  const outFile = spec.usesOutFile ? join(tmpdir(), `fuse-${bin}-${randomUUID()}.txt`) : undefined;

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
  // Token counts are estimated (subscription CLIs report none).
  const ok = (text: string): CompletionResult => {
    if (text) opts.onToken?.(text);
    return {
      text,
      model: modelString,
      provider,
      usage: { inputTokens: inputTokensEst, outputTokens: estimateTokens(text) },
      latencyMs: Date.now() - start,
    };
  };

  if (opts.signal?.aborted) return fail("aborted before start");

  return withBinLock(bin, () => new Promise<CompletionResult>((resolve) => {
    let settled = false;
    const done = (result: CompletionResult) => {
      if (settled) return;
      settled = true;
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      if (outFile) {
        try {
          unlinkSync(outFile);
        } catch {
          // temp file may not exist
        }
      }
      resolve(result);
    };

    const child = execFile(
      bin,
      spec.buildArgs(prompt, modelString, outFile),
      { timeout: CLI_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        // Prefer the out-file (just the final message) when used; else stdout.
        let text = (stdout ?? "").trim();
        if (outFile) {
          try {
            const fromFile = readFileSync(outFile, "utf8").trim();
            if (fromFile) text = fromFile;
          } catch {
            // fall back to stdout
          }
        }
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

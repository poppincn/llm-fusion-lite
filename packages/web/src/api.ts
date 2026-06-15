import type {
  FuseRequest,
  FusionEvent,
  FusionConfig,
  ModelStrength,
  RunSummary,
  Rating,
} from "./types";

/**
 * Stream a fusion run. POSTs the body to /api/fuse and parses the
 * Server-Sent-Events response off the raw ReadableStream (we do NOT use
 * EventSource since EventSource cannot issue POST requests).
 *
 * Calls `onEvent` for each parsed FusionEvent. Resolves when the stream
 * terminates (either via the `end` event whose data is `[DONE]`, or when the
 * underlying stream closes). Rejects on network/HTTP errors.
 *
 * Pass an AbortSignal to cancel the run early.
 */
export async function streamFuse(
  body: FuseRequest,
  onEvent: (event: FusionEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/fuse", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      /* ignore */
    }
    throw new Error(
      `Fusion request failed (${res.status})${detail ? `: ${detail}` : ""}`,
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE messages are separated by a blank line (\n\n or \r\n\r\n).
      for (;;) {
        const sepIndex = indexOfSeparator(buffer);
        if (sepIndex === -1) break;
        const rawMessage = buffer.slice(0, sepIndex);
        buffer = buffer.slice(sepIndex + separatorLength(buffer, sepIndex));
        const finished = handleSseMessage(rawMessage, onEvent);
        if (finished) return;
      }
    }

    // Flush any trailing message without a terminating blank line.
    if (buffer.trim().length > 0) {
      handleSseMessage(buffer, onEvent);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

/** Find the index of the next message separator (blank line). Supports \n\n and \r\n\r\n. */
function indexOfSeparator(buf: string): number {
  const lf = buf.indexOf("\n\n");
  const crlf = buf.indexOf("\r\n\r\n");
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}

function separatorLength(buf: string, idx: number): number {
  return buf.startsWith("\r\n\r\n", idx) ? 4 : 2;
}

/**
 * Parse one SSE message block (one or more lines) and dispatch it.
 * Returns true if this message marks the end of the stream ([DONE]).
 */
function handleSseMessage(
  raw: string,
  onEvent: (event: FusionEvent) => void,
): boolean {
  const lines = raw.split(/\r?\n/);
  let eventName = "";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith(":")) continue; // comment / heartbeat
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).replace(/^ /, ""));
    }
  }

  const data = dataLines.join("\n").trim();
  if (data.length === 0) return false;

  // Stream terminator.
  if (eventName === "end" || data === "[DONE]") {
    return true;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    // Ignore unparseable payloads rather than aborting the whole stream.
    return false;
  }

  if (isFusionEvent(parsed)) {
    onEvent(parsed);
  }
  return false;
}

function isFusionEvent(value: unknown): value is FusionEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

export interface FeedbackBody {
  runId: string;
  rating: Rating;
  modelId?: string;
}

export async function sendFeedback(body: FeedbackBody): Promise<{ ok: true }> {
  const res = await fetch("/api/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Feedback failed (${res.status})`);
  return (await res.json()) as { ok: true };
}

export async function getStrengths(
  category?: string,
): Promise<ModelStrength[]> {
  const qs =
    category && category.length > 0
      ? `?category=${encodeURIComponent(category)}`
      : "";
  const res = await fetch(`/api/strengths${qs}`);
  if (!res.ok) throw new Error(`Strengths fetch failed (${res.status})`);
  const json = (await res.json()) as { strengths: ModelStrength[] };
  return json.strengths ?? [];
}

export async function getRuns(limit?: number): Promise<RunSummary[]> {
  const qs = typeof limit === "number" ? `?limit=${limit}` : "";
  const res = await fetch(`/api/runs${qs}`);
  if (!res.ok) throw new Error(`Runs fetch failed (${res.status})`);
  const json = (await res.json()) as { runs: RunSummary[] };
  return json.runs ?? [];
}

export async function getConfig(): Promise<FusionConfig> {
  const res = await fetch("/api/config");
  if (!res.ok) throw new Error(`Config fetch failed (${res.status})`);
  return (await res.json()) as FusionConfig;
}

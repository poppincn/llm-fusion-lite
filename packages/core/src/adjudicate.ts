/**
 * Scope adjudication: a cheap pre-pass that reads the request and decides the
 * subject (category) and the depth tier each panelist should run at. Depth is
 * dynamic — scaled to the scope of work inferred from the request.
 */
import type { FusionConfig } from "./config.js";
import { apiKeyForModel, getModel } from "./config.js";
import { getProvider } from "./providers/index.js";
import type { ChatMessage, Depth } from "./types.js";

export interface Adjudication {
  subject: string;
  depth: Depth;
  rationale: string;
}

const DEPTHS: Depth[] = ["light", "standard", "deep"];

function lastUserText(messages: ChatMessage[]): string {
  const u = [...messages].reverse().find((m) => m.role === "user");
  return (u?.content ?? messages.map((m) => m.content).join("\n")).slice(0, 6000);
}

function heuristicSubject(text: string, categories: string[]): string {
  const t = text.toLowerCase();
  const rules: Array<[string, RegExp]> = [
    ["coding", /\b(code|function|bug|compile|api|typescript|python|refactor|stack trace|npm|git)\b/],
    ["math", /\b(prove|integral|equation|theorem|calculate|probability|matrix|derivative)\b/],
    ["research", /\b(latest|research|paper|state of the art|survey|compare|versus|vs\.)\b/],
    ["factual", /\b(who|when|where|what is|how many|capital of|population)\b/],
    ["writing", /\b(write|draft|email|essay|rewrite|edit|summari[sz]e)\b/],
    ["creative", /\b(story|poem|imagine|fiction|brainstorm|character)\b/],
    ["analysis", /\b(analy[sz]e|evaluate|tradeoff|pros and cons|assess|critique)\b/],
    ["reasoning", /\b(why|explain|reason|logic|deduce|step by step)\b/],
  ];
  for (const [cat, re] of rules) if (categories.includes(cat) && re.test(t)) return cat;
  return categories.includes("other") ? "other" : categories[0];
}

function heuristicDepth(text: string): Depth {
  const t = text.toLowerCase();
  const words = t.split(/\s+/).length;
  if (
    /\b(research|investigate|deep dive|comprehensive|thorough|design|architect|debug|build|compare .* (across|to)|benchmark|analy[sz]e in depth)\b/.test(
      t,
    ) ||
    words > 120
  ) {
    return "deep";
  }
  if (/\b(latest|current|today|recent|news|price|version|cite|sources?)\b/.test(t) || words > 25) {
    return "standard";
  }
  return "light";
}

export async function adjudicate(
  messages: ChatMessage[],
  config: FusionConfig,
  signal?: AbortSignal,
): Promise<Adjudication> {
  const text = lastUserText(messages);
  const fallback: Adjudication = {
    subject: heuristicSubject(text, config.categories),
    depth: heuristicDepth(text),
    rationale: "heuristic (no classifier model available)",
  };

  const spec = getModel(config, config.classifierModel);
  if (!spec || !apiKeyForModel(spec)) return fallback;

  const provider = getProvider(spec.provider);
  const cats = config.categories.join(", ");
  const res = await provider.complete(spec.model, {
    maxTokens: 200,
    webSearch: false,
    depth: "light",
    signal,
    messages: [
      {
        role: "system",
        content: `You triage a user request for a multi-model "fusion" pipeline. Decide:
1. subject: exactly one of [${cats}].
2. depth: how much work this needs — "light" (simple/known, one shot), "standard" (needs current info / moderate reasoning), or "deep" (open-ended, multi-step research, design, debugging, or comparison worth an agentic tool loop).
Respond with ONLY a JSON object: {"subject":"...","depth":"...","rationale":"one short clause"}`,
      },
      { role: "user", content: text },
    ],
  });

  if (res.error || !res.text) return fallback;
  try {
    const start = res.text.indexOf("{");
    const end = res.text.lastIndexOf("}");
    const obj = JSON.parse(res.text.slice(start, end + 1)) as Partial<Adjudication>;
    const subject =
      (obj.subject && config.categories.find((c) => obj.subject!.toLowerCase().includes(c))) ||
      fallback.subject;
    const depth = DEPTHS.includes(obj.depth as Depth) ? (obj.depth as Depth) : fallback.depth;
    return { subject, depth, rationale: String(obj.rationale ?? "").slice(0, 200) || "adjudicated" };
  } catch {
    return fallback;
  }
}

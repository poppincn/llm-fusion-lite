/** Cheap prompt categorization to drive per-category adaptive panel selection. */
import type { FusionConfig } from "./config.js";
import { apiKeyFor, getModel } from "./config.js";
import { getProvider } from "./providers/index.js";
import type { ChatMessage } from "./types.js";

function lastUserText(messages: ChatMessage[]): string {
  const u = [...messages].reverse().find((m) => m.role === "user");
  return (u?.content ?? messages.map((m) => m.content).join("\n")).slice(0, 4000);
}

/** Fast keyword heuristic used when no classifier model is available. */
function heuristic(text: string, categories: string[]): string {
  const t = text.toLowerCase();
  const rules: Array<[string, RegExp]> = [
    ["coding", /\b(code|function|bug|compile|api|typescript|python|refactor|stack trace|npm|git)\b/],
    ["math", /\b(prove|integral|equation|theorem|calculate|probability|matrix|derivative)\b/],
    ["research", /\b(latest|research|paper|state of the art|survey|compare .* (vs|versus))\b/],
    ["factual", /\b(who|when|where|what is|how many|capital of|population)\b/],
    ["writing", /\b(write|draft|email|essay|rewrite|edit|summari[sz]e)\b/],
    ["creative", /\b(story|poem|imagine|fiction|brainstorm|character)\b/],
    ["analysis", /\b(analy[sz]e|evaluate|tradeoff|pros and cons|assess|critique)\b/],
    ["reasoning", /\b(why|explain|reason|logic|deduce|step by step)\b/],
  ];
  for (const [cat, re] of rules) {
    if (categories.includes(cat) && re.test(t)) return cat;
  }
  return categories.includes("other") ? "other" : categories[0];
}

export async function classifyPrompt(
  messages: ChatMessage[],
  config: FusionConfig,
  signal?: AbortSignal,
): Promise<string> {
  const text = lastUserText(messages);
  const spec = getModel(config, config.classifierModel);
  if (!spec || !apiKeyFor(spec.provider)) {
    return heuristic(text, config.categories);
  }

  const provider = getProvider(spec.provider);
  const list = config.categories.join(", ");
  const res = await provider.complete(spec.model, {
    maxTokens: 16,
    webSearch: false,
    signal,
    messages: [
      {
        role: "system",
        content: `You are a topic classifier. Classify the user's request into exactly one of these categories: ${list}. Respond with only the single category word, lowercase, nothing else.`,
      },
      { role: "user", content: text },
    ],
  });

  if (res.error || !res.text) return heuristic(text, config.categories);
  const guess = res.text.toLowerCase().replace(/[^a-z]/g, "");
  const match = config.categories.find((c) => guess.includes(c));
  return match ?? heuristic(text, config.categories);
}

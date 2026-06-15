import type { Provider, ProviderName } from "../types.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";
import { GoogleProvider } from "./google.js";

const registry: Record<ProviderName, Provider> = {
  anthropic: new AnthropicProvider(),
  openai: new OpenAIProvider(),
  google: new GoogleProvider(),
};

export function getProvider(name: ProviderName): Provider {
  return registry[name];
}

/** Provider names that currently have an API key configured. */
export function configuredProviders(): ProviderName[] {
  return (Object.keys(registry) as ProviderName[]).filter((n) =>
    registry[n].isConfigured(),
  );
}

export { AnthropicProvider, OpenAIProvider, GoogleProvider };

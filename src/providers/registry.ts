import type { AppConfig, ProviderConfig } from "../config/schema.js";
import type { LlmClient } from "./types.js";
import { createOpenAIResponsesClient } from "./openaiResponses.js";
import { createAnthropicMessagesClient } from "./anthropicMessages.js";

export function getProvider(config: AppConfig, key: string): ProviderConfig {
  const provider = config.providers[key];
  if (!provider) {
    throw new Error(`Provider '${key}' not found in config.providers`);
  }
  return provider;
}

export function createLlmClient(provider: ProviderConfig): LlmClient {
  switch (provider.type) {
    case "openai":
      // MVP default: OpenAI Responses API.
      return createOpenAIResponsesClient(provider);
    case "anthropic":
      return createAnthropicMessagesClient(provider);
    default:
      throw new Error(`Unsupported provider type: ${(provider as any).type}`);
  }
}

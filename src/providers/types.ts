import type { BaseMessage } from "@langchain/core/messages";

export type GenerateTextParams = {
  messages: BaseMessage[];
  model: string;
  temperature?: number;
  systemPrompt?: string;
};

export interface LlmClient {
  generateText(params: GenerateTextParams): Promise<string>;
}

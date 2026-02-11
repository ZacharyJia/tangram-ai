import type { BaseMessage } from "@langchain/core/messages";

export type GenerateTextParams = {
  messages: BaseMessage[];
  model: string;
  temperature?: number;
  systemPrompt?: string;
};

export type FunctionToolDef = {
  name: string;
  description?: string;
  parameters: Record<string, unknown> | null;
  strict?: boolean;
};

export type FunctionToolCall = {
  name: string;
  callId: string;
  argumentsJson: string;
};

export type GenerateWithToolsParams = GenerateTextParams & {
  tools?: FunctionToolDef[];
  toolCallItems?: Array<{
    type: "function_call";
    call_id: string;
    name: string;
    arguments: string;
  }>;
  toolOutputs?: Array<{
    type: "function_call_output";
    call_id: string;
    output: string;
  }>;
};

export type GenerateWithToolsResult = {
  outputText: string;
  toolCalls: FunctionToolCall[];
};

export interface LlmClient {
  generateText(params: GenerateTextParams): Promise<string>;
  generateWithTools(params: GenerateWithToolsParams): Promise<GenerateWithToolsResult>;
}

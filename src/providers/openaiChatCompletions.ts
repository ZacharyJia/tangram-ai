import OpenAI from "openai";
import type { BaseMessage } from "@langchain/core/messages";

import type {
  FunctionToolCall,
  FunctionToolDef,
  GenerateWithToolsParams,
  GenerateWithToolsResult,
  LlmClient,
} from "./types.js";
import type { ProviderConfig } from "../config/schema.js";

function assertOpenAIChatCompletions(
  provider: ProviderConfig
): asserts provider is Extract<ProviderConfig, { type: "openai-chat-completions" }> {
  if (provider.type !== "openai-chat-completions") {
    throw new Error(`createOpenAIChatCompletionsClient: unsupported provider type '${(provider as any).type}'`);
  }
}

function toText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function mapMessages(messages: BaseMessage[], systemPrompt?: string): OpenAI.Chat.ChatCompletionMessageParam[] {
  const systemParts: string[] = [];
  const mapped: OpenAI.Chat.ChatCompletionMessageParam[] = [];

  for (const msg of messages) {
    const t = msg._getType();
    const content = toText((msg as any).content);
    if (t === "system") {
      if (content) systemParts.push(content);
      continue;
    }
    if (t === "ai") {
      mapped.push({ role: "assistant", content });
      continue;
    }
    mapped.push({ role: "user", content });
  }

  if (systemPrompt) systemParts.push(systemPrompt);
  const system = systemParts.join("\n\n").trim();
  if (!system) return mapped;
  return [{ role: "system", content: system }, ...mapped];
}

function appendToolCycle(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  toolHistoryItems?: Array<
    | { type: "function_call"; call_id: string; name: string; arguments: string }
    | { type: "function_call_output"; call_id: string; output: string }
  >,
  toolCallItems?: Array<{ type: "function_call"; call_id: string; name: string; arguments: string }>,
  toolOutputs?: Array<{ type: "function_call_output"; call_id: string; output: string }>
): void {
  if (toolHistoryItems?.length) {
    for (let i = 0; i < toolHistoryItems.length; i += 1) {
      const item = toolHistoryItems[i];
      if (item.type === "function_call") {
        const calls: Array<{ type: "function_call"; call_id: string; name: string; arguments: string }> = [item];
        while (i + 1 < toolHistoryItems.length && toolHistoryItems[i + 1]?.type === "function_call") {
          i += 1;
          calls.push(toolHistoryItems[i] as any);
        }

        messages.push({
          role: "assistant",
          content: null,
          tool_calls: calls.map((call) => ({
            id: call.call_id,
            type: "function",
            function: {
              name: call.name,
              arguments: call.arguments,
            },
          })),
        } as OpenAI.Chat.ChatCompletionMessageParam);
        continue;
      }

      messages.push({
        role: "tool",
        tool_call_id: item.call_id,
        content: item.output,
      } as OpenAI.Chat.ChatCompletionMessageParam);
    }
    return;
  }

  if (toolCallItems?.length) {
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: toolCallItems.map((call) => ({
        id: call.call_id,
        type: "function",
        function: {
          name: call.name,
          arguments: call.arguments,
        },
      })),
    } as OpenAI.Chat.ChatCompletionMessageParam);
  }

  if (toolOutputs?.length) {
    for (const output of toolOutputs) {
      messages.push({
        role: "tool",
        tool_call_id: output.call_id,
        content: output.output,
      } as OpenAI.Chat.ChatCompletionMessageParam);
    }
  }
}

function convertFunctionTools(tools?: FunctionToolDef[]): OpenAI.Chat.ChatCompletionTool[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters ?? { type: "object", properties: {}, required: [] },
    },
  }));
}

function extractOutputText(message: OpenAI.Chat.Completions.ChatCompletionMessage | undefined): string {
  if (!message) return "";
  const content = (message as any).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map((part: any) => {
      if (!part) return "";
      if (typeof part.text === "string") return part.text;
      return "";
    })
    .join("");
}

function extractToolCalls(message: OpenAI.Chat.Completions.ChatCompletionMessage | undefined): FunctionToolCall[] {
  if (!message?.tool_calls?.length) return [];

  return message.tool_calls
    .filter((call) => call.type === "function")
    .map((call) => ({
      name: call.function.name,
      callId: call.id,
      argumentsJson: call.function.arguments ?? "{}",
    }))
    .filter((call) => call.name && call.callId);
}

export function createOpenAIChatCompletionsClient(provider: ProviderConfig): LlmClient {
  assertOpenAIChatCompletions(provider);

  const client = new OpenAI({
    apiKey: provider.apiKey,
    baseURL: provider.baseUrl,
  });

  const createCompletion = async (params: GenerateWithToolsParams): Promise<GenerateWithToolsResult> => {
    const { messages, model, temperature, systemPrompt, tools, toolHistoryItems, toolCallItems, toolOutputs } =
      params;

    const chatMessages = mapMessages(messages, systemPrompt);
    appendToolCycle(chatMessages, toolHistoryItems, toolCallItems, toolOutputs);
    const functionTools = convertFunctionTools(tools);

    const resp = await client.chat.completions.create({
      model,
      messages: chatMessages,
      temperature,
      tools: functionTools,
      tool_choice: functionTools && functionTools.length > 0 ? "auto" : undefined,
    });

    const message = resp.choices?.[0]?.message;
    return {
      outputText: extractOutputText(message),
      toolCalls: extractToolCalls(message),
    };
  };

  return {
    async generateWithTools(params: GenerateWithToolsParams): Promise<GenerateWithToolsResult> {
      return createCompletion(params);
    },
    async generateText({ messages, model, temperature, systemPrompt }) {
      const res = await createCompletion({ messages, model, temperature, systemPrompt });
      if (res.toolCalls.length > 0) {
        throw new Error("generateText received tool calls; use generateWithTools for tool-enabled runs.");
      }
      if (!res.outputText) {
        throw new Error("OpenAI chat.completions returned empty message content.");
      }
      return res.outputText;
    },
  };
}

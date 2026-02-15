import type { BaseMessage } from "@langchain/core/messages";

import type {
  FunctionToolCall,
  FunctionToolDef,
  GenerateWithToolsParams,
  GenerateWithToolsResult,
  LlmClient,
} from "./types.js";
import type { ProviderConfig } from "../config/schema.js";

type AnthropicContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

type AnthropicMessage = {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
};

function assertAnthropic(provider: ProviderConfig): asserts provider is Extract<ProviderConfig, { type: "anthropic" }> {
  if (provider.type !== "anthropic") {
    throw new Error(`createAnthropicMessagesClient: unsupported provider type '${(provider as any).type}'`);
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

function mapMessages(messages: BaseMessage[]): { system?: string; messages: AnthropicMessage[] } {
  let systemParts: string[] = [];
  const mapped: AnthropicMessage[] = [];

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

  const system = systemParts.join("\n\n").trim();
  return {
    system: system || undefined,
    messages: mapped,
  };
}

function convertFunctionTools(tools?: FunctionToolDef[]): unknown[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters ?? { type: "object", properties: {}, required: [] },
  }));
}

function appendToolCycle(
  messages: AnthropicMessage[],
  toolHistoryItems?: Array<
    | { type: "function_call"; call_id: string; name: string; arguments: string }
    | { type: "function_call_output"; call_id: string; output: string }
  >,
  toolCallItems?: Array<{ type: "function_call"; call_id: string; name: string; arguments: string }>,
  toolOutputs?: Array<{ type: "function_call_output"; call_id: string; output: string }>
) {
  if (toolHistoryItems?.length) {
    for (let i = 0; i < toolHistoryItems.length; i += 1) {
      const item = toolHistoryItems[i];
      if (item.type === "function_call") {
        const content: AnthropicContentBlock[] = [];
        const calls: Array<{ type: "function_call"; call_id: string; name: string; arguments: string }> = [item];
        while (i + 1 < toolHistoryItems.length && toolHistoryItems[i + 1]?.type === "function_call") {
          i += 1;
          calls.push(toolHistoryItems[i] as any);
        }
        for (const c of calls) {
          let input: unknown = {};
          try {
            input = JSON.parse(c.arguments);
          } catch {
            input = { _raw: c.arguments };
          }
          content.push({
            type: "tool_use",
            id: c.call_id,
            name: c.name,
            input,
          });
        }
        messages.push({ role: "assistant", content });
        continue;
      }

      const content: AnthropicContentBlock[] = [];
      const outputs: Array<{ type: "function_call_output"; call_id: string; output: string }> = [item];
      while (i + 1 < toolHistoryItems.length && toolHistoryItems[i + 1]?.type === "function_call_output") {
        i += 1;
        outputs.push(toolHistoryItems[i] as any);
      }
      for (const o of outputs) {
        content.push({
          type: "tool_result",
          tool_use_id: o.call_id,
          content: o.output,
        });
      }
      messages.push({ role: "user", content });
    }
    return;
  }

  if (!toolCallItems?.length && !toolOutputs?.length) return;

  if (toolCallItems?.length) {
    const content: AnthropicContentBlock[] = toolCallItems.map((c) => {
      let input: unknown = {};
      try {
        input = JSON.parse(c.arguments);
      } catch {
        input = { _raw: c.arguments };
      }
      return {
        type: "tool_use",
        id: c.call_id,
        name: c.name,
        input,
      };
    });
    messages.push({ role: "assistant", content });
  }

  if (toolOutputs?.length) {
    const content: AnthropicContentBlock[] = toolOutputs.map((o) => ({
      type: "tool_result",
      tool_use_id: o.call_id,
      content: o.output,
    }));
    messages.push({ role: "user", content });
  }
}

function extractResult(resp: any): GenerateWithToolsResult {
  const blocks = Array.isArray(resp?.content) ? resp.content : [];

  const outputText = blocks
    .filter((b: any) => b?.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("");

  const toolCalls: FunctionToolCall[] = blocks
    .filter((b: any) => b?.type === "tool_use")
    .map((b: any) => {
      const input = b.input ?? {};
      return {
        name: String(b.name ?? ""),
        callId: String(b.id ?? ""),
        argumentsJson: JSON.stringify(input),
      };
    })
    .filter((c: FunctionToolCall) => c.name && c.callId);

  return { outputText, toolCalls };
}

export function createAnthropicMessagesClient(provider: ProviderConfig): LlmClient {
  assertAnthropic(provider);

  const baseUrl = (provider.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
  const version = provider.anthropicVersion ?? "2023-06-01";

  const createMessage = async (params: GenerateWithToolsParams): Promise<GenerateWithToolsResult> => {
    const { messages, model, temperature, systemPrompt, tools, toolHistoryItems, toolCallItems, toolOutputs } =
      params;

    const mapped = mapMessages(messages);
    const anthropicMessages = [...mapped.messages];
    appendToolCycle(anthropicMessages, toolHistoryItems, toolCallItems, toolOutputs);

    const system = [mapped.system, systemPrompt].filter(Boolean).join("\n\n").trim() || undefined;

    const payload: Record<string, unknown> = {
      model,
      max_tokens: 4096,
      messages: anthropicMessages,
      temperature,
      system,
      tools: convertFunctionTools(tools),
    };

    const res = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": provider.apiKey,
        "anthropic-version": version,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Anthropic messages error (${res.status}): ${text}`);
    }

    const json = await res.json();
    return extractResult(json);
  };

  return {
    async generateWithTools(params: GenerateWithToolsParams): Promise<GenerateWithToolsResult> {
      return createMessage(params);
    },
    async generateText({ messages, model, temperature, systemPrompt }) {
      const res = await createMessage({ messages, model, temperature, systemPrompt });
      if (res.toolCalls.length > 0) {
        throw new Error("generateText received tool calls; use generateWithTools for tool-enabled runs.");
      }
      if (!res.outputText) {
        throw new Error("Anthropic /v1/messages returned empty text output.");
      }
      return res.outputText;
    },
  };
}

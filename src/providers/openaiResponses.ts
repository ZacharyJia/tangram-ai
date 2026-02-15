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

function toOpenAIRole(msg: BaseMessage): "user" | "assistant" | "system" {
  const t = msg._getType();
  if (t === "human") return "user";
  if (t === "ai") return "assistant";
  return "system";
}

function coerceContentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (content == null) return "";
  // LangChain messages can hold structured content; MVP: stringify.
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function extractOutputText(resp: any): string {
  if (typeof resp?.output_text === "string" && resp.output_text.length > 0) {
    return resp.output_text;
  }

  const out = resp?.output;
  if (!Array.isArray(out)) return "";

  const chunks: string[] = [];
  for (const item of out) {
    if (!item || item.type !== "message") continue;
    const content = item.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (!c) continue;
      if (c.type === "output_text" && typeof c.text === "string") {
        chunks.push(c.text);
      } else if (typeof c.text === "string") {
        chunks.push(c.text);
      }
    }
  }

  return chunks.join("");
}

function extractFunctionToolCalls(resp: any): FunctionToolCall[] {
  const out = resp?.output;
  if (!Array.isArray(out)) return [];

  const calls: FunctionToolCall[] = [];
  for (const item of out) {
    if (!item || item.type !== "function_call") continue;
    const name = item.name;
    const callId = item.call_id;
    const argumentsJson = item.arguments;
    if (typeof name === "string" && typeof callId === "string" && typeof argumentsJson === "string") {
      calls.push({ name, callId, argumentsJson });
    }
  }
  return calls;
}

function shouldFallbackToStreaming(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // Some OpenAI-compatible gateways return SSE even when stream=false.
  // The OpenAI SDK then can surface a runtime error during the post-processing
  // step that checks `'object' in rsp`.
  return (
    msg.includes("Cannot use 'in' operator to search for 'object' in event:") ||
    msg.includes("event: response.") ||
    msg.includes("data: {\"type\":\"response.")
  );
}

export function createOpenAIResponsesClient(provider: ProviderConfig): LlmClient {
  if (provider.type !== "openai") {
    throw new Error(`createOpenAIResponsesClient: unsupported provider type '${(provider as any).type}'`);
  }

  if (provider.responsesApi?.enabled === false) {
    throw new Error(
      "Provider type 'openai' uses OpenAI Responses API. Set providers.<key>.responsesApi.enabled=true (or remove it), or use provider type 'openai-chat-completions'."
    );
  }

  const client = new OpenAI({
    apiKey: provider.apiKey,
    baseURL: provider.baseUrl,
  });

  const createResponse = async (params: GenerateWithToolsParams): Promise<GenerateWithToolsResult> => {
    const { messages, model, temperature, systemPrompt, tools, toolHistoryItems, toolCallItems, toolOutputs } =
      params;
    const messageItems: OpenAI.Responses.EasyInputMessage[] = messages.map((m) => ({
      type: "message" as const,
      role: toOpenAIRole(m),
      content: coerceContentToString((m as any).content),
    }));

    const toolInputItems =
      toolHistoryItems && toolHistoryItems.length > 0 ? toolHistoryItems : [...(toolCallItems ?? []), ...(toolOutputs ?? [])];

    const input: OpenAI.Responses.ResponseInputItem[] = [
      ...messageItems,
      ...(toolInputItems as any),
    ];

    const functionTools: OpenAI.Responses.FunctionTool[] | undefined = tools?.map((t: FunctionToolDef) => ({
      type: "function" as const,
      name: t.name,
      description: t.description,
      parameters: t.parameters ?? null,
      strict: t.strict ?? true,
    }));

    try {
      const resp = await client.responses.create({
        model,
        input,
        instructions: systemPrompt,
        temperature,
        tools: functionTools,
        tool_choice: functionTools && functionTools.length > 0 ? "auto" : undefined,
        stream: false,
      });

      return {
        outputText: extractOutputText(resp),
        toolCalls: extractFunctionToolCalls(resp),
      };
    } catch (err) {
      if (!shouldFallbackToStreaming(err)) throw err;

      const stream = await client.responses.create({
        model,
        input,
        instructions: systemPrompt,
        temperature,
        tools: functionTools,
        tool_choice: functionTools && functionTools.length > 0 ? "auto" : undefined,
        stream: true,
      });

      let acc = "";
      let doneText = "";
      let finalResponse: any | undefined;

      for await (const event of stream as any) {
        if (event?.type === "response.output_text.delta" && typeof event.delta === "string") {
          acc += event.delta;
        }
        if (event?.type === "response.output_text.done" && typeof event.text === "string") {
          doneText = event.text;
        }
        if (event?.type === "response.completed" && event.response) {
          finalResponse = event.response;
          break;
        }
        if (event?.type === "response.failed" && event.response) {
          finalResponse = event.response;
          break;
        }
      }

      const outputText = finalResponse ? extractOutputText(finalResponse) : doneText || acc;
      const toolCalls = finalResponse ? extractFunctionToolCalls(finalResponse) : [];
      return { outputText, toolCalls };
    }
  };

  return {
    async generateWithTools(params: GenerateWithToolsParams): Promise<GenerateWithToolsResult> {
      return createResponse(params);
    },
    async generateText({ messages, model, temperature, systemPrompt }) {
      const res = await createResponse({ messages, model, temperature, systemPrompt });
      if (res.toolCalls.length > 0) {
        throw new Error("generateText received tool calls; use generateWithTools for tool-enabled runs.");
      }
      if (!res.outputText) {
        throw new Error("OpenAI responses.create returned empty output_text.");
      }
      return res.outputText;
    },
  };
}

import OpenAI from "openai";
import type { BaseMessage } from "@langchain/core/messages";

import type { LlmClient } from "./types.js";
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
      "This MVP only supports OpenAI Responses API. Set providers.<key>.responsesApi.enabled=true (or remove it)."
    );
  }

  const client = new OpenAI({
    apiKey: provider.apiKey,
    baseURL: provider.baseUrl,
  });

  return {
    async generateText({ messages, model, temperature, systemPrompt }) {
      const input: OpenAI.Responses.EasyInputMessage[] = messages.map((m) => ({
        type: "message" as const,
        role: toOpenAIRole(m),
        content: coerceContentToString((m as any).content),
      }));

      try {
        const resp = await client.responses.create({
          model,
          input,
          // "instructions" is the system-level prompt in Responses API.
          instructions: systemPrompt,
          temperature,
          stream: false,
        });

        const text = extractOutputText(resp);
        if (!text) {
          throw new Error("OpenAI responses.create returned empty output_text.");
        }
        return text;
      } catch (err) {
        if (!shouldFallbackToStreaming(err)) throw err;

        const stream = await client.responses.create({
          model,
          input,
          instructions: systemPrompt,
          temperature,
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

        const text = finalResponse ? extractOutputText(finalResponse) : doneText || acc;
        if (!text) {
          throw new Error("OpenAI responses streaming returned empty output_text.");
        }
        return text;
      }
    },
  };
}

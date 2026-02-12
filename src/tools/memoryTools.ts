import { z } from "zod";

import type { FunctionToolCall, FunctionToolDef } from "../providers/types.js";
import type { MemoryStore } from "../memory/store.js";

const MemoryWriteArgs = z
  .object({
    scope: z.enum(["daily", "long_term"]),
    content: z.string().min(1),
  })
  .strict();

const MemorySearchArgs = z
  .object({
    query: z.string().min(1),
    days: z
      .preprocess((v) => (typeof v === "string" ? Number(v) : v), z.number().int().min(0).max(3650))
      .optional()
      .default(30),
    maxResults: z
      .preprocess((v) => (typeof v === "string" ? Number(v) : v), z.number().int().min(1).max(50))
      .optional()
      .default(10),
  })
  .strict();

export const memoryToolDefs: FunctionToolDef[] = [
  {
    name: "memory_write",
    description:
      "Write shared memory for Tangram. Use scope='daily' for today's notes or scope='long_term' for durable preferences/decisions. Do not store secrets.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        scope: { type: "string", enum: ["daily", "long_term"] },
        content: { type: "string", description: "Plain text to append." },
      },
      required: ["scope", "content"],
    },
  },
  {
    name: "memory_search",
    description:
      "Search shared memory files (memory.md and recent daily notes) and return matching snippets. Use this to recall past details.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string" },
        days: {
          type: "integer",
          minimum: 0,
          maximum: 3650,
          description: "How many days of daily notes to search; 0 means search all existing daily files.",
        },
        maxResults: { type: "integer", minimum: 1, maximum: 50 },
      },
      required: ["query", "days", "maxResults"],
    },
  },
];

function safeJsonParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

export async function executeMemoryTool(call: FunctionToolCall, memory: MemoryStore): Promise<string> {
  if (call.name === "memory_write") {
    const parsed = MemoryWriteArgs.safeParse(safeJsonParse(call.argumentsJson));
    if (!parsed.success) {
      return `Invalid arguments for memory_write: ${parsed.error.toString()}`;
    }
    const { scope, content } = parsed.data;
    if (scope === "daily") {
      await memory.appendToday(content);
      return "OK: wrote to today's memory.";
    }
    await memory.appendLongTerm(content);
    return "OK: wrote to long-term memory.";
  }

  if (call.name === "memory_search") {
    const parsed = MemorySearchArgs.safeParse(safeJsonParse(call.argumentsJson));
    if (!parsed.success) {
      return `Invalid arguments for memory_search: ${parsed.error.toString()}`;
    }
    const { query, days, maxResults } = parsed.data;
    return memory.search(query, { days, maxResults });
  }

  return `Unknown tool: ${call.name}`;
}

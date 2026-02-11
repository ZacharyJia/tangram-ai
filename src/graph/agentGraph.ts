import { Annotation, END, MemorySaver, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { AIMessage, HumanMessage } from "@langchain/core/messages";

import type { AppConfig } from "../config/schema.js";
import type { LlmClient } from "../providers/types.js";
import { getProvider } from "../providers/registry.js";
import type { MemoryStore } from "../memory/store.js";
import { executeMemoryTool, memoryToolDefs } from "../tools/memoryTools.js";

type ToolCallState = {
  name: string;
  callId: string;
  argumentsJson: string;
};

const GraphState = Annotation.Root({
  ...MessagesAnnotation.spec,
  lastReply: Annotation<string>({
    reducer: (_prev, next) => (typeof next === "string" ? next : ""),
    default: () => "",
  }),
  pendingToolCalls: Annotation<ToolCallState[]>({
    reducer: (_prev, next) => (Array.isArray(next) ? next : []),
    default: () => [],
  }),
  toolCallItems: Annotation<Array<{ type: "function_call"; call_id: string; name: string; arguments: string }>>({
    reducer: (_prev, next) => (Array.isArray(next) ? next : []),
    default: () => [],
  }),
  toolOutputs: Annotation<Array<{ type: "function_call_output"; call_id: string; output: string }>>({
    reducer: (_prev, next) => (Array.isArray(next) ? next : []),
    default: () => [],
  }),
});

export type AgentGraphState = typeof GraphState.State;

function buildInstructions(base: string | undefined, memoryContext: string): string | undefined {
  const baseTrimmed = (base ?? "").trim();
  const memTrimmed = (memoryContext ?? "").trim();

  const toolHint = [
    "# Tools",
    "You may use these tools when helpful:",
    "- memory_search: search shared memory files to recall past details",
    "- memory_write: write stable facts/preferences/decisions to shared memory",
    "Do NOT store secrets (API keys, tokens, passwords).",
  ].join("\n");

  if (!baseTrimmed && !memTrimmed) return toolHint;
  if (!memTrimmed) return `${baseTrimmed}\n\n---\n\n${toolHint}`;
  if (!baseTrimmed) return `# Memory\n\n${memTrimmed}\n\n---\n\n${toolHint}`;
  return `${baseTrimmed}\n\n---\n\n# Memory\n\n${memTrimmed}\n\n---\n\n${toolHint}`;
}

export function createAgentGraph(config: AppConfig, llm: LlmClient, memory?: MemoryStore) {
  const agentDefaults = config.agents.defaults;
  const provider = getProvider(config, agentDefaults.provider);

  const model = agentDefaults.model ?? provider.defaultModel;
  if (!model) {
    throw new Error(
      `No model configured. Set agents.defaults.model or providers['${agentDefaults.provider}'].defaultModel.`
    );
  }

  const graph = new StateGraph(GraphState)
    .addNode("llm", async (state) => {
      const memoryContext = memory ? await memory.getMemoryContext() : "";
      const instructions = buildInstructions(agentDefaults.systemPrompt, memoryContext);

      const res = await llm.generateWithTools({
        messages: state.messages,
        model,
        temperature: agentDefaults.temperature,
        systemPrompt: instructions,
        tools: memory ? memoryToolDefs : undefined,
        toolCallItems: state.toolCallItems,
        toolOutputs: state.toolOutputs,
      });

      const toolCalls = res.toolCalls.map((c) => ({
        name: c.name,
        callId: c.callId,
        argumentsJson: c.argumentsJson,
      }));

      const toolCallItems = res.toolCalls.map((c) => ({
        type: "function_call" as const,
        call_id: c.callId,
        name: c.name,
        arguments: c.argumentsJson,
      }));

      // Only commit assistant messages to history when the model is done calling tools.
      if (toolCalls.length === 0) {
        const text = res.outputText || "";
        return {
          messages: [new AIMessage(text)],
          lastReply: text,
          pendingToolCalls: [],
          toolCallItems: [],
          toolOutputs: [],
        };
      }

      return {
        pendingToolCalls: toolCalls,
        toolCallItems,
        lastReply: "",
        // Tool outputs were consumed by this LLM call.
        toolOutputs: [],
      };
    })
    .addNode("tools", async (state) => {
      if (!memory) {
        return { pendingToolCalls: [], toolOutputs: [] };
      }

      const outputs: Array<{ type: "function_call_output"; call_id: string; output: string }> = [];
      for (const call of state.pendingToolCalls) {
        const output = await executeMemoryTool(
          { name: call.name, callId: call.callId, argumentsJson: call.argumentsJson },
          memory
        );
        outputs.push({ type: "function_call_output", call_id: call.callId, output });
      }

      return {
        pendingToolCalls: [],
        toolOutputs: outputs,
      };
    })
    .addNode("memory_reflect", async (state) => {
      if (!memory) return {};

      // Reflect on the latest user<->assistant exchange and write durable memory.
      // This runs after we have produced a final assistant reply.
      const msgs = state.messages;
      const last = msgs[msgs.length - 1];
      const prev = msgs[msgs.length - 2];
      const userText = prev && prev._getType() === "human" ? String((prev as any).content ?? "") : "";
      const assistantText = last && last._getType() === "ai" ? String((last as any).content ?? "") : "";
      if (!userText && !assistantText) return {};

      const reflectionPrompt = [
        "You are tangram2's memory writer.",
        "<system-reminder>",
        "- Summarize useful info from this turn into shared memory.",
        "- Store stable facts, preferences, ongoing projects, decisions, TODOs.",
        "- Do NOT store secrets (API keys, tokens, passwords) or highly sensitive personal data.",
        "- If nothing should be remembered, output empty strings.",
        "- Output STRICT JSON ONLY with keys: daily, long_term.",
        "</system-reminder>",
      ].join("\n");

      const inputText = [
        "Turn:",
        `User: ${userText}`,
        `Assistant: ${assistantText}`,
      ].join("\n");

      let out: string;
      try {
        out = await llm.generateText({
          messages: [new HumanMessage(inputText)],
          model,
          temperature: 0.2,
          systemPrompt: reflectionPrompt,
        });
      } catch {
        return {};
      }

      const cleaned = out
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/```\s*$/i, "")
        .trim();

      let obj: any;
      try {
        obj = JSON.parse(cleaned);
      } catch {
        return {};
      }

      const daily = typeof obj?.daily === "string" ? obj.daily.trim() : "";
      const longTerm = typeof obj?.long_term === "string" ? obj.long_term.trim() : "";

      try {
        if (daily) await memory.appendToday(daily);
        if (longTerm) await memory.appendLongTerm(longTerm);
      } catch {
        // Don't break chat if memory writes fail.
      }

      return {};
    })
    .addEdge(START, "llm")
    .addConditionalEdges("llm", (state) => {
      return state.pendingToolCalls.length > 0 ? "tools" : "memory_reflect";
    })
    .addEdge("tools", "llm")
    .addEdge("memory_reflect", END);

  return graph.compile({
    checkpointer: new MemorySaver(),
  });
}

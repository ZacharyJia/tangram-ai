import { Annotation, END, MemorySaver, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { AIMessage } from "@langchain/core/messages";

import type { AppConfig } from "../config/schema.js";
import type { LlmClient } from "../providers/types.js";
import { getProvider } from "../providers/registry.js";
import type { MemoryStore } from "../memory/store.js";

const GraphState = Annotation.Root({
  ...MessagesAnnotation.spec,
  lastReply: Annotation<string>({
    reducer: (_prev, next) => (typeof next === "string" ? next : ""),
    default: () => "",
  }),
});

export type AgentGraphState = typeof GraphState.State;

function buildInstructions(base: string | undefined, memoryContext: string): string | undefined {
  const baseTrimmed = (base ?? "").trim();
  const memTrimmed = (memoryContext ?? "").trim();

  if (!baseTrimmed && !memTrimmed) return undefined;
  if (!memTrimmed) return baseTrimmed;
  if (!baseTrimmed) return `# Memory\n\n${memTrimmed}`;
  return `${baseTrimmed}\n\n---\n\n# Memory\n\n${memTrimmed}`;
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
    .addNode("respond", async (state) => {
      const memoryContext = memory ? await memory.getMemoryContext() : "";
      const instructions = buildInstructions(agentDefaults.systemPrompt, memoryContext);

      const text = await llm.generateText({
        messages: state.messages,
        model,
        temperature: agentDefaults.temperature,
        systemPrompt: instructions,
      });

      return {
        messages: [new AIMessage(text)],
        lastReply: text,
      };
    })
    .addEdge(START, "respond")
    .addEdge("respond", END);

  return graph.compile({
    checkpointer: new MemorySaver(),
  });
}

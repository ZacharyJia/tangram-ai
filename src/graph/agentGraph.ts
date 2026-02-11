import { Annotation, END, MemorySaver, MessagesAnnotation, START, StateGraph } from "@langchain/langgraph";
import { AIMessage, HumanMessage } from "@langchain/core/messages";

import type { AppConfig } from "../config/schema.js";
import type { LlmClient } from "../providers/types.js";
import { getProvider } from "../providers/registry.js";
import type { MemoryStore } from "../memory/store.js";
import { executeMemoryTool, memoryToolDefs } from "../tools/memoryTools.js";
import { executeFileTool, fileToolDefs } from "../tools/fileTools.js";
import { bashToolDefs, executeBashTool } from "../tools/bashTool.js";
import { cronToolDefs, executeCronTool } from "../tools/cronTools.js";
import { resolveSkillRoots } from "../skills/catalog.js";
import type { Logger } from "../utils/logger.js";
import type { CronStore } from "../scheduler/cronStore.js";

type ToolCallState = {
  name: string;
  callId: string;
  argumentsJson: string;
};

function clipForLog(text: string, maxChars = 4000): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}... [truncated ${text.length - maxChars} chars]`;
}

async function emitProgress(
  onProgress:
    | ((event: { kind: "assistant_explanation" | "tool_progress"; message: string }) => Promise<void> | void)
    | undefined,
  event: { kind: "assistant_explanation" | "tool_progress"; message: string },
  logger?: Logger
): Promise<void> {
  if (!onProgress) return;
  const text = event.message.trim();
  if (!text) return;

  try {
    await onProgress({ ...event, message: text });
  } catch (err) {
    logger?.warn("Progress callback failed", { message: (err as Error)?.message });
  }
}

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

function buildInstructions(
  base: string | undefined,
  memoryContext: string,
  skillsMetadata: string,
  hasFileTools: boolean,
  hasBashTool: boolean,
  hasCronTools: boolean
): string | undefined {
  const baseTrimmed = (base ?? "").trim();
  const memTrimmed = (memoryContext ?? "").trim();
  const skillsTrimmed = (skillsMetadata ?? "").trim();

  const blocks: string[] = [];

  if (baseTrimmed) {
    blocks.push(baseTrimmed);
  }

  if (memTrimmed) {
    blocks.push(`# Memory\n\n${memTrimmed}`);
  }

  if (skillsTrimmed) {
    blocks.push(skillsTrimmed);
  }

  const toolLines = [
    "# Tools",
    "You may use these tools when helpful:",
    "- memory_search: search shared memory files to recall past details",
    "- memory_write: write stable facts/preferences/decisions to shared memory",
    "Do NOT store secrets (API keys, tokens, passwords).",
  ];

  if (hasFileTools) {
    toolLines.splice(
      4,
      0,
      "- file_read: read skill files or other allowed local text files",
      "- file_write: write/update allowed local files when needed",
      "- file_edit: edit files by targeted replace operations"
    );
  }

  if (hasBashTool) {
    const insertAt = hasFileTools ? 6 : 4;
    toolLines.splice(insertAt, 0, "- bash: execute CLI commands in allowed directories");
  }

  if (hasCronTools) {
    const insertAt = hasFileTools ? (hasBashTool ? 7 : 6) : hasBashTool ? 5 : 4;
    toolLines.splice(
      insertAt,
      0,
      "- cron_schedule: schedule future or recurring task callbacks",
      "- cron_schedule_local: schedule with timezone local-time semantics",
      "- cron_list: list scheduled cron tasks",
      "- cron_cancel: cancel scheduled cron tasks"
    );
  }

  blocks.push(toolLines.join("\n"));

  return blocks.join("\n\n---\n\n");
}

export function createAgentGraph(
  config: AppConfig,
  llm: LlmClient,
  memory?: MemoryStore,
  skillsMetadata = "",
  logger?: Logger,
  cronStore?: CronStore
) {
  const agentDefaults = config.agents.defaults;
  const provider = getProvider(config, agentDefaults.provider);
  const skillRoots = resolveSkillRoots(config);
  const hasFileTools = skillRoots.length > 0;
  const shellCfg = agentDefaults.shell;
  const hasBashTool = Boolean(shellCfg?.enabled);
  const cronCfg = agentDefaults.cron;
  const hasCronTools = Boolean(cronCfg?.enabled && cronStore);

  const model = agentDefaults.model ?? provider.defaultModel;
  if (!model) {
    throw new Error(
      `No model configured. Set agents.defaults.model or providers['${agentDefaults.provider}'].defaultModel.`
    );
  }

  const graph = new StateGraph(GraphState)
    .addNode("llm", async (state, runtime) => {
      const onProgress = (runtime as any)?.configurable?.on_progress as
        | ((event: { kind: "assistant_explanation" | "tool_progress"; message: string }) => Promise<void> | void)
        | undefined;

      logger?.debug("Graph node: llm", {
        messageCount: state.messages.length,
        pendingToolCalls: state.pendingToolCalls.length,
      });
      const memoryContext = memory ? await memory.getMemoryContext() : "";
      const instructions = buildInstructions(
        agentDefaults.systemPrompt,
        memoryContext,
        skillsMetadata,
        hasFileTools,
        hasBashTool,
        hasCronTools
      );
      const tools = [
        ...(memory ? memoryToolDefs : []),
        ...(hasFileTools ? fileToolDefs : []),
        ...(hasBashTool ? bashToolDefs : []),
        ...(hasCronTools ? cronToolDefs : []),
      ];

      const res = await llm.generateWithTools({
        messages: state.messages,
        model,
        temperature: agentDefaults.temperature,
        systemPrompt: instructions,
        tools: tools.length > 0 ? tools : undefined,
        toolCallItems: state.toolCallItems,
        toolOutputs: state.toolOutputs,
      });

      const toolCalls = res.toolCalls.map((c) => ({
        name: c.name,
        callId: c.callId,
        argumentsJson: c.argumentsJson,
      }));
      logger?.debug("LLM returned", {
        outputLength: (res.outputText || "").length,
        toolCalls: toolCalls.map((c) => c.name),
      });
      for (const toolCall of toolCalls) {
        logger?.debug("LLM tool call detail", {
          name: toolCall.name,
          callId: toolCall.callId,
          argumentsJson: clipForLog(toolCall.argumentsJson),
        });
      }

      if (toolCalls.length > 0) {
        const explanation = (res.outputText || "").trim();
        if (explanation) {
          await emitProgress(
            onProgress,
            { kind: "assistant_explanation", message: explanation },
            logger
          );
        } else {
          await emitProgress(
            onProgress,
            { kind: "tool_progress", message: "正在调用工具处理你的请求…" },
            logger
          );
        }
      }

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
    .addNode("tools", async (state, runtime) => {
      const onProgress = (runtime as any)?.configurable?.on_progress as
        | ((event: { kind: "assistant_explanation" | "tool_progress"; message: string }) => Promise<void> | void)
        | undefined;

      logger?.debug("Graph node: tools", {
        pendingToolCalls: state.pendingToolCalls.map((c) => c.name),
      });
      if (!memory && skillRoots.length === 0 && !hasBashTool && !hasCronTools) {
        return { pendingToolCalls: [], toolOutputs: [] };
      }

      const outputs: Array<{ type: "function_call_output"; call_id: string; output: string }> = [];
      for (const call of state.pendingToolCalls) {
        let output: string;
        logger?.debug("Tool call dispatch", {
          name: call.name,
          callId: call.callId,
          argumentsJson: clipForLog(call.argumentsJson),
        });
        await emitProgress(
          onProgress,
          { kind: "tool_progress", message: `工具执行中：${call.name}` },
          logger
        );

        if (call.name === "memory_search" || call.name === "memory_write") {
          if (!memory) {
            output = "Memory tool unavailable: memory store is not initialized.";
          } else {
            logger?.debug("Execute memory tool", { name: call.name, callId: call.callId });
            output = await executeMemoryTool(
              { name: call.name, callId: call.callId, argumentsJson: call.argumentsJson },
              memory
            );
          }
        } else if (call.name === "file_read" || call.name === "file_write" || call.name === "file_edit") {
          logger?.debug("Execute file tool", { name: call.name, callId: call.callId });
          output = await executeFileTool(
            { name: call.name, callId: call.callId, argumentsJson: call.argumentsJson },
            { allowedRoots: skillRoots }
          );
        } else if (call.name === "bash") {
          logger?.debug("Execute bash tool", { name: call.name, callId: call.callId });
          output = await executeBashTool(
            { name: call.name, callId: call.callId, argumentsJson: call.argumentsJson },
            {
              enabled: Boolean(shellCfg?.enabled),
              fullAccess: Boolean(shellCfg?.fullAccess),
              roots: shellCfg?.roots ?? ["~/.tangram2"],
              defaultCwd: shellCfg?.defaultCwd ?? "~/.tangram2/workspace",
              timeoutMs: shellCfg?.timeoutMs ?? 120000,
              maxOutputChars: shellCfg?.maxOutputChars ?? 12000,
            }
          );
        } else if (
          call.name === "cron_schedule" ||
          call.name === "cron_schedule_local" ||
          call.name === "cron_list" ||
          call.name === "cron_cancel"
        ) {
          if (!cronStore) {
            output = "Cron tools unavailable: cron store is not initialized.";
          } else {
            logger?.debug("Execute cron tool", { name: call.name, callId: call.callId });
            output = await executeCronTool(
              { name: call.name, callId: call.callId, argumentsJson: call.argumentsJson },
              {
                enabled: Boolean(cronCfg?.enabled),
                store: cronStore,
                defaultThreadId: cronCfg?.defaultThreadId ?? "cron",
              }
            );
          }
        } else {
          output = `Unknown tool: ${call.name}`;
        }

        logger?.debug("Tool output ready", {
          name: call.name,
          callId: call.callId,
          outputLength: output.length,
          outputPreview: clipForLog(output),
        });
        const firstLine = output.split(/\r?\n/)[0]?.trim() || "(no output)";
        await emitProgress(
          onProgress,
          { kind: "tool_progress", message: `工具完成：${call.name} · ${clipForLog(firstLine, 160)}` },
          logger
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
      logger?.debug("Graph node: memory_reflect", { messageCount: state.messages.length });

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
        logger?.debug("Memory reflection written", {
          wroteDaily: Boolean(daily),
          wroteLongTerm: Boolean(longTerm),
        });
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

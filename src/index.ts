import "dotenv/config";

import { HumanMessage } from "@langchain/core/messages";

import { loadConfig } from "./config/load.js";
import { createLlmClient, getProvider } from "./providers/registry.js";
import { createAgentGraph } from "./graph/agentGraph.js";
import { startTelegramGateway } from "./channels/telegram.js";
import { MemoryStore } from "./memory/store.js";
import { discoverSkills, renderSkillsMetadata } from "./skills/catalog.js";
import { createLogger } from "./utils/logger.js";

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(...flags: string[]): boolean {
  return flags.some((flag) => process.argv.includes(flag));
}

function usage(exitCode = 0) {
  // Keep it minimal; this is an MVP.
  // eslint-disable-next-line no-console
  console.log(
    [
      "Usage:",
      "  npm run dev -- gateway [--config <path>] [--verbose|-v]",
      "",
      "Config lookup order:",
      "  1) --config <path>",
      "  2) $TANGRAM2_CONFIG",
      "  3) ~/.tangram2/config.json",
      "  4) ./config.json (legacy fallback)",
    ].join("\n")
  );
  process.exit(exitCode);
}

async function main() {
  const cmd = process.argv[2];
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    usage(0);
  }
  if (cmd !== "gateway") {
    // eslint-disable-next-line no-console
    console.error(`Unknown command: ${cmd}`);
    usage(1);
  }

  const configPath = getArg("--config");
  const verbose = hasFlag("--verbose", "-v");
  const logger = createLogger(verbose);
  const { config, configPath: loadedFrom } = await loadConfig(configPath);
  // eslint-disable-next-line no-console
  console.log(`Loaded config: ${loadedFrom}`);
  logger.info("Gateway bootstrap", { command: cmd, verbose: logger.enabled });

  const providerKey = config.agents.defaults.provider;
  const provider = getProvider(config, providerKey);
  const llm = createLlmClient(provider);

  const memory = new MemoryStore(config.agents.defaults.workspace);
  await memory.init();

  const skills = await discoverSkills(config);
  const skillsMetadata = renderSkillsMetadata(skills);
  // eslint-disable-next-line no-console
  console.log(`Discovered skills: ${skills.length}`);
  logger.info("Skills discovered", { count: skills.length });

  const graph = createAgentGraph(config, llm, memory, skillsMetadata, logger);

  const invoke = async ({ threadId, text }: { threadId: string; text: string }) => {
    const res = await graph.invoke(
      {
        messages: [new HumanMessage(text)],
      },
      {
        configurable: { thread_id: threadId },
      }
    );

    const lastReply = (res as any).lastReply as string | undefined;
    if (lastReply) return lastReply;

    // Fallback: pick the last AI message.
    const msgs = (res as any).messages as any[] | undefined;
    const last = Array.isArray(msgs) ? msgs[msgs.length - 1] : undefined;
    const content = last?.content;
    if (typeof content === "string" && content.length > 0) return content;
    return "(empty reply)";
  };

  if (config.channels.telegram?.enabled) {
    await startTelegramGateway(config, invoke, memory, logger);
    return;
  }

  throw new Error("No channels enabled. Enable channels.telegram.enabled to start the gateway.");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

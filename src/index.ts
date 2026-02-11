import "dotenv/config";

import { HumanMessage } from "@langchain/core/messages";

import { loadConfig } from "./config/load.js";
import { createLlmClient, getProvider } from "./providers/registry.js";
import { createAgentGraph } from "./graph/agentGraph.js";
import { startTelegramGateway } from "./channels/telegram.js";
import { MemoryStore } from "./memory/store.js";
import { SkillsRuntime } from "./skills/runtime.js";
import { createLogger } from "./utils/logger.js";
import { CronStore } from "./scheduler/cronStore.js";
import { CronRunner } from "./scheduler/cronRunner.js";
import { HeartbeatRunner } from "./scheduler/heartbeat.js";
import { runOnboard } from "./onboard/run.js";

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
      "  npm run dev -- onboard",
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

function supportsColor(): boolean {
  return Boolean(process.stderr.isTTY) && !process.env.NO_COLOR;
}

function formatSecurityWarning(message: string): string {
  if (!supportsColor()) return message;
  const red = "\x1b[31m";
  const yellow = "\x1b[33m";
  const bold = "\x1b[1m";
  const reset = "\x1b[0m";
  return `${bold}${red}⚠ SECURITY WARNING${reset} ${yellow}${message}${reset}`;
}

async function main() {
  const cmd = process.argv[2];
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    usage(0);
  }
  if (cmd === "onboard") {
    await runOnboard();
    return;
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

  if (config.agents.defaults.shell?.enabled && config.agents.defaults.shell?.fullAccess) {
    // Always print this warning, even when --verbose is disabled.
    // eslint-disable-next-line no-console
    console.warn(
      formatSecurityWarning(
        "shell.fullAccess=true: bash tool can execute commands in any local path. Use only in trusted environments."
      )
    );
  }

  logger.info("Gateway bootstrap", { command: cmd, verbose: logger.enabled });

  const providerKey = config.agents.defaults.provider;
  const provider = getProvider(config, providerKey);
  const llm = createLlmClient(provider);

  const memory = new MemoryStore(config.agents.defaults.workspace);
  await memory.init();

  const cronCfg = config.agents.defaults.cron;
  const cronStore = new CronStore(cronCfg.storePath);
  await cronStore.init();
  logger.info("Cron store ready", { path: cronStore.filePath });

  const skillsRuntime = new SkillsRuntime(config, logger);
  await skillsRuntime.start();
  const initialSkillsSnapshot = skillsRuntime.getSnapshot();
  // eslint-disable-next-line no-console
  console.log(`Discovered skills: ${initialSkillsSnapshot.skills.length}`);
  logger.info("Skills snapshot ready", {
    count: initialSkillsSnapshot.skills.length,
    version: initialSkillsSnapshot.version,
    updatedAt: initialSkillsSnapshot.updatedAt,
  });

  const graph = createAgentGraph(
    config,
    llm,
    memory,
    () => skillsRuntime.getSnapshot().metadata,
    logger,
    cronStore
  );

  const invoke = async ({
    threadId,
    text,
    onProgress,
  }: {
    threadId: string;
    text: string;
    onProgress?: (event: { kind: "assistant_explanation" | "tool_progress"; message: string }) => Promise<void> | void;
  }) => {
    const res = await graph.invoke(
      {
        messages: [new HumanMessage(text)],
      },
      {
        configurable: { thread_id: threadId, on_progress: onProgress },
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

  const heartbeatRunner = new HeartbeatRunner({
    enabled: Boolean(config.agents.defaults.heartbeat?.enabled),
    intervalSeconds: config.agents.defaults.heartbeat?.intervalSeconds ?? 300,
    filePath: config.agents.defaults.heartbeat?.filePath ?? "~/.tangram2/workspace/HEARTBEAT.md",
    threadId: config.agents.defaults.heartbeat?.threadId ?? "heartbeat",
    invoke,
    logger,
  });
  heartbeatRunner.start();

  const cronRunner = new CronRunner({
    enabled: Boolean(cronCfg?.enabled),
    tickSeconds: cronCfg?.tickSeconds ?? 15,
    store: cronStore,
    invoke,
    logger,
  });

  let telegramSender: { sendToThread: (params: { threadId: string; text: string }) => Promise<void> } | undefined;
  cronRunner.setOnTaskReply(async ({ threadId, taskId, reply }) => {
    if (!telegramSender) {
      logger.warn("Cron task reply skipped: telegram sender not ready", {
        taskId,
        threadId,
      });
      return;
    }

    const text = [`⏰ Cron task executed: ${taskId}`, "", reply].join("\n");
    try {
      await telegramSender.sendToThread({ threadId, text });
      logger.info("Cron task reply delivered", {
        taskId,
        threadId,
        replyLength: reply.length,
      });
    } catch (err) {
      logger.error("Cron task reply delivery failed", {
        taskId,
        threadId,
        message: (err as Error)?.message,
      });
    }
  });

  cronRunner.start();

  let shutdownDone = false;
  const shutdown = () => {
    if (shutdownDone) return;
    shutdownDone = true;
    heartbeatRunner.stop();
    cronRunner.stop();
    skillsRuntime.stop();
    logger.info("Gateway shutdown complete");
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.once("beforeExit", shutdown);

  if (config.channels.telegram?.enabled) {
    void startTelegramGateway(config, invoke, memory, logger)
      .then((telegram) => {
        telegramSender = telegram;
        logger.info("Telegram sender ready for cron replies");
      })
      .catch((err) => {
        logger.error("Telegram gateway failed to start", {
          message: (err as Error)?.message,
        });
        process.exit(1);
      });
    return;
  }

  throw new Error("No channels enabled. Enable channels.telegram.enabled to start the gateway.");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

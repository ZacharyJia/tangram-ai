#!/usr/bin/env node

import "dotenv/config";

import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

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
import { restartService, statusService, stopService } from "./deploy/systemdUser.js";
import { runRollback, runUpgrade } from "./deploy/upgrade.js";
import { SessionStore } from "./session/store.js";

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function hasFlag(...flags: string[]): boolean {
  return flags.some((flag) => process.argv.includes(flag));
}

type GatewaySubcommand = "status" | "stop" | "restart";

function parseGatewayArgs(): { subcommand?: GatewaySubcommand; unknownArg?: string } {
  const known = new Set(["status", "stop", "restart"]);
  let subcommand: GatewaySubcommand | undefined;

  for (let i = 3; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === "--config") {
      i += 1;
      continue;
    }
    if (arg.startsWith("--config=")) {
      continue;
    }
    if (arg === "--verbose" || arg === "-v") continue;
    if (arg.startsWith("-")) continue;
    if (known.has(arg)) {
      if (!subcommand) {
        subcommand = arg as GatewaySubcommand;
        continue;
      }
      return { subcommand, unknownArg: arg };
    }
    return { subcommand, unknownArg: arg };
  }
  return { subcommand };
}

function usage(exitCode = 0) {
  // Keep it minimal; this is an MVP.
  // eslint-disable-next-line no-console
  console.log(
    [
      "Usage:",
      "  tangram gateway [--config <path>] [--verbose|-v]",
      "  tangram gateway status|stop|restart",
      "  tangram onboard",
      "  tangram upgrade [--version <tag>] [--no-restart] [--dry-run]",
      "  tangram rollback [--to <tag>] [--no-restart]",
      "",
      "Config lookup order:",
      "  1) --config <path>",
      "  2) $TANGRAM_CONFIG",
      "  3) ~/.tangram/config.json",
      "  4) ./config.json (local fallback)",
    ].join("\n")
  );
  process.exit(exitCode);
}

async function runGatewayServiceCommand(action: "status" | "stop" | "restart"): Promise<void> {
  const result =
    action === "status" ? await statusService() : action === "stop" ? await stopService() : await restartService();

  if (result.stdout) {
    // eslint-disable-next-line no-console
    console.log(result.stdout);
  }
  if (result.stderr) {
    // eslint-disable-next-line no-console
    console.error(result.stderr);
  }
  if (result.code !== 0) {
    if (action === "status") {
      return;
    }
    throw new Error(
      `gateway ${action} failed (exit=${result.code}). If systemd --user is unavailable, use foreground mode: tangram gateway --verbose`
    );
  }
}

async function runUpgradeCommand(): Promise<void> {
  const version = getArg("--version");
  const dryRun = hasFlag("--dry-run");
  const noRestart = hasFlag("--no-restart");

  const result = await runUpgrade({
    version,
    dryRun,
    restart: !noRestart,
  });

  if (!result.changed) {
    // eslint-disable-next-line no-console
    console.log(`Already up to date: ${result.version}`);
    return;
  }

  // eslint-disable-next-line no-console
  console.log(
    [
      "Upgrade completed.",
      `- version: ${result.version}`,
      `- changed: ${result.changed}`,
      `- restarted: ${result.restarted}`,
      result.previousVersion ? `- previousVersion: ${result.previousVersion}` : "",
    ]
      .filter(Boolean)
      .join("\n")
  );
}

async function runRollbackCommand(): Promise<void> {
  const to = getArg("--to");
  const noRestart = hasFlag("--no-restart");

  const result = await runRollback({ to, restart: !noRestart });
  // eslint-disable-next-line no-console
  console.log(
    ["Rollback completed.", `- version: ${result.version}`, `- restarted: ${result.restarted}`].join("\n")
  );
}

async function runGatewayLoop(): Promise<void> {
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

  logger.info("Gateway bootstrap", { command: "gateway", verbose: logger.enabled });

  const providerKey = config.agents.defaults.provider;
  const provider = getProvider(config, providerKey);
  const llm = createLlmClient(provider);

  const memory = new MemoryStore(config.agents.defaults.workspace);
  await memory.init();

  const sessionCfg = config.agents.defaults.session;
  const sessionStore = sessionCfg?.enabled ? new SessionStore(sessionCfg.dir, logger) : undefined;
  if (sessionStore) {
    await sessionStore.init();
    logger.info("Session store ready", {
      dir: sessionStore.dir,
      restoreMessages: sessionCfg.restoreMessages,
      persistAssistantEmpty: sessionCfg.persistAssistantEmpty,
    });
  }

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
    let history: BaseMessage[] = [];
    if (sessionStore) {
      try {
        history = await sessionStore.loadRecentMessages(threadId, sessionCfg.restoreMessages);
      } catch (err) {
        logger.warn("Session restore failed", {
          threadId,
          message: (err as Error)?.message,
        });
      }
    }

    const res = await graph.invoke(
      {
        messages: [...history, new HumanMessage(text)],
      },
      {
        configurable: { thread_id: threadId, on_progress: onProgress },
      }
    );

    let rawReply = "";
    const lastReply = (res as any).lastReply as string | undefined;
    if (typeof lastReply === "string" && lastReply.length > 0) {
      rawReply = lastReply;
    } else {
      const msgs = (res as any).messages as any[] | undefined;
      const last = Array.isArray(msgs) ? msgs[msgs.length - 1] : undefined;
      const content = last?.content;
      if (typeof content === "string" && content.length > 0) {
        rawReply = content;
      }
    }

    const finalReply = rawReply || "(empty reply)";

    if (sessionStore) {
      const assistantText = rawReply || (sessionCfg.persistAssistantEmpty ? finalReply : "");
      void (async () => {
        try {
          await withTimeout(sessionStore.appendUserMessage(threadId, text), 1500, "session append user");
          if (assistantText) {
            await withTimeout(
              sessionStore.appendAssistantMessage(threadId, assistantText),
              1500,
              "session append assistant"
            );
          }
        } catch (err) {
          logger.warn("Session persist failed", {
            threadId,
            message: (err as Error)?.message,
          });
        }
      })();
    }

    return finalReply;
  };

  const heartbeatRunner = new HeartbeatRunner({
    enabled: Boolean(config.agents.defaults.heartbeat?.enabled),
    intervalSeconds: config.agents.defaults.heartbeat?.intervalSeconds ?? 300,
    filePath: config.agents.defaults.heartbeat?.filePath ?? "~/.tangram/workspace/HEARTBEAT.md",
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

  let telegramSender:
    | {
        sendToThread: (params: { threadId: string; text: string }) => Promise<void>;
        stop: () => void;
      }
    | undefined;
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
  const shutdown = (signal?: string) => {
    if (shutdownDone) return;
    shutdownDone = true;

    logger.info("Gateway shutdown start", { signal: signal ?? "unknown" });

    try {
      telegramSender?.stop();
    } catch (err) {
      logger.warn("Gateway shutdown: telegram stop failed", {
        message: (err as Error)?.message,
      });
    }

    heartbeatRunner.stop();
    cronRunner.stop();
    skillsRuntime.stop();
    logger.info("Gateway shutdown complete");
  };

  process.once("SIGINT", () => {
    shutdown("SIGINT");
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    shutdown("SIGTERM");
    process.exit(0);
  });
  process.once("beforeExit", () => shutdown("beforeExit"));

  if (config.channels.telegram?.enabled) {
    telegramSender = await startTelegramGateway(config, invoke, memory, logger);
    logger.info("Telegram sender ready for cron replies");
    return;
  }

  throw new Error("No channels enabled. Enable channels.telegram.enabled to start the gateway.");
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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

  if (cmd === "upgrade") {
    await runUpgradeCommand();
    return;
  }

  if (cmd === "rollback") {
    await runRollbackCommand();
    return;
  }

  if (cmd !== "gateway") {
    // eslint-disable-next-line no-console
    console.error(`Unknown command: ${cmd}`);
    usage(1);
  }

  const parsedGatewayArgs = parseGatewayArgs();
  const sub = parsedGatewayArgs.subcommand;
  if (sub === "status" || sub === "stop" || sub === "restart") {
    await runGatewayServiceCommand(sub);
    return;
  }

  if (parsedGatewayArgs.unknownArg) {
    throw new Error(`Unknown gateway subcommand: ${parsedGatewayArgs.unknownArg}`);
  }

  await runGatewayLoop();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

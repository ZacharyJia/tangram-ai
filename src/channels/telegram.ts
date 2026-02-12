import { Telegraf } from "telegraf";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import type { AppConfig } from "../config/schema.js";
import { splitTelegramMessage } from "../utils/telegram.js";
import { withKeyLock } from "../session/locks.js";
import type { SessionStore } from "../session/store.js";
import type { MemoryStore } from "../memory/store.js";
import type { Logger } from "../utils/logger.js";
import type { SkillSummary } from "../skills/catalog.js";

type InvokeFn = (params: {
  threadId: string;
  text: string;
  onProgress?: (event: { kind: "assistant_explanation" | "tool_progress"; message: string }) => Promise<void> | void;
}) => Promise<string>;

const TELEGRAM_HANDLER_TIMEOUT_MS = 10 * 60 * 1000;
const TELEGRAM_LAUNCH_TIMEOUT_MS = 120 * 1000;
const TELEGRAM_LAUNCH_MAX_ATTEMPTS = 5;
const TELEGRAM_LAUNCH_INITIAL_BACKOFF_MS = 2000;
const TELEGRAM_COMMAND_TIMEOUT_MS = 8 * 1000;
const TELEGRAM_COMMAND_MAX_ATTEMPTS = 3;
const TELEGRAM_COMMAND_INITIAL_BACKOFF_MS = 1500;

const TELEGRAM_COMMANDS = [
  { command: "new", description: "Start a new session" },
  { command: "whoami", description: "Show your Telegram identity" },
  { command: "skill", description: "List installed skills" },
  { command: "memory", description: "Show current memory context" },
  { command: "remember", description: "Save note to today's memory" },
  { command: "remember_long", description: "Save note to long-term memory" },
] as const;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${label} timeout after ${timeoutMs} milliseconds`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type TelegramPush = {
  sendToThread: (params: { threadId: string; text: string }) => Promise<void>;
  stop: () => void;
};

function createTypingLoop(ctx: any, chatId: string) {
  let stopped = false;

  const run = async () => {
    while (!stopped) {
      try {
        await ctx.telegram.sendChatAction(chatId, "typing");
      } catch {
      }
      await sleep(3500);
    }
  };

  void run();
  return () => {
    stopped = true;
  };
}

function resolveChatId(rawThreadId: string, fallbackThreadId?: string): number | string {
  const aliases = new Set(["current", "current_thread", "this_thread", "this"]);
  let effective = rawThreadId.trim();
  if (aliases.has(effective) && fallbackThreadId) {
    effective = fallbackThreadId;
  }

  if (/^-?\d+$/.test(effective)) {
    const asNum = Number(effective);
    if (Number.isSafeInteger(asNum)) {
      return asNum;
    }
  }

  return effective;
}

export async function startTelegramGateway(
  config: AppConfig,
  invoke: InvokeFn,
  memory: MemoryStore,
  sessionStore: SessionStore | undefined,
  getSkills: () => SkillSummary[],
  logger?: Logger
): Promise<TelegramPush> {
  const tg = config.channels.telegram;
  if (!tg?.enabled) {
    throw new Error("Telegram channel is not enabled in config.channels.telegram.enabled");
  }
  if (!tg.token) {
    throw new Error("Telegram token is required when channels.telegram.enabled=true");
  }

  const bot = new Telegraf(tg.token, {
    handlerTimeout: TELEGRAM_HANDLER_TIMEOUT_MS,
  });
  let lastSeenChatId: string | undefined;
  logger?.info("Telegram gateway starting", {
    allowFromCount: Array.isArray(tg.allowFrom) ? tg.allowFrom.length : 0,
    progressUpdates: tg.progressUpdates !== false,
  });

  const replyText = async (ctx: any, text: string) => {
    const safeText = text && text.length > 0 ? text : "(empty reply)";
    // Use a safety margin below Telegram's hard 4096-char limit.
    const parts = splitTelegramMessage(safeText, 3800);
    for (const part of parts) {
      await ctx.reply(part, { link_preview_options: { is_disabled: true } });
    }
  };

  const sendToThread = async ({ threadId, text }: { threadId: string; text: string }) => {
    const safeText = text && text.length > 0 ? text : "(empty reply)";
    const chatId = resolveChatId(threadId, lastSeenChatId);
    const parts = splitTelegramMessage(safeText, 3800);
    for (const part of parts) {
      await bot.telegram.sendMessage(chatId, part, { link_preview_options: { is_disabled: true } });
    }
  };

  const setCommands = async (label: string, extra?: Record<string, unknown>) => {
    await withTimeout(
      bot.telegram.setMyCommands(TELEGRAM_COMMANDS as any, extra as any),
      TELEGRAM_COMMAND_TIMEOUT_MS,
      `telegram setMyCommands (${label})`
    );
  };

  const registerCommandsWithRetry = async (): Promise<void> => {
    logger?.info("Telegram bot command registration started", {
      scopes: ["default", "all_private_chats"],
      commandCount: TELEGRAM_COMMANDS.length,
    });

    let backoffMs = TELEGRAM_COMMAND_INITIAL_BACKOFF_MS;
    for (let attempt = 1; attempt <= TELEGRAM_COMMAND_MAX_ATTEMPTS; attempt += 1) {
      logger?.info("Telegram bot command registration attempt", {
        attempt,
        maxAttempts: TELEGRAM_COMMAND_MAX_ATTEMPTS,
      });

      try {
        await setCommands("default");
        await setCommands("all_private_chats", {
          scope: { type: "all_private_chats" },
        });
        logger?.info("Telegram bot commands registered", {
          scopes: ["default", "all_private_chats"],
          commandCount: TELEGRAM_COMMANDS.length,
          attempt,
        });
        return;
      } catch (err) {
        const message = (err as Error)?.message ?? "unknown error";
        const finalAttempt = attempt >= TELEGRAM_COMMAND_MAX_ATTEMPTS;
        if (finalAttempt) {
          logger?.error("Telegram bot command registration failed", {
            attempt,
            maxAttempts: TELEGRAM_COMMAND_MAX_ATTEMPTS,
            message,
          });
          return;
        }

        logger?.warn("Telegram bot command registration failed, retrying", {
          attempt,
          maxAttempts: TELEGRAM_COMMAND_MAX_ATTEMPTS,
          backoffMs,
          message,
        });
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 10000);
      }
    }
  };

  bot.start(async (ctx) => {
    await replyText(ctx, "Connected. Send me a message.");
  });

  bot.catch((err, ctx) => {
    logger?.error("Telegram update handler failed", {
      message: (err as Error)?.message,
      updateType: ctx?.updateType,
      chatId: String(ctx?.chat?.id ?? ""),
      userId: String(ctx?.from?.id ?? ""),
    });
  });

  bot.command("memory", async (ctx) => {
    logger?.debug("Command /memory", {
      chatId: String(ctx.chat?.id ?? ""),
      userId: String(ctx.from?.id ?? ""),
    });
    const userId = ctx.from?.id != null ? String(ctx.from.id) : "";
    if (Array.isArray(tg.allowFrom) && tg.allowFrom.length > 0) {
      if (!userId || !tg.allowFrom.includes(userId)) {
        await replyText(ctx, "Not allowed.");
        return;
      }
    }

    const text = await withKeyLock("memory", async () => memory.getMemoryContext());
    if (!text) {
      await replyText(ctx, "(memory is empty)");
      return;
    }

    // Avoid spamming too many messages if memory grows large.
    const maxChars = 20000;
    const trimmed = text.length > maxChars ? text.slice(-maxChars) : text;
    const note = text.length > maxChars ? "(showing last 20000 chars)\n\n" : "";
    await replyText(ctx, note + trimmed);
  });

  bot.command("remember", async (ctx) => {
    logger?.debug("Command /remember", {
      chatId: String(ctx.chat?.id ?? ""),
      userId: String(ctx.from?.id ?? ""),
    });
    const userId = ctx.from?.id != null ? String(ctx.from.id) : "";
    if (Array.isArray(tg.allowFrom) && tg.allowFrom.length > 0) {
      if (!userId || !tg.allowFrom.includes(userId)) {
        await replyText(ctx, "Not allowed.");
        return;
      }
    }

    const raw = (ctx.message as any)?.text as string | undefined;
    const payload = raw?.replace(/^\/remember\s*/i, "").trim() ?? "";
    if (!payload) {
      await replyText(ctx, "Usage: /remember <text>");
      return;
    }

    await withKeyLock("memory", async () => memory.appendToday(payload));
    await replyText(ctx, "Saved to today's memory.");
  });

  bot.command("remember_long", async (ctx) => {
    logger?.debug("Command /remember_long", {
      chatId: String(ctx.chat?.id ?? ""),
      userId: String(ctx.from?.id ?? ""),
    });
    const userId = ctx.from?.id != null ? String(ctx.from.id) : "";
    if (Array.isArray(tg.allowFrom) && tg.allowFrom.length > 0) {
      if (!userId || !tg.allowFrom.includes(userId)) {
        await replyText(ctx, "Not allowed.");
        return;
      }
    }

    const raw = (ctx.message as any)?.text as string | undefined;
    const payload = raw?.replace(/^\/remember_long\s*/i, "").trim() ?? "";
    if (!payload) {
      await replyText(ctx, "Usage: /remember_long <text>");
      return;
    }

    await withKeyLock("memory", async () => memory.appendLongTerm(payload));
    await replyText(ctx, "Saved to long-term memory.");
  });

  bot.command("new", async (ctx) => {
    const chatId = String(ctx.chat?.id ?? "");
    const userId = ctx.from?.id != null ? String(ctx.from.id) : "";

    logger?.debug("Command /new", { chatId, userId });
    if (Array.isArray(tg.allowFrom) && tg.allowFrom.length > 0) {
      if (!userId || !tg.allowFrom.includes(userId)) {
        await replyText(ctx, "Not allowed.");
        return;
      }
    }

    if (!chatId) {
      await replyText(ctx, "Cannot resolve current chat id.");
      return;
    }

    if (!sessionStore) {
      await replyText(ctx, "Session persistence is disabled. No stored context to reset.");
      return;
    }

    await sessionStore.resetThread(chatId);
    await replyText(ctx, "Started a new session for this chat.");
  });

  bot.command("whoami", async (ctx) => {
    const chatId = String(ctx.chat?.id ?? "");
    const user = ctx.from;
    const lines = [
      "Current Telegram identity:",
      `- userId: ${user?.id != null ? String(user.id) : "(unknown)"}`,
      `- username: ${user?.username ? `@${user.username}` : "(none)"}`,
      `- firstName: ${user?.first_name ?? "(none)"}`,
      `- lastName: ${user?.last_name ?? "(none)"}`,
      `- languageCode: ${(user as any)?.language_code ?? "(none)"}`,
      `- chatId: ${chatId || "(unknown)"}`,
      `- chatType: ${(ctx.chat as any)?.type ?? "(unknown)"}`,
    ];
    await replyText(ctx, lines.join("\n"));
  });

  bot.command("skill", async (ctx) => {
    const userId = ctx.from?.id != null ? String(ctx.from.id) : "";

    if (Array.isArray(tg.allowFrom) && tg.allowFrom.length > 0) {
      if (!userId || !tg.allowFrom.includes(userId)) {
        await replyText(ctx, "Not allowed.");
        return;
      }
    }

    const skills = getSkills();
    if (!skills.length) {
      await replyText(ctx, "No skills installed.");
      return;
    }

    const lines = [
      `Installed skills (${skills.length}):`,
      ...skills.map((skill) => `- ${skill.name}: ${skill.description}`),
    ];
    await replyText(ctx, lines.join("\n"));
  });

  bot.on("text", async (ctx) => {
    const chatId = String(ctx.chat.id);
    lastSeenChatId = chatId;
    const userId = ctx.from?.id != null ? String(ctx.from.id) : "";
    const text = (ctx.message as any)?.text as string | undefined;
    if (!text) return;

    logger?.debug("Incoming text", {
      chatId,
      userId,
      length: text.length,
    });

    if (Array.isArray(tg.allowFrom) && tg.allowFrom.length > 0) {
      if (!userId || !tg.allowFrom.includes(userId)) {
        await replyText(ctx, "Not allowed.");
        return;
      }
    }

    try {
      const stopTyping = createTypingLoop(ctx, chatId);
      const progressThrottleMs = 1200;
      let lastProgressAt = 0;
      const progressEnabled = tg.progressUpdates !== false;

      const onProgress = async (event: { kind: "assistant_explanation" | "tool_progress"; message: string }) => {
        if (event.kind === "tool_progress" && !progressEnabled) return;
        const now = Date.now();
        if (now - lastProgressAt < progressThrottleMs) return;
        lastProgressAt = now;

        if (event.kind === "assistant_explanation") {
          await replyText(ctx, `💬 ${event.message}`);
          return;
        }

        await replyText(ctx, `⏳ ${event.message}`);
      };

      // Prevent concurrent invokes within a chat to keep ordering and memory sane.
      try {
        const reply = await withKeyLock(chatId, async () => invoke({ threadId: chatId, text, onProgress }));
        logger?.debug("Outgoing reply", { chatId, length: reply.length });
        await replyText(ctx, reply);
        logger?.debug("Outgoing reply delivered", { chatId, length: reply.length });
      } finally {
        stopTyping();
      }
    } catch (err) {
      // Avoid echoing huge payloads back to Telegram (which can recurse into the same error).
      // Log full error locally.
      const errorId = randomUUID().slice(0, 8);
      // eslint-disable-next-line no-console
      console.error(`[telegram][${errorId}]`, err);
      logger?.error("Invoke failed", { errorId, chatId, userId, message: (err as Error)?.message });

      // User-facing error should be short and never include provider payloads.
      const safe = `Provider error (${errorId}). Check server logs.`;
      try {
        await replyText(ctx, safe);
      } catch (inner) {
        // eslint-disable-next-line no-console
        console.error("Failed to send error message", inner);
      }
    }
  });

  let backoffMs = TELEGRAM_LAUNCH_INITIAL_BACKOFF_MS;
  let launched = false;
  for (let attempt = 1; attempt <= TELEGRAM_LAUNCH_MAX_ATTEMPTS; attempt += 1) {
    logger?.info("Telegram bot launch attempt", {
      attempt,
      maxAttempts: TELEGRAM_LAUNCH_MAX_ATTEMPTS,
    });
    try {
      let launchAcknowledged = false;
      const launchStart = new Promise<void>((resolve, reject) => {
        const runtime = bot.launch({}, () => {
          launchAcknowledged = true;
          resolve();
        });

        runtime.catch((err) => {
          if (launchAcknowledged) {
            logger?.error("Telegram bot runtime failed", {
              message: (err as Error)?.message,
            });
            return;
          }
          reject(err);
        });
      });

      await withTimeout(launchStart, TELEGRAM_LAUNCH_TIMEOUT_MS, "telegram launch start");
      logger?.info("Telegram bot launched", { attempt });
      launched = true;
      break;
    } catch (err) {
      const message = (err as Error)?.message ?? "unknown error";
      if (message.includes("timeout")) {
        logger?.error("Telegram bot launch timed out; aborting for clean restart", {
          attempt,
          maxAttempts: TELEGRAM_LAUNCH_MAX_ATTEMPTS,
          message,
        });
        throw err;
      }

      const finalAttempt = attempt >= TELEGRAM_LAUNCH_MAX_ATTEMPTS;
      if (finalAttempt) {
        logger?.error("Telegram bot launch failed", {
          attempt,
          maxAttempts: TELEGRAM_LAUNCH_MAX_ATTEMPTS,
          message,
        });
        throw err;
      }

      try {
        bot.stop("launch-retry");
      } catch {
      }

      logger?.warn("Telegram bot launch failed, retrying", {
        attempt,
        maxAttempts: TELEGRAM_LAUNCH_MAX_ATTEMPTS,
        backoffMs,
        message,
      });
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30000);
    }
  }

  if (!launched) {
    throw new Error("Telegram bot launch failed: exhausted retries");
  }

  void registerCommandsWithRetry();

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    bot.stop("SIGTERM");
    logger?.info("Telegram bot stopped");
  };

  return { sendToThread, stop };
}

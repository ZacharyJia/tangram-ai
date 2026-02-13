import { Telegraf } from "telegraf";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import https from "node:https";

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
const TELEGRAM_FORCE_IPV4 = process.env.TANGRAM_TELEGRAM_FORCE_IPV4 !== "0";

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

function maybeString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function compactMeta(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    out[key] = value;
  }
  return out;
}

function truncateForTelegram(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function describeError(err: unknown): { message: string; details: Record<string, unknown> } {
  const error = err as any;
  const message = maybeString(error?.message) ?? String(err);
  const causeMessage = maybeString(error?.cause?.message);
  const normalizedMessage =
    message.endsWith("reason: ") && causeMessage ? `${message}${causeMessage}` : message;

  const causeDetails = error?.cause
    ? compactMeta({
        name: maybeString(error.cause?.name),
        message: maybeString(error.cause?.message),
        code: maybeString(error.cause?.code),
        type: maybeString(error.cause?.type),
        errno: maybeString(error.cause?.errno),
        syscall: maybeString(error.cause?.syscall),
        stack: maybeString(error.cause?.stack),
      })
    : undefined;

  const details = compactMeta({
    name: maybeString(error?.name),
    message: maybeString(error?.message),
    code: maybeString(error?.code),
    type: maybeString(error?.type),
    errno: maybeString(error?.errno),
    syscall: maybeString(error?.syscall),
    stack: maybeString(error?.stack),
    cause: causeDetails,
  });

  return {
    message: normalizedMessage,
    details,
  };
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

  const telegramAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 10_000,
    family: TELEGRAM_FORCE_IPV4 ? 4 : 0,
  });

  const bot = new Telegraf(tg.token, {
    handlerTimeout: TELEGRAM_HANDLER_TIMEOUT_MS,
    telegram: {
      agent: telegramAgent,
    },
  });
  let lastSeenChatId: string | undefined;
  logger?.info("Telegram gateway starting", {
    allowFromCount: Array.isArray(tg.allowFrom) ? tg.allowFrom.length : 0,
    progressUpdates: tg.progressUpdates !== false,
    forceIpv4: TELEGRAM_FORCE_IPV4,
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

  const registerCommandsWithRetry = async (): Promise<boolean> => {
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
        return true;
      } catch (err) {
        const info = describeError(err);
        const message = info.message;
        const finalAttempt = attempt >= TELEGRAM_COMMAND_MAX_ATTEMPTS;
        if (finalAttempt) {
          logger?.error("Telegram bot command registration failed", {
            attempt,
            maxAttempts: TELEGRAM_COMMAND_MAX_ATTEMPTS,
            message,
            error: info.details,
          });
          return false;
        }

        logger?.warn("Telegram bot command registration failed, retrying", {
          attempt,
          maxAttempts: TELEGRAM_COMMAND_MAX_ATTEMPTS,
          backoffMs,
          message,
          error: info.details,
        });
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 10000);
      }
    }

    return false;
  };

  bot.start(async (ctx) => {
    await replyText(ctx, "Connected. Send me a message.");
  });

  bot.catch((err, ctx) => {
    const info = describeError(err);
    logger?.error("Telegram update handler failed", {
      message: info.message,
      updateType: ctx?.updateType,
      chatId: String(ctx?.chat?.id ?? ""),
      userId: String(ctx?.from?.id ?? ""),
      error: info.details,
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
      let progressRevision = 0;
      let progressDraftMessageId: number | undefined;
      let lastProgressDraftText = "";

      const upsertProgressDraft = async (text: string): Promise<void> => {
        const draft = truncateForTelegram(text, 1000);
        if (!draft || draft === lastProgressDraftText) return;

        try {
          if (!progressDraftMessageId) {
            const sent = await ctx.reply(draft, { link_preview_options: { is_disabled: true } });
            const sentMessageId = (sent as any)?.message_id;
            if (typeof sentMessageId === "number") {
              progressDraftMessageId = sentMessageId;
            }
          } else {
            await ctx.telegram.editMessageText(chatId, progressDraftMessageId, undefined, draft, {
              link_preview_options: { is_disabled: true },
            });
          }
          lastProgressDraftText = draft;
        } catch (err) {
          const message = (err as Error)?.message ?? String(err);
          if (message.includes("message is not modified")) return;
          logger?.warn("Telegram progress draft update failed", {
            chatId,
            message,
          });
        }
      };

      const onProgress = async (event: { kind: "assistant_explanation" | "tool_progress"; message: string }) => {
        if (event.kind === "tool_progress" && !progressEnabled) return;
        const now = Date.now();
        if (now - lastProgressAt < progressThrottleMs) return;
        lastProgressAt = now;
        progressRevision += 1;

        const base = `⏳ 正在调用工具处理你的请求… x${progressRevision}`;
        if (event.kind === "assistant_explanation") {
          const explanation = event.message.trim();
          const next = explanation ? `${base}\n💬 ${explanation}` : base;
          await upsertProgressDraft(next);
          return;
        }

        await upsertProgressDraft(base);
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

  const commandsRegistered = await registerCommandsWithRetry();
  logger?.info("Telegram bot command registration completed", {
    success: commandsRegistered,
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
            const info = describeError(err);
            logger?.error("Telegram bot runtime failed", {
              message: info.message,
              error: info.details,
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
      const info = describeError(err);
      const message = info.message;
      if (message.includes("timeout")) {
        logger?.error("Telegram bot launch timed out; aborting for clean restart", {
          attempt,
          maxAttempts: TELEGRAM_LAUNCH_MAX_ATTEMPTS,
          message,
          error: info.details,
        });
        throw err;
      }

      const finalAttempt = attempt >= TELEGRAM_LAUNCH_MAX_ATTEMPTS;
      if (finalAttempt) {
        logger?.error("Telegram bot launch failed", {
          attempt,
          maxAttempts: TELEGRAM_LAUNCH_MAX_ATTEMPTS,
          message,
          error: info.details,
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
        error: info.details,
      });
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30000);
    }
  }

  if (!launched) {
    throw new Error("Telegram bot launch failed: exhausted retries");
  }

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    bot.stop("SIGTERM");
    logger?.info("Telegram bot stopped");
  };

  return { sendToThread, stop };
}

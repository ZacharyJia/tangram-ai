import { Telegraf } from "telegraf";
import { randomUUID } from "node:crypto";

import type { AppConfig } from "../config/schema.js";
import { splitTelegramMessage } from "../utils/telegram.js";
import { withKeyLock } from "../session/locks.js";
import type { MemoryStore } from "../memory/store.js";
import type { Logger } from "../utils/logger.js";

type InvokeFn = (params: { threadId: string; text: string }) => Promise<string>;

export async function startTelegramGateway(
  config: AppConfig,
  invoke: InvokeFn,
  memory: MemoryStore,
  logger?: Logger
) {
  const tg = config.channels.telegram;
  if (!tg?.enabled) {
    throw new Error("Telegram channel is not enabled in config.channels.telegram.enabled");
  }

  const bot = new Telegraf(tg.token);
  logger?.info("Telegram gateway starting", {
    allowFromCount: Array.isArray(tg.allowFrom) ? tg.allowFrom.length : 0,
  });

  const replyText = async (ctx: any, text: string) => {
    const safeText = text && text.length > 0 ? text : "(empty reply)";
    // Use a safety margin below Telegram's hard 4096-char limit.
    const parts = splitTelegramMessage(safeText, 3800);
    for (const part of parts) {
      await ctx.reply(part, { link_preview_options: { is_disabled: true } });
    }
  };

  bot.start(async (ctx) => {
    await replyText(ctx, "Connected. Send me a message.");
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

  bot.on("text", async (ctx) => {
    const chatId = String(ctx.chat.id);
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
      // Prevent concurrent invokes within a chat to keep ordering and memory sane.
      const reply = await withKeyLock(chatId, async () => invoke({ threadId: chatId, text }));
      logger?.debug("Outgoing reply", { chatId, length: reply.length });
      await replyText(ctx, reply);
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

  await bot.launch();
  logger?.info("Telegram bot launched");

  // Graceful shutdown.
  const stop = () => bot.stop("SIGTERM");
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

import { z } from "zod";

import type { FunctionToolCall, FunctionToolDef } from "../providers/types.js";
import type { CronRepeat, CronStore } from "../scheduler/cronStore.js";
import { assertValidTimeZone, localDateTimeToUtcIso, nextLocalTimeUtcIso } from "../scheduler/timezone.js";

const CronScheduleArgs = z
  .object({
    id: z.string(),
    runAt: z.string().min(1),
    message: z.string().min(1),
    threadId: z.string(),
    repeat: z
      .object({
        mode: z.enum(["once", "interval"]),
        everySeconds: z.number().int().min(0).max(365 * 24 * 3600),
      })
      .strict(),
    enabled: z.boolean(),
  })
  .strict();

const CronCancelArgs = z
  .object({
    id: z.string().min(1),
  })
  .strict();

const CronScheduleLocalArgs = z
  .object({
    id: z.string(),
    timezone: z.string().min(1),
    localTime: z.string().min(1),
    localDate: z.string().optional(),
    message: z.string().min(1),
    threadId: z.string(),
    repeatMode: z.enum(["once", "daily"]),
    enabled: z.boolean(),
  })
  .strict();

const CronListArgs = z
  .object({
    limit: z.number().int().min(1).max(200).optional().default(20),
  })
  .strict();

export const cronToolDefs: FunctionToolDef[] = [
  {
    name: "cron_schedule",
    description:
      "Schedule or update a cron task. Provide runAt (ISO datetime), message payload, optional threadId, and repeat settings.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string" },
        runAt: { type: "string", description: "ISO datetime, e.g. 2026-02-12T03:00:00Z" },
        message: { type: "string" },
        threadId: { type: "string" },
        repeat: {
          type: "object",
          additionalProperties: false,
          properties: {
            mode: { type: "string", enum: ["once", "interval"] },
            everySeconds: { type: "integer", minimum: 5 },
          },
          required: ["mode", "everySeconds"],
        },
        enabled: { type: "boolean" },
      },
      required: ["id", "runAt", "message", "threadId", "repeat", "enabled"],
    },
  },
  {
    name: "cron_schedule_local",
    description:
      "Schedule task using local timezone semantics. Supports one-time local date+time or recurring daily local time.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string" },
        timezone: { type: "string", description: "IANA timezone, e.g. Asia/Shanghai" },
        localTime: { type: "string", description: "HH:mm" },
        localDate: { type: "string", description: "YYYY-MM-DD (required for once mode)" },
        message: { type: "string" },
        threadId: { type: "string" },
        repeatMode: { type: "string", enum: ["once", "daily"] },
        enabled: { type: "boolean" },
      },
      required: ["id", "timezone", "localTime", "localDate", "message", "threadId", "repeatMode", "enabled"],
    },
  },
  {
    name: "cron_list",
    description: "List scheduled cron tasks.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 200, default: 20 },
      },
      required: ["limit"],
    },
  },
  {
    name: "cron_cancel",
    description: "Cancel a scheduled cron task by id.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string" },
      },
      required: ["id"],
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

function normalizeRepeat(repeat: { mode: "once" | "interval"; everySeconds: number }): CronRepeat {
  if (repeat.mode === "once") {
    return { mode: "once" };
  }
  const sec = repeat.everySeconds;
  if (!Number.isInteger(sec) || sec < 5) {
    throw new Error("repeat.everySeconds is required for interval mode and must be >= 5");
  }
  return { mode: "interval", everySeconds: sec };
}

function formatRepeat(repeat: CronRepeat): string {
  if (repeat.mode === "once") return "once";
  if (repeat.mode === "interval") return `interval/${repeat.everySeconds}s`;
  return `daily_local/${repeat.localTime} ${repeat.timezone}`;
}

export async function executeCronTool(
  call: FunctionToolCall,
  opts: { enabled: boolean; store: CronStore; defaultThreadId: string }
): Promise<string> {
  if (!opts.enabled) {
    return "cron tools disabled by config.agents.defaults.cron.enabled=false";
  }

  if (call.name === "cron_schedule") {
    const parsed = CronScheduleArgs.safeParse(safeJsonParse(call.argumentsJson));
    if (!parsed.success) {
      return `Invalid arguments for cron_schedule: ${parsed.error.toString()}`;
    }

    try {
      const repeat = normalizeRepeat(parsed.data.repeat);
      const id = parsed.data.id.trim();
      const threadId = parsed.data.threadId.trim() || opts.defaultThreadId;
      const task = await opts.store.schedule({
        id: id || undefined,
        runAt: parsed.data.runAt,
        message: parsed.data.message,
        threadId,
        repeat,
        enabled: parsed.data.enabled,
      });

      return [
        "OK: cron task scheduled",
        `id: ${task.id}`,
        `threadId: ${task.threadId}`,
        `nextRunAt: ${task.nextRunAt}`,
        `repeat: ${formatRepeat(task.repeat)}`,
        `enabled: ${task.enabled}`,
      ].join("\n");
    } catch (err) {
      return `cron_schedule failed: ${(err as Error).message}`;
    }
  }

  if (call.name === "cron_schedule_local") {
    const parsed = CronScheduleLocalArgs.safeParse(safeJsonParse(call.argumentsJson));
    if (!parsed.success) {
      return `Invalid arguments for cron_schedule_local: ${parsed.error.toString()}`;
    }

    try {
      assertValidTimeZone(parsed.data.timezone);

      const id = parsed.data.id.trim();
      const threadId = parsed.data.threadId.trim() || opts.defaultThreadId;
      const repeatMode = parsed.data.repeatMode;

      let runAt: string;
      let repeat: CronRepeat;

      if (repeatMode === "once") {
        const localDate = (parsed.data.localDate ?? "").trim();
        if (!localDate) {
          return "cron_schedule_local failed: localDate is required when repeatMode='once'";
        }
        runAt = localDateTimeToUtcIso({
          timezone: parsed.data.timezone,
          localDate,
          localTime: parsed.data.localTime,
        });
        repeat = { mode: "once" };
      } else {
        runAt = nextLocalTimeUtcIso({
          timezone: parsed.data.timezone,
          localTime: parsed.data.localTime,
        });
        repeat = {
          mode: "daily_local",
          timezone: parsed.data.timezone,
          localTime: parsed.data.localTime,
        };
      }

      const task = await opts.store.schedule({
        id: id || undefined,
        runAt,
        message: parsed.data.message,
        threadId,
        repeat,
        enabled: parsed.data.enabled,
      });

      return [
        "OK: cron local task scheduled",
        `id: ${task.id}`,
        `threadId: ${task.threadId}`,
        `timezone: ${parsed.data.timezone}`,
        `localTime: ${parsed.data.localTime}`,
        `nextRunAtUtc: ${task.nextRunAt}`,
        `repeat: ${repeatMode === "daily" ? "daily_local" : "once"}`,
        `enabled: ${task.enabled}`,
      ].join("\n");
    } catch (err) {
      return `cron_schedule_local failed: ${(err as Error).message}`;
    }
  }

  if (call.name === "cron_list") {
    const parsed = CronListArgs.safeParse(safeJsonParse(call.argumentsJson) ?? {});
    if (!parsed.success) {
      return `Invalid arguments for cron_list: ${parsed.error.toString()}`;
    }

    const tasks = opts.store.list(parsed.data.limit);
    if (!tasks.length) return "No cron tasks.";

    return [
      `Cron tasks: ${tasks.length}`,
      "",
      ...tasks.map(
        (t) =>
          `- id=${t.id} enabled=${t.enabled} next=${t.nextRunAt} repeat=${formatRepeat(
            t.repeat
          )} threadId=${t.threadId}`
      ),
    ].join("\n");
  }

  if (call.name === "cron_cancel") {
    const parsed = CronCancelArgs.safeParse(safeJsonParse(call.argumentsJson));
    if (!parsed.success) {
      return `Invalid arguments for cron_cancel: ${parsed.error.toString()}`;
    }

    const removed = await opts.store.cancel(parsed.data.id);
    return removed ? `OK: canceled cron task ${parsed.data.id}` : `Task not found: ${parsed.data.id}`;
  }

  return `Unknown tool: ${call.name}`;
}

import { z } from "zod";

import type { FunctionToolCall, FunctionToolDef } from "../providers/types.js";
import type { CronRepeat, CronStore } from "../scheduler/cronStore.js";
import { assertValidTimeZone, localDateTimeToUtcIso, nextLocalTimeUtcIso } from "../scheduler/timezone.js";

const CronScheduleArgs = z
  .object({
    id: z.string(),
    runAt: z.string().min(1),
    callbackPrompt: z.string().min(1),
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

const CronScheduleArgsLegacy = z
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
    callbackPrompt: z.string().min(1),
    threadId: z.string(),
    repeatMode: z.enum(["once", "daily"]),
    enabled: z.boolean(),
  })
  .strict();

const CronScheduleLocalArgsLegacy = z
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
      "Schedule or update a cron task. callbackPrompt is callback text sent to the model at trigger time (not a direct user message).",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string" },
        runAt: { type: "string", description: "ISO datetime, e.g. 2026-02-12T03:00:00Z" },
        callbackPrompt: {
          type: "string",
          description:
            "Prompt payload for future model execution when task is due; this is NOT sent directly to end users.",
        },
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
      required: ["id", "runAt", "callbackPrompt", "threadId", "repeat", "enabled"],
    },
  },
  {
    name: "cron_schedule_local",
    description:
      "Schedule task using local timezone semantics. callbackPrompt is callback text for model execution at trigger time, not a direct user message.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string" },
        timezone: { type: "string", description: "IANA timezone, e.g. Asia/Shanghai" },
        localTime: { type: "string", description: "HH:mm" },
        localDate: { type: "string", description: "YYYY-MM-DD (required for once mode)" },
        callbackPrompt: {
          type: "string",
          description:
            "Prompt payload for future model execution when task is due; this is NOT sent directly to end users.",
        },
        threadId: { type: "string" },
        repeatMode: { type: "string", enum: ["once", "daily"] },
        enabled: { type: "boolean" },
      },
      required: [
        "id",
        "timezone",
        "localTime",
        "localDate",
        "callbackPrompt",
        "threadId",
        "repeatMode",
        "enabled",
      ],
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

function parseCronScheduleInput(input: unknown):
  | {
      ok: true;
      value: {
        id: string;
        runAt: string;
        callbackPrompt: string;
        threadId: string;
        repeat: { mode: "once" | "interval"; everySeconds: number };
        enabled: boolean;
      };
    }
  | { ok: false; error: string } {
  const parsed = CronScheduleArgs.safeParse(input);
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }

  const legacy = CronScheduleArgsLegacy.safeParse(input);
  if (legacy.success) {
    return {
      ok: true,
      value: {
        ...legacy.data,
        callbackPrompt: legacy.data.message,
      },
    };
  }

  return { ok: false, error: parsed.error.toString() };
}

function parseCronScheduleLocalInput(input: unknown):
  | {
      ok: true;
      value: {
        id: string;
        timezone: string;
        localTime: string;
        localDate?: string;
        callbackPrompt: string;
        threadId: string;
        repeatMode: "once" | "daily";
        enabled: boolean;
      };
    }
  | { ok: false; error: string } {
  const parsed = CronScheduleLocalArgs.safeParse(input);
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }

  const legacy = CronScheduleLocalArgsLegacy.safeParse(input);
  if (legacy.success) {
    return {
      ok: true,
      value: {
        ...legacy.data,
        callbackPrompt: legacy.data.message,
      },
    };
  }

  return { ok: false, error: parsed.error.toString() };
}

export async function executeCronTool(
  call: FunctionToolCall,
  opts: { enabled: boolean; store: CronStore; defaultThreadId: string }
): Promise<string> {
  if (!opts.enabled) {
    return "cron tools disabled by config.agents.defaults.cron.enabled=false";
  }

  if (call.name === "cron_schedule") {
    const parsed = parseCronScheduleInput(safeJsonParse(call.argumentsJson));
    if (!parsed.ok) {
      return `Invalid arguments for cron_schedule: ${parsed.error}`;
    }

    try {
      const repeat = normalizeRepeat(parsed.value.repeat);
      const id = parsed.value.id.trim();
      const threadId = parsed.value.threadId.trim() || opts.defaultThreadId;
      const task = await opts.store.schedule({
        id: id || undefined,
        runAt: parsed.value.runAt,
        message: parsed.value.callbackPrompt,
        threadId,
        repeat,
        enabled: parsed.value.enabled,
      });

      return [
        "OK: cron task scheduled",
        `id: ${task.id}`,
        `threadId: ${task.threadId}`,
        `nextRunAt: ${task.nextRunAt}`,
        `repeat: ${formatRepeat(task.repeat)}`,
        `enabled: ${task.enabled}`,
        "note: message will be delivered to the model when task is due, not directly to the user",
      ].join("\n");
    } catch (err) {
      return `cron_schedule failed: ${(err as Error).message}`;
    }
  }

  if (call.name === "cron_schedule_local") {
    const parsed = parseCronScheduleLocalInput(safeJsonParse(call.argumentsJson));
    if (!parsed.ok) {
      return `Invalid arguments for cron_schedule_local: ${parsed.error}`;
    }

    try {
      assertValidTimeZone(parsed.value.timezone);

      const id = parsed.value.id.trim();
      const threadId = parsed.value.threadId.trim() || opts.defaultThreadId;
      const repeatMode = parsed.value.repeatMode;

      let runAt: string;
      let repeat: CronRepeat;

      if (repeatMode === "once") {
        const localDate = (parsed.value.localDate ?? "").trim();
        if (!localDate) {
          return "cron_schedule_local failed: localDate is required when repeatMode='once'";
        }
        runAt = localDateTimeToUtcIso({
          timezone: parsed.value.timezone,
          localDate,
          localTime: parsed.value.localTime,
        });
        repeat = { mode: "once" };
      } else {
        runAt = nextLocalTimeUtcIso({
          timezone: parsed.value.timezone,
          localTime: parsed.value.localTime,
        });
        repeat = {
          mode: "daily_local",
          timezone: parsed.value.timezone,
          localTime: parsed.value.localTime,
        };
      }

      const task = await opts.store.schedule({
        id: id || undefined,
        runAt,
        message: parsed.value.callbackPrompt,
        threadId,
        repeat,
        enabled: parsed.value.enabled,
      });

      return [
        "OK: cron local task scheduled",
        `id: ${task.id}`,
        `threadId: ${task.threadId}`,
        `timezone: ${parsed.value.timezone}`,
        `localTime: ${parsed.value.localTime}`,
        `nextRunAtUtc: ${task.nextRunAt}`,
        `repeat: ${repeatMode === "daily" ? "daily_local" : "once"}`,
        `enabled: ${task.enabled}`,
        "note: message will be delivered to the model when task is due, not directly to the user",
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

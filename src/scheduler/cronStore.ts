import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { expandHome } from "../utils/path.js";

export type CronRepeat =
  | { mode: "once" }
  | { mode: "interval"; everySeconds: number };

export type CronTask = {
  id: string;
  message: string;
  threadId: string;
  runAt: string;
  nextRunAt: string;
  repeat: CronRepeat;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastError?: string;
};

type CronStoreFile = {
  version: 1;
  tasks: CronTask[];
};

function nowIso(): string {
  return new Date().toISOString();
}

function parseIsoTime(iso: string): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) {
    throw new Error(`Invalid ISO datetime: ${iso}`);
  }
  return t;
}

function normalizeTask(task: CronTask): CronTask {
  parseIsoTime(task.runAt);
  parseIsoTime(task.nextRunAt);
  parseIsoTime(task.createdAt);
  parseIsoTime(task.updatedAt);
  if (task.lastRunAt) parseIsoTime(task.lastRunAt);

  if (task.repeat.mode === "interval") {
    if (!Number.isInteger(task.repeat.everySeconds) || task.repeat.everySeconds < 5) {
      throw new Error(`Invalid repeat.everySeconds for task ${task.id}`);
    }
  }

  return task;
}

export class CronStore {
  readonly filePath: string;
  private tasks: CronTask[] = [];

  constructor(filePath: string) {
    this.filePath = path.resolve(expandHome(filePath));
  }

  async init(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await this.load();
  }

  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as any)?.code === "ENOENT") {
        this.tasks = [];
        await this.save();
        return;
      }
      throw err;
    }

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error(`Invalid cron store JSON: ${this.filePath}`);
    }

    const file = json as CronStoreFile;
    if (!file || file.version !== 1 || !Array.isArray(file.tasks)) {
      throw new Error(`Invalid cron store structure: ${this.filePath}`);
    }

    this.tasks = file.tasks.map((t) => normalizeTask(t));
  }

  async save(): Promise<void> {
    const file: CronStoreFile = {
      version: 1,
      tasks: this.tasks,
    };
    await fs.writeFile(this.filePath, JSON.stringify(file, null, 2) + "\n", "utf8");
  }

  list(limit = 100): CronTask[] {
    return [...this.tasks]
      .sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt))
      .slice(0, Math.max(1, limit));
  }

  get(id: string): CronTask | undefined {
    return this.tasks.find((t) => t.id === id);
  }

  async schedule(params: {
    id?: string;
    runAt: string;
    message: string;
    threadId: string;
    repeat: CronRepeat;
    enabled?: boolean;
  }): Promise<CronTask> {
    const timestamp = parseIsoTime(params.runAt);
    const iso = new Date(timestamp).toISOString();
    const now = nowIso();

    const existing = params.id ? this.get(params.id) : undefined;
    const task: CronTask = normalizeTask({
      id: existing?.id ?? params.id ?? `cron_${randomUUID().slice(0, 8)}`,
      message: params.message.trim(),
      threadId: params.threadId.trim(),
      runAt: iso,
      nextRunAt: iso,
      repeat: params.repeat,
      enabled: params.enabled ?? true,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      lastRunAt: existing?.lastRunAt,
      lastError: existing?.lastError,
    });

    const idx = this.tasks.findIndex((t) => t.id === task.id);
    if (idx >= 0) {
      this.tasks[idx] = task;
    } else {
      this.tasks.push(task);
    }

    await this.save();
    return task;
  }

  async cancel(id: string): Promise<boolean> {
    const before = this.tasks.length;
    this.tasks = this.tasks.filter((t) => t.id !== id);
    if (this.tasks.length === before) return false;
    await this.save();
    return true;
  }

  due(now = Date.now()): CronTask[] {
    return this.tasks.filter((t) => t.enabled && Date.parse(t.nextRunAt) <= now);
  }

  async markRunSuccess(taskId: string, atIso = nowIso()): Promise<void> {
    const t = this.get(taskId);
    if (!t) return;

    t.lastRunAt = atIso;
    t.lastError = undefined;
    t.updatedAt = atIso;

    if (t.repeat.mode === "once") {
      this.tasks = this.tasks.filter((x) => x.id !== taskId);
      await this.save();
      return;
    }

    const step = t.repeat.everySeconds * 1000;
    const base = Date.parse(t.nextRunAt);
    const nowMs = Date.now();
    let next = base + step;
    while (next <= nowMs) {
      next += step;
    }
    t.nextRunAt = new Date(next).toISOString();

    await this.save();
  }

  async markRunFailure(taskId: string, errorText: string): Promise<void> {
    const t = this.get(taskId);
    if (!t) return;
    const now = nowIso();
    t.lastError = errorText.slice(0, 2000);
    t.updatedAt = now;

    const retryInMs = 60_000;
    t.nextRunAt = new Date(Date.now() + retryInMs).toISOString();
    await this.save();
  }
}


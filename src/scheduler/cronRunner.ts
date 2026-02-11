import type { Logger } from "../utils/logger.js";
import { CronStore, type CronTask } from "./cronStore.js";

type InvokeFn = (params: { threadId: string; text: string }) => Promise<string>;

export class CronRunner {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly opts: {
      enabled: boolean;
      tickSeconds: number;
      store: CronStore;
      invoke: InvokeFn;
      onTaskReply?: (params: { threadId: string; taskId: string; reply: string }) => Promise<void> | void;
      logger?: Logger;
    }
  ) {}

  setOnTaskReply(handler?: (params: { threadId: string; taskId: string; reply: string }) => Promise<void> | void): void {
    this.opts.onTaskReply = handler;
  }

  start(): void {
    if (!this.opts.enabled) return;
    if (this.timer) return;

    const everyMs = Math.max(5, this.opts.tickSeconds) * 1000;
    this.timer = setInterval(() => {
      void this.tick();
    }, everyMs);

    this.opts.logger?.info("Cron runner started", {
      everySeconds: this.opts.tickSeconds,
      storePath: this.opts.store.filePath,
    });

    void this.tick();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.opts.logger?.info("Cron runner stopped");
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const due = this.opts.store.due();
      if (!due.length) return;

      this.opts.logger?.info("Cron due tasks", { count: due.length });
      for (const task of due) {
        await this.runTask(task);
      }
    } catch (err) {
      this.opts.logger?.error("Cron tick failed", { message: (err as Error)?.message });
    } finally {
      this.running = false;
    }
  }

  private async runTask(task: CronTask): Promise<void> {
    const prompt = [
      "[CRON_TRIGGER] A scheduled task is due.",
      `taskId: ${task.id}`,
      `scheduledAt: ${task.nextRunAt}`,
      "payload:",
      task.message,
    ].join("\n");

    this.opts.logger?.info("Cron task execute", {
      taskId: task.id,
      threadId: task.threadId,
      repeat: task.repeat.mode,
      nextRunAt: task.nextRunAt,
    });

    try {
      const reply = await this.opts.invoke({
        threadId: task.threadId,
        text: prompt,
      });

      if (this.opts.onTaskReply) {
        try {
          await this.opts.onTaskReply({
            threadId: task.threadId,
            taskId: task.id,
            reply,
          });
        } catch (err) {
          this.opts.logger?.warn("Cron task reply callback failed", {
            taskId: task.id,
            threadId: task.threadId,
            message: (err as Error)?.message,
          });
        }
      }

      await this.opts.store.markRunSuccess(task.id);
      this.opts.logger?.debug("Cron task success", { taskId: task.id });
    } catch (err) {
      const message = (err as Error)?.message ?? "unknown error";
      await this.opts.store.markRunFailure(task.id, message);
      this.opts.logger?.error("Cron task failed", {
        taskId: task.id,
        message,
      });
    }
  }
}

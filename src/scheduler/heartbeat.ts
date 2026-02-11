import fs from "node:fs/promises";
import path from "node:path";

import type { Logger } from "../utils/logger.js";
import { expandHome } from "../utils/path.js";

type InvokeFn = (params: { threadId: string; text: string }) => Promise<string>;

export class HeartbeatRunner {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly opts: {
      enabled: boolean;
      intervalSeconds: number;
      filePath: string;
      threadId: string;
      invoke: InvokeFn;
      logger?: Logger;
    }
  ) {}

  start(): void {
    if (!this.opts.enabled) return;
    if (this.timer) return;

    const intervalMs = Math.max(10, this.opts.intervalSeconds) * 1000;
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.opts.logger?.info("Heartbeat started", {
      everySeconds: this.opts.intervalSeconds,
      filePath: path.resolve(expandHome(this.opts.filePath)),
      threadId: this.opts.threadId,
    });

    void this.tick();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.opts.logger?.info("Heartbeat stopped");
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const fp = path.resolve(expandHome(this.opts.filePath));
      let content: string;
      try {
        content = await fs.readFile(fp, "utf8");
      } catch (err) {
        if ((err as any)?.code === "ENOENT") {
          this.opts.logger?.debug("Heartbeat skipped: file not found", { filePath: fp });
          return;
        }
        throw err;
      }

      const trimmed = content.trim();
      if (!trimmed) {
        this.opts.logger?.debug("Heartbeat skipped: file empty", { filePath: fp });
        return;
      }

      const text = [
        "[HEARTBEAT] Execute according to HEARTBEAT.md instructions.",
        "",
        trimmed,
      ].join("\n");

      this.opts.logger?.info("Heartbeat tick", {
        threadId: this.opts.threadId,
        contentLength: trimmed.length,
      });
      const reply = await this.opts.invoke({ threadId: this.opts.threadId, text });
      this.opts.logger?.debug("Heartbeat reply", { length: reply.length });
    } catch (err) {
      this.opts.logger?.error("Heartbeat tick failed", {
        message: (err as Error)?.message,
      });
    } finally {
      this.running = false;
    }
  }
}


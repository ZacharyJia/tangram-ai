import fs from "node:fs/promises";
import path from "node:path";

import { AIMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { withKeyLock } from "./locks.js";
import { expandHome } from "../utils/path.js";
import type { Logger } from "../utils/logger.js";

type SessionRole = "user" | "assistant";

type SessionRecord = {
  v: 1;
  ts: string;
  threadId: string;
  role: SessionRole;
  content: string;
};

function encodeThreadId(threadId: string): string {
  return Buffer.from(threadId, "utf8").toString("base64url");
}

function decodeRecord(line: string): SessionRecord | undefined {
  try {
    const data = JSON.parse(line) as SessionRecord;
    if (data.v !== 1) return undefined;
    if (!data.threadId || typeof data.threadId !== "string") return undefined;
    if (data.role !== "user" && data.role !== "assistant") return undefined;
    if (typeof data.content !== "string") return undefined;
    return data;
  } catch {
    return undefined;
  }
}

export class SessionStore {
  readonly dir: string;
  private readonly logger?: Logger;

  constructor(dir: string, logger?: Logger) {
    this.dir = path.resolve(expandHome(dir));
    this.logger = logger;
  }

  async init(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
  }

  private getFilePath(threadId: string): string {
    const encoded = encodeThreadId(threadId);
    return path.join(this.dir, `${encoded}.jsonl`);
  }

  private async append(threadId: string, role: SessionRole, content: string): Promise<void> {
    const trimmed = content.trim();
    if (!trimmed) return;

    const fp = this.getFilePath(threadId);
    const record: SessionRecord = {
      v: 1,
      ts: new Date().toISOString(),
      threadId,
      role,
      content: trimmed,
    };

    const line = `${JSON.stringify(record)}\n`;
    await withKeyLock(threadId, async () => {
      await fs.appendFile(fp, line, "utf8");
    });
  }

  async appendUserMessage(threadId: string, content: string): Promise<void> {
    await this.append(threadId, "user", content);
  }

  async appendAssistantMessage(threadId: string, content: string): Promise<void> {
    await this.append(threadId, "assistant", content);
  }

  async loadRecentMessages(threadId: string, limit: number): Promise<BaseMessage[]> {
    const fp = this.getFilePath(threadId);
    let raw: string;
    try {
      raw = await fs.readFile(fp, "utf8");
    } catch (err) {
      if ((err as any)?.code === "ENOENT") return [];
      throw err;
    }

    const lines = raw.split(/\r?\n/).filter(Boolean);
    const records: SessionRecord[] = [];
    let dropped = 0;

    for (const line of lines) {
      const rec = decodeRecord(line);
      if (!rec) {
        dropped += 1;
        continue;
      }
      if (rec.threadId !== threadId) continue;
      if (!rec.content.trim()) continue;
      records.push(rec);
    }

    if (dropped > 0) {
      this.logger?.warn("Session file contains invalid records; skipped", {
        threadId,
        dropped,
      });
    }

    const recent = records.slice(-Math.max(0, limit));
    return recent.map((rec) => {
      if (rec.role === "user") return new HumanMessage(rec.content);
      return new AIMessage(rec.content);
    });
  }
}


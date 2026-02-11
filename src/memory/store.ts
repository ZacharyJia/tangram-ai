import fs from "node:fs/promises";
import path from "node:path";

import { expandHome } from "../utils/path.js";

function todayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function readFileIfExists(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as any)?.code === "ENOENT") return "";
    throw err;
  }
}

async function appendTextFile(filePath: string, content: string): Promise<void> {
  const existing = await readFileIfExists(filePath);
  const next = existing
    ? existing.replace(/\s*$/, "") + "\n\n" + content
    : content;
  await fs.writeFile(filePath, next, "utf8");
}

export class MemoryStore {
  readonly workspaceDir: string;
  readonly memoryDir: string;
  readonly longTermFile: string;

  constructor(workspaceDir: string) {
    const expanded = expandHome(workspaceDir);
    this.workspaceDir = path.resolve(expanded);
    this.memoryDir = path.join(this.workspaceDir, "memory");
    // Long-term memory file; we keep it lowercase to match the requested naming.
    this.longTermFile = path.join(this.memoryDir, "memory.md");
  }

  async init(): Promise<void> {
    await ensureDir(this.memoryDir);
  }

  todayFilePath(dateStr = todayDate()): string {
    return path.join(this.memoryDir, `${dateStr}.md`);
  }

  async readToday(): Promise<string> {
    return readFileIfExists(this.todayFilePath());
  }

  async appendToday(content: string): Promise<void> {
    const dateStr = todayDate();
    const fp = this.todayFilePath(dateStr);

    const existing = await readFileIfExists(fp);
    if (!existing) {
      const header = `# ${dateStr}\n\n`;
      await fs.writeFile(fp, header + content.trim() + "\n", "utf8");
      return;
    }

    await appendTextFile(fp, content.trim());
  }

  async readLongTerm(): Promise<string> {
    return readFileIfExists(this.longTermFile);
  }

  async appendLongTerm(content: string): Promise<void> {
    const trimmed = content.trim();
    if (!trimmed) return;

    const existing = await readFileIfExists(this.longTermFile);
    if (!existing) {
      const header = "# Long-term Memory\n\n";
      await fs.writeFile(this.longTermFile, header + trimmed + "\n", "utf8");
      return;
    }

    await appendTextFile(this.longTermFile, trimmed);
  }

  async getMemoryContext(): Promise<string> {
    const parts: string[] = [];

    const longTerm = (await this.readLongTerm()).trim();
    if (longTerm) parts.push(`## Long-term Memory\n${longTerm}`);

    const today = (await this.readToday()).trim();
    if (today) parts.push(`## Today's Notes\n${today}`);

    return parts.join("\n\n---\n\n");
  }
}

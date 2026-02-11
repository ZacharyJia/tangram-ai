import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

type WriteResult =
  | { action: "created"; filePath: string }
  | { action: "overwritten"; filePath: string }
  | { action: "skipped"; filePath: string }
  | { action: "backed_up_and_overwritten"; filePath: string; backupPath: string };

export type OnboardPaths = {
  baseDir: string;
  workspaceDir: string;
  skillsDir: string;
  configPath: string;
  heartbeatPath: string;
  cronStorePath: string;
  skillsReadmePath: string;
};

export function getDefaultOnboardPaths(): OnboardPaths {
  const baseDir = path.join(os.homedir(), ".tangram2");
  const workspaceDir = path.join(baseDir, "workspace");
  const skillsDir = path.join(baseDir, "skills");

  return {
    baseDir,
    workspaceDir,
    skillsDir,
    configPath: path.join(baseDir, "config.json"),
    heartbeatPath: path.join(workspaceDir, "HEARTBEAT.md"),
    cronStorePath: path.join(workspaceDir, "cron-tasks.json"),
    skillsReadmePath: path.join(skillsDir, "README.md"),
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function timestampForBackup(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${y}${m}${day}-${hh}${mm}${ss}`;
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, content, "utf8");
  await fs.rename(tmp, filePath);
}

async function askExistingPolicy(filePath: string): Promise<"overwrite" | "skip" | "backup"> {
  const rl = createInterface({ input, output });
  try {
    while (true) {
      const ans = (
        await rl.question(`File exists: ${filePath}\nChoose action: [o]verwrite / [s]kip / [b]ackup then overwrite (default: s): `)
      )
        .trim()
        .toLowerCase();

      if (!ans || ans === "s" || ans === "skip") return "skip";
      if (ans === "o" || ans === "overwrite") return "overwrite";
      if (ans === "b" || ans === "backup") return "backup";
      // eslint-disable-next-line no-console
      console.log("Invalid input. Please enter o/s/b.");
    }
  } finally {
    rl.close();
  }
}

async function writeWithPolicy(filePath: string, content: string): Promise<WriteResult> {
  const alreadyExists = await exists(filePath);
  if (!alreadyExists) {
    await atomicWrite(filePath, content);
    return { action: "created", filePath };
  }

  const policy = await askExistingPolicy(filePath);
  if (policy === "skip") {
    return { action: "skipped", filePath };
  }

  if (policy === "overwrite") {
    await atomicWrite(filePath, content);
    return { action: "overwritten", filePath };
  }

  const backupPath = `${filePath}.bak.${timestampForBackup()}`;
  await fs.copyFile(filePath, backupPath);
  await atomicWrite(filePath, content);
  return { action: "backed_up_and_overwritten", filePath, backupPath };
}

export async function ensureOnboardDirs(paths: OnboardPaths): Promise<void> {
  await fs.mkdir(paths.baseDir, { recursive: true });
  await fs.mkdir(paths.workspaceDir, { recursive: true });
  await fs.mkdir(paths.skillsDir, { recursive: true });
}

export async function writeOnboardFiles(files: Array<{ filePath: string; content: string }>): Promise<WriteResult[]> {
  const results: WriteResult[] = [];
  for (const f of files) {
    results.push(await writeWithPolicy(f.filePath, f.content));
  }
  return results;
}


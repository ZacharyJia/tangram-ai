import fs from "node:fs/promises";
import { spawn } from "node:child_process";

import { getAppPaths } from "./paths.js";
import { restartService } from "./systemdUser.js";

type UpgradeOptions = {
  version?: string;
  dryRun?: boolean;
  restart?: boolean;
};

type UpgradeResult = {
  version: string;
  previousVersion?: string;
  changed: boolean;
  restarted: boolean;
};

type UpgradeState = {
  lastVersion?: string;
  previousVersion?: string;
  updatedAt?: string;
};

type CmdResult = {
  code: number;
  stdout: string;
  stderr: string;
};

function runCmd(command: string, args: string[]): Promise<CmdResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function normalizeVersion(v: string): string {
  return v.startsWith("v") ? v.slice(1) : v;
}

async function ensureStateDir(): Promise<void> {
  const p = getAppPaths();
  await fs.mkdir(p.baseDir, { recursive: true });
  await fs.mkdir(p.appDir, { recursive: true });
}

async function readState(): Promise<UpgradeState> {
  const p = getAppPaths();
  try {
    const raw = await fs.readFile(p.upgradeStatePath, "utf8");
    const parsed = JSON.parse(raw) as UpgradeState;
    return parsed;
  } catch {
    return {};
  }
}

async function writeState(state: UpgradeState): Promise<void> {
  const p = getAppPaths();
  await fs.writeFile(p.upgradeStatePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function readInstalledVersion(): Promise<string> {
  const result = await runCmd("npm", ["view", "tangram2", "version"]);
  if (result.code !== 0) {
    throw new Error(`Failed to query npm package version: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

async function installGlobalVersion(target: string): Promise<void> {
  const result = await runCmd("npm", ["install", "-g", `tangram2@${target}`]);
  if (result.code !== 0) {
    throw new Error(`npm global install failed: ${result.stderr || result.stdout}`);
  }
}

async function tryGetCurrentGlobalVersion(): Promise<string | undefined> {
  const result = await runCmd("npm", ["list", "-g", "tangram2", "--depth=0", "--json"]);
  if (result.code !== 0) return undefined;
  try {
    const parsed = JSON.parse(result.stdout) as {
      dependencies?: Record<string, { version?: string }>;
    };
    const version = parsed.dependencies?.tangram2?.version;
    return version;
  } catch {
    return undefined;
  }
}

async function restartIfNeeded(restart: boolean): Promise<boolean> {
  if (!restart) return false;
  const restarted = await restartService().catch(() => ({ code: 1, stdout: "", stderr: "" }));
  if (restarted.code !== 0) {
    throw new Error(`systemctl restart failed: ${restarted.stderr || restarted.stdout}`);
  }
  return true;
}

export async function runUpgrade(options: UpgradeOptions): Promise<UpgradeResult> {
  await ensureStateDir();

  const target = options.version ? normalizeVersion(options.version) : "latest";
  const restart = options.restart ?? true;
  const previousVersion = await tryGetCurrentGlobalVersion();

  if (options.dryRun) {
    return {
      version: target,
      previousVersion,
      changed: true,
      restarted: false,
    };
  }

  await installGlobalVersion(target);
  const installed = await readInstalledVersion();

  const state = await readState();
  await writeState({
    previousVersion: previousVersion ?? state.lastVersion,
    lastVersion: installed,
    updatedAt: new Date().toISOString(),
  });

  try {
    const restarted = await restartIfNeeded(restart);
    return {
      version: installed,
      previousVersion,
      changed: true,
      restarted,
    };
  } catch (err) {
    if (previousVersion && previousVersion !== installed) {
      await installGlobalVersion(previousVersion).catch(() => undefined);
      await restartIfNeeded(true).catch(() => undefined);
    }
    throw err;
  }
}

export async function runRollback(options?: { to?: string; restart?: boolean }): Promise<{ version: string; restarted: boolean }> {
  await ensureStateDir();

  const restart = options?.restart ?? true;
  const state = await readState();
  const target = options?.to
    ? normalizeVersion(options.to)
    : state.previousVersion;

  if (!target) {
    throw new Error("No rollback target found. Provide --to <version> or run upgrade at least once.");
  }

  await installGlobalVersion(target);
  const installed = await readInstalledVersion();

  await writeState({
    previousVersion: state.lastVersion,
    lastVersion: installed,
    updatedAt: new Date().toISOString(),
  });

  const restarted = await restartIfNeeded(restart);
  return {
    version: installed,
    restarted,
  };
}


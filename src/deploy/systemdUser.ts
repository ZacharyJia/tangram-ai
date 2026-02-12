import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { getAppPaths } from "./paths.js";

type CmdResult = {
  code: number;
  stdout: string;
  stderr: string;
};

function resolveUserNpmBin(): string {
  const home = os.homedir();
  if (process.platform === "win32") {
    return path.join(home, "AppData", "Roaming", "npm");
  }
  return path.join(home, ".npm-global", "bin");
}

function runCmd(command: string, args: string[]): Promise<CmdResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
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

export async function isSystemdUserAvailable(): Promise<boolean> {
  const res = await runCmd("systemctl", ["--user", "--version"]).catch(() => ({
    code: 1,
    stdout: "",
    stderr: "",
  }));
  return res.code === 0;
}

export async function ensureServiceFile(options?: { description?: string }): Promise<{ created: boolean; path: string }> {
  const paths = getAppPaths();
  await fs.mkdir(paths.systemdUserDir, { recursive: true });

  const description = options?.description ?? "Tangram Gateway";
  const npmBin = resolveUserNpmBin();
  const unit = [
    "[Unit]",
    `Description=${description}`,
    "After=network.target",
    "",
    "[Service]",
    "Type=simple",
    `WorkingDirectory=${paths.baseDir}`,
    `Environment=PATH=${npmBin}:/usr/local/bin:/usr/bin:/bin`,
    `ExecStart=${npmBin}/tangram gateway --config ${paths.configPath}`,
    "Restart=always",
    "RestartSec=3",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");

  let existed = true;
  try {
    await fs.access(paths.serviceFilePath);
  } catch {
    existed = false;
  }

  if (existed) {
    const backupPath = `${paths.serviceFilePath}.bak`;
    await fs.copyFile(paths.serviceFilePath, backupPath);
  }

  await fs.writeFile(paths.serviceFilePath, unit, "utf8");
  return { created: !existed, path: paths.serviceFilePath };
}

export async function daemonReload(): Promise<CmdResult> {
  return runCmd("systemctl", ["--user", "daemon-reload"]);
}

export async function enableService(): Promise<CmdResult> {
  return runCmd("systemctl", ["--user", "enable", "tangram"]);
}

export async function startService(): Promise<CmdResult> {
  return runCmd("systemctl", ["--user", "start", "tangram"]);
}

export async function stopService(): Promise<CmdResult> {
  return runCmd("systemctl", ["--user", "stop", "tangram"]);
}

export async function restartService(): Promise<CmdResult> {
  return runCmd("systemctl", ["--user", "restart", "tangram"]);
}

export async function statusService(): Promise<CmdResult> {
  return runCmd("systemctl", ["--user", "status", "tangram", "--no-pager", "--lines", "20"]);
}

export async function ensureAndStartService(): Promise<{ serviceFile: string }> {
  const hasSystemd = await isSystemdUserAvailable();
  if (!hasSystemd) {
    throw new Error(
      "systemd --user is not available on this machine. Use foreground mode: tangram gateway --verbose"
    );
  }

  const created = await ensureServiceFile();
  const reload = await daemonReload();
  if (reload.code !== 0) {
    throw new Error(`systemctl daemon-reload failed: ${reload.stderr || reload.stdout}`);
  }

  const enabled = await enableService();
  if (enabled.code !== 0 && !enabled.stderr.includes("is enabled")) {
    throw new Error(`systemctl enable failed: ${enabled.stderr || enabled.stdout}`);
  }

  const started = await startService();
  if (started.code !== 0) {
    throw new Error(`systemctl start failed: ${started.stderr || started.stdout}`);
  }

  return { serviceFile: created.path };
}

export async function installService(options?: { start?: boolean }): Promise<{ serviceFile: string; started: boolean }> {
  const hasSystemd = await isSystemdUserAvailable();
  if (!hasSystemd) {
    throw new Error(
      "systemd --user is not available on this machine. Use foreground mode: tangram gateway --verbose"
    );
  }

  const created = await ensureServiceFile();
  const reload = await daemonReload();
  if (reload.code !== 0) {
    throw new Error(`systemctl daemon-reload failed: ${reload.stderr || reload.stdout}`);
  }

  const enabled = await enableService();
  if (enabled.code !== 0 && !enabled.stderr.includes("is enabled")) {
    throw new Error(`systemctl enable failed: ${enabled.stderr || enabled.stdout}`);
  }

  if (options?.start === false) {
    return { serviceFile: created.path, started: false };
  }

  const started = await startService();
  if (started.code !== 0) {
    throw new Error(`systemctl start failed: ${started.stderr || started.stdout}`);
  }
  return { serviceFile: created.path, started: true };
}

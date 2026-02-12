import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

import { fetchLatestRelease, fetchReleaseByTag } from "./githubRelease.js";
import { getAppPaths } from "./paths.js";
import { restartService } from "./systemdUser.js";

type UpgradeOptions = {
  version?: string;
  dryRun?: boolean;
  restart?: boolean;
};

type UpgradeResult = {
  version: string;
  changed: boolean;
  restarted: boolean;
  downloadPath?: string;
};

function runCmd(command: string, args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
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

async function ensureDirs(): Promise<void> {
  const p = getAppPaths();
  await fs.mkdir(p.baseDir, { recursive: true });
  await fs.mkdir(p.appDir, { recursive: true });
  await fs.mkdir(p.releasesDir, { recursive: true });
  await fs.mkdir(p.downloadsDir, { recursive: true });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readLinkSafe(linkPath: string): Promise<string | undefined> {
  try {
    return await fs.readlink(linkPath);
  } catch {
    return undefined;
  }
}

async function writeLinkAtomic(targetPath: string, linkPath: string): Promise<void> {
  const tmpLink = `${linkPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.symlink(targetPath, tmpLink);
  await fs.rename(tmpLink, linkPath);
}

async function sha256(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function downloadToFile(url: string, outPath: string): Promise<void> {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "tangram2-upgrader",
      Accept: "application/octet-stream",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Download failed (${res.status}): ${body || res.statusText}`);
  }

  const arr = new Uint8Array(await res.arrayBuffer());
  await fs.writeFile(outPath, arr);
}

async function parseChecksumFile(checksumPath: string, artifactName: string): Promise<string | undefined> {
  const text = await fs.readFile(checksumPath, "utf8");
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [hash, file] = trimmed.split(/\s+/);
    if (file === artifactName || file === `*${artifactName}`) {
      return hash;
    }
  }
  return undefined;
}

async function installReleaseTarball(archivePath: string, releaseDir: string): Promise<void> {
  await fs.rm(releaseDir, { recursive: true, force: true });
  await fs.mkdir(releaseDir, { recursive: true });

  const untar = await runCmd("tar", ["-xzf", archivePath, "-C", releaseDir]);
  if (untar.code !== 0) {
    throw new Error(`Failed to extract artifact: ${untar.stderr || untar.stdout}`);
  }

  const npmCi = await runCmd("npm", ["ci", "--omit=dev"], releaseDir);
  if (npmCi.code !== 0) {
    throw new Error(`Failed to install runtime dependencies: ${npmCi.stderr || npmCi.stdout}`);
  }
}

async function rollbackTo(previousTarget: string, restart: boolean): Promise<void> {
  const p = getAppPaths();
  await fs.rm(p.currentLink, { force: true });
  await writeLinkAtomic(previousTarget, p.currentLink);

  if (restart) {
    const restarted = await restartService().catch(() => ({ code: 1, stdout: "", stderr: "" }));
    if (restarted.code !== 0) {
      throw new Error(`Rollback restart failed: ${restarted.stderr || restarted.stdout}`);
    }
  }
}

export async function runUpgrade(options: UpgradeOptions): Promise<UpgradeResult> {
  await ensureDirs();
  const p = getAppPaths();
  const restart = options.restart ?? true;

  const release = options.version
    ? await fetchReleaseByTag(options.version)
    : await fetchLatestRelease();

  const artifactName = `tangram2-${release.tag}.tar.gz`;
  const artifact = release.assets.find((x) => x.name === artifactName);
  if (!artifact) {
    throw new Error(`Release asset not found: ${artifactName}`);
  }
  const checksumAsset = release.assets.find((x) => x.name === "checksums.txt");

  const releaseDir = path.join(p.releasesDir, release.tag);
  if (options.dryRun) {
    return {
      version: release.tag,
      changed: !(await fileExists(releaseDir)),
      restarted: false,
    };
  }

  const archivePath = path.join(p.downloadsDir, artifactName);
  await downloadToFile(artifact.url, archivePath);

  if (checksumAsset) {
    const checksumPath = path.join(p.downloadsDir, `${release.tag}-checksums.txt`);
    await downloadToFile(checksumAsset.url, checksumPath);
    const expected = await parseChecksumFile(checksumPath, artifactName);
    if (expected) {
      const actual = await sha256(archivePath);
      if (actual !== expected) {
        throw new Error(`Checksum mismatch for ${artifactName}`);
      }
    }
  }

  await installReleaseTarball(archivePath, releaseDir);

  const previousCurrent = await readLinkSafe(p.currentLink);
  if (previousCurrent) {
    await fs.rm(p.previousLink, { force: true });
    await writeLinkAtomic(previousCurrent, p.previousLink);
    await fs.rm(p.currentLink, { force: true });
  }

  await writeLinkAtomic(releaseDir, p.currentLink);

  if (!restart) {
    return {
      version: release.tag,
      changed: true,
      restarted: false,
      downloadPath: archivePath,
    };
  }

  const restarted = await restartService().catch(() => ({ code: 1, stdout: "", stderr: "" }));
  if (restarted.code !== 0) {
    if (previousCurrent) {
      await rollbackTo(previousCurrent, true).catch(() => undefined);
    }
    throw new Error(`Restart after upgrade failed: ${restarted.stderr || restarted.stdout}`);
  }

  return {
    version: release.tag,
    changed: true,
    restarted: true,
    downloadPath: archivePath,
  };
}

export async function runRollback(options?: { to?: string; restart?: boolean }): Promise<{ version: string; restarted: boolean }> {
  const p = getAppPaths();
  const restart = options?.restart ?? true;

  let targetPath: string | undefined;
  let version: string | undefined;

  if (options?.to) {
    version = options.to;
    targetPath = path.join(p.releasesDir, options.to);
    const exists = await fileExists(targetPath);
    if (!exists) {
      throw new Error(`Rollback target not installed: ${options.to}`);
    }
  } else {
    targetPath = await readLinkSafe(p.previousLink);
    if (!targetPath) {
      throw new Error("No previous release found for rollback.");
    }
    version = path.basename(targetPath);
  }

  await fs.rm(p.currentLink, { force: true });
  await writeLinkAtomic(targetPath, p.currentLink);

  if (restart) {
    const restarted = await restartService().catch(() => ({ code: 1, stdout: "", stderr: "" }));
    if (restarted.code !== 0) {
      throw new Error(`Restart after rollback failed: ${restarted.stderr || restarted.stdout}`);
    }
  }

  return {
    version,
    restarted: restart,
  };
}


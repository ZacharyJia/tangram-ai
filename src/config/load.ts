import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ConfigSchema, type AppConfig } from "./schema.js";

export type LoadedConfig = {
  config: AppConfig;
  configPath: string;
};

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function resolveConfigPath(explicitPath?: string): Promise<string> {
  const homeConfig = path.join(os.homedir(), ".tangram2", "config.json");
  const candidates: Array<string | undefined> = [
    explicitPath,
    process.env.TANGRAM2_CONFIG,
    // Back-compat from earlier MVP naming.
    process.env.NANOGRAPHBOT_CONFIG,
    homeConfig,
    // Legacy fallback for older local-dev setups.
    path.resolve(process.cwd(), "config.json"),
  ];

  for (const c of candidates) {
    if (!c) continue;
    if (await fileExists(c)) return c;
  }

  return candidates.find(Boolean) ?? homeConfig;
}

export async function loadConfig(explicitPath?: string): Promise<LoadedConfig> {
  const configPath = await resolveConfigPath(explicitPath);
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (err) {
    const code = (err as any)?.code;
    if (code === "ENOENT") {
      throw new Error(
        [
          `Config file not found: ${configPath}`,
          "Create one from config.example.json:",
          "  mkdir -p ~/.tangram2 && cp config.example.json ~/.tangram2/config.json",
          "Or set TANGRAM2_CONFIG to an absolute path.",
        ].join("\n")
      );
    }
    throw err;
  }
  const json = JSON.parse(raw);
  const parsed = ConfigSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `Invalid config at ${configPath}:\n${parsed.error.toString()}`
    );
  }

  const config = parsed.data;
  const providerKey = config.agents.defaults.provider;
  if (!config.providers[providerKey]) {
    throw new Error(
      `Config error: agents.defaults.provider is '${providerKey}', but providers['${providerKey}'] is missing.`
    );
  }

  return { config, configPath };
}

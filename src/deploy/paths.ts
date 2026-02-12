import os from "node:os";
import path from "node:path";

export type AppPaths = {
  baseDir: string;
  appDir: string;
  upgradeStatePath: string;
  configPath: string;
  systemdUserDir: string;
  serviceFilePath: string;
};

export function getAppPaths(): AppPaths {
  const home = os.homedir();
  const baseDir = path.join(home, ".tangram-ai");
  const appDir = path.join(baseDir, "app");
  const systemdUserDir = path.join(home, ".config", "systemd", "user");

  return {
    baseDir,
    appDir,
    upgradeStatePath: path.join(appDir, "upgrade-state.json"),
    configPath: path.join(baseDir, "config.json"),
    systemdUserDir,
    serviceFilePath: path.join(systemdUserDir, "tangram.service"),
  };
}

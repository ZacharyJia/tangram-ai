import os from "node:os";
import path from "node:path";

export type AppPaths = {
  baseDir: string;
  appDir: string;
  releasesDir: string;
  downloadsDir: string;
  currentLink: string;
  currentGatewayEntrypoint: string;
  previousLink: string;
  configPath: string;
  systemdUserDir: string;
  serviceFilePath: string;
};

export function getAppPaths(): AppPaths {
  const home = os.homedir();
  const baseDir = path.join(home, ".tangram2");
  const appDir = path.join(baseDir, "app");
  const systemdUserDir = path.join(home, ".config", "systemd", "user");

  return {
    baseDir,
    appDir,
    releasesDir: path.join(appDir, "releases"),
    downloadsDir: path.join(appDir, "downloads"),
    currentLink: path.join(appDir, "current"),
    currentGatewayEntrypoint: path.join(appDir, "current", "dist", "index.js"),
    previousLink: path.join(appDir, "previous"),
    configPath: path.join(baseDir, "config.json"),
    systemdUserDir,
    serviceFilePath: path.join(systemdUserDir, "tangram2.service"),
  };
}

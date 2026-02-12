#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const target = process.argv[2] ?? "patch";

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run("npm", ["run", "version:bump", "--", target]);
run("npm", ["run", "build"]);

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const versionTag = `v${pkg.version}`;

run("git", ["add", "package.json", "package-lock.json"]);
run("git", ["commit", "-m", `chore(release): ${versionTag}`]);
run("git", ["tag", versionTag]);

// eslint-disable-next-line no-console
console.log([
  `Release prepared: ${versionTag}`,
  "Next steps:",
  "  git push origin master",
  `  git push origin ${versionTag}`,
].join("\n"));


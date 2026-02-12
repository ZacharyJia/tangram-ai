#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const arg = process.argv[2] ?? "patch";
const allowedKinds = new Set([
  "patch",
  "minor",
  "major",
  "prepatch",
  "preminor",
  "premajor",
  "prerelease",
]);

const isSemver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/.test(arg);

if (!allowedKinds.has(arg) && !isSemver) {
  // eslint-disable-next-line no-console
  console.error(
    [
      `Invalid version bump target: ${arg}`,
      "Use one of: patch | minor | major | prepatch | preminor | premajor | prerelease",
      "or a full semver value like: 1.2.3",
    ].join("\n")
  );
  process.exit(1);
}

const npmArgs = ["version", arg, "--no-git-tag-version"];
const result = spawnSync("npm", npmArgs, {
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
// eslint-disable-next-line no-console
console.log(`Updated version: v${pkg.version}`);


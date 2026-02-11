import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AppConfig } from "../config/schema.js";
import { expandHome } from "../utils/path.js";

export type SkillSummary = {
  name: string;
  description: string;
  skillPath: string;
};

async function dirExists(dir: string): Promise<boolean> {
  try {
    const s = await fs.stat(dir);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function readSkillDescription(skillMdPath: string): Promise<string> {
  try {
    const raw = await fs.readFile(skillMdPath, "utf8");
    const lines = raw.split(/\r?\n/).map((line) => line.trim());
    for (const line of lines) {
      if (!line) continue;
      if (line.startsWith("#")) continue;
      if (line.startsWith("```")) continue;
      return line.length > 220 ? `${line.slice(0, 217)}...` : line;
    }
    return "No description.";
  } catch {
    return "No description.";
  }
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    const resolved = path.resolve(expandHome(p));
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

function getDefaultSkillRoots(): string[] {
  return [path.join(os.homedir(), ".tangram2", "skills")];
}

export function resolveSkillRoots(config: AppConfig): string[] {
  const skillsCfg = config.agents.defaults.skills;
  if (!skillsCfg?.enabled) return [];
  return dedupePaths([...getDefaultSkillRoots(), ...(skillsCfg.roots ?? [])]);
}

async function listSkillDirs(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => path.join(root, e.name));
  } catch {
    return [];
  }
}

export async function discoverSkills(config: AppConfig): Promise<SkillSummary[]> {
  const skillsCfg = config.agents.defaults.skills;
  if (!skillsCfg?.enabled) return [];

  const roots = resolveSkillRoots(config);
  const maxSkills = skillsCfg.maxSkills ?? 40;

  const all: SkillSummary[] = [];
  const byName = new Set<string>();

  for (const root of roots) {
    if (!(await dirExists(root))) continue;
    const dirs = await listSkillDirs(root);

    for (const d of dirs) {
      const skillMdPath = path.join(d, "SKILL.md");
      try {
        await fs.access(skillMdPath);
      } catch {
        continue;
      }

      const name = path.basename(d);
      if (byName.has(name)) continue;

      const description = await readSkillDescription(skillMdPath);
      all.push({
        name,
        description,
        skillPath: skillMdPath,
      });
      byName.add(name);

      if (all.length >= maxSkills) return all;
    }
  }

  return all;
}

export function renderSkillsMetadata(skills: SkillSummary[]): string {
  if (!skills.length) return "";

  const lines = [
    "# Skills",
    "Available local skills (open the listed SKILL.md when needed):",
    ...skills.map((s) => `- ${s.name}: ${s.description} (file: ${s.skillPath})`),
  ];

  return lines.join("\n");
}

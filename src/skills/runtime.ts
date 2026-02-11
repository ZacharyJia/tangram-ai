import { statSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";

import type { AppConfig } from "../config/schema.js";
import type { Logger } from "../utils/logger.js";
import { discoverSkills, renderSkillsMetadata, resolveSkillRoots, type SkillSummary } from "./catalog.js";

export type SkillsSnapshot = {
  version: number;
  skills: SkillSummary[];
  metadata: string;
  updatedAt: string;
};

type SkillsDiff = {
  added: string[];
  removed: string[];
  changed: string[];
};

function dedupe(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    const resolved = path.resolve(p);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

function isDirectory(dirPath: string): boolean {
  try {
    return statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

function diffSkills(previous: SkillSummary[], next: SkillSummary[]): SkillsDiff {
  const prevByName = new Map<string, SkillSummary>();
  const nextByName = new Map<string, SkillSummary>();

  for (const skill of previous) prevByName.set(skill.name, skill);
  for (const skill of next) nextByName.set(skill.name, skill);

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const [name, nextSkill] of nextByName.entries()) {
    const prevSkill = prevByName.get(name);
    if (!prevSkill) {
      added.push(name);
      continue;
    }

    if (prevSkill.description !== nextSkill.description || prevSkill.skillPath !== nextSkill.skillPath) {
      changed.push(name);
    }
  }

  for (const name of prevByName.keys()) {
    if (!nextByName.has(name)) removed.push(name);
  }

  return {
    added: added.sort((a, b) => a.localeCompare(b)),
    removed: removed.sort((a, b) => a.localeCompare(b)),
    changed: changed.sort((a, b) => a.localeCompare(b)),
  };
}

function hasDiff(diff: SkillsDiff): boolean {
  return diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0;
}

export class SkillsRuntime {
  private snapshot: SkillsSnapshot = {
    version: 0,
    skills: [],
    metadata: "",
    updatedAt: new Date().toISOString(),
  };

  private started = false;
  private stopped = false;
  private reloading = false;
  private queuedReload = false;
  private watchers: FSWatcher[] = [];
  private reloadTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly logger?: Logger
  ) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    await this.reloadNow("startup");

    if (!this.isHotReloadEnabled()) {
      this.logger?.info("Skills hot reload disabled", {
        skillsEnabled: Boolean(this.config.agents.defaults.skills?.enabled),
        hotReloadEnabled: Boolean(this.config.agents.defaults.skills?.hotReload?.enabled),
      });
      return;
    }

    this.logger?.info("Skills hot reload started", {
      roots: resolveSkillRoots(this.config),
      debounceMs: this.getDebounceMs(),
      logDiff: this.shouldLogDiff(),
    });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;

    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }

    this.closeWatchers();
    this.logger?.info("Skills runtime stopped");
  }

  getSnapshot(): SkillsSnapshot {
    return {
      version: this.snapshot.version,
      skills: [...this.snapshot.skills],
      metadata: this.snapshot.metadata,
      updatedAt: this.snapshot.updatedAt,
    };
  }

  private isHotReloadEnabled(): boolean {
    const skillsCfg = this.config.agents.defaults.skills;
    return Boolean(skillsCfg?.enabled && skillsCfg.hotReload?.enabled);
  }

  private getDebounceMs(): number {
    return this.config.agents.defaults.skills?.hotReload?.debounceMs ?? 800;
  }

  private shouldLogDiff(): boolean {
    return this.config.agents.defaults.skills?.hotReload?.logDiff !== false;
  }

  private scheduleReload(reason: string): void {
    if (this.stopped || !this.isHotReloadEnabled()) return;

    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }

    const delayMs = this.getDebounceMs();
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      void this.reloadNow(reason);
    }, delayMs);
  }

  private async reloadNow(reason: string): Promise<void> {
    if (this.reloading) {
      this.queuedReload = true;
      return;
    }

    this.reloading = true;
    try {
      do {
        this.queuedReload = false;

        const previous = this.snapshot;
        const nextSkills = await discoverSkills(this.config);
        const nextMetadata = renderSkillsMetadata(nextSkills);
        const diff = diffSkills(previous.skills, nextSkills);
        const changed = previous.version === 0 || hasDiff(diff) || previous.metadata !== nextMetadata;

        if (!changed) {
          this.logger?.debug("Skills reload skipped (no changes)", { reason, count: nextSkills.length });
          continue;
        }

        const nextSnapshot: SkillsSnapshot = {
          version: previous.version + 1,
          skills: nextSkills,
          metadata: nextMetadata,
          updatedAt: new Date().toISOString(),
        };
        this.snapshot = nextSnapshot;

        if (this.shouldLogDiff()) {
          this.logger?.info("Skills reloaded", {
            reason,
            version: nextSnapshot.version,
            count: nextSnapshot.skills.length,
            added: diff.added,
            removed: diff.removed,
            changed: diff.changed,
          });
        } else {
          this.logger?.info("Skills reloaded", {
            reason,
            version: nextSnapshot.version,
            count: nextSnapshot.skills.length,
          });
        }

        if (this.isHotReloadEnabled()) {
          this.refreshWatchers();
        }
      } while (this.queuedReload && !this.stopped);
    } catch (err) {
      this.logger?.error("Skills reload failed", {
        reason,
        message: (err as Error)?.message,
      });
    } finally {
      this.reloading = false;
    }
  }

  private buildWatchTargets(): string[] {
    const roots = resolveSkillRoots(this.config);
    if (!roots.length) return [];

    const skillDirs = this.snapshot.skills.map((skill) => path.dirname(skill.skillPath));

    const targets = dedupe([
      ...roots.map((root) => (isDirectory(root) ? root : path.dirname(root))),
      ...skillDirs.filter((dir) => isDirectory(dir)),
    ]);

    return targets;
  }

  private refreshWatchers(): void {
    this.closeWatchers();
    if (this.stopped || !this.isHotReloadEnabled()) return;

    const targets = this.buildWatchTargets();
    for (const target of targets) {
      try {
        const watcher = watch(target, (eventType, fileName) => {
          const file = typeof fileName === "string" ? fileName : "";
          this.logger?.debug("Skills fs event", {
            target,
            eventType,
            file,
          });
          this.scheduleReload(`watch:${eventType}:${target}`);
        });

        watcher.on("error", (err) => {
          this.logger?.warn("Skills watcher error", {
            target,
            message: (err as Error)?.message,
          });
          this.scheduleReload(`watch-error:${target}`);
        });

        this.watchers.push(watcher);
      } catch (err) {
        this.logger?.warn("Skills watcher setup failed", {
          target,
          message: (err as Error)?.message,
        });
      }
    }

    this.logger?.debug("Skills watchers active", {
      count: this.watchers.length,
      targets,
    });
  }

  private closeWatchers(): void {
    for (const watcher of this.watchers) {
      try {
        watcher.close();
      } catch {
      }
    }
    this.watchers = [];
  }
}

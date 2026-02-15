import fs from "node:fs/promises";
import path from "node:path";

import type { AppConfig } from "./schema.js";
import { expandHome } from "../utils/path.js";

export type SoulMergeMode = "append" | "replace";

export type SoulSection = {
  title: string;
  slug: string;
  content: string;
};

export type ParsedSoulDocument = {
  title?: string;
  sections: SoulSection[];
  whoYouAre?: string;
  coreTruths: string[];
  boundaries: string[];
  vibe?: string;
  continuity?: string;
};

export type LoadedSoulDocument = {
  path: string;
  mergeMode: SoulMergeMode;
  parsed: ParsedSoulDocument;
  promptBlock: string;
};

function normalizeMarkdown(raw: string): string {
  return raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").trim();
}

function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[`*_~]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function collectSections(markdown: string): { title?: string; sections: SoulSection[] } {
  const lines = markdown.split("\n");
  let docTitle: string | undefined;
  const sections: SoulSection[] = [];
  let currentTitle: string | undefined;
  let buffer: string[] = [];

  const flush = () => {
    if (!currentTitle) return;
    const content = buffer.join("\n").trim();
    sections.push({
      title: currentTitle,
      slug: slugifyHeading(currentTitle),
      content,
    });
    buffer = [];
  };

  for (const line of lines) {
    const h1 = line.match(/^#\s+(.+?)\s*$/);
    if (h1 && !docTitle) {
      docTitle = h1[1].trim();
      continue;
    }

    const sectionHeading = line.match(/^#{2,6}\s+(.+?)\s*$/);
    if (sectionHeading) {
      flush();
      if (!currentTitle) {
        // Drop pre-section text so it doesn't leak into the first section body.
        buffer = [];
      }
      currentTitle = sectionHeading[1].trim();
      continue;
    }

    buffer.push(line);
  }

  flush();
  return { title: docTitle, sections };
}

function parseListItems(block: string): string[] {
  const lines = block
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const listItems = lines
    .map((line) => line.match(/^[-*+]\s+(.+)$/)?.[1] ?? line.match(/^\d+\.\s+(.+)$/)?.[1])
    .filter((item): item is string => Boolean(item))
    .map((item) => item.trim())
    .filter(Boolean);

  if (listItems.length > 0) return listItems;
  if (lines.length === 0) return [];
  return [lines.join(" ")];
}

function findSection(sections: SoulSection[], aliases: string[]): SoulSection | undefined {
  const aliasSet = new Set(aliases.map((a) => slugifyHeading(a)));
  return sections.find((section) => aliasSet.has(section.slug));
}

export function parseSoulMarkdown(raw: string): ParsedSoulDocument {
  const markdown = normalizeMarkdown(raw);
  if (!markdown) {
    throw new Error("SOUL.md is empty.");
  }

  const parsed = collectSections(markdown);
  const sections = parsed.sections.length
    ? parsed.sections
    : [
        {
          title: "Profile",
          slug: "profile",
          content: markdown,
        },
      ];

  const who = findSection(sections, ["Who You Are", "Identity", "Persona"]);
  const truths = findSection(sections, ["Core Truths", "Values", "Principles"]);
  const boundaries = findSection(sections, ["Boundaries", "Guardrails", "Limits"]);
  const vibe = findSection(sections, ["Vibe", "Tone", "Style"]);
  const continuity = findSection(sections, ["Continuity", "Memory"]);

  return {
    title: parsed.title,
    sections,
    whoYouAre: who?.content?.trim() || undefined,
    coreTruths: parseListItems(truths?.content ?? ""),
    boundaries: parseListItems(boundaries?.content ?? ""),
    vibe: vibe?.content?.trim() || undefined,
    continuity: continuity?.content?.trim() || undefined,
  };
}

export function buildSoulPromptBlock(parsed: ParsedSoulDocument): string {
  const lines: string[] = [
    "# SOUL.md Profile",
    "Treat this profile as a durable personality and behavior contract for this assistant.",
  ];

  if (parsed.whoYouAre) {
    lines.push("## Who You Are", parsed.whoYouAre);
  }
  if (parsed.coreTruths.length > 0) {
    lines.push("## Core Truths", ...parsed.coreTruths.map((item) => `- ${item}`));
  }
  if (parsed.boundaries.length > 0) {
    lines.push("## Boundaries", ...parsed.boundaries.map((item) => `- ${item}`));
  }
  if (parsed.vibe) {
    lines.push("## Vibe", parsed.vibe);
  }
  if (parsed.continuity) {
    lines.push("## Continuity", parsed.continuity);
  }

  const covered = new Set(
    ["Who You Are", "Identity", "Persona", "Core Truths", "Values", "Principles", "Boundaries", "Guardrails", "Limits", "Vibe", "Tone", "Style", "Continuity", "Memory"].map(
      (name) => slugifyHeading(name)
    )
  );

  const extras = parsed.sections.filter((section) => !covered.has(section.slug) && section.content.trim().length > 0);
  for (const extra of extras) {
    lines.push(`## ${extra.title}`, extra.content.trim());
  }

  if (lines.length <= 2 && parsed.sections.length > 0) {
    for (const section of parsed.sections) {
      if (!section.content.trim()) continue;
      lines.push(`## ${section.title}`, section.content.trim());
    }
  }

  return lines.join("\n").trim();
}

function resolveSoulPath(configPath: string, soulPath: string): string {
  const expanded = expandHome(soulPath);
  if (path.isAbsolute(expanded)) return path.resolve(expanded);
  return path.resolve(path.dirname(configPath), expanded);
}

export async function loadSoulFromConfig(
  config: AppConfig,
  configPath: string
): Promise<LoadedSoulDocument | undefined> {
  const soulCfg = config.agents.defaults.soul;
  if (!soulCfg?.enabled) {
    return undefined;
  }

  const soulPath = resolveSoulPath(configPath, soulCfg.path ?? "~/.tangram/workspace/SOUL.md");

  let raw: string;
  try {
    raw = await fs.readFile(soulPath, "utf8");
  } catch (err) {
    const code = (err as any)?.code;
    if (code === "ENOENT" && !soulCfg.required) {
      return undefined;
    }
    if (code === "ENOENT") {
      throw new Error(`SOUL.md is required but missing: ${soulPath}`);
    }
    throw err;
  }

  const normalized = normalizeMarkdown(raw);
  if (!normalized) {
    if (soulCfg.required) {
      throw new Error(`SOUL.md is required but empty: ${soulPath}`);
    }
    return undefined;
  }

  let parsed: ParsedSoulDocument;
  try {
    parsed = parseSoulMarkdown(normalized);
  } catch (err) {
    if (soulCfg.required) {
      throw new Error(`SOUL.md parse failed at ${soulPath}: ${(err as Error)?.message}`);
    }
    return undefined;
  }

  const promptBlock = buildSoulPromptBlock(parsed);
  if (!promptBlock) {
    if (soulCfg.required) {
      throw new Error(`SOUL.md produced an empty prompt block: ${soulPath}`);
    }
    return undefined;
  }

  return {
    path: soulPath,
    mergeMode: soulCfg.mergeMode ?? "append",
    parsed,
    promptBlock,
  };
}

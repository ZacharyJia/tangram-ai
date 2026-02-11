import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import type { FunctionToolCall, FunctionToolDef } from "../providers/types.js";

const FileReadArgs = z
  .object({
    path: z.string().min(1),
    startLine: z.number().int().min(1).optional().default(1),
    maxLines: z.number().int().min(1).max(1000).optional().default(300),
  })
  .strict();

const FileWriteArgs = z
  .object({
    path: z.string().min(1),
    content: z.string(),
    mode: z.enum(["overwrite", "append"]).optional().default("overwrite"),
  })
  .strict();

const FileEditArgs = z
  .object({
    path: z.string().min(1),
    replacements: z
      .array(
        z
          .object({
            from: z.string().min(1),
            to: z.string(),
            replaceAll: z.boolean().optional().default(false),
          })
          .strict()
      )
      .min(1),
    createIfMissing: z.boolean().optional().default(false),
  })
  .strict();

export const fileToolDefs: FunctionToolDef[] = [
  {
    name: "file_read",
    description:
      "Read a UTF-8 text file from allowed local directories. Use startLine/maxLines to read partial content.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "Absolute or allowed-root-relative file path." },
        startLine: { type: "integer", minimum: 1, default: 1 },
        maxLines: { type: "integer", minimum: 1, maximum: 1000, default: 300 },
      },
      required: ["path", "startLine", "maxLines"],
    },
  },
  {
    name: "file_write",
    description:
      "Write UTF-8 text to an allowed local file. Supports overwrite or append mode. Creates parent directories if missing.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "Absolute or allowed-root-relative file path." },
        content: { type: "string" },
        mode: { type: "string", enum: ["overwrite", "append"], default: "overwrite" },
      },
      required: ["path", "content", "mode"],
    },
  },
  {
    name: "file_edit",
    description:
      "Edit an existing UTF-8 text file by replacing text snippets. Supports first-match or replace-all mode for each replacement.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string", description: "Absolute or allowed-root-relative file path." },
        replacements: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              from: { type: "string" },
              to: { type: "string" },
              replaceAll: { type: "boolean", default: false },
            },
            required: ["from", "to", "replaceAll"],
          },
        },
        createIfMissing: { type: "boolean", default: false },
      },
      required: ["path", "replacements", "createIfMissing"],
    },
  },
];

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let start = 0;
  while (start <= haystack.length) {
    const idx = haystack.indexOf(needle, start);
    if (idx === -1) break;
    count += 1;
    start = idx + needle.length;
  }
  return count;
}

function safeJsonParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

function normalizeRoots(roots: string[]): string[] {
  return roots.map((r) => path.resolve(r));
}

function resolveAllowedPath(inputPath: string, roots: string[]): string {
  const normalizedRoots = normalizeRoots(roots);
  if (!normalizedRoots.length) {
    throw new Error("No allowed roots configured for file tools.");
  }

  const candidates: string[] = [];
  if (path.isAbsolute(inputPath)) {
    candidates.push(path.resolve(inputPath));
  } else {
    for (const root of normalizedRoots) {
      candidates.push(path.resolve(root, inputPath));
    }
  }

  for (const candidate of candidates) {
    for (const root of normalizedRoots) {
      const rel = path.relative(root, candidate);
      if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
        return candidate;
      }
    }
  }

  throw new Error(`Path is outside allowed roots: ${inputPath}`);
}

export async function executeFileTool(
  call: FunctionToolCall,
  opts: { allowedRoots: string[] }
): Promise<string> {
  if (call.name === "file_read") {
    const parsed = FileReadArgs.safeParse(safeJsonParse(call.argumentsJson));
    if (!parsed.success) {
      return `Invalid arguments for file_read: ${parsed.error.toString()}`;
    }

    const { path: rawPath, startLine, maxLines } = parsed.data;
    let fp: string;
    try {
      fp = resolveAllowedPath(rawPath, opts.allowedRoots);
    } catch (err) {
      return (err as Error).message;
    }

    let raw: string;
    try {
      raw = await fs.readFile(fp, "utf8");
    } catch (err) {
      return `file_read failed: ${(err as Error).message}`;
    }

    const lines = raw.split(/\r?\n/);
    const startIdx = Math.max(0, startLine - 1);
    const endIdx = Math.min(lines.length, startIdx + maxLines);
    const chunk = lines.slice(startIdx, endIdx);

    return [
      `Path: ${fp}`,
      `Range: ${startLine}-${startIdx + chunk.length}`,
      "",
      ...chunk,
    ].join("\n");
  }

  if (call.name === "file_write") {
    const parsed = FileWriteArgs.safeParse(safeJsonParse(call.argumentsJson));
    if (!parsed.success) {
      return `Invalid arguments for file_write: ${parsed.error.toString()}`;
    }

    const { path: rawPath, content, mode } = parsed.data;
    let fp: string;
    try {
      fp = resolveAllowedPath(rawPath, opts.allowedRoots);
    } catch (err) {
      return (err as Error).message;
    }

    try {
      await fs.mkdir(path.dirname(fp), { recursive: true });
      if (mode === "append") {
        await fs.appendFile(fp, content, "utf8");
      } else {
        await fs.writeFile(fp, content, "utf8");
      }
      return `OK: wrote file (${mode}) ${fp}`;
    } catch (err) {
      return `file_write failed: ${(err as Error).message}`;
    }
  }

  if (call.name === "file_edit") {
    const parsed = FileEditArgs.safeParse(safeJsonParse(call.argumentsJson));
    if (!parsed.success) {
      return `Invalid arguments for file_edit: ${parsed.error.toString()}`;
    }

    const { path: rawPath, replacements, createIfMissing } = parsed.data;
    let fp: string;
    try {
      fp = resolveAllowedPath(rawPath, opts.allowedRoots);
    } catch (err) {
      return (err as Error).message;
    }

    let content = "";
    try {
      content = await fs.readFile(fp, "utf8");
    } catch (err) {
      if ((err as any)?.code === "ENOENT" && createIfMissing) {
        content = "";
      } else {
        return `file_edit failed: ${(err as Error).message}`;
      }
    }

    const applied: string[] = [];
    let next = content;

    for (let i = 0; i < replacements.length; i++) {
      const r = replacements[i];
      const found = countOccurrences(next, r.from);
      if (found === 0) {
        return `file_edit failed: replacement #${i + 1} not found: ${JSON.stringify(r.from)}`;
      }

      if (r.replaceAll) {
        next = next.split(r.from).join(r.to);
        applied.push(`#${i + 1}: replaced all (${found})`);
      } else {
        next = next.replace(r.from, r.to);
        applied.push(`#${i + 1}: replaced first match`);
      }
    }

    try {
      await fs.mkdir(path.dirname(fp), { recursive: true });
      await fs.writeFile(fp, next, "utf8");
      return [
        `OK: edited file ${fp}`,
        `Applied: ${applied.length} replacement(s)`,
        ...applied.map((x) => `- ${x}`),
      ].join("\n");
    } catch (err) {
      return `file_edit failed: ${(err as Error).message}`;
    }
  }

  return `Unknown tool: ${call.name}`;
}

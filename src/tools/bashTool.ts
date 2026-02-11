import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

import type { FunctionToolCall, FunctionToolDef } from "../providers/types.js";
import { expandHome } from "../utils/path.js";

const execFileAsync = promisify(execFile);

const BashArgs = z
  .object({
    command: z.array(z.string().min(1)).min(1),
    cwd: z.string().min(1).optional(),
    timeoutMs: z.number().int().min(500).max(300000).optional(),
  })
  .strict();

export const bashToolDefs: FunctionToolDef[] = [
  {
    name: "bash",
    description:
      "Run a command with argv form. Prefer ['bash','-lc','...'] for shell syntax. Execution is restricted to configured allowed roots.",
    strict: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        command: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          description: "Command argv, e.g. ['bash','-lc','ls -la']",
        },
        cwd: { type: "string", description: "Optional working directory under allowed roots." },
        timeoutMs: { type: "integer", minimum: 500, maximum: 300000 },
      },
      required: ["command", "cwd", "timeoutMs"],
    },
  },
];

function safeJsonParse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

function resolveRoots(roots: string[]): string[] {
  return roots.map((r) => path.resolve(expandHome(r)));
}

function formatOutOfRootsMessage(inputPath: string, candidates: string[], roots: string[]): string {
  const tipRoot = roots[0];
  return [
    "Invalid bash.cwd: path is outside allowed roots.",
    `requestedCwd: ${inputPath}`,
    "resolvedCandidates:",
    ...candidates.map((c) => `- ${c}`),
    "allowedRoots:",
    ...roots.map((r) => `- ${r}`),
    tipRoot ? `Tip: set cwd to an allowed root/subdir, e.g. ${tipRoot}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function resolveAllowedPath(inputPath: string, roots: string[]): string {
  const expanded = expandHome(inputPath);

  const candidates: string[] = [];
  if (path.isAbsolute(expanded)) {
    candidates.push(path.resolve(expanded));
  } else {
    for (const root of roots) {
      candidates.push(path.resolve(root, expanded));
    }
  }

  for (const candidate of candidates) {
    for (const root of roots) {
      const rel = path.relative(root, candidate);
      if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
        return candidate;
      }
    }
  }

  throw new Error(formatOutOfRootsMessage(inputPath, candidates, roots));
}

function clampOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... [truncated ${text.length - maxChars} chars]`;
}

export async function executeBashTool(
  call: FunctionToolCall,
  opts: {
    enabled: boolean;
    roots: string[];
    defaultCwd: string;
    timeoutMs: number;
    maxOutputChars: number;
  }
): Promise<string> {
  if (call.name !== "bash") return `Unknown tool: ${call.name}`;

  if (!opts.enabled) {
    return "bash tool is disabled by config.agents.defaults.shell.enabled=false";
  }

  const parsed = BashArgs.safeParse(safeJsonParse(call.argumentsJson));
  if (!parsed.success) {
    return `Invalid arguments for bash: ${parsed.error.toString()}`;
  }

  const { command, cwd, timeoutMs } = parsed.data;
  const roots = resolveRoots(opts.roots);

  if (!roots.length) {
    return "bash tool unavailable: no allowed roots configured.";
  }

  let runCwd: string;
  try {
    runCwd = resolveAllowedPath(cwd ?? opts.defaultCwd, roots);
  } catch (err) {
    return (err as Error).message;
  }

  const [file, ...args] = command;
  if (!file) {
    return "Invalid arguments for bash: command is empty.";
  }

  try {
    const result = await execFileAsync(file, args, {
      cwd: runCwd,
      timeout: timeoutMs ?? opts.timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      encoding: "utf8",
      env: process.env,
    });

    const stdout = clampOutput(result.stdout ?? "", opts.maxOutputChars);
    const stderr = clampOutput(result.stderr ?? "", opts.maxOutputChars);

    return [
      `exitCode: 0`,
      `cwd: ${runCwd}`,
      `command: ${JSON.stringify(command)}`,
      "stdout:",
      stdout || "",
      "stderr:",
      stderr || "",
    ].join("\n");
  } catch (err: any) {
    const stdout = clampOutput(String(err?.stdout ?? ""), opts.maxOutputChars);
    const stderr = clampOutput(String(err?.stderr ?? err?.message ?? ""), opts.maxOutputChars);
    const code = typeof err?.code === "number" ? err.code : "unknown";

    return [
      `exitCode: ${code}`,
      `cwd: ${runCwd}`,
      `command: ${JSON.stringify(command)}`,
      "stdout:",
      stdout || "",
      "stderr:",
      stderr || "",
    ].join("\n");
  }
}

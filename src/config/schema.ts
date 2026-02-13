import { z } from "zod";

const OpenAIProviderSchema = z
  .object({
    type: z.literal("openai"),
    apiKey: z.string().min(1),
    // For OpenAI-compatible servers (OpenAI, OpenRouter, vLLM, etc.).
    baseUrl: z.string().min(1).optional(),
    defaultModel: z.string().min(1).optional(),
    responsesApi: z
      .object({
        enabled: z.boolean().optional().default(true),
      })
      .optional()
      .default({ enabled: true }),
  })
  .strict();

const AnthropicProviderSchema = z
  .object({
    type: z.literal("anthropic"),
    apiKey: z.string().min(1),
    // For Anthropic-compatible gateways.
    baseUrl: z.string().min(1).optional(),
    defaultModel: z.string().min(1).optional(),
    anthropicVersion: z.string().min(1).optional().default("2023-06-01"),
  })
  .strict();

export const ProviderSchema = z.discriminatedUnion("type", [
  OpenAIProviderSchema,
  AnthropicProviderSchema,
]);
export type ProviderConfig = z.infer<typeof ProviderSchema>;

export const ConfigSchema = z
  .object({
    providers: z.record(z.string().min(1), ProviderSchema),
    agents: z
      .object({
        defaults: z
          .object({
            provider: z.string().min(1),
            // Workspace directory for shared memory files.
            workspace: z.string().min(1).default("~/.tangram/workspace"),
            recursionLimit: z.number().int().min(1).max(500).optional().default(25),
            skills: z
              .object({
                enabled: z.boolean().optional().default(true),
                // Extra skill roots. We also scan a couple of built-in defaults.
                roots: z.array(z.string().min(1)).optional().default([]),
                maxSkills: z.number().int().min(1).max(200).optional().default(40),
                hotReload: z
                  .object({
                    enabled: z.boolean().optional().default(true),
                    debounceMs: z.number().int().min(100).max(10000).optional().default(800),
                    logDiff: z.boolean().optional().default(true),
                  })
                  .strict()
                  .optional()
                  .default({ enabled: true, debounceMs: 800, logDiff: true }),
              })
              .strict()
              .optional()
              .default({
                enabled: true,
                roots: [],
                maxSkills: 40,
                hotReload: { enabled: true, debounceMs: 800, logDiff: true },
              }),
            files: z
              .object({
                enabled: z.boolean().optional().default(true),
                // If true, skip path root restrictions and allow any local path.
                fullAccess: z.boolean().optional().default(false),
                roots: z.array(z.string().min(1)).optional().default(["~/.tangram"]),
              })
              .strict()
              .optional()
              .default({
                enabled: true,
                fullAccess: false,
                roots: ["~/.tangram"],
              }),
            shell: z
              .object({
                enabled: z.boolean().optional().default(false),
                // If true, skip cwd root restrictions and allow any local path.
                fullAccess: z.boolean().optional().default(false),
                roots: z.array(z.string().min(1)).optional().default(["~/.tangram"]),
                defaultCwd: z.string().min(1).optional().default("~/.tangram/workspace"),
                timeoutMs: z.number().int().min(500).max(300000).optional().default(120000),
                maxOutputChars: z.number().int().min(200).max(200000).optional().default(12000),
              })
              .strict()
              .optional()
              .default({
                enabled: false,
                fullAccess: false,
                roots: ["~/.tangram"],
                defaultCwd: "~/.tangram/workspace",
                timeoutMs: 120000,
                maxOutputChars: 12000,
              }),
            heartbeat: z
              .object({
                enabled: z.boolean().optional().default(false),
                intervalSeconds: z.number().int().min(10).max(86400).optional().default(300),
                filePath: z.string().min(1).optional().default("~/.tangram/workspace/HEARTBEAT.md"),
                threadId: z.string().min(1).optional().default("heartbeat"),
              })
              .strict()
              .optional()
              .default({
                enabled: false,
                intervalSeconds: 300,
                filePath: "~/.tangram/workspace/HEARTBEAT.md",
                threadId: "heartbeat",
              }),
            cron: z
              .object({
                enabled: z.boolean().optional().default(true),
                tickSeconds: z.number().int().min(5).max(3600).optional().default(15),
                storePath: z.string().min(1).optional().default("~/.tangram/workspace/cron-tasks.json"),
                defaultThreadId: z.string().min(1).optional().default("cron"),
              })
              .strict()
              .optional()
              .default({
                enabled: true,
                tickSeconds: 15,
                storePath: "~/.tangram/workspace/cron-tasks.json",
                defaultThreadId: "cron",
              }),
            session: z
              .object({
                enabled: z.boolean().optional().default(true),
                dir: z.string().min(1).optional().default("~/.tangram/workspace/sessions"),
                restoreMessages: z.number().int().min(1).max(500).optional().default(100),
                persistAssistantEmpty: z.boolean().optional().default(false),
              })
              .strict()
              .optional()
              .default({
                enabled: true,
                dir: "~/.tangram/workspace/sessions",
                restoreMessages: 100,
                persistAssistantEmpty: false,
              }),
            model: z.string().min(1).optional(),
            temperature: z.number().min(0).max(2).optional(),
            systemPrompt: z.string().optional(),
          })
          .strict(),
      })
      .strict(),
    channels: z
      .object({
        telegram: z
          .object({
            enabled: z.boolean().optional().default(false),
            token: z.string().min(1).optional(),
            progressUpdates: z.boolean().optional().default(true),
            // Telegram numeric user IDs as strings (e.g. "12345678"). Empty => allow all.
            allowFrom: z.array(z.string().min(1)).optional().default([]),
          })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .superRefine((cfg, ctx) => {
    const tg = cfg.channels.telegram;
    if (tg?.enabled && !tg.token) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["channels", "telegram", "token"],
        message: "token is required when channels.telegram.enabled=true",
      });
    }
  })
  .strict();

export type AppConfig = z.infer<typeof ConfigSchema>;

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

export const ProviderSchema = z.discriminatedUnion("type", [OpenAIProviderSchema]);
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
            workspace: z.string().min(1).default("~/.tangram2/workspace"),
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
            token: z.string().min(1),
            // Telegram numeric user IDs as strings (e.g. "12345678"). Empty => allow all.
            allowFrom: z.array(z.string().min(1)).optional().default([]),
          })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict();

export type AppConfig = z.infer<typeof ConfigSchema>;

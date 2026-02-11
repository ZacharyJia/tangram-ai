import type { OnboardAnswers } from "./prompts.js";

type AnyJson = Record<string, unknown>;

export function buildConfigJson(answers: OnboardAnswers): string {
  const provider: AnyJson = {
    type: answers.providerType,
    apiKey: answers.apiKey,
  };
  if (answers.baseUrl) provider.baseUrl = answers.baseUrl;
  if (answers.defaultModel) provider.defaultModel = answers.defaultModel;

  const config: AnyJson = {
    providers: {
      [answers.providerKey]: provider,
    },
    agents: {
      defaults: {
        provider: answers.providerKey,
        workspace: "~/.tangram2/workspace",
        skills: {
          enabled: true,
          roots: ["~/.tangram2/skills"],
          maxSkills: 40,
        },
        shell: {
          enabled: answers.shellEnabled,
          fullAccess: answers.shellFullAccess,
          roots: ["~/.tangram2"],
          defaultCwd: "~/.tangram2/workspace",
          timeoutMs: 120000,
          maxOutputChars: 12000,
        },
        heartbeat: {
          enabled: false,
          intervalSeconds: 300,
          filePath: "~/.tangram2/workspace/HEARTBEAT.md",
          threadId: "heartbeat",
        },
        cron: {
          enabled: true,
          tickSeconds: 15,
          storePath: "~/.tangram2/workspace/cron-tasks.json",
          defaultThreadId: "cron",
        },
        temperature: 0.7,
        systemPrompt: "You are a helpful assistant. Keep replies concise.",
      },
    },
    channels: {
      telegram: answers.enableTelegram
        ? {
            enabled: true,
            token: answers.telegramToken,
            allowFrom: answers.telegramAllowFrom,
          }
        : {
            enabled: false,
            allowFrom: [],
          },
    },
  };

  return JSON.stringify(config, null, 2) + "\n";
}

export function buildHeartbeatTemplate(): string {
  return [
    "# HEARTBEAT",
    "",
    "Put recurring autonomous instructions here.",
    "The agent periodically reads this file and executes it when heartbeat is enabled.",
    "",
    "Example:",
    "- Review pending cron tasks and summarize upcoming actions.",
  ].join("\n");
}

export function buildCronStoreTemplate(): string {
  return JSON.stringify(
    {
      version: 1,
      tasks: [],
    },
    null,
    2
  );
}

export function buildSkillsReadmeTemplate(): string {
  return [
    "# Tangram2 Skills",
    "",
    "Place each skill in its own folder:",
    "",
    "- ~/.tangram2/skills/<skill-name>/SKILL.md",
    "",
    "The runtime discovers these folders and injects skill metadata into prompts.",
  ].join("\n");
}


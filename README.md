# tangram2 (MVP)

Minimal Telegram chatbot built with **TypeScript + LangGraph**, with **multi-provider config** and **OpenAI Responses API** as the default provider.

## Quick Start

1) Install deps

```bash
npm i
```

2) Create config

```bash
mkdir -p ~/.tangram2 && cp config.example.json ~/.tangram2/config.json
```

Edit `~/.tangram2/config.json` and set:
- `channels.telegram.token`
- `providers.<yourProviderKey>.apiKey`
- optionally `providers.<yourProviderKey>.baseUrl`

Supported providers:
- `openai` (Responses API)
- `anthropic` (Messages API, supports custom `baseUrl`)

3) Run

```bash
npm run dev -- gateway
npm run dev -- gateway --verbose
npm run dev -- onboard
```

## Onboard Wizard

Run `npm run dev -- onboard` for an interactive setup that:
- asks for provider/API/Telegram settings
- applies developer-default permissions (shell enabled but restricted)
- initializes `~/.tangram2` directories and baseline files
- handles existing files one by one (`overwrite` / `skip` / `backup then overwrite`)

## Memory (Shared)

Shared memory lives under the configured workspace directory (default: `~/.tangram2/workspace`):
- Long-term memory: `memory/memory.md`
- Daily notes: `memory/YYYY-MM-DD.md`

Telegram commands:
- `/memory` show memory context
- `/remember <text>` append to today's daily memory
- `/remember_long <text>` append to long-term memory

Telegram UX behaviors:
- bot sends `typing` action while processing
- during tool-calling loops, progress hints may be sent as temporary `⏳ ...` updates (controlled by `channels.telegram.progressUpdates`, default `true`)

## Memory Tools (LLM)

The agent exposes function tools to the model (via OpenAI Responses API):
- `memory_search` search shared memory files
- `memory_write` append to shared memory files
- `file_read` read local skill/content files from allowed roots
- `file_write` write local files under allowed roots
- `file_edit` edit files by targeted text replacement
- `bash` execute CLI commands when `agents.defaults.shell.enabled=true`
- `cron_schedule` schedule one-time/repeating callbacks
- `cron_list` list scheduled callbacks
- `cron_cancel` cancel scheduled callbacks

The LangGraph workflow also runs a post-reply "memory reflection" node that can automatically summarize the latest turn into memory using a strict JSON format prompt.

## Skills Metadata

The runtime discovers local skills and injects a compact skills list into the model instructions, so the model can decide which skill to open/use.

By default it scans:
- `~/.tangram2/skills`

You can customize via `agents.defaults.skills`:

```json
{
  "agents": {
    "defaults": {
      "skills": {
        "enabled": true,
        "roots": [
          "~/.tangram2/skills"
        ],
        "maxSkills": 40
      }
    }
  }
}
```

`file_read` / `file_write` / `file_edit` are path-restricted to these resolved skill roots.

## Shell Tool (Optional)

Enable shell execution only when needed:

```json
{
  "agents": {
    "defaults": {
      "shell": {
        "enabled": true,
        "fullAccess": false,
        "roots": ["~/.tangram2"],
        "defaultCwd": "~/.tangram2/workspace",
        "timeoutMs": 120000,
        "maxOutputChars": 12000
      }
    }
  }
}
```

When enabled, the model can call a `bash` tool with argv form commands (e.g. `['bash','-lc','ls -la']`), constrained to allowed roots.

Set `shell.fullAccess=true` to disable cwd root restrictions and allow any local path.

## Heartbeat (Optional)

Heartbeat periodically reads `HEARTBEAT.md` and triggers a model run with that content.

```json
{
  "agents": {
    "defaults": {
      "heartbeat": {
        "enabled": true,
        "intervalSeconds": 300,
        "filePath": "~/.tangram2/workspace/HEARTBEAT.md",
        "threadId": "heartbeat"
      }
    }
  }
}
```

## Cron Scheduler

Cron scheduler runs due tasks and sends their payload to the model at the scheduled time.

```json
{
  "agents": {
    "defaults": {
      "cron": {
        "enabled": true,
        "tickSeconds": 15,
        "storePath": "~/.tangram2/workspace/cron-tasks.json",
        "defaultThreadId": "cron"
      }
    }
  }
}
```

Model-facing cron tools:
- `cron_schedule` set run time, repeat mode, callback text payload
- `cron_schedule_local` set local timezone schedules (e.g. daily 09:00 Asia/Shanghai)
- `cron_list` inspect pending tasks
- `cron_cancel` remove a task by id

## Config

This project supports **multiple provider instances**. Example:

```json
{
  "providers": {
    "openai": {
      "type": "openai",
      "apiKey": "sk-...",
      "baseUrl": "https://api.openai.com/v1",
      "defaultModel": "gpt-4.1-mini"
    },
    "anthropic": {
      "type": "anthropic",
      "apiKey": "sk-ant-...",
      "baseUrl": "https://api.anthropic.com",
      "defaultModel": "claude-3-5-sonnet-latest"
    },
    "local": {
      "type": "openai",
      "apiKey": "dummy",
      "baseUrl": "http://localhost:8000/v1",
      "defaultModel": "meta-llama/Llama-3.1-8B-Instruct"
    }
  },
  "agents": {
    "defaults": {
      "provider": "openai",
      "temperature": 0.7,
      "systemPrompt": "You are a helpful assistant."
    }
  },
  "channels": {
    "telegram": {
      "enabled": true,
      "token": "123456:ABCDEF...",
      "allowFrom": []
    }
  }
}
```

Config lookup order:
- `--config <path>`
- `TANGRAM2_CONFIG`
- `~/.tangram2/config.json`
- `./config.json` (legacy fallback)

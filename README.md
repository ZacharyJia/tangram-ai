# Tangram AI (MVP)

Minimal Telegram chatbot built with **TypeScript + LangGraph**, with **multi-provider config** and **OpenAI Responses API** as the default provider.

## Quick Start

1) Install deps

```bash
npm i
```

2) Create config

```bash
mkdir -p ~/.tangram-ai && cp config.example.json ~/.tangram-ai/config.json
```

Edit `~/.tangram-ai/config.json` and set:
- `channels.telegram.token`
- `providers.<yourProviderKey>.apiKey`
- optionally `providers.<yourProviderKey>.baseUrl`

Supported providers:
- `openai` (Responses API)
- `anthropic` (Messages API, supports custom `baseUrl`)

3) Run

```bash
npm run gateway -- --verbose
npm run onboard
npm run gateway -- status
```

## Deploy & Upgrade

Deployment bootstrap is part of `onboard`.

```bash
npm run onboard
```

During onboarding, the wizard can optionally install/start a user-level `systemd` service.

Gateway service operations:

```bash
npm run gateway -- status
npm run gateway -- stop
npm run gateway -- restart
```

Upgrade and rollback:

```bash
npm run upgrade -- --dry-run
npm run upgrade -- --version v0.0.1
npm run rollback -- --to v0.0.1
```

Notes:
- `upgrade` uses global npm install (`npm install -g tangram-ai@...`) and auto-restarts service
- use `--no-restart` to skip restart
- if `systemd --user` is unavailable, run foreground mode: `npm run gateway -- --verbose`

## Release Workflow

This repo includes a baseline release pipeline:

- CI workflow: `.github/workflows/ci.yml`
  - runs on push/PR
  - executes `npm ci`, `npm run lint`, `npm test`, `npm run build`
- Release workflow: `.github/workflows/release.yml`
  - triggers on tag push `v*`
  - builds project and uploads tarball asset to GitHub Release
- npm publish workflow: `.github/workflows/npm-publish.yml`
  - triggers on tag push `v*`
  - executes `npm ci`, `npm run build`, `npm publish`

### One-time setup for npm CI publish

1. Configure npm Trusted Publishing for this GitHub repository
2. Ensure workflow permission includes `id-token: write` (already configured)
3. No `NPM_TOKEN` secret is required

After this setup, pushing a version tag (for example `v0.0.2`) will publish `tangram-ai` to npm automatically.

### Local release commands

- Bump version only:

```bash
npm run release:patch
npm run release:minor
npm run release:major
```

- Prepare a full release (bump version + build + commit + tag):

```bash
npm run release:prepare:patch
npm run release:prepare:minor
npm run release:prepare:major
```

After `release:prepare:*` completes, push branch and tag:

```bash
git push origin master
git push origin vX.Y.Z
```

Pushing the tag triggers GitHub Actions release creation automatically.

## Onboard Wizard

Run `npm run onboard` for an interactive setup that:
- asks for provider/API/Telegram settings
- applies developer-default permissions (shell enabled but restricted)
- initializes `~/.tangram-ai` directories and baseline files
- initializes runtime directories under `~/.tangram-ai/app`
- can install/start user-level `systemd` service
- handles existing files one by one (`overwrite` / `skip` / `backup then overwrite`)

## Memory (Shared)

Shared memory lives under the configured workspace directory (default: `~/.tangram-ai/workspace`):
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
- `~/.tangram-ai/skills`

You can customize via `agents.defaults.skills`:

```json
{
  "agents": {
    "defaults": {
      "skills": {
        "enabled": true,
        "roots": [
          "~/.tangram-ai/skills"
        ],
        "maxSkills": 40,
        "hotReload": {
          "enabled": true,
          "debounceMs": 800,
          "logDiff": true
        }
      }
    }
  }
}
```

Hot reload behavior:
- skill directory/file changes are detected with filesystem watchers
- reload is debounced (`hotReload.debounceMs`) to avoid noisy rapid rescans
- updates apply globally to the next LLM execution without restarting gateway
- when `hotReload.logDiff=true`, gateway logs added/removed/changed skills

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
        "roots": ["~/.tangram-ai"],
        "defaultCwd": "~/.tangram-ai/workspace",
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
        "filePath": "~/.tangram-ai/workspace/HEARTBEAT.md",
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
        "storePath": "~/.tangram-ai/workspace/cron-tasks.json",
        "defaultThreadId": "cron"
      }
    }
  }
}
```

Model-facing cron tools:
- `cron_schedule` set run time, repeat mode, and `callbackPrompt` (sent to model when due, not directly to user)
- `cron_schedule_local` set local timezone schedules (e.g. daily 09:00 Asia/Shanghai) and `callbackPrompt`
- `cron_list` inspect pending tasks
- `cron_cancel` remove a task by id

Compatibility note:
- old `message` field is still accepted for backward compatibility, but `callbackPrompt` is recommended

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
- `TANGRAM_AI_CONFIG` (preferred)
- `TANGRAM2_CONFIG` (legacy compatibility)
- `~/.tangram-ai/config.json` (preferred)
- `~/.tangram2/config.json` (legacy compatibility)
- `./config.json` (legacy fallback)

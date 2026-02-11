# tangram2 (MVP)

Minimal Telegram chatbot built with **TypeScript + LangGraph**, with **multi-provider config** and **OpenAI Responses API** as the default provider.

## Quick Start

1) Install deps

```bash
npm i
```

2) Create config

```bash
cp config.example.json config.json
```

Edit `config.json` and set:
- `channels.telegram.token`
- `providers.<yourProviderKey>.apiKey`
- optionally `providers.<yourProviderKey>.baseUrl`

3) Run

```bash
npm run dev -- gateway
```

## Memory (Shared)

Shared memory lives under the configured workspace directory (default: `~/.tangram2/workspace`):
- Long-term memory: `memory/memory.md`
- Daily notes: `memory/YYYY-MM-DD.md`

Telegram commands:
- `/memory` show memory context
- `/remember <text>` append to today's daily memory
- `/remember_long <text>` append to long-term memory

## Memory Tools (LLM)

The agent exposes function tools to the model (via OpenAI Responses API):
- `memory_search` search shared memory files
- `memory_write` append to shared memory files

The LangGraph workflow also runs a post-reply "memory reflection" node that can automatically summarize the latest turn into memory using a strict JSON format prompt.

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
- `./config.json`
- `~/.tangram2/config.json`

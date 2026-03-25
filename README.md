# 🎩 Home PiPi

> Your AI butler doesn't judge. He just quietly disapproves.

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-green.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](https://www.typescriptlang.org)

An AI butler for your smart home that runs on a Raspberry Pi, speaks Russian,
remembers your habits, and has opinions about your cleaning schedule.

## Why This Exists

[NanoClaw](https://github.com/qwibitai/nanoclaw) proved that an AI assistant
doesn't need half a million lines of code. We took that philosophy — *small enough
to understand, secure enough to trust* — and pointed it at a Raspberry Pi 4
with IKEA lights and a fridge that's always empty.

The result is **Jeeves**: a butler powered by Gemini, backed by SQLite,
who manages your groceries, controls your lights, monitors your network,
and will politely remind you that the bathroom hasn't been cleaned in twelve days.

This is not a framework. It's a working butler. Fork it, customize it, make it yours.

## Philosophy

- **Small enough to understand.** One process, a handful of files. Read the whole codebase over lunch.
- **Skills over features.** New capability? Write a skill file — tools, handlers, crons, migrations, all in one place.
- **Built for the household.** Not for the enterprise. Not for scale. For the people who live in your apartment.
- **Customization = code changes.** No YAML sprawl. Want different behavior? Change the code. It's 30 files.

## Quick Start

### Requirements

- **Raspberry Pi 4 or 5** with **≥ 4 GB RAM** (or any Linux/macOS machine with Docker)
- Node.js 20+
- Docker & Docker Compose

### Setup

1. **Clone:**
   ```bash
   git clone https://github.com/amyotoff/Home_Pipi.git
   cd Home_Pipi
   ```

2. **Configure:** Copy `.env.example` to `.env` and fill in:
   ```bash
   cp .env.example .env
   ```

   | Variable | Where to get it |
   |----------|----------------|
   | `TELEGRAM_BOT_TOKEN` | [@BotFather](https://t.me/BotFather) |
   | `GEMINI_API_KEY` | [Google AI Studio](https://aistudio.google.com) |
   | `HOUSEHOLD_CHAT_ID` | Your Telegram group chat ID |
   | `OWNER_TG_IDS` | Your Telegram user IDs (comma-separated) |

   > ⚠️ **Security: The bot is fail-closed by default.** If `OWNER_TG_IDS`, `TELEGRAM_BOT_TOKEN`, or `GEMINI_API_KEY` are missing, the bot will refuse to start. This prevents accidental exposure. See [SECURITY.md](SECURITY.md).

3. **Launch:**
   ```bash
   docker compose up -d
   ```

4. **Talk to Jeeves** in Telegram. He's ready.

### Development

```bash
# Run with hot reload (uses docker-compose.dev.yml overrides)
docker compose -f docker-compose.yml -f docker-compose.dev.yml up

# Or run locally
npm install
npm run dev

# Tests
npm test

# Type check
npm run typecheck
```

## What It Does

| Skill | What it does |
|-------|-------------|
| 🛒 Shopping | Shared grocery list with purchase tracking |
| 🧹 Cleaning | Task rotation, photo verification, guilt-tripping |
| 💡 Lights | IKEA Tradfri control (on/off/brightness/color) |
| 🌡️ Room Sensor | Zigbee2MQTT temperature/humidity monitoring |
| ❄️ AC Control | Air conditioner management |
| 🌤️ Weather | Forecasts via Open-Meteo (no API key needed) |
| 🧠 Memory | Learns habits, remembers preferences, consolidates conversations |
| 🌐 Network | Device discovery, ARP scanning, port checking |
| 🔧 Net Debug | Ping, traceroute, DNS lookup, Docker management |
| 🏠 Presence | Detect who's home via IP/BLE |
| 📝 Todos | Personal to-do lists per resident |
| ⏰ Reminders | "Remind me to..." with natural language |
| 🍳 Chef | Recipe suggestions based on what you have (and allergies) |
| 🌐 Browsing | Web search and page content extraction |
| 🖥️ WebRun | Execute web automation tasks via Playwright |
| 🔧 Ops | System health, token usage, cost tracking |

### Outbound Channels

Channels auto-register when their env vars are set:

| Channel | Env Vars |
|---------|----------|
| WhatsApp | `WHATSAPP_ENABLED=true` |
| Discord | `DISCORD_BOT_TOKEN`, `DISCORD_CHANNEL_ID` |
| Gmail | `CONCIERGE_SMTP_HOST`, `CONCIERGE_SMTP_USER`, `CONCIERGE_SMTP_PASS` |

## Architecture

```
Telegram → Router → LLM (Gemini / Ollama) → Skills → SQLite
                                               ↓
                                        Channels (Discord, Gmail, WhatsApp)
```

Single Node.js process. Skills self-register at startup. LLM calls tools, tools return
results, LLM responds. If Gemini is down, Ollama kicks in. If Ollama is down,
you can still turn the lights on.

### Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Bootstrap: DB, channels, skills, scheduler, Telegram |
| `src/router.ts` | Message routing, access control, trigger detection |
| `src/core/llm.ts` | Gemini/Ollama LLM orchestration with tool loop |
| `src/db.ts` | SQLite schema, CRUD, migrations |
| `src/skills/_registry.ts` | Skill registration (tools, handlers, crons) |
| `src/skills/_types.ts` | `SkillManifest` interface |
| `src/channels/_registry.ts` | Outbound channel registration |
| `src/task-scheduler.ts` | Cron-based proactive tasks |
| `src/config.ts` | Environment variable parsing |
| `src/utils/shell.ts` | Sandboxed command execution |

## Creating a Skill

```typescript
// src/skills/my-thing.skill.ts
import { SkillManifest } from './_types';
import { Type } from '@google/genai';

const skill: SkillManifest = {
    name: 'my-thing',
    description: 'Does a thing',
    version: '1.0.0',
    tools: [{
        name: 'do_the_thing',
        description: 'Does the thing',
        parameters: {
            type: Type.OBJECT,
            properties: {
                what: { type: Type.STRING, description: 'What to do' }
            },
            required: ['what']
        }
    }],
    handlers: {
        do_the_thing: async (args) => {
            return `Did the thing: ${args.what}`;
        }
    }
};

export default skill;
```

Then add it to `src/skills/_registry.ts`. See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## FAQ

**Can I use this without IKEA lights?**
Yes. Jeeves will manage what he can and politely lament what he can't.

**Can I use a different LLM?**
Gemini is primary, Ollama is the fallback. Swap models in `.env`. The codebase is small enough to rewire.

**Does it work without a Raspberry Pi?**
Any machine with Docker works. But running a butler on a $50 computer that sits quietly in the corner is kind of the point.

**Is this secure?**
Strict shell command allowlist (no `exec` shell injection), Docker isolation, private IP blocking for browser tools, and fail-closed owners-only access control. The bot will refuse to start if security config is missing. See [SECURITY.md](SECURITY.md). The codebase is small enough that you can actually audit it.

**Why Russian?**
Because the first household that used it speaks Russian. Jeeves understands any language Gemini supports, but his personality is best experienced in Russian.

**What does PiPi stand for?**
**Pi**-powered **Pi**pe — a pipeline that runs on a Raspberry Pi. Or it's just a fun name. Take your pick.

## Acknowledgments

Architecture inspired by [NanoClaw](https://github.com/qwibitai/nanoclaw) — the project that proved an AI assistant should be small enough to understand and secure enough to trust.

## Community

Found a bug? Have an idea? [Open an issue](https://github.com/amyotoff/Home_Pipi/issues).

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for breaking changes and release notes.

## License

[MIT](LICENSE) — do whatever you want with it. Jeeves wouldn't have it any other way.

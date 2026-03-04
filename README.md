# xn-mc

Minecraft server management for Xandaris — Discord bot, AI chatbots, revival system, map auth, backups, and tooling.

## Components

### Discord Bot (`bot/`)
Go-based Discord bot for server management via [Crafty Controller](https://craftycontrol.com/) and RCON.

**Slash Commands:** `/status`, `/start`, `/stop`, `/restart`, `/backup`, `/mem`, `/size`, `/rcon`, `/unban`, `/help`

Also runs periodic health checks and updates [Statuspage.io](https://statuspage.io) automatically.

### Chatbots (`chatbot/`)
AI-driven Minecraft bots (mineflayer) that join the server and chat with players. Powered by xAI Grok. Managed by PM2 as `xandaris-bots`.

- **Regular bots** — Idle chatbots with unique personalities, react to player messages and server events
- **Revival bots** — Summoned by an iron golem ritual. Revived "players" that follow owner commands: mining, combat, chest management, crafting, building, and more (16 tools). Persist across restarts.

**Revival webhook** (`:8765`):
- `POST /revival` — Trigger a revival (called by the MC plugin)
- `POST /rbsay` — Inject a message into a revival bot's queue for testing
- `GET /rblist` — List active revival bots

Revival events are announced as embeds in the Discord `#deaths` channel.

### Map Auth (`map-auth/`)
Go service for [BlueMap](https://bluemap.bluecolored.de/) access control. Discord OAuth2 + guild role check behind nginx `auth_request` at `map.xandaris.space`.

### Scripts (`scripts/`)
- `setup.sh` — Sets up Crafty Controller (podman) and builds the bot
- `backup.py` — World backup/restore to S3

## Setup

```bash
cp .env.example .env
# Fill in credentials (see .env.example for all variables)
./scripts/setup.sh
```

## Releases

Pre-built binaries (linux/arm64 + linux/amd64) on [GitHub Releases](https://github.com/hunterjsb/xn-mc/releases) via tag push:

- `bot-v*` — Discord bot
- `map-auth-v*` — Map auth service

## License

MIT

# xn-mc

Minecraft server management for Xandaris — Discord bot, map auth, backups, and setup tooling.

## Components

### Discord Bot (`bot/`)
Go-based Discord bot that manages the Minecraft server through [Crafty Controller](https://craftycontrol.com/) and RCON.

**Slash Commands:**
- `/status` — Server status (players, CPU, memory, disk %, version)
- `/start` `/stop` `/restart` — Server lifecycle via Crafty
- `/backup` — Trigger a server backup via Crafty
- `/mem` — System resource usage (CPU, memory)
- `/size` — Disk breakdown (overworld, nether, end, BlueMap, plugins, total)
- `/rcon <command>` — Execute RCON commands
- `/unban <player>` — Unban a deathbanned player and reset their spawn
- `/help` — List all commands

Also runs periodic health checks (Crafty + RCON) and updates [Statuspage.io](https://statuspage.io) components automatically.

### Map Auth (`map-auth/`)
Standalone Go service that replaces vouch-proxy for [BlueMap](https://bluemap.bluecolored.de/). Handles Discord OAuth2 and checks guild roles before granting access — only users with admin/mod/staff roles can view the map at `map.xandaris.space`.

Drops into the same nginx `auth_request` slot as vouch-proxy — same port (9090), same endpoints.

### Scripts (`scripts/`)
- `setup.sh` — Sets up Crafty Controller (podman) and builds the bot
- `backup.py` — World backup/restore to S3

## Setup

```bash
cp .env.example .env
# Fill in your credentials (see .env.example for all variables)
./scripts/setup.sh
```

### Environment Variables

**Required:**
- `RCON_IP` / `RCON_PW` — RCON connection
- `CRAFTY_URL` / `CRAFTY_API_KEY` / `CRAFTY_SERVER_ID` / `CRAFTY_SERVER_PATH` — Crafty Controller
- `DISCORD_TOKEN` / `DISCORD_CHANNEL_ID` / `DISCORD_GUILD_ID` — Discord bot

**Optional:**
- `S3_BUCKET` — S3 bucket for world backups
- `STATUSPAGE_API_KEY` / `STATUSPAGE_PAGE_ID` — Statuspage.io integration
- `STATUSPAGE_MINECRAFT_SERVER_COMPONENT_ID` / `STATUSPAGE_BOT_COMPONENT_ID` — Component IDs

## Releases

Pre-built binaries (linux/arm64 + linux/amd64) are published to [GitHub Releases](https://github.com/hunterjsb/xn-mc/releases) on tag push:

- `bot-v*` — Discord bot binary
- `map-auth-v*` — Map auth service binary

## License

MIT

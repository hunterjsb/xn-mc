# xn-mc

Minecraft server management and Discord bot integration.
- Send RCON commands to the server from discord
- start / stop / monitor from discord
- status page [WIP]
- download and manage server.jar's, including the latest snapshot
- backup and migrate worlds

## Setup

Copy `.env.example` to `.env` and configure:
```bash
cp .env.example .env
```

## Usage

### Discord Bot
```bash
cd bot && go run .
```

**Commands:**
- `!status` - Check server status
- `!start` / `!stop` - Start/stop server
- `!mem` - Show memory usage
- `!clearlogs` / `!archivelogs` / `!logsize` - Log management
- Any other command → sent to server via RCON

### Server Updates
```bash
python scripts/update_server.py
```

### Backups
```bash
python scripts/backup.py
```

## License

MIT

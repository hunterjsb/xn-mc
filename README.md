
# xn-mc

Welcome to **xn-mc**, a repository dedicated to advanced Minecraft server management and configuration.
Our goal is to leverage **free-tier** cloud resources to improve server performance and stability while decreasing cost.

## Features

- **Server Optimization**: Scripts and configurations to boost server performance.
- **Backups and Migrations**: Manage world state across machines.
- **Discord Integration**: Manage your server with RCONN and other commands/chat.

## Usage

### Discord Bot
```bash
cd bot
go run .
```

### Server Updates
```bash
# Update to latest release
python scripts/update_server.py

# Update to latest snapshot
python scripts/update_server.py --type snapshot

# Update to specific version
python scripts/update_server.py --version_id 1.21.5
```

## License

MIT

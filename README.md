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

Fill in the following environment variables in your `.env` file:

- `WORLD_NAME`: Name of your Minecraft world.
- `SERVER_FP`: Filepath to the server directory.
- `START_COMMAND`: The command used to start your Minecraft server (e.g., "java -Xms1024M -Xmx2G -jar server.jar nogui").
- `RCON_IP`: RCON IP address and port (e.g., `0.0.0.0:25575`).
- `RCON_PW`: Your RCON password.

### AWS Configuration (Optional - for backups)
- `S3_BUCKET`: Your S3 bucket name for world backups.

### Discord Bot Configuration
- `DISCORD_CHANNEL_ID`: The Discord channel ID where the bot should operate.
- `DISCORD_TOKEN`: Your Discord bot token.
- `COMMAND_PREFIX`: The prefix for bot commands (e.g., `!`).

### Statuspage.io Integration (Optional)
To enable Statuspage.io integration, you first need to obtain an API key and identify your Page ID and Component IDs from your Statuspage account.
- `STATUSPAGE_API_KEY`: Your Statuspage API key.
- `STATUSPAGE_PAGE_ID`: The ID of your Statuspage page.
- `STATUSPAGE_MINECRAFT_SERVER_COMPONENT_ID`: The ID of the component on Statuspage representing your Minecraft server. The bot will update this component's status (e.g., Operational, Major Outage).
- `STATUSPAGE_BOT_COMPONENT_ID`: The ID of the component on Statuspage representing the Discord bot itself. The bot will update this to Operational on startup and Major Outage on shutdown.

If `STATUSPAGE_API_KEY` and `STATUSPAGE_PAGE_ID` are set, the bot will attempt to update component statuses. If the component IDs are not set, relevant updates will be skipped with a warning.

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
cd scripts && uv run python update_server.py
```

### Backups
```bash
cd scripts && uv run python backup.py upload    # backup world to S3
cd scripts && uv run python backup.py download  # restore world from S3
```

## License

MIT

#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Crafty Controller + xn-mc Bot Setup
# Replaces the old Paper setup script — Crafty now manages the MC server.
# =============================================================================
#
# WHAT THIS DOES:
#   1. Checks prerequisites (podman, go, java 21+)
#   2. Creates Crafty volume directories
#   3. Pulls and runs Crafty Controller as a podman container
#   4. Waits for Crafty to become healthy
#   5. Prints default admin credentials
#   6. Builds the Go bot
#   7. Prints next-steps instructions
#
# PORTS:
#   8443/tcp  - Crafty HTTPS panel
#   25565/tcp - Minecraft Java
#   25575/tcp - RCON
#   19132/udp - Bedrock (Geyser)
#
# AFTER RUNNING:
#   1. Log into https://localhost:8443 with the printed credentials
#   2. Create or import a Minecraft server via Crafty's web UI
#   3. Generate an API token in Crafty (User > API Tokens)
#   4. Update .env with CRAFTY_API_KEY, CRAFTY_SERVER_ID, CRAFTY_SERVER_PATH
#   5. Run the bot: ./xn-mc-bot
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
CRAFTY_DIR="$PROJECT_DIR/crafty"

CONTAINER_NAME="crafty"
CRAFTY_IMAGE="registry.gitlab.com/crafty-controller/crafty-4:latest"

# =============================================================================
# Prerequisites
# =============================================================================
echo "=== Checking prerequisites ==="

MISSING=()
command -v podman >/dev/null 2>&1 || MISSING+=("podman")
command -v go >/dev/null 2>&1 || MISSING+=("go")

if [ ${#MISSING[@]} -gt 0 ]; then
    echo "ERROR: Missing dependencies: ${MISSING[*]}"
    echo ""
    echo "Install them first:"
    echo "  Bazzite/Fedora Atomic: podman is pre-installed; brew install go"
    echo "  Fedora:                sudo dnf install podman golang"
    echo "  Ubuntu/Debian:         sudo apt install podman golang"
    echo ""
    exit 1
fi

# Check Java 21+ (needed inside Crafty for MC servers, but also useful locally)
JAVA_OK=false
if command -v java >/dev/null 2>&1; then
    JAVA_VER=$(java -version 2>&1 | head -1 | grep -oP '"?\K[0-9]+' | head -1)
    if [ "${JAVA_VER:-0}" -ge 21 ] 2>/dev/null; then
        JAVA_OK=true
    fi
fi
if [ "$JAVA_OK" = false ]; then
    echo "WARNING: Java 21+ not found locally."
    echo "  Crafty's container bundles its own JRE, but you may want Java"
    echo "  locally for debugging. Install with: brew install openjdk@21"
    echo ""
fi

echo "  podman: $(podman --version)"
echo "  go:     $(go version)"
echo ""

# =============================================================================
# Create Crafty volume directories
# =============================================================================
echo "=== Creating Crafty volume directories ==="

for dir in backups logs servers config import; do
    mkdir -p "$CRAFTY_DIR/$dir"
    echo "  crafty/$dir/"
done
echo ""

# =============================================================================
# Pull Crafty image
# =============================================================================
echo "=== Pulling Crafty Controller image ==="
podman pull "$CRAFTY_IMAGE"
echo ""

# =============================================================================
# Stop existing container if present
# =============================================================================
if podman container exists "$CONTAINER_NAME" 2>/dev/null; then
    echo "=== Stopping existing '$CONTAINER_NAME' container ==="
    podman stop "$CONTAINER_NAME" 2>/dev/null || true
    podman rm "$CONTAINER_NAME" 2>/dev/null || true
    echo ""
fi

# =============================================================================
# Run Crafty container
# =============================================================================
echo "=== Starting Crafty Controller container ==="

# Detect timezone (fall back to America/New_York)
TZ="${TZ:-$(timedatectl show -p Timezone --value 2>/dev/null || echo "America/New_York")}"

podman run -d \
    --name "$CONTAINER_NAME" \
    --restart always \
    -e TZ="$TZ" \
    -p 8443:8443 \
    -p 25565:25565 \
    -p 25575:25575 \
    -p 19132:19132/udp \
    -v "$CRAFTY_DIR/backups:/crafty/backups" \
    -v "$CRAFTY_DIR/logs:/crafty/logs" \
    -v "$CRAFTY_DIR/servers:/crafty/servers" \
    -v "$CRAFTY_DIR/config:/crafty/app/config" \
    -v "$CRAFTY_DIR/import:/crafty/import" \
    "$CRAFTY_IMAGE"

echo "  Container '$CONTAINER_NAME' started."
echo "  Timezone: $TZ"
echo ""

# =============================================================================
# Wait for Crafty to become healthy
# =============================================================================
echo "=== Waiting for Crafty to initialize ==="

CREDS_FILE="$CRAFTY_DIR/config/default-creds.txt"
MAX_WAIT=120
elapsed=0

while [ ! -f "$CREDS_FILE" ] && [ $elapsed -lt $MAX_WAIT ]; do
    sleep 2
    elapsed=$((elapsed + 2))
    printf "\r  Waiting... %ds / %ds" "$elapsed" "$MAX_WAIT"
done
echo ""

if [ -f "$CREDS_FILE" ]; then
    echo "  Crafty is ready!"
else
    echo "  WARNING: Timed out waiting for default-creds.txt after ${MAX_WAIT}s."
    echo "  The container may still be starting. Check: podman logs $CONTAINER_NAME"
fi
echo ""

# =============================================================================
# Print default credentials
# =============================================================================
if [ -f "$CREDS_FILE" ]; then
    echo "=== Crafty Default Admin Credentials ==="
    cat "$CREDS_FILE"
    echo ""
    echo "  Change these after first login!"
    echo ""
fi

# =============================================================================
# Build the Go bot
# =============================================================================
echo "=== Building xn-mc-bot ==="
cd "$PROJECT_DIR/bot"
go build -o "$PROJECT_DIR/xn-mc-bot" .
echo "  Built: $PROJECT_DIR/xn-mc-bot"
echo ""

# =============================================================================
# Done
# =============================================================================
echo "========================================"
echo "  Setup complete!"
echo "========================================"
echo ""
echo "Crafty panel:  https://localhost:8443"
echo "Container:     podman ps  (should show '$CONTAINER_NAME')"
echo "Bot binary:    $PROJECT_DIR/xn-mc-bot"
echo ""
echo "Next steps:"
echo "  1. Log into https://localhost:8443 with the credentials above"
echo "  2. Create a new Minecraft server (or import an existing one)"
echo "     To import: copy your server files into crafty/import/ and"
echo "     use Crafty's Import Server feature in the web UI."
echo "  3. Generate an API token: User Settings > API Tokens > Create"
echo "  4. Find your server ID in the Crafty URL bar or server settings"
echo "  5. Update .env with:"
echo "       CRAFTY_URL=https://localhost:8443/api/v2"
echo "       CRAFTY_API_KEY=<your-token>"
echo "       CRAFTY_SERVER_ID=<your-server-id>"
echo "       CRAFTY_SERVER_PATH=<path-shown-in-crafty-server-settings>"
echo "  6. Run the bot: ./xn-mc-bot"
echo ""

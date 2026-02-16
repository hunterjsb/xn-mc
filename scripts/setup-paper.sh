#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Paper Hardcore Server Setup Script
# Works on any Linux distro (Fedora, Ubuntu, etc.) — requires: curl, python3, java 21+
# =============================================================================
#
# WHAT THIS DOES:
#   Migrates the vanilla MC server to Paper 1.21.11 and sets up a permanent
#   deathban hardcore server with 15 plugins + donation rank tiers via LuckPerms.
#   The bot (xn-mc-bot) needs NO changes — it still does `-jar server.jar nogui`
#   and pgrep/pkill server.jar.
#
# WHAT CHANGES:
#   - server.jar symlink -> Paper 1.21.11 (replaces vanilla bundled jar)
#   - server.properties: hardcore=true, difficulty=hard, RCON enabled (pw: minecraft),
#     spawn-protection=0, enforce-secure-profile=false (for Geyser/Floodgate)
#   - start.sh: simplified for Paper's -jar launch
#   - .env: Aikar's GC flags, preserves existing memory settings, auto-detected Java path
#          (prefers Amazon Corretto 21 on arm64 — Ubuntu OpenJDK has SIGSEGV bugs)
#
# PLUGINS INSTALLED (15):
#   DeathBan          - Permanent deathban (ban-time: 0), spectator after death
#   CoreProtect       - Block/container/chat logging and rollback
#   LuckPerms         - Permission groups (h2 storage) + donation rank tiers
#   HeadDrop          - 100% player head drop on all deaths
#   AltDetector       - Flags alt accounts (365 day expiration)
#   Simple Voice Chat - Proximity voice (UDP port 24454)
#   BlueMap           - Web-based 3D map (http://localhost:8100)
#   Chunky            - Chunk pre-generation
#   ChunkyBorder      - World border management
#   OpenInv           - Open offline player inventories
#   Geyser-Spigot     - Bedrock crossplay (port 19132)
#   Floodgate-Spigot  - Bedrock auth (username prefix ".")
#   RandomSPAWNZ      - Random spawn within 5000 blocks on first join
#   Tebex             - Donation store integration (executes LP commands on purchase)
#   NicknameEasy      - /nick with color code support (champion+ perm)
#
# PERFORMANCE TUNING:
#   - Anti-xray engine-mode 2 (ore obfuscation)
#   - ALTERNATE_CURRENT redstone (faster)
#   - Optimized explosions, reduced mob spawns, tighter despawn ranges
#   - Aikar's G1GC flags in .env
#
# THE SCRIPT WILL:
#   1. Check prerequisites (java 21+, curl, python3, tmux)
#   2. Download Paper jar and update symlink
#   3. Write start.sh with auto-detected Java path
#   4. Boot the server THREE times:
#      — Boot 1: generate Paper configs
#      — Boot 2: generate plugin configs
#      — Boot 3: set up LuckPerms donation rank groups via RCON
#   5. Apply all config edits
#   6. Update .env with Aikar's flags
#   Total runtime: ~3-4 minutes (mostly download + three server boots)
#
# AFTER RUNNING:
#   1. Start via bot (/start) or: cd server && ./start.sh
#   2. Verify in-game: /plugins (15 loaded), hardcore hearts visible
#   3. Pre-gen spawn chunks: /chunky radius 5000 -> /chunky start
#   4. Set world border with ChunkyBorder
#   5. BlueMap at http://<server-ip>:8100
#
# PORTS USED:
#   25565/tcp - Minecraft Java
#   19132/udp - Geyser (Bedrock)
#   24454/udp - Simple Voice Chat
#   25575/tcp - RCON
#    8100/tcp - BlueMap webserver
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
SERVER_DIR="$PROJECT_DIR/server"
PLUGINS_DIR="$SERVER_DIR/plugins"
MC_VERSION="1.21.11"

# =============================================================================
# Prerequisites check — tell the user what to install
# =============================================================================
MISSING=()
command -v curl >/dev/null 2>&1 || MISSING+=("curl")
command -v python3 >/dev/null 2>&1 || MISSING+=("python3")
command -v tmux >/dev/null 2>&1 || MISSING+=("tmux")

if [ ${#MISSING[@]} -gt 0 ]; then
    echo "========================================="
    echo "  Missing dependencies: ${MISSING[*]}"
    echo "========================================="
    echo ""
    echo "Install them first:"
    echo "  Ubuntu/Debian:  sudo apt update && sudo apt install -y ${MISSING[*]} openjdk-21-jre-headless"
    echo "  Fedora/RHEL:    sudo dnf install -y ${MISSING[*]} java-21-openjdk-headless"
    echo "  Homebrew:       brew install ${MISSING[*]} openjdk@21"
    echo ""
    exit 1
fi

# --- Auto-detect Java ---
find_java() {
    # Check common locations in priority order
    for candidate in \
        /opt/corretto-21/bin/java \
        /home/linuxbrew/.linuxbrew/opt/openjdk@21/bin/java \
        /usr/lib/jvm/java-21-openjdk-amd64/bin/java \
        /usr/lib/jvm/java-21-openjdk-arm64/bin/java \
        /usr/lib/jvm/java-21-openjdk/bin/java \
        /usr/lib/jvm/java-21/bin/java \
        "$(command -v java 2>/dev/null || true)"; do
        if [ -n "$candidate" ] && [ -x "$candidate" ]; then
            # Verify it's Java 21+
            local ver
            ver=$("$candidate" -version 2>&1 | head -1 | grep -oP '"\K[0-9]+' | head -1)
            if [ "$ver" -ge 21 ] 2>/dev/null; then
                echo "$candidate"
                return 0
            fi
        fi
    done
    return 1
}

JAVA=$(find_java) || { echo "ERROR: Java 21+ not found. Install it first:"; echo "  Ubuntu: sudo apt install openjdk-21-jre-headless"; echo "  Fedora/Brew: brew install openjdk@21"; exit 1; }
echo "Using Java: $JAVA"
$JAVA -version 2>&1 | head -1

if pgrep -f "server.jar" >/dev/null 2>&1; then
    echo "ERROR: Minecraft server is already running. Stop it first."
    exit 1
fi

# =============================================================================
# Step 1: Download Paper
# =============================================================================
echo ""
echo "=== Downloading Paper $MC_VERSION ==="
cd "$SERVER_DIR"

BUILD=$(curl -sf "https://api.papermc.io/v2/projects/paper/versions/$MC_VERSION" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['builds'][-1])")
PAPER_JAR="paper-${MC_VERSION}-${BUILD}.jar"

if [ -f "$PAPER_JAR" ]; then
    echo "Paper jar already exists: $PAPER_JAR"
else
    echo "Downloading Paper build $BUILD..."
    curl -Lo "$PAPER_JAR" \
        "https://api.papermc.io/v2/projects/paper/versions/$MC_VERSION/builds/$BUILD/downloads/paper-${MC_VERSION}-${BUILD}.jar"
fi

# Update symlink
rm -f server.jar
ln -s "$PAPER_JAR" server.jar
echo "server.jar -> $PAPER_JAR"

# =============================================================================
# Step 2: Write start.sh
# =============================================================================
echo ""
echo "=== Writing start.sh ==="
cat > start.sh << STARTEOF
#!/bin/bash

JAVA=$JAVA

if [ ! -e "server.jar" ]; then
    echo "server.jar not found!"
    exit 1
fi

if [ "\$1" = "--direct" ]; then
    exec \$JAVA -Xms1G -Xmx2560M -jar server.jar nogui
else
    tmux new-session -d -s minecraft "\$JAVA -Xms1G -Xmx2560M -jar server.jar nogui 2>&1 | tee server.out; read"
fi
STARTEOF
chmod +x start.sh

# =============================================================================
# Step 3: Update server.properties
# =============================================================================
echo ""
echo "=== Configuring server.properties ==="

# Ensure eula is accepted
echo "eula=true" > eula.txt

apply_property() {
    local key="$1" val="$2" file="$SERVER_DIR/server.properties"
    if [ ! -f "$file" ]; then return; fi
    if grep -q "^${key}=" "$file"; then
        sed -i "s|^${key}=.*|${key}=${val}|" "$file"
    else
        echo "${key}=${val}" >> "$file"
    fi
}

# Only apply properties if server.properties exists (it will after first boot)
if [ -f server.properties ]; then
    apply_property "hardcore" "true"
    apply_property "difficulty" "hard"
    apply_property "enable-rcon" "true"
    apply_property "rcon.password" "minecraft"
    apply_property "spawn-protection" "0"
    apply_property "enforce-secure-profile" "false"
    apply_property "motd" '\u00a71\u00a7lX\u00a79\u00a7lA\u00a73\u00a7lN\u00a7b\u00a7lD\u00a7b\u00a7lA\u00a73\u00a7lR\u00a79\u00a7lI\u00a71\u00a7lS \u00a7r\u2620\\n\u00a77New world. No resets.'
    echo "server.properties updated."
fi

# =============================================================================
# Step 4: First boot (generate Paper configs + server.properties if missing)
# =============================================================================
boot_and_stop() {
    local label="$1"
    echo ""
    echo "=== Boot: $label ==="
    cd "$SERVER_DIR"
    > logs/latest.log 2>/dev/null || true

    $JAVA -Xms1G -Xmx2560M -jar server.jar nogui > /dev/null 2>&1 &
    local pid=$!

    # Wait for "Done (" in log
    for i in $(seq 1 180); do
        if grep -q "Done (" logs/latest.log 2>/dev/null; then
            echo "Server started ($label). Sending stop..."
            sleep 3
            # Try RCON stop, fall back to kill
            python3 -c "
import socket, struct
try:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(5)
    s.connect(('127.0.0.1', 25575))
    def send(sock, rid, ptype, payload):
        data = payload.encode() + b'\x00\x00'
        sock.send(struct.pack('<iii', len(data)+10, rid, ptype) + data)
    send(s, 1, 3, 'minecraft')
    s.recv(4096)
    send(s, 2, 2, 'stop')
    s.close()
except: pass
" 2>/dev/null || true
            # Wait for exit
            for j in $(seq 1 30); do
                kill -0 $pid 2>/dev/null || break
                sleep 1
            done
            kill $pid 2>/dev/null || true
            wait $pid 2>/dev/null || true
            echo "Server stopped ($label)."
            return 0
        fi
        if ! kill -0 $pid 2>/dev/null; then
            echo "Server exited early during $label!"
            wait $pid 2>/dev/null || true
            return 1
        fi
        sleep 1
    done
    echo "Timed out waiting for server ($label)"
    kill $pid 2>/dev/null; wait $pid 2>/dev/null || true
    return 1
}

# First boot: generates Paper configs, bukkit.yml, spigot.yml, server.properties
boot_and_stop "generate Paper configs"

# Now apply server.properties if it was just created
apply_property "hardcore" "true"
apply_property "difficulty" "hard"
apply_property "enable-rcon" "true"
apply_property "rcon.password" "minecraft"
apply_property "spawn-protection" "0"
apply_property "enforce-secure-profile" "false"
apply_property "motd" '\u00a74\u00a7lHARDCORE \u00a7r- Permanent Deathban'

# =============================================================================
# Step 5: Tune Paper / Bukkit / Spigot configs
# =============================================================================
echo ""
echo "=== Tuning Paper configs ==="

# --- paper-world-defaults.yml ---
PAPER_WORLD="$SERVER_DIR/config/paper-world-defaults.yml"
if [ -f "$PAPER_WORLD" ]; then
    python3 << PYEOF
import re

path = "$PAPER_WORLD"
with open(path) as f:
    content = f.read()

# Enable anti-xray engine-mode 2
content = re.sub(r'(anti-xray:\n\s+enabled:) false', r'\1 true', content)
content = re.sub(r'(engine-mode:) 1', r'\1 2', content)

# Replace hidden-blocks list
old_blocks = re.search(r'(    hidden-blocks:\n)((?:    - .+\n)+)', content)
if old_blocks:
    new_blocks = """    hidden-blocks:
    - diamond_ore
    - deepslate_diamond_ore
    - ancient_debris
    - iron_ore
    - deepslate_iron_ore
    - gold_ore
    - deepslate_gold_ore
    - copper_ore
    - deepslate_copper_ore
    - lapis_ore
    - deepslate_lapis_ore
    - redstone_ore
    - deepslate_redstone_ore
    - emerald_ore
    - deepslate_emerald_ore
    - chest
    - spawner
"""
    content = content[:old_blocks.start()] + new_blocks + content[old_blocks.end():]

# Optimize explosions
content = content.replace('optimize-explosions: false', 'optimize-explosions: true')

# Alternate current redstone
content = content.replace('redstone-implementation: VANILLA', 'redstone-implementation: ALTERNATE_CURRENT')

# Monster despawn ranges
content = re.sub(
    r'(      monster:\n        hard:) default\n(        soft:) default',
    r'\1 96\n\2 32',
    content
)

with open(path, 'w') as f:
    f.write(content)
print("  paper-world-defaults.yml updated")
PYEOF
fi

# --- bukkit.yml ---
BUKKIT="$SERVER_DIR/bukkit.yml"
if [ -f "$BUKKIT" ]; then
    sed -i 's/monsters: 70/monsters: 50/' "$BUKKIT"
    sed -i 's/animals: 10/animals: 8/' "$BUKKIT"
    sed -i 's/water-animals: 5/water-animals: 3/' "$BUKKIT"
    sed -i 's/water-ambient: 20/water-ambient: 3/' "$BUKKIT"
    sed -i 's/ambient: 15/ambient: 1/' "$BUKKIT"
    echo "  bukkit.yml updated"
fi

# --- spigot.yml ---
SPIGOT="$SERVER_DIR/spigot.yml"
if [ -f "$SPIGOT" ]; then
    sed -i 's/mob-spawn-range: 8/mob-spawn-range: 6/' "$SPIGOT"
    sed -i 's/raiders: 64/raiders: 48/' "$SPIGOT"
    sed -i '/merge-radius:/{n;s/item: 0.5/item: 2.5/}' "$SPIGOT"
    sed -i '/merge-radius:/{n;n;s/exp: -1.0/exp: 3.0/}' "$SPIGOT"
    echo "  spigot.yml updated"
fi

# =============================================================================
# Step 6: Download plugins
# =============================================================================
echo ""
echo "=== Downloading plugins ==="
mkdir -p "$PLUGINS_DIR"
cd "$PLUGINS_DIR"

# Helper: download from Modrinth
modrinth_dl() {
    local slug="$1"
    local url="https://api.modrinth.com/v2/project/${slug}/version?loaders=%5B%22paper%22%5D&game_versions=%5B%22${MC_VERSION}%22%5D"
    local json file_url filename

    json=$(curl -sf "$url")
    file_url=$(echo "$json" | python3 -c "import sys,json; v=json.load(sys.stdin); print(v[0]['files'][0]['url'])" 2>/dev/null || true)

    if [ -z "$file_url" ] || [ "$file_url" = "None" ]; then
        # Retry without version filter
        url="https://api.modrinth.com/v2/project/${slug}/version?loaders=%5B%22paper%22%5D"
        json=$(curl -sf "$url")
        file_url=$(echo "$json" | python3 -c "import sys,json; v=json.load(sys.stdin); print(v[0]['files'][0]['url'])" 2>/dev/null || true)
    fi

    filename=$(echo "$json" | python3 -c "import sys,json; v=json.load(sys.stdin); print(v[0]['files'][0]['filename'])" 2>/dev/null || true)

    if [ -n "$file_url" ] && [ "$file_url" != "None" ]; then
        if [ -f "$filename" ]; then
            echo "  $slug: $filename (already exists)"
        else
            curl -sLo "$filename" "$file_url"
            echo "  $slug: $filename ($(du -h "$filename" | cut -f1))"
        fi
    else
        echo "  WARNING: Failed to download $slug"
    fi
}

# Modrinth plugins
for slug in deathban coreprotect luckperms head-drop altdetector simple-voice-chat bluemap chunky chunkyborder tebex nickname-easy; do
    modrinth_dl "$slug"
done

# OpenInv from GitHub
if ! ls OpenInv*.jar >/dev/null 2>&1; then
    echo "  Fetching OpenInv from GitHub..."
    OPENINV_URL=$(curl -sf https://api.github.com/repos/Jikoo/OpenInv/releases/latest \
        | python3 -c "import sys,json; r=json.load(sys.stdin); [print(a['browser_download_url']) for a in r['assets'] if a['name']=='OpenInv.jar']")
    curl -sLo OpenInv.jar "$OPENINV_URL"
    echo "  openinv: OpenInv.jar ($(du -h OpenInv.jar | cut -f1))"
else
    echo "  openinv: $(ls OpenInv*.jar) (already exists)"
fi

# Geyser + Floodgate from GeyserMC
for proj in geyser floodgate; do
    jar_name="$(echo "$proj" | sed 's/./\U&/')-Spigot.jar"  # Capitalize
    if [ "$proj" = "geyser" ]; then jar_name="Geyser-Spigot.jar"; fi
    if [ "$proj" = "floodgate" ]; then jar_name="Floodgate-Spigot.jar"; fi

    if [ -f "$jar_name" ]; then
        echo "  $proj: $jar_name (already exists)"
    else
        curl -sLo "$jar_name" "https://download.geysermc.org/v2/projects/$proj/versions/latest/builds/latest/downloads/spigot"
        echo "  $proj: $jar_name ($(du -h "$jar_name" | cut -f1))"
    fi
done

# RandomSPAWNZ
modrinth_dl "randomspawnz"

echo ""
echo "Plugins downloaded: $(ls *.jar 2>/dev/null | wc -l) jars"

# =============================================================================
# Step 7: Boot with plugins to generate configs
# =============================================================================
cd "$SERVER_DIR"
boot_and_stop "generate plugin configs"

# =============================================================================
# Step 8: Configure plugins
# =============================================================================
echo ""
echo "=== Configuring plugins ==="

# DeathBan: permanent ban
DEATHBAN_CFG="$PLUGINS_DIR/DeathBan/config.yml"
if [ -f "$DEATHBAN_CFG" ]; then
    sed -i 's/ban-time: [0-9]*/ban-time: 0/' "$DEATHBAN_CFG"
    sed -i 's/Ban Duration: <yellow>[^<]*/Ban Duration: <yellow>Permanent/' "$DEATHBAN_CFG"
    sed -i 's/dying in combat/dying on the hardcore server/' "$DEATHBAN_CFG"
    echo "  DeathBan: permanent ban"
fi

# Geyser: floodgate auth
GEYSER_CFG="$PLUGINS_DIR/Geyser-Spigot/config.yml"
if [ -f "$GEYSER_CFG" ]; then
    sed -i 's/auth-type: online/auth-type: floodgate/' "$GEYSER_CFG"
    echo "  Geyser: auth-type=floodgate"
fi

# BlueMap: accept download, 2 render threads
BLUEMAP_CFG="$PLUGINS_DIR/BlueMap/core.conf"
if [ -f "$BLUEMAP_CFG" ]; then
    sed -i 's/accept-download: false/accept-download: true/' "$BLUEMAP_CFG"
    sed -i 's/render-thread-count: 1/render-thread-count: 2/' "$BLUEMAP_CFG"
    echo "  BlueMap: accept-download=true, render-threads=2"
fi

# AltDetector: 365 day expiration
ALT_CFG="$PLUGINS_DIR/AltDetector/config.yml"
if [ -f "$ALT_CFG" ]; then
    sed -i 's/expiration-time: [0-9]*/expiration-time: 365/' "$ALT_CFG"
    echo "  AltDetector: expiration=365d"
fi

# RandomSPAWNZ: 5000 block radius, first join only
SPAWN_CFG="$PLUGINS_DIR/RandomSPAWNZ/config.yml"
if [ -f "$SPAWN_CFG" ]; then
    sed -i 's/min-x: -[0-9]*/min-x: -5000/' "$SPAWN_CFG"
    sed -i 's/max-x: [0-9]*/max-x: 5000/' "$SPAWN_CFG"
    sed -i 's/min-z: -[0-9]*/min-z: -5000/' "$SPAWN_CFG"
    sed -i 's/max-z: [0-9]*/max-z: 5000/' "$SPAWN_CFG"
    sed -i 's/teleport-on-first-join-only: false/teleport-on-first-join-only: true/' "$SPAWN_CFG"
    echo "  RandomSPAWNZ: 5000 radius, first-join-only"
fi

# HeadDrop: enable broadcast
HEADDROP_CFG="$PLUGINS_DIR/HeadDrop/config.yml"
if [ -f "$HEADDROP_CFG" ]; then
    sed -i '/^broadcast:/,/enabled:/{s/enabled: false/enabled: true/}' "$HEADDROP_CFG"
    echo "  HeadDrop: broadcast=true"
fi

# Tebex: secret key must be set manually after setup
# Run: /tebex secret <key> in-game, or edit plugins/Tebex/config.yml
# Each Tebex package should execute: lp user {username} parent add <rank>
echo "  Tebex: installed (set secret key via /tebex secret <key> after first start)"

# NicknameEasy: default config is fine — permissions gate /nick usage
echo "  NicknameEasy: installed (gated by nicknameseasy.use permission)"

# =============================================================================
# Step 9: Set up LuckPerms donation rank groups
# =============================================================================
echo ""
echo "=== Setting up LuckPerms donation ranks ==="
echo "  Booting server to run LP commands via console stdin..."
cd "$SERVER_DIR"
> logs/latest.log 2>/dev/null || true

# Pipe LP commands into the server console via stdin.
# The subshell waits for "Done (", sends commands, then stops the server.
{
    # Wait for server to finish starting
    while ! grep -q "Done (" logs/latest.log 2>/dev/null; do sleep 1; done
    sleep 3
    echo "  Server ready, sending LP commands..." >&2

    # Create groups
    echo "lp creategroup supporter"
    echo "lp creategroup champion"
    echo "lp creategroup legend"
    echo "lp creategroup mythic"
    sleep 1

    # Set weights
    echo "lp group supporter setweight 10"
    echo "lp group champion setweight 20"
    echo "lp group legend setweight 30"
    echo "lp group mythic setweight 40"
    sleep 1

    # Inheritance chain: mythic > legend > champion > supporter > default
    echo "lp group champion parent add supporter"
    echo "lp group legend parent add champion"
    echo "lp group mythic parent add legend"
    sleep 1

    # Default group: deny cosmetic perms
    echo "lp group default permission set nicknameseasy.use false"
    echo "lp group default permission set nicknameseasy.color false"
    sleep 1

    # Prefixes (quoted to preserve color codes + spaces)
    echo 'lp group supporter meta setprefix 10 "&a[S] &f"'
    echo 'lp group champion meta setprefix 20 "&b[C] &f"'
    echo 'lp group legend meta setprefix 30 "&6[L] &f"'
    echo 'lp group mythic meta setprefix 40 "&d[M] &f"'
    sleep 1

    # Champion: unlock /nick
    echo "lp group champion permission set nicknameseasy.use true"
    echo "lp group champion permission set nicknameseasy.color true"
    sleep 1

    # Verify
    echo "lp listgroups"
    sleep 2

    echo "  LP commands sent, stopping server..." >&2
    echo "stop"
    sleep 5
} | $JAVA -Xms1G -Xmx2560M -jar server.jar nogui > /dev/null 2>&1

echo "  LuckPerms donation ranks configured."

# =============================================================================
# Step 10: Update .env
# =============================================================================
echo ""
echo "=== Updating .env ==="
ENV_FILE="$PROJECT_DIR/.env"
if [ -f "$ENV_FILE" ]; then
    # Update START_COMMAND with Aikar's flags and detected Java path
    # Preserve existing -Xmx if set, otherwise default to 4G
    EXISTING_XMX=$(grep -oP '\-Xmx\K[^ "]+' "$ENV_FILE" 2>/dev/null || echo "4G")
    EXISTING_XMS=$(grep -oP '\-Xms\K[^ "]+' "$ENV_FILE" 2>/dev/null || echo "2G")
    sed -i "s|^START_COMMAND=.*|START_COMMAND=\"$JAVA -Xms${EXISTING_XMS} -Xmx${EXISTING_XMX} -XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 -XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC -XX:+AlwaysPreTouch -XX:G1NewSizePercent=30 -XX:G1MaxNewSizePercent=40 -XX:G1HeapRegionSize=8M -XX:G1ReservePercent=20 -jar server.jar nogui\"|" "$ENV_FILE"
    # Ensure RCON password matches
    sed -i 's|^RCON_PW=.*|RCON_PW=minecraft|' "$ENV_FILE"
    echo "  .env updated with Aikar's flags and Java path"
fi

# =============================================================================
# Done
# =============================================================================
echo ""
echo "========================================"
echo "  Paper Hardcore setup complete!"
echo "========================================"
echo ""
echo "Java:    $JAVA"
echo "Paper:   $PAPER_JAR"
echo "Plugins: $(ls "$PLUGINS_DIR"/*.jar 2>/dev/null | wc -l) installed"
echo ""
echo "Donation ranks: supporter, champion, legend, mythic"
echo "  Champion+ unlocks: /nick with color codes"
echo ""
echo "Next steps:"
echo "  1. Start the server via the bot (/start) or: cd server && ./start.sh"
echo "  2. Verify: /plugins (15 loaded), hardcore hearts, RCON"
echo "  3. Pre-gen spawn: /chunky radius 5000 && /chunky start"
echo "  4. Set world border with ChunkyBorder"
echo "  5. Set Tebex secret: /tebex secret <key>"
echo "     Configure packages to run: lp user {username} parent add <rank>"
echo "  6. DiscordSRV is NOT included (xn-mc-bot handles Discord)"
echo ""

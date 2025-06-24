#!/bin/bash

# Check if server.jar exists and is valid
if [ -L "server.jar" ] && [ ! -e "server.jar" ]; then
    echo "Broken symlink detected for server.jar, attempting to fix..."

    # Extract version from symlink target
    target=$(readlink server.jar)
    version=$(echo "$target" | grep -oP 'versions/\K[^/]+')

    if [ -n "$version" ]; then
        echo "Auto-downloading missing server JAR for version: $version"
        cd ..
        python3 scripts/update_server.py --version_id "$version"
        cd server

        if [ -e "server.jar" ]; then
            echo "Server JAR fixed successfully!"
        else
            echo "Failed to fix server.jar, please run: python3 scripts/update_server.py"
            exit 1
        fi
    else
        echo "Could not determine version from symlink, please run: python3 scripts/update_server.py"
        exit 1
    fi
elif [ ! -e "server.jar" ]; then
    echo "server.jar not found, please run: python3 scripts/update_server.py"
    exit 1
fi

# Build classpath with all libraries
CLASSPATH=$(find libraries -name "*.jar" | tr '\n' ':')server.jar

# Start the Minecraft server in a new detached tmux session
tmux new-session -d -s minecraft "java -Xms1G -Xmx2.5G -cp \"$CLASSPATH\" net.minecraft.server.Main nogui 2>&1 | tee server.out; read"

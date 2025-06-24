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

# Start the Minecraft server in a new detached tmux session
tmux new-session -d -s minecraft

# Send the Java command to the tmux session and redirect output to a file
nohup java -Xms1024M -Xmx7G -jar server.jar nogui &> server.out &

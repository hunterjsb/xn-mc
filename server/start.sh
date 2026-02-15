#!/bin/bash

JAVA=/home/linuxbrew/.linuxbrew/opt/openjdk@21/bin/java

if [ ! -e "server.jar" ]; then
    echo "server.jar not found!"
    exit 1
fi

if [ "$1" = "--direct" ]; then
    exec $JAVA -Xms1G -Xmx2560M -jar server.jar nogui
else
    tmux new-session -d -s minecraft "$JAVA -Xms1G -Xmx2560M -jar server.jar nogui 2>&1 | tee server.out; read"
fi

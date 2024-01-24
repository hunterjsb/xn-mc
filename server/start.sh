#!/bin/bash

# Start the Minecraft server in a new detached tmux session
tmux new-session -d -s minecraft

# Send the Java command to the tmux session and redirect output to a file
nohup java -Xms1024M -Xmx7G -jar server.jar nogui &> server.out &

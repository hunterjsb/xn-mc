package main

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/bwmarrin/discordgo"
	"github.com/gorcon/rcon"
	"github.com/joho/godotenv"
)

const maxDiscordMessageLength = 1900 // Leave some room for code blocks

// Globally available env vars
var (
	channelID     string
	commandPrefix byte
	rconClient    *rcon.Conn

	// Statuspage variables
	statuspageAPIKey                 string
	statuspagePageID                 string
	statuspageMinecraftServerComponentID string
	statuspageBotComponentID         string
	spClient                         *StatuspageClient
)

func init() {
	err := godotenv.Load("../.env") // Adjust the path as necessary
	if err != nil {
		fmt.Println("Error loading .env file")
		// Attempt to run without .env for environments where vars are externally set
	}

	// Get environment variables
	channelID = os.Getenv("DISCORD_CHANNEL_ID")
	if channelID == "" {
		fmt.Println("Warning: DISCORD_CHANNEL_ID is not set.")
	}
	commandPrefixStr := os.Getenv("COMMAND_PREFIX")
	if commandPrefixStr == "" {
		fmt.Println("Warning: COMMAND_PREFIX is not set. Defaulting to '!'")
		commandPrefix = '!'
	} else {
		commandPrefix = commandPrefixStr[0]
	}

	// Statuspage environment variables
	statuspageAPIKey = os.Getenv("STATUSPAGE_API_KEY")
	statuspagePageID = os.Getenv("STATUSPAGE_PAGE_ID")
	statuspageMinecraftServerComponentID = os.Getenv("STATUSPAGE_MINECRAFT_SERVER_COMPONENT_ID")
	statuspageBotComponentID = os.Getenv("STATUSPAGE_BOT_COMPONENT_ID")

	// Initialize Statuspage client
	// We initialize it here so it can be used by various functions.
	// Actual checks for API key presence for operations are done within the client methods.
	spClient = NewStatuspageClient(statuspageAPIKey, statuspagePageID)

	// Check essential Statuspage config and log warnings/errors
	if err := checkStatuspageConfig(); err != nil {
		fmt.Printf("Statuspage Configuration Error: %v\n", err)
		// Decide if this should be a fatal error or just a warning.
		// For now, let the bot run but Statuspage features might be disabled.
	}
}

func main() {
	discordToken := os.Getenv("DISCORD_TOKEN")
	if discordToken == "" {
		fmt.Println("Error: DISCORD_TOKEN is not set. Bot cannot start.")
		return
	}
	// Create a new Discord session using the provided bot token.
	dg, err := discordgo.New("Bot " + discordToken)
	if err != nil {
		fmt.Println("error creating Discord session,", err)
		return
	}

	// Register the messageCreate func as a callback for MessageCreate events.
	dg.AddHandler(messageCreate)

	// We only care about receiving message events.
	dg.Identify.Intents = discordgo.IntentsGuildMessages

	// Open a websocket connection to Discord and begin listening.
	err = dg.Open()
	if err != nil {
		fmt.Println("error opening connection,", err)
		return
	}

	// Start streaming server logs
	go streamServerLogsToDiscord(dg, channelID, "../server/server.out")

	// Update Bot component status to Operational on startup
	if statuspageBotComponentID != "" {
		err := spClient.UpdateComponentStatus(statuspageBotComponentID, StatusOperational)
		if err != nil {
			fmt.Printf("Failed to update bot status to operational on startup: %v\n", err)
		} else {
			fmt.Println("Bot status updated to operational on Statuspage.")
		}
	}

	// Perform an initial Minecraft server status check and update Statuspage
	// This uses the same logic as the periodic check.
	// We pass nil for discordgo.Session and discordgo.MessageCreate as they are not needed for this initial check's Statuspage update.
	go performMinecraftServerHealthCheck(nil, true) // Run immediately and then start ticker

	// Start periodic health check for Minecraft server
	go periodicMinecraftServerHealthCheck(dg)


	// Wait here until CTRL-C or other term signal is received.
	fmt.Println("Bot is now running.  Press CTRL-C to exit.")
	sc := make(chan os.Signal, 1)
	signal.Notify(sc, syscall.SIGINT, syscall.SIGTERM, os.Interrupt)
	<-sc

	// Update Bot component status to Major Outage on shutdown
	if statuspageBotComponentID != "" {
		fmt.Println("Bot shutting down. Updating Statuspage bot component to Major Outage...")
		err := spClient.UpdateComponentStatus(statuspageBotComponentID, StatusMajorOutage)
		if err != nil {
			fmt.Printf("Failed to update bot status to major_outage on shutdown: %v\n", err)
		} else {
			fmt.Println("Bot status updated to major_outage on Statuspage.")
		}
	}

	// Cleanly close down the Discord session.
	dg.Close()
}

// This function will be called (due to AddHandler above) every time a new
// message is created on any channel that the authenticated bot has access to.
func messageCreate(s *discordgo.Session, m *discordgo.MessageCreate) {
	// If the message is "ping" reply with "Pong!"
	if m.Content == "ping" {
		s.ChannelMessageSend(m.ChannelID, "Pong! github: https://github.com/hunterjsb/xn-mc?tab=readme-ov-file#xn-mc")
	}

	// Ignore all messages created by the bot itself OR in other channels OR empty messages OR no command prefix
	if m.Author.ID == s.State.User.ID || m.ChannelID != channelID || len(m.Content) == 0 || m.Content[0] != commandPrefix {
		return
	}
	command := m.Content[1:]

	// Use a switch statement to handle different commands
	switch command {
	case "status":
		checkMinecraftServerStatus(s, m)
	case "start":
		startMinecraftServer(s, m)
	case "stop":
		stopMinecraftServer(s, m)
		if rconClient != nil {
			rconClient.Close()
		}
	case "mem":
		s.ChannelMessageSend(m.ChannelID, ReadMemoryStats().ToStr())
	case "clearlogs":
		clearServerLogs(s, m)
	case "archivelogs":
		archiveServerLogs(s, m)
	case "logsize":
		getLogFileSize(s, m)
	case "help":
		showHelpCommands(s, m)
	default:
		// Relay any other command to the server
		if rconClient == nil {
			rconClient = connectRcon(s)
		}
		executeRcon(s, command)
	}
}

func connectRcon(s *discordgo.Session) *rcon.Conn {
	conn, err := rcon.Dial(os.Getenv("RCON_IP"), os.Getenv("RCON_PW"))
	if err != nil {
		errStr := fmt.Sprintf("**ERROR**: Could not connect to minecraft rcon on %s: %s", os.Getenv("RCON_IP"), err.Error())
		s.ChannelMessageSend(channelID, errStr)
	}
	return conn
}

func executeRcon(s *discordgo.Session, cmd string) {
	response, err := rconClient.Execute(cmd)
	if err != nil {
		s.ChannelMessageSend(channelID, "ERROR: "+err.Error())
	}
	s.ChannelMessageSend(channelID, response)
}

func checkMinecraftServerStatus(s *discordgo.Session, m *discordgo.MessageCreate) {
	statusMsg := "Minecraft server is not running."
	spStatus := StatusMajorOutage

	// First try pgrep
	cmd := exec.Command("pgrep", "-f", "server.jar")
	processFound := cmd.Run() == nil

	if processFound {
		statusMsg = "Minecraft server is running (process found)."
		spStatus = StatusOperational
	} else {
		// Fallback: try RCON connection to detect externally started servers
		conn, err := rcon.Dial(os.Getenv("RCON_IP"), os.Getenv("RCON_PW"))
		if err == nil {
			_, err = conn.Execute("list")
			conn.Close()
			if err == nil {
				statusMsg = "Minecraft server is running (RCON responsive)."
				spStatus = StatusOperational
			}
		}
	}

	s.ChannelMessageSend(channelID, statusMsg)

	if statuspageMinecraftServerComponentID != "" {
		updateErr := spClient.UpdateComponentStatus(statuspageMinecraftServerComponentID, spStatus)
		if updateErr != nil {
			errMsg := fmt.Sprintf("Failed to update Minecraft server status on Statuspage: %v", updateErr)
			fmt.Println(errMsg)
			s.ChannelMessageSend(channelID, "Error: "+errMsg) // Notify Discord as well
		} else {
			s.ChannelMessageSend(channelID, fmt.Sprintf("Minecraft server status on Statuspage updated to: %s", spStatus))
		}
	}
}

func startMinecraftServer(s *discordgo.Session, m *discordgo.MessageCreate) {
	if os.Getenv("START_COMMAND") == "" {
		s.ChannelMessageSend(channelID, "START_COMMAND is not set in the environment")
		return
	}

	// Check if server is already running
	pgrepCmd := exec.Command("pgrep", "-f", "server.jar")
	if pgrepCmd.Run() == nil {
		s.ChannelMessageSend(channelID, "Minecraft server process appears to be already running.")
		// Optionally, update statuspage to operational if not already
		if statuspageMinecraftServerComponentID != "" {
			spClient.UpdateComponentStatus(statuspageMinecraftServerComponentID, StatusOperational) // Best effort
		}
		return
	}


	cmdArgs := strings.Fields(os.Getenv("START_COMMAND"))
	cmd := exec.Command("nohup", cmdArgs...)
	cmd.Dir = "../server"

	// Redirect output to server.out
	stdout, err := os.Create(filepath.Join("../server", "server.out"))
	if err != nil {
		s.ChannelMessageSend(channelID, "Failed to create log file: "+err.Error())
		return
	}
	cmd.Stdout = stdout
	cmd.Stderr = stdout

	err = cmd.Start()
	if err != nil {
		s.ChannelMessageSend(channelID, "Failed to start the Minecraft server: "+err.Error())
		if statuspageMinecraftServerComponentID != "" {
			updateErr := spClient.UpdateComponentStatus(statuspageMinecraftServerComponentID, StatusMajorOutage)
			if updateErr != nil {
				fmt.Printf("Failed to update Minecraft server status to major_outage on Statuspage after start failure: %v\n", updateErr)
			}
		}
		return
	}

	s.ChannelMessageSend(channelID, "Minecraft server started.")
	if statuspageMinecraftServerComponentID != "" {
		// Give it a few seconds to actually start up before declaring operational
		time.AfterFunc(5*time.Second, func() {
			updateErr := spClient.UpdateComponentStatus(statuspageMinecraftServerComponentID, StatusOperational)
			if updateErr != nil {
				fmt.Printf("Failed to update Minecraft server status to operational on Statuspage: %v\n", updateErr)
				// Consider sending a Discord message here too if important
			} else {
				fmt.Println("Minecraft server status updated to operational on Statuspage after start.")
			}
		})
	}
}

func stopMinecraftServer(s *discordgo.Session, m *discordgo.MessageCreate) {
	// Command to find and kill the Minecraft server process
	cmd := exec.Command("pkill", "-f", "server.jar")
	err := cmd.Run()

	if err != nil {
		s.ChannelMessageSend(channelID, "Failed to stop the Minecraft server: "+err.Error())
		// Potentially update statuspage to an error state or leave as is if unsure
		return
	}

	s.ChannelMessageSend(channelID, "Minecraft server stopped.")
	if statuspageMinecraftServerComponentID != "" {
		updateErr := spClient.UpdateComponentStatus(statuspageMinecraftServerComponentID, StatusMajorOutage) // Or StatusUnderMaintenance if preferred for intentional stops
		if updateErr != nil {
			fmt.Printf("Failed to update Minecraft server status to major_outage on Statuspage after stop: %v\n", updateErr)
		} else {
			fmt.Println("Minecraft server status updated to major_outage on Statuspage after stop.")
		}
	}
}

// performMinecraftServerHealthCheck checks the Minecraft server's health and updates Statuspage.
// If s is not nil, it can also send messages to Discord.
// `initialCheck` is true if this is the first check on bot startup.
func performMinecraftServerHealthCheck(s *discordgo.Session, initialCheck bool) {
	if statuspageMinecraftServerComponentID == "" {
		if !initialCheck && s != nil { // Avoid logging this on every tick if not configured
			// fmt.Println("Minecraft Server Component ID for Statuspage is not set. Skipping health check for Statuspage.")
		}
		return // No component ID to update
	}

	currentStatus := StatusMajorOutage // Default to major outage

	// 1. Check if server process is running
	pgrepCmd := exec.Command("pgrep", "-f", "server.jar")
	pgrepErr := pgrepCmd.Run()

	if pgrepErr == nil { // Process found
		// 2. Check RCON connection and a simple command
		// Ensure RCON client is connected, attempt to connect if not
		if rconClient == nil || rconClient.RemoteAddr().String() == "" { // Second check for truly closed client
			var tempSession *discordgo.Session
			if s != nil {
				tempSession = s // Use existing session if available
			} else {
				// Create a temporary minimal session if needed for connectRcon, though connectRcon doesn't strictly use it for sending messages on initial failure path
				// This path is mainly for the initial check where 's' might be nil.
				// connectRcon will print to console if it fails and s is nil.
			}
			rconClient = connectRcon(tempSession) // connectRcon handles its own nil session checks for messaging
		}

		if rconClient != nil {
			_, err := rconClient.Execute("list") // A simple command to check responsiveness
			if err == nil {
				currentStatus = StatusOperational
			} else {
				currentStatus = StatusDegradedPerformance // Process running, but RCON failing
				if s != nil { // Only log to Discord if a session is available (not initial silent check)
					s.ChannelMessageSend(channelID, fmt.Sprintf("Warning: Minecraft server process is running, but RCON is unresponsive: %v", err))
				}
				fmt.Printf("RCON command failed during health check: %v\n", err)
				// Attempt to close and nullify rconClient so it's fresh for the next attempt
				rconClient.Close()
				rconClient = nil
			}
		} else {
			currentStatus = StatusDegradedPerformance // Process running, but RCON couldn't connect
			if s != nil {
				s.ChannelMessageSend(channelID, "Warning: Minecraft server process is running, but RCON connection failed.")
			}
			fmt.Println("RCON client is nil during health check after attempting connection.")
		}
	} else {
		currentStatus = StatusMajorOutage // Process not found
		if rconClient != nil { // Ensure RCON client is closed if server process is gone
			rconClient.Close()
			rconClient = nil
		}
	}

	// Update Statuspage
	err := spClient.UpdateComponentStatus(statuspageMinecraftServerComponentID, currentStatus)
	if err != nil {
		errMsg := fmt.Sprintf("Periodic Health Check: Failed to update Minecraft server status on Statuspage to %s: %v", currentStatus, err)
		fmt.Println(errMsg)
		if s != nil { // Send to Discord if session available
			s.ChannelMessageSend(channelID, "Error: "+errMsg)
		}
	} else {
		if !initialCheck { // Don't be too verbose on the very first check's success
			fmt.Printf("Periodic Health Check: Minecraft server status on Statuspage updated to: %s\n", currentStatus)
			if s != nil && (currentStatus == StatusDegradedPerformance || currentStatus == StatusMajorOutage) {
				// Notify on Discord if status is bad and it's not the initial check
				s.ChannelMessageSend(channelID, fmt.Sprintf("Alert: Minecraft server status on Statuspage set to: %s", currentStatus))
			}
		} else {
			fmt.Printf("Initial Health Check: Minecraft server status on Statuspage set to: %s\n", currentStatus)
		}
	}
}

func periodicMinecraftServerHealthCheck(s *discordgo.Session) {
	if statuspageMinecraftServerComponentID == "" {
		fmt.Println("STATUSPAGE_MINECRAFT_SERVER_COMPONENT_ID not set. Periodic health check for Statuspage will not run.")
		return
	}

	// Check more frequently at first, then less frequently.
	// For example, every 30 seconds for 5 minutes, then every 2 minutes.
	// This is a simple example: check every 60 seconds.
	// Statuspage rate limit is 1 req/sec.
	ticker := time.NewTicker(60 * time.Second) // Check every 60 seconds
	defer ticker.Stop()

	for range ticker.C {
		performMinecraftServerHealthCheck(s, false)
	}
}


// sendLongMessage splits long messages into chunks and sends them
func sendLongMessage(s *discordgo.Session, channelID, message string) {
	if len(message) <= maxDiscordMessageLength {
		s.ChannelMessageSend(channelID, message)
		return
	}

	// Split into chunks
	for len(message) > 0 {
		end := maxDiscordMessageLength
		if end > len(message) {
			end = len(message)
		}

		chunk := message[:end]
		message = message[end:]

		s.ChannelMessageSend(channelID, chunk)
		time.Sleep(100 * time.Millisecond) // Small delay between chunks
	}
}

var lastReadPosition int64 = -1 // -1 means seek to end on first read

func streamServerLogsToDiscord(s *discordgo.Session, channelID string, logFilePath string) {
	ticker := time.NewTicker(4 * time.Second)
	for range ticker.C {
		// Open the log file
		file, err := os.Open(logFilePath)
		if err != nil {
			continue // File doesn't exist yet, silently retry
		}

		// Check file size to detect truncation (e.g. after !start)
		info, err := file.Stat()
		if err != nil {
			file.Close()
			continue
		}
		if lastReadPosition == -1 || info.Size() < lastReadPosition {
			// First read: skip to end. Truncated file: reset to beginning.
			if lastReadPosition == -1 {
				lastReadPosition = info.Size()
			} else {
				lastReadPosition = 0
			}
		}

		// Seek to the last read position
		_, err = file.Seek(lastReadPosition, 0)
		if err != nil {
			fmt.Println("Error seeking log file:", err)
			file.Close()
			continue
		}

		// Read new log entries
		scanner := bufio.NewScanner(file)
		var logLines []string
		for scanner.Scan() {
			logLines = append(logLines, scanner.Text())
		}

		if err := scanner.Err(); err != nil {
			fmt.Println("Error reading log file:", err)
			file.Close()
			continue
		}

		// Update the last read position
		lastReadPosition, err = file.Seek(0, io.SeekCurrent)
		if err != nil {
			fmt.Println("Error getting current position in log file:", err)
			file.Close()
			continue
		}

		file.Close()

		// Send new log entries to Discord, if any
		if len(logLines) > 0 {
			// Build message with code blocks, but split if too long
			var currentMessage strings.Builder
			currentMessage.WriteString("```\n")

			for _, line := range logLines {
				// Check if adding this line would exceed the limit
				testMessage := currentMessage.String() + line + "\n```"
				if len(testMessage) > maxDiscordMessageLength {
					// Send current message and start a new one
					currentMessage.WriteString("```")
					sendLongMessage(s, channelID, currentMessage.String())

					// Start new message
					currentMessage.Reset()
					currentMessage.WriteString("```\n")
				}
				currentMessage.WriteString(line + "\n")
			}

			// Send final message
			currentMessage.WriteString("```")
			sendLongMessage(s, channelID, currentMessage.String())
		}
	}
}

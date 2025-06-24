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
)

func init() {
	err := godotenv.Load("../.env") // Adjust the path as necessary
	if err != nil {
		fmt.Println("Error loading .env file")
		return
	}

	// Get environment variables
	channelID = os.Getenv("DISCORD_CHANNEL_ID")
	commandPrefix = os.Getenv("COMMAND_PREFIX")[0]
}

func main() {
	// Create a new Discord session using the provided bot token.
	dg, err := discordgo.New("Bot " + os.Getenv("DISCORD_TOKEN"))
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

	// Wait here until CTRL-C or other term signal is received.
	fmt.Println("Bot is now running.  Press CTRL-C to exit.")
	sc := make(chan os.Signal, 1)
	signal.Notify(sc, syscall.SIGINT, syscall.SIGTERM, os.Interrupt)
	<-sc

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

	// Ignore all messages created by the bot itself OR in other channels OR no command prefix
	if m.Author.ID == s.State.User.ID || m.ChannelID != channelID || m.Content[0] != commandPrefix {
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
	// Command to check if a process with 'server.jar' is running
	cmd := exec.Command("pgrep", "-f", "server.jar")
	err := cmd.Run()

	statusMsg := "Minecraft server is not running."

	if err == nil { // If err is nil, it means a process was found
		statusMsg = "Minecraft server is running."
	}

	s.ChannelMessageSend(channelID, statusMsg)
}

func startMinecraftServer(s *discordgo.Session, m *discordgo.MessageCreate) {
	if os.Getenv("START_COMMAND") == "" {
		s.ChannelMessageSend(channelID, "START_COMMAND is not set in the environment")
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
		return
	}

	s.ChannelMessageSend(channelID, "Minecraft server started.")
}

func stopMinecraftServer(s *discordgo.Session, m *discordgo.MessageCreate) {
	// Command to find and kill the Minecraft server process
	cmd := exec.Command("pkill", "-f", "server.jar")
	err := cmd.Run()

	if err != nil {
		s.ChannelMessageSend(channelID, "Failed to stop the Minecraft server: "+err.Error())
		return
	}

	s.ChannelMessageSend(channelID, "Minecraft server stopped.")
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

var lastReadPosition int64 = 0

func streamServerLogsToDiscord(s *discordgo.Session, channelID string, logFilePath string) {
	ticker := time.NewTicker(4 * time.Second) // Check for updates every 2 seconds
	for range ticker.C {
		// Open the log file
		file, err := os.Open(logFilePath)
		if err != nil {
			fmt.Println("Error opening log file:", err)
			continue
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

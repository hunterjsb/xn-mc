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
	"github.com/joho/godotenv"
)

// Globally available env vars
var (
	token     string
	channelID string
	startCmd  string
	serverDir string
)

func init() {
	err := godotenv.Load("../.env") // Adjust the path as necessary
	if err != nil {
		fmt.Println("Error loading .env file")
		return
	}

	// Get environment variables
	token = os.Getenv("DISCORD_TOKEN")
	channelID = os.Getenv("DISCORD_CHANNEL_ID")
	startCmd = os.Getenv("START_COMMAND")
	serverDir = os.Getenv("SERVER_FP")
}

func main() {
	// Create a new Discord session using the provided bot token.
	dg, err := discordgo.New("Bot " + token)
	if err != nil {
		fmt.Println("error creating Discord session,", err)
		return
	}

	// Register the messageCreate func as a callback for MessageCreate events.
	dg.AddHandler(messageCreate)

	// In this example, we only care about receiving message events.
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

	// Ignore all messages created by the bot itself or in other channels
	if m.Author.ID == s.State.User.ID || m.ChannelID != channelID {
		return
	}
	// If the message is "ping" reply with "Pong!"
	if m.Content == "ping" {
		s.ChannelMessageSend(m.ChannelID, "Pong! Yes prntbot is live!\ngithub: https://github.com/hunterjsb/xn-mc?tab=readme-ov-file#xn-mc")
	}

	if m.Content == "/status" {
		checkMinecraftServerStatus(s, m)
	}

	if m.Content == "/start" {
		startMinecraftServer(s, m)
	}

	if m.Content == "/stop" {
		stopMinecraftServer(s, m)
	}
}

func checkMinecraftServerStatus(s *discordgo.Session, m *discordgo.MessageCreate) {
	// Command to check if a process with 'server.jar' is running
	cmd := exec.Command("pgrep", "-f", "server.jar")
	err := cmd.Run()

	statusMsg := "Minecraft server is not running."
	fmt.Println(err)
	if err == nil { // If err is nil, it means a process was found
		statusMsg = "Minecraft server is running."
	}

	s.ChannelMessageSend(channelID, statusMsg)
}

func startMinecraftServer(s *discordgo.Session, m *discordgo.MessageCreate) {
	if startCmd == "" {
		s.ChannelMessageSend(channelID, "START_COMMAND is not set in the environment")
		return
	}

	cmdArgs := strings.Fields(startCmd)
	cmd := exec.Command("nohup", cmdArgs...)
	cmd.Dir = serverDir

	// Redirect output to server.out
	stdout, err := os.Create(filepath.Join(serverDir, "server.out"))
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

var lastReadPosition int64 = 0

func streamServerLogsToDiscord(s *discordgo.Session, channelID string, logFilePath string) {
	ticker := time.NewTicker(5 * time.Second) // Check for updates every 5 seconds
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
		var logUpdates string
		for scanner.Scan() {
			logUpdates += scanner.Text() + "\n"
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
		if logUpdates != "" {
			_, err = s.ChannelMessageSend(channelID, "```"+logUpdates+"```")
			if err != nil {
				fmt.Println("Error sending log updates to Discord:", err)
			}
		}
	}
}

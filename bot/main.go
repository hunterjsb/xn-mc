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
	guildID       string
	commandPrefix byte
	rconClient    *rcon.Conn

	// Statuspage variables
	statuspageAPIKey                    string
	statuspagePageID                    string
	statuspageMinecraftServerComponentID string
	statuspageBotComponentID            string
	spClient                            *StatuspageClient
)

func init() {
	err := godotenv.Load("../.env") // Adjust the path as necessary
	if err != nil {
		fmt.Println("Error loading .env file")
	}

	// Get environment variables
	channelID = os.Getenv("DISCORD_CHANNEL_ID")
	if channelID == "" {
		fmt.Println("Warning: DISCORD_CHANNEL_ID is not set.")
	}
	guildID = os.Getenv("DISCORD_GUILD_ID") // Empty string = global commands
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
	spClient = NewStatuspageClient(statuspageAPIKey, statuspagePageID)

	if err := checkStatuspageConfig(); err != nil {
		fmt.Printf("Statuspage Configuration Error: %v\n", err)
	}
}

func main() {
	discordToken := os.Getenv("DISCORD_TOKEN")
	if discordToken == "" {
		fmt.Println("Error: DISCORD_TOKEN is not set. Bot cannot start.")
		return
	}
	dg, err := discordgo.New("Bot " + discordToken)
	if err != nil {
		fmt.Println("error creating Discord session,", err)
		return
	}

	// Register handlers
	dg.AddHandler(messageCreate)
	dg.AddHandler(interactionCreate)

	dg.Identify.Intents = discordgo.IntentsGuildMessages

	err = dg.Open()
	if err != nil {
		fmt.Println("error opening connection,", err)
		return
	}

	// Register slash commands
	for _, cmd := range slashCommands {
		created, err := dg.ApplicationCommandCreate(dg.State.User.ID, guildID, cmd)
		if err != nil {
			fmt.Printf("Error registering slash command '%s': %v\n", cmd.Name, err)
		} else {
			fmt.Printf("Registered slash command: /%s\n", created.Name)
		}
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
	go performMinecraftServerHealthCheck(nil, true)

	// Start periodic health check for Minecraft server
	go periodicMinecraftServerHealthCheck(dg)

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

	dg.Close()
}

// interactionCreate routes slash command interactions to their handlers.
func interactionCreate(s *discordgo.Session, i *discordgo.InteractionCreate) {
	if i.Type != discordgo.InteractionApplicationCommand {
		return
	}
	if handler, ok := slashCommandHandlers[i.ApplicationCommandData().Name]; ok {
		handler(s, i)
	}
}

// --- Core logic functions (used by both prefix and slash handlers) ---

type serverStatusResult struct {
	Running bool
	Method  string
	Status  string // Statuspage status constant
}

func checkServerStatus() serverStatusResult {
	// First try pgrep
	cmd := exec.Command("pgrep", "-f", "server.jar")
	if cmd.Run() == nil {
		return serverStatusResult{Running: true, Method: "process found", Status: StatusOperational}
	}

	// Fallback: try RCON
	conn, err := rcon.Dial(os.Getenv("RCON_IP"), os.Getenv("RCON_PW"))
	if err == nil {
		_, err = conn.Execute("list")
		conn.Close()
		if err == nil {
			return serverStatusResult{Running: true, Method: "RCON responsive", Status: StatusOperational}
		}
	}

	return serverStatusResult{Running: false, Status: StatusMajorOutage}
}

func startServerCore() *discordgo.MessageEmbed {
	if os.Getenv("START_COMMAND") == "" {
		return errorEmbed("Start Failed", "START_COMMAND is not set in the environment.")
	}

	// Check if already running
	pgrepCmd := exec.Command("pgrep", "-f", "server.jar")
	if pgrepCmd.Run() == nil {
		if statuspageMinecraftServerComponentID != "" {
			spClient.UpdateComponentStatus(statuspageMinecraftServerComponentID, StatusOperational)
		}
		return warningEmbed("Already Running", "Minecraft server process appears to be already running.")
	}

	cmdArgs := strings.Fields(os.Getenv("START_COMMAND"))
	cmd := exec.Command("nohup", cmdArgs...)
	cmd.Dir = "../server"

	stdout, err := os.Create(filepath.Join("../server", "server.out"))
	if err != nil {
		return errorEmbed("Start Failed", "Failed to create log file: "+err.Error())
	}
	cmd.Stdout = stdout
	cmd.Stderr = stdout

	err = cmd.Start()
	if err != nil {
		if statuspageMinecraftServerComponentID != "" {
			spClient.UpdateComponentStatus(statuspageMinecraftServerComponentID, StatusMajorOutage)
		}
		return errorEmbed("Start Failed", "Failed to start the Minecraft server: "+err.Error())
	}

	if statuspageMinecraftServerComponentID != "" {
		time.AfterFunc(5*time.Second, func() {
			updateErr := spClient.UpdateComponentStatus(statuspageMinecraftServerComponentID, StatusOperational)
			if updateErr != nil {
				fmt.Printf("Failed to update Minecraft server status to operational on Statuspage: %v\n", updateErr)
			} else {
				fmt.Println("Minecraft server status updated to operational on Statuspage after start.")
			}
		})
	}

	return successEmbed("Server Started", "Minecraft server started successfully.")
}

func stopServerCore() *discordgo.MessageEmbed {
	cmd := exec.Command("pkill", "-f", "server.jar")
	err := cmd.Run()
	if err != nil {
		return errorEmbed("Stop Failed", "Failed to stop the Minecraft server: "+err.Error())
	}

	if rconClient != nil {
		rconClient.Close()
		rconClient = nil
	}

	if statuspageMinecraftServerComponentID != "" {
		updateErr := spClient.UpdateComponentStatus(statuspageMinecraftServerComponentID, StatusMajorOutage)
		if updateErr != nil {
			fmt.Printf("Failed to update Minecraft server status to major_outage on Statuspage after stop: %v\n", updateErr)
		} else {
			fmt.Println("Minecraft server status updated to major_outage on Statuspage after stop.")
		}
	}

	return warningEmbed("Server Stopped", "Minecraft server has been stopped.")
}

func connectRconSafe() (*rcon.Conn, error) {
	return rcon.Dial(os.Getenv("RCON_IP"), os.Getenv("RCON_PW"))
}

// --- Prefix command wrappers (unchanged behavior) ---

func messageCreate(s *discordgo.Session, m *discordgo.MessageCreate) {
	if m.Content == "ping" {
		s.ChannelMessageSend(m.ChannelID, "Pong! github: https://github.com/hunterjsb/xn-mc?tab=readme-ov-file#xn-mc")
	}

	if m.Author.ID == s.State.User.ID || m.ChannelID != channelID || len(m.Content) == 0 || m.Content[0] != commandPrefix {
		return
	}
	command := m.Content[1:]

	switch command {
	case "status":
		checkMinecraftServerStatus(s, m)
	case "start":
		startMinecraftServer(s, m)
	case "stop":
		stopMinecraftServer(s, m)
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
		// Relay any other command to the server via RCON
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
	result := checkServerStatus()
	if result.Running {
		s.ChannelMessageSend(channelID, fmt.Sprintf("Minecraft server is running (%s).", result.Method))
	} else {
		s.ChannelMessageSend(channelID, "Minecraft server is not running.")
	}

	if statuspageMinecraftServerComponentID != "" {
		updateErr := spClient.UpdateComponentStatus(statuspageMinecraftServerComponentID, result.Status)
		if updateErr != nil {
			errMsg := fmt.Sprintf("Failed to update Minecraft server status on Statuspage: %v", updateErr)
			fmt.Println(errMsg)
			s.ChannelMessageSend(channelID, "Error: "+errMsg)
		} else {
			s.ChannelMessageSend(channelID, fmt.Sprintf("Minecraft server status on Statuspage updated to: %s", result.Status))
		}
	}
}

func startMinecraftServer(s *discordgo.Session, m *discordgo.MessageCreate) {
	embed := startServerCore()
	s.ChannelMessageSendEmbed(m.ChannelID, embed)
}

func stopMinecraftServer(s *discordgo.Session, m *discordgo.MessageCreate) {
	embed := stopServerCore()
	s.ChannelMessageSendEmbed(m.ChannelID, embed)
}

// --- Health check functions (unchanged) ---

func performMinecraftServerHealthCheck(s *discordgo.Session, initialCheck bool) {
	if statuspageMinecraftServerComponentID == "" {
		return
	}

	currentStatus := StatusMajorOutage

	pgrepCmd := exec.Command("pgrep", "-f", "server.jar")
	pgrepErr := pgrepCmd.Run()

	if pgrepErr == nil {
		if rconClient == nil || rconClient.RemoteAddr().String() == "" {
			var tempSession *discordgo.Session
			if s != nil {
				tempSession = s
			}
			rconClient = connectRcon(tempSession)
		}

		if rconClient != nil {
			_, err := rconClient.Execute("list")
			if err == nil {
				currentStatus = StatusOperational
			} else {
				currentStatus = StatusDegradedPerformance
				if s != nil {
					s.ChannelMessageSend(channelID, fmt.Sprintf("Warning: Minecraft server process is running, but RCON is unresponsive: %v", err))
				}
				fmt.Printf("RCON command failed during health check: %v\n", err)
				rconClient.Close()
				rconClient = nil
			}
		} else {
			currentStatus = StatusDegradedPerformance
			if s != nil {
				s.ChannelMessageSend(channelID, "Warning: Minecraft server process is running, but RCON connection failed.")
			}
			fmt.Println("RCON client is nil during health check after attempting connection.")
		}
	} else {
		currentStatus = StatusMajorOutage
		if rconClient != nil {
			rconClient.Close()
			rconClient = nil
		}
	}

	err := spClient.UpdateComponentStatus(statuspageMinecraftServerComponentID, currentStatus)
	if err != nil {
		errMsg := fmt.Sprintf("Periodic Health Check: Failed to update Minecraft server status on Statuspage to %s: %v", currentStatus, err)
		fmt.Println(errMsg)
		if s != nil {
			s.ChannelMessageSend(channelID, "Error: "+errMsg)
		}
	} else {
		if !initialCheck {
			fmt.Printf("Periodic Health Check: Minecraft server status on Statuspage updated to: %s\n", currentStatus)
			if s != nil && (currentStatus == StatusDegradedPerformance || currentStatus == StatusMajorOutage) {
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

	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()

	for range ticker.C {
		performMinecraftServerHealthCheck(s, false)
	}
}

// --- Log streaming (unchanged) ---

func sendLongMessage(s *discordgo.Session, channelID, message string) {
	if len(message) <= maxDiscordMessageLength {
		s.ChannelMessageSend(channelID, message)
		return
	}

	for len(message) > 0 {
		end := maxDiscordMessageLength
		if end > len(message) {
			end = len(message)
		}

		chunk := message[:end]
		message = message[end:]

		s.ChannelMessageSend(channelID, chunk)
		time.Sleep(100 * time.Millisecond)
	}
}

var lastReadPosition int64 = -1

func streamServerLogsToDiscord(s *discordgo.Session, channelID string, logFilePath string) {
	ticker := time.NewTicker(4 * time.Second)
	for range ticker.C {
		file, err := os.Open(logFilePath)
		if err != nil {
			continue
		}

		info, err := file.Stat()
		if err != nil {
			file.Close()
			continue
		}
		if lastReadPosition == -1 || info.Size() < lastReadPosition {
			if lastReadPosition == -1 {
				lastReadPosition = info.Size()
			} else {
				lastReadPosition = 0
			}
		}

		_, err = file.Seek(lastReadPosition, 0)
		if err != nil {
			fmt.Println("Error seeking log file:", err)
			file.Close()
			continue
		}

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

		lastReadPosition, err = file.Seek(0, io.SeekCurrent)
		if err != nil {
			fmt.Println("Error getting current position in log file:", err)
			file.Close()
			continue
		}

		file.Close()

		if len(logLines) > 0 {
			var currentMessage strings.Builder
			currentMessage.WriteString("```\n")

			for _, line := range logLines {
				testMessage := currentMessage.String() + line + "\n```"
				if len(testMessage) > maxDiscordMessageLength {
					currentMessage.WriteString("```")
					sendLongMessage(s, channelID, currentMessage.String())

					currentMessage.Reset()
					currentMessage.WriteString("```\n")
				}
				currentMessage.WriteString(line + "\n")
			}

			currentMessage.WriteString("```")
			sendLongMessage(s, channelID, currentMessage.String())
		}
	}
}

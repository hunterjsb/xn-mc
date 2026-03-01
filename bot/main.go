package main

import (
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/bwmarrin/discordgo"
	"github.com/gorcon/rcon"
	"github.com/joho/godotenv"
)

// Globally available env vars
var (
	channelID string
	guildID   string

	// Crafty Controller client
	craftyClient *CraftyClient

	// Statuspage variables
	statuspageAPIKey                     string
	statuspagePageID                     string
	statuspageMinecraftServerComponentID string
	statuspageBotComponentID             string
	spClient                             *StatuspageClient
)

func init() {
	// Try loading .env file — optional, env vars may come from systemd EnvironmentFile instead.
	if envFile := os.Getenv("ENV_FILE"); envFile != "" {
		_ = godotenv.Load(envFile)
	} else {
		_ = godotenv.Load("../.env")
	}

	// Get environment variables
	channelID = os.Getenv("DISCORD_CHANNEL_ID")
	if channelID == "" {
		fmt.Println("Warning: DISCORD_CHANNEL_ID is not set.")
	}
	guildID = os.Getenv("DISCORD_GUILD_ID") // Empty string = global commands

	// Initialize Crafty client
	craftyURL := os.Getenv("CRAFTY_URL")
	craftyAPIKey := os.Getenv("CRAFTY_API_KEY")
	craftyServerID := os.Getenv("CRAFTY_SERVER_ID")
	if craftyURL == "" || craftyAPIKey == "" || craftyServerID == "" {
		fmt.Println("Warning: CRAFTY_URL, CRAFTY_API_KEY, or CRAFTY_SERVER_ID not set. Crafty integration disabled.")
	} else {
		craftyClient = NewCraftyClient(craftyURL, craftyAPIKey, craftyServerID)
		fmt.Println("Crafty Controller client initialized.")
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

	// Register slash command handler
	dg.AddHandler(interactionCreate)
	dg.Identify.Intents = discordgo.IntentsGuilds

	err = dg.Open()
	if err != nil {
		fmt.Println("error opening connection,", err)
		return
	}

	// Clean up stale global commands (we use guild commands only)
	globalCmds, err := dg.ApplicationCommands(dg.State.User.ID, "")
	if err == nil && len(globalCmds) > 0 {
		fmt.Printf("Cleaning up %d stale global commands...\n", len(globalCmds))
		for _, cmd := range globalCmds {
			_ = dg.ApplicationCommandDelete(dg.State.User.ID, "", cmd.ID)
		}
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
	Stats   *ServerStats
}

func checkServerStatus() serverStatusResult {
	if craftyClient == nil {
		return serverStatusResult{Running: false, Status: StatusMajorOutage}
	}

	stats, err := craftyClient.GetServerStats()
	if err != nil {
		fmt.Printf("Crafty stats error: %v\n", err)
		return serverStatusResult{Running: false, Status: StatusMajorOutage}
	}
	if stats.Running {
		return serverStatusResult{Running: true, Method: "Crafty", Status: StatusOperational, Stats: stats}
	}
	return serverStatusResult{Running: false, Status: StatusMajorOutage, Stats: stats}
}

func startServerCore() *discordgo.MessageEmbed {
	if craftyClient == nil {
		return errorEmbed("Start Failed", "Crafty Controller is not configured.")
	}

	// Check if already running
	stats, err := craftyClient.GetServerStats()
	if err == nil && stats.Running {
		if statuspageMinecraftServerComponentID != "" {
			spClient.UpdateComponentStatus(statuspageMinecraftServerComponentID, StatusOperational)
		}
		return warningEmbed("Already Running", "Minecraft server is already running.")
	}

	if err := craftyClient.StartServer(); err != nil {
		if statuspageMinecraftServerComponentID != "" {
			spClient.UpdateComponentStatus(statuspageMinecraftServerComponentID, StatusMajorOutage)
		}
		return errorEmbed("Start Failed", "Failed to start the Minecraft server: "+err.Error())
	}

	return successEmbed("Server Starting", "Minecraft server start requested via Crafty. Statuspage will update once the server is ready.")
}

func stopServerCore() *discordgo.MessageEmbed {
	if craftyClient == nil {
		return errorEmbed("Stop Failed", "Crafty Controller is not configured.")
	}

	if err := craftyClient.StopServer(); err != nil {
		return errorEmbed("Stop Failed", "Failed to stop the Minecraft server: "+err.Error())
	}

	if statuspageMinecraftServerComponentID != "" {
		updateErr := spClient.UpdateComponentStatus(statuspageMinecraftServerComponentID, StatusMajorOutage)
		if updateErr != nil {
			fmt.Printf("Failed to update Minecraft server status to major_outage on Statuspage after stop: %v\n", updateErr)
		} else {
			fmt.Println("Minecraft server status updated to major_outage on Statuspage after stop.")
		}
	}

	return warningEmbed("Server Stopped", "Minecraft server stop requested via Crafty.")
}

func restartServerCore() *discordgo.MessageEmbed {
	if craftyClient == nil {
		return errorEmbed("Restart Failed", "Crafty Controller is not configured.")
	}

	if err := craftyClient.RestartServer(); err != nil {
		return errorEmbed("Restart Failed", "Failed to restart the Minecraft server: "+err.Error())
	}

	// Create a maintenance incident on Statuspage
	if statuspageMinecraftServerComponentID != "" {
		_, err := spClient.CreateMaintenanceIncident(
			"Server Restart",
			"The Minecraft server is restarting. It should be back shortly.",
			[]string{statuspageMinecraftServerComponentID},
		)
		if err != nil {
			fmt.Printf("Failed to create maintenance incident: %v\n", err)
		}
	}

	return successEmbed("Server Restarting", "Minecraft server restart requested via Crafty. Statuspage will update once the server is ready.")
}

func backupServerCore() *discordgo.MessageEmbed {
	if craftyClient == nil {
		return errorEmbed("Backup Failed", "Crafty Controller is not configured.")
	}

	if err := craftyClient.BackupServer(); err != nil {
		return errorEmbed("Backup Failed", "Failed to backup the Minecraft server: "+err.Error())
	}

	return successEmbed("Backup Started", "Server backup initiated via Crafty.")
}

func connectRconSafe() (*rcon.Conn, error) {
	return rcon.Dial(os.Getenv("RCON_IP"), os.Getenv("RCON_PW"))
}

// --- Health check functions ---

func performMinecraftServerHealthCheck(s *discordgo.Session, initialCheck bool) {
	if statuspageMinecraftServerComponentID == "" {
		return
	}

	currentStatus := StatusMajorOutage

	if craftyClient != nil {
		stats, err := craftyClient.GetServerStats()
		if err != nil {
			fmt.Printf("Health check: Crafty API error: %v\n", err)
			currentStatus = StatusMajorOutage
		} else if stats.Running {
			// Verify RCON responsiveness for full operational status
			conn, rconErr := connectRconSafe()
			if rconErr == nil {
				_, execErr := conn.Execute("list")
				conn.Close()
				if execErr == nil {
					currentStatus = StatusOperational
				} else {
					currentStatus = StatusDegradedPerformance
					if s != nil {
						s.ChannelMessageSend(channelID, fmt.Sprintf("Warning: Server running (Crafty) but RCON unresponsive: %v", execErr))
					}
				}
			} else {
				currentStatus = StatusDegradedPerformance
				if s != nil {
					s.ChannelMessageSend(channelID, "Warning: Server running (Crafty) but RCON connection failed.")
				}
			}
		} else {
			currentStatus = StatusMajorOutage
		}
	}

	// Resolve any active maintenance incidents when server is back to operational
	if currentStatus == StatusOperational {
		if err := spClient.ResolveMaintenanceIncidents(); err != nil {
			fmt.Printf("Failed to resolve maintenance incidents: %v\n", err)
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


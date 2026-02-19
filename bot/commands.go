package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/bwmarrin/discordgo"
)

// Embed color constants
const (
	colorSuccess = 0x00C853
	colorError   = 0xFF1744
	colorWarning = 0xFFAB00
	colorInfo    = 0x2979FF
)

// File paths derived from CRAFTY_SERVER_PATH (set in init, fallback to old defaults)
var (
	usercachePath  = "../server/usercache.json"
	playerdataPath = "../server/plugins/RandomSPAWNZ/playerdata.yml"
)

func init() {
	if sp := os.Getenv("CRAFTY_SERVER_PATH"); sp != "" {
		usercachePath = filepath.Join(sp, "usercache.json")
		playerdataPath = filepath.Join(sp, "plugins", "RandomSPAWNZ", "playerdata.yml")
	}
}

// Slash command definitions
var slashCommands = []*discordgo.ApplicationCommand{
	{Name: "status", Description: "Check if the Minecraft server is running"},
	{Name: "start", Description: "Start the Minecraft server"},
	{Name: "stop", Description: "Stop the Minecraft server"},
	{Name: "restart", Description: "Restart the Minecraft server"},
	{Name: "backup", Description: "Trigger a server backup via Crafty"},
	{Name: "mem", Description: "Show system resource usage (CPU, memory, uptime)"},
	{Name: "rcon", Description: "Send a command to the server via RCON",
		Options: []*discordgo.ApplicationCommandOption{{
			Type:        discordgo.ApplicationCommandOptionString,
			Name:        "command",
			Description: "The RCON command to execute",
			Required:    true,
		}},
	},
	{Name: "unban", Description: "Unban a deathbanned player and reset their spawn",
		Options: []*discordgo.ApplicationCommandOption{{
			Type:        discordgo.ApplicationCommandOptionString,
			Name:        "player",
			Description: "The player's Minecraft username",
			Required:    true,
		}},
	},
	{Name: "help", Description: "Show all available bot commands"},
}

// Handler map routes slash command names to handler functions
var slashCommandHandlers = map[string]func(s *discordgo.Session, i *discordgo.InteractionCreate){
	"status":      handleStatus,
	"start":       handleStart,
	"stop":        handleStop,
	"restart":     handleRestart,
	"backup":      handleBackup,
	"mem":         handleMem,
	"rcon":        handleRcon,
	"unban":       handleUnban,
	"help":        handleHelp,
}

// --- Embed helpers ---

func successEmbed(title, desc string) *discordgo.MessageEmbed {
	return &discordgo.MessageEmbed{
		Title:       title,
		Description: desc,
		Color:       colorSuccess,
		Timestamp:   time.Now().Format(time.RFC3339),
	}
}

func errorEmbed(title, desc string) *discordgo.MessageEmbed {
	return &discordgo.MessageEmbed{
		Title:       title,
		Description: desc,
		Color:       colorError,
		Timestamp:   time.Now().Format(time.RFC3339),
	}
}

func warningEmbed(title, desc string) *discordgo.MessageEmbed {
	return &discordgo.MessageEmbed{
		Title:       title,
		Description: desc,
		Color:       colorWarning,
		Timestamp:   time.Now().Format(time.RFC3339),
	}
}

func infoEmbed(title, desc string) *discordgo.MessageEmbed {
	return &discordgo.MessageEmbed{
		Title:       title,
		Description: desc,
		Color:       colorInfo,
		Timestamp:   time.Now().Format(time.RFC3339),
	}
}

// respondEmbed sends an immediate interaction response with an embed.
func respondEmbed(s *discordgo.Session, i *discordgo.InteractionCreate, embed *discordgo.MessageEmbed) {
	s.InteractionRespond(i.Interaction, &discordgo.InteractionResponse{
		Type: discordgo.InteractionResponseChannelMessageWithSource,
		Data: &discordgo.InteractionResponseData{
			Embeds: []*discordgo.MessageEmbed{embed},
		},
	})
}

// deferResponse sends a deferred interaction response (shows "thinking...").
func deferResponse(s *discordgo.Session, i *discordgo.InteractionCreate) {
	s.InteractionRespond(i.Interaction, &discordgo.InteractionResponse{
		Type: discordgo.InteractionResponseDeferredChannelMessageWithSource,
	})
}

// followupEmbed sends a followup message with an embed after a deferred response.
func followupEmbed(s *discordgo.Session, i *discordgo.InteractionCreate, embed *discordgo.MessageEmbed) {
	s.FollowupMessageCreate(i.Interaction, true, &discordgo.WebhookParams{
		Embeds: []*discordgo.MessageEmbed{embed},
	})
}

// --- Slash command handlers ---

func handleStatus(s *discordgo.Session, i *discordgo.InteractionCreate) {
	result := checkServerStatus()

	var embed *discordgo.MessageEmbed
	if result.Running {
		embed = successEmbed("Server Online", fmt.Sprintf("Minecraft server is running (%s).", result.Method))

		// Enrich with Crafty stats if available
		if result.Stats != nil {
			st := result.Stats
			players := st.ParsePlayers()
			playerText := "None"
			if len(players) > 0 {
				playerText = strings.Join(players, ", ")
			}
			embed.Fields = append(embed.Fields,
				&discordgo.MessageEmbedField{Name: "Players", Value: fmt.Sprintf("%d/%d — %s", st.Online, st.Max, playerText), Inline: false},
				&discordgo.MessageEmbedField{Name: "CPU", Value: fmt.Sprintf("%.1f%%", st.CPU), Inline: true},
				&discordgo.MessageEmbedField{Name: "Memory", Value: st.Mem, Inline: true},
				&discordgo.MessageEmbedField{Name: "World Size", Value: st.WorldSize, Inline: true},
			)
			if st.Version != "" {
				embed.Fields = append(embed.Fields,
					&discordgo.MessageEmbedField{Name: "Version", Value: st.Version, Inline: true},
				)
			}
		}
	} else {
		embed = errorEmbed("Server Offline", "Minecraft server is not running.")
	}

	if statuspageMinecraftServerComponentID != "" {
		spStatus := result.Status
		updateErr := spClient.UpdateComponentStatus(statuspageMinecraftServerComponentID, spStatus)
		if updateErr != nil {
			embed.Fields = append(embed.Fields, &discordgo.MessageEmbedField{
				Name:  "Statuspage",
				Value: fmt.Sprintf("Failed to update: %v", updateErr),
			})
		} else {
			embed.Fields = append(embed.Fields, &discordgo.MessageEmbedField{
				Name:  "Statuspage",
				Value: fmt.Sprintf("Updated to: %s", spStatus),
			})
		}
	}

	respondEmbed(s, i, embed)
}

func handleStart(s *discordgo.Session, i *discordgo.InteractionCreate) {
	deferResponse(s, i)
	embed := startServerCore()
	followupEmbed(s, i, embed)
}

func handleStop(s *discordgo.Session, i *discordgo.InteractionCreate) {
	deferResponse(s, i)
	embed := stopServerCore()
	followupEmbed(s, i, embed)
}

func handleRestart(s *discordgo.Session, i *discordgo.InteractionCreate) {
	deferResponse(s, i)
	embed := restartServerCore()
	followupEmbed(s, i, embed)
}

func handleBackup(s *discordgo.Session, i *discordgo.InteractionCreate) {
	deferResponse(s, i)
	embed := backupServerCore()
	followupEmbed(s, i, embed)
}

func handleMem(s *discordgo.Session, i *discordgo.InteractionCreate) {
	respondEmbed(s, i, buildSystemStatsEmbed())
}

func handleRcon(s *discordgo.Session, i *discordgo.InteractionCreate) {
	cmdText := i.ApplicationCommandData().Options[0].StringValue()

	conn, err := connectRconSafe()
	if err != nil {
		respondEmbed(s, i, errorEmbed("RCON Error", fmt.Sprintf("Could not connect to RCON: %s", err.Error())))
		return
	}
	defer conn.Close()

	response, err := conn.Execute(cmdText)
	if err != nil {
		respondEmbed(s, i, errorEmbed("RCON Error", fmt.Sprintf("Command failed: %s", err.Error())))
		return
	}

	embed := infoEmbed("RCON", "")
	embed.Fields = []*discordgo.MessageEmbedField{
		{Name: "Command", Value: fmt.Sprintf("`%s`", cmdText)},
		{Name: "Response", Value: fmt.Sprintf("```\n%s\n```", response)},
	}
	respondEmbed(s, i, embed)
}

func handleUnban(s *discordgo.Session, i *discordgo.InteractionCreate) {
	playerName := i.ApplicationCommandData().Options[0].StringValue()
	deferResponse(s, i)

	// Look up UUID from usercache.json
	uuid, err := lookupUUID(playerName)
	if err != nil {
		followupEmbed(s, i, errorEmbed("Unban Failed", fmt.Sprintf("Could not find UUID for **%s**: %s", playerName, err.Error())))
		return
	}

	// Remove from RandomSPAWNZ playerdata
	spawnReset, err := removeFromPlayerdata(uuid)
	if err != nil {
		followupEmbed(s, i, warningEmbed("Unban Warning", fmt.Sprintf("Failed to reset spawn data: %s\nContinuing with pardon...", err.Error())))
	}

	// Pardon via RCON
	conn, err := connectRconSafe()
	if err != nil {
		followupEmbed(s, i, errorEmbed("Unban Failed", fmt.Sprintf("Spawn reset: %s\nBut RCON failed: %s", spawnReset, err.Error())))
		return
	}
	defer conn.Close()

	resp, err := conn.Execute("pardon " + playerName)
	if err != nil {
		followupEmbed(s, i, errorEmbed("Unban Failed", fmt.Sprintf("Spawn reset: %s\nRCON pardon failed: %s", spawnReset, err.Error())))
		return
	}

	embed := successEmbed("Player Unbanned", fmt.Sprintf("**%s** has been unbanned and will get a fresh random spawn.", playerName))
	embed.Fields = []*discordgo.MessageEmbedField{
		{Name: "UUID", Value: fmt.Sprintf("`%s`", uuid), Inline: true},
		{Name: "Spawn Reset", Value: spawnReset, Inline: true},
		{Name: "Pardon", Value: resp, Inline: false},
	}
	followupEmbed(s, i, embed)
}

// lookupUUID finds a player's UUID from the server's usercache.json.
func lookupUUID(name string) (string, error) {
	data, err := os.ReadFile(usercachePath)
	if err != nil {
		return "", fmt.Errorf("could not read usercache.json: %w", err)
	}

	var entries []struct {
		UUID string `json:"uuid"`
		Name string `json:"name"`
	}
	if err := json.Unmarshal(data, &entries); err != nil {
		return "", fmt.Errorf("could not parse usercache.json: %w", err)
	}

	lower := strings.ToLower(name)
	for _, e := range entries {
		if strings.ToLower(e.Name) == lower {
			return e.UUID, nil
		}
	}

	return "", fmt.Errorf("player not in usercache (have they joined before?)")
}

// removeFromPlayerdata removes a UUID entry from RandomSPAWNZ's playerdata.yml.
func removeFromPlayerdata(uuid string) (string, error) {
	file, err := os.Open(playerdataPath)
	if err != nil {
		if os.IsNotExist(err) {
			return "no playerdata file (skip)", nil
		}
		return "", fmt.Errorf("could not read playerdata: %w", err)
	}
	defer file.Close()

	var kept []string
	found := false
	skip := false
	scanner := bufio.NewScanner(file)

	for scanner.Scan() {
		line := scanner.Text()
		// UUID lines start at column 0 (no leading whitespace)
		if !strings.HasPrefix(line, " ") && strings.Contains(line, uuid) {
			found = true
			skip = true
			continue
		}
		if skip && strings.HasPrefix(line, " ") {
			continue
		}
		skip = false
		kept = append(kept, line)
	}

	if err := scanner.Err(); err != nil {
		return "", fmt.Errorf("error reading playerdata: %w", err)
	}

	if !found {
		return "not in playerdata (already clean)", nil
	}

	if err := os.WriteFile(playerdataPath, []byte(strings.Join(kept, "\n")+"\n"), 0644); err != nil {
		return "", fmt.Errorf("could not write playerdata: %w", err)
	}

	return "cleared (fresh random spawn on rejoin)", nil
}

func buildHelpEmbed() *discordgo.MessageEmbed {
	return &discordgo.MessageEmbed{
		Title:       "Bot Commands",
		Description: "All available slash commands:",
		Color:       colorInfo,
		Fields: []*discordgo.MessageEmbedField{
			{Name: "/status", Value: "Check server status (players, CPU, memory, world size)", Inline: false},
			{Name: "/start", Value: "Start the Minecraft server", Inline: false},
			{Name: "/stop", Value: "Stop the Minecraft server", Inline: false},
			{Name: "/restart", Value: "Restart the Minecraft server", Inline: false},
			{Name: "/backup", Value: "Trigger a server backup via Crafty", Inline: false},
			{Name: "/mem", Value: "Show system resource usage (CPU, memory)", Inline: false},
			{Name: "/rcon", Value: "Send a command to the server via RCON", Inline: false},
			{Name: "/unban", Value: "Unban a deathbanned player and reset their spawn", Inline: false},
			{Name: "/help", Value: "Show this help message", Inline: false},
		},
		Timestamp: time.Now().Format(time.RFC3339),
	}
}

func handleHelp(s *discordgo.Session, i *discordgo.InteractionCreate) {
	respondEmbed(s, i, buildHelpEmbed())
}

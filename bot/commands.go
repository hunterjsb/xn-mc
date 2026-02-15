package main

import (
	"fmt"
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

// Slash command definitions
var slashCommands = []*discordgo.ApplicationCommand{
	{Name: "status", Description: "Check if the Minecraft server is running"},
	{Name: "start", Description: "Start the Minecraft server"},
	{Name: "stop", Description: "Stop the Minecraft server"},
	{Name: "mem", Description: "Show system memory usage"},
	{Name: "clearlogs", Description: "Clear the server log file"},
	{Name: "archivelogs", Description: "Archive logs with timestamp and clear"},
	{Name: "logsize", Description: "Show current log file size"},
	{Name: "rcon", Description: "Send a command to the server via RCON",
		Options: []*discordgo.ApplicationCommandOption{{
			Type:        discordgo.ApplicationCommandOptionString,
			Name:        "command",
			Description: "The RCON command to execute",
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
	"mem":         handleMem,
	"clearlogs":   handleClearLogs,
	"archivelogs": handleArchiveLogs,
	"logsize":     handleLogSize,
	"rcon":        handleRcon,
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

func handleMem(s *discordgo.Session, i *discordgo.InteractionCreate) {
	mem := ReadMemoryStats()
	respondEmbed(s, i, buildMemEmbed(mem))
}

func handleClearLogs(s *discordgo.Session, i *discordgo.InteractionCreate) {
	freedSize, err := clearServerLogsCore()
	if err != nil {
		respondEmbed(s, i, errorEmbed("Clear Logs Failed", err.Error()))
		return
	}
	respondEmbed(s, i, successEmbed("Logs Cleared", fmt.Sprintf("Freed %s.", freedSize)))
}

func handleArchiveLogs(s *discordgo.Session, i *discordgo.InteractionCreate) {
	deferResponse(s, i)
	archiveName, fileSize, err := archiveServerLogsCore()
	if err != nil {
		followupEmbed(s, i, errorEmbed("Archive Failed", err.Error()))
		return
	}
	embed := successEmbed("Logs Archived", "Logs archived and cleared successfully.")
	embed.Fields = []*discordgo.MessageEmbedField{
		{Name: "Archive", Value: fmt.Sprintf("`%s`", archiveName), Inline: true},
		{Name: "Size", Value: fileSize, Inline: true},
	}
	followupEmbed(s, i, embed)
}

func handleLogSize(s *discordgo.Session, i *discordgo.InteractionCreate) {
	size, modTime, err := getLogFileSizeCore()
	if err != nil {
		respondEmbed(s, i, errorEmbed("Log Size Error", err.Error()))
		return
	}
	embed := infoEmbed("Server Log Info", "")
	embed.Fields = []*discordgo.MessageEmbedField{
		{Name: "Size", Value: size, Inline: true},
		{Name: "Last Modified", Value: modTime, Inline: true},
	}
	respondEmbed(s, i, embed)
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

func handleHelp(s *discordgo.Session, i *discordgo.InteractionCreate) {
	respondEmbed(s, i, buildHelpEmbed())
}

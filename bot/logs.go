package main

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/bwmarrin/discordgo"
)

const serverLogPath = "../server/server.out"

// clearServerLogsCore truncates the server log file and returns the freed size.
func clearServerLogsCore() (string, error) {
	info, err := os.Stat(serverLogPath)
	if os.IsNotExist(err) {
		return "", fmt.Errorf("server log file doesn't exist")
	}
	if err != nil {
		return "", fmt.Errorf("error reading log file: %w", err)
	}

	freedSize := formatFileSize(info.Size())

	if err := os.Truncate(serverLogPath, 0); err != nil {
		return "", fmt.Errorf("error clearing logs: %w", err)
	}

	lastReadPosition = 0
	return freedSize, nil
}

// archiveServerLogsCore archives logs and returns the archive name and file size.
func archiveServerLogsCore() (string, string, error) {
	info, err := os.Stat(serverLogPath)
	if os.IsNotExist(err) {
		return "", "", fmt.Errorf("server log file doesn't exist")
	}
	if err != nil {
		return "", "", fmt.Errorf("error reading log file: %w", err)
	}
	if info.Size() == 0 {
		return "", "", fmt.Errorf("log file is already empty")
	}

	timestamp := time.Now().Format("2006-01-02_15-04-05")
	archivePath := fmt.Sprintf("../server/server.out.%s", timestamp)

	if err := copyFile(serverLogPath, archivePath); err != nil {
		return "", "", fmt.Errorf("error archiving logs: %w", err)
	}

	if err := os.Truncate(serverLogPath, 0); err != nil {
		return "", "", fmt.Errorf("error clearing logs after archive: %w", err)
	}

	lastReadPosition = 0
	return filepath.Base(archivePath), formatFileSize(info.Size()), nil
}

// getLogFileSizeCore returns the log file size and last modified time.
func getLogFileSizeCore() (string, string, error) {
	info, err := os.Stat(serverLogPath)
	if os.IsNotExist(err) {
		return "", "", fmt.Errorf("server log file doesn't exist")
	}
	if err != nil {
		return "", "", fmt.Errorf("error reading log file: %w", err)
	}

	size := formatFileSize(info.Size())
	modTime := info.ModTime().Format("2006-01-02 15:04:05")
	return size, modTime, nil
}

// --- Prefix command wrappers (unchanged behavior) ---

func clearServerLogs(s *discordgo.Session, m *discordgo.MessageCreate) {
	freedSize, err := clearServerLogsCore()
	if err != nil {
		s.ChannelMessageSend(m.ChannelID, err.Error())
		return
	}
	s.ChannelMessageSend(m.ChannelID, fmt.Sprintf("Server logs cleared! (Freed %s)", freedSize))
}

func archiveServerLogs(s *discordgo.Session, m *discordgo.MessageCreate) {
	archiveName, fileSize, err := archiveServerLogsCore()
	if err != nil {
		s.ChannelMessageSend(m.ChannelID, err.Error())
		return
	}
	s.ChannelMessageSend(m.ChannelID, fmt.Sprintf("Logs archived to `%s` (%s) and cleared!", archiveName, fileSize))
}

func getLogFileSize(s *discordgo.Session, m *discordgo.MessageCreate) {
	size, modTime, err := getLogFileSizeCore()
	if err != nil {
		s.ChannelMessageSend(m.ChannelID, err.Error())
		return
	}
	s.ChannelMessageSend(m.ChannelID, fmt.Sprintf("**Server Log Info:**\nSize: %s\nLast Modified: %s", size, modTime))
}

func showHelpCommands(s *discordgo.Session, m *discordgo.MessageCreate) {
	helpText := `**Bot Commands:**
` + "`!status`" + ` - Check if Minecraft server is running
` + "`!start`" + ` - Start the Minecraft server
` + "`!stop`" + ` - Stop the Minecraft server
` + "`!mem`" + ` - Show system memory usage
` + "`!clearlogs`" + ` - Clear server log file
` + "`!archivelogs`" + ` - Archive logs with timestamp and clear
` + "`!logsize`" + ` - Show current log file size
` + "`!help`" + ` - Show this help message

**Server Commands:**
Any other command gets sent directly to the server via RCON (e.g., ` + "`!list`" + `, ` + "`!gamemode creative`" + `, etc.)`

	s.ChannelMessageSend(m.ChannelID, helpText)
}

// buildHelpEmbed creates an embed with all slash commands listed.
func buildHelpEmbed() *discordgo.MessageEmbed {
	return &discordgo.MessageEmbed{
		Title:       "Bot Commands",
		Description: "All available slash commands:",
		Color:       colorInfo,
		Fields: []*discordgo.MessageEmbedField{
			{Name: "/status", Value: "Check if the Minecraft server is running", Inline: false},
			{Name: "/start", Value: "Start the Minecraft server", Inline: false},
			{Name: "/stop", Value: "Stop the Minecraft server", Inline: false},
			{Name: "/mem", Value: "Show system memory usage", Inline: false},
			{Name: "/clearlogs", Value: "Clear the server log file", Inline: false},
			{Name: "/archivelogs", Value: "Archive logs with timestamp and clear", Inline: false},
			{Name: "/logsize", Value: "Show current log file size", Inline: false},
			{Name: "/rcon", Value: "Send a command to the server via RCON", Inline: false},
			{Name: "/help", Value: "Show this help message", Inline: false},
		},
		Timestamp: time.Now().Format(time.RFC3339),
	}
}

// --- Utility functions ---

func formatFileSize(bytes int64) string {
	const unit = 1024
	if bytes < unit {
		return fmt.Sprintf("%d B", bytes)
	}

	div, exp := int64(unit), 0
	for n := bytes / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}

	return fmt.Sprintf("%.1f %cB", float64(bytes)/float64(div), "KMGTPE"[exp])
}

func copyFile(src, dst string) error {
	sourceFile, err := os.Open(src)
	if err != nil {
		return err
	}
	defer sourceFile.Close()

	destFile, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer destFile.Close()

	_, err = destFile.ReadFrom(sourceFile)
	return err
}

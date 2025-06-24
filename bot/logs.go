package main

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/bwmarrin/discordgo"
)

const serverLogPath = "../server/server.out"

// clearServerLogs truncates the server log file
func clearServerLogs(s *discordgo.Session, m *discordgo.MessageCreate) {
	// Check if log file exists
	if _, err := os.Stat(serverLogPath); os.IsNotExist(err) {
		s.ChannelMessageSend(m.ChannelID, "Server log file doesn't exist.")
		return
	}

	// Get file size before clearing
	info, err := os.Stat(serverLogPath)
	if err != nil {
		s.ChannelMessageSend(m.ChannelID, "Error reading log file: "+err.Error())
		return
	}
	oldSize := formatFileSize(info.Size())

	// Truncate the file (clear contents)
	err = os.Truncate(serverLogPath, 0)
	if err != nil {
		s.ChannelMessageSend(m.ChannelID, "Error clearing logs: "+err.Error())
		return
	}

	// Reset the log streaming position
	lastReadPosition = 0

	s.ChannelMessageSend(m.ChannelID, fmt.Sprintf("✅ Server logs cleared! (Freed %s)", oldSize))
}

// archiveServerLogs moves current logs to a timestamped backup file
func archiveServerLogs(s *discordgo.Session, m *discordgo.MessageCreate) {
	// Check if log file exists
	if _, err := os.Stat(serverLogPath); os.IsNotExist(err) {
		s.ChannelMessageSend(m.ChannelID, "Server log file doesn't exist.")
		return
	}

	// Get file info
	info, err := os.Stat(serverLogPath)
	if err != nil {
		s.ChannelMessageSend(m.ChannelID, "Error reading log file: "+err.Error())
		return
	}

	if info.Size() == 0 {
		s.ChannelMessageSend(m.ChannelID, "Log file is already empty.")
		return
	}

	// Create archive filename with timestamp
	timestamp := time.Now().Format("2006-01-02_15-04-05")
	archivePath := fmt.Sprintf("../server/server.out.%s", timestamp)

	// Copy file to archive
	err = copyFile(serverLogPath, archivePath)
	if err != nil {
		s.ChannelMessageSend(m.ChannelID, "Error archiving logs: "+err.Error())
		return
	}

	// Clear the original file
	err = os.Truncate(serverLogPath, 0)
	if err != nil {
		s.ChannelMessageSend(m.ChannelID, "Error clearing logs after archive: "+err.Error())
		return
	}

	// Reset the log streaming position
	lastReadPosition = 0

	fileSize := formatFileSize(info.Size())
	s.ChannelMessageSend(m.ChannelID, fmt.Sprintf("📦 Logs archived to `%s` (%s) and cleared!", filepath.Base(archivePath), fileSize))
}

// getLogFileSize returns the current log file size
func getLogFileSize(s *discordgo.Session, m *discordgo.MessageCreate) {
	info, err := os.Stat(serverLogPath)
	if os.IsNotExist(err) {
		s.ChannelMessageSend(m.ChannelID, "Server log file doesn't exist.")
		return
	}
	if err != nil {
		s.ChannelMessageSend(m.ChannelID, "Error reading log file: "+err.Error())
		return
	}

	size := formatFileSize(info.Size())
	modTime := info.ModTime().Format("2006-01-02 15:04:05")

	s.ChannelMessageSend(m.ChannelID, fmt.Sprintf("📊 **Server Log Info:**\nSize: %s\nLast Modified: %s", size, modTime))
}

// formatFileSize converts bytes to human-readable format
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

// showHelpCommands displays all available bot commands
func showHelpCommands(s *discordgo.Session, m *discordgo.MessageCreate) {
	helpText := `**🤖 Bot Commands:**
• ` + "`!status`" + ` - Check if Minecraft server is running
• ` + "`!start`" + ` - Start the Minecraft server
• ` + "`!stop`" + ` - Stop the Minecraft server
• ` + "`!mem`" + ` - Show system memory usage
• ` + "`!clearlogs`" + ` - Clear server log file
• ` + "`!archivelogs`" + ` - Archive logs with timestamp and clear
• ` + "`!logsize`" + ` - Show current log file size
• ` + "`!help`" + ` - Show this help message

**💬 Server Commands:**
Any other command gets sent directly to the server via RCON (e.g., ` + "`!list`" + `, ` + "`!gamemode creative`" + `, etc.)`

	s.ChannelMessageSend(m.ChannelID, helpText)
}

// copyFile copies src file to dst
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

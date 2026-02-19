package main

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/bwmarrin/discordgo"
)

// buildSystemStatsEmbed builds an embed with system stats from Crafty,
// falling back to /proc/meminfo if Crafty is unavailable.
func buildSystemStatsEmbed() *discordgo.MessageEmbed {
	if craftyClient != nil {
		stats, err := craftyClient.GetServerStats()
		if err == nil {
			embed := &discordgo.MessageEmbed{
				Title: "System Stats",
				Color: colorInfo,
				Fields: []*discordgo.MessageEmbedField{
					{Name: "Server CPU", Value: fmt.Sprintf("%.1f%%", stats.CPU), Inline: true},
					{Name: "Server Memory", Value: stats.Mem, Inline: true},
				},
				Timestamp: time.Now().Format(time.RFC3339),
			}
			if stats.Running {
				embed.Fields = append(embed.Fields,
					&discordgo.MessageEmbedField{Name: "Status", Value: "Running", Inline: true},
				)
			} else {
				embed.Fields = append(embed.Fields,
					&discordgo.MessageEmbedField{Name: "Status", Value: "Stopped", Inline: true},
				)
			}
			return embed
		}
		fmt.Printf("Crafty stats error (falling back to /proc/meminfo): %v\n", err)
	}

	// Fallback: local /proc/meminfo
	mem := readMemoryStats()
	return buildMemEmbed(mem)
}

// --- Fallback: /proc/meminfo ---

type memory struct {
	MemTotal     int
	MemFree      int
	MemAvailable int
}

func readMemoryStats() memory {
	file, err := os.Open("/proc/meminfo")
	if err != nil {
		return memory{}
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	res := memory{}
	for scanner.Scan() {
		key, value := parseLine(scanner.Text())
		switch key {
		case "MemTotal":
			res.MemTotal = value
		case "MemFree":
			res.MemFree = value
		case "MemAvailable":
			res.MemAvailable = value
		}
	}
	return res
}

func buildMemEmbed(m memory) *discordgo.MessageEmbed {
	return &discordgo.MessageEmbed{
		Title: "System Memory",
		Color: colorInfo,
		Fields: []*discordgo.MessageEmbedField{
			{Name: "Total", Value: fmt.Sprintf("%.3f GB", float64(m.MemTotal)/1000000), Inline: true},
			{Name: "Free", Value: fmt.Sprintf("%.3f GB", float64(m.MemFree)/1000000), Inline: true},
			{Name: "Available", Value: fmt.Sprintf("%.3f GB", float64(m.MemAvailable)/1000000), Inline: true},
		},
		Timestamp: time.Now().Format(time.RFC3339),
	}
}

func parseLine(raw string) (key string, value int) {
	text := strings.ReplaceAll(raw[:len(raw)-2], " ", "")
	keyValue := strings.Split(text, ":")
	return keyValue[0], toInt(keyValue[1])
}

func toInt(raw string) int {
	if raw == "" {
		return 0
	}
	res, err := strconv.Atoi(raw)
	if err != nil {
		return 0
	}
	return res
}

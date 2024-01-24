package main

import (
	"flag"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"syscall"

	"github.com/bwmarrin/discordgo"
)

// Variables used for command line parameters
var (
	Token string
)

func init() {

	flag.StringVar(&Token, "t", "", "Bot Token")
	flag.Parse()
}

func main() {

	// Create a new Discord session using the provided bot token.
	dg, err := discordgo.New("Bot " + Token)
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

	// Ignore all messages created by the bot itself
	if m.Author.ID == s.State.User.ID {
		return
	}
	// If the message is "ping" reply with "Pong!"
	if m.Content == "ping" {
		s.ChannelMessageSend(m.ChannelID, "Pong!")
	}

	if m.Content == "/status" {
		checkMinecraftServerStatus(s, m)
	}

	if m.Content == "/start" {
		startMinecraftServer(s, m)
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

	s.ChannelMessageSend(m.ChannelID, statusMsg)
}

func startMinecraftServer(s *discordgo.Session, m *discordgo.MessageCreate) {
	cmd := exec.Command("tmux", "new-session", "-d", "-s", "your_tmux_session_name", "path/to/minecraft_server_command")
	err := cmd.Run()
	if err != nil {
		s.ChannelMessageSend(m.ChannelID, "Failed to start the Minecraft server.")
		return
	}

	s.ChannelMessageSend(m.ChannelID, "Minecraft server started.")
}

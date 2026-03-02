package main

import (
	"github.com/pulumi/pulumi-terraform-provider/sdks/go/discord/v2/discord"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
)

type TextChannels struct {
	Rules         *discord.TextChannel
	Announcements *discord.NewsChannel
	ServerStatus  *discord.TextChannel
	General       *discord.TextChannel
	Media         *discord.TextChannel
	BotCommands   *discord.TextChannel
	ServerChat    *discord.TextChannel
	Deaths        *discord.TextChannel
	Trading       *discord.TextChannel
	Donate           *discord.TextChannel
	Links            *discord.TextChannel
	AdminChat        *discord.TextChannel
	ModChat          *discord.TextChannel
	ModLog           *discord.TextChannel
	ServerConsole    *discord.TextChannel
	DevServerConsole *discord.TextChannel
}

type VoiceChannels struct {
	General *discord.VoiceChannel
	Gaming  *discord.VoiceChannel
	Admin   *discord.VoiceChannel
	Mod     *discord.VoiceChannel
}

func createTextChannels(ctx *pulumi.Context, serverId pulumi.StringInput, cats *Categories) (*TextChannels, error) {
	// Info channels
	rules, err := discord.NewTextChannel(ctx, "rules", &discord.TextChannelArgs{
		ServerId: serverId,
		Name:     pulumi.String("rules"),
		Topic:    pulumi.String("Server rules and guidelines"),
		Category: cats.Info.ChannelId,
		Position: pulumi.Float64(0),
	})
	if err != nil {
		return nil, err
	}

	announcements, err := discord.NewNewsChannel(ctx, "announcements", &discord.NewsChannelArgs{
		ServerId: serverId,
		Name:     pulumi.String("announcements"),
		Topic:    pulumi.String("Server news and updates"),
		Category: cats.Info.ChannelId,
		Position: pulumi.Float64(1),
	})
	if err != nil {
		return nil, err
	}

	serverStatus, err := discord.NewTextChannel(ctx, "server-status", &discord.TextChannelArgs{
		ServerId: serverId,
		Name:     pulumi.String("server-status"),
		Topic:    pulumi.String("IP, connection info, uptime"),
		Category: cats.Info.ChannelId,
		Position: pulumi.Float64(2),
	})
	if err != nil {
		return nil, err
	}

	donate, err := discord.NewTextChannel(ctx, "donate", &discord.TextChannelArgs{
		ServerId: serverId,
		Name:     pulumi.String("donate"),
		Topic:    pulumi.String("Support the server — donation tiers and perks"),
		Category: cats.Info.ChannelId,
		Position: pulumi.Float64(3),
	})
	if err != nil {
		return nil, err
	}

	links, err := discord.NewTextChannel(ctx, "links", &discord.TextChannelArgs{
		ServerId: serverId,
		Name:     pulumi.String("links"),
		Topic:    pulumi.String("Voting, wiki, and community links"),
		Category: cats.Info.ChannelId,
		Position: pulumi.Float64(4),
	})
	if err != nil {
		return nil, err
	}

	// Chat channels
	general, err := discord.NewTextChannel(ctx, "general-text", &discord.TextChannelArgs{
		ServerId: serverId,
		Name:     pulumi.String("general"),
		Topic:    pulumi.String("Main chat"),
		Category: cats.Game.ChannelId,
		Position: pulumi.Float64(0),
	})
	if err != nil {
		return nil, err
	}

	serverChat, err := discord.NewTextChannel(ctx, "server-chat", &discord.TextChannelArgs{
		ServerId: serverId,
		Name:     pulumi.String("server-chat"),
		Category: cats.Game.ChannelId,
		Position: pulumi.Float64(1),
	})
	if err != nil {
		return nil, err
	}

	media, err := discord.NewTextChannel(ctx, "media", &discord.TextChannelArgs{
		ServerId: serverId,
		Name:     pulumi.String("media"),
		Topic:    pulumi.String("Screenshots and clips"),
		Category: cats.Game.ChannelId,
		Position: pulumi.Float64(2),
	})
	if err != nil {
		return nil, err
	}

	deaths, err := discord.NewTextChannel(ctx, "deaths", &discord.TextChannelArgs{
		ServerId: serverId,
		Name:     pulumi.String("deaths"),
		Topic:    pulumi.String("Hall of the fallen"),
		Category: cats.Game.ChannelId,
		Position: pulumi.Float64(3),
	})
	if err != nil {
		return nil, err
	}

	trading, err := discord.NewTextChannel(ctx, "trading", &discord.TextChannelArgs{
		ServerId: serverId,
		Name:     pulumi.String("trading"),
		Topic:    pulumi.String("Item trading"),
		Category: cats.Game.ChannelId,
		Position: pulumi.Float64(4),
	})
	if err != nil {
		return nil, err
	}

	botCommands, err := discord.NewTextChannel(ctx, "bot-commands", &discord.TextChannelArgs{
		ServerId: serverId,
		Name:     pulumi.String("bot-commands"),
		Topic:    pulumi.String("Public bot commands"),
		Category: cats.Game.ChannelId,
		Position: pulumi.Float64(5),
	})
	if err != nil {
		return nil, err
	}

	// Admin channels
	adminChat, err := discord.NewTextChannel(ctx, "admin-text", &discord.TextChannelArgs{
		ServerId: serverId,
		Name:     pulumi.String("admin"),
		Topic:    pulumi.String("Private admin channel"),
		Category: cats.Admin.ChannelId,
		Position: pulumi.Float64(0),
	})
	if err != nil {
		return nil, err
	}

	modChat, err := discord.NewTextChannel(ctx, "mod-chat", &discord.TextChannelArgs{
		ServerId: serverId,
		Name:     pulumi.String("mod-chat"),
		Topic:    pulumi.String("Staff discussion"),
		Category: cats.Admin.ChannelId,
		Position: pulumi.Float64(1),
	})
	if err != nil {
		return nil, err
	}

	modLog, err := discord.NewTextChannel(ctx, "mod-log", &discord.TextChannelArgs{
		ServerId: serverId,
		Name:     pulumi.String("mod-log"),
		Topic:    pulumi.String("Moderation log"),
		Category: cats.Admin.ChannelId,
		Position: pulumi.Float64(2),
	})
	if err != nil {
		return nil, err
	}

	serverConsole, err := discord.NewTextChannel(ctx, "server-console", &discord.TextChannelArgs{
		ServerId: serverId,
		Name:     pulumi.String("server-console"),
		Category: cats.Admin.ChannelId,
		Position: pulumi.Float64(3),
	})
	if err != nil {
		return nil, err
	}

	devServerConsole, err := discord.NewTextChannel(ctx, "dev-server-console", &discord.TextChannelArgs{
		ServerId: serverId,
		Name:     pulumi.String("dev-server-console"),
		Topic:    pulumi.String("Server console and commands - Admin only"),
		Category: cats.Admin.ChannelId,
		Position: pulumi.Float64(4),
	})
	if err != nil {
		return nil, err
	}

	return &TextChannels{
		Rules:            rules,
		Announcements:    announcements,
		ServerStatus:     serverStatus,
		General:          general,
		Media:            media,
		BotCommands:      botCommands,
		ServerChat:       serverChat,
		Deaths:           deaths,
		Trading:          trading,
		Donate:           donate,
		Links:            links,
		AdminChat:        adminChat,
		ModChat:          modChat,
		ModLog:           modLog,
		ServerConsole:    serverConsole,
		DevServerConsole: devServerConsole,
	}, nil
}

func createVoiceChannels(ctx *pulumi.Context, serverId pulumi.StringInput, cats *Categories) (*VoiceChannels, error) {
	general, err := discord.NewVoiceChannel(ctx, "general-voice", &discord.VoiceChannelArgs{
		ServerId: serverId,
		Name:     pulumi.String("General"),
		Category: cats.Voice.ChannelId,
		Position: pulumi.Float64(0),
		Bitrate:  pulumi.Float64(64000),
	})
	if err != nil {
		return nil, err
	}

	gaming, err := discord.NewVoiceChannel(ctx, "gaming-voice", &discord.VoiceChannelArgs{
		ServerId: serverId,
		Name:     pulumi.String("Gaming"),
		Category: cats.Voice.ChannelId,
		Position: pulumi.Float64(1),
		Bitrate:  pulumi.Float64(64000),
		UserLimit: pulumi.Float64(10),
	})
	if err != nil {
		return nil, err
	}

	adminVc, err := discord.NewVoiceChannel(ctx, "admin-voice", &discord.VoiceChannelArgs{
		ServerId: serverId,
		Name:     pulumi.String("Admin VC"),
		Category: cats.Voice.ChannelId,
		Position: pulumi.Float64(2),
		Bitrate:  pulumi.Float64(64000),
	})
	if err != nil {
		return nil, err
	}

	modVc, err := discord.NewVoiceChannel(ctx, "mod-voice", &discord.VoiceChannelArgs{
		ServerId: serverId,
		Name:     pulumi.String("Mod VC"),
		Category: cats.Voice.ChannelId,
		Position: pulumi.Float64(3),
		Bitrate:  pulumi.Float64(64000),
	})
	if err != nil {
		return nil, err
	}

	return &VoiceChannels{
		General: general,
		Gaming:  gaming,
		Admin:   adminVc,
		Mod:     modVc,
	}, nil
}

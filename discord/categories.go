package main

import (
	"github.com/pulumi/pulumi-terraform-provider/sdks/go/discord/v2/discord"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
)

type Categories struct {
	Info  *discord.CategoryChannel
	Game  *discord.CategoryChannel
	Voice *discord.CategoryChannel
	Admin *discord.CategoryChannel
}

func createCategories(ctx *pulumi.Context, serverId pulumi.StringInput) (*Categories, error) {
	info, err := discord.NewCategoryChannel(ctx, "info", &discord.CategoryChannelArgs{
		ServerId: serverId,
		Name:     pulumi.String("Info"),
		Position: pulumi.Float64(0),
	})
	if err != nil {
		return nil, err
	}

	game, err := discord.NewCategoryChannel(ctx, "game", &discord.CategoryChannelArgs{
		ServerId: serverId,
		Name:     pulumi.String("Chat"),
		Position: pulumi.Float64(1),
	})
	if err != nil {
		return nil, err
	}

	voice, err := discord.NewCategoryChannel(ctx, "voice", &discord.CategoryChannelArgs{
		ServerId: serverId,
		Name:     pulumi.String("Voice"),
		Position: pulumi.Float64(2),
	})
	if err != nil {
		return nil, err
	}

	admin, err := discord.NewCategoryChannel(ctx, "admin", &discord.CategoryChannelArgs{
		ServerId: serverId,
		Name:     pulumi.String("Admin"),
		Position: pulumi.Float64(3),
	})
	if err != nil {
		return nil, err
	}

	return &Categories{
		Info:  info,
		Game:  game,
		Voice: voice,
		Admin: admin,
	}, nil
}

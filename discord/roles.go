package main

import (
	"github.com/pulumi/pulumi-terraform-provider/sdks/go/discord/v2/discord"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
)

type Roles struct {
	Admin     *discord.Role
	Moderator *discord.Role
	Staff     *discord.Role
	Player    *discord.Role
	Dead      *discord.Role
}

func createRoles(ctx *pulumi.Context, serverId pulumi.StringInput) (*Roles, error) {
	admin, err := discord.NewRole(ctx, "admin", &discord.RoleArgs{
		ServerId:    serverId,
		Name:        pulumi.String("Admin"),
		Color:       pulumi.Float64(0xFF0000),
		Permissions: pulumi.Float64(PermAdministrator),
		Hoist:       pulumi.Bool(true),
		Mentionable: pulumi.Bool(true),
	})
	if err != nil {
		return nil, err
	}

	moderator, err := discord.NewRole(ctx, "moderator", &discord.RoleArgs{
		ServerId:    serverId,
		Name:        pulumi.String("Moderator"),
		Color:       pulumi.Float64(0x00FF00),
		Permissions: pulumi.Float64(PermModerator),
		Hoist:       pulumi.Bool(true),
		Mentionable: pulumi.Bool(true),
	})
	if err != nil {
		return nil, err
	}

	staff, err := discord.NewRole(ctx, "staff", &discord.RoleArgs{
		ServerId:    serverId,
		Name:        pulumi.String("Staff"),
		Color:       pulumi.Float64(0),
		Permissions: pulumi.Float64(PermModerator),
		Hoist:       pulumi.Bool(false),
		Mentionable: pulumi.Bool(true),
	})
	if err != nil {
		return nil, err
	}

	player, err := discord.NewRole(ctx, "player", &discord.RoleArgs{
		ServerId:    serverId,
		Name:        pulumi.String("Player"),
		Color:       pulumi.Float64(0x3498DB),
		Permissions: pulumi.Float64(PermPlayer),
		Hoist:       pulumi.Bool(true),
		Mentionable: pulumi.Bool(true),
	})
	if err != nil {
		return nil, err
	}

	dead, err := discord.NewRole(ctx, "dead", &discord.RoleArgs{
		ServerId:    serverId,
		Name:        pulumi.String("Dead"),
		Color:       pulumi.Float64(0x808080),
		Permissions: pulumi.Float64(PermDead),
		Hoist:       pulumi.Bool(true),
		Mentionable: pulumi.Bool(true),
	})
	if err != nil {
		return nil, err
	}

	return &Roles{
		Admin:     admin,
		Moderator: moderator,
		Staff:     staff,
		Player:    player,
		Dead:      dead,
	}, nil
}

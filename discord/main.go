package main

import (
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi/config"
)

func main() {
	pulumi.Run(func(ctx *pulumi.Context) error {
		cfg := config.New(ctx, "xhc-discord")
		serverId := cfg.Require("serverId")
		serverIdInput := pulumi.String(serverId)

		// Roles
		roles, err := createRoles(ctx, serverIdInput)
		if err != nil {
			return err
		}

		// Categories
		cats, err := createCategories(ctx, serverIdInput)
		if err != nil {
			return err
		}

		// Text channels
		textChannels, err := createTextChannels(ctx, serverIdInput, cats)
		if err != nil {
			return err
		}

		// Voice channels
		voiceChannels, err := createVoiceChannels(ctx, serverIdInput, cats)
		if err != nil {
			return err
		}

		// Permission overwrites
		if err := createPermissions(ctx, serverIdInput, roles, cats, textChannels, voiceChannels); err != nil {
			return err
		}

		// Members
		if err := createMembers(ctx, serverIdInput, roles); err != nil {
			return err
		}

		// Messages
		if err := createMessages(ctx, textChannels); err != nil {
			return err
		}

		// Exports
		ctx.Export("serverId", pulumi.String(serverId))
		ctx.Export("adminRoleId", roles.Admin.ID())
		ctx.Export("moderatorRoleId", roles.Moderator.ID())
		ctx.Export("playerRoleId", roles.Player.ID())
		ctx.Export("staffRoleId", roles.Staff.ID())
		ctx.Export("deadRoleId", roles.Dead.ID())
		ctx.Export("generalChannelId", textChannels.General.ChannelId)
		ctx.Export("rulesChannelId", textChannels.Rules.ChannelId)
		ctx.Export("announcementsChannelId", textChannels.Announcements.ChannelId)
		ctx.Export("botCommandsChannelId", textChannels.BotCommands.ChannelId)
		ctx.Export("serverConsoleChannelId", textChannels.ServerConsole.ChannelId)
		ctx.Export("devServerConsoleChannelId", textChannels.DevServerConsole.ChannelId)

		return nil
	})
}

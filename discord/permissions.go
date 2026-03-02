package main

import (
	"github.com/pulumi/pulumi-terraform-provider/sdks/go/discord/v2/discord"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
)

func createPermissions(
	ctx *pulumi.Context,
	serverId pulumi.StringInput,
	roles *Roles,
	cats *Categories,
	textChannels *TextChannels,
	voiceChannels *VoiceChannels,
) error {
	// --- Admin category: deny @everyone, allow Admin + Moderator ---

	// @everyone role ID == server ID in Discord
	_, err := discord.NewChannelPermission(ctx, "admin-cat-deny-everyone", &discord.ChannelPermissionArgs{
		ChannelId:   cats.Admin.ChannelId,
		Type:        pulumi.String("role"),
		OverwriteId: serverId,
		Allow:       pulumi.Float64(0),
		Deny:        pulumi.Float64(PermTextAll),
	})
	if err != nil {
		return err
	}

	_, err = discord.NewChannelPermission(ctx, "admin-cat-allow-admin", &discord.ChannelPermissionArgs{
		ChannelId:   cats.Admin.ChannelId,
		Type:        pulumi.String("role"),
		OverwriteId: roles.Admin.ID().ToStringOutput(),
		Allow:       pulumi.Float64(PermTextAll),
		Deny:        pulumi.Float64(0),
	})
	if err != nil {
		return err
	}

	_, err = discord.NewChannelPermission(ctx, "admin-cat-allow-mod", &discord.ChannelPermissionArgs{
		ChannelId:   cats.Admin.ChannelId,
		Type:        pulumi.String("role"),
		OverwriteId: roles.Moderator.ID().ToStringOutput(),
		Allow:       pulumi.Float64(PermTextAll),
		Deny:        pulumi.Float64(0),
	})
	if err != nil {
		return err
	}

	_, err = discord.NewChannelPermission(ctx, "admin-cat-allow-staff", &discord.ChannelPermissionArgs{
		ChannelId:   cats.Admin.ChannelId,
		Type:        pulumi.String("role"),
		OverwriteId: roles.Staff.ID().ToStringOutput(),
		Allow:       pulumi.Float64(PermTextAll),
		Deny:        pulumi.Float64(0),
	})
	if err != nil {
		return err
	}

	// --- Deny Staff on admin-chat (admin-only) ---

	_, err = discord.NewChannelPermission(ctx, "admin-chat-deny-staff", &discord.ChannelPermissionArgs{
		ChannelId:   textChannels.AdminChat.ChannelId,
		Type:        pulumi.String("role"),
		OverwriteId: roles.Staff.ID().ToStringOutput(),
		Allow:       pulumi.Float64(0),
		Deny:        pulumi.Float64(PermTextAll),
	})
	if err != nil {
		return err
	}

	// --- Deny Moderator on admin-chat (admin-only) ---

	_, err = discord.NewChannelPermission(ctx, "admin-chat-deny-mod", &discord.ChannelPermissionArgs{
		ChannelId:   textChannels.AdminChat.ChannelId,
		Type:        pulumi.String("role"),
		OverwriteId: roles.Moderator.ID().ToStringOutput(),
		Allow:       pulumi.Float64(0),
		Deny:        pulumi.Float64(PermTextAll),
	})
	if err != nil {
		return err
	}

	// --- Admin VC: deny @everyone, allow admin only ---

	_, err = discord.NewChannelPermission(ctx, "admin-vc-deny-everyone", &discord.ChannelPermissionArgs{
		ChannelId:   voiceChannels.Admin.ChannelId,
		Type:        pulumi.String("role"),
		OverwriteId: serverId,
		Allow:       pulumi.Float64(0),
		Deny:        pulumi.Float64(PermConnect | PermSpeak | PermViewChannel),
	})
	if err != nil {
		return err
	}

	_, err = discord.NewChannelPermission(ctx, "admin-vc-allow-admin", &discord.ChannelPermissionArgs{
		ChannelId:   voiceChannels.Admin.ChannelId,
		Type:        pulumi.String("role"),
		OverwriteId: roles.Admin.ID().ToStringOutput(),
		Allow:       pulumi.Float64(PermConnect | PermSpeak | PermViewChannel),
		Deny:        pulumi.Float64(0),
	})
	if err != nil {
		return err
	}

	// --- Mod VC: deny @everyone, allow admin + mod ---

	_, err = discord.NewChannelPermission(ctx, "mod-vc-deny-everyone", &discord.ChannelPermissionArgs{
		ChannelId:   voiceChannels.Mod.ChannelId,
		Type:        pulumi.String("role"),
		OverwriteId: serverId,
		Allow:       pulumi.Float64(0),
		Deny:        pulumi.Float64(PermConnect | PermSpeak | PermViewChannel),
	})
	if err != nil {
		return err
	}

	_, err = discord.NewChannelPermission(ctx, "mod-vc-allow-admin", &discord.ChannelPermissionArgs{
		ChannelId:   voiceChannels.Mod.ChannelId,
		Type:        pulumi.String("role"),
		OverwriteId: roles.Admin.ID().ToStringOutput(),
		Allow:       pulumi.Float64(PermConnect | PermSpeak | PermViewChannel),
		Deny:        pulumi.Float64(0),
	})
	if err != nil {
		return err
	}

	_, err = discord.NewChannelPermission(ctx, "mod-vc-allow-mod", &discord.ChannelPermissionArgs{
		ChannelId:   voiceChannels.Mod.ChannelId,
		Type:        pulumi.String("role"),
		OverwriteId: roles.Moderator.ID().ToStringOutput(),
		Allow:       pulumi.Float64(PermConnect | PermSpeak | PermViewChannel),
		Deny:        pulumi.Float64(0),
	})
	if err != nil {
		return err
	}

	_, err = discord.NewChannelPermission(ctx, "mod-vc-allow-staff", &discord.ChannelPermissionArgs{
		ChannelId:   voiceChannels.Mod.ChannelId,
		Type:        pulumi.String("role"),
		OverwriteId: roles.Staff.ID().ToStringOutput(),
		Allow:       pulumi.Float64(PermConnect | PermSpeak | PermViewChannel),
		Deny:        pulumi.Float64(0),
	})
	if err != nil {
		return err
	}

	// --- Staff role: allow on mod-chat, mod-log, server-console, dev-server-console ---

	staffChannels := map[string]pulumi.StringOutput{
		"mod-chat":           textChannels.ModChat.ChannelId,
		"mod-log":            textChannels.ModLog.ChannelId,
		"server-console":     textChannels.ServerConsole.ChannelId,
		"dev-server-console": textChannels.DevServerConsole.ChannelId,
	}

	for chName, chID := range staffChannels {
		_, err = discord.NewChannelPermission(ctx, "staff-allow-"+chName, &discord.ChannelPermissionArgs{
			ChannelId:   chID,
			Type:        pulumi.String("role"),
			OverwriteId: roles.Staff.ID().ToStringOutput(),
			Allow:       pulumi.Float64(PermTextAll),
			Deny:        pulumi.Float64(0),
		})
		if err != nil {
			return err
		}
	}

	// --- Dead role: deny SEND_MESSAGES and SPEAK on all public text channels ---

	deadDenyBits := float64(PermSendMessages | PermSpeak)

	textChannelIDs := map[string]pulumi.StringOutput{
		"rules":         textChannels.Rules.ChannelId,
		"announcements": textChannels.Announcements.ChannelId,
		"server-status": textChannels.ServerStatus.ChannelId,
		"general":       textChannels.General.ChannelId,
		"media":         textChannels.Media.ChannelId,
		"bot-commands":  textChannels.BotCommands.ChannelId,
		"server-chat":   textChannels.ServerChat.ChannelId,
		"deaths":        textChannels.Deaths.ChannelId,
		"trading":       textChannels.Trading.ChannelId,
	}

	for chName, chID := range textChannelIDs {
		_, err = discord.NewChannelPermission(ctx, "dead-deny-"+chName, &discord.ChannelPermissionArgs{
			ChannelId:   chID,
			Type:        pulumi.String("role"),
			OverwriteId: roles.Dead.ID().ToStringOutput(),
			Allow:       pulumi.Float64(0),
			Deny:        pulumi.Float64(deadDenyBits),
		})
		if err != nil {
			return err
		}
	}

	// Dead role: deny SPEAK on voice channels
	voiceChannelIDs := map[string]pulumi.StringOutput{
		"general-vc": voiceChannels.General.ChannelId,
		"gaming-vc":  voiceChannels.Gaming.ChannelId,
	}

	for vcName, vcID := range voiceChannelIDs {
		_, err = discord.NewChannelPermission(ctx, "dead-deny-"+vcName, &discord.ChannelPermissionArgs{
			ChannelId:   vcID,
			Type:        pulumi.String("role"),
			OverwriteId: roles.Dead.ID().ToStringOutput(),
			Allow:       pulumi.Float64(0),
			Deny:        pulumi.Float64(PermSpeak),
		})
		if err != nil {
			return err
		}
	}

	return nil
}

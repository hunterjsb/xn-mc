package main

// Discord permission bit flags.
// See https://discord.com/developers/docs/topics/permissions
const (
	PermKickMembers        = 0x00000002
	PermBanMembers         = 0x00000004
	PermAdministrator      = 0x00000008
	PermViewChannel        = 0x00000400
	PermSendMessages       = 0x00000800
	PermManageMessages     = 0x00002000
	PermEmbedLinks         = 0x00004000
	PermAttachFiles        = 0x00008000
	PermReadMessageHistory = 0x00010000
	PermConnect            = 0x00100000
	PermSpeak              = 0x00200000
	PermMuteMembers        = 0x00400000
	PermDeafenMembers      = 0x00800000
	PermMoveMembers        = 0x01000000
	PermStream             = 0x00000200
)

// Composite permission sets.
const (
	PermPlayer = PermViewChannel | PermSendMessages | PermEmbedLinks |
		PermAttachFiles | PermReadMessageHistory | PermConnect | PermSpeak |
		PermStream

	PermDead = PermViewChannel | PermReadMessageHistory | PermConnect

	PermModerator = PermViewChannel | PermSendMessages | PermEmbedLinks |
		PermAttachFiles | PermReadMessageHistory | PermConnect | PermSpeak |
		PermManageMessages | PermKickMembers | PermBanMembers |
		PermMuteMembers | PermDeafenMembers | PermMoveMembers

	PermTextAll = PermViewChannel | PermSendMessages | PermManageMessages |
		PermEmbedLinks | PermAttachFiles | PermReadMessageHistory
)

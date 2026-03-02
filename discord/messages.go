package main

import (
	"github.com/pulumi/pulumi-terraform-provider/sdks/go/discord/v2/discord"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
)

func createMessages(ctx *pulumi.Context, textChannels *TextChannels) error {
	// Server info pinned in #server-status
	_, err := discord.NewMessage(ctx, "server-info-message", &discord.MessageArgs{
		ChannelId: textChannels.ServerStatus.ChannelId,
		Pinned:    pulumi.Bool(true),
		Embed: discord.MessageEmbedArgs{
			Title:       pulumi.String("Server Info"),
			Description: pulumi.String("Everything you need to connect and stay informed."),
			Color:       pulumi.Float64(0x3498DB),
			Fields: discord.MessageEmbedFieldArray{
				discord.MessageEmbedFieldArgs{
					Name:   pulumi.String("Server IP"),
					Value:  pulumi.String("`mc.xandaris.space`"),
					Inline: pulumi.Bool(true),
				},
				discord.MessageEmbedFieldArgs{
					Name:   pulumi.String("Website"),
					Value:  pulumi.String("[xandaris.space](https://xandaris.space)"),
					Inline: pulumi.Bool(true),
				},
				discord.MessageEmbedFieldArgs{
					Name:   pulumi.String("Status Page"),
					Value:  pulumi.String("[xnmc.statuspage.io](https://xnmc.statuspage.io)"),
					Inline: pulumi.Bool(true),
				},
			},
		},
	})
	if err != nil {
		return err
	}

	// --- #donate messages ---

	// Pinned donate info
	_, err = discord.NewMessage(ctx, "donate-info-message", &discord.MessageArgs{
		ChannelId: textChannels.Donate.ChannelId,
		Pinned:    pulumi.Bool(true),
		Embed: discord.MessageEmbedArgs{
			Title:       pulumi.String("Support Xandaris"),
			Description: pulumi.String("Donations help keep the server running. All tiers include a role and our eternal gratitude."),
			Color:       pulumi.Float64(0xF1C40F),
			Fields: discord.MessageEmbedFieldArray{
				discord.MessageEmbedFieldArgs{
					Name:   pulumi.String("How to Donate"),
					Value:  pulumi.String("[Donate Here](https://xandaris.space/donate)"),
					Inline: pulumi.Bool(true),
				},
			},
		},
	})
	if err != nil {
		return err
	}

	// Tier 1 — Supporter ($5)
	_, err = discord.NewMessage(ctx, "donate-tier1-message", &discord.MessageArgs{
		ChannelId: textChannels.Donate.ChannelId,
		Embed: discord.MessageEmbedArgs{
			Title:       pulumi.String("Supporter — $5"),
			Description: pulumi.String("Show your support for the server."),
			Color:       pulumi.Float64(0x2ECC71),
			Fields: discord.MessageEmbedFieldArray{
				discord.MessageEmbedFieldArgs{
					Name:  pulumi.String("Perks"),
					Value: pulumi.String("• Supporter role & color\n• Access to supporter-only channels\n• Our thanks!"),
				},
			},
		},
	})
	if err != nil {
		return err
	}

	// Tier 2 — VIP ($10)
	_, err = discord.NewMessage(ctx, "donate-tier2-message", &discord.MessageArgs{
		ChannelId: textChannels.Donate.ChannelId,
		Embed: discord.MessageEmbedArgs{
			Title:       pulumi.String("VIP — $10"),
			Description: pulumi.String("For dedicated players who want a bit more."),
			Color:       pulumi.Float64(0x3498DB),
			Fields: discord.MessageEmbedFieldArray{
				discord.MessageEmbedFieldArgs{
					Name:  pulumi.String("Perks"),
					Value: pulumi.String("• Everything in Supporter\n• VIP role & color\n• Priority slot during peak hours"),
				},
			},
		},
	})
	if err != nil {
		return err
	}

	// Tier 3 — MVP ($25)
	_, err = discord.NewMessage(ctx, "donate-tier3-message", &discord.MessageArgs{
		ChannelId: textChannels.Donate.ChannelId,
		Embed: discord.MessageEmbedArgs{
			Title:       pulumi.String("MVP — $25"),
			Description: pulumi.String("The ultimate way to support Xandaris."),
			Color:       pulumi.Float64(0x9B59B6),
			Fields: discord.MessageEmbedFieldArray{
				discord.MessageEmbedFieldArgs{
					Name:  pulumi.String("Perks"),
					Value: pulumi.String("• Everything in VIP\n• MVP role & color\n• Name in the credits on the website"),
				},
			},
		},
	})
	if err != nil {
		return err
	}

	// --- #links message ---

	_, err = discord.NewMessage(ctx, "links-message", &discord.MessageArgs{
		ChannelId: textChannels.Links.ChannelId,
		Pinned:    pulumi.Bool(true),
		Embed: discord.MessageEmbedArgs{
			Title: pulumi.String("Xandaris Links"),
			Color: pulumi.Float64(0x3498DB),
			Fields: discord.MessageEmbedFieldArray{
				discord.MessageEmbedFieldArgs{
					Name:  pulumi.String("Website"),
					Value: pulumi.String("**[xandaris.space](https://xandaris.space)**"),
				},
				discord.MessageEmbedFieldArgs{
					Name:  pulumi.String("Server Wiki"),
					Value: pulumi.String("**[wiki.xandaris.space](https://wiki.xandaris.space)**"),
				},
				discord.MessageEmbedFieldArgs{
					Name:  pulumi.String("Status Page"),
					Value: pulumi.String("**[xnmc.statuspage.io](https://xnmc.statuspage.io)**"),
				},
				discord.MessageEmbedFieldArgs{
					Name:  pulumi.String("GitHub"),
					Value: pulumi.String("**[hunterjsb/xn-mc](https://github.com/hunterjsb/xn-mc)**"),
				},
				discord.MessageEmbedFieldArgs{
					Name:  pulumi.String("Vote for Us"),
					Value: pulumi.String("**[Coming Soon](https://xandaris.space)**"),
				},
			},
		},
	})
	if err != nil {
		return err
	}

	// Rules pinned in #rules
	_, err = discord.NewMessage(ctx, "rules-message", &discord.MessageArgs{
		ChannelId: textChannels.Rules.ChannelId,
		Pinned:    pulumi.Bool(true),
		Embed: discord.MessageEmbedArgs{
			Title:       pulumi.String("Xandaris Hardcore SMP — Rules"),
			Description: pulumi.String("Welcome to the XHC. Pure vanilla, borderline anarchy. Everything goes — except hacks."),
			Color:       pulumi.Float64(0xFF0000),
			Fields: discord.MessageEmbedFieldArray{
				discord.MessageEmbedFieldArgs{
					Name:  pulumi.String("1. No Cheating"),
					Value: pulumi.String("No hacked clients, x-ray, duping, or exploits. Play legit or don't play. This is the only real rule."),
				},
				discord.MessageEmbedFieldArgs{
					Name:  pulumi.String("2. Everything Else Is Fair Game"),
					Value: pulumi.String("Griefing, raiding, PvP, betrayal, theft — all allowed. This is hardcore. Trust no one."),
				},
				discord.MessageEmbedFieldArgs{
					Name:  pulumi.String("3. Death is Permanent"),
					Value: pulumi.String("When you die, you get the **Dead** role. You can still read and listen, but you cannot send messages or speak. No appeals, no second chances."),
				},
				discord.MessageEmbedFieldArgs{
					Name:  pulumi.String("4. Don't Be Bigoted"),
					Value: pulumi.String("Trash talk and toxicity are part of the game. Slurs and targeted harassment are not. Know the difference."),
				},
				discord.MessageEmbedFieldArgs{
					Name:  pulumi.String("5. Admin Decisions Are Final"),
					Value: pulumi.String("If an admin makes a call, respect it. Disputes go to #admin, not public channels."),
				},
			},
		},
	})
	return err
}

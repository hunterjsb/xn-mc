package main

import (
	"github.com/pulumi/pulumi-terraform-provider/sdks/go/statuspage/statuspage"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi"
	"github.com/pulumi/pulumi/sdk/v3/go/pulumi/config"
)

func main() {
	pulumi.Run(func(ctx *pulumi.Context) error {
		cfg := config.New(ctx, "statuspageio")
		pageID := cfg.Require("pageId")

		// Bot component (imported)
		bot, err := statuspage.NewComponent(ctx, "bot", &statuspage.ComponentArgs{
			PageId:      pulumi.String(pageID),
			Name:        pulumi.String("Bot"),
			Description: pulumi.String("Discord Bot"),
			Showcase:    pulumi.Bool(true),
		})
		if err != nil {
			return err
		}

		// Server component (imported)
		server, err := statuspage.NewComponent(ctx, "server", &statuspage.ComponentArgs{
			PageId:      pulumi.String(pageID),
			Name:        pulumi.String("Server"),
			Description: pulumi.String("Minecraft Server"),
			Showcase:    pulumi.Bool(true),
		})
		if err != nil {
			return err
		}

		// Restart component (hidden when operational)
		restart, err := statuspage.NewComponent(ctx, "restart", &statuspage.ComponentArgs{
			PageId:             pulumi.String(pageID),
			Name:               pulumi.String("Restart"),
			Description:        pulumi.String("Shown during server restarts"),
			OnlyShowIfDegraded: pulumi.Bool(true),
		})
		if err != nil {
			return err
		}

		ctx.Export("botComponentId", bot.ID())
		ctx.Export("serverComponentId", server.ID())
		ctx.Export("restartComponentId", restart.ID())

		return nil
	})
}

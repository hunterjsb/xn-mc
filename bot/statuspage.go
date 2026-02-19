package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

const (
	statuspageAPIBaseURL = "https://api.statuspage.io/v1"
	// Component Statues
	StatusOperational         = "operational"
	StatusUnderMaintenance    = "under_maintenance"
	StatusDegradedPerformance = "degraded_performance"
	StatusPartialOutage       = "partial_outage"
	StatusMajorOutage         = "major_outage"
)

// StatuspageClient holds the configuration for the Statuspage API client
type StatuspageClient struct {
	apiKey     string
	pageID     string
	httpClient *http.Client
}

// NewStatuspageClient creates a new client for Statuspage API interactions
func NewStatuspageClient(apiKey, pageID string) *StatuspageClient {
	return &StatuspageClient{
		apiKey: apiKey,
		pageID: pageID,
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
}

// ComponentUpdatePayload is the structure for updating a component's status
type ComponentUpdatePayload struct {
	Component struct {
		Status string `json:"status"`
	} `json:"component"`
}

// UpdateComponentStatus updates the status of a given component on Statuspage.io
func (c *StatuspageClient) UpdateComponentStatus(componentID string, status string) error {
	if c.apiKey == "" || c.pageID == "" || componentID == "" {
		// Silently return if configuration is missing, error will be logged at bot startup/initialization.
		// This prevents spamming logs if the bot is running without full Statuspage config.
		return fmt.Errorf("Statuspage client not configured (API Key, Page ID, or Component ID missing). Cannot update component %s", componentID)
	}

	payload := ComponentUpdatePayload{}
	payload.Component.Status = status

	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("failed to marshal Statuspage payload: %w", err)
	}

	url := fmt.Sprintf("%s/pages/%s/components/%s.json", statuspageAPIBaseURL, c.pageID, componentID)

	req, err := http.NewRequest("PATCH", url, bytes.NewBuffer(payloadBytes))
	if err != nil {
		return fmt.Errorf("failed to create Statuspage request: %w", err)
	}

	req.Header.Set("Authorization", "OAuth "+c.apiKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to send request to Statuspage: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		fmt.Printf("Successfully updated Statuspage component %s to %s\n", componentID, status)
		return nil
	}

	// Attempt to read body for more error info, but don't fail if that's not possible
	var responseBody bytes.Buffer
	_, _ = responseBody.ReadFrom(resp.Body)
	errMsg := fmt.Sprintf("failed to update Statuspage component %s, status: %s, response: %s", componentID, resp.Status, responseBody.String())
	fmt.Println("Statuspage API Error:", errMsg) // Log to console
	return fmt.Errorf(errMsg)
}

// Helper function to validate essential Statuspage configuration on startup
func checkStatuspageConfig() error {
	if statuspageAPIKey == "" {
		return fmt.Errorf("STATUSPAGE_API_KEY is not set")
	}
	if statuspagePageID == "" {
		return fmt.Errorf("STATUSPAGE_PAGE_ID is not set")
	}
	// Component IDs can be checked where they are used, as one might be set and not the other.
	// For example, user might only want to report server status and not bot status.
	if statuspageMinecraftServerComponentID == "" && statuspageBotComponentID == "" {
		fmt.Println("Warning: Neither STATUSPAGE_MINECRAFT_SERVER_COMPONENT_ID nor STATUSPAGE_BOT_COMPONENT_ID are set. Statuspage updates will be limited.")
	} else {
		if statuspageMinecraftServerComponentID == "" {
			fmt.Println("Warning: STATUSPAGE_MINECRAFT_SERVER_COMPONENT_ID is not set. Minecraft server status will not be reported to Statuspage.")
		}
		if statuspageBotComponentID == "" {
			fmt.Println("Warning: STATUSPAGE_BOT_COMPONENT_ID is not set. Bot status will not be reported to Statuspage.")
		}
		if statuspageRestartComponentID == "" {
			fmt.Println("Warning: STATUSPAGE_RESTART_COMPONENT_ID is not set. Restart status will not be reported to Statuspage.")
		}
	}
	return nil
}

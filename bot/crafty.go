package main

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// CraftyClient wraps the Crafty Controller v2 REST API.
type CraftyClient struct {
	baseURL  string // e.g. "https://localhost:8443/api/v2"
	apiKey   string // JWT bearer token
	serverID string
	http     *http.Client
}

// NewCraftyClient creates a Crafty API client.
// InsecureSkipVerify is used because Crafty uses a self-signed cert on localhost.
func NewCraftyClient(baseURL, apiKey, serverID string) *CraftyClient {
	return &CraftyClient{
		baseURL:  strings.TrimRight(baseURL, "/"),
		apiKey:   apiKey,
		serverID: serverID,
		http: &http.Client{
			Timeout: 15 * time.Second,
			Transport: &http.Transport{
				TLSClientConfig: &tls.Config{InsecureSkipVerify: true},
			},
		},
	}
}

// doRequest executes an authenticated request and decodes the JSON response.
func (c *CraftyClient) doRequest(method, path string, body interface{}) (json.RawMessage, error) {
	var reqBody io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("marshal body: %w", err)
		}
		reqBody = bytes.NewReader(b)
	}

	url := c.baseURL + path
	req, err := http.NewRequest(method, url, reqBody)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("HTTP %d from %s %s: %s", resp.StatusCode, method, path, string(raw))
	}

	var envelope struct {
		Status string          `json:"status"`
		Data   json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return nil, fmt.Errorf("decode response: %w", err)
	}
	if envelope.Status != "ok" {
		return nil, fmt.Errorf("API status %q: %s", envelope.Status, string(raw))
	}

	return envelope.Data, nil
}

// doRequestText sends a plain-text body (used for stdin).
func (c *CraftyClient) doRequestText(method, path, text string) error {
	url := c.baseURL + path
	req, err := http.NewRequest(method, url, strings.NewReader(text))
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("Content-Type", "text/plain")

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("request %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		raw, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("HTTP %d from %s %s: %s", resp.StatusCode, method, path, string(raw))
	}
	return nil
}

// ServerStats is the response from GET /servers/{id}/stats.
type ServerStats struct {
	Running    bool    `json:"running"`
	CPU        float64 `json:"cpu"`
	Mem        string `json:"mem"`
	MemPercent float64 `json:"mem_percent"`
	Online     int    `json:"online"`
	Max        int    `json:"max"`
	Players    string `json:"players"` // Python-repr: "['name1', 'name2']"
	WorldName  string `json:"world_name"`
	WorldSize  string `json:"world_size"`
	Version    string `json:"version"`
	Updating   bool   `json:"updating"`
	Crashed    bool   `json:"crashed"`
}

// GetServerStats returns the current server stats from Crafty.
func (c *CraftyClient) GetServerStats() (*ServerStats, error) {
	data, err := c.doRequest("GET", fmt.Sprintf("/servers/%s/stats", c.serverID), nil)
	if err != nil {
		return nil, err
	}
	var stats ServerStats
	if err := json.Unmarshal(data, &stats); err != nil {
		return nil, fmt.Errorf("decode server stats: %w", err)
	}
	return &stats, nil
}

// ParsePlayers extracts player names from the Python-repr string Crafty returns.
// Input: "['name1', 'name2']" or "[]" → Output: []string{"name1", "name2"} or nil.
func (s *ServerStats) ParsePlayers() []string {
	trimmed := strings.TrimSpace(s.Players)
	if trimmed == "" || trimmed == "[]" {
		return nil
	}
	// Strip outer brackets
	trimmed = strings.Trim(trimmed, "[]")
	var names []string
	for _, part := range strings.Split(trimmed, ",") {
		name := strings.TrimSpace(part)
		name = strings.Trim(name, "'\"")
		if name != "" {
			names = append(names, name)
		}
	}
	return names
}

// StartServer sends a start action to Crafty.
func (c *CraftyClient) StartServer() error {
	_, err := c.doRequest("POST", fmt.Sprintf("/servers/%s/action/start_server", c.serverID), nil)
	return err
}

// StopServer sends a stop action to Crafty.
func (c *CraftyClient) StopServer() error {
	_, err := c.doRequest("POST", fmt.Sprintf("/servers/%s/action/stop_server", c.serverID), nil)
	return err
}

// RestartServer sends a restart action to Crafty.
func (c *CraftyClient) RestartServer() error {
	_, err := c.doRequest("POST", fmt.Sprintf("/servers/%s/action/restart_server", c.serverID), nil)
	return err
}

// BackupServer triggers a backup via Crafty.
func (c *CraftyClient) BackupServer() error {
	_, err := c.doRequest("POST", fmt.Sprintf("/servers/%s/action/backup_server", c.serverID), nil)
	return err
}

// SendCommand sends a console command to the server via stdin.
// Note: this does NOT return output — use RCON if you need a response.
func (c *CraftyClient) SendCommand(cmd string) error {
	return c.doRequestText("POST", fmt.Sprintf("/servers/%s/stdin", c.serverID), cmd)
}

// GetLogs retrieves the server log lines from Crafty.
func (c *CraftyClient) GetLogs() ([]string, error) {
	data, err := c.doRequest("GET", fmt.Sprintf("/servers/%s/logs", c.serverID), nil)
	if err != nil {
		return nil, err
	}
	var lines []string
	if err := json.Unmarshal(data, &lines); err != nil {
		return nil, fmt.Errorf("decode logs: %w", err)
	}
	return lines, nil
}

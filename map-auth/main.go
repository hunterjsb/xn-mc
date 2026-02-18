package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Config holds all service configuration.
type Config struct {
	ClientID     string
	ClientSecret string
	BotToken     string
	GuildID      string
	AllowedRoles map[string]bool
	CallbackURL  string
	CookieSecret []byte
	ListenAddr   string
	CookieDomain string
}

// CookiePayload is the signed cookie content.
type CookiePayload struct {
	UserID  string `json:"uid"`
	Expires int64  `json:"exp"`
}

const (
	cookieName = "map_auth"
	cookieTTL  = 24 * time.Hour

	discordAuthorizeURL = "https://discord.com/api/oauth2/authorize"
	discordTokenURL     = "https://discord.com/api/oauth2/token"
	discordAPIBase      = "https://discord.com/api/v10"
)

func main() {
	cfg := loadConfig()

	http.HandleFunc("/validate", cfg.handleValidate)
	http.HandleFunc("/login", cfg.handleLogin)
	http.HandleFunc("/auth", cfg.handleAuth)
	http.HandleFunc("/logout", cfg.handleLogout)

	log.Printf("map-auth listening on %s", cfg.ListenAddr)
	log.Fatal(http.ListenAndServe(cfg.ListenAddr, nil))
}

func loadConfig() *Config {
	cfg := &Config{
		ClientID:     envOrDie("DISCORD_CLIENT_ID"),
		ClientSecret: envOrDie("DISCORD_CLIENT_SECRET"),
		BotToken:     envOrDie("DISCORD_BOT_TOKEN"),
		GuildID:      envOrDie("DISCORD_GUILD_ID"),
		CallbackURL:  envDefault("CALLBACK_URL", "https://map.xandaris.space/auth"),
		ListenAddr:   envDefault("LISTEN_ADDR", "127.0.0.1:9090"),
		CookieDomain: envDefault("COOKIE_DOMAIN", "xandaris.space"),
	}

	// Parse allowed roles into a set.
	roles := envOrDie("ALLOWED_ROLES")
	cfg.AllowedRoles = make(map[string]bool)
	for _, r := range strings.Split(roles, ",") {
		r = strings.TrimSpace(r)
		if r != "" {
			cfg.AllowedRoles[r] = true
		}
	}

	// Cookie secret: use env, or load/generate from file.
	if secret := os.Getenv("COOKIE_SECRET"); secret != "" {
		cfg.CookieSecret = []byte(secret)
	} else {
		cfg.CookieSecret = loadOrGenerateSecret()
	}

	return cfg
}

func envOrDie(key string) string {
	v := os.Getenv(key)
	if v == "" {
		log.Fatalf("required env var %s is not set", key)
	}
	return v
}

func envDefault(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func loadOrGenerateSecret() []byte {
	// Try to store next to the binary.
	exe, err := os.Executable()
	if err != nil {
		exe = "."
	}
	secretPath := filepath.Join(filepath.Dir(exe), ".cookie_secret")

	data, err := os.ReadFile(secretPath)
	if err == nil && len(data) >= 32 {
		return data
	}

	// Generate new secret.
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		log.Fatalf("failed to generate cookie secret: %v", err)
	}
	if err := os.WriteFile(secretPath, secret, 0600); err != nil {
		log.Printf("warning: could not persist cookie secret to %s: %v", secretPath, err)
	} else {
		log.Printf("generated new cookie secret at %s", secretPath)
	}
	return secret
}

// --- Handlers ---

func (c *Config) handleValidate(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie(cookieName)
	if err != nil {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}

	payload, err := c.verifyCookie(cookie.Value)
	if err != nil {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}

	if time.Now().Unix() > payload.Expires {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}

	w.Header().Set("X-Auth-User", payload.UserID)
	w.WriteHeader(http.StatusOK)
}

func (c *Config) handleLogin(w http.ResponseWriter, r *http.Request) {
	params := url.Values{
		"client_id":     {c.ClientID},
		"redirect_uri":  {c.CallbackURL},
		"response_type": {"code"},
		"scope":         {"identify"},
	}
	http.Redirect(w, r, discordAuthorizeURL+"?"+params.Encode(), http.StatusFound)
}

func (c *Config) handleAuth(w http.ResponseWriter, r *http.Request) {
	code := r.URL.Query().Get("code")
	if code == "" {
		http.Error(w, "missing code parameter", http.StatusBadRequest)
		return
	}

	// Exchange code for access token.
	tokenResp, err := http.PostForm(discordTokenURL, url.Values{
		"client_id":     {c.ClientID},
		"client_secret": {c.ClientSecret},
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"redirect_uri":  {c.CallbackURL},
	})
	if err != nil {
		log.Printf("token exchange failed: %v", err)
		http.Error(w, "authentication failed", http.StatusBadGateway)
		return
	}
	defer tokenResp.Body.Close()

	var tokenData struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(tokenResp.Body).Decode(&tokenData); err != nil || tokenData.AccessToken == "" {
		log.Printf("failed to parse token response: %v", err)
		http.Error(w, "authentication failed", http.StatusBadGateway)
		return
	}

	// Get user ID from Discord.
	userID, err := c.getDiscordUserID(tokenData.AccessToken)
	if err != nil {
		log.Printf("failed to get user: %v", err)
		http.Error(w, "authentication failed", http.StatusBadGateway)
		return
	}

	// Check guild membership and roles via bot API.
	hasRole, err := c.checkMemberRoles(userID)
	if err != nil {
		log.Printf("failed to check roles for user %s: %v", userID, err)
		http.Error(w, "failed to verify server membership", http.StatusBadGateway)
		return
	}

	if !hasRole {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusForbidden)
		fmt.Fprint(w, `<!DOCTYPE html>
<html><head><title>Access Denied</title>
<style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a2e;color:#e0e0e0}
.box{text-align:center;padding:2rem;border-radius:8px;background:#16213e;box-shadow:0 4px 6px rgba(0,0,0,.3)}
h1{color:#e74c3c}a{color:#5865F2}</style></head>
<body><div class="box"><h1>Access Denied</h1>
<p>You need a staff role in the Xandaris Discord server to access the map.</p>
<p><a href="/logout">Log out</a></p></div></body></html>`)
		return
	}

	// Set signed cookie and redirect to map.
	cookieVal, err := c.signCookie(CookiePayload{
		UserID:  userID,
		Expires: time.Now().Add(cookieTTL).Unix(),
	})
	if err != nil {
		log.Printf("failed to sign cookie: %v", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     cookieName,
		Value:    cookieVal,
		Path:     "/",
		Domain:   c.CookieDomain,
		MaxAge:   int(cookieTTL.Seconds()),
		Secure:   true,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
	http.Redirect(w, r, "/", http.StatusFound)
}

func (c *Config) handleLogout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     cookieName,
		Value:    "",
		Path:     "/",
		Domain:   c.CookieDomain,
		MaxAge:   -1,
		Secure:   true,
		HttpOnly: true,
	})
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	fmt.Fprint(w, `<!DOCTYPE html>
<html><head><title>Logged Out</title>
<style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#1a1a2e;color:#e0e0e0}
.box{text-align:center;padding:2rem;border-radius:8px;background:#16213e;box-shadow:0 4px 6px rgba(0,0,0,.3)}
a{color:#5865F2}</style></head>
<body><div class="box"><h1>Logged Out</h1>
<p>You have been logged out of the Xandaris map.</p>
<p><a href="/login">Log in again</a></p></div></body></html>`)
}

// --- Discord API ---

func (c *Config) getDiscordUserID(accessToken string) (string, error) {
	req, _ := http.NewRequest("GET", discordAPIBase+"/users/@me", nil)
	req.Header.Set("Authorization", "Bearer "+accessToken)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("discord /users/@me returned %d: %s", resp.StatusCode, body)
	}

	var user struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&user); err != nil {
		return "", err
	}
	return user.ID, nil
}

func (c *Config) checkMemberRoles(userID string) (bool, error) {
	url := fmt.Sprintf("%s/guilds/%s/members/%s", discordAPIBase, c.GuildID, userID)
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("Authorization", "Bot "+c.BotToken)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return false, nil // not a member of the guild
	}
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return false, fmt.Errorf("discord guild member API returned %d: %s", resp.StatusCode, body)
	}

	var member struct {
		Roles []string `json:"roles"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&member); err != nil {
		return false, err
	}

	for _, role := range member.Roles {
		if c.AllowedRoles[role] {
			return true, nil
		}
	}
	return false, nil
}

// --- Cookie signing/verification ---

func (c *Config) signCookie(payload CookiePayload) (string, error) {
	data, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}

	encoded := base64.RawURLEncoding.EncodeToString(data)
	sig := c.hmacSign([]byte(encoded))
	return encoded + "." + base64.RawURLEncoding.EncodeToString(sig), nil
}

func (c *Config) verifyCookie(cookie string) (*CookiePayload, error) {
	parts := strings.SplitN(cookie, ".", 2)
	if len(parts) != 2 {
		return nil, fmt.Errorf("malformed cookie")
	}

	encoded, sigB64 := parts[0], parts[1]
	sig, err := base64.RawURLEncoding.DecodeString(sigB64)
	if err != nil {
		return nil, fmt.Errorf("invalid signature encoding")
	}

	expected := c.hmacSign([]byte(encoded))
	if !hmac.Equal(sig, expected) {
		return nil, fmt.Errorf("invalid signature")
	}

	data, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return nil, fmt.Errorf("invalid payload encoding")
	}

	var payload CookiePayload
	if err := json.Unmarshal(data, &payload); err != nil {
		return nil, fmt.Errorf("invalid payload")
	}
	return &payload, nil
}

func (c *Config) hmacSign(data []byte) []byte {
	mac := hmac.New(sha256.New, c.CookieSecret)
	mac.Write(data)
	return mac.Sum(nil)
}


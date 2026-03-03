package space.xandaris.revival;

import org.bukkit.Location;
import org.bukkit.plugin.java.JavaPlugin;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.logging.Level;

public class RevivalPlugin extends JavaPlugin {

    private String webhookUrl;
    private String webhookSecret;

    // Pending revivals: player name → ritual location (set before pardon, consumed on join)
    final Map<String, Location> pendingRevivals = new ConcurrentHashMap<>();

    @Override
    public void onEnable() {
        saveDefaultConfig();
        webhookUrl = getConfig().getString("webhook-url", "http://localhost:8765/revival");
        webhookSecret = getConfig().getString("webhook-secret", "");

        getServer().getPluginManager().registerEvents(new RevivalListener(this), this);
        getLogger().info("RevivalRitual enabled — webhook: " + webhookUrl);
    }

    @Override
    public void onDisable() {
        getLogger().info("RevivalRitual disabled");
    }

    /**
     * Send a revival webhook to the chatbot system.
     * Runs async to avoid blocking the main thread.
     */
    public void sendWebhook(String reviver, String deadPlayer, double x, double y, double z) {
        getServer().getScheduler().runTaskAsynchronously(this, () -> {
            try {
                URL url = new URL(webhookUrl);
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("POST");
                conn.setRequestProperty("Content-Type", "application/json");
                conn.setDoOutput(true);
                conn.setConnectTimeout(5000);
                conn.setReadTimeout(5000);

                String json = String.format(
                    "{\"secret\":\"%s\",\"reviver\":\"%s\",\"deadPlayer\":\"%s\",\"x\":%.1f,\"y\":%.1f,\"z\":%.1f}",
                    webhookSecret, reviver, deadPlayer, x, y, z
                );

                try (OutputStream os = conn.getOutputStream()) {
                    os.write(json.getBytes(StandardCharsets.UTF_8));
                }

                int code = conn.getResponseCode();
                if (code == 200) {
                    getLogger().info("Webhook sent: " + reviver + " revived " + deadPlayer);
                } else {
                    getLogger().warning("Webhook returned HTTP " + code);
                }
                conn.disconnect();
            } catch (Exception e) {
                getLogger().log(Level.WARNING, "Failed to send webhook", e);
            }
        });
    }
}

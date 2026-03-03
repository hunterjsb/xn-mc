package space.xandaris.revival;

import org.bukkit.Bukkit;
import org.bukkit.Location;
import org.bukkit.block.Block;
import org.bukkit.block.Skull;
import org.bukkit.block.BlockState;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.event.block.BlockPlaceEvent;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.Material;
import org.bukkit.OfflinePlayer;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.SkullMeta;

public class RevivalListener implements Listener {

    private final RevivalPlugin plugin;

    public RevivalListener(RevivalPlugin plugin) {
        this.plugin = plugin;
    }

    @EventHandler(priority = EventPriority.MONITOR, ignoreCancelled = true)
    public void onBlockPlace(BlockPlaceEvent event) {
        Block placed = event.getBlockPlaced();

        // Only trigger on player head placement
        if (placed.getType() != Material.PLAYER_HEAD && placed.getType() != Material.PLAYER_WALL_HEAD) {
            return;
        }

        plugin.getLogger().info("Player head placed by " + event.getPlayer().getName()
            + " at " + placed.getX() + ", " + placed.getY() + ", " + placed.getZ()
            + " (type: " + placed.getType() + ")");

        // Try getting the owner from the ITEM first (more reliable than block state on place)
        String deadPlayer = null;
        ItemStack handItem = event.getItemInHand();
        if (handItem != null && handItem.getItemMeta() instanceof SkullMeta skullMeta) {
            OfflinePlayer itemOwner = skullMeta.getOwningPlayer();
            if (itemOwner != null && itemOwner.getName() != null) {
                deadPlayer = itemOwner.getName();
                plugin.getLogger().info("Owner from item meta: " + deadPlayer);
            } else {
                plugin.getLogger().info("Item SkullMeta has no owning player");
            }
        }

        // Fallback: try block state
        if (deadPlayer == null) {
            BlockState state = placed.getState();
            if (state instanceof Skull skull) {
                OfflinePlayer blockOwner = skull.getOwningPlayer();
                if (blockOwner != null && blockOwner.getName() != null) {
                    deadPlayer = blockOwner.getName();
                    plugin.getLogger().info("Owner from block state: " + deadPlayer);
                } else {
                    plugin.getLogger().info("Block Skull has no owning player");
                }
            } else {
                plugin.getLogger().info("Block state is not Skull: " + state.getClass().getSimpleName());
            }
        }

        if (deadPlayer == null) {
            plugin.getLogger().info("Could not determine head owner, aborting");
            return;
        }

        // Check for the golem T-pattern
        GolemPatternDetector.PatternResult pattern = GolemPatternDetector.detect(placed);
        if (pattern == null) {
            plugin.getLogger().info("No golem T-pattern detected below head");
            return;
        }

        final String finalDeadPlayer = deadPlayer;
        final String reviver = event.getPlayer().getName();

        // Don't allow self-revival
        if (finalDeadPlayer.equalsIgnoreCase(reviver)) {
            plugin.getLogger().info("Skipping self-revival: " + reviver);
            return;
        }
        final double x = placed.getX();
        final double y = placed.getY();
        final double z = placed.getZ();

        // Consume the pattern blocks
        pattern.consume();

        // Register pending revival BEFORE pardon so the join listener can catch them
        Location ritualLoc = new Location(placed.getWorld(), x + 0.5, y, z + 0.5);
        plugin.pendingRevivals.put(finalDeadPlayer.toLowerCase(), ritualLoc);

        // Unban the dead player so the bot can connect
        Bukkit.dispatchCommand(Bukkit.getConsoleSender(), "pardon " + finalDeadPlayer);

        // Broadcast
        Bukkit.broadcastMessage("\u00A76[Revival] \u00A7f" + reviver + " summoned " + finalDeadPlayer);
        plugin.getLogger().info(reviver + " summoned " + finalDeadPlayer + " at " + x + ", " + y + ", " + z);

        // Fire webhook (slight delay to let pardon propagate)
        Bukkit.getScheduler().runTaskLater(plugin, () -> {
            plugin.sendWebhook(reviver, finalDeadPlayer, x, y, z);
        }, 20L); // 1 second delay
    }

    /**
     * Catch revived players the instant they join — teleport to ritual site
     * and grant brief invulnerability so they don't die before settling in.
     */
    @EventHandler(priority = EventPriority.HIGHEST)
    public void onPlayerJoin(PlayerJoinEvent event) {
        String name = event.getPlayer().getName().toLowerCase();
        Location loc = plugin.pendingRevivals.remove(name);
        if (loc == null) return;

        plugin.getLogger().info("Revived player " + event.getPlayer().getName() + " joining — teleporting to ritual site");

        // Teleport immediately on next tick (same tick can be too early for some plugins)
        Bukkit.getScheduler().runTaskLater(plugin, () -> {
            if (!event.getPlayer().isOnline()) return;
            event.getPlayer().teleport(loc);
            event.getPlayer().setInvulnerable(true);
            plugin.getLogger().info("Teleported + invulnerable: " + event.getPlayer().getName());

            // Remove invulnerability after 10 seconds
            Bukkit.getScheduler().runTaskLater(plugin, () -> {
                if (event.getPlayer().isOnline()) {
                    event.getPlayer().setInvulnerable(false);
                    plugin.getLogger().info("Invulnerability removed: " + event.getPlayer().getName());
                }
            }, 200L); // 10 seconds
        }, 1L);
    }
}

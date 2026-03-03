package space.xandaris.revival;

import org.bukkit.Material;
import org.bukkit.block.Block;

/**
 * Detects the iron golem T-pattern with a player head on top.
 *
 * Same shape as a real iron golem (4 iron blocks + head):
 *
 *      [HEAD]         ← player head (placed block)
 * [IRON][IRON][IRON]  ← arms + torso (1 below head, center directly under head)
 *      [IRON]         ← body (2 below head)
 *
 * Checks both East-West and North-South arm orientations.
 */
public class GolemPatternDetector {

    public static class PatternResult {
        public final Block head;
        public final Block torso;    // center of arm row (directly below head)
        public final Block armLeft;
        public final Block armRight;
        public final Block body;     // below torso

        public PatternResult(Block head, Block torso, Block armLeft, Block armRight, Block body) {
            this.head = head;
            this.torso = torso;
            this.armLeft = armLeft;
            this.armRight = armRight;
            this.body = body;
        }

        /** Remove all 5 blocks (consume the pattern). */
        public void consume() {
            head.setType(Material.AIR);
            torso.setType(Material.AIR);
            armLeft.setType(Material.AIR);
            armRight.setType(Material.AIR);
            body.setType(Material.AIR);
        }
    }

    /**
     * Check if placing a player head at headBlock completes a golem T-pattern.
     * @return PatternResult if pattern matches, null otherwise.
     */
    public static PatternResult detect(Block headBlock) {
        if (headBlock.getType() != Material.PLAYER_HEAD && headBlock.getType() != Material.PLAYER_WALL_HEAD) {
            return null;
        }

        // Torso/center: iron block directly below head
        Block torso = headBlock.getRelative(0, -1, 0);
        if (torso.getType() != Material.IRON_BLOCK) return null;

        // Body: iron block below torso
        Block body = torso.getRelative(0, -1, 0);
        if (body.getType() != Material.IRON_BLOCK) return null;

        // Arms: check E-W then N-S
        PatternResult ew = checkArms(headBlock, torso, body, 1, 0);
        if (ew != null) return ew;

        return checkArms(headBlock, torso, body, 0, 1);
    }

    private static PatternResult checkArms(Block head, Block torso, Block body, int dx, int dz) {
        Block left = torso.getRelative(-dx, 0, -dz);
        Block right = torso.getRelative(dx, 0, dz);

        if (left.getType() == Material.IRON_BLOCK && right.getType() == Material.IRON_BLOCK) {
            return new PatternResult(head, torso, left, right, body);
        }
        return null;
    }
}

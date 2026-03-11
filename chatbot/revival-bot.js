import mineflayer from 'mineflayer';
import crypto from 'crypto';
import pathfinderPkg from 'mineflayer-pathfinder';
const { pathfinder, Movements, goals } = pathfinderPkg;
import { plugin as collectBlock } from 'mineflayer-collectblock';
import { plugin as pvp } from 'mineflayer-pvp';
import mcData from 'minecraft-data';

function offlineUUID(username) {
  const md5 = crypto.createHash('md5').update('OfflinePlayer:' + username).digest();
  md5[6] = (md5[6] & 0x0f) | 0x30;
  md5[8] = (md5[8] & 0x3f) | 0x80;
  const hex = md5.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

const TWO_HOURS = 2 * 60 * 60 * 1000;
const OWNER_GRACE_PERIOD = 5 * 60 * 1000;
const TICK_INTERVAL_MIN = 10000;  // 10s
const TICK_INTERVAL_MAX = 20000;  // 20s
const SURVIVAL_INTERVAL = 3000;   // 3s — fast reactive loop
const STUCK_THRESHOLD = 30000;    // 30s same position → unstuck
const MAX_LOG_ENTRIES = 15;
const MAX_TICK_HISTORY = 4;

const HOSTILE_MOBS = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch', 'phantom',
  'drowned', 'husk', 'stray', 'pillager', 'vindicator', 'ravager', 'blaze',
  'ghast', 'wither_skeleton', 'piglin_brute', 'cave_spider', 'slime',
  'magma_cube', 'warden', 'breeze',
]);

const UNDERGROUND_BLOCKS = {
  ancient_debris:    { y: 15,   dimension: 'the_nether' },
  diamond_ore:       { y: -59,  dimension: 'overworld' },
  deepslate_diamond_ore: { y: -59, dimension: 'overworld' },
  emerald_ore:       { y: -16,  dimension: 'overworld' },
  deepslate_emerald_ore: { y: -16, dimension: 'overworld' },
  gold_ore:          { y: -16,  dimension: 'overworld' },
  deepslate_gold_ore: { y: -16, dimension: 'overworld' },
  lapis_ore:         { y: 0,    dimension: 'overworld' },
  deepslate_lapis_ore: { y: 0,  dimension: 'overworld' },
  redstone_ore:      { y: -59,  dimension: 'overworld' },
  deepslate_redstone_ore: { y: -59, dimension: 'overworld' },
  nether_gold_ore:   { y: 15,   dimension: 'the_nether' },
  nether_quartz_ore: { y: 15,   dimension: 'the_nether' },
};

const PICKAXE_TIERS = ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'golden_pickaxe', 'stone_pickaxe', 'wooden_pickaxe'];

const FOOD_ITEMS = new Set([
  'bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
  'cooked_rabbit', 'cooked_salmon', 'cooked_cod', 'baked_potato', 'golden_apple',
  'enchanted_golden_apple', 'apple', 'carrot', 'melon_slice', 'sweet_berries',
  'mushroom_stew', 'rabbit_stew', 'beetroot_soup', 'pumpkin_pie', 'cookie',
  'dried_kelp', 'beetroot', 'golden_carrot',
]);

export class RevivalBot {
  constructor({ deadPlayer, reviver, pos, profile, conversationManager, config = {} }) {
    this.username = deadPlayer;
    this.owner = reviver;
    this.spawnPos = pos;
    this.profile = profile;
    this.cm = conversationManager;
    this.config = config;

    this.bot = null;
    this.connected = false;
    this.state = 'idle';
    this.despawned = false;
    this.suspended = false;           // true when owner offline — bot disconnected but not despawned
    this._suspendPos = null;          // saved position when suspended
    this.debugChat = false;           // toggle: show LLM thinking + tool calls in-game

    // ── Agent memory ──────────────────────────────────────────────────
    this.objectives = [];             // current goals: [{text, priority, timestamp}]
    this.actionLog = [];              // recent events: [{type, detail, timestamp}]
    this.pendingMessages = [];        // incoming chat to process on next tick
    this.revivalInfo = {
      reviver,
      location: pos,
      time: Date.now()
    };

    // ── Tick history for LLM context ──────────────────────────────────
    this.tickHistory = [];            // compact summaries of recent ticks

    // ── Lifecycle ─────────────────────────────────────────────────────
    this._despawnTimer = null;
    this._ownerGraceTimer = null;
    this._tickTimer = null;
    this._survivalTimer = null;
    this._ticking = false;            // prevent overlapping ticks
    this._abortIdleTick = false;      // set true when owner messages during a tick
    this._onDespawn = null;
    this._onTick = null;              // callback: (rBot) => Promise — set by index.js

    // ── Survival loop state ─────────────────────────────────────────
    this._lastPos = null;             // {x, y, z, time} for stuck detection
    this._lastEatTime = 0;            // cooldown for auto-eat

    // Minecraft data (set after login)
    this._mcData = null;
    this._movements = null;
  }

  // ── Agent memory helpers ──────────────────────────────────────────

  log(type, detail) {
    this.actionLog.push({ type, detail, timestamp: Date.now() });
    if (this.actionLog.length > MAX_LOG_ENTRIES) this.actionLog.shift();
  }

  addObjective(text, priority = 'normal') {
    // Don't add duplicates (fuzzy — check if existing objective substantially overlaps)
    const textLower = text.toLowerCase();
    if (this.objectives.some(o => {
      const oLower = o.text.toLowerCase();
      return oLower === textLower || oLower.includes(textLower) || textLower.includes(oLower);
    })) return;
    // Cap at 3 objectives to prevent objective spam
    if (this.objectives.length >= 3) {
      this.objectives.shift(); // drop oldest
    }
    this.objectives.push({ text, priority, timestamp: Date.now() });
    this.log('objective_added', text);
    console.log(`[Revival] ${this.username} objective+: ${text}`);
  }

  completeObjective(text) {
    const idx = this.objectives.findIndex(o => o.text.toLowerCase().includes(text.toLowerCase()));
    if (idx !== -1) {
      const removed = this.objectives.splice(idx, 1)[0];
      this.log('objective_completed', removed.text);
      console.log(`[Revival] ${this.username} objective✓: ${removed.text}`);
    }
  }

  clearObjectives() {
    this.objectives = [];
    this.log('objectives_cleared', 'all objectives cleared');
  }

  recordTickExchange(summary) {
    this.tickHistory.push(summary);
    if (this.tickHistory.length > MAX_TICK_HISTORY) this.tickHistory.shift();
  }

  queueMessage(sender, message) {
    this.pendingMessages.push({ sender, message, timestamp: Date.now() });
    // Instant interrupt: if owner says "stop"/"cancel" while a long action is running, break it immediately
    const msgLower = message.toLowerCase().trim();
    if (sender === this.owner && (msgLower.includes('stop') || msgLower.includes('cancel'))) {
      if (this.state !== 'idle') {
        console.log(`[Revival] ${this.username} instant interrupt from ${sender}: "${message}"`);
        this.state = 'idle';
        this.bot?.pathfinder?.stop();
        try { this.bot?.pvp?.stop(); } catch {}
      }
    }
    // Owner messages get near-instant ticks; others keep normal bump
    const isOwner = sender === this.owner;
    const bumpDelay = isOwner ? (100 + Math.random() * 200) : (500 + Math.random() * 1000);

    if (!this._ticking && this.connected && !this.despawned && this._loopRunning) {
      this._scheduleNextTick(bumpDelay);
    }
    // If currently ticking and owner sent a message, flag to shorten next idle delay
    if (this._ticking && isOwner) {
      this._abortIdleTick = true;
    }
  }

  // ── World context for LLM ─────────────────────────────────────────

  getWorldContext() {
    if (!this.bot?.entity) return {};

    const pos = this.bot.entity.position;
    const health = this.bot.health;
    const food = this.bot.food;
    const time = this.bot.time?.timeOfDay;
    const isDay = time != null ? (time < 13000 || time > 23000) : null;

    // Inventory summary
    const inventory = this.bot.inventory.items().map(i => `${i.name}x${i.count}`);

    // Owner proximity
    const ownerEntity = this.bot.players[this.owner]?.entity;
    const ownerDist = ownerEntity
      ? Math.round(pos.distanceTo(ownerEntity.position))
      : null;

    // Nearby entities (all living entities + item drops within 24 blocks)
    const nearby = [];
    for (const entity of Object.values(this.bot.entities)) {
      if (!entity || entity === this.bot.entity) continue;
      const dist = pos.distanceTo(entity.position);
      if (dist > 24) continue;
      if (entity.type === 'player') {
        nearby.push(`player:${entity.username}(${Math.round(dist)}m)`);
      } else if (entity.name === 'item') {
        // Dropped item — show what it is
        const droppedItem = entity.getDroppedItem?.();
        const itemName = droppedItem?.name || 'unknown';
        nearby.push(`dropped:${itemName}(${Math.round(dist)}m)`);
      } else if (entity.name) {
        // Include all named entities: mobs, animals, hostiles, etc.
        nearby.push(`${entity.name}(${Math.round(dist)}m)`);
      }
    }

    // Dimension: "minecraft:overworld" → "overworld", "minecraft:the_nether" → "the_nether", etc.
    const rawDim = this.bot.game?.dimension || 'unknown';
    const dimension = rawDim.replace(/^minecraft:/, '');

    // Nearby utility blocks (crafting table, furnace, chest, etc.)
    const utilityBlocks = [];
    const UTILITY_BLOCK_IDS = ['crafting_table', 'furnace', 'chest', 'anvil', 'enchanting_table', 'smithing_table', 'blast_furnace', 'smoker',
      'red_bed', 'white_bed', 'blue_bed', 'green_bed', 'black_bed', 'yellow_bed', 'orange_bed', 'cyan_bed', 'purple_bed', 'pink_bed', 'brown_bed', 'gray_bed', 'light_gray_bed', 'light_blue_bed', 'lime_bed', 'magenta_bed'];
    for (const name of UTILITY_BLOCK_IDS) {
      const blockId = this._mcData?.blocksByName[name]?.id;
      if (blockId == null) continue;
      const found = this.bot.findBlock({ matching: blockId, maxDistance: 8 });
      if (found) {
        const dist = Math.round(pos.distanceTo(found.position));
        utilityBlocks.push(`${name}(${dist}m)`);
      }
    }

    return {
      position: `${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)}`,
      health: Math.round(health),
      food: Math.round(food),
      timeOfDay: isDay === null ? 'unknown' : (isDay ? 'day' : 'night'),
      dimension,
      inventory: inventory.length > 0 ? inventory.join(', ') : 'empty',
      ownerDistance: ownerDist !== null ? `${ownerDist}m` : 'not visible',
      nearbyEntities: nearby.length > 0 ? nearby.slice(0, 15).join(', ') : 'none',
      nearbyBlocks: utilityBlocks.length > 0 ? utilityBlocks.join(', ') : 'none',
      currentState: this.state
    };
  }

  // ── Agent loop ────────────────────────────────────────────────────

  startAgentLoop() {
    if (this._loopRunning) return;
    this._loopRunning = true;
    this._scheduleNextTick(3000); // first tick after 3s
    this._startSurvivalLoop();
  }

  // ── Survival loop (fast, no LLM) ─────────────────────────────────

  _startSurvivalLoop() {
    if (this._survivalTimer) return;
    this._survivalTimer = setInterval(() => this._survivalTick(), SURVIVAL_INTERVAL);
  }

  _survivalTick() {
    if (!this.connected || this.despawned || !this.bot?.entity) return;

    try {
      this._survivalEat();
      this._survivalDefend();
      this._survivalBreathe();
      this._survivalUnstuck();
    } catch (err) {
      console.error(`[Survival] ${this.username} error: ${err.message}`);
    }
  }

  // Auto-eat when food is low
  _survivalEat() {
    if (this.bot.food >= 14) return;
    if (Date.now() - this._lastEatTime < 10000) return; // 10s cooldown
    // Don't interrupt active combat or crafting (window click conflicts)
    if (this.state === 'attacking' || this.state === 'crafting' || this.state === 'smelting') return;

    const food = this.bot.inventory.items().find(i => FOOD_ITEMS.has(i.name));
    if (!food) return;

    this._lastEatTime = Date.now();
    console.log(`[Survival] ${this.username} auto-eating ${food.name} (food=${this.bot.food})`);
    this.log('survival', `Auto-ate ${food.name} (hunger=${this.bot.food})`);

    this.bot.equip(food, 'hand')
      .then(() => this.bot.consume())
      .catch(() => {}); // silent fail — next tick will retry
  }

  // Fight back when hit by hostiles
  _survivalDefend() {
    // Skip during mining/checking chests — those are interruptible by other means
    if (this.state === 'mining' || this.state === 'checking_chests') return;

    // Check if a hostile mob is attacking us (within 5 blocks and targeting us)
    const hostile = this.bot.nearestEntity(e => {
      if (!e || !e.name) return false;
      const dist = e.position.distanceTo(this.bot.entity.position);
      if (dist > 5) return false;
      return HOSTILE_MOBS.has(e.name.toLowerCase());
    });

    if (!hostile) return;

    // Only fight back if we're actually taking damage (health changed recently)
    // or if the mob is very close (within 3 blocks)
    const dist = hostile.position.distanceTo(this.bot.entity.position);
    if (dist > 3) return;

    console.log(`[Survival] ${this.username} defending against ${hostile.name} (${Math.round(dist)}m)`);
    this.log('survival', `Auto-defending against ${hostile.name}`);

    // Equip best weapon first
    const weapons = this.bot.inventory.items().filter(i =>
      i.name.includes('sword') || i.name.includes('axe')
    );
    if (weapons.length > 0) {
      // Prefer swords over axes, higher tier first
      const best = weapons.sort((a, b) => {
        const tierOrder = ['netherite', 'diamond', 'iron', 'stone', 'wooden', 'golden'];
        const aTier = tierOrder.findIndex(t => a.name.includes(t));
        const bTier = tierOrder.findIndex(t => b.name.includes(t));
        const aSword = a.name.includes('sword') ? 0 : 1;
        const bSword = b.name.includes('sword') ? 0 : 1;
        if (aSword !== bSword) return aSword - bSword;
        return aTier - bTier;
      })[0];
      this.bot.equip(best, 'hand').catch(() => {});
    }

    try {
      this.bot.pvp.attack(hostile);
    } catch {}
  }

  // Swim up when underwater
  _survivalBreathe() {
    if (!this.bot.entity) return;
    const pos = this.bot.entity.position;
    const block = this.bot.blockAt(pos.offset(0, 1, 0)); // block at head level
    if (!block) return;

    const isUnderwater = block.name === 'water';
    if (!isUnderwater) return;

    // Only act if not already moving somewhere intentionally
    if (this.state === 'mining' || this.state === 'following') return;

    console.log(`[Survival] ${this.username} underwater — swimming up`);
    this.log('survival', 'Swimming up (underwater)');

    // Set control state to jump (swim up)
    this.bot.setControlState('jump', true);
    setTimeout(() => {
      try { this.bot.setControlState('jump', false); } catch {}
    }, 2000);
  }

  // Detect if stuck and try to unstick
  _survivalUnstuck() {
    if (this.state === 'idle' || this.state === 'guarding') return; // not stuck if intentionally still
    if (!this.bot.entity) return;

    const pos = this.bot.entity.position;
    const now = Date.now();

    if (!this._lastPos) {
      this._lastPos = { x: pos.x, y: pos.y, z: pos.z, time: now };
      return;
    }

    const dx = Math.abs(pos.x - this._lastPos.x);
    const dy = Math.abs(pos.y - this._lastPos.y);
    const dz = Math.abs(pos.z - this._lastPos.z);
    const moved = dx + dy + dz;

    if (moved > 1.5) {
      // Moving fine — update position
      this._lastPos = { x: pos.x, y: pos.y, z: pos.z, time: now };
      return;
    }

    // Hasn't moved significantly — check if stuck long enough
    const stuckTime = now - this._lastPos.time;
    if (stuckTime < STUCK_THRESHOLD) return;

    // Smelting and crafting are stationary — not stuck
    if (this.state === 'smelting' || this.state === 'crafting') {
      this._lastPos.time = now;
      return;
    }

    // Following near the owner is correct — not stuck
    if (this.state === 'following') {
      const ownerEnt = this.bot.players[this.owner]?.entity;
      if (ownerEnt && this.bot.entity.position.distanceTo(ownerEnt.position) < 6) {
        this._lastPos.time = now; // reset timer — we're just close to owner
        return;
      }
    }

    console.log(`[Survival] ${this.username} stuck for ${Math.round(stuckTime / 1000)}s in state "${this.state}" — resetting`);
    this.log('survival', `Unstuck: was "${this.state}" for ${Math.round(stuckTime / 1000)}s, resetting to idle`);

    // Reset state
    this.state = 'idle';
    this.bot.pathfinder?.stop();
    try { this.bot.pvp?.stop(); } catch {}

    // Try jumping to break free
    this.bot.setControlState('jump', true);
    setTimeout(() => {
      try { this.bot.setControlState('jump', false); } catch {}
    }, 500);

    // Reset stuck tracker
    this._lastPos = { x: pos.x, y: pos.y, z: pos.z, time: now };
  }

  _scheduleNextTick(delay) {
    if (this.despawned) return;
    if (delay == null) {
      delay = TICK_INTERVAL_MIN + Math.random() * (TICK_INTERVAL_MAX - TICK_INTERVAL_MIN);
    }
    if (this._tickTimer) clearTimeout(this._tickTimer);
    this._tickTimer = setTimeout(() => this._runTick(), delay);
  }

  async _runTick() {
    if (this._ticking || !this.connected || this.despawned) {
      this._scheduleNextTick();
      return;
    }
    this._ticking = true;
    this._abortIdleTick = false;
    try {
      if (this._onTick) await this._onTick(this);
    } catch (err) {
      console.error(`[Revival Tick] ${this.username} error: ${err.message}`);
    } finally {
      this._ticking = false;
      // If owner sent a message during this tick, schedule fast follow-up
      if (this._abortIdleTick) {
        this._abortIdleTick = false;
        this._scheduleNextTick(100 + Math.random() * 200);
      } else {
        this._scheduleNextTick();
      }
    }
  }

  // ── Connection ────────────────────────────────────────────────────

  connect() {
    if (this.despawned) return;
    console.log(`[Revival] ${this.username} connecting (revived by ${this.owner})...`);

    const uuid = offlineUUID(this.username);
    this.bot = mineflayer.createBot({
      host: this.config.host || 'localhost',
      port: this.config.port || 25565,
      username: this.username,
      version: false,
      auth: 'offline',
      hideErrors: false,
      fakeHost: `localhost\x00127.0.0.1\x00${uuid}`
    });

    this.bot.on('login', () => {
      console.log(`[Revival] ${this.username} connected!`);
      this.connected = true;
      this.log('connected', `Revived by ${this.owner}`);

      // Load minecraft data and plugins
      this._mcData = mcData(this.bot.version);
      this.bot.loadPlugin(pathfinder);
      this.bot.loadPlugin(collectBlock);
      this.bot.loadPlugin(pvp);

      this._movements = new Movements(this.bot);
      this._movements.canDig = true;
      this._movements.allow1by1towers = true;
      this.bot.pathfinder.setMovements(this._movements);

      // 2-hour despawn timer (only set once — not on resume from suspend)
      if (!this._despawnTimer) {
        this._despawnTimer = setTimeout(() => {
          console.log(`[Revival] ${this.username} timed out (2 hours)`);
          this.despawn('timeout');
        }, TWO_HOURS);
      }

      // Fake ping
      const client = this.bot._client;
      const basePing = 50 + Math.random() * 60;
      const keepAlive = client.listeners('keep_alive')?.[0];
      if (keepAlive) {
        client.removeListener('keep_alive', keepAlive);
        client.on('keep_alive', (packet) => {
          setTimeout(() => {
            client.write('keep_alive', { keepAliveId: packet.keepAliveId });
          }, basePing + (Math.random() - 0.5) * 2);
        });
      }

      // Start the agent loop
      this.startAgentLoop();
    });

    // Ignore death events in the first 5s — mineflayer can fire 'death' on spawn
    // if the player's last state was dead (health=0)
    const connectTime = Date.now();
    this.bot.on('death', () => {
      if (Date.now() - connectTime < 5000) {
        console.log(`[Revival] ${this.username} death event within 5s of connect — ignoring (spawn artifact)`);
        return;
      }
      console.log(`[Revival] ${this.username} died in-game — permanent despawn`);
      this.log('died', 'Died in-game');
      this.despawn('death');
    });

    this.bot.on('playerLeft', (player) => {
      if (player.username === this.owner) {
        console.log(`[Revival] Owner ${this.owner} disconnected — ${OWNER_GRACE_PERIOD / 60000}min grace`);
        this.log('owner_left', `${this.owner} disconnected`);
        this._ownerGraceTimer = setTimeout(() => {
          console.log(`[Revival] Owner ${this.owner} didn't return — suspending ${this.username}`);
          this.suspend();
        }, OWNER_GRACE_PERIOD);
      }
    });

    this.bot.on('playerJoined', (player) => {
      if (player.username === this.owner && this._ownerGraceTimer) {
        console.log(`[Revival] Owner ${this.owner} returned — cancelling grace timer`);
        clearTimeout(this._ownerGraceTimer);
        this._ownerGraceTimer = null;
        this.log('owner_returned', `${this.owner} reconnected`);
      }
    });

    this.bot.on('kicked', (reason) => {
      console.log(`[Revival] ${this.username} kicked — despawning`);
      this.connected = false;
      this.despawn('kicked');
    });

    this.bot.on('error', (err) => {
      console.error(`[Revival] ${this.username} error: ${err.message}`);
    });

    this.bot.on('end', () => {
      console.log(`[Revival] ${this.username} disconnected`);
      this.connected = false;
      this.tickHistory = [];
      if (!this.despawned && !this.suspended) {
        // Auto-reconnect on unexpected disconnect (protocol errors, etc.)
        console.log(`[Revival] ${this.username} unexpected disconnect — reconnecting in 5s`);
        this.log('reconnecting', 'Unexpected disconnect, auto-reconnecting');
        if (this._tickTimer) { clearTimeout(this._tickTimer); this._tickTimer = null; }
        if (this._survivalTimer) { clearInterval(this._survivalTimer); this._survivalTimer = null; }
        this._loopRunning = false;
        setTimeout(() => {
          if (!this.despawned) this.connect();
        }, 5000);
      }
    });
  }

  suspend() {
    if (this.despawned || this.suspended) return;
    this.suspended = true;

    // Save current position before disconnecting
    if (this.bot?.entity?.position) {
      const p = this.bot.entity.position;
      this._suspendPos = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
    } else {
      this._suspendPos = this.spawnPos;
    }

    // Stop all loops (but keep the 2-hour despawn timer running)
    if (this._ownerGraceTimer) { clearTimeout(this._ownerGraceTimer); this._ownerGraceTimer = null; }
    if (this._tickTimer) { clearTimeout(this._tickTimer); this._tickTimer = null; }
    if (this._survivalTimer) { clearInterval(this._survivalTimer); this._survivalTimer = null; }

    try {
      if (this.bot) {
        this.bot.pathfinder?.stop();
        this.bot.pvp?.stop();
      }
    } catch { /* already gone */ }

    if (this.bot && this.connected) {
      try { this.bot.end(); } catch { /* already gone */ }
    }
    this.connected = false;
    this.state = 'idle';

    console.log(`[Revival] ${this.username} suspended at ${this._suspendPos.x},${this._suspendPos.y},${this._suspendPos.z} — waiting for ${this.owner}`);
    this.log('suspended', `Suspended at ${this._suspendPos.x},${this._suspendPos.y},${this._suspendPos.z}`);
    if (this._onSuspend) this._onSuspend(this.username);
  }

  resume() {
    if (this.despawned || !this.suspended) return;
    this.suspended = false;
    this.tickHistory = [];
    console.log(`[Revival] ${this.username} resuming — owner ${this.owner} is back`);
    this.log('resumed', `Owner ${this.owner} returned`);
    this.connect();
  }

  despawn(reason = 'unknown') {
    if (this.despawned) return;
    this.despawned = true;
    this.state = 'idle';

    if (this._despawnTimer) clearTimeout(this._despawnTimer);
    if (this._ownerGraceTimer) clearTimeout(this._ownerGraceTimer);
    if (this._tickTimer) clearTimeout(this._tickTimer);
    if (this._survivalTimer) clearInterval(this._survivalTimer);

    try {
      if (this.bot) {
        this.bot.pathfinder?.stop();
        this.bot.pvp?.stop();
      }
    } catch { /* already gone */ }

    if (this.bot && this.connected) {
      try { this.bot.end(); } catch { /* already gone */ }
    }
    this.connected = false;

    console.log(`[Revival] ${this.username} despawned (${reason})`);
    if (this._onDespawn) this._onDespawn(this.username, reason);
  }

  // ── Chat ───────────────────────────────────────────────────────────

  async chat(message) {
    if (!this.connected || !message) return;
    const lines = message.split('\n').map(l => l.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, 250 + Math.random() * 550));
      this.bot.chat(lines[i]);
    }
    this.cm.addMessage(this.username, message, { isBot: true });
    this.cm.recordBotMessage();
    this.log('chat', message);
  }

  // ── Action Implementations ────────────────────────────────────────

  _cmdFollowPlayer(playerName) {
    this.state = 'following';
    const playerEntity = this.bot.players[playerName]?.entity;
    if (!playerEntity) {
      this.log('action_failed', `Can't see ${playerName} to follow`);
      return;
    }
    this.log('action', `Following ${playerName}`);

    const followLoop = () => {
      if (this.state !== 'following' || !this.connected || this.despawned) return;
      const target = this.bot.players[playerName]?.entity;
      if (target) {
        this.bot.pathfinder.setGoal(new goals.GoalFollow(target, 3), true);
      }
      setTimeout(followLoop, 2000);
    };
    followLoop();
  }

  _cmdCome() {
    const ownerEntity = this.bot.players[this.owner]?.entity;
    if (!ownerEntity) {
      this.log('action_failed', `Can't see ${this.owner}`);
      return;
    }
    this.state = 'idle';
    this.log('action', `Going to ${this.owner}`);
    this.bot.pathfinder.setGoal(
      new goals.GoalNear(ownerEntity.position.x, ownerEntity.position.y, ownerEntity.position.z, 2)
    );
  }

  _cmdStop() {
    this.state = 'idle';
    this.bot.pathfinder.stop();
    try { this.bot.pvp.stop(); } catch {}
    this.log('action', 'Stopped all actions');
  }

  _cmdGuard() {
    this.state = 'guarding';
    const guardPos = this.bot.entity.position.clone();
    this.log('action', `Guarding at ${Math.round(guardPos.x)}, ${Math.round(guardPos.y)}, ${Math.round(guardPos.z)}`);

    const guardLoop = () => {
      if (this.state !== 'guarding' || !this.connected || this.despawned) return;
      const hostile = this.bot.nearestEntity(e => {
        if (!e.type || e.type !== 'mob') return false;
        const dist = e.position.distanceTo(this.bot.entity.position);
        if (dist > 16) return false;
        const hostileTypes = ['zombie', 'skeleton', 'creeper', 'spider', 'enderman',
          'witch', 'phantom', 'drowned', 'husk', 'stray', 'pillager', 'vindicator',
          'ravager', 'blaze', 'ghast', 'wither_skeleton', 'piglin_brute'];
        return hostileTypes.some(h => (e.name || '').toLowerCase().includes(h));
      });
      if (hostile) {
        this.bot.pvp.attack(hostile);
      } else {
        const dist = this.bot.entity.position.distanceTo(guardPos);
        if (dist > 5) {
          this.bot.pathfinder.setGoal(new goals.GoalNear(guardPos.x, guardPos.y, guardPos.z, 2));
        }
      }
      setTimeout(guardLoop, 1500);
    };
    guardLoop();
  }

  _cmdDismiss() {
    this.log('action', `Dismissed by ${this.owner}`);
    this.despawn('dismissed');
  }

  async _cmdMine(blockName, count) {
    // Fix common LLM block name mistakes
    const MINE_ALIASES = {
      log: 'oak_log', logs: 'oak_log', wood: 'oak_log',
      plank: 'oak_planks', planks: 'oak_planks',
      cobble: 'stone', cobblestone: 'stone', stone: 'stone',
      iron: 'iron_ore', gold: 'gold_ore', diamond: 'diamond_ore',
      coal: 'coal_ore', copper: 'copper_ore', lapis: 'lapis_ore',
      redstone: 'redstone_ore', emerald: 'emerald_ore',
      dirt: 'dirt', sand: 'sand', gravel: 'gravel', clay: 'clay',
    };
    const resolvedBlock = MINE_ALIASES[blockName] || blockName;
    if (resolvedBlock !== blockName) {
      this.log('action', `Resolved mine name: ${blockName} → ${resolvedBlock}`);
      blockName = resolvedBlock;
    }

    this.state = 'mining';
    this.log('action', `Mining up to ${count}x ${blockName}`);

    let blockType = this._mcData?.blocksByName[blockName];
    if (!blockType) {
      this.state = 'idle';
      this.log('action_failed', `"${blockName}" is not a valid block name`);
      return;
    }

    let mined = 0;
    let failReason = null;
    let roamed = false;

    // Auto-equip best tool for the block type
    const bestTool = this.bot.pathfinder?.bestHarvestTool(this.bot.blockAt(this.bot.entity.position.offset(0, -1, 0)) || blockType)
      || this.bot.inventory.items().find(i => PICKAXE_TIERS.includes(i.name));
    if (bestTool) try { await this.bot.equip(bestTool, 'hand'); } catch {}

    const skippedPositions = new Set();
    while (mined < count && this.state === 'mining' && this.connected && !this.despawned) {
      // Find the nearest matching block, excluding already-skipped ones
      const block = this.bot.findBlock({
        matching: blockType.id,
        maxDistance: 64,
        useExtraInfo: (b) => !skippedPositions.has(b.position.toString()),
      });
      if (!block) {
        // Try strip-mining if this is an underground block
        const ugInfo = UNDERGROUND_BLOCKS[blockName];
        if (ugInfo) {
          const rawDim = this.bot.game?.dimension || '';
          const currentDim = rawDim.replace(/^minecraft:/, '');
          if (currentDim !== ugInfo.dimension) {
            failReason = `${blockName} spawns in the ${ugInfo.dimension}, but you're in the ${currentDim}`;
            break;
          }
          const stripResult = await this._stripMine(blockName, blockType.id, count - mined, ugInfo.y);
          mined += stripResult.found;
          if (stripResult.found === 0) {
            failReason = stripResult.reason || `strip-mined but found no ${blockName}`;
          }
          break; // strip-mine handles its own loop
        }

        // For log blocks, try all wood variants before giving up
        if (blockName.endsWith('_log')) {
          const LOG_VARIANTS = ['oak_log', 'birch_log', 'spruce_log', 'dark_oak_log', 'jungle_log', 'acacia_log', 'mangrove_log', 'cherry_log'];
          let found = false;
          for (const variant of LOG_VARIANTS) {
            if (variant === blockName) continue;
            const variantType = this._mcData?.blocksByName[variant];
            if (!variantType) continue;
            const variantBlock = this.bot.findBlock({ matching: variantType.id, maxDistance: 64 });
            if (variantBlock) {
              this.log('action', `No ${blockName} nearby, switching to ${variant}`);
              blockName = variant;
              blockType = variantType;
              found = true;
              break;
            }
          }
          if (found) continue; // restart the while loop with new block type
        }

        // Roam-and-retry for surface blocks — walk ~100 blocks and look again
        if (!roamed) {
          roamed = true;
          this.log('action', `No ${blockName} nearby — roaming to search further`);
          const angle = Math.random() * 2 * Math.PI;
          const roamDist = 80 + Math.random() * 40;
          const roamX = Math.round(this.bot.entity.position.x + Math.cos(angle) * roamDist);
          const roamZ = Math.round(this.bot.entity.position.z + Math.sin(angle) * roamDist);
          const roamY = Math.round(this.bot.entity.position.y);
          this.bot.pathfinder.setGoal(new goals.GoalNear(roamX, roamY, roamZ, 8));
          await new Promise(resolve => {
            const timeout = setTimeout(() => { this.bot.pathfinder.setGoal(null); resolve(); }, 20000);
            this.bot.once('goal_reached', () => { clearTimeout(timeout); resolve(); });
          });
          continue; // retry finding block after roam
        }

        failReason = `no ${blockName} found nearby (even after roaming)`;
        break;
      }
      try {
        // Disable canDig for underground blocks so pathfinder won't mine through stone
        const prevCanDig = this._movements.canDig;
        if (UNDERGROUND_BLOCKS[blockName]) {
          this._movements.canDig = false;
          this.bot.pathfinder.setMovements(this._movements);
        }

        // Race collect against a 15s timeout and state-change abort
        const restoreMovements = () => {
          this._movements.canDig = prevCanDig;
          this.bot.pathfinder.setMovements(this._movements);
        };
        await Promise.race([
          this.bot.collectBlock.collect(block).finally(restoreMovements),
          new Promise((_, reject) => {
            const check = setInterval(() => {
              if (this.state !== 'mining') {
                clearInterval(check);
                this.bot.pathfinder?.stop();
                reject(new Error('interrupted'));
              }
            }, 250);
            setTimeout(() => { clearInterval(check); reject(new Error('collect timeout')); }, 30000);
          })
        ]);
        mined++;
      } catch (err) {
        // If pathfinding failed, skip this block and try the next one
        if (err.message === 'collect timeout' || err.message.includes('NoPath')) {
          console.log(`[Mine] ${this.username}: skipping unreachable ${blockName} at ${block.position}`);
          skippedPositions.add(block.position.toString());
          continue;
        }
        failReason = err.message;
        break;
      }
    }

    if (this.state === 'mining') this.state = 'idle';

    if (mined === 0 && failReason) {
      this.log('action_failed', `Mine ${blockName}: ${failReason}`);
    } else if (mined < count) {
      this.log('action_partial', `Mined ${mined}/${count} ${blockName}: ${failReason || 'interrupted'}`);
    } else {
      this.log('action_success', `Mined ${mined} ${blockName}`);
    }
  }

  async _stripMine(blockName, blockTypeId, targetCount, optimalY) {
    this.log('action', `Strip-mining for ${blockName} at Y=${optimalY}`);
    console.log(`[StripMine] ${this.username} mining ${blockName} → Y=${optimalY}`);

    // Check for a pickaxe
    const pickaxe = this.bot.inventory.items().find(i => PICKAXE_TIERS.includes(i.name));
    if (!pickaxe) {
      this.log('action_failed', `Strip-mine ${blockName}: no pickaxe in inventory`);
      return { found: 0, reason: 'no pickaxe in inventory' };
    }
    try { await this.bot.equip(pickaxe, 'hand'); } catch {}

    // Navigate to optimal Y level
    const pos = this.bot.entity.position;
    const targetPos = pos.offset(0, optimalY - Math.round(pos.y), 0);
    try {
      this.bot.pathfinder.setGoal(new goals.GoalNear(targetPos.x, targetPos.y, targetPos.z, 3));
      await Promise.race([
        new Promise(resolve => this.bot.once('goal_reached', resolve)),
        new Promise((_, reject) => setTimeout(() => reject(new Error('nav timeout')), 20000)),
        new Promise((_, reject) => {
          const check = setInterval(() => {
            if (this.state !== 'mining') { clearInterval(check); reject(new Error('interrupted')); }
          }, 500);
          setTimeout(() => clearInterval(check), 20000);
        })
      ]);
    } catch (err) {
      if (err.message === 'interrupted') return { found: 0, reason: 'interrupted' };
      // Navigation failed — try to mine from current position anyway
      console.log(`[StripMine] ${this.username} nav failed (${err.message}), mining from current pos`);
    }

    // Pick random cardinal direction
    const dirs = [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }];
    const dir = dirs[Math.floor(Math.random() * dirs.length)];

    let found = 0;
    let blocksDug = 0;
    const startTime = Date.now();
    const MAX_BLOCKS = 80;
    const TIMEOUT = 60000;

    while (found < targetCount && blocksDug < MAX_BLOCKS && this.state === 'mining'
           && this.connected && !this.despawned && (Date.now() - startTime) < TIMEOUT) {
      const botPos = this.bot.entity.position;
      // Dig a 1x2 tunnel: foot level and head level
      const footPos = botPos.offset(dir.x, 0, dir.z);
      const headPos = botPos.offset(dir.x, 1, dir.z);

      for (const digPos of [footPos, headPos]) {
        if (this.state !== 'mining') break;
        const blk = this.bot.blockAt(digPos);
        if (!blk || blk.name === 'air' || blk.name === 'cave_air' || blk.name === 'void_air') continue;

        // Check if this is our target ore
        if (blk.type === blockTypeId) {
          found++;
          console.log(`[StripMine] ${this.username} found ${blockName}! (${found}/${targetCount})`);
        }

        try {
          await this.bot.dig(blk);
          blocksDug++;
        } catch {
          // Skip undiggable blocks (bedrock, etc.)
        }
      }

      // Also check blocks adjacent to the tunnel (ore veins beside the path)
      for (const offset of [{ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }]) {
        for (const side of [
          { x: dir.z, z: -dir.x },  // left
          { x: -dir.z, z: dir.x },  // right
          { x: 0, z: 0, y: -1 },    // below feet
          { x: 0, z: 0, y: 2 },     // above head
        ]) {
          if (this.state !== 'mining' || found >= targetCount) break;
          const checkPos = botPos.offset(dir.x + side.x, (side.y ?? offset.y), dir.z + side.z);
          const sideBlk = this.bot.blockAt(checkPos);
          if (sideBlk && sideBlk.type === blockTypeId) {
            found++;
            console.log(`[StripMine] ${this.username} found ${blockName} in wall! (${found}/${targetCount})`);
            try { await this.bot.dig(sideBlk); blocksDug++; } catch {}
          }
        }
      }

      // Step forward
      try {
        this.bot.setControlState('forward', true);
        await new Promise(r => setTimeout(r, 300));
        this.bot.setControlState('forward', false);
      } catch {}
    }

    try { this.bot.setControlState('forward', false); } catch {}
    const reason = found >= targetCount ? null
      : (Date.now() - startTime >= TIMEOUT) ? 'strip-mine timeout'
      : blocksDug >= MAX_BLOCKS ? 'reached max tunnel length'
      : this.state !== 'mining' ? 'interrupted'
      : `strip-mined ${blocksDug} blocks but found no ${blockName}`;

    if (found > 0) {
      this.log('action_success', `Strip-mined ${found} ${blockName} (dug ${blocksDug} blocks)`);
    }
    return { found, reason };
  }

  async _cmdAttack(mobName, count = 1) {
    this.state = 'attacking';
    this.log('action', `Attacking ${count}x ${mobName}`);

    const nameLower = mobName.toLowerCase();
    let killed = 0;

    for (let i = 0; i < count && this.state === 'attacking' && this.connected && !this.despawned; i++) {
      const target = this.bot.nearestEntity(e => {
        if (!e) return false;
        if (e.type === 'player') return (e.username || '').toLowerCase().includes(nameLower);
        return (e.name || '').toLowerCase().includes(nameLower);
      });

      if (!target) {
        if (killed === 0) {
          this.log('action_failed', `No ${mobName} found nearby`);
        }
        break;
      }

      console.log(`[Attack] ${this.username} targeting ${target.name || target.username} (type=${target.type}, dist=${Math.round(target.position.distanceTo(this.bot.entity.position))})`);

      try {
        this.bot.pvp.attack(target);
        // Wait for pvp to finish (mob dies or goes out of range)
        await new Promise((resolve) => {
          const onStop = () => { resolve(); };
          if (typeof this.bot.pvp.once === 'function') {
            this.bot.pvp.once('stoppedAttacking', onStop);
          } else if (typeof this.bot.pvp.on === 'function') {
            const handler = () => { onStop(); this.bot.pvp.removeListener?.('stoppedAttacking', handler); };
            this.bot.pvp.on('stoppedAttacking', handler);
          } else {
            setTimeout(onStop, 10000);
          }
          // Safety timeout
          setTimeout(onStop, 30000);
        });
        killed++;
        // Walk toward drops and wait briefly for item pickup
        if (target.position) {
          this.bot.pathfinder.setGoal(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 1));
        }
        await new Promise(r => setTimeout(r, 2000));
        this.bot.pathfinder.setGoal(null);
      } catch (err) {
        this.log('action_failed', `Attack ${mobName}: ${err.message}`);
        break;
      }
    }

    if (this.state === 'attacking') this.state = 'idle';

    if (killed > 0) {
      this.log('action_success', `Killed ${killed}${count > 1 ? `/${count}` : ''} ${mobName}`);
    }
  }

  async _cmdPickup(itemName) {
    const pos = this.bot.entity.position;
    const items = [];
    for (const entity of Object.values(this.bot.entities)) {
      if (!entity || entity.name !== 'item') continue;
      const dist = pos.distanceTo(entity.position);
      if (dist > 24) continue;
      const droppedItem = entity.getDroppedItem?.();
      if (!droppedItem) continue;
      if (itemName && !droppedItem.name.toLowerCase().includes(itemName.toLowerCase())) continue;
      items.push({ entity, name: droppedItem.name, dist });
    }

    if (items.length === 0) {
      this.log('action_failed', `No ${itemName || 'items'} on the ground nearby`);
      return;
    }

    // Sort by distance, pick up closest first
    items.sort((a, b) => a.dist - b.dist);
    this.state = 'collecting';
    let picked = 0;

    for (const item of items.slice(0, 5)) {
      if (!this.connected || this.despawned) break;
      try {
        this.bot.pathfinder.setGoal(new goals.GoalNear(
          item.entity.position.x, item.entity.position.y, item.entity.position.z, 0
        ));
        await new Promise(r => setTimeout(r, 3000));
        this.bot.pathfinder.setGoal(null);
        picked++;
      } catch {}
    }

    if (this.state === 'collecting') this.state = 'idle';
    this.log(picked > 0 ? 'action_success' : 'action_failed',
      picked > 0 ? `Picked up ${picked} item(s)` : `Failed to pick up items`);
  }

  _cmdDrop(itemName, count) {
    const item = this.bot.inventory.items().find(i =>
      i.name.toLowerCase().includes(itemName.toLowerCase())
    );
    if (!item) {
      this.log('action_failed', `No ${itemName} in inventory`);
      return;
    }
    this.log('action', `Dropping ${count || 'all'} ${itemName}`);
    this.bot.tossStack(item).catch(err => {
      this.log('action_failed', `Drop error: ${err.message}`);
    });
  }

  async _cmdDropAll() {
    const items = this.bot.inventory.items();
    if (items.length === 0) {
      this.log('action_failed', 'Inventory is empty');
      return;
    }
    this.log('action', `Dropping all ${items.length} item stacks`);
    let dropped = 0;
    for (const item of [...items]) {
      try {
        await this.bot.tossStack(item);
        dropped++;
      } catch {}
    }
    this.log('action_success', `Dropped ${dropped} item stacks`);
  }

  _cmdGive(playerName, itemName, count) {
    const target = this.bot.players[playerName]?.entity;
    if (!target) {
      this.log('action_failed', `Can't see ${playerName}`);
      return;
    }
    this.log('action', `Giving ${count || 'all'} ${itemName} to ${playerName}`);
    this.bot.pathfinder.setGoal(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 2));
    this.bot.once('goal_reached', () => {
      const item = this.bot.inventory.items().find(i =>
        i.name.toLowerCase().includes(itemName.toLowerCase())
      );
      if (!item) {
        this.log('action_failed', `No ${itemName} in inventory`);
        return;
      }
      this.bot.lookAt(target.position.offset(0, 1, 0)).then(() => {
        this.bot.tossStack(item).catch(() => {});
      });
    });
  }

  async _cmdCheckChests() {
    this.state = 'checking_chests';
    this.log('action', 'Scanning nearby containers');

    const containerIds = [
      this._mcData?.blocksByName.chest?.id,
      this._mcData?.blocksByName.trapped_chest?.id,
      this._mcData?.blocksByName.barrel?.id,
    ].filter(Boolean);

    const furnaceIds = [
      this._mcData?.blocksByName.furnace?.id,
      this._mcData?.blocksByName.blast_furnace?.id,
      this._mcData?.blocksByName.smoker?.id,
    ].filter(Boolean);

    const allIds = [...containerIds, ...furnaceIds];

    const positions = this.bot.findBlocks({
      matching: allIds,
      maxDistance: 32,
      count: 15,
    });

    if (positions.length === 0) {
      this.state = 'idle';
      this.log('action_failed', 'No containers found nearby');
      return;
    }

    const results = [];
    for (const pos of positions.slice(0, 8)) {
      const block = this.bot.blockAt(pos);
      if (!block) continue;
      try {
        // Walk to container if out of reach
        const dist = this.bot.entity.position.distanceTo(pos);
        if (dist > 4) {
          this.bot.pathfinder.setGoal(new goals.GoalNear(pos.x, pos.y, pos.z, 3));
          await new Promise(resolve => {
            const timeout = setTimeout(() => resolve(), 10000);
            this.bot.once('goal_reached', () => { clearTimeout(timeout); resolve(); });
          });
        }

        const isFurnace = furnaceIds.includes(block.type);
        const label = block.name.replace(/_/g, ' ');

        if (isFurnace) {
          const furnace = await this.bot.openFurnace(block);
          const parts = [];
          if (furnace.inputItem()) parts.push(`in:${furnace.inputItem().name}x${furnace.inputItem().count}`);
          if (furnace.fuelItem()) parts.push(`fuel:${furnace.fuelItem().name}x${furnace.fuelItem().count}`);
          if (furnace.outputItem()) parts.push(`out:${furnace.outputItem().name}x${furnace.outputItem().count}`);
          const summary = parts.length > 0 ? parts.join(', ') : 'empty';
          results.push(`${label}(${pos.x},${pos.y},${pos.z}): ${summary}`);
          furnace.close();
        } else {
          const container = await this.bot.openContainer(block);
          const items = container.containerItems();
          const summary = items.length > 0
            ? items.map(i => `${i.name}x${i.count}`).join(', ')
            : 'empty';
          results.push(`${label}(${pos.x},${pos.y},${pos.z}): ${summary}`);
          container.close();
        }
      } catch (err) {
        results.push(`${block.name}(${pos.x},${pos.y},${pos.z}): error (${err.message})`);
      }
    }

    this.state = 'idle';
    if (results.length > 0) {
      this.log('chest_contents', results.join(' | '));
    } else {
      this.log('action_failed', 'Could not open any containers');
    }
  }

  async _cmdTakeFromChest(itemName, count) {
    this.log('action', `Taking ${count || 'all'} ${itemName} from container`);

    const chestIds = [
      this._mcData?.blocksByName.chest?.id,
      this._mcData?.blocksByName.trapped_chest?.id,
      this._mcData?.blocksByName.barrel?.id,
    ].filter(Boolean);

    const furnaceIds = [
      this._mcData?.blocksByName.furnace?.id,
      this._mcData?.blocksByName.blast_furnace?.id,
      this._mcData?.blocksByName.smoker?.id,
    ].filter(Boolean);

    const allIds = [...chestIds, ...furnaceIds];

    const positions = this.bot.findBlocks({
      matching: allIds,
      maxDistance: 32,
      count: 15,
    });

    const nameLower = itemName.toLowerCase();

    for (const pos of positions) {
      const block = this.bot.blockAt(pos);
      if (!block) continue;
      try {
        const dist = this.bot.entity.position.distanceTo(pos);
        if (dist > 4) {
          this.bot.pathfinder.setGoal(new goals.GoalNear(pos.x, pos.y, pos.z, 3));
          await new Promise(resolve => {
            const timeout = setTimeout(() => resolve(), 10000);
            this.bot.once('goal_reached', () => { clearTimeout(timeout); resolve(); });
          });
        }

        const isFurnace = furnaceIds.includes(block.type);

        if (isFurnace) {
          const furnace = await this.bot.openFurnace(block);
          const output = furnace.outputItem();
          if (output && output.name.toLowerCase().includes(nameLower)) {
            await furnace.takeOutput();
            furnace.close();
            this.log('action_success', `Took ${output.count}x ${output.name} from furnace`);
            return;
          }
          // Also check input slot (in case they want raw items back)
          const input = furnace.inputItem();
          if (input && input.name.toLowerCase().includes(nameLower)) {
            await furnace.takeInput();
            furnace.close();
            this.log('action_success', `Took ${input.count}x ${input.name} from furnace input`);
            return;
          }
          furnace.close();
        } else {
          const container = await this.bot.openContainer(block);
          const items = container.containerItems();
          const target = items.find(i => i.name.toLowerCase().includes(nameLower));
          if (target) {
            const amt = Math.min(count || target.count, target.count);
            await container.withdraw(target.type, target.metadata, amt);
            container.close();
            this.log('action_success', `Took ${amt}x ${target.name} from chest`);
            return;
          }
          container.close();
        }
      } catch (err) {
        // try next container
      }
    }

    this.state = 'idle';
    this.log('action_failed', `No ${itemName} found in nearby containers`);
  }

  async _cmdDepositAll() {
    const items = this.bot.inventory.items();
    if (items.length === 0) {
      this.log('action_failed', 'Inventory is empty');
      return;
    }
    this.log('action', `Depositing all ${items.length} item stacks into chest`);

    const chestIds = [
      this._mcData?.blocksByName.chest?.id,
      this._mcData?.blocksByName.trapped_chest?.id,
      this._mcData?.blocksByName.barrel?.id,
    ].filter(Boolean);

    const positions = this.bot.findBlocks({
      matching: chestIds,
      maxDistance: 32,
      count: 5,
    });

    if (positions.length === 0) {
      this.log('action_failed', 'No chests found nearby');
      return;
    }

    let deposited = 0;
    for (const pos of positions) {
      const block = this.bot.blockAt(pos);
      if (!block) continue;
      try {
        const dist = this.bot.entity.position.distanceTo(pos);
        if (dist > 4) {
          this.bot.pathfinder.setGoal(new goals.GoalNear(pos.x, pos.y, pos.z, 3));
          await new Promise(resolve => {
            const timeout = setTimeout(() => resolve(), 10000);
            this.bot.once('goal_reached', () => { clearTimeout(timeout); resolve(); });
          });
        }
        const container = await this.bot.openContainer(block);
        // Deposit every item stack we have
        for (const item of [...this.bot.inventory.items()]) {
          try {
            await container.deposit(item.type, item.metadata, item.count);
            deposited++;
          } catch { /* chest full or can't deposit this item */ }
        }
        container.close();
        if (this.bot.inventory.items().length === 0) break; // all deposited
      } catch {
        // try next chest
      }
    }

    if (deposited > 0) {
      const remaining = this.bot.inventory.items().length;
      if (remaining === 0) {
        this.log('action_success', `Deposited ${deposited} item stacks into chest`);
      } else {
        this.log('action_partial', `Deposited ${deposited} stacks, ${remaining} remaining (chests may be full)`);
      }
    } else {
      this.log('action_failed', 'Could not deposit any items');
    }
  }

  async _cmdDepositInChest(itemName, count) {
    this.log('action', `Depositing ${count || 'all'} ${itemName} in chest`);

    const item = this.bot.inventory.items().find(i =>
      i.name.toLowerCase().includes(itemName.toLowerCase())
    );
    if (!item) {
      this.log('action_failed', `No ${itemName} in inventory`);
      return;
    }

    const chestIds = [
      this._mcData?.blocksByName.chest?.id,
      this._mcData?.blocksByName.trapped_chest?.id,
      this._mcData?.blocksByName.barrel?.id,
    ].filter(Boolean);

    const positions = this.bot.findBlocks({
      matching: chestIds,
      maxDistance: 32,
      count: 5,
    });

    if (positions.length === 0) {
      this.log('action_failed', 'No chests found nearby');
      return;
    }

    for (const pos of positions) {
      const block = this.bot.blockAt(pos);
      if (!block) continue;
      try {
        const dist = this.bot.entity.position.distanceTo(pos);
        if (dist > 4) {
          this.bot.pathfinder.setGoal(new goals.GoalNear(pos.x, pos.y, pos.z, 3));
          await new Promise(resolve => {
            const timeout = setTimeout(() => resolve(), 10000);
            this.bot.once('goal_reached', () => { clearTimeout(timeout); resolve(); });
          });
        }
        const container = await this.bot.openContainer(block);
        const amt = Math.min(count || item.count, item.count);
        await container.deposit(item.type, item.metadata, amt);
        container.close();
        this.log('action_success', `Deposited ${amt}x ${item.name} in chest`);
        return;
      } catch (err) {
        // try next chest
      }
    }
    this.log('action_failed', `Could not deposit ${itemName} in any chest`);
  }

  async _cmdCraft(itemName, count = 1) {
    // Fix common LLM item name mistakes
    const CRAFT_ALIASES = {
      planks: 'oak_planks', oak_plank: 'oak_planks', plank: 'oak_planks',
      birch_plank: 'birch_planks', spruce_plank: 'spruce_planks',
      dark_oak_plank: 'dark_oak_planks', jungle_plank: 'jungle_planks',
      acacia_plank: 'acacia_planks', mangrove_plank: 'mangrove_planks',
      sticks: 'stick', wooden_stick: 'stick',
      wooden_plank: 'oak_planks', wooden_planks: 'oak_planks',
      log: 'oak_log', logs: 'oak_log', wood: 'oak_planks',
      stone_pickaxe: 'stone_pickaxe', // valid — no alias needed
      pickaxe: 'wooden_pickaxe', // bare "pickaxe" → cheapest
      sword: 'wooden_sword',
      axe: 'wooden_axe',
      shovel: 'wooden_shovel',
      hoe: 'wooden_hoe',
    };
    const resolvedName = CRAFT_ALIASES[itemName] || itemName;
    if (resolvedName !== itemName) {
      this.log('action', `Resolved craft name: ${itemName} → ${resolvedName}`);
    }
    itemName = resolvedName;

    this.log('action', `Crafting ${count}x ${itemName}`);
    const prevState = this.state;
    this.state = 'crafting';

    const item = this._mcData?.itemsByName[itemName];
    if (!item) {
      this.log('action_failed', `Unknown item: ${itemName}`);
      this.state = prevState;
      return;
    }

    try {
      // Stop pathfinding during craft to avoid window click conflicts
      this.bot.pathfinder.setGoal(null);

      const recipes = this.bot.recipesFor(item.id, null, 1, null);
      // Try with crafting table if no 2x2 recipe
      let craftingTable = null;
      if (recipes.length === 0) {
        const tableBlock = this.bot.findBlock({
          matching: this._mcData.blocksByName.crafting_table?.id,
          maxDistance: 32,
        });
        if (tableBlock) {
          const dist = this.bot.entity.position.distanceTo(tableBlock.position);
          if (dist > 4) {
            this.bot.pathfinder.setGoal(new goals.GoalNear(tableBlock.position.x, tableBlock.position.y, tableBlock.position.z, 3));
            await new Promise(resolve => {
              const timeout = setTimeout(() => resolve(), 10000);
              this.bot.once('goal_reached', () => { clearTimeout(timeout); resolve(); });
            });
          }
          craftingTable = tableBlock;
        } else {
          // No crafting table found — check if bot has one in inventory to hint the LLM
          const hasTable = this.bot.inventory.items().some(i => i.name === 'crafting_table');
          this.log('action_failed', hasTable
            ? `${itemName} needs a crafting table (3×3 grid). Place your crafting_table first!`
            : `${itemName} needs a crafting table but none found nearby and none in inventory`);
          this.state = prevState;
          return;
        }
      }

      let crafted = 0;
      // count = desired number of items, not recipe batches
      // Each recipe produces recipe.result.count items (e.g. sticks → 4 per batch)
      const firstRecipes = this.bot.recipesFor(item.id, null, 1, craftingTable);
      const outputPerBatch = firstRecipes.length > 0 ? (firstRecipes[0].result?.count || 1) : 1;
      const batches = Math.ceil(count / outputPerBatch);

      for (let i = 0; i < batches; i++) {
        const recipes = this.bot.recipesFor(item.id, null, 1, craftingTable);
        if (recipes.length === 0) break;
        try {
          await this.bot.craft(recipes[0], 1, craftingTable);
          crafted += outputPerBatch;
        } catch (err) {
          if (crafted === 0) {
            this.log('action_failed', `Craft ${itemName}: ${err.message}`);
            return;
          }
          break; // partial success
        }
      }
      if (crafted === 0) {
        this.log('action_failed', `No recipe for ${itemName} (missing materials or crafting table)`);
      } else {
        this.log('action_success', `Crafted ${crafted}x ${itemName}`);
      }
    } finally {
      this.state = prevState;
    }
  }

  async _cmdSmelt(itemName, fuelName = 'coal', count = 1) {
    // Fix common LLM item name mistakes (raw_porkchop → porkchop, raw_beef → beef, etc.)
    const SMELT_ALIASES = {
      raw_porkchop: 'porkchop', raw_beef: 'beef', raw_chicken: 'chicken',
      raw_mutton: 'mutton', raw_rabbit: 'rabbit', raw_salmon: 'salmon',
      raw_cod: 'cod', raw_iron: 'raw_iron', raw_gold: 'raw_gold',
      raw_copper: 'raw_copper', log: 'oak_log', plank: 'oak_planks',
    };
    const resolvedName = SMELT_ALIASES[itemName] || itemName;
    if (resolvedName !== itemName) {
      console.log(`[Smelt] ${this.username}: aliased ${itemName} → ${resolvedName}`);
    }

    this.log('action', `Smelting ${count}x ${resolvedName} with ${fuelName}`);
    const prevState = this.state;
    this.state = 'smelting';

    try {
      // Find a furnace nearby
      const furnaceIds = ['furnace', 'blast_furnace', 'smoker']
        .map(n => this._mcData?.blocksByName[n]?.id).filter(Boolean);
      const furnaceBlock = this.bot.findBlock({ matching: furnaceIds, maxDistance: 32 });
      if (!furnaceBlock) {
        this.log('action_failed', 'No furnace found nearby');
        return;
      }

      // Walk to furnace if needed
      const dist = this.bot.entity.position.distanceTo(furnaceBlock.position);
      if (dist > 4) {
        const { x, y, z } = furnaceBlock.position;
        this.bot.pathfinder.setGoal(new goals.GoalNear(x, y, z, 3));
        await new Promise(resolve => {
          const timeout = setTimeout(() => resolve(), 15000);
          this.bot.once('goal_reached', () => { clearTimeout(timeout); resolve(); });
        });
      }

      // Check we have the input item and fuel
      const inputItem = this.bot.inventory.items().find(i => i.name.includes(resolvedName));
      if (!inputItem) {
        this.log('action_failed', `No ${resolvedName} in inventory`);
        return;
      }
      const fuelItem = this.bot.inventory.items().find(i => i.name.includes(fuelName));
      if (!fuelItem) {
        this.log('action_failed', `No ${fuelName} (fuel) in inventory`);
        return;
      }

      const furnace = await this.bot.openFurnace(furnaceBlock);
      const smeltCount = Math.min(count, inputItem.count);

      // Put fuel in first, then input
      if (!furnace.fuelItem()) {
        // Items per fuel unit: coal=8, planks/logs=1.5, sticks=0.5, charcoal=8, blaze_rod=12
        const FUEL_RATES = {
          coal: 8, charcoal: 8, coal_block: 80, blaze_rod: 12, lava_bucket: 100,
          oak_planks: 1.5, spruce_planks: 1.5, birch_planks: 1.5, jungle_planks: 1.5,
          acacia_planks: 1.5, dark_oak_planks: 1.5, cherry_planks: 1.5, mangrove_planks: 1.5,
          oak_log: 1.5, spruce_log: 1.5, birch_log: 1.5, stick: 0.5,
        };
        const rate = FUEL_RATES[fuelItem.name] || 1.5;
        const fuelNeeded = Math.ceil(smeltCount / rate);
        await furnace.putFuel(fuelItem.type, null, Math.min(fuelNeeded, fuelItem.count));
      }
      await furnace.putInput(inputItem.type, null, smeltCount);

      // Wait for smelting (roughly 10s per item, but check periodically)
      const maxWait = smeltCount * 12000;
      const start = Date.now();
      while (Date.now() - start < maxWait) {
        await new Promise(r => setTimeout(r, 2000));
        if (!furnace.inputItem()) break; // all smelted
        if (this.state !== 'smelting') break; // interrupted
      }

      // Take output
      const output = furnace.outputItem();
      if (output) {
        await furnace.takeOutput();
        this.log('action_success', `Smelted ${output.count}x ${output.name}`);
      } else {
        this.log('action_partial', `Smelting in progress (items placed in furnace)`);
      }

      furnace.close();
    } catch (err) {
      this.log('action_failed', `Smelt: ${err.message}`);
    } finally {
      this.state = prevState;
    }
  }

  async _cmdEquip(itemName) {
    const item = this.bot.inventory.items().find(i =>
      i.name.toLowerCase().includes(itemName.toLowerCase())
    );
    if (!item) {
      this.log('action_failed', `No ${itemName} in inventory`);
      return;
    }

    // Determine slot: armor goes to armor slots, tools/weapons go to hand
    let dest = 'hand';
    if (item.name.includes('helmet') || item.name.includes('cap')) dest = 'head';
    else if (item.name.includes('chestplate') || item.name.includes('tunic')) dest = 'torso';
    else if (item.name.includes('leggings') || item.name.includes('pants')) dest = 'legs';
    else if (item.name.includes('boots')) dest = 'feet';
    else if (item.name.includes('shield')) dest = 'off-hand';

    this.log('action', `Equipping ${item.name} to ${dest}`);
    try {
      await this.bot.equip(item, dest);
      this.log('action_success', `Equipped ${item.name}`);
    } catch (err) {
      this.log('action_failed', `Equip ${item.name}: ${err.message}`);
    }
  }

  async _cmdEat() {
    const foods = this.bot.inventory.items().filter(i => {
      const food = this._mcData?.foodsByName?.[i.name] || this._mcData?.itemsByName?.[i.name];
      // Simple heuristic: common food items
      const foodNames = ['bread', 'cooked_', 'apple', 'golden_apple', 'steak',
        'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
        'cooked_rabbit', 'cooked_salmon', 'cooked_cod', 'baked_potato',
        'carrot', 'melon_slice', 'sweet_berries', 'mushroom_stew',
        'rabbit_stew', 'beetroot_soup', 'pumpkin_pie', 'cookie',
        'dried_kelp', 'beetroot'];
      return foodNames.some(f => i.name.includes(f));
    });

    if (foods.length === 0) {
      this.log('action_failed', 'No food in inventory');
      return;
    }

    try {
      await this.bot.equip(foods[0], 'hand');
      await this.bot.consume();
      this.log('action_success', `Ate ${foods[0].name}`);
    } catch (err) {
      this.log('action_failed', `Eat: ${err.message}`);
    }
  }

  async _cmdSleep() {
    const bedColors = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime',
      'pink', 'gray', 'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];
    const bedIds = bedColors
      .map(c => this._mcData?.blocksByName[`${c}_bed`]?.id)
      .filter(id => id != null);

    const bed = this.bot.findBlock({ matching: bedIds, maxDistance: 32 });
    if (!bed) {
      this.log('action_failed', 'No bed found nearby');
      return;
    }

    try {
      const dist = this.bot.entity.position.distanceTo(bed.position);
      if (dist > 3) {
        this.bot.pathfinder.setGoal(new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2));
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => { this.bot.pathfinder.stop(); reject(new Error('timeout walking to bed')); }, 15000);
          this.bot.once('goal_reached', () => { clearTimeout(timeout); resolve(); });
        });
      }
      await this.bot.sleep(bed);
      this.log('action_success', 'Sleeping in bed');
    } catch (err) {
      this.log('action_failed', `Sleep: ${err.message}`);
    }
  }

  async _cmdPlace(blockName, direction = 'forward') {
    const item = this.bot.inventory.items().find(i => i.name.includes(blockName));
    if (!item) {
      this.log('action_failed', `No ${blockName} in inventory`);
      return;
    }

    try {
      await this.bot.equip(item, 'hand');
    } catch (err) {
      this.log('action_failed', `Equip ${item.name}: ${err.message}`);
      return;
    }

    const pos = this.bot.entity.position.floored();
    const Vec3 = this.bot.entity.position.constructor;

    // Blocks that can be broken to make room for placement
    const REPLACEABLE = new Set([
      'short_grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush',
      'leaf_litter', 'seagrass', 'tall_seagrass', 'snow',
      'vine', 'dandelion', 'poppy', 'blue_orchid', 'allium',
      'azure_bluet', 'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip',
      'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'sunflower',
      'lilac', 'rose_bush', 'peony', 'sweet_berry_bush',
    ]);

    // Clear replaceable block at a position if present
    const clearIfReplaceable = async (targetPos) => {
      const block = this.bot.blockAt(targetPos);
      if (block && REPLACEABLE.has(block.name)) {
        try { await this.bot.dig(block); } catch {}
      }
    };

    // Check if a position is open (air or replaceable)
    const isOpen = (targetPos) => {
      const block = this.bot.blockAt(targetPos);
      return block && (block.name === 'air' || REPLACEABLE.has(block.name));
    };

    // Try placing on top of ground block in a cardinal direction
    const tryDirection = (dx, dz) => {
      for (const dist of [1, 2]) {
        const tp = pos.offset(dx * dist, 0, dz * dist);
        if (isOpen(tp)) {
          const bl = this.bot.blockAt(tp.offset(0, -1, 0));
          if (bl && bl.name !== 'air') return { ref: bl, face: new Vec3(0, 1, 0), clearPos: tp };
        }
      }
      return null;
    };

    // Forward direction based on yaw
    const yaw = this.bot.entity.yaw;
    const fdx = -Math.sin(yaw);
    const fdz = -Math.cos(yaw);
    const fwdDir = Math.abs(fdx) > Math.abs(fdz)
      ? { x: Math.sign(fdx), z: 0 } : { x: 0, z: Math.sign(fdz) };

    // Prioritized direction order: requested first, then all others
    const allDirs = [
      { x: fwdDir.x, z: fwdDir.z },   // forward
      { x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }, // cardinals
    ];
    // Deduplicate
    const seen = new Set();
    const dirs = allDirs.filter(d => {
      const key = `${d.x},${d.z}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const candidates = [];

    // Try placing at feet (on block below) — most reliable placement
    const belowBlock = this.bot.blockAt(pos.offset(0, -1, 0));
    if (belowBlock && belowBlock.name !== 'air' && isOpen(pos)) {
      candidates.push({ ref: belowBlock, face: new Vec3(0, 1, 0), clearPos: pos });
    }

    // Then try cardinal directions
    for (const d of dirs) {
      const result = tryDirection(d.x, d.z);
      if (result) candidates.push(result);
    }

    for (const { ref, face, clearPos } of candidates) {
      try {
        if (clearPos) await clearIfReplaceable(clearPos);
        await this.bot.equip(item, 'hand'); // re-equip after digging
        await this.bot.placeBlock(ref, face);
        this.log('action_success', `Placed ${item.name}`);
        return;
      } catch (err) {
        // Try next candidate
      }
    }
    this.log('action_failed', `Place ${item.name}: no valid placement found`)
  }
}

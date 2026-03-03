import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { pathfinder, Movements, goals } = pathfinderPkg;
import { plugin as collectBlock } from 'mineflayer-collectblock';
import { plugin as pvp } from 'mineflayer-pvp';
import mcData from 'minecraft-data';

const TWO_HOURS = 2 * 60 * 60 * 1000;
const OWNER_GRACE_PERIOD = 5 * 60 * 1000;
const TICK_INTERVAL_MIN = 10000;  // 10s
const TICK_INTERVAL_MAX = 20000;  // 20s
const SURVIVAL_INTERVAL = 3000;   // 3s — fast reactive loop
const STUCK_THRESHOLD = 30000;    // 30s same position → unstuck
const MAX_LOG_ENTRIES = 15;

const HOSTILE_MOBS = new Set([
  'zombie', 'skeleton', 'creeper', 'spider', 'enderman', 'witch', 'phantom',
  'drowned', 'husk', 'stray', 'pillager', 'vindicator', 'ravager', 'blaze',
  'ghast', 'wither_skeleton', 'piglin_brute', 'cave_spider', 'slime',
  'magma_cube', 'warden', 'breeze',
]);

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

    // ── Lifecycle ─────────────────────────────────────────────────────
    this._despawnTimer = null;
    this._ownerGraceTimer = null;
    this._tickTimer = null;
    this._survivalTimer = null;
    this._ticking = false;            // prevent overlapping ticks
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
    // Don't add duplicates
    if (this.objectives.some(o => o.text === text)) return;
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
    // Bump the next tick sooner for responsiveness (without breaking the loop)
    if (!this._ticking && this.connected && !this.despawned && this._loopRunning) {
      this._scheduleNextTick(500 + Math.random() * 1000);
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

    // Nearby entities (all living entities within 24 blocks)
    const nearby = [];
    for (const entity of Object.values(this.bot.entities)) {
      if (!entity || entity === this.bot.entity) continue;
      const dist = pos.distanceTo(entity.position);
      if (dist > 24) continue;
      if (entity.type === 'player') {
        nearby.push(`player:${entity.username}(${Math.round(dist)}m)`);
      } else if (entity.name) {
        // Include all named entities: mobs, animals, hostiles, etc.
        nearby.push(`${entity.name}(${Math.round(dist)}m)`);
      }
    }

    return {
      position: `${Math.round(pos.x)}, ${Math.round(pos.y)}, ${Math.round(pos.z)}`,
      health: Math.round(health),
      food: Math.round(food),
      timeOfDay: isDay === null ? 'unknown' : (isDay ? 'day' : 'night'),
      inventory: inventory.length > 0 ? inventory.join(', ') : 'empty',
      ownerDistance: ownerDist !== null ? `${ownerDist}m` : 'not visible',
      nearbyEntities: nearby.length > 0 ? nearby.slice(0, 15).join(', ') : 'none',
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
    // Don't interrupt active combat
    if (this.state === 'attacking') return;

    const food = this.bot.inventory.items().find(i => FOOD_ITEMS.has(i.name));
    if (!food) return;

    this._lastEatTime = Date.now();
    console.log(`[Survival] ${this.username} auto-eating ${food.name} (food=${this.bot.food})`);
    this.log('survival', `Auto-ate ${food.name} (hunger=${this.bot.food})`);

    this.bot.equip(food, 'hand')
      .then(() => this.bot.consume())
      .catch(() => {}); // silent fail — next tick will retry
  }

  // Fight back when hit by hostiles (only if idle or following)
  _survivalDefend() {
    // Only auto-defend if not busy with an owner-issued action
    if (this.state !== 'idle' && this.state !== 'following' && this.state !== 'guarding') return;

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
    try {
      if (this._onTick) await this._onTick(this);
    } catch (err) {
      console.error(`[Revival Tick] ${this.username} error: ${err.message}`);
    } finally {
      this._ticking = false;
      this._scheduleNextTick();
    }
  }

  // ── Connection ────────────────────────────────────────────────────

  connect() {
    if (this.despawned) return;
    console.log(`[Revival] ${this.username} connecting (revived by ${this.owner})...`);

    this.bot = mineflayer.createBot({
      host: this.config.host || 'localhost',
      port: this.config.port || 25565,
      username: this.username,
      version: false,
      auth: 'offline',
      hideErrors: false,
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

      // 2-hour despawn timer
      this._despawnTimer = setTimeout(() => {
        console.log(`[Revival] ${this.username} timed out (2 hours)`);
        this.despawn('timeout');
      }, TWO_HOURS);

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

    this.bot.on('death', () => {
      console.log(`[Revival] ${this.username} died in-game — permanent despawn`);
      this.log('died', 'Died in-game');
      this.despawn('death');
    });

    this.bot.on('playerLeft', (player) => {
      if (player.username === this.owner) {
        console.log(`[Revival] Owner ${this.owner} disconnected — ${OWNER_GRACE_PERIOD / 60000}min grace`);
        this.log('owner_left', `${this.owner} disconnected`);
        this._ownerGraceTimer = setTimeout(() => {
          console.log(`[Revival] Owner ${this.owner} didn't return — despawning ${this.username}`);
          this.despawn('owner_left');
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
      if (!this.despawned) this.despawn('disconnected');
    });
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

  _cmdFollow() {
    this._cmdFollowPlayer(this.owner);
  }

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
    this.state = 'mining';
    this.log('action', `Mining up to ${count}x ${blockName}`);

    const blockType = this._mcData?.blocksByName[blockName];
    if (!blockType) {
      this.state = 'idle';
      this.log('action_failed', `"${blockName}" is not a valid block name`);
      return;
    }

    let mined = 0;
    let failReason = null;

    while (mined < count && this.state === 'mining' && this.connected && !this.despawned) {
      // Find the nearest matching block
      const block = this.bot.findBlock({ matching: blockType.id, maxDistance: 64 });
      if (!block) {
        failReason = `no ${blockName} found nearby`;
        break;
      }
      try {
        // Race collect against a 30s timeout and state-change abort
        await Promise.race([
          this.bot.collectBlock.collect(block, { ignoreNoPath: true }),
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
    this.log('action', `Crafting ${count}x ${itemName}`);

    const item = this._mcData?.itemsByName[itemName];
    if (!item) {
      this.log('action_failed', `Unknown item: ${itemName}`);
      return;
    }

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
      }
    }

    const allRecipes = this.bot.recipesFor(item.id, null, count, craftingTable);
    if (allRecipes.length === 0) {
      this.log('action_failed', `No recipe for ${itemName} (missing materials or crafting table)`);
      return;
    }

    try {
      await this.bot.craft(allRecipes[0], count, craftingTable);
      this.log('action_success', `Crafted ${count}x ${itemName}`);
    } catch (err) {
      this.log('action_failed', `Craft ${itemName}: ${err.message}`);
    }
  }

  async _cmdSmelt(itemName, fuelName = 'coal', count = 1) {
    this.log('action', `Smelting ${count}x ${itemName} with ${fuelName}`);

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
    const inputItem = this.bot.inventory.items().find(i => i.name.includes(itemName));
    if (!inputItem) {
      this.log('action_failed', `No ${itemName} in inventory`);
      return;
    }
    const fuelItem = this.bot.inventory.items().find(i => i.name.includes(fuelName));
    if (!fuelItem) {
      this.log('action_failed', `No ${fuelName} (fuel) in inventory`);
      return;
    }

    try {
      const furnace = await this.bot.openFurnace(furnaceBlock);
      const smeltCount = Math.min(count, inputItem.count);

      // Put fuel in first, then input
      if (!furnace.fuelItem()) {
        const fuelNeeded = Math.ceil(smeltCount / 8); // coal smelts 8 items
        await furnace.putFuel(fuelItem.type, null, Math.min(fuelNeeded, fuelItem.count));
      }
      await furnace.putInput(inputItem.type, null, smeltCount);

      // Wait for smelting (roughly 10s per item, but check periodically)
      const maxWait = smeltCount * 12000;
      const start = Date.now();
      while (Date.now() - start < maxWait) {
        await new Promise(r => setTimeout(r, 2000));
        if (!furnace.inputItem()) break; // all smelted
        if (this.state !== 'idle' && this.state !== 'mining') break; // interrupted
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
    }
  }

  _cmdEquip(itemName) {
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
    this.bot.equip(item, dest).then(() => {
      this.log('action_success', `Equipped ${item.name}`);
    }).catch(err => {
      this.log('action_failed', `Equip ${item.name}: ${err.message}`);
    });
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
}

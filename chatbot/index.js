import './env.js';
import { readFileSync, writeFileSync, existsSync, watch } from 'fs';
import { ChatBot } from './bot.js';
import { ConversationManager, reloadPrompts } from './conversation.js';
import { findMentionedBot, findMentionedBots } from './mention.js';

const personalities = JSON.parse(readFileSync('./personalities.json', 'utf-8'));
const skinAssignments = existsSync('./skin-assignments.json')
  ? JSON.parse(readFileSync('./skin-assignments.json', 'utf-8'))
  : {};
const BOT_COUNT = Math.min(parseInt(process.env.BOT_COUNT) || 4, personalities.length);
const MAX_IN_WINDOW = Infinity; // rate limit disabled — per-bot cooldowns handle pacing
const RATE_WINDOW_MIN = 5;
const CHATTER_MIN = (parseInt(process.env.CHATTER_INTERVAL_MIN) || 3) * 60 * 1000;
const CHATTER_MAX = (parseInt(process.env.CHATTER_INTERVAL_MAX) || 10) * 60 * 1000;

const cm = new ConversationManager({
  maxInWindow: MAX_IN_WINDOW,
  rateLimitWindowMin: RATE_WINDOW_MIN
});

// ── Known players persistence ─────────────────────────────────────────
const KNOWN_PLAYERS_FILE = './known-players.json';
let knownPlayers = new Set();
try {
  if (existsSync(KNOWN_PLAYERS_FILE)) {
    knownPlayers = new Set(JSON.parse(readFileSync(KNOWN_PLAYERS_FILE, 'utf-8')));
    console.log(`Loaded ${knownPlayers.size} known players.`);
  }
} catch { /* fresh start */ }

function saveKnownPlayers() {
  try { writeFileSync(KNOWN_PLAYERS_FILE, JSON.stringify([...knownPlayers])); } catch {}
}

function trackPlayer(username) {
  if (knownPlayers.has(username)) return false; // returning player
  knownPlayers.add(username);
  saveKnownPlayers();
  return true; // new player
}

const bots = [];
const botsByName = new Map();
const botConfig = {
  host: process.env.MC_HOST || 'localhost',
  port: parseInt(process.env.MC_PORT) || 25565
};

console.log('=== Xandaris Chatbots ===');
console.log(`Starting ${BOT_COUNT} bots -> ${botConfig.host}:${botConfig.port}`);
console.log(`Rate limit: ${MAX_IN_WINDOW} messages per ${RATE_WINDOW_MIN} min`);

for (let i = 0; i < BOT_COUNT; i++) {
  const profile = personalities[i];
  const bot = new ChatBot(profile, cm, botConfig);
  bot.muted = !!profile.muted;
  bot.priority = !!profile.priority;
  bots.push(bot);
  botsByName.set(profile.username, bot);

  // Apply skin after login via SkinsRestorer /skin command
  // Stagger by bot index to avoid Mojang API rate limits
  const skinSource = skinAssignments[profile.username];
  if (skinSource) {
    const skinDelay = 5000 + i * 3000; // 5s base + 3s per bot
    const origConnect = bot.connect.bind(bot);
    bot.connect = function () {
      origConnect();
      const onLogin = () => {
        setTimeout(() => {
          if (bot.bot && bot.connected) {
            console.log(`[Skin] ${bot.username} → /skin set ${skinSource}`);
            bot.bot.chat(`/skin set ${skinSource}`);
          }
        }, skinDelay);
      };
      bot.bot.once('login', onLogin);
    };
  }

  setTimeout(() => bot.connect(), i * 15000 + Math.random() * 5000);
}

const botNames = bots.map(b => b.username);

function getRealPlayerCount() {
  const leader = bots[0];
  if (!leader?.bot?.players) return 0;
  return Object.keys(leader.bot.players).filter(n => !botNames.includes(n)).length;
}

function resolveSender(leaderBot, senderUuid) {
  if (!leaderBot.players) return null;
  for (const [name, player] of Object.entries(leaderBot.players)) {
    if (player.uuid === senderUuid) return name;
  }
  return null;
}

// ── Dispatch a response from a specific bot ─────────────────────────
// Flow: read delay → LLM call (~1-2s) → typing delay → send
// Per-bot cooldown prevents pile-ups when multiple messages come in fast

const botBusy = new Set(); // tracks bots currently thinking/typing
const botLastMessage = new Map(); // per-bot cooldown: username → timestamp
const BOT_COOLDOWN = 8000; // minimum 8s between messages from the SAME bot

async function dispatchResponse(bot, tag, playerName, { serverQuestion = false } = {}) {
  if (!bot || !bot.connected || bot.muted || cm.isRateLimited()) return;
  if (botBusy.has(bot.username)) {
    console.log(`[${tag}] ${bot.username} busy, skipping`);
    return;
  }
  botBusy.add(bot.username);

  // If bot is on cooldown, wait for it to expire instead of dropping
  const lastMsg = botLastMessage.get(bot.username) || 0;
  const elapsed = Date.now() - lastMsg;
  const cooldownWait = elapsed < BOT_COOLDOWN ? BOT_COOLDOWN - elapsed : 0;
  const readDelay = cm.getReadDelay() + cooldownWait;

  if (cooldownWait > 0) {
    console.log(`[${tag}] ${bot.username} on cooldown, waiting ${Math.round(cooldownWait / 1000)}s`);
  }

  setTimeout(async () => {
    if (cm.isRateLimited()) { botBusy.delete(bot.username); return; }
    const result = await cm.generateResponse(bot, { serverQuestion });
    if (result) {
      const { text, fallback } = result;
      const typingDelay = fallback ? 0 : cm.getTypingDelay(text);
      console.log(`[${tag}] ${bot.username}${fallback ? ' (instant)' : ` (typing ${Math.round(typingDelay / 1000)}s)`}: ${text}`);
      setTimeout(() => {
        bot.chat(text);
        botLastMessage.set(bot.username, Date.now());
        if (playerName) cm.trackConversation(playerName, bot.username);
        botBusy.delete(bot.username);
      }, typingDelay);
    } else {
      botBusy.delete(bot.username);
    }
  }, readDelay);
}

// ── Death reactions ─────────────────────────────────────────────────

const DEATH_REACTIONS = [
  'F', 'f', 'rip', 'rip bozo', 'L', 'gg', 'noooo',
  'rip lol', 'hardcore claims another', 'brutal', 'gone too soon',
  'shoulda been more careful', 'rip brother', 'lmaooo', 'not like this',
  'get rekt', 'they had a good run', 'one less player lol',
  'that was rough', 'rip in pieces', 'big L', 'down bad',
];

const DEATH_PATTERNS = [
  'was slain by', 'was killed', 'was shot by', 'was fireballed by',
  'was pummeled by', 'was stung by', 'was impaled by',
  'fell from', 'fell off', 'fell out of', 'fell while',
  'hit the ground too hard', 'experienced kinetic energy',
  'drowned', 'suffocated', 'starved to death',
  'burned to death', 'was burnt to a crisp', 'went up in flames',
  'tried to swim in lava', 'was roasted',
  'blew up', 'was blown up by',
  'was pricked to death', 'walked into a cactus',
  'was squished', 'was squashed by',
  'withered away', 'was frozen',
  'was struck by lightning',
  'was doomed to fall', 'walked into fire',
  'died', 'was obliterated',
];

function isDeathMessage(text) {
  const lower = text.toLowerCase();
  return DEATH_PATTERNS.some(p => lower.includes(p));
}

function getDeathVictim(text, onlinePlayers) {
  // Death messages start with player name, possibly prefixed with symbols like ☠
  const stripped = text.replace(/^[^\w]+/, ''); // strip leading non-word chars (☠, spaces, etc.)
  for (const name of onlinePlayers) {
    if (stripped.startsWith(name + ' ') || stripped.startsWith(name + "'")) {
      return name;
    }
    // Also check original text in case no prefix
    if (text.startsWith(name + ' ') || text.startsWith(name + "'")) {
      return name;
    }
  }
  return null;
}

function triggerDeathReactions(victim) {
  console.log(`[Death] ${victim} died! All bots reacting.`);
  const connected = bots.filter(b => b.connected && !b.muted);
  connected.forEach((bot, i) => {
    // Stagger: 2-6s base + 0-4s per bot index so they don't all fire at once
    const delay = 2000 + Math.random() * 4000 + i * (1000 + Math.random() * 3000);
    setTimeout(() => {
      const reaction = DEATH_REACTIONS[Math.floor(Math.random() * DEATH_REACTIONS.length)];
      console.log(`[Death React] ${bot.username}: ${reaction}`);
      bot.chat(reaction);
    }, delay);
  });
}

// ── Join/leave reactions ────────────────────────────────────────────

// Join reactions are now LLM-generated per bot personality

const LEAVE_REACTIONS = [
  'cya', 'later', 'bye', 'peace', 'rip he left', 'nooo come back',
];

const playerLeaveTimestamps = new Map(); // username → timestamp of last leave
const RECONNECT_GRACE_PERIOD = 10000; // 10s — skip welcome if rejoin within this window

function setupJoinLeaveListeners() {
  const leader = bots[0];
  const checkReady = setInterval(() => {
    if (leader.bot) {
      clearInterval(checkReady);

      // Track player leaves for reconnect detection
      leader.bot.on('playerLeft', (player) => {
        if (!player.username || botNames.includes(player.username)) return;
        playerLeaveTimestamps.set(player.username, Date.now());
      });

      leader.bot.on('playerJoined', (player) => {
        if (!player.username || botNames.includes(player.username)) return;

        // Skip welcome if this is a quick reconnect (left within 10s)
        const lastLeave = playerLeaveTimestamps.get(player.username);
        if (lastLeave && Date.now() - lastLeave < RECONNECT_GRACE_PERIOD) {
          console.log(`[Join] ${player.username} reconnected within ${Math.round((Date.now() - lastLeave) / 1000)}s — skipping welcome`);
          playerLeaveTimestamps.delete(player.username);
          return;
        }
        playerLeaveTimestamps.delete(player.username);

        const isNew = trackPlayer(player.username);
        console.log(`[Join] ${player.username} joined (${isNew ? 'NEW' : 'returning'}) — greetings disabled`);
      });

      console.log('Join/leave listener active.');
    }
  }, 1000);
}

// ── Death message listener (system_chat) ────────────────────────────

function setupDeathListener() {
  const leader = bots[0];
  const checkReady = setInterval(() => {
    if (leader.bot) {
      clearInterval(checkReady);

      // mineflayer 'message' fires for system_chat packets (deaths, announcements)
      leader.bot.on('message', (jsonMsg, position) => {
        if (position === 'game_info') return; // skip action bar
        const text = jsonMsg.toString();
        if (!text || text.length < 5) return;

        // Get online player names (non-bot)
        const onlinePlayers = leader.bot.players
          ? Object.keys(leader.bot.players).filter(n => !botNames.includes(n))
          : [];

        const victim = getDeathVictim(text, onlinePlayers);
        if (victim && isDeathMessage(text)) {
          triggerDeathReactions(victim);
        }
      });

      console.log('Death listener active.');
    }
  }, 1000);
}

// ── Global chat listener ────────────────────────────────────────────

// Parse "username » message" from system_chat text (LPC format via FreedomChat)
function parseChatFromSystem(text) {
  // LPC format: "nickname » message" — the » (or >) separates name from message
  const match = text.match(/^(.+?)\s+[»>]\s+(.+)$/);
  if (!match) return null;
  return { nickname: match[1].trim(), message: match[2].trim() };
}

// Resolve a nickname/display name back to the real username
function resolveUsername(leader, nickname) {
  if (!leader.bot?.players) return null;
  const lower = nickname.toLowerCase();
  // Direct match on username
  for (const name of Object.keys(leader.bot.players)) {
    if (name === nickname) return name;
  }
  // Case-insensitive exact match
  for (const name of Object.keys(leader.bot.players)) {
    if (lower === name.toLowerCase()) return name;
  }
  // Nickname contains username (e.g. "☭ samboyd" contains "samboyd")
  for (const name of Object.keys(leader.bot.players)) {
    if (lower.includes(name.toLowerCase())) return name;
  }
  return null;
}

async function handlePlayerChat(username, message) {
  // Add to shared history ONCE (this is the single source of truth)
  if (!botNames.includes(username)) {
    cm.addMessage(username, message);
  }

  if (botNames.includes(username)) return; // don't process bot messages here
  if (cm.isRateLimited()) return;

  // 1. Direct mentions — dispatch to ALL mentioned bots
  const mentioned = findMentionedBots(message, personalities);
  if (mentioned.length > 0) {
    for (const botName of mentioned) {
      console.log(`[Mention] "${message}" → ${botName}`);
      dispatchResponse(botsByName.get(botName), 'Mention', username);
    }
    return;
  }

  // 2. Conversation continuity — if this player was recently talking to a bot
  const recentBot = cm.getRecentConversant(username);
  if (recentBot && botsByName.has(recentBot)) {
    const bot = botsByName.get(recentBot);
    if (bot.connected) {
      console.log(`[Continuity] "${message}" → ${recentBot} (recent convo)`);
      dispatchResponse(bot, 'Continuity', username);
      return;
    }
  }

  // 3. No mention, no recent convo — ask the orchestrator
  const result = await cm.orchestrate(message, username, personalities, { realPlayerCount: getRealPlayerCount() });
  if (result) {
    const label = result.serverQuestion ? 'Orchestrator+ServerQ' : 'Orchestrator';
    console.log(`[${label}] "${message}" → ${result.botName}`);
    dispatchResponse(botsByName.get(result.botName), label, username, { serverQuestion: result.serverQuestion });
  }
}

function setupGlobalChatListener() {
  const leader = bots[0];
  const checkReady = setInterval(() => {
    if (leader.bot && leader.bot._client) {
      clearInterval(checkReady);

      // Primary: player_chat packets (works without FreedomChat)
      leader.bot._client.on('player_chat', async (packet) => {
        const message = packet.plainMessage;
        if (!message) return;
        const username = resolveSender(leader.bot, packet.senderUuid);
        if (!username) return;
        handlePlayerChat(username, message);
      });

      // Fallback: system_chat via message event (FreedomChat converts player_chat → system_chat)
      leader.bot.on('message', (jsonMsg, position) => {
        if (position === 'game_info') return; // skip action bar
        const text = jsonMsg.toString();
        if (!text || text.length < 3) return;

        // Skip death messages (handled by death listener)
        if (isDeathMessage(text)) return;

        const parsed = parseChatFromSystem(text);
        if (!parsed) return;

        const username = resolveUsername(leader, parsed.nickname);
        if (!username) return;

        handlePlayerChat(username, parsed.message);
      });

      console.log('Global chat listener active (player_chat + system_chat fallback).');
    }
  }, 1000);
}

// ── Bot-to-bot: respond if mentioned by another bot ─────────────────

// Bot-to-bot pair exchange tracking: "botA:botB" → { count, resetTime }
const botPairExchanges = new Map();
const BOT_PAIR_MAX = 4; // max exchanges per pair per window
const BOT_PAIR_WINDOW = 60000; // 1 minute window

function checkBotPairLimit(botA, botB) {
  const key = [botA, botB].sort().join(':');
  const now = Date.now();
  const entry = botPairExchanges.get(key);
  if (!entry || now > entry.resetTime) {
    botPairExchanges.set(key, { count: 1, resetTime: now + BOT_PAIR_WINDOW });
    return true;
  }
  if (entry.count >= BOT_PAIR_MAX) return false;
  entry.count++;
  return true;
}

function setupBotToBotListener(currentBot) {
  const checkReady = setInterval(() => {
    if (currentBot.bot && currentBot.bot._client) {
      clearInterval(checkReady);

      function handleBotToBot(username, message) {
        if (!username || username === currentBot.username) return;
        if (!botNames.includes(username)) return;
        const mentioned = findMentionedBot(message, [{ username: currentBot.username }]);
        if (!mentioned) return;
        if (!checkBotPairLimit(username, currentBot.username)) {
          console.log(`[Bot→Bot] ${username} → ${currentBot.username} (pair limit reached, skipping)`);
          return;
        }
        console.log(`[Bot→Bot] ${username} → ${currentBot.username}`);
        dispatchResponse(currentBot, 'Bot→Bot');
      }

      // Primary: player_chat
      currentBot.bot._client.on('player_chat', async (packet) => {
        const message = packet.plainMessage;
        if (!message) return;
        const username = resolveSender(currentBot.bot, packet.senderUuid);
        handleBotToBot(username, message);
      });

      // Fallback: system_chat (FreedomChat)
      currentBot.bot.on('message', (jsonMsg, position) => {
        if (position === 'game_info') return;
        const text = jsonMsg.toString();
        if (!text || text.length < 3) return;
        const parsed = parseChatFromSystem(text);
        if (!parsed) return;
        const username = resolveUsername(currentBot, parsed.nickname);
        handleBotToBot(username, parsed.message);
      });
    }
  }, 1000);
}

// ── Periodic silly chatter ──────────────────────────────────────────

function scheduleChatter() {
  // Dynamic interval based on real player count
  const playerCount = getRealPlayerCount();
  let minMs, maxMs;
  if (playerCount <= 2) {
    minMs = 1 * 60 * 1000;  maxMs = 2.5 * 60 * 1000; // 1-2.5 min
  } else if (playerCount <= 5) {
    minMs = 3 * 60 * 1000;  maxMs = 6 * 60 * 1000;   // 3-6 min
  } else {
    minMs = 8 * 60 * 1000;  maxMs = 15 * 60 * 1000;  // 8-15 min
  }
  const interval = minMs + Math.random() * (maxMs - minMs);

  setTimeout(async () => {
    if (cm.isRateLimited()) {
      scheduleChatter();
      return;
    }
    const connectedBots = bots.filter(b => b.connected && !b.muted);
    if (connectedBots.length === 0) {
      scheduleChatter();
      return;
    }
    // Skip chatter if no real players are online
    if (getRealPlayerCount() === 0) {
      scheduleChatter();
      return;
    }
    const starter = connectedBots[Math.floor(Math.random() * connectedBots.length)];
    // chattiness gates whether this bot actually speaks
    if (Math.random() > starter.chattiness) {
      console.log(`[Chatter] ${starter.username} rolled above chattiness (${starter.chattiness}), skipping`);
      scheduleChatter();
      return;
    }
    const otherNames = connectedBots
      .filter(b => b.username !== starter.username)
      .map(b => b.username);
    const result = await cm.generateConversationStarter(starter, otherNames);
    if (result) {
      const pc = getRealPlayerCount();
      console.log(`[Chatter] ${starter.username} (${pc} players, ${Math.round(interval/60000)}m interval): ${result.text}`);
      await starter.chat(result.text);
    }
    scheduleChatter();
  }, interval);
}

// ── Dynamic bot scaling with jitter and rotation ─────────────────────

let botCountJitter = 0;

function getTargetBotCount(realPlayers) {
  const total = bots.length;
  let base;
  if (realPlayers <= 3) base = total;
  else if (realPlayers <= 6) base = Math.ceil(total * 0.75);
  else base = Math.ceil(total * 0.5);
  // Apply jitter, but never below 1 or above total
  return Math.max(1, Math.min(total, base + botCountJitter));
}

function scaleBots() {
  const realPlayers = getRealPlayerCount();
  const target = getTargetBotCount(realPlayers);
  const active = bots.filter(b => !b.parked);
  const parked = bots.filter(b => b.parked);

  if (active.length > target) {
    // Park excess — randomly pick from non-protected bots (not bots[0], not priority)
    const parkable = active.filter(b => b !== bots[0] && !b.priority);
    const shuffled = [...parkable].sort(() => Math.random() - 0.5);
    const topark = shuffled.slice(0, active.length - target);
    if (topark.length > 0) {
      topark.forEach((b, i) => b.park(i * (15000 + Math.random() * 10000)));
      console.log(`[Scaler] ${realPlayers} players → target ${target} bots (parking ${topark.map(b => b.username).join(', ')})`);
    }
  } else if (active.length < target && parked.length > 0) {
    // Unpark — randomly pick from parked bots
    const shuffled = [...parked].sort(() => Math.random() - 0.5);
    const tounpark = shuffled.slice(0, target - active.length);
    if (tounpark.length > 0) {
      tounpark.forEach(b => b.unpark());
      console.log(`[Scaler] ${realPlayers} players → target ${target} bots (unparked ${tounpark.map(b => b.username).join(', ')})`);
    }
  }
}

// Jitter refresh: every 12-18 min, nudge the target ±1 and optionally rotate a bot
function scheduleJitterRefresh() {
  const interval = (12 + Math.random() * 6) * 60 * 1000;
  setTimeout(() => {
    const oldJitter = botCountJitter;
    botCountJitter = Math.floor(Math.random() * 3) - 1; // -1, 0, +1
    if (botCountJitter !== oldJitter) {
      console.log(`[Scaler] Jitter: ${botCountJitter > 0 ? '+' : ''}${botCountJitter}`);
    }

    // 50% chance to rotate: swap a random active non-priority bot with a parked one
    const activeSwappable = bots.filter(b => !b.parked && b !== bots[0] && !b.priority);
    const parked = bots.filter(b => b.parked);
    if (activeSwappable.length > 0 && parked.length > 0 && Math.random() < 0.5) {
      const out = activeSwappable[Math.floor(Math.random() * activeSwappable.length)];
      const inn = parked[Math.floor(Math.random() * parked.length)];
      console.log(`[Scaler] Rotating: ${out.username} out → ${inn.username} in`);
      out.park(0);
      setTimeout(() => inn.unpark(), 15000 + Math.random() * 10000);
    }

    scaleBots();
    scheduleJitterRefresh();
  }, interval);
}

// Check every 45 seconds
setInterval(scaleBots, 45000);
scheduleJitterRefresh();

// ── Boot ─────────────────────────────────────────────────────────────

setTimeout(() => {
  setupGlobalChatListener();
  setupDeathListener();
  setupJoinLeaveListeners();
  bots.forEach(bot => setupBotToBotListener(bot));
}, 3000);

setTimeout(() => {
  scheduleChatter();
  console.log('Silly chatter active.');
}, BOT_COUNT * 5000 + 5000);

// ── Hot-reload: prompts/ and personalities.json ──────────────────────

function debounce(fn, ms) {
  let timer;
  return () => { clearTimeout(timer); timer = setTimeout(fn, ms); };
}

watch('./prompts', debounce(() => {
  console.log('[HotReload] prompts/ changed — reloading');
  reloadPrompts();
}, 500));

function readBotCountFromEnv() {
  try {
    const env = readFileSync('../.env', 'utf-8');
    const match = env.match(/^BOT_COUNT=(\d+)/m);
    return match ? parseInt(match[1]) : BOT_COUNT;
  } catch {
    return BOT_COUNT;
  }
}

function reconcileBots() {
  try {
    const updated = JSON.parse(readFileSync('./personalities.json', 'utf-8'));
    const targetCount = Math.min(readBotCountFromEnv(), updated.length);
    const desired = updated.slice(0, targetCount);
    const desiredNames = desired.map(p => p.username);
    const currentNames = bots.map(b => b.username);

    // Update personalities for existing bots that are staying
    for (const bot of bots) {
      const profile = desired.find(p => p.username === bot.username);
      if (profile) {
        bot.personality = profile.personality;
        bot.chattiness = profile.chattiness;
        bot.interests = profile.interests || [];
        bot.muted = !!profile.muted;
        bot.priority = !!profile.priority;
        console.log(`[HotReload]   ${bot.username} personality updated${bot.muted ? ' (muted)' : ''}${bot.priority ? ' (priority)' : ''}`);
      }
    }

    // Spawn new bots (in desired but not already running)
    const toAdd = desired.filter(p => !botsByName.has(p.username));
    toAdd.forEach((profile, i) => {
      const bot = new ChatBot(profile, cm, botConfig);
      bot.muted = !!profile.muted;
      bot.priority = !!profile.priority;
      bots.push(bot);
      botsByName.set(profile.username, bot);

      // Apply skin if configured
      const skinSource = skinAssignments[profile.username];
      if (skinSource) {
        const origConnect = bot.connect.bind(bot);
        bot.connect = function () {
          origConnect();
          bot.bot.once('login', () => {
            setTimeout(() => {
              if (bot.bot && bot.connected) {
                console.log(`[Skin] ${bot.username} → /skin set ${skinSource}`);
                bot.bot.chat(`/skin set ${skinSource}`);
              }
            }, 5000);
          });
        };
      }

      // Stagger connections 15s apart
      setTimeout(() => {
        bot.connect();
        setupBotToBotListener(bot);
      }, i * 15000);
      console.log(`[HotReload] Spawning new bot: ${profile.username}`);
    });

    // Remove bots no longer in desired list (never remove bots[0] — runs global listeners)
    const toRemove = bots.filter(b => !desiredNames.includes(b.username) && b !== bots[0]);
    for (const bot of toRemove) {
      console.log(`[HotReload] Removing bot: ${bot.username}`);
      bot.parked = true; // prevent reconnect attempts
      if (bot.bot?.end) bot.bot.end();
      bot.connected = false;
      botsByName.delete(bot.username);
      botBusy.delete(bot.username);
      const idx = bots.indexOf(bot);
      if (idx !== -1) bots.splice(idx, 1);
    }

    // Update botNames in-place
    botNames.length = 0;
    botNames.push(...bots.map(b => b.username));

    // Update personalities array
    personalities.length = 0;
    personalities.push(...updated);

    console.log(`[HotReload] Active bots (${bots.length}): ${botNames.join(', ')}`);
  } catch (e) {
    console.error(`[HotReload] Failed to reconcile bots: ${e.message}`);
  }
}

watch('./personalities.json', debounce(() => {
  console.log('[HotReload] personalities.json changed — reconciling bots');
  reconcileBots();
}, 500));

watch(new URL('../.env', import.meta.url).pathname, debounce(() => {
  const newCount = readBotCountFromEnv();
  if (newCount !== bots.length) {
    console.log(`[HotReload] .env changed — BOT_COUNT=${newCount}, reconciling`);
    reconcileBots();
  }
}, 500));

console.log('[HotReload] Watching prompts/ and personalities.json');

function gracefulShutdown() {
  console.log('\nShutting down bots...');
  bots.forEach((bot, i) => {
    setTimeout(() => {
      if (bot.bot && bot.connected) {
        if (bot.bot?.end) bot.bot.end();
      } else if (bot.bot?.end) {
        bot.bot.end();
      }
    }, i * 4000 + Math.random() * 3000);
  });
  setTimeout(() => process.exit(0), bots.length * 4000 + 5000);
}
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

console.log('Bot orchestrator running. Press Ctrl+C to stop.');

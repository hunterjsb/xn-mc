import './env.js';
import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync, watch } from 'fs';
import { ChatBot } from './bot.js';
import { RevivalBot } from './revival-bot.js';
import { getPlayerProfile } from './distill-player.js';
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
const revivalBots = new Map(); // deadPlayer → RevivalBot
const MAX_REVIVAL_BOTS = 5;
const REVIVAL_STATE_FILE = './revival-state.json';

function saveRevivalState() {
  const state = [];
  for (const [name, rBot] of revivalBots) {
    if (rBot.despawned) continue;
    state.push({
      deadPlayer: rBot.username,
      reviver: rBot.owner,
      pos: rBot._suspendPos || rBot.spawnPos,
      profile: rBot.profile,
      objectives: rBot.objectives,
      actionLog: rBot.actionLog.slice(-5),
      createdAt: rBot.revivalInfo?.time || Date.now(),
      suspended: rBot.suspended || false,
    });
  }
  try { writeFileSync(REVIVAL_STATE_FILE, JSON.stringify(state, null, 2)); } catch {}
}

function loadRevivalState() {
  try {
    if (!existsSync(REVIVAL_STATE_FILE)) return [];
    const data = JSON.parse(readFileSync(REVIVAL_STATE_FILE, 'utf-8'));
    // Filter out expired ones (older than 2 hours)
    const twoHours = 2 * 60 * 60 * 1000;
    return data.filter(s => Date.now() - s.createdAt < twoHours);
  } catch { return []; }
}
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
      if (!bot.bot) return; // connect was skipped (parked or failed)
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

function getAllBotNames() {
  return [...botNames, ...revivalBots.keys()];
}

function getRealPlayerCount() {
  const leader = bots[0];
  if (!leader?.bot?.players) return 0;
  const allBots = getAllBotNames();
  return Object.keys(leader.bot.players).filter(n => !allBots.includes(n)).length;
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

        // Resume suspended revival bots when their owner returns
        for (const [deadName, rBot] of revivalBots) {
          if (rBot.suspended && rBot.owner === player.username) {
            console.log(`[Revival] Owner ${player.username} returned — resuming ${deadName}`);
            rBot.resume();
            // Teleport to saved position after reconnect
            const waitForConnect = setInterval(() => {
              if (rBot.connected) {
                clearInterval(waitForConnect);
                const pos = rBot._suspendPos || rBot.spawnPos;
                rcon(`tp ${deadName} ${pos.x} ${pos.y} ${pos.z}`).then(resp => {
                  console.log(`[Revival] Resumed & teleported ${deadName}: ${resp}`);
                }).catch(() => {});
              }
            }, 500);
            setTimeout(() => clearInterval(waitForConnect), 30000);
          }
        }

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
  const players = Object.keys(leader.bot.players);
  // Direct match on username
  for (const name of players) {
    if (name === nickname) return name;
  }
  // Case-insensitive exact match
  for (const name of players) {
    if (lower === name.toLowerCase()) return name;
  }
  // Nickname contains username (e.g. "☭ samboyd" contains "samboyd")
  for (const name of players) {
    if (lower.includes(name.toLowerCase())) return name;
  }
  // Username contains nickname (reverse check)
  for (const name of players) {
    if (name.toLowerCase().includes(lower)) return name;
  }
  // Fuzzy: same sorted letters (handles swaps like Lkgye → Lkyge)
  const sortedNick = lower.split('').sort().join('');
  for (const name of players) {
    const sortedName = name.toLowerCase().split('').sort().join('');
    if (sortedNick === sortedName) return name;
  }
  return null;
}

// ── RCON helper ──────────────────────────────────────────────────────

import net from 'net';

function rcon(command) {
  return new Promise((resolve, reject) => {
    const host = '127.0.0.1';
    const port = 25575;
    const password = process.env.RCON_PW || 'minecraft';
    const s = new net.Socket();
    s.connect(port, host, () => {
      // Login packet
      const loginPayload = Buffer.alloc(password.length + 2);
      loginPayload.write(password);
      const loginPkt = Buffer.alloc(12 + password.length + 2);
      loginPkt.writeInt32LE(10 + password.length, 0);
      loginPkt.writeInt32LE(0, 4);
      loginPkt.writeInt32LE(3, 8);
      loginPayload.copy(loginPkt, 12);
      s.write(loginPkt);
    });
    let step = 0;
    s.on('data', (data) => {
      if (step === 0) {
        // Login response, now send command
        step = 1;
        const cmdBuf = Buffer.alloc(command.length + 2);
        cmdBuf.write(command);
        const cmdPkt = Buffer.alloc(12 + command.length + 2);
        cmdPkt.writeInt32LE(10 + command.length, 0);
        cmdPkt.writeInt32LE(1, 4);
        cmdPkt.writeInt32LE(2, 8);
        cmdBuf.copy(cmdPkt, 12);
        s.write(cmdPkt);
      } else {
        const resp = data.slice(12).toString('utf-8').replace(/\0/g, '');
        s.destroy();
        resolve(resp);
      }
    });
    s.on('error', reject);
    setTimeout(() => { s.destroy(); reject(new Error('RCON timeout')); }, 5000);
  });
}

// ── Revival handling ─────────────────────────────────────────────────

function wireRevivalBot(rBot) {
  rBot._onDespawn = (username, reason) => {
    console.log(`[Revival] Cleaning up ${username} (${reason})`);
    revivalBots.delete(username);
    saveRevivalState();
    const regular = botsByName.get(username);
    if (regular) {
      console.log(`[Revival] Unparking regular chatbot ${username}`);
      regular.unpark();
    }
  };

  rBot._onSuspend = (username) => {
    saveRevivalState();
  };

  // Agent loop tick — called every 10-20s by revival-bot.js
  // Supports multi-step chaining: execute actions, then re-tick to let LLM see results
  rBot._onTick = async (bot) => {
    const MAX_STEPS = 3;
    let allSenders = [];
    let lastChat = null; // only send chat from the final step

    for (let step = 0; step < MAX_STEPS; step++) {
      if (!bot.connected || bot.despawned) break;

      const result = await cm.revivalTick(bot);
      if (step === 0) allSenders = result.senders;

      // Debug mode: emit thinking + tool calls as in-game chat
      if (bot.debugChat && bot.connected && !bot.despawned) {
        const dbgMessages = [];
        if (result.rawThinking) {
          const think = result.rawThinking.replace(/\n/g, ' ').slice(0, 200);
          dbgMessages.push(`[think] ${think}`);
        }
        for (const action of result.actions) {
          const args = Object.keys(action.params).length > 0
            ? `(${JSON.stringify(action.params)})` : '()';
          dbgMessages.push(`[tool] ${action.name}${args}`.slice(0, 256));
        }
        if (dbgMessages.length === 0) {
          dbgMessages.push('[think] (idle — no action)');
        }
        for (const msg of dbgMessages) {
          console.log(`[DBG] ${bot.username}: ${msg}`);
          try { bot.bot.chat(msg); } catch (e) { console.log(`[DBG] chat error: ${e.message}`); }
          await new Promise(r => setTimeout(r, 350));
        }
      }

      const logBefore = bot.actionLog.length;
      for (const action of result.actions) {
        await executeRevivalAction(bot, action.name, action.params);
      }

      // Debug mode: emit action results
      if (bot.debugChat && bot.connected && !bot.despawned) {
        const newEntries = bot.actionLog.slice(logBefore);
        for (const entry of newEntries) {
          const prefix = entry.type.includes('fail') ? '[FAIL]'
            : entry.type.includes('success') ? '[OK]'
            : entry.type.includes('partial') ? '[PARTIAL]'
            : `[${entry.type}]`;
          const dbgMsg = `${prefix} ${entry.detail}`.slice(0, 256);
          console.log(`[DBG Chat] ${bot.username}: ${dbgMsg}`);
          bot.bot.chat(dbgMsg);
          await new Promise(r => setTimeout(r, 300));
        }
      }

      // Keep the latest chat — will only be sent after the loop ends
      if (result.chat) lastChat = result.chat;

      // Chain if actions produced new log entries (results the LLM should see)
      const newLogs = bot.actionLog.length - logBefore;
      if (result.actions.length === 0 || newLogs === 0) break;
      // Skip further chaining if owner sent a message mid-tick (handle it on next tick instead)
      if (bot._abortIdleTick) {
        console.log(`[Revival Tick] ${bot.username} breaking chain — owner message pending`);
        break;
      }
      console.log(`[Revival Tick] ${bot.username} chaining step ${step + 1}/${MAX_STEPS} (${newLogs} new log entries)`);
    }

    // Send chat AFTER all chaining is done (so it reflects actual results)
    if (lastChat && bot.connected && !bot.despawned) {
      const delay = 500 + Math.random() * 1500;
      console.log(`[Revival Chat] ${bot.username} (${Math.round(delay / 1000)}s): ${lastChat}`);
      await new Promise(r => setTimeout(r, delay));
      if (bot.connected && !bot.despawned) {
        bot.chat(lastChat);
        for (const sender of allSenders) {
          cm.trackConversation(sender, bot.username);
        }
        // Fire-and-forget memory evaluation (mirrors regular bot behavior)
        const recentMsgs = bot.actionLog.slice(-5).map(e => `[${e.type}] ${e.detail}`).join('\n');
        const snippet = `${recentMsgs}\n<${bot.username}> ${lastChat}`;
        cm.evaluateMemory(bot.username, snippet);
      }
    }
  };
}

async function handleRevival(reviver, deadPlayer, pos) {
  console.log(`[Revival] Handling revival: ${reviver} revived ${deadPlayer} at ${pos.x},${pos.y},${pos.z}`);

  if (revivalBots.has(deadPlayer)) {
    console.log(`[Revival] ${deadPlayer} already has an active revival bot`);
    return;
  }
  if (revivalBots.size >= MAX_REVIVAL_BOTS) {
    console.log(`[Revival] Max revival bots (${MAX_REVIVAL_BOTS}) reached`);
    return;
  }

  const existingBot = botsByName.get(deadPlayer);
  if (existingBot) {
    console.log(`[Revival] Parking regular chatbot ${deadPlayer} for revival`);
    existingBot.park(0);
    migrateGlobalChatListener();
  }

  let profile;
  try {
    profile = await getPlayerProfile(deadPlayer);
    console.log(`[Revival] Profile for ${deadPlayer}: ${profile.personality?.slice(0, 80)}...`);
  } catch (err) {
    console.error(`[Revival] Profile generation failed: ${err.message}`);
    profile = {
      personality: 'A confused player who just woke up from the dead.',
      chatStyle: 'Short lowercase messages, dazed tone.',
      samplePhrases: ['huh', 'where am i', 'what happened']
    };
  }

  const rBot = new RevivalBot({
    deadPlayer,
    reviver,
    pos,
    profile,
    conversationManager: cm,
    config: botConfig
  });

  wireRevivalBot(rBot);
  revivalBots.set(deadPlayer, rBot);
  saveRevivalState();
  rBot.connect();

  // After connecting: teleport to ritual location, queue greeting for agent loop
  const waitForConnect = setInterval(() => {
    if (rBot.connected) {
      clearInterval(waitForConnect);
      const { x, y, z } = pos;
      rcon(`tp ${deadPlayer} ${x} ${y} ${z}`).then(resp => {
        console.log(`[Revival] Teleported ${deadPlayer} to ${x},${y},${z}: ${resp}`);
      }).catch(err => {
        console.error(`[Revival] Teleport failed: ${err.message}`);
      });
      // Start the agent loop so periodic ticks fire
      rBot.startAgentLoop();

      setTimeout(() => {
        if (rBot.connected && !rBot.despawned) {
          rBot.queueMessage('__system__', `You were just revived by ${reviver}. Greet them warmly but briefly, in your style.`);
        }
      }, 2000);
    }
    if (rBot.despawned) clearInterval(waitForConnect);
  }, 1000);
}

// Restore revival bots from previous session
async function restoreRevivals() {
  const saved = loadRevivalState();
  if (saved.length === 0) return;
  console.log(`[Revival] Restoring ${saved.length} revival bot(s) from previous session`);

  for (const s of saved) {
    const existingBot = botsByName.get(s.deadPlayer);
    if (existingBot) { existingBot.park(0); migrateGlobalChatListener(); }

    const rBot = new RevivalBot({
      deadPlayer: s.deadPlayer,
      reviver: s.reviver,
      pos: s.pos,
      profile: s.profile,
      conversationManager: cm,
      config: botConfig
    });

    // Restore agent memory
    if (s.objectives) rBot.objectives = s.objectives;
    if (s.actionLog) rBot.actionLog = s.actionLog;
    if (s.createdAt) rBot.revivalInfo.time = s.createdAt;

    wireRevivalBot(rBot);
    revivalBots.set(s.deadPlayer, rBot);

    // If it was suspended, restore in suspended state (wait for owner to join)
    if (s.suspended) {
      rBot.suspended = true;
      rBot._suspendPos = s.pos;
      console.log(`[Revival] Restoring ${s.deadPlayer} as suspended (owner: ${s.reviver})`);
      continue;
    }

    rBot.connect();

    // Pardon + teleport after connect (in case server also restarted)
    const waitForConnect = setInterval(() => {
      if (rBot.connected) {
        clearInterval(waitForConnect);
        rcon(`pardon ${s.deadPlayer}`).catch(() => {});
        const { x, y, z } = s.pos;
        rcon(`tp ${s.deadPlayer} ${x} ${y} ${z}`).then(resp => {
          console.log(`[Revival] Restored & teleported ${s.deadPlayer}: ${resp}`);
        }).catch(() => {});
        rBot.startAgentLoop();
        rBot.log('restored', `Reconnected after restart (owner: ${s.reviver})`);
      }
      if (rBot.despawned) clearInterval(waitForConnect);
    }, 1000);

    console.log(`[Revival] Restoring ${s.deadPlayer} (owner: ${s.reviver})`);
  }
}

// ── Webhook server ───────────────────────────────────────────────────

function setupWebhookServer() {
  const port = parseInt(process.env.WEBHOOK_PORT) || 8765;
  const secret = process.env.WEBHOOK_SECRET || '';

  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/revival') {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);

        // Verify secret
        if (secret && data.secret !== secret) {
          console.log('[Webhook] Invalid secret');
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }

        const { reviver, deadPlayer, x, y, z } = data;
        if (!reviver || !deadPlayer) {
          res.writeHead(400);
          res.end('Missing fields');
          return;
        }
        if (reviver === deadPlayer) {
          console.log('[Webhook] Ignoring self-revival');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ignored', reason: 'self-revival' }));
          return;
        }

        console.log(`[Webhook] Revival request: ${reviver} → ${deadPlayer} at ${x},${y},${z}`);
        handleRevival(reviver, deadPlayer, { x, y, z });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } catch (err) {
        console.error(`[Webhook] Error: ${err.message}`);
        res.writeHead(500);
        res.end('Server error');
      }
    });
  });

  server.listen(port, () => {
    console.log(`[Webhook] Revival webhook listening on :${port}`);
  });
}

// ── Revival action executor ─────────────────────────────────────────

async function executeRevivalAction(rBot, actionName, params) {
  console.log(`[Revival Action] ${rBot.username}: ${actionName}(${JSON.stringify(params)})`);
  switch (actionName) {
    case 'follow_owner': rBot._cmdFollow(); break;
    case 'follow_player': rBot._cmdFollowPlayer(params.player); break;
    case 'come_here': rBot._cmdCome(); break;
    case 'stop': rBot._cmdStop(); break;
    case 'guard': rBot._cmdGuard(); break;
    case 'mine': await rBot._cmdMine(params.block, params.count || 16); break;
    case 'attack': await rBot._cmdAttack(params.mob, params.count || 1); break;
    case 'drop_item': rBot._cmdDrop(params.item, params.count); break;
    case 'drop_all': await rBot._cmdDropAll(); break;
    case 'give_item': rBot._cmdGive(params.player, params.item, params.count); break;
    case 'check_chests': await rBot._cmdCheckChests(); break;
    case 'take_from_chest': await rBot._cmdTakeFromChest(params.item, params.count); break;
    case 'deposit_in_chest': await rBot._cmdDepositInChest(params.item, params.count); break;
    case 'deposit_all': await rBot._cmdDepositAll(); break;
    case 'craft_item': await rBot._cmdCraft(params.item, params.count || 1); break;
    case 'smelt': await rBot._cmdSmelt(params.item, params.fuel || 'coal', params.count || 1); break;
    case 'equip_item': rBot._cmdEquip(params.item); break;
    case 'eat': await rBot._cmdEat(); break;
    case 'whisper':
      if (params.player && params.message) {
        rBot.bot.chat(`/msg ${params.player} ${params.message}`);
        rBot.log('whisper', `Whispered to ${params.player}: ${params.message}`);
      }
      break;
    case 'dismiss': rBot._cmdDismiss(); break;
    case 'ask_clarification':
      if (params.question) rBot.chat(params.question);
      break;
    case 'set_objective': rBot.addObjective(params.text, params.priority || 'normal'); break;
    case 'complete_objective':
      rBot.completeObjective(params.text);
      cm.addMemory(rBot.username, `Completed objective: ${params.text}`);
      break;
    case 'clear_objectives': rBot.clearObjectives(); break;
    default: console.log(`[Revival Action] Unknown action: ${actionName}`);
  }
}

// ── Player chat handler ─────────────────────────────────────────────

async function handlePlayerChat(username, message) {
  console.log(`[Chat] ${username}: "${message}"`);
  // Add to shared history ONCE (this is the single source of truth)
  if (!botNames.includes(username)) {
    cm.addMessage(username, message);
  }

  if (botNames.includes(username)) return; // don't process bot messages here

  // 0a. Debug toggle: "debug" or "debug <botname>" toggles debug chat for the owner's bot
  const msgLower = message.toLowerCase();
  if (msgLower === 'debug' || msgLower.startsWith('debug ')) {
    // If "debug botname", find that specific bot; otherwise toggle all owned bots
    const debugArg = msgLower.replace(/^debug\s*/, '').trim();
    for (const [deadName, rBot] of revivalBots) {
      if (rBot.owner !== username || !rBot.connected) continue;
      if (debugArg) {
        const nameClean = deadName.toLowerCase().replace(/[_\s]/g, '');
        const argClean = debugArg.replace(/[_\s]/g, '');
        if (!nameClean.includes(argClean) && !deadName.toLowerCase().includes(debugArg)) continue;
      }
      rBot.debugChat = !rBot.debugChat;
      const status = rBot.debugChat ? 'ON' : 'OFF';
      console.log(`[Debug] ${username} toggled debug for ${rBot.username}: ${status}`);
      rBot.bot.chat(`[dbg] debug mode ${status}`);
    }
    return;
  }

  // 0. Revival bot interaction — queue message for agent tick
  //    Fuzzy name matching: "pepperoni dude" matches "pepperoni_dude", "zold" matches "Zold_"
  const ownedBots = [];
  const mentionedBots = [];
  for (const [deadName, rBot] of revivalBots) {
    if (!rBot.connected) continue;
    if (rBot.owner === username) ownedBots.push(rBot);
    // Fuzzy match: check each word in the message against cleaned bot name variants
    const nameClean = deadName.toLowerCase().replace(/[_\s]/g, '');
    const nameLower = deadName.toLowerCase();
    const msgWords = msgLower.split(/[\s,]+/);
    const mentioned = msgWords.some(w => {
      const wClean = w.replace(/[_\s]/g, '');
      return wClean === nameClean || wClean === nameLower
        || nameClean.startsWith(wClean) && wClean.length >= 3; // "brezzy" matches "brezzytracks"
    }) || msgLower.includes(nameLower);
    if (mentioned) mentionedBots.push(rBot);
  }
  // Routing rules:
  // 1. Owner mentions a specific bot by name → route to that bot
  // 2. Owner has only one bot → route to it
  // 3. Owner has multiple bots but didn't mention one → route to all owned bots
  // 4. Non-owner mentioning a bot by name → route to that bot
  // Check if message mentions a regular chatbot — if so, skip revival routing for that message
  const mentionsRegularBot = findMentionedBots(message, personalities).length > 0;

  if (!mentionsRegularBot) {
    if (ownedBots.length > 0) {
      // Check if the owner mentioned a specific bot they own
      const ownedMentioned = mentionedBots.filter(b => b.owner === username);
      if (ownedMentioned.length > 0) {
        for (const target of ownedMentioned) {
          console.log(`[Revival] "${message}" → ${target.username} (owner+mention)`);
          target.queueMessage(username, message);
        }
      } else if (ownedBots.length === 1) {
        console.log(`[Revival] "${message}" → ${ownedBots[0].username} (owner)`);
        ownedBots[0].queueMessage(username, message);
      } else {
        // Multiple bots, no mention — send to the most recently messaged one
        const sorted = ownedBots.sort((a, b) => {
          const aLast = a.pendingMessages.length > 0 ? a.pendingMessages[a.pendingMessages.length - 1].timestamp
            : a.actionLog.length > 0 ? a.actionLog[a.actionLog.length - 1].timestamp : 0;
          const bLast = b.pendingMessages.length > 0 ? b.pendingMessages[b.pendingMessages.length - 1].timestamp
            : b.actionLog.length > 0 ? b.actionLog[b.actionLog.length - 1].timestamp : 0;
          return bLast - aLast;
        });
        const target = sorted[0];
        console.log(`[Revival] "${message}" → ${target.username} (owner, most recent)`);
        target.queueMessage(username, message);
      }
      return;
    }
    if (mentionedBots.length > 0) {
      const target = mentionedBots[0];
      console.log(`[Revival] "${message}" → ${target.username} (mention)`);
      target.queueMessage(username, message);
      return;
    }
  }

  if (cm.isRateLimited()) return;

  // 1. Direct mentions — dispatch to ALL mentioned bots
  const mentioned = findMentionedBots(message, personalities);
  if (mentioned.length > 0) {
    for (const botName of mentioned) {
      const mbot = botsByName.get(botName);
      console.log(`[Mention] "${message}" → ${botName} (connected=${mbot?.connected}, parked=${mbot?.parked}, muted=${mbot?.muted})`);
      dispatchResponse(mbot, 'Mention', username);
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

let globalChatListenerBot = null; // track which bot has the global chat listener

function attachGlobalChatListener(leader) {
  if (globalChatListenerBot === leader) return; // already attached to this bot
  globalChatListenerBot = leader;

  // Chat arrives as system_chat (LPC/FreedomChat converts player_chat → system_chat)
  leader.bot.on('message', (jsonMsg, position) => {
    if (globalChatListenerBot !== leader) return; // stale listener
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

  console.log(`Global chat listener active on ${leader.username} (player_chat + system_chat fallback).`);
}

// Re-attach global chat listener to a different connected, non-parked bot
function migrateGlobalChatListener() {
  const candidate = bots.find(b => b.connected && !b.parked && b.bot?._client);
  if (candidate && candidate !== globalChatListenerBot) {
    console.log(`[ChatListener] Migrating from ${globalChatListenerBot?.username || 'none'} to ${candidate.username}`);
    attachGlobalChatListener(candidate);
  }
}

function setupGlobalChatListener() {
  const leader = bots[0];
  const checkReady = setInterval(() => {
    if (leader.bot && leader.bot._client) {
      clearInterval(checkReady);
      attachGlobalChatListener(leader);
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

      // Chat arrives as system_chat (LPC/FreedomChat)
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
      migrateGlobalChatListener();
      console.log(`[Scaler] ${realPlayers} players → target ${target} bots (parking ${topark.map(b => b.username).join(', ')})`);
    }
  } else if (active.length < target && parked.length > 0) {
    // Unpark — randomly pick from parked bots (skip those with active revival bots)
    const shuffled = [...parked].filter(b => !revivalBots.has(b.username) && !b.deathBanned).sort(() => Math.random() - 0.5);
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
    const activeSwappable = bots.filter(b => !b.parked && b !== bots[0] && !b.priority && !b.deathBanned);
    const parked = bots.filter(b => b.parked && !b.deathBanned);
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
  setupWebhookServer();
  // Restore revival bots from previous session (survives restarts)
  restoreRevivals();
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
          if (!bot.bot) return;
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
  // Save revival state before disconnecting so they survive restart
  saveRevivalState();
  // Disconnect revival bots (but state is already saved)
  for (const [name, rBot] of revivalBots) {
    rBot.despawned = true; // prevent _onDespawn from clearing saved state
    if (rBot.bot && rBot.connected) {
      try { rBot.bot.end(); } catch {}
    }
  }
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

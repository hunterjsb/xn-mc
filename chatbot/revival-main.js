/**
 * Revival bot process — runs independently from regular chatbots.
 * PM2 name: xandaris-revival
 *
 * Manages revival bot lifecycle, webhook server, per-bot chat listeners,
 * and owner-return detection. Writes revival-names.json so the regular
 * chatbot process can filter revival bot names from player counts.
 */

import './env.js';
import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import crypto from 'crypto';
import { RevivalBot } from './revival-bot.js';
import { getPlayerProfile } from './distill-player.js';
import { ConversationManager, discordRevivalEmbed } from './conversation.js';
import { rcon, parseChatFromSystem, resolveUsername } from './shared.js';

function offlineUUID(username) {
  const md5 = crypto.createHash('md5').update('OfflinePlayer:' + username).digest();
  md5[6] = (md5[6] & 0x0f) | 0x30;
  md5[8] = (md5[8] & 0x3f) | 0x80;
  const hex = md5.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

// Load regular chatbot names so we can ignore their messages in revival chat listeners
const chatbotNames = new Set(
  JSON.parse(readFileSync(new URL('./personalities.json', import.meta.url), 'utf-8'))
    .map(p => p.username.toLowerCase())
);

const MAX_REVIVAL_BOTS = 5;
const REVIVAL_STATE_FILE = './revival-state.json';
const REVIVAL_NAMES_FILE = './revival-names.json';
const NAME_POOL_FILE = './revival-name-pool.json';

// ── Name pool for revival bots ───────────────────────────────────────
const namePool = JSON.parse(readFileSync(new URL(NAME_POOL_FILE, import.meta.url), 'utf-8'));
const usedNames = new Set(); // tracks names in use this session

function pickRevivalName() {
  // Filter out names currently in use (active bots) or already used this session
  const activeBotNames = new Set([...revivalBots.values()].map(b => b.username));
  const available = namePool.filter(n => !activeBotNames.has(n) && !usedNames.has(n) && !chatbotNames.has(n.toLowerCase()));
  if (available.length === 0) {
    // Fallback: reset used names and try again (only exclude currently active)
    usedNames.clear();
    const retry = namePool.filter(n => !activeBotNames.has(n) && !chatbotNames.has(n.toLowerCase()));
    if (retry.length === 0) return null;
    const name = retry[Math.floor(Math.random() * retry.length)];
    usedNames.add(name);
    return name;
  }
  const name = available[Math.floor(Math.random() * available.length)];
  usedNames.add(name);
  return name;
}

const botConfig = {
  host: process.env.MC_HOST || 'localhost',
  port: parseInt(process.env.MC_PORT) || 25565
};

const cm = new ConversationManager({
  maxInWindow: Infinity,
  rateLimitWindowMin: 5
});

const revivalBots = new Map(); // deadPlayer → RevivalBot

console.log('=== Xandaris Revival Bots ===');
console.log(`Config: ${botConfig.host}:${botConfig.port}`);

// ── Revival names file (coordination with regular bot process) ────────

function writeRevivalNames() {
  try {
    const botNames = [...revivalBots.values()].map(b => b.username);
    writeFileSync(REVIVAL_NAMES_FILE, JSON.stringify(botNames));
  } catch {}
}

// ── Revival state persistence ─────────────────────────────────────────

function saveRevivalState() {
  const state = [];
  for (const [name, rBot] of revivalBots) {
    if (rBot.despawned) continue;
    state.push({
      deadPlayer: rBot.deadPlayer,
      botName: rBot.username,
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
    const twoHours = 2 * 60 * 60 * 1000;
    return data.filter(s => Date.now() - s.createdAt < twoHours);
  } catch { return []; }
}

// ── Per-bot chat listener ─────────────────────────────────────────────

function attachChatListener(rBot) {
  if (!rBot.bot) return;

  const allBotNames = () => [...revivalBots.keys()];

  rBot.bot.on('message', (jsonMsg, position) => {
    if (position === 'game_info') return;
    const text = jsonMsg.toString();
    if (!text || text.length < 3) return;

    const parsed = parseChatFromSystem(text);
    if (!parsed) return;

    const username = resolveUsername(rBot.bot.players, parsed.nickname);
    if (!username) return;
    // Ignore messages from revival bots and regular chatbots
    if (allBotNames().includes(username)) return;
    if (chatbotNames.has(username.toLowerCase())) return;

    const message = parsed.message;
    const msgLower = message.toLowerCase();

    // Debug toggle
    if (msgLower === 'debug' || msgLower.startsWith('debug ')) {
      if (rBot.owner !== username || !rBot.connected) return;
      const debugArg = msgLower.replace(/^debug\s*/, '').trim();
      if (debugArg) {
        const nameClean = rBot.username.toLowerCase().replace(/[_\s]/g, '');
        const argClean = debugArg.replace(/[_\s]/g, '');
        if (!nameClean.includes(argClean) && !rBot.username.toLowerCase().includes(debugArg)) return;
      }
      rBot.debugChat = !rBot.debugChat;
      const status = rBot.debugChat ? 'ON' : 'OFF';
      console.log(`[Debug] ${username} toggled debug for ${rBot.username}: ${status}`);
      rBot.bot.chat(`[dbg] debug mode ${status}`);
      return;
    }

    // Route: owner → always queue
    if (rBot.owner === username) {
      console.log(`[Revival] "${message}" → ${rBot.username} (owner)`);
      rBot.queueMessage(username, message);
      cm.addMessage(username, message);
      return;
    }

    // Route: mentioned by name
    const nameClean = rBot.username.toLowerCase().replace(/[_\s]/g, '');
    const nameLower = rBot.username.toLowerCase();
    const msgWords = msgLower.split(/[\s,]+/);
    const mentioned = msgWords.some(w => {
      const wClean = w.replace(/[_\s]/g, '');
      return wClean === nameClean || wClean === nameLower
        || nameClean.startsWith(wClean) && wClean.length >= 3;
    }) || msgLower.includes(nameLower);

    if (mentioned) {
      console.log(`[Revival] "${message}" → ${rBot.username} (mention)`);
      rBot.queueMessage(username, message);
      cm.addMessage(username, message);
    }
  });
}

// ── Owner-return detection on each connected bot ──────────────────────

function attachOwnerReturnListener(rBot) {
  if (!rBot.bot) return;

  rBot.bot.on('playerJoined', (player) => {
    if (!player.username) return;

    // Check all suspended bots for owner match
    for (const [deadName, rb] of revivalBots) {
      if (rb.suspended && rb.owner === player.username) {
        console.log(`[Revival] Owner ${player.username} returned — resuming ${deadName}`);
        rb.resume();
        const waitForConnect = setInterval(() => {
          if (rb.connected) {
            clearInterval(waitForConnect);
            const pos = rb._suspendPos || rb.spawnPos;
            rcon(`tp ${deadName} ${pos.x} ${pos.y} ${pos.z}`).then(resp => {
              console.log(`[Revival] Resumed & teleported ${deadName}: ${resp}`);
            }).catch(() => {});
          }
        }, 500);
        setTimeout(() => clearInterval(waitForConnect), 30000);
      }
    }
  });
}

// ── Wire up revival bot callbacks ─────────────────────────────────────

function wireRevivalBot(rBot) {
  rBot._onDespawn = (username, reason) => {
    console.log(`[Revival] Cleaning up ${username} (${reason})`);
    revivalBots.delete(rBot.deadPlayer);
    saveRevivalState();
    writeRevivalNames();
    rcon(`lp user ${offlineUUID(username)} permission unset grim.exempt`).catch(() => {});
    // Re-pardon the original dead player after bot death so DeathBan doesn't keep them banned
    if (reason === 'death') {
      rcon(`pardon ${rBot.deadPlayer}`).catch(() => {});
    }
  };

  rBot._onSuspend = (username) => {
    saveRevivalState();
  };

  // Benchmark event tracking
  rBot._benchLog = [];
  rBot._benchStart = null;

  // Agent loop tick
  rBot._onTick = async (bot) => {
    const MAX_STEPS = 3;
    let allSenders = [];
    let lastChat = null;

    for (let step = 0; step < MAX_STEPS; step++) {
      if (!bot.connected || bot.despawned) break;

      const result = await cm.revivalTick(bot);
      if (step === 0) allSenders = result.senders;

      // Bench tracking: log tool calls
      for (const action of result.actions) {
        bot._benchLog.push({ type: 'tool', name: action.name, params: action.params, t: Date.now() });
      }
      if (result.chat) {
        bot._benchLog.push({ type: 'chat', text: result.chat, t: Date.now() });
      }
      if (result.actions.length === 0 && !result.chat) {
        bot._benchLog.push({ type: 'idle', t: Date.now() });
      }

      // Debug mode
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

      // Bench tracking: log action results
      for (const entry of bot.actionLog.slice(logBefore)) {
        bot._benchLog.push({ type: 'result', detail: entry.detail, result: entry.type, t: Date.now() });
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

      if (result.chat) lastChat = result.chat;

      const newLogs = bot.actionLog.length - logBefore;
      if (result.actions.length === 0 || newLogs === 0) break;
      if (bot._abortIdleTick) {
        console.log(`[Revival Tick] ${bot.username} breaking chain — owner message pending`);
        break;
      }
      console.log(`[Revival Tick] ${bot.username} chaining step ${step + 1}/${MAX_STEPS} (${newLogs} new log entries)`);
    }

    // Send chat AFTER all chaining is done
    if (lastChat && bot.connected && !bot.despawned) {
      const delay = 500 + Math.random() * 1500;
      console.log(`[Revival Chat] ${bot.username} (${Math.round(delay / 1000)}s): ${lastChat}`);
      await new Promise(r => setTimeout(r, delay));
      if (bot.connected && !bot.despawned) {
        bot.chat(lastChat);
        for (const sender of allSenders) {
          cm.trackConversation(sender, bot.username);
        }
        const recentMsgs = bot.actionLog.slice(-5).map(e => `[${e.type}] ${e.detail}`).join('\n');
        const snippet = `${recentMsgs}\n<${bot.username}> ${lastChat}`;
        cm.evaluateMemory(bot.username, snippet);
      }
    }
  };
}

// ── Revival action executor ─────────────────────────────────────────

async function executeRevivalAction(rBot, actionName, params) {
  console.log(`[Revival Action] ${rBot.username}: ${actionName}(${JSON.stringify(params)})`);
  switch (actionName) {
    case 'follow': rBot._cmdFollowPlayer(params.player || rBot.owner); break;
    case 'come_here': rBot._cmdCome(); break;
    case 'stop': rBot._cmdStop(); break;
    case 'guard': rBot._cmdGuard(); break;
    case 'mine': await rBot._cmdMine(params.block, params.count || 16); break;
    case 'attack': await rBot._cmdAttack(params.mob, params.count || 1); break;
    case 'pickup': await rBot._cmdPickup(params.item); break;
    case 'drop':
      if (params.item) rBot._cmdDrop(params.item, params.count);
      else await rBot._cmdDropAll();
      break;
    case 'give': rBot._cmdGive(params.player, params.item, params.count); break;
    case 'chest':
      switch (params.action) {
        case 'check': await rBot._cmdCheckChests(); break;
        case 'take': await rBot._cmdTakeFromChest(params.item, params.count); break;
        case 'deposit':
          if (params.item) await rBot._cmdDepositInChest(params.item, params.count);
          else await rBot._cmdDepositAll();
          break;
      }
      break;
    case 'craft': await rBot._cmdCraft(params.item, params.count || 1); break;
    case 'equip': await rBot._cmdEquip(params.item); break;
    case 'smelt': await rBot._cmdSmelt(params.item, params.fuel || 'coal', params.count || 1); break;
    case 'eat': await rBot._cmdEat(); break;
    case 'sleep': await rBot._cmdSleep(); break;
    case 'place': await rBot._cmdPlace(params.block, params.direction || 'forward'); break;
    case 'whisper':
      if (params.player && params.message) {
        rBot.bot.chat(`/msg ${params.player} ${params.message}`);
        rBot.log('whisper', `Whispered to ${params.player}: ${params.message}`);
      }
      break;
    case 'dismiss': rBot._cmdDismiss(); break;
    case 'remember':
      if (params.text) cm.addMemory(rBot.username, params.text);
      break;
    case 'objective':
      if (params.action === 'set') rBot.addObjective(params.text, params.priority || 'normal');
      else if (params.action === 'complete') {
        rBot.completeObjective(params.text);
        cm.addMemory(rBot.username, `Completed objective: ${params.text}`);
      }
      else if (params.action === 'clear') rBot.clearObjectives();
      break;
    default: console.log(`[Revival Action] Unknown action: ${actionName}`);
  }
}

// ── Handle a new revival ──────────────────────────────────────────────

async function handleRevival(reviver, deadPlayer, pos, opts = {}) {
  console.log(`[Revival] Handling revival: ${reviver} revived ${deadPlayer} at ${pos.x},${pos.y},${pos.z}`);

  if (revivalBots.has(deadPlayer)) {
    console.log(`[Revival] ${deadPlayer} already has an active revival bot`);
    return;
  }
  if (revivalBots.size >= MAX_REVIVAL_BOTS) {
    console.log(`[Revival] Max revival bots (${MAX_REVIVAL_BOTS}) reached`);
    return;
  }

  // Allow callers (e.g. benchmarks) to specify the bot name directly
  const botName = opts.botName || pickRevivalName();
  if (!botName) {
    console.error(`[Revival] No available names in pool!`);
    return;
  }
  console.log(`[Revival] ${opts.botName ? 'Using explicit' : 'Picked'} name "${botName}" for ${deadPlayer}'s revival`);

  // Allow callers to provide a pre-built profile (skip LLM distillation)
  let profile;
  if (opts.profile) {
    profile = opts.profile;
  } else {
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
  }

  const rBot = new RevivalBot({
    deadPlayer,
    botName,
    reviver,
    pos,
    profile,
    conversationManager: cm,
    config: botConfig
  });

  wireRevivalBot(rBot);
  revivalBots.set(deadPlayer, rBot);
  saveRevivalState();
  writeRevivalNames();
  rBot.connect();

  const waitForConnect = setInterval(() => {
    if (rBot.connected) {
      clearInterval(waitForConnect);

      // Attach per-bot chat listener and owner-return detection
      attachChatListener(rBot);
      attachOwnerReturnListener(rBot);

      const { x, y, z } = pos;
      rcon(`gamemode survival ${botName}`).catch(() => {});
      rcon(`tp ${botName} ${x} ${y} ${z}`).then(resp => {
        console.log(`[Revival] Teleported ${botName} (revival of ${deadPlayer}) to ${x},${y},${z}: ${resp}`);
        discordRevivalEmbed(deadPlayer, reviver);
      }).catch(err => {
        console.error(`[Revival] Teleport failed: ${err.message}`);
      });
      rcon(`lp user ${offlineUUID(botName)} permission set grim.exempt true`).catch(() => {});
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

// ── Restore revival bots from previous session ────────────────────────

async function restoreRevivals() {
  const saved = loadRevivalState();
  if (saved.length === 0) return;
  console.log(`[Revival] Restoring ${saved.length} revival bot(s) from previous session`);

  for (const s of saved) {
    // Use saved botName, or pick a new one if restoring old-format state
    const botName = s.botName || pickRevivalName() || s.deadPlayer;
    if (s.botName) usedNames.add(s.botName);

    const rBot = new RevivalBot({
      deadPlayer: s.deadPlayer,
      botName,
      reviver: s.reviver,
      pos: s.pos,
      profile: s.profile,
      conversationManager: cm,
      config: botConfig
    });

    if (s.objectives) rBot.objectives = s.objectives;
    if (s.actionLog) rBot.actionLog = s.actionLog;
    if (s.createdAt) rBot.revivalInfo.time = s.createdAt;

    wireRevivalBot(rBot);
    revivalBots.set(s.deadPlayer, rBot);

    if (s.suspended) {
      rBot.suspended = true;
      rBot._suspendPos = s.pos;
      console.log(`[Revival] Restoring ${s.deadPlayer} as ${botName} (suspended, owner: ${s.reviver})`);
      continue;
    }

    rBot.connect();

    const waitForConnect = setInterval(() => {
      if (rBot.connected) {
        clearInterval(waitForConnect);

        // Attach per-bot chat listener and owner-return detection
        attachChatListener(rBot);
        attachOwnerReturnListener(rBot);

        rcon(`gamemode survival ${botName}`).catch(() => {});
        rcon(`lp user ${offlineUUID(botName)} permission set grim.exempt true`).catch(() => {});
        const { x, y, z } = s.pos;
        rcon(`tp ${botName} ${x} ${y} ${z}`).then(resp => {
          console.log(`[Revival] Restored & teleported ${botName} (revival of ${s.deadPlayer}): ${resp}`);
        }).catch(() => {});
        rBot.startAgentLoop();
        rBot.log('restored', `Reconnected after restart (owner: ${s.reviver})`);
      }
      if (rBot.despawned) clearInterval(waitForConnect);
    }, 1000);

    console.log(`[Revival] Restoring ${s.deadPlayer} as ${botName} (owner: ${s.reviver})`);
  }

  writeRevivalNames();
}

// ── Webhook server ────────────────────────────────────────────────────

function setupWebhookServer() {
  const port = parseInt(process.env.WEBHOOK_PORT) || 8765;
  const secret = process.env.WEBHOOK_SECRET || '';

  const server = createServer((req, res) => {
    // GET /rblist
    if (req.method === 'GET' && req.url === '/rblist') {
      const list = [];
      for (const [deadPlayer, rBot] of revivalBots) {
        list.push({
          name: rBot.username,
          deadPlayer,
          owner: rBot.owner,
          state: rBot.state,
          connected: rBot.connected,
          objectives: rBot.objectives || [],
          pending: rBot.pendingMessages.length,
        });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ bots: list }, null, 2));
      return;
    }

    // GET /bench/metrics?bot=NAME
    if (req.method === 'GET' && req.url.startsWith('/bench/metrics')) {
      const url = new URL(req.url, 'http://localhost');
      const botName = url.searchParams.get('bot');
      let rBot;
      for (const [name, rb] of revivalBots) {
        if (name.toLowerCase() === botName?.toLowerCase() || rb.username.toLowerCase() === botName?.toLowerCase()) { rBot = rb; break; }
      }
      if (!rBot) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: `No bot "${botName}"` }));
        return;
      }
      const toolCalls = rBot._benchLog.filter(e => e.type === 'tool');
      const chats = rBot._benchLog.filter(e => e.type === 'chat');
      const idles = rBot._benchLog.filter(e => e.type === 'idle');
      const results = rBot._benchLog.filter(e => e.type === 'result');
      const failures = results.filter(e => e.result?.includes('fail'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        bot: rBot.username,
        benchStart: rBot._benchStart,
        elapsed: rBot._benchStart ? Date.now() - rBot._benchStart : null,
        state: rBot.state,
        objectives: rBot.objectives,
        totalToolCalls: toolCalls.length,
        totalChats: chats.length,
        totalIdles: idles.length,
        totalFailures: failures.length,
        log: rBot._benchLog,
      }, null, 2));
      return;
    }

    // POST /bench/reset?bot=NAME — clear bench log and start timer
    if (req.method === 'POST' && req.url.startsWith('/bench/reset')) {
      const url = new URL(req.url, 'http://localhost');
      const botName = url.searchParams.get('bot');
      let rBot;
      for (const [name, rb] of revivalBots) {
        if (name.toLowerCase() === botName?.toLowerCase() || rb.username.toLowerCase() === botName?.toLowerCase()) { rBot = rb; break; }
      }
      if (!rBot) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: `No bot "${botName}"` }));
        return;
      }
      rBot._benchLog = [];
      rBot._benchStart = Date.now();
      rBot._benchMode = true;    // benchmark mode — focuses LLM on task
      rBot.clearObjectives();    // clear stale objectives from greeting/previous bench
      rBot.actionLog.length = 0; // clear action log so LLM doesn't see stale context
      rBot.tickHistory.length = 0;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', benchStart: rBot._benchStart }));
      return;
    }

    // POST /rbsay
    if (req.method === 'POST' && req.url === '/rbsay') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          const { bot: botName, message } = data;
          if (!botName || !message) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Missing bot or message' }));
            return;
          }
          let rBot;
          for (const [deadName, rb] of revivalBots) {
            // Match by dead player name or bot username
            if (deadName.toLowerCase() === botName.toLowerCase()
                || rb.username.toLowerCase() === botName.toLowerCase()) {
              rBot = rb; break;
            }
          }
          if (!rBot || !rBot.connected) {
            res.writeHead(404);
            const available = [...revivalBots.values()].map(b => `${b.username} (${b.deadPlayer})`);
            res.end(JSON.stringify({ error: `No active revival bot "${botName}"`, available }));
            return;
          }
          const sender = data.as || rBot.owner;
          rBot.queueMessage(sender, message);
          cm.addMessage(sender, message);
          console.log(`[Webhook] rbsay: ${sender} → ${rBot.username}: "${message}"`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok', bot: rBot.username, sender, message }));
        } catch (err) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // POST /revival
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

        if (secret && data.secret !== secret) {
          console.log('[Webhook] Invalid secret');
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }

        const { reviver, deadPlayer, x, y, z, botName, profile } = data;
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

        console.log(`[Webhook] Revival request: ${reviver} → ${deadPlayer} at ${x},${y},${z}${botName ? ` (as ${botName})` : ''}`);
        handleRevival(reviver, deadPlayer, { x, y, z }, { botName, profile });
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

// ── Boot ──────────────────────────────────────────────────────────────

setupWebhookServer();
restoreRevivals();

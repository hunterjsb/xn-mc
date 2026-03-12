import OpenAI from 'openai';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { containsSlur } from './slur-filter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── LLM Clients: Ollama (primary) → Grok (fallback) ───────────────
const grokClient = new OpenAI({
  apiKey: process.env.XAI_API_KEY,
  baseURL: 'https://api.x.ai/v1'
});

// OpenAI client for revival bots (GPT-5 mini)
const openaiClient = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;
const REVIVAL_MODEL = 'gpt-5-mini';

// OpenRouter client (access to grok, etc. without direct xAI credits)
const openrouterClient = process.env.OPENROUTER_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1' })
  : null;

// Ollama OpenAI-compatible client for local models via ngrok (used by getRevivalBackend for local/ models)
const ollamaClient = process.env.OLLAMA_URL
  ? new OpenAI({ apiKey: 'ollama', baseURL: process.env.OLLAMA_URL,
      defaultHeaders: { 'ngrok-skip-browser-warning': 'true' } })
  : null;

const GROK_MODEL = 'grok-4-1-fast-non-reasoning';

// Models that should use OpenAI's API directly (free tier / direct key)
const OPENAI_DIRECT_MODELS = new Set([
  'gpt-5-mini', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-4.1-nano', 'o3-mini', 'o4-mini',
]);

// Select revival LLM backend. Supports REVIVAL_MODEL env (model name) for flexible routing.
function getRevivalBackend() {
  const model = process.env.REVIVAL_MODEL;
  if (model) {
    // Route local/ prefixed models to Ollama via ngrok (OpenAI-compatible endpoint)
    if (model.startsWith('local/') && ollamaClient) {
      const ollamaModelName = model.slice('local/'.length);
      return { client: ollamaClient, model: ollamaModelName, tag: `local/${ollamaModelName}`,
        extraParams: { max_tokens: 4096, temperature: 0.6 } };
    }
    // Route OpenAI-native models to openaiClient (free tier), everything else to OpenRouter
    if (OPENAI_DIRECT_MODELS.has(model) && openaiClient) {
      return { client: openaiClient, model, tag: `openai/${model}`,
        extraParams: { max_completion_tokens: 4096 } };
    }
    if (openrouterClient) {
      return { client: openrouterClient, model, tag: `openrouter/${model}`,
        extraParams: { max_tokens: 4096, temperature: 0.6 } };
    }
    console.warn(`[RevivalBackend] Model ${model} requested but no suitable client`);
  }

  // Default: openai (gpt-5-mini) → openrouter → grok direct
  if (openaiClient) return { client: openaiClient, model: REVIVAL_MODEL, tag: 'openai',
    extraParams: { max_completion_tokens: 4096 } };
  if (openrouterClient) return { client: openrouterClient, model: 'x-ai/grok-4.1-fast', tag: 'openrouter/grok',
    extraParams: { max_tokens: 4096, temperature: 0.6 } };
  return { client: grokClient, model: GROK_MODEL, tag: 'grok',
    extraParams: { max_tokens: 4096, temperature: 0.6 } };
}

// ── Discord model logging ──────────────────────────────────────────
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DISCORD_LOG_CHANNEL = process.env.DISCORD_CHANNEL_ID;

async function discordLog(text) {
  if (!DISCORD_TOKEN || !DISCORD_LOG_CHANNEL) return;
  try {
    await fetch(`https://discord.com/api/v10/channels/${DISCORD_LOG_CHANNEL}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text })
    });
  } catch { /* non-critical */ }
}

const DISCORD_DEATHS_CHANNEL = '1472697700519645217';

export async function discordRevivalEmbed(deadPlayer, reviver) {
  if (!DISCORD_TOKEN) return;
  try {
    await fetch(`https://discord.com/api/v10/channels/${DISCORD_DEATHS_CHANNEL}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{
          color: 0x00ff00,
          author: {
            name: `☠ ${deadPlayer} has been revived by ${reviver}!`,
            icon_url: `https://cravatar.eu/helmavatar/${deadPlayer}`
          },
          timestamp: new Date().toISOString()
        }]
      })
    });
  } catch { /* non-critical */ }
}

async function callLLM(params, { label = 'LLM' } = {}) {
  // Use OpenAI (gpt-5-mini) if available, otherwise Grok
  if (openaiClient) {
    const { max_tokens, temperature, ...rest } = params;
    const openaiParams = {
      ...rest,
      model: REVIVAL_MODEL,
      ...(max_tokens ? { max_completion_tokens: Math.max(max_tokens * 8, 2048) } : {}),
    };
    const response = await openaiClient.chat.completions.create(openaiParams, { timeout: 30_000 });
    console.log(`[${label}] ✓ openai`);
    return response;
  }

  const response = await grokClient.chat.completions.create({ ...params, model: GROK_MODEL }, { timeout: 30_000 });
  console.log(`[${label}] ✓ grok`);
  return response;
}

// ── Prompt loader ────────────────────────────────────────────────────

function loadPrompt(name) {
  return readFileSync(join(__dirname, 'prompts', `${name}.md`), 'utf-8').trim();
}

function fillTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}

// Load all prompts at startup (mutated in-place by reloadPrompts)
const prompts = {
  response: loadPrompt('response'),
  chatter: loadPrompt('chatter'),
  joinReaction: loadPrompt('join-reaction'),
  orchestrator: loadPrompt('orchestrator'),
  memoryCompact: loadPrompt('memory-compact'),
  memoryEvaluate: loadPrompt('memory-evaluate'),
};
let chatStyle = loadPrompt('style');
let serverInfo = loadPrompt('server-info');

export function reloadPrompts() {
  const reloaded = [];
  for (const key of Object.keys(prompts)) {
    const filename = key.replace(/([A-Z])/g, '-$1').toLowerCase(); // camelCase → kebab-case
    try {
      prompts[key] = loadPrompt(filename);
      reloaded.push(filename);
    } catch (e) {
      console.error(`[HotReload] Failed to load ${filename}.md: ${e.message}`);
    }
  }
  try { chatStyle = loadPrompt('style'); reloaded.push('style'); } catch {}
  try { serverInfo = loadPrompt('server-info'); reloaded.push('server-info'); } catch {}
  console.log(`[HotReload] Reloaded prompts: ${reloaded.join(', ')}`);
}

// Trim to last complete thought if truncated mid-sentence
function trimToComplete(text) {
  // If it ends with punctuation or looks complete, keep it
  if (/[.!?)\]]$/.test(text)) return text;
  // Try cutting at last sentence-ending punctuation
  const lastBreak = Math.max(text.lastIndexOf('. '), text.lastIndexOf('! '), text.lastIndexOf('? '));
  if (lastBreak > text.length * 0.4) return text.slice(0, lastBreak + 1);
  // Try cutting at last comma, dash, or natural pause
  const lastPause = Math.max(text.lastIndexOf(', '), text.lastIndexOf(' - '), text.lastIndexOf(' — '));
  if (lastPause > text.length * 0.5) return text.slice(0, lastPause);
  return text;
}

// Strip thinking/reasoning tokens that leak into content from local models
function stripThinking(text) {
  // Remove <think>...</think> blocks
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  // Broad catch: any numbered-list opener ("1. ...") — real chat never starts with "1."
  if (/^\d+\.\s+/i.test(text)) return '';
  // Catch meta/self-instruction patterns — reject if first word is a reasoning keyword
  if (/^(think|thought|thinking|reasoning|internal|step|analyze|consider|respond|plan|approach|persona|style|context|instructions?)\b/i.test(text)) return '';
  // Remove any leading reasoning before actual chat content
  const chatMatch = text.match(/(?:^|\n)([a-z].*)/i);
  if (chatMatch && text.indexOf(chatMatch[1]) > text.length * 0.5) {
    // More than half the text was reasoning preamble — just take the chat part
    return chatMatch[1].trim();
  }
  return text;
}

// Strip unicode emojis from output — LLMs sometimes ignore the prompt instruction
function stripEmojis(text) {
  return text.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, '').trim();
}

export class ConversationManager {
  constructor(config = {}) {
    this.chatHistory = [];
    this.maxHistory = 20;
    this.compactThreshold = 10; // compact when history exceeds this
    this.compactSummary = ''; // summary of older compacted messages

    // Rolling 5-minute window rate limiter
    this.messageTimestamps = [];
    this.windowMs = (config.rateLimitWindowMin || 5) * 60 * 1000;
    this.maxInWindow = config.maxInWindow || 12;

    // Conversation continuity: track which bot last talked to which player
    this.recentConversations = new Map(); // playerName → { botName, timestamp }

    // Anti-repetition: track recent chatter messages
    this.recentChatter = [];
    this.maxRecentChatter = 15;

    // Per-bot memory system
    this.memoriesDir = join(__dirname, 'memories');
    if (!existsSync(this.memoriesDir)) mkdirSync(this.memoriesDir);
    this.botMemories = new Map(); // username → { summary, recent[] }
    this.memoryMaxRecent = 15; // max recent entries before compacting
    this.memoryKeepAfterCompact = 5; // keep this many recent after compact
  }

  // ── Per-bot memory ──────────────────────────────────────────────────

  _loadMemory(username) {
    if (this.botMemories.has(username)) return this.botMemories.get(username);
    const file = join(this.memoriesDir, `${username}.json`);
    let mem = { summary: '', recent: [] };
    if (existsSync(file)) {
      try { mem = JSON.parse(readFileSync(file, 'utf-8')); } catch { /* fresh start */ }
    }
    this.botMemories.set(username, mem);
    return mem;
  }

  _saveMemory(username) {
    const mem = this.botMemories.get(username);
    if (!mem) return;
    const file = join(this.memoriesDir, `${username}.json`);
    try { writeFileSync(file, JSON.stringify(mem, null, 2)); } catch (e) {
      console.error(`[Memory] Failed to save ${username}: ${e.message}`);
    }
  }

  // Record something the bot said or experienced
  addMemory(username, entry) {
    const mem = this._loadMemory(username);
    mem.recent.push(entry);
    this._saveMemory(username);

    // Compact if too many recent entries
    if (mem.recent.length >= this.memoryMaxRecent) {
      this._compactMemory(username);
    }
  }

  // Compact older memories into a summary via LLM
  async _compactMemory(username) {
    const mem = this._loadMemory(username);
    if (mem.recent.length < this.memoryMaxRecent) return;

    // Take the oldest entries, keep the newest few
    const toCompact = mem.recent.slice(0, mem.recent.length - this.memoryKeepAfterCompact);
    const kept = mem.recent.slice(-this.memoryKeepAfterCompact);

    const existing = mem.summary ? `Existing summary: ${mem.summary}\n\n` : '';
    const entries = toCompact.join('\n');

    try {
      const response = await callLLM({
        messages: [{
          role: 'system',
          content: fillTemplate(prompts.memoryCompact, { existing, entries })
        }],
        max_tokens: 200,
        temperature: 0.3
      }, { label: 'MemoryCompact', lightweight: true });
      mem.summary = response.choices[0].message.content.trim();
      mem.recent = kept;
      this._saveMemory(username);
      console.log(`[Memory] Compacted ${toCompact.length} entries for ${username}`);
    } catch (err) {
      console.error(`[Memory Compact] ${err.message}`);
    }
  }

  // Evaluate if an interaction is worth remembering (async, fire-and-forget)
  async evaluateMemory(username, chatSnippet) {
    try {
      const response = await callLLM({
        messages: [{
          role: 'system',
          content: fillTemplate(prompts.memoryEvaluate, { username, chatSnippet })
        }],
        max_tokens: 30,
        temperature: 0.2
      }, { label: 'MemoryEval', lightweight: true });
      const result = response.choices[0].message.content.trim();
      if (result.toLowerCase() === 'none' || result.length < 3) return;
      this.addMemory(username, result);
      console.log(`[Memory] ${username}: ${result}`);
    } catch (err) {
      // Non-critical, just skip
    }
  }

  // Get formatted memory block for injection into prompts
  getMemoryBlock(username) {
    const mem = this._loadMemory(username);
    const parts = [];
    if (mem.summary) parts.push(mem.summary);
    if (mem.recent.length > 0) parts.push('Recent:\n' + mem.recent.map(r => `- ${r}`).join('\n'));
    if (parts.length === 0) return '';
    return `\nYOUR MEMORIES & EXPERIENCES (things you've done, seen, and learned on this server — reference these naturally):\n${parts.join('\n\n')}`;
  }

  // Record that a bot responded to a player
  trackConversation(playerName, botName) {
    this.recentConversations.set(playerName, { botName, timestamp: Date.now() });
  }

  // Get the bot that recently talked to this player (within maxAge ms)
  getRecentConversant(playerName, maxAge = 30000) {
    const entry = this.recentConversations.get(playerName);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > maxAge) {
      this.recentConversations.delete(playerName);
      return null;
    }
    return entry.botName;
  }

  addMessage(username, message, { isBot = false } = {}) {
    this.chatHistory.push({
      role: 'user',
      content: `<${username}> ${message}`,
      timestamp: Date.now(),
      isBot
    });
    if (this.chatHistory.length > this.maxHistory) {
      this.chatHistory.shift();
    }
    // Compact when history grows past threshold
    if (this.chatHistory.length > this.compactThreshold) {
      this.compactHistory();
    }
  }

  compactHistory() {
    // Keep the most recent 6 messages, summarize the rest
    const keep = 6;
    const toCompact = this.chatHistory.slice(0, this.chatHistory.length - keep);
    const kept = this.chatHistory.slice(-keep);

    const summary = toCompact.map(h => h.content).join(' | ');
    // Append to rolling summary, trim if too long
    this.compactSummary = this.compactSummary
      ? this.compactSummary + ' | ' + summary
      : summary;
    // Cap summary length to ~500 chars
    if (this.compactSummary.length > 500) {
      this.compactSummary = this.compactSummary.slice(-500);
    }

    this.chatHistory = kept;
    console.log(`[Compact] Compacted ${toCompact.length} messages, keeping ${kept.length}`);
  }

  isRateLimited() {
    const now = Date.now();
    this.messageTimestamps = this.messageTimestamps.filter(t => now - t < this.windowMs);
    return this.messageTimestamps.length >= this.maxInWindow;
  }

  recordBotMessage() {
    this.messageTimestamps.push(Date.now());
  }

  remainingInWindow() {
    const now = Date.now();
    this.messageTimestamps = this.messageTimestamps.filter(t => now - t < this.windowMs);
    return Math.max(0, this.maxInWindow - this.messageTimestamps.length);
  }

  // "Reading" delay — simulates the bot noticing and reading the message
  getReadDelay() {
    return 2000 + Math.random() * 6000; // 2-8 seconds
  }

  // "Typing" delay — simulates the bot typing out their response
  getTypingDelay(message) {
    const perChar = 80 + Math.random() * 80; // 80-160ms per character
    const base = 1500 + Math.random() * 2000; // 1.5-3.5s base thinking time
    return base + message.length * perChar; // no cap — longer messages take longer
  }

  /**
   * Orchestrator: decide if/which bot should respond to a message
   * that didn't mention a specific bot by name.
   * Returns the bot username to respond, or null.
   */
  async orchestrate(message, senderName, botProfiles, { realPlayerCount = 1 } = {}) {
    const botList = botProfiles.map(b =>
      `- ${b.username}: ${b.interests.join(', ')}`
    ).join('\n');

    const recentChat = this.chatHistory.slice(-10)
      .map(h => h.content).join('\n');

    // Dynamic response chance based on player count
    let chimeChance, activityNote;
    if (realPlayerCount <= 2) {
      chimeChance = '~40%';
      activityNote = 'Few players online — be more engaged and responsive.';
    } else if (realPlayerCount <= 5) {
      chimeChance = '~20%';
      activityNote = 'Moderate player count — chime in occasionally.';
    } else {
      chimeChance = '~10%';
      activityNote = 'Server is busy — step back and let players talk. Only respond if directly relevant.';
    }

    // Check recent chat activity
    const twoMinAgo = Date.now() - 120000;
    const recentMsgCount = this.chatHistory.filter(h => h.timestamp > twoMinAgo).length;
    if (recentMsgCount > 8) {
      activityNote += ' Chat is very active right now — lean toward "none" for casual messages.';
    }

    try {
      const response = await callLLM({
        messages: [
          {
            role: 'system',
            content: fillTemplate(prompts.orchestrator, {
              botList, recentChat, realPlayerCount, activityNote, chimeChance
            })
          },
          {
            role: 'user',
            content: `<${senderName}> ${message}`
          }
        ],
        max_tokens: 20,
        temperature: 0.5
      }, { label: 'Orchestrator', lightweight: true });

      const pick = response.choices[0].message.content.trim();
      const validNames = botProfiles.map(b => b.username);

      // Parse "server:BotName" or just "BotName"
      let serverQuestion = false;
      let botName = pick;
      if (pick.startsWith('server:')) {
        serverQuestion = true;
        botName = pick.slice(7);
      }

      if (validNames.includes(botName)) return { botName, serverQuestion };
      return null;
    } catch (err) {
      console.error(`[Orchestrator Error] ${err.message}`);
      return null;
    }
  }

  async generateResponse(bot, { serverQuestion = false } = {}) {
    const history = this.chatHistory.slice(-10);
    const contextLine = this.compactSummary
      ? `\nEARLIER CHAT (summary): ${this.compactSummary}\n`
      : '';
    const serverBlock = serverQuestion && serverInfo
      ? `\nSERVER KNOWLEDGE (use this to answer the server question accurately):\n${serverInfo}\n`
      : '';
    const memoryBlock = this.getMemoryBlock(bot.username);
    const messages = [
      {
        role: 'system',
        content: fillTemplate(prompts.response, {
          personality: bot.personality,
          serverBlock,
          memoryBlock,
          chatStyle,
          contextLine,
          botUsername: bot.username
        })
      },
      ...history.map(h => ({ role: 'user', content: h.content })),
      {
        role: 'user',
        content: `Respond as ${bot.username} in the Minecraft chat. Keep it short and natural. Just give the chat message, nothing else.`
      }
    ];

    try {
      const response = await callLLM({
        messages,
        max_tokens: 80,
        temperature: 0.75
      }, { label: 'Response', botName: bot.username });
      let reply = stripThinking(response.choices[0].message.content.trim());
      reply = reply.replace(/^["']|["']$/g, '');
      // Strip the bot's own name in any format from the start of the message
      const nameEsc = bot.username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      reply = reply.replace(new RegExp(`^<?\\[?${nameEsc}\\]?>?\\s*[:>\\-]?\\s*`, 'i'), '');
      reply = stripEmojis(reply);
      reply = trimToComplete(reply);

      // Block slurs — LLMs get tricked via word games
      if (reply && containsSlur(reply)) {
        console.log(`[Filter] Blocked slur from ${bot.username}: ${reply}`);
        return null;
      }

      // Evaluate if this interaction is worth remembering (non-blocking)
      if (reply) {
        const recentContext = history.slice(-3).map(h => h.content).join('\n');
        this.evaluateMemory(bot.username, `${recentContext}\n<${bot.username}> ${reply}`);
      }

      return reply ? { text: reply } : null;
    } catch (err) {
      console.error(`[LLM Error] ${err.message}`);
      return null;
    }
  }

  async generateConversationStarter(bot, otherBotNames = []) {
    // ~15% of the time, address another bot to spark bot-to-bot chatter
    const targetLine = otherBotNames.length > 0 && Math.random() < 0.15
      ? `\nAddress your message to ${otherBotNames[Math.floor(Math.random() * otherBotNames.length)]} by name — ask them something or say something to them directly.`
      : '';

    // Chat context: show only PLAYER messages (exclude bot messages to prevent pattern-copying loops)
    const recentChat = this.chatHistory.filter(h => !h.isBot).slice(-10);
    const chatContext = recentChat.length > 0
      ? `\n\nRECENT CHAT (use this for context — you can react to what players are talking about):\n${recentChat.map(h => h.content).join('\n')}`
      : '';

    // Anti-repetition: show topics to avoid (NOT exact text — LLMs copy exact patterns)
    const antiRepeat = this.recentChatter.length > 0
      ? `\n\nTOPICS ALREADY COVERED (pick something totally different, do NOT follow any pattern or sentence structure from these):\n${this.recentChatter.slice(-8).map(m => `- ${m.slice(0, 30)}`).join('\n')}\n\nBe original. Do NOT use "too X for Y" or any repeated sentence template.`
      : '';

    const memoryBlock = this.getMemoryBlock(bot.username);
    const messages = [
      {
        role: 'system',
        content: fillTemplate(prompts.chatter, {
          personality: bot.personality,
          memoryBlock,
          chatStyle,
          targetLine,
          chatContext,
          antiRepeat,
          botUsername: bot.username
        })
      }
    ];

    try {
      const response = await callLLM({
        messages,
        max_tokens: 40,
        temperature: 0.8
      }, { label: 'Chatter', botName: bot.username });
      let reply = stripThinking(response.choices[0].message.content.trim());
      reply = reply.replace(/^["']|["']$/g, '');
      reply = stripEmojis(reply);
      reply = trimToComplete(reply);

      if (reply && containsSlur(reply)) {
        console.log(`[Filter] Blocked slur from ${bot.username}: ${reply}`);
        return null;
      }

      // Track for anti-repetition (but do NOT memorize — chatter is fabricated)
      if (reply) {
        this.recentChatter.push(reply);
        if (this.recentChatter.length > this.maxRecentChatter) {
          this.recentChatter.shift();
        }
      }

      return reply ? { text: reply } : null;
    } catch (err) {
      console.error(`[LLM Error] ${err.message}`);
      return null;
    }
  }

  async generateJoinReaction(bot, playerName, isNewPlayer = false, priorGreeting = '') {
    const joinContext = `${playerName} just joined the server. ${isNewPlayer ? 'This is their FIRST TIME on the server — welcome them as a new player.' : 'They have been here before — greet them casually like a regular. Do NOT treat them like a new player. Just say hi, wb, yo, etc.'}`;
    const avoidLine = priorGreeting
      ? `\nAnother bot already said: "${priorGreeting}" — say something COMPLETELY DIFFERENT. Do NOT repeat or rephrase it.`
      : '';

    const messages = [
      {
        role: 'system',
        content: fillTemplate(prompts.joinReaction, {
          botUsername: bot.username,
          personality: bot.personality,
          joinContext: joinContext + avoidLine,
          chatStyle,
          playerName
        })
      }
    ];

    try {
      const response = await callLLM({
        messages,
        max_tokens: 30,
        temperature: 1.0
      }, { label: 'JoinReaction', botName: bot.username });
      let reply = stripThinking(response.choices[0].message.content.trim());
      reply = reply.replace(/^["']|["']$/g, '');
      reply = stripEmojis(reply);
      return reply ? { text: reply } : null;
    } catch (err) {
      console.error(`[LLM Error] ${err.message}`);
      return null;
    }
  }

  // ── Unified revival agent tick ──────────────────────────────────────

  async revivalTick(rBot) {
    const profile = rBot.profile || {};
    const world = rBot.getWorldContext();
    const pendingMessages = rBot.pendingMessages.splice(0); // drain queue
    const senders = pendingMessages.map(m => m.sender).filter(s => s !== '__system__');

    // Track when bench mode has received its first owner message (the goal).
    // Before goal: skip idle ticks to prevent hallucination.
    // After goal: keep ticking even if objectives are empty (recovery from chat-only responses).
    if (rBot._benchMode && pendingMessages.some(m => m.sender !== '__system__')) {
      rBot._benchGoalReceived = true;
    }

    // Skip idle ticks: in benchmark mode, only skip if goal hasn't arrived yet.
    // In normal mode, skip ~70% of idle ticks to save API calls.
    if (pendingMessages.length === 0 && rBot.objectives.length === 0 && rBot.state === 'idle') {
      if (rBot._benchMode && !rBot._benchGoalReceived) return { actions: [], chat: null, senders: [] };
      if (!rBot._benchMode && Math.random() > 0.3) return { actions: [], chat: null, senders: [] };
    }

    const worldSection = Object.keys(world).length > 0
      ? Object.entries(world).map(([k, v]) => `  ${k}: ${v}`).join('\n')
      : '  (not available)';

    const objectivesSection = rBot.objectives.length > 0
      ? rBot.objectives.map(o => `  - [${o.priority}] ${o.text}`).join('\n')
      : '  (none)';

    const logSection = rBot.actionLog.length > 0
      ? rBot.actionLog.slice(-10).map(e => {
          const ago = Math.round((Date.now() - e.timestamp) / 1000);
          return `  [${ago}s ago] ${e.type}: ${e.detail}`;
        }).join('\n')
      : '  (none)';

    const messagesSection = pendingMessages.length > 0
      ? pendingMessages.map(m => `  <${m.sender}> ${m.message}`).join('\n')
      : '  (no messages — idle tick)';

    const benchMode = !!rBot._benchMode;

    const systemPrompt = `You are ${rBot.username}, a revived player on a Minecraft server. You died and were brought back by ${rBot.owner} using an iron golem ritual.
${benchMode ? `\nBENCHMARK MODE: You are being timed on a specific task. CRITICAL RULES:
1. ONLY work on the task your owner assigns you. Do NOT invent goals or take initiative — if you have no objectives yet, return empty and WAIT for your owner's message.
2. Follow instructions EXACTLY. Don't do anything unrelated to the assigned task (no eating, no checking chests unless the task requires it).
3. Every tick should make progress toward the goal. Don't waste ticks.\n` : ''}
PERSONALITY: ${profile.personality || 'Unknown'}
CHAT STYLE: ${profile.chatStyle || 'Short lowercase messages'}
${profile.samplePhrases?.length ? `EXAMPLE PHRASES: ${profile.samplePhrases.join(', ')}` : ''}
${benchMode ? '' : this.getMemoryBlock(rBot.username)}

WORLD STATE:
${worldSection}

CURRENT OBJECTIVES:
${objectivesSection}

RECENT ACTIONS:
${logSection}

INCOMING MESSAGES:
${messagesSection}

RULES:
- ${rBot.owner} is your owner who revived you. Follow their instructions. Others can chat but can't command you.
- CRITICAL: When your owner gives a command (follow, mine, attack, come, stop, etc.), you MUST call the matching tool. NEVER just say "ok" without calling the tool — that does nothing. Chat alone does NOT execute actions.
- Keep chat SHORT (1-5 words), casual, in-character. Match your personality.
- On idle ticks with NO messages AND no objectives: do nothing. Just return empty.
- AUTONOMOUS EXECUTION: When you have objectives or your RECENT ACTIONS show a multi-step task in progress, KEEP WORKING. Do the next step immediately — do NOT stop to ask "what now" or wait for confirmation. For example, if told to "craft a wooden pickaxe", set an objective, then chain: craft planks → craft sticks → craft pickaxe → complete objective, all without waiting for further instructions.
- IMPORTANT: If you are already doing something (currentState is not "idle"), do NOT re-issue that action. For example if currentState is "following", do NOT call follow again. Only call tools when you need to CHANGE what you're doing.
- IMPORTANT: If an action just FAILED (check RECENT ACTIONS), try a GENUINELY different approach — do NOT repeat the same action. Think about alternative ways to get what you need: check nearby chests for items, craft prerequisite tools, try a different block/mob, or ask your owner for help. Repeating a failed action is wasteful.
- When a player talks to you: respond naturally. Take action if your owner instructs you.
- Use objective(set) to track multi-step goals. Use objective(complete) when the ENTIRE goal is done. While an objective is active, keep working toward it each tick.
- To get items: chest(check) first, then chest(take), then equip. Chain these steps.
- To store items: use chest(deposit) (NOT drop — that drops on the ground). Omit item to deposit everything.
- come_here just walks to your owner. Do NOT use it as a catch-all — only use it when specifically asked to come.
- For mine/collect: translate player requests into Minecraft block IDs. "dark oak logs" = dark_oak_log, "cobble" = cobblestone, "wood"/"logs" = oak_log, etc. If asked to "get" an item, consider ALL sources: mining, chests, crafting, smelting — not just mining.
- Your survival instincts are AUTOMATIC (eating, fighting back, swimming, getting unstuck). Focus on goals and owner instructions.
- If you have no food and your hunger is low, check nearby chests for food or ask your owner.
- Use sleep when it's nighttime and your owner asks or you need to skip the night.
- Use place to put blocks like torches, crafting tables, etc. Direction defaults to forward.
- Use remember when your owner tells you to remember something important for later.
- NEVER say coordinates in public chat. Use whisper to DM your owner.
- No emojis. No roleplay asterisks. No slash commands. Respond in whatever language fits your personality and the conversation.
- You're not fully alive — you're an echo of your former self. Keep this subtle, don't overplay it.`;

    const tools = [
      { type: 'function', function: { name: 'follow', description: 'Follow a player around. Defaults to your owner if no player specified.', parameters: { type: 'object', properties: { player: { type: 'string', description: 'Player name (omit to follow owner)' } }, required: [] } } },
      { type: 'function', function: { name: 'come_here', description: "Walk to the owner's position (one-time)", parameters: { type: 'object', properties: {}, required: [] } } },
      { type: 'function', function: { name: 'stop', description: 'Stop all current actions', parameters: { type: 'object', properties: {}, required: [] } } },
      { type: 'function', function: { name: 'guard', description: 'Guard current position — attack hostile mobs', parameters: { type: 'object', properties: {}, required: [] } } },
      { type: 'function', function: { name: 'mine', description: 'Find and mine blocks nearby. For underground ores, automatically strip-mines at optimal Y. For logs, auto-tries all wood variants if the specified type is not found. Will roam to find blocks if none nearby.', parameters: { type: 'object', properties: { block: { type: 'string', description: 'Minecraft block ID (e.g. oak_log, stone, diamond_ore). Use "stone" to get cobblestone drops.' }, count: { type: 'integer', description: 'How many to mine (default 16)' } }, required: ['block'] } } },
      { type: 'function', function: { name: 'attack', description: 'Attack nearby mobs of a type.', parameters: { type: 'object', properties: { mob: { type: 'string', description: 'Mob name (e.g. chicken, zombie)' }, count: { type: 'integer', description: 'How many to kill (default 1)' } }, required: ['mob'] } } },
      { type: 'function', function: { name: 'pickup', description: 'Walk to and pick up items dropped on the ground. Check nearbyEntities for "dropped:item_name" entries.', parameters: { type: 'object', properties: { item: { type: 'string', description: 'Item name filter (e.g. raw_beef, diamond). Omit to pick up everything nearby.' } }, required: [] } } },
      { type: 'function', function: { name: 'drop', description: 'Drop items. Omit item to drop everything.', parameters: { type: 'object', properties: { item: { type: 'string', description: 'Item name (omit to drop all)' }, count: { type: 'integer', description: 'How many (omit for all of that item)' } }, required: [] } } },
      { type: 'function', function: { name: 'give', description: 'Walk to a player and give them an item', parameters: { type: 'object', properties: { player: { type: 'string' }, item: { type: 'string' }, count: { type: 'integer' } }, required: ['player', 'item'] } } },
      { type: 'function', function: { name: 'chest', description: 'Interact with nearby chests/containers.', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['check', 'take', 'deposit'], description: 'check = scan contents, take = grab item (omit item to take everything), deposit = store item (omit item to store all)' }, item: { type: 'string', description: 'Item name (optional for take/deposit — omit to take/deposit all)' }, count: { type: 'integer', description: 'How many (omit for all)' } }, required: ['action'] } } },
      { type: 'function', function: { name: 'craft', description: 'Craft an item using nearby crafting table or inventory', parameters: { type: 'object', properties: { item: { type: 'string', description: 'Item to craft (e.g. wooden_pickaxe, furnace)' }, count: { type: 'integer', description: 'How many (default 1)' } }, required: ['item'] } } },
      { type: 'function', function: { name: 'equip', description: 'Equip an item from inventory', parameters: { type: 'object', properties: { item: { type: 'string', description: 'Item name (e.g. iron_sword, diamond_chestplate)' } }, required: ['item'] } } },
      { type: 'function', function: { name: 'smelt', description: 'Smelt items in a nearby furnace', parameters: { type: 'object', properties: { item: { type: 'string', description: 'Item to smelt (e.g. raw_iron)' }, fuel: { type: 'string', description: 'Fuel (default: coal)' }, count: { type: 'integer', description: 'How many (default 1)' } }, required: ['item'] } } },
      { type: 'function', function: { name: 'eat', description: 'Eat food from inventory', parameters: { type: 'object', properties: {}, required: [] } } },
      { type: 'function', function: { name: 'sleep', description: 'Sleep in a nearby bed', parameters: { type: 'object', properties: {}, required: [] } } },
      { type: 'function', function: { name: 'place', description: 'Place a block from inventory', parameters: { type: 'object', properties: { block: { type: 'string', description: 'Block name (e.g. torch, cobblestone, crafting_table)' }, direction: { type: 'string', enum: ['forward', 'below', 'above'], description: 'Where to place (default: forward)' } }, required: ['block'] } } },
      { type: 'function', function: { name: 'whisper', description: 'DM a player. Use for coordinates or sensitive info.', parameters: { type: 'object', properties: { player: { type: 'string' }, message: { type: 'string' } }, required: ['player', 'message'] } } },
      { type: 'function', function: { name: 'dismiss', description: 'Despawn permanently. Only if explicitly told to leave.', parameters: { type: 'object', properties: {}, required: [] } } },
      { type: 'function', function: { name: 'remember', description: 'Store a memory for later. Use when your owner tells you to remember something.', parameters: { type: 'object', properties: { text: { type: 'string', description: 'What to remember' } }, required: ['text'] } } },
      { type: 'function', function: { name: 'objective', description: 'Manage your objectives/goals.', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['set', 'complete', 'clear'], description: 'set = new goal, complete = mark done, clear = remove all' }, text: { type: 'string', description: 'Objective text (required for set/complete)' }, priority: { type: 'string', enum: ['high', 'normal', 'low'], description: 'Priority (for set, default: normal)' } }, required: ['action'] } } },
    ];

    try {
      // Build messages with tick history injected into the user prompt
      const historySection = rBot.tickHistory.length > 0
        ? '\n\nYOUR RECENT TICK HISTORY (what you did on previous ticks — do NOT repeat yourself):\n'
          + rBot.tickHistory.map((h, i) => `  Tick ${i + 1}: ${h}`).join('\n')
        : '';
      const messages = [
        { role: 'system', content: systemPrompt + historySection },
        { role: 'user', content: 'Tick. Decide what to do.' }
      ];

      const rb = getRevivalBackend();
      const callLLM = (timeoutMs) => rb.client.chat.completions.create({
        model: rb.model,
        messages,
        tools,
        ...rb.extraParams,
      }, { timeout: timeoutMs });

      let response;
      try {
        response = await callLLM(60_000);
      } catch (firstErr) {
        // Retry once on timeout/network errors (not on 4xx auth/quota errors)
        const status = firstErr?.status || firstErr?.response?.status;
        if (status && status >= 400 && status < 500) throw firstErr;
        console.log(`[RevivalTick] ⟳ ${rb.tag} (${rBot.username}) retry after: ${firstErr.message?.slice(0, 80)}`);
        response = await callLLM(45_000);
      }

      const choice = response.choices[0];
      const hasTools = !!choice.message.tool_calls?.length;
      const hasContent = !!choice.message.content?.trim();
      const msgCount = pendingMessages.length;
      if (msgCount > 0 && !hasTools && !hasContent) {
        console.log(`[RevivalTick] ⚠ ${rb.tag} (${rBot.username}) — ${msgCount} messages but LLM returned empty. finish_reason=${choice.finish_reason}`);
      } else {
        console.log(`[RevivalTick] ✓ ${rb.tag} (${rBot.username})${msgCount > 0 ? ` (${msgCount} msgs)` : ''}`);
      }
      const result = { actions: [], chat: null, senders, rawThinking: null };

      // Debug: log reasoning/thinking from the LLM
      if (choice.message.reasoning) {
        console.log(`[RevivalTick] 💭 ${rBot.username}: ${choice.message.reasoning.slice(0, 200)}`);
      }

      if (choice.message.tool_calls) {
        for (const tc of choice.message.tool_calls) {
          let args = {};
          try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
          result.actions.push({ name: tc.function.name, params: args });
          console.log(`[RevivalTick] Tool: ${tc.function.name}(${JSON.stringify(args)})`);
        }
      }

      if (choice.message.content) {
        // Preserve raw thinking for debug mode before stripping
        result.rawThinking = choice.message.content.trim();

        let reply = stripThinking(result.rawThinking);
        reply = reply.replace(/^["']|["']$/g, '');
        // Strip "chat:", "**chat**:", "response:", bot name prefixes, and XML-style tags
        reply = reply.replace(/^\*{0,2}(chat|response|say|message)\*{0,2}\s*:\s*/i, '');
        reply = reply.replace(/<\/?chat>/gi, '');
        const nameEsc = rBot.username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        reply = reply.replace(new RegExp(`^<?\\[?${nameEsc}\\]?>?\\s*[:>\\-]?\\s*`, 'i'), '');
        reply = stripEmojis(reply);
        reply = trimToComplete(reply);
        // Strip any coordinates from public chat (e.g. "-6448, 79, -11779" or "-6448 79 -11779")
        reply = reply.replace(/-?\d{2,}[,\s]+-?\d{1,3}[,\s]+-?\d{2,}/g, '[coords hidden]');
        // Filter out LLM echoing instructions or tool names as chat
        const replyLower = reply.toLowerCase();
        const toolNames = ['objective(', 'follow(', 'come_here', 'chest(', 'craft(',
          'equip(', 'give(', 'drop(', 'mine(', 'attack(', 'sleep', 'place(', 'remember('];
        const isEcho = replyLower.includes('idle tick') || replyLower.includes('do nothing')
          || replyLower.includes('no messages') || replyLower.includes('currentstate')
          || toolNames.some(t => replyLower.includes(t));
        if (reply && !containsSlur(reply) && !isEcho) result.chat = reply;
      }

      // Record compact tick summary for conversation continuity (skip empty idle ticks)
      const summaryParts = [];
      for (const a of result.actions) {
        const argStr = Object.keys(a.params).length > 0 ? `(${Object.values(a.params).join(',')})` : '';
        summaryParts.push(`[tool] ${a.name}${argStr}`);
      }
      if (result.chat) summaryParts.push(`[chat] ${result.chat}`);
      if (summaryParts.length > 0) {
        rBot.recordTickExchange(summaryParts.join(' | '));
      }

      return result;
    } catch (err) {
      console.error(`[RevivalTick Error] ${err.message}`);
      return { actions: [], chat: null, senders };
    }
  }
}

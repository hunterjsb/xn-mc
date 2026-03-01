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

const ollamaBaseUrl = process.env.OLLAMA_URL?.replace(/\/v1\/?$/, ''); // strip /v1 — use native API
const ollamaModel = process.env.OLLAMA_MODEL;
const ollamaAuth = process.env.OLLAMA_AUTH;
const ollamaEnabled = false; // disabled — Ollama API is down, using Grok only

const GROK_MODEL = 'grok-4-1-fast-non-reasoning';

// Native Ollama /api/chat call with think:false
async function ollamaChat(params) {
  const headers = { 'Content-Type': 'application/json' };
  if (ollamaAuth) headers['Authorization'] = `Basic ${ollamaAuth}`;

  const body = {
    model: ollamaModel,
    messages: params.messages,
    stream: false,
    think: false,
    keep_alive: 0, // unload after responding — frees VRAM
    options: {}
  };
  if (params.max_tokens) body.options.num_predict = Math.min(params.max_tokens, 50); // cap Ollama shorter
  if (params.temperature != null) body.options.temperature = params.temperature;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000); // 15s — if GPU is busy, fall back to Grok

  try {
    const res = await fetch(`${ollamaBaseUrl}/api/chat`, {
      method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // Return OpenAI-compatible shape so callers don't change
    return {
      choices: [{ message: { role: 'assistant', content: data.message?.content || '' } }]
    };
  } finally {
    clearTimeout(timeout);
  }
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

async function callLLM(params, { label = 'LLM', lightweight = false, botName = '' } = {}) {
  // For lightweight calls (memory eval, orchestrator), prefer Grok for speed
  if (lightweight || !ollamaEnabled) {
    const response = await grokClient.chat.completions.create({ ...params, model: GROK_MODEL });
    console.log(`[${label}] ✓ grok`);
    return response;
  }

  // Try Ollama first, fall back to Grok
  try {
    const response = await ollamaChat(params);
    const tag = `ollama (${ollamaModel})`;
    console.log(`[${label}] ✓ ${tag}`);
    if (botName) discordLog(`\`[${label}] ${botName} via ${tag}\``);
    response._fallback = false;
    return response;
  } catch (err) {
    console.warn(`[${label}] Ollama failed (${err.message}), falling back to Grok`);
    const response = await grokClient.chat.completions.create({ ...params, model: GROK_MODEL });
    console.log(`[${label}] ✓ grok (fallback)`);
    if (botName) discordLog(`\`[${label}] ${botName} via grok (fallback)\``);
    response._fallback = true;
    return response;
  }
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

      return reply ? { text: reply, fallback: !!response._fallback } : null;
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

      return reply ? { text: reply, fallback: !!response._fallback } : null;
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
      return reply ? { text: reply, fallback: !!response._fallback } : null;
    } catch (err) {
      console.error(`[LLM Error] ${err.message}`);
      return null;
    }
  }
}

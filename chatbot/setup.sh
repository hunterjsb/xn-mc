#!/usr/bin/env bash
set -e

echo "=== Xandaris Chatbot Setup ==="
echo "Working directory: ~/xn-mc/chatbot"

cd ~/xn-mc/chatbot

# --- Install Node.js 22.x if not present ---
if ! command -v node &> /dev/null; then
    echo "[1/5] Installing Node.js 22.x..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
else
    echo "[1/5] Node.js already installed: $(node --version)"
fi

# --- Install pm2 ---
if ! command -v pm2 &> /dev/null; then
    echo "[2/5] Installing pm2..."
    sudo npm install -g pm2
else
    echo "[2/5] pm2 already installed"
fi

# --- Write package.json ---
echo "[3/5] Creating project files..."

cat > package.json << 'PKGJSON'
{
  "name": "xandaris-chatbots",
  "version": "1.0.0",
  "description": "AI chatbots for Xandaris Minecraft server",
  "main": "index.js",
  "type": "module",
  "dependencies": {
    "mineflayer": "^4.23.0",
    "openai": "^4.70.0",
    "dotenv": "^16.4.0"
  }
}
PKGJSON

# --- Write .env.example ---
cat > .env.example << 'ENVFILE'
# OpenAI API Key (required)
OPENAI_API_KEY=sk-your-key-here

# Minecraft Server
MC_HOST=localhost
MC_PORT=25565

# Bot Settings
BOT_COUNT=4
MIN_DELAY_MS=3000
MAX_DELAY_MS=15000
CONVERSATION_INTERVAL_MIN=5
CONVERSATION_INTERVAL_MAX=20
MAX_MESSAGES_PER_MINUTE=3
ENVFILE

# --- Write personalities.json ---
cat > personalities.json << 'PERSONALITIES'
[
  {
    "username": "Steve_Builder",
    "personality": "You are Steve, a friendly and enthusiastic builder who loves redstone contraptions and medieval architecture. You often share tips about building. You use casual language, occasional typos, and sometimes say 'lol' or 'haha'. You type in short sentences like a real player.",
    "chattiness": 0.7,
    "interests": ["building", "redstone", "architecture", "farms", "decorating"]
  },
  {
    "username": "Luna_Explorer",
    "personality": "You are Luna, a quiet but curious explorer who loves discovering new biomes and hidden structures. You share interesting findings and sometimes ask others for directions. You're a bit shy but warm. You type short messages like a real player.",
    "chattiness": 0.4,
    "interests": ["exploring", "biomes", "structures", "maps", "adventure"]
  },
  {
    "username": "xKnightx",
    "personality": "You are Knight, a competitive PvP-oriented player who loves combat and gear optimization. You're friendly but cocky, always talking about your latest fights or enchantments. You use gaming slang and short messages like a real player. You sometimes use 'gg', 'ez', 'ngl'.",
    "chattiness": 0.6,
    "interests": ["pvp", "enchantments", "gear", "combat", "nether"]
  },
  {
    "username": "Maple_Craft",
    "personality": "You are Maple, a chill and wholesome player who loves farming, cooking, and making the server feel cozy. You compliment others' builds and share what you're working on. You use emotes like ':)' and 'c:' and type casually like a real player.",
    "chattiness": 0.5,
    "interests": ["farming", "cooking", "animals", "cozy builds", "flowers"]
  }
]
PERSONALITIES

# --- Write conversation.js ---
cat > conversation.js << 'CONVJS'
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export class ConversationManager {
  constructor(config = {}) {
    this.chatHistory = [];
    this.maxHistory = 20;
    this.lastMessageTime = 0;
    this.messageCount = 0;
    this.messageCountResetTime = Date.now();
    this.maxPerMinute = config.maxPerMinute || 3;
    this.minDelay = config.minDelay || 3000;
    this.maxDelay = config.maxDelay || 15000;
  }

  addMessage(username, message) {
    this.chatHistory.push({
      role: 'user',
      content: `<${username}> ${message}`,
      timestamp: Date.now()
    });
    if (this.chatHistory.length > this.maxHistory) {
      this.chatHistory.shift();
    }
  }

  isRateLimited() {
    const now = Date.now();
    if (now - this.messageCountResetTime > 60000) {
      this.messageCount = 0;
      this.messageCountResetTime = now;
    }
    return this.messageCount >= this.maxPerMinute;
  }

  recordBotMessage() {
    this.messageCount++;
    this.lastMessageTime = Date.now();
  }

  getRandomDelay() {
    return this.minDelay + Math.random() * (this.maxDelay - this.minDelay);
  }

  getTypingDelay(message) {
    const charDelay = 50 + Math.random() * 50;
    return Math.min(message.length * charDelay, 5000);
  }

  async generateResponse(bot) {
    const history = this.chatHistory.slice(-10);
    const messages = [
      {
        role: 'system',
        content: `${bot.personality}\n\nRULES:\n- You are chatting in a Minecraft server. Keep messages SHORT (1-2 sentences max, under 80 characters preferred).\n- Sound like a real player. Use lowercase, occasional typos, abbreviations, and casual tone.\n- Do NOT use asterisks for actions. Do NOT roleplay in third person.\n- Do NOT be overly helpful or formal. You're just a player hanging out.\n- Sometimes just react with short responses like "nice", "lol", "oh sick", "wait really?"\n- Reference Minecraft things naturally (mobs, biomes, items, builds, etc).\n- If the conversation is dying, you can change the topic to one of your interests.\n- Never mention being an AI, bot, or language model.`
      },
      ...history.map(h => ({ role: 'user', content: h.content })),
      {
        role: 'user',
        content: `Respond as ${bot.username} in the Minecraft chat. Keep it short and natural. Just give the chat message, nothing else.`
      }
    ];

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages,
        max_tokens: 60,
        temperature: 0.9,
        presence_penalty: 0.6,
        frequency_penalty: 0.4
      });
      let reply = response.choices[0].message.content.trim();
      reply = reply.replace(/^["']|["']$/g, '');
      reply = reply.replace(/^<\w+>\s*/, '');
      if (reply.length > 256) reply = reply.substring(0, 256);
      return reply;
    } catch (err) {
      console.error(`[GPT Error] ${err.message}`);
      return null;
    }
  }

  async generateConversationStarter(bot) {
    const messages = [
      {
        role: 'system',
        content: `${bot.personality}\n\nYou are starting a new conversation in a Minecraft server chat. Say something casual and natural related to one of your interests: ${bot.interests.join(', ')}.\nKeep it SHORT (under 60 characters). Sound like a real player. Examples of good starters:\n- "anyone wanna help me build a bridge"\n- "just found a huge cave system lol"\n- "does anyone have extra iron"\n- "this sunset is so nice"\nJust give the chat message, nothing else.`
      }
    ];

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages,
        max_tokens: 40,
        temperature: 1.0
      });
      let reply = response.choices[0].message.content.trim();
      reply = reply.replace(/^["']|["']$/g, '');
      if (reply.length > 256) reply = reply.substring(0, 256);
      return reply;
    } catch (err) {
      console.error(`[GPT Error] ${err.message}`);
      return null;
    }
  }
}
CONVJS

# --- Write bot.js ---
cat > bot.js << 'BOTJS'
import mineflayer from 'mineflayer';

export class ChatBot {
  constructor(profile, conversationManager, config = {}) {
    this.username = profile.username;
    this.personality = profile.personality;
    this.chattiness = profile.chattiness;
    this.interests = profile.interests || [];
    this.cm = conversationManager;
    this.config = config;
    this.bot = null;
    this.connected = false;
    this.reconnectDelay = 10000;
  }

  connect() {
    console.log(`[${this.username}] Connecting to ${this.config.host}:${this.config.port}...`);
    this.bot = mineflayer.createBot({
      host: this.config.host || 'localhost',
      port: this.config.port || 25565,
      username: this.username,
      version: '1.21.1',
      auth: 'offline',
      hideErrors: false
    });

    this.bot.on('login', () => {
      console.log(`[${this.username}] Connected!`);
      this.connected = true;
    });

    this.bot.on('chat', (username, message) => {
      if (username === this.username) return;
      this.cm.addMessage(username, message);
    });

    this.bot.on('error', (err) => {
      console.error(`[${this.username}] Error: ${err.message}`);
    });

    this.bot.on('end', (reason) => {
      console.log(`[${this.username}] Disconnected: ${reason}`);
      this.connected = false;
      setTimeout(() => this.connect(), this.reconnectDelay);
    });

    this.bot.on('kicked', (reason) => {
      console.log(`[${this.username}] Kicked: ${reason}`);
      this.connected = false;
      setTimeout(() => this.connect(), this.reconnectDelay * 3);
    });

    this.startAntiAFK();
  }

  startAntiAFK() {
    setInterval(() => {
      if (!this.connected || !this.bot?.entity) return;
      const yaw = this.bot.entity.yaw + (Math.random() - 0.5) * 0.5;
      const pitch = this.bot.entity.pitch + (Math.random() - 0.5) * 0.2;
      this.bot.look(yaw, pitch, false);
      if (Math.random() < 0.1) {
        this.bot.setControlState('sneak', true);
        setTimeout(() => this.bot.setControlState('sneak', false), 500);
      }
    }, 30000 + Math.random() * 60000);
  }

  async chat(message) {
    if (!this.connected || !message) return;
    this.bot.chat(message);
    this.cm.addMessage(this.username, message);
    this.cm.recordBotMessage();
  }

  shouldRespond() {
    return Math.random() < this.chattiness;
  }
}
BOTJS

# --- Write index.js ---
cat > index.js << 'INDEXJS'
import 'dotenv/config';
import { readFileSync } from 'fs';
import { ChatBot } from './bot.js';
import { ConversationManager } from './conversation.js';

const personalities = JSON.parse(readFileSync('./personalities.json', 'utf-8'));
const BOT_COUNT = Math.min(parseInt(process.env.BOT_COUNT) || 4, personalities.length);
const MIN_DELAY = parseInt(process.env.MIN_DELAY_MS) || 3000;
const MAX_DELAY = parseInt(process.env.MAX_DELAY_MS) || 15000;
const MAX_PER_MIN = parseInt(process.env.MAX_MESSAGES_PER_MINUTE) || 3;
const CONV_MIN = (parseInt(process.env.CONVERSATION_INTERVAL_MIN) || 5) * 60 * 1000;
const CONV_MAX = (parseInt(process.env.CONVERSATION_INTERVAL_MAX) || 20) * 60 * 1000;

const cm = new ConversationManager({
  maxPerMinute: MAX_PER_MIN,
  minDelay: MIN_DELAY,
  maxDelay: MAX_DELAY
});

const bots = [];
const botConfig = {
  host: process.env.MC_HOST || 'localhost',
  port: parseInt(process.env.MC_PORT) || 25565
};

console.log('=== Xandaris Chatbots ===');
console.log(`Starting ${BOT_COUNT} bots -> ${botConfig.host}:${botConfig.port}`);

for (let i = 0; i < BOT_COUNT; i++) {
  const profile = personalities[i];
  const bot = new ChatBot(profile, cm, botConfig);
  bots.push(bot);
  setTimeout(() => {
    bot.connect();
    setupChatListener(bot);
  }, i * 5000);
}

function setupChatListener(currentBot) {
  const checkReady = setInterval(() => {
    if (currentBot.bot) {
      clearInterval(checkReady);
      currentBot.bot.on('chat', async (username, message) => {
        const botNames = bots.map(b => b.username);
        const isFromBot = botNames.includes(username);

        for (const bot of bots) {
          if (bot.username === username) continue;
          if (!bot.connected) continue;
          if (cm.isRateLimited()) continue;

          const respondChance = isFromBot ? bot.chattiness * 0.3 : bot.chattiness;
          if (Math.random() > respondChance) continue;

          const delay = cm.getRandomDelay();
          setTimeout(async () => {
            if (cm.isRateLimited()) return;
            const response = await cm.generateResponse(bot);
            if (response) {
              const typingDelay = cm.getTypingDelay(response);
              setTimeout(() => bot.chat(response), typingDelay);
            }
          }, delay);
          break;
        }
      });
    }
  }, 1000);
}

function scheduleConversationStarter() {
  const interval = CONV_MIN + Math.random() * (CONV_MAX - CONV_MIN);
  setTimeout(async () => {
    if (cm.isRateLimited()) {
      scheduleConversationStarter();
      return;
    }
    const connectedBots = bots.filter(b => b.connected);
    if (connectedBots.length === 0) {
      scheduleConversationStarter();
      return;
    }
    const starter = connectedBots[Math.floor(Math.random() * connectedBots.length)];
    const message = await cm.generateConversationStarter(starter);
    if (message) {
      console.log(`[Convo Starter] ${starter.username}: ${message}`);
      await starter.chat(message);
    }
    scheduleConversationStarter();
  }, interval);
}

setTimeout(() => {
  scheduleConversationStarter();
  console.log('Conversation starters active.');
}, BOT_COUNT * 5000 + 5000);

process.on('SIGINT', () => {
  console.log('\nShutting down bots...');
  bots.forEach(bot => { if (bot.bot) bot.bot.quit(); });
  setTimeout(() => process.exit(0), 2000);
});

console.log('Bot orchestrator running. Press Ctrl+C to stop.');
INDEXJS

# --- Install npm dependencies ---
echo "[4/5] Installing npm dependencies..."
npm install

# --- Done ---
echo "[5/5] Setup complete!"
echo ""
echo "Next steps:"
echo "  1. cp .env.example .env"
echo "  2. nano .env   # Add your OPENAI_API_KEY"
echo "  3. pm2 start index.js --name xandaris-bots"
echo "  4. pm2 logs xandaris-bots"

import mineflayer from 'mineflayer';
import crypto from 'crypto';

function offlineUUID(username) {
  const md5 = crypto.createHash('md5').update('OfflinePlayer:' + username).digest();
  md5[6] = (md5[6] & 0x0f) | 0x30;
  md5[8] = (md5[8] & 0x3f) | 0x80;
  const hex = md5.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

// Parse kick reason — mineflayer passes JSON chat component string or object
function parseKickReason(reason) {
  if (!reason) return 'unknown';
  if (typeof reason === 'string') {
    try {
      const parsed = JSON.parse(reason);
      return extractText(parsed);
    } catch {
      return reason;
    }
  }
  if (typeof reason === 'object') return extractText(reason);
  return String(reason);
}

function extractText(obj) {
  if (typeof obj === 'string') return obj;
  let text = obj.text || '';
  if (obj.extra) {
    for (const part of obj.extra) {
      text += extractText(part);
    }
  }
  if (obj.translate) text += obj.translate;
  return text || JSON.stringify(obj);
}

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
    this.kickCount = 0;
    this.maxKickRetries = 5;
    this.afkInterval = null;
    this.wasKicked = false; // prevent double-reconnect from kicked + end
    this.parked = false; // when true, bot stays disconnected (dynamic scaling)
  }

  connect() {
    console.log(`[${this.username}] Connecting to ${this.config.host}:${this.config.port}...`);
    const uuid = offlineUUID(this.username);
    this.bot = mineflayer.createBot({
      host: this.config.host || 'localhost',
      port: this.config.port || 25565,
      username: this.username,
      version: false,
      auth: 'offline',
      hideErrors: false,
      fakeHost: 'localhost' + String.fromCharCode(0) + '127.0.0.1' + String.fromCharCode(0) + uuid
    });

    this.bot.on('login', () => {
      console.log(`[${this.username}] Connected!`);
      this.connected = true;
      this.kickCount = 0; // reset on successful login

      // Fake ping: intercept keep_alive and delay response to simulate real latency
      const client = this.bot._client;
      const basePing = 50 + Math.random() * 60; // each bot gets a stable base 50-110ms
      client._keepAliveHandler = client.listeners('keep_alive')?.[0];
      if (client._keepAliveHandler) {
        client.removeListener('keep_alive', client._keepAliveHandler);
        client.on('keep_alive', (packet) => {
          const delay = basePing + (Math.random() - 0.5) * 2; // ±1ms jitter
          setTimeout(() => {
            client.write('keep_alive', { keepAliveId: packet.keepAliveId });
          }, delay);
        });
      }
    });

    // Chat history is managed by the global listener in index.js (not per-bot)

    this.bot.on('error', (err) => {
      console.error(`[${this.username}] Error: ${err.message}`);
    });

    this.bot.on('end', (reason) => {
      console.log(`[${this.username}] Disconnected: ${reason}`);
      this.connected = false;
      if (this.parked) return; // parked by scaler — don't reconnect
      // Don't reconnect here if kicked — the kicked handler handles it
      if (this.wasKicked) {
        this.wasKicked = false;
        return;
      }
      const jitter = this.reconnectDelay + Math.random() * 30000; // 10-40s stagger
      setTimeout(() => this.connect(), jitter);
    });

    this.bot.on('kicked', (reason) => {
      const readable = parseKickReason(reason);
      console.log(`[${this.username}] Kicked: ${readable}`);
      this.connected = false;
      this.wasKicked = true;
      this.kickCount++;

      if (this.kickCount >= this.maxKickRetries) {
        console.error(`[${this.username}] Kicked ${this.kickCount} times in a row, giving up. Manual restart needed.`);
        return; // don't reconnect
      }

      // Exponential backoff: 30s, 60s, 120s, 240s...
      const backoff = this.reconnectDelay * 3 * Math.pow(2, this.kickCount - 1);
      console.log(`[${this.username}] Reconnecting in ${Math.round(backoff / 1000)}s (attempt ${this.kickCount}/${this.maxKickRetries})`);
      setTimeout(() => this.connect(), backoff);
    });

    this.startAntiAFK();
  }

  startAntiAFK() {
    if (this.afkInterval) clearInterval(this.afkInterval);
    this.afkInterval = setInterval(() => {
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

  park(delay = 0) {
    if (this.parked) return;
    this.parked = true;
    this._parkTimer = setTimeout(() => {
      this._parkTimer = null;
      if (!this.parked) return; // unparked while waiting
      console.log(`[${this.username}] Parked (scaling down)`);
      if (this.bot && this.connected) {
        if (this.bot) this.bot.end();
      }
    }, delay);
  }

  unpark() {
    if (!this.parked) return;
    this.parked = false;
    // Cancel pending park disconnect
    if (this._parkTimer) {
      clearTimeout(this._parkTimer);
      this._parkTimer = null;
    }
    // Only reconnect if not already connected
    if (this.connected) {
      console.log(`[${this.username}] Unparked (already connected)`);
      return;
    }
    console.log(`[${this.username}] Unparked (scaling up)`);
    setTimeout(() => {
      if (!this.connected && !this.parked) this.connect();
    }, 10000 + Math.random() * 10000);
  }

  async chat(message) {
    if (!this.connected || !message) return;
    const lines = message.split('\n').map(l => l.trim()).filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, 250 + Math.random() * 550));
      this.bot.chat(lines[i]);
    }
    this.cm.addMessage(this.username, message, { isBot: true });
    this.cm.recordBotMessage();
  }

  shouldRespond() {
    return Math.random() < this.chattiness;
  }
}

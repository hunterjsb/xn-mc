/**
 * Shared utilities used by both index.js (regular chatbots) and revival-main.js (revival bots).
 */

import net from 'net';

// Parse "nickname » message" from system_chat text (LPC format via FreedomChat)
export function parseChatFromSystem(text) {
  const match = text.match(/^(.+?)\s+[»>]\s+(.+)$/);
  if (!match) return null;
  return { nickname: match[1].trim(), message: match[2].trim() };
}

// Resolve a nickname/display name back to the real username
// Takes a players object (bot.players from any mineflayer bot)
export function resolveUsername(players, nickname) {
  if (!players) return null;
  const lower = nickname.toLowerCase();
  const names = Object.keys(players);
  // Direct match on username
  for (const name of names) {
    if (name === nickname) return name;
  }
  // Case-insensitive exact match
  for (const name of names) {
    if (lower === name.toLowerCase()) return name;
  }
  // Nickname contains username (e.g. "☭ samboyd" contains "samboyd")
  for (const name of names) {
    if (lower.includes(name.toLowerCase())) return name;
  }
  // Username contains nickname (reverse check)
  for (const name of names) {
    if (name.toLowerCase().includes(lower)) return name;
  }
  // Fuzzy: same sorted letters (handles swaps like Lkgye → Lkyge)
  const sortedNick = lower.split('').sort().join('');
  for (const name of names) {
    const sortedName = name.toLowerCase().split('').sort().join('');
    if (sortedNick === sortedName) return name;
  }
  return null;
}

// RCON helper — raw TCP connection to Minecraft RCON
export function rcon(command) {
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

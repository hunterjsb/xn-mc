#!/usr/bin/env node
/**
 * Revival Bot Benchmark Runner
 *
 * Benchmarks:
 *   pick     — From empty inventory, craft a wooden_pickaxe
 *   food     — From wooden tools, kill an animal and cook food
 *   shears   — From wooden tools + food, mine iron, smelt, craft shears
 *   diamonds — From empty, find diamonds in a chest and craft full armor
 *
 * Usage:
 *   node benchmark.js pick              # run one benchmark
 *   node benchmark.js all               # run all
 *   node benchmark.js all --runs 5      # 5 runs each
 *   node benchmark.js all --parallel 3  # 3 bots at once
 *   node benchmark.js all --runs 5 --parallel 5 --model x-ai/grok-4.1-fast
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import { rcon } from './shared.js';
import { compileBenchmarks } from './compile-benchmarks.js';
import './env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_PATH = path.join(__dirname, 'benchmarks', 'results.jsonl');

const API = 'http://localhost:8765';

const BENCH_NAMES = [
  'Archaeo', 'Basalt', 'Calcite', 'Diorite', 'Elytra',
  'Flint', 'Gravel', 'Hopper', 'Ignite', 'Jasper',
  'Kelp', 'Lapis', 'Magma', 'Nether', 'Obsidian',
  'Prism', 'Quartz', 'Redstone', 'Shulker', 'Tundra',
];
const OWNER = 'BrezzyTracks';
const OWNER_MODEL = 'gpt-5-mini';

// Diverse speech styles for benchmarks — randomly assigned to each run
const CHAT_STYLES = [
  { chatStyle: 'Short lowercase messages, no punctuation', samplePhrases: ['yo', 'got it', 'done', 'whats next'] },
  { chatStyle: 'Enthusiastic and energetic, lots of exclamation marks', samplePhrases: ['lets go!', 'awesome!', 'on it!', 'heck yeah!'] },
  { chatStyle: 'Calm and measured, proper grammar', samplePhrases: ['Understood.', 'Working on it now.', 'I have completed the task.', 'What would you like next?'] },
  { chatStyle: 'Terse military-style responses', samplePhrases: ['copy', 'roger', 'affirmative', 'moving out'] },
  { chatStyle: 'Chill surfer vibe, laid back', samplePhrases: ['duude', 'no worries', 'totally', 'vibin'] },
  { chatStyle: 'Slightly confused but trying their best', samplePhrases: ['uhh ok', 'i think i got it', 'wait which one', 'lemme try'] },
  { chatStyle: 'Overly polite and formal', samplePhrases: ['Of course!', 'Right away, sir.', 'It would be my pleasure.', 'Certainly.'] },
  { chatStyle: 'Gen-Z internet speak, abbreviations', samplePhrases: ['bet', 'ngl', 'fr fr', 'say less'] },
  { chatStyle: 'Grumpy but competent', samplePhrases: ['fine', 'whatever', 'yeah yeah', 'there happy now'] },
  { chatStyle: 'Pirate speak', samplePhrases: ['aye aye', 'arrr', 'ye want me to what', 'shiver me timbers'] },
];

// Owner LLM client (always gpt-5-mini via OpenAI)
const ownerClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Benchmark definitions ────────────────────────────────────────────

export const BENCHMARKS = {
  pick: {
    name: 'Wooden Pickaxe',
    startItems: [],
    goal: 'mine 4 oak_log, craft planks, craft crafting_table, place it, craft sticks, craft wooden_pickaxe',
    successItems: ['wooden_pickaxe'],
    timeout: 600_000,
  },
  food: {
    name: 'Cooked Food',
    startItems: [
      'wooden_pickaxe 1', 'wooden_sword 1', 'wooden_axe 1',
      'cobblestone 8', 'oak_planks 16', 'stick 8', 'crafting_table 1',
    ],
    goal: 'craft a furnace, place it, kill a cow or pig, smelt the raw meat with oak_planks as fuel, then eat the cooked food (you are hungry!)',
    successCheck: 'food_eaten', // custom: check food level restored
    timeout: 600_000,
  },
  shears: {
    name: 'Iron Shears',
    startItems: [
      'wooden_pickaxe 1', 'wooden_sword 1', 'stone_pickaxe 1',
      'furnace 1', 'torch 16', 'cooked_beef 5',
      'oak_planks 32', 'cobblestone 16', 'stick 8',
    ],
    goal: 'mine 2 iron_ore, place the furnace, smelt the raw_iron with oak_planks as fuel, craft shears',
    successItems: ['shears'],
    timeout: 600_000,
  },
  diamonds: {
    name: 'Diamond Armor',
    startItems: [],
    goal: 'get diamonds from the nearby chest, craft a full set of diamond armor (helmet, chestplate, leggings, boots), and EQUIP all 4 pieces',
    successCheck: 'diamond_armor_equipped', // custom: check armor slots
    timeout: 600_000,
  },
  sleep: {
    name: 'Craft Bed & Sleep',
    startItems: [
      'wooden_sword 1', 'torch 4',
    ],
    goal: 'it is nighttime and dangerous! check the nearby chest for wool and planks, craft a bed, place it, and sleep in it',
    successCheck: 'slept', // custom: check SleepTimer or bed_used advancement
    timeout: 300_000, // 5 min
  },
  collect: {
    name: 'Resource Collection',
    startItems: [
      'iron_pickaxe 1', 'iron_axe 1', 'iron_shovel 1', 'bread 8',
    ],
    goal: 'dig 16 dirt, chop 8 of any type of log (oak birch spruce etc), and mine 16 stone to get cobblestone',
    successCounts: { dirt: 16, _log: 8, cobblestone: 16 },
    timeout: 600_000,
  },
};

const COOKED_FOODS = new Set([
  'cooked_beef', 'cooked_porkchop', 'cooked_chicken',
  'cooked_mutton', 'cooked_rabbit', 'cooked_salmon', 'cooked_cod',
]);

// ── Helpers ──────────────────────────────────────────────────────────

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API}${path}`, opts);
  return res.json();
}

async function waitForBot(name, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { bots } = await api('GET', '/rblist');
    const bot = bots.find(b => b.name === name && b.connected);
    if (bot) return bot;
    await sleep(2000);
  }
  throw new Error(`Bot ${name} did not connect within ${timeoutMs / 1000}s`);
}

async function getInventory(player) {
  const items = [];
  // Slots 0-35 = main inventory
  for (const i of Array(36).keys()) {
    try {
      const resp = await rcon(`data get entity ${player} Inventory[{Slot:${i}b}]`);
      if (resp.includes('No elements') || resp.includes('Found no')) continue;
      const m = resp.match(/id: "minecraft:(\w+)".*?count: (\d+)/);
      if (m) items.push({ name: m[1], count: parseInt(m[2]), slot: i });
    } catch { continue; }
  }
  // MC 1.21+ equipment slots (armor + held items)
  for (const [slot, idx] of [['feet', 100], ['legs', 101], ['chest', 102], ['head', 103]]) {
    try {
      const resp = await rcon(`data get entity ${player} equipment.${slot}`);
      if (resp.includes('Found no') || resp.includes('{}')) continue;
      const m = resp.match(/id: "minecraft:(\w+)".*?count: (\d+)/);
      if (m) items.push({ name: m[1], count: parseInt(m[2]), slot: idx });
    } catch { continue; }
  }
  return items;
}

// Check if specific items are equipped (MC 1.21+ uses equipment NBT, not Inventory slots)
async function hasEquippedArmor(player, armorItems) {
  const slotMap = { head: 'helmet', chest: 'chestplate', legs: 'leggings', feet: 'boots' };
  const equipped = [];
  for (const slot of ['head', 'chest', 'legs', 'feet']) {
    try {
      const resp = await rcon(`data get entity ${player} equipment.${slot}`);
      const m = resp.match(/id: "minecraft:(\w+)"/);
      if (m) equipped.push(m[1]);
    } catch {}
  }
  return armorItems.every(name => equipped.includes(name));
}

// Check player's food/hunger level (returns -1 on error instead of 20)
async function getFoodLevel(player) {
  try {
    const resp = await rcon(`data get entity ${player} foodLevel`);
    const m = resp.match(/(\d+)$/);
    return m ? parseInt(m[1]) : -1;
  } catch { return -1; }
}

async function hasItem(player, itemNames, requireAll = false) {
  const inv = await getInventory(player);
  if (requireAll) return itemNames.every(name => inv.some(i => i.name === name));
  return inv.some(i => itemNames.includes(i.name));
}

async function hasRequiredCounts(player, counts) {
  const inv = await getInventory(player);
  for (const [key, need] of Object.entries(counts)) {
    // Keys starting with _ are suffix matches (e.g. _log matches oak_log, birch_log, etc.)
    const total = key.startsWith('_')
      ? inv.filter(i => i.name.endsWith(key)).reduce((s, i) => s + i.count, 0)
      : inv.filter(i => i.name === key).reduce((s, i) => s + i.count, 0);
    if (total < need) return false;
  }
  return true;
}

async function getPlayerPos(player) {
  try {
    const resp = await rcon(`data get entity ${player} Pos`);
    const m = resp.match(/([-\d.]+)d.*?([-\d.]+)d.*?([-\d.]+)d/);
    if (m) return { x: Math.round(parseFloat(m[1])), y: Math.round(parseFloat(m[2])), z: Math.round(parseFloat(m[3])) };
  } catch {}
  return { x: 0, y: 64, z: 0 };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fmtTime(ms) {
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
}

// ── Owner simulation ─────────────────────────────────────────────────

async function ownerReply(botMessage, goal, chatHistory) {
  try {
    const messages = [
      {
        role: 'system',
        content: `You are BrezzyTracks, a Minecraft player. Your bot is working on a task you gave it. Answer questions briefly and helpfully (1-2 sentences max). Be specific with Minecraft item/block IDs when relevant.\n\nTask you assigned: ${goal}`,
      },
      ...chatHistory.map(m => ({
        role: m.from === 'owner' ? 'assistant' : 'user',
        content: m.text,
      })),
      { role: 'user', content: botMessage },
    ];
    const res = await ownerClient.chat.completions.create({
      model: OWNER_MODEL,
      messages,
      max_completion_tokens: 1000,
    });
    return res.choices[0]?.message?.content?.trim() || '';
  } catch (err) {
    console.error(`  Owner LLM error: ${err.message}`);
    return '';
  }
}

// ── Spawn location ──────────────────────────────────────────────────

// Each worker gets a unique quadrant 10k+ blocks from spawn and from each other
const WORKER_ORIGINS = [
  { x:  10000, z:  10000 },
  { x: -10000, z:  10000 },
  { x:  10000, z: -10000 },
  { x: -10000, z: -10000 },
  { x:  20000, z:      0 },
  { x: -20000, z:      0 },
  { x:      0, z:  20000 },
  { x:      0, z: -20000 },
  { x:  15000, z:  15000 },
  { x: -15000, z: -15000 },
];

function getWorkerOrigin(workerId) {
  return WORKER_ORIGINS[workerId % WORKER_ORIGINS.length];
}

// ── Run a single benchmark ──────────────────────────────────────────

async function runBenchmark(benchId, botName, workerId = 0) {
  const bench = BENCHMARKS[benchId];
  if (!bench) throw new Error(`Unknown benchmark: ${benchId}`);
  const tag = `[${botName}/${benchId}]`;

  console.log(`\n${tag} ${'='.repeat(50)}`);
  console.log(`${tag}  BENCHMARK: ${bench.name}`);
  console.log(`${tag} ${'='.repeat(50)}`);

  // ── 1. Clean up any existing bot ──────────────────────────────────
  try { await rcon(`kick ${botName}`); } catch {}
  await sleep(3000);

  // ── 2. Spawn bot via revival API ──────────────────────────────────
  try { await rcon(`pardon ${botName}`); } catch {}
  try { await rcon(`op ${botName}`); } catch {}
  const style = CHAT_STYLES[Math.floor(Math.random() * CHAT_STYLES.length)];
  const profile = {
    personality: `A revived Minecraft player named ${botName}. Focused and task-oriented.`,
    chatStyle: style.chatStyle,
    samplePhrases: style.samplePhrases,
  };
  console.log(`${tag}  Chat style: ${style.chatStyle}`);
  // Spawn at 0,70,0 initially (loaded chunks), teleport to isolated area after connect
  await api('POST', '/revival', { reviver: OWNER, deadPlayer: botName, x: 0, y: 70, z: 0, botName, profile });

  // ── 3. Wait for connection ────────────────────────────────────────
  await waitForBot(botName);
  console.log(`${tag}  Connected!`);
  try { await rcon(`op ${botName}`); } catch {}
  await sleep(2000);

  // ── 4. Teleport to isolated area ──────────────────────────────────
  // Each worker gets a unique quadrant far from spawn and other workers
  const origin = getWorkerOrigin(workerId);
  const spreadResp = await rcon(`spreadplayers ${origin.x} ${origin.z} 50 500 false ${botName}`);
  await sleep(2000);
  let pos = await getPlayerPos(botName);

  // Verify bot actually moved — if still near 0,0 spreadplayers failed
  if (Math.abs(pos.x) < 100 && Math.abs(pos.z) < 100) {
    console.log(`${tag}  WARNING: spreadplayers may have failed (pos ${pos.x},${pos.z}), retrying...`);
    await rcon(`tp ${botName} ${origin.x} 100 ${origin.z}`);
    await sleep(1000);
    await rcon(`spreadplayers ${origin.x} ${origin.z} 50 500 false ${botName}`);
    await sleep(2000);
    pos = await getPlayerPos(botName);
  }
  console.log(`${tag}  Spawned at ${pos.x}, ${pos.y}, ${pos.z}`);

  // ── 5. Build environment ──────────────────────────────────────────
  // Clear a 5x5 platform and 3-high air space at spawn for ALL benchmarks
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      await rcon(`setblock ${pos.x + dx} ${pos.y - 1} ${pos.z + dz} minecraft:grass_block`);
      for (let dy = 0; dy <= 2; dy++) {
        await rcon(`setblock ${pos.x + dx} ${pos.y + dy} ${pos.z + dz} minecraft:air`);
      }
    }
  }

  // Benchmark-specific environment
  if (benchId === 'pick') {
    // Place oak logs nearby for mining
    for (let y = 0; y < 4; y++) {
      await rcon(`setblock ${pos.x + 3} ${pos.y + y} ${pos.z} minecraft:oak_log`);
      await rcon(`setblock ${pos.x - 3} ${pos.y + y} ${pos.z} minecraft:oak_log`);
    }
  } else if (benchId === 'shears') {
    // Place iron ore nearby with stone underneath
    for (const [dx, dz] of [[3, 0], [-3, 0], [0, 3]]) {
      const ox = pos.x + dx, oz = pos.z + dz;
      await rcon(`setblock ${ox} ${pos.y - 1} ${oz} minecraft:stone`);
      await rcon(`setblock ${ox} ${pos.y} ${oz} minecraft:iron_ore`);
      await rcon(`setblock ${ox} ${pos.y + 1} ${oz} minecraft:air`);
    }
  } else if (benchId === 'diamonds') {
    // Place chest with diamonds + crafting table
    const cx = pos.x + 3, cz = pos.z;
    await rcon(`setblock ${cx} ${pos.y - 1} ${cz} minecraft:stone`);
    await rcon(`setblock ${cx} ${pos.y} ${cz} minecraft:chest`);
    await rcon(`setblock ${cx} ${pos.y + 1} ${cz} minecraft:air`);
    await rcon(`item replace block ${cx} ${pos.y} ${cz} container.0 with minecraft:diamond 24`);
    await rcon(`item replace block ${cx} ${pos.y} ${cz} container.1 with minecraft:crafting_table 1`);
  } else if (benchId === 'sleep') {
    // Place chest with bed-crafting materials
    const cx = pos.x + 3, cz = pos.z;
    await rcon(`setblock ${cx} ${pos.y - 1} ${cz} minecraft:stone`);
    await rcon(`setblock ${cx} ${pos.y} ${cz} minecraft:chest`);
    await rcon(`setblock ${cx} ${pos.y + 1} ${cz} minecraft:air`);
    await rcon(`item replace block ${cx} ${pos.y} ${cz} container.0 with minecraft:white_wool 3`);
    await rcon(`item replace block ${cx} ${pos.y} ${cz} container.1 with minecraft:oak_planks 3`);
    await rcon(`item replace block ${cx} ${pos.y} ${cz} container.2 with minecraft:crafting_table 1`);
    // Revoke sleep advancement for detection
    await rcon(`advancement revoke ${botName} only minecraft:adventure/sleep_in_bed`).catch(() => {});
  }

  // ── 6. Set inventory ──────────────────────────────────────────────
  await rcon(`clear ${botName}`);
  for (const item of bench.startItems) {
    const [name, count] = item.split(' ');
    await rcon(`give ${botName} minecraft:${name} ${count || 1}`);
  }
  console.log(`${tag}  Inventory: ${bench.startItems.length > 0 ? bench.startItems.join(', ') : 'empty'}`);

  // ── 7. Wait for greeting cycle ────────────────────────────────────
  console.log(`${tag}  Waiting for greeting cycle...`);
  for (let i = 0; i < 15; i++) {
    await sleep(2000);
    const { bots } = await api('GET', '/rblist');
    const bot = bots.find(b => b.name === botName);
    if (bot && bot.state === 'idle' && bot.pending === 0) break;
  }

  // Teleport bot back (may have wandered during greeting)
  await rcon(`tp ${botName} ${pos.x} ${pos.y} ${pos.z}`);
  await sleep(1000);

  // ── 8. Pre-goal setup ─────────────────────────────────────────────
  if (benchId === 'food') {
    // Spawn animals nearby
    await rcon(`summon cow ${pos.x + 3} ${pos.y} ${pos.z}`);
    await rcon(`summon cow ${pos.x - 3} ${pos.y} ${pos.z}`);
    await rcon(`summon pig ${pos.x} ${pos.y} ${pos.z + 3}`);
  }

  // Reset bench metrics
  await api('POST', `/bench/reset?bot=${botName}`);

  // Drain hunger for food benchmark
  if (benchId === 'food') {
    console.log(`${tag}  Draining hunger...`);
    // Phase 1: Burn saturation buffer (~3s at amp 255)
    await rcon(`effect give ${botName} hunger 3 255 true`);
    await sleep(3500);
    await rcon(`effect clear ${botName} hunger`);
    // Phase 2: Controlled food drain (amp 50 ≈ 1.5 food/sec)
    await rcon(`effect give ${botName} hunger 30 50 true`);
    for (let i = 1; i <= 20; i++) {
      await sleep(1000);
      const fl = await getFoodLevel(botName);
      if (fl >= 0 && fl <= 6) break;
    }
    await rcon(`effect clear ${botName} hunger`);
    const fl = await getFoodLevel(botName);
    console.log(`${tag}  Food level: ${fl}`);
    if (fl > 10) console.log(`${tag}  WARNING: Hunger drain incomplete`);
  }

  // Set time for sleep benchmark + clear mobs + give resistance so bot doesn't die crafting
  if (benchId === 'sleep') {
    await rcon('time set midnight');
    await rcon(`kill @e[type=!player,distance=..100,x=${pos.x},y=${pos.y},z=${pos.z}]`);
    await rcon(`effect give ${botName} resistance 300 255 true`);
  }

  // ── 9. Send goal ──────────────────────────────────────────────────
  console.log(`${tag}  Goal: ${bench.goal}`);
  await api('POST', '/rbsay', { bot: botName, message: bench.goal, as: OWNER });
  const startTime = Date.now();
  console.log(`${tag}  Started at ${new Date().toLocaleTimeString()}`);
  console.log(`${tag}  Timeout: ${fmtTime(bench.timeout)}`);

  // 8. Poll for completion
  let success = false;
  let lastState = '';
  let retries = 0;
  let lastToolTime = startTime;
  let lastLogIdx = 0;  // track how far we've scanned the bench log
  const ownerChat = [];  // {from: 'bot'|'owner', text, t}
  while (Date.now() - startTime < bench.timeout) {
    await sleep(5000);

    // Check for success (custom or standard)
    try {
      let passed = false;
      if (bench.successCheck === 'diamond_armor_equipped') {
        passed = await hasEquippedArmor(botName, ['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots']);
      } else if (bench.successCheck === 'food_eaten') {
        // Success = food level restored above 6 (started at ~0 after hunger drain)
        const fl = await getFoodLevel(botName);
        passed = fl > 0 && fl >= 7;  // -1 = error, don't pass on error
      } else if (bench.successCheck === 'slept') {
        // Keep it nighttime (in case another bot sleeping advanced time) and clear mobs
        try { await rcon('time set midnight'); } catch {}
        try { await rcon(`execute at ${botName} run kill @e[type=!player,distance=..100,type=!item]`); } catch {}
        // Check if bot actually slept using the "Sweet Dreams" advancement (most reliable)
        try {
          const resp = await rcon(`execute if entity @a[name=${botName},advancements={minecraft:adventure/sleep_in_bed=true}]`);
          if (resp.includes('Test passed')) { passed = true; }
        } catch {}
      } else if (bench.successCounts) {
        passed = await hasRequiredCounts(botName, bench.successCounts);
      } else if (bench.successItems) {
        passed = await hasItem(botName, bench.successItems, bench.successAll);
      }
      if (passed) {
        success = true;
        break;
      }
    } catch {}

    // Check if bot is still alive + detect whispers for owner replies
    try {
      const { bots } = await api('GET', '/rblist');
      const bot = bots.find(b => b.name === botName);
      if (!bot || !bot.connected) {
        console.log(`${tag}  Bot disconnected!`);
        break;
      }
      const stateStr = `${bot.state} | obj: ${bot.objectives?.map(o => o.text).join(', ') || 'none'}`;
      if (stateStr !== lastState) {
        console.log(`${tag}  [${fmtTime(Date.now() - startTime)}] ${stateStr}`);
        lastState = stateStr;
      }

      // Scan for new whisper tool calls → owner replies
      try {
        const metrics = await api('GET', `/bench/metrics?bot=${botName}`);
        const log = metrics.log || [];
        for (let i = lastLogIdx; i < log.length; i++) {
          const e = log[i];
          if (e.type === 'tool' && e.name === 'whisper' && e.params?.player?.toLowerCase() === OWNER.toLowerCase() && e.params?.message) {
            const botMsg = e.params.message;
            console.log(`${tag}  [${fmtTime(Date.now() - startTime)}] Bot asks: "${botMsg}"`);
            ownerChat.push({ from: 'bot', text: botMsg, t: Date.now() - startTime });
            const reply = await ownerReply(botMsg, bench.goal, ownerChat);
            if (reply) {
              console.log(`${tag}  [${fmtTime(Date.now() - startTime)}] Owner replies: "${reply}"`);
              ownerChat.push({ from: 'owner', text: reply, t: Date.now() - startTime });
              await api('POST', '/rbsay', { bot: botName, message: reply, as: OWNER });
              lastToolTime = Date.now();  // reset idle timer
            }
          }
        }
        lastLogIdx = log.length;
      } catch {}

      // If bot is idle for 20s, resend goal (max 4 retries)
      if (bot.state !== 'idle') {
        lastToolTime = Date.now();
      } else if (Date.now() - lastToolTime > 20_000 && retries < 4) {
        retries++;
        console.log(`${tag}  [${fmtTime(Date.now() - startTime)}] Resending goal (retry ${retries}/4)...`);
        await api('POST', '/rbsay', { bot: botName, message: bench.goal, as: OWNER });
        lastToolTime = Date.now();
      }
    } catch {}
  }

  const elapsed = Date.now() - startTime;

  // 9. Collect metrics
  let metrics = {};
  try {
    metrics = await api('GET', `/bench/metrics?bot=${botName}`);
  } catch {}

  // 10. Get final inventory
  let finalInv = [];
  try { finalInv = await getInventory(botName); } catch {}

  // 11. Clean up
  try { await rcon(`kick ${botName}`); } catch {}

  // 12. Build result
  const toolLog = (metrics.log || []).filter(e => e.type === 'tool');
  const result = {
    benchmark: benchId,
    name: bench.name,
    success,
    elapsed,
    timeout: bench.timeout,
    elapsedStr: fmtTime(elapsed),
    toolCalls: metrics.totalToolCalls || 0,
    chatMessages: metrics.totalChats || 0,
    idleTicks: metrics.totalIdles || 0,
    failures: metrics.totalFailures || 0,
    chatStyle: style.chatStyle,
    inventory: finalInv.map(i => `${i.name} x${i.count}`),
    log: metrics.log || [],
    toolLog: toolLog.map(e => ({ name: e.name, params: e.params, t: e.t })),
    ownerModel: OWNER_MODEL,
    ownerInteractions: ownerChat.filter(m => m.from === 'bot').length,
    ownerChat,
    pos,
  };

  // 13. Print result
  console.log(`${tag}  ${'─'.repeat(40)}`);
  console.log(`${tag}  Result: ${success ? 'SUCCESS' : 'FAIL'}`);
  console.log(`${tag}  Time:   ${result.elapsedStr}`);
  console.log(`${tag}  Tools:  ${result.toolCalls} calls (${result.failures} failed)`);
  if (result.ownerInteractions > 0) {
    console.log(`${tag}  Owner:  ${result.ownerInteractions} questions answered`);
  }
  console.log(`${tag}  Inventory: ${result.inventory.join(', ') || 'empty'}`);

  if (toolLog.length > 0) {
    console.log(`${tag}  Tool sequence:`);
    for (const e of toolLog) {
      const params = Object.keys(e.params || {}).length > 0 ? JSON.stringify(e.params) : '';
      const t = result.log[0] ? Math.round((e.t - result.log[0].t) / 1000) : 0;
      console.log(`${tag}    +${t}s  ${e.name}(${params})`);
    }
  }

  return result;
}

// ── Persistence ─────────────────────────────────────────────────────

function saveResult(result, model) {
  const record = {
    model,
    bench: result.benchmark,
    success: result.success,
    elapsed: result.elapsed || 0,
    timeout: result.timeout || 300_000,
    toolCalls: result.toolCalls || 0,
    failures: result.failures || 0,
    chatMessages: result.chatMessages || 0,
    idleTicks: result.idleTicks || 0,
    ownerModel: result.ownerModel || OWNER_MODEL,
    ownerInteractions: result.ownerInteractions || 0,
    chatStyle: result.chatStyle || null,
    ownerChat: result.ownerChat || [],
    toolLog: result.toolLog || [],
    inventory: result.inventory || [],
    pos: result.pos || { x: 0, y: 70, z: 0 },
    ts: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(RESULTS_PATH), { recursive: true });
  fs.appendFileSync(RESULTS_PATH, JSON.stringify(record) + '\n');
  console.log(`  Saved to ${path.relative(process.cwd(), RESULTS_PATH)}`);
}

// ── Main ─────────────────────────────────────────────────────────────

async function setRevivalModel(model) {
  const { execSync } = await import('child_process');
  if (model) {
    console.log(`  Switching revival model to: ${model}`);
    execSync(`REVIVAL_MODEL=${model} pm2 restart xandaris-revival --update-env`, { stdio: 'pipe' });
  } else {
    console.log(`  Restoring default revival model...`);
    execSync(`REVIVAL_MODEL= pm2 restart xandaris-revival --update-env`, { stdio: 'pipe' });
  }
  await sleep(5000);
}

async function main() {
  const args = process.argv.slice(2);
  let benchIds = [];
  let runs = 1;
  let parallel = 1;
  let model = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--runs' && args[i + 1]) {
      runs = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--parallel' && args[i + 1]) {
      parallel = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--model' && args[i + 1]) {
      model = args[i + 1];
      i++;
    } else if (args[i] === 'all') {
      benchIds = Object.keys(BENCHMARKS);
    } else if (BENCHMARKS[args[i]]) {
      benchIds.push(args[i]);
    } else {
      console.error(`Unknown benchmark or option: ${args[i]}`);
      console.error(`Available: ${Object.keys(BENCHMARKS).join(', ')}, all`);
      console.error(`Options: --runs N, --parallel N, --model <model-name>`);
      process.exit(1);
    }
  }

  if (benchIds.length === 0) {
    console.log('Revival Bot Benchmarks');
    console.log('Usage: node benchmark.js <bench> [<bench>...] [--runs N] [--parallel N] [--model <model-name>]');
    console.log(`Available: ${Object.keys(BENCHMARKS).join(', ')}, all`);
    console.log(`Models: gpt-5-mini (default), x-ai/grok-4.1-fast, anthropic/claude-haiku-4.5, etc.`);
    process.exit(0);
  }

  if (model) await setRevivalModel(model);

  // Build job queue: [{benchId, run}]
  const jobs = [];
  for (let run = 0; run < runs; run++) {
    for (const id of benchIds) {
      jobs.push({ benchId: id, run });
    }
  }

  const m = model || 'gpt-5-mini';
  const allResults = [];
  let jobIdx = 0;

  // Set time to day (sleep benchmarks set time to midnight individually before their goal)
  await rcon('time set day');

  console.log(`\n  ${jobs.length} jobs, ${parallel} parallel workers, model: ${m}`);

  // Worker: pulls jobs from queue, runs them with assigned bot name
  async function worker(workerId) {
    const botName = BENCH_NAMES[workerId % BENCH_NAMES.length];
    while (jobIdx < jobs.length) {
      const idx = jobIdx++;
      const job = jobs[idx];
      console.log(`\n  [Worker ${workerId}] Job ${idx + 1}/${jobs.length}: ${job.benchId} (run ${job.run + 1})`);
      try {
        const result = await runBenchmark(job.benchId, botName, workerId);
        result.model = m;
        allResults.push(result);
        saveResult(result, m);
      } catch (err) {
        console.error(`  [Worker ${workerId}] ERROR: ${err.message}`);
        const failResult = { benchmark: job.benchId, success: false, error: err.message, model: m, timeout: BENCHMARKS[job.benchId]?.timeout || 300_000 };
        allResults.push(failResult);
        saveResult(failResult, m);
      }
      try { compileBenchmarks(); } catch {}
    }
  }

  // Launch workers
  const workers = [];
  for (let i = 0; i < parallel; i++) {
    workers.push(worker(i));
  }
  await Promise.all(workers);

  // Summary
  if (allResults.length > 1) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  SUMMARY${model ? ` (${model})` : ''}`);
    console.log(`${'='.repeat(60)}`);

    const grouped = {};
    for (const r of allResults) {
      if (!grouped[r.benchmark]) grouped[r.benchmark] = [];
      grouped[r.benchmark].push(r);
    }

    for (const [id, results] of Object.entries(grouped)) {
      const successes = results.filter(r => r.success);
      const avgTime = successes.length > 0
        ? Math.round(successes.reduce((s, r) => s + r.elapsed, 0) / successes.length)
        : null;
      const avgTools = successes.length > 0
        ? Math.round(successes.reduce((s, r) => s + (r.toolCalls || 0), 0) / successes.length)
        : null;
      const avgFailures = successes.length > 0
        ? Math.round(successes.reduce((s, r) => s + (r.failures || 0), 0) / successes.length)
        : null;

      console.log(`\n  ${BENCHMARKS[id]?.name || id}:`);
      console.log(`    Pass rate:  ${successes.length}/${results.length} (${Math.round(100 * successes.length / results.length)}%)`);
      if (avgTime != null) console.log(`    Avg time:   ${fmtTime(avgTime)}`);
      if (avgTools != null) console.log(`    Avg tools:  ${avgTools} calls`);
      if (avgFailures != null) console.log(`    Avg fails:  ${avgFailures}`);
    }
  }

  if (model) await setRevivalModel(null);

  console.log('\nDone.');
  process.exit(0);
}

// Only run CLI when executed directly (not imported)
const __benchmark_filename = fileURLToPath(import.meta.url);
if (process.argv[1] === __benchmark_filename) {
  main().catch(err => { console.error(err); process.exit(1); });
}

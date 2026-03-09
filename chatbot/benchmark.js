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
const OWNER = 'BrezzyTracks';
const OWNER_MODEL = 'gpt-5-mini';

// Owner LLM client (always gpt-5-mini via OpenAI)
const ownerClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Benchmark definitions ────────────────────────────────────────────

export const BENCHMARKS = {
  pick: {
    name: 'Wooden Pickaxe',
    startItems: [],
    goal: 'mine 4 oak_log, craft planks, craft crafting_table, place it, craft sticks, craft wooden_pickaxe',
    successItems: ['wooden_pickaxe'],
    timeout: 300_000,
  },
  food: {
    name: 'Cooked Food',
    startItems: [
      'wooden_pickaxe 1', 'wooden_sword 1', 'wooden_axe 1',
      'cobblestone 8', 'oak_planks 16', 'stick 8', 'crafting_table 1',
    ],
    goal: 'craft a furnace, place it, kill a cow or pig, smelt the raw meat with oak_planks as fuel',
    successItems: ['cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_rabbit'],
    timeout: 300_000,
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
    timeout: 300_000,
  },
  diamonds: {
    name: 'Diamond Armor',
    startItems: [],
    goal: 'get diamonds and craft a full set of diamond armor',
    successItems: ['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots'],
    successAll: true,  // require ALL items, not just one
    timeout: 300_000,
  },
  collect: {
    name: 'Resource Collection',
    startItems: [
      'iron_pickaxe 1', 'iron_axe 1', 'iron_shovel 1', 'bread 8',
    ],
    goal: 'dig 16 dirt, chop 8 of any type of log (oak birch spruce etc), and mine 16 stone to get cobblestone',
    successCounts: { dirt: 16, _log: 8, cobblestone: 16 },
    timeout: 300_000,
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
  // Slots 0-35 = main inventory, 100-103 = armor (boots, leggings, chestplate, helmet)
  const slots = [...Array(36).keys(), 100, 101, 102, 103];
  for (const i of slots) {
    try {
      const resp = await rcon(`data get entity ${player} Inventory[{Slot:${i}b}]`);
      if (resp.includes('No elements') || resp.includes('Found no')) continue;
      const m = resp.match(/id: "minecraft:(\w+)".*?count: (\d+)/);
      if (m) items.push({ name: m[1], count: parseInt(m[2]) });
    } catch { continue; }
  }
  return items;
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
      max_tokens: 100,
      temperature: 0.3,
    });
    return res.choices[0]?.message?.content?.trim() || '';
  } catch (err) {
    console.error(`  Owner LLM error: ${err.message}`);
    return '';
  }
}

// ── Spawn location ──────────────────────────────────────────────────

function randomCoords() {
  return {
    x: Math.floor(Math.random() * 2500) - 1250,
    z: Math.floor(Math.random() * 2500) - 1250,
  };
}

// ── Run a single benchmark ──────────────────────────────────────────

async function runBenchmark(benchId, botName) {
  const bench = BENCHMARKS[benchId];
  if (!bench) throw new Error(`Unknown benchmark: ${benchId}`);
  const tag = `[${botName}/${benchId}]`;

  console.log(`\n${tag} ${'='.repeat(50)}`);
  console.log(`${tag}  BENCHMARK: ${bench.name}`);
  console.log(`${tag} ${'='.repeat(50)}`);

  // 1. Clean up any existing bot
  try { await rcon(`kick ${botName}`); } catch {}
  await sleep(3000);

  // 2. Pardon + OP (deathban.immune) + spawn bot at world spawn first
  try { await rcon(`pardon ${botName}`); } catch {}
  try { await rcon(`op ${botName}`); } catch {}
  // Spawn at world spawn (loaded chunks), then spreadplayers to random location
  await api('POST', '/revival', { reviver: OWNER, deadPlayer: botName, x: 0, y: 70, z: 0 });

  // 3. Wait for connection
  await waitForBot(botName);
  console.log(`${tag}  Connected!`);
  // Re-send OP after connection (pre-connect OP may not take effect)
  try { await rcon(`op ${botName}`); } catch {}
  await sleep(2000);

  // 4. Teleport to random safe location using spreadplayers (avoids oceans)
  const { x: sx, z: sz } = randomCoords();
  await rcon(`spreadplayers ${sx} ${sz} 100 1250 false ${botName}`);
  await sleep(1000);
  const pos = await getPlayerPos(botName);
  console.log(`${tag}  Spawned at ${pos.x}, ${pos.y}, ${pos.z}`);

  // 5. Set time to day, set up environment, set up inventory
  await rcon('time set day');
  // Ensure solid ground at spawn for all benchmarks
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      await rcon(`setblock ${pos.x + dx} ${pos.y - 1} ${pos.z + dz} minecraft:grass_block`);
    }
  }
  // (food cows spawned later, after greeting cycle)
  if (benchId === 'shears') {
    const orePositions = [
      [pos.x + 3, pos.y, pos.z],
      [pos.x - 3, pos.y, pos.z],
      [pos.x, pos.y, pos.z + 3],
    ];
    for (const [ox, oy, oz] of orePositions) {
      await rcon(`setblock ${ox} ${oy} ${oz} minecraft:iron_ore`);
      await rcon(`setblock ${ox} ${oy + 1} ${oz} minecraft:air`);
      await rcon(`setblock ${ox} ${oy - 1} ${oz} minecraft:stone`);
    }
  }
  if (benchId === 'diamonds') {
    const cx = pos.x + 3, cy = pos.y, cz = pos.z;
    await rcon(`setblock ${cx} ${cy} ${cz} minecraft:chest`);
    await rcon(`item replace block ${cx} ${cy} ${cz} container.0 with minecraft:diamond 24`);
    await rcon(`item replace block ${cx} ${cy} ${cz} container.1 with minecraft:crafting_table 1`);
    await rcon(`setblock ${cx} ${cy + 1} ${cz} minecraft:air`);
    await rcon(`setblock ${cx} ${cy - 1} ${cz} minecraft:stone`);
  }
  if (benchId === 'pick') {
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        for (let dy = 0; dy <= 2; dy++) {
          await rcon(`setblock ${pos.x + dx} ${pos.y + dy} ${pos.z + dz} minecraft:air`);
        }
        await rcon(`setblock ${pos.x + dx} ${pos.y - 1} ${pos.z + dz} minecraft:grass_block`);
      }
    }
    for (let y = 0; y < 4; y++) {
      await rcon(`setblock ${pos.x + 2} ${pos.y + y} ${pos.z} minecraft:oak_log`);
      await rcon(`setblock ${pos.x - 2} ${pos.y + y} ${pos.z} minecraft:oak_log`);
    }
  }
  await rcon(`clear ${botName}`);
  for (const item of bench.startItems) {
    const [name, count] = item.split(' ');
    await rcon(`give ${botName} minecraft:${name} ${count || 1}`);
  }
  console.log(`${tag}  Inventory: ${bench.startItems.length > 0 ? bench.startItems.join(', ') : 'empty'}`);

  // 6. Wait for greeting cycle to finish
  console.log(`${tag}  Waiting for greeting cycle...`);
  for (let i = 0; i < 15; i++) {
    await sleep(2000);
    const { bots } = await api('GET', '/rblist');
    const bot = bots.find(b => b.name === botName);
    if (bot && bot.state === 'idle' && bot.pending === 0) break;
  }

  // 6b. Teleport bot back to spawn point (may have wandered during greeting)
  await rcon(`tp ${botName} ${pos.x} ${pos.y} ${pos.z}`);
  await sleep(1000);

  // 6c. Spawn animals for food bench (right before goal so they don't wander)
  if (benchId === 'food') {
    await rcon(`summon cow ${pos.x + 3} ${pos.y} ${pos.z}`);
    await rcon(`summon cow ${pos.x - 3} ${pos.y} ${pos.z}`);
    await rcon(`summon pig ${pos.x} ${pos.y} ${pos.z + 3}`);
  }

  // 7. Reset bench metrics and send goal
  await api('POST', `/bench/reset?bot=${botName}`);
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

    // Check inventory for success
    try {
      const passed = bench.successCounts
        ? await hasRequiredCounts(botName, bench.successCounts)
        : await hasItem(botName, bench.successItems, bench.successAll);
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
          if (e.type === 'tool' && e.name === 'whisper' && e.params?.player === OWNER && e.params?.message) {
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
    elapsedStr: fmtTime(elapsed),
    toolCalls: metrics.totalToolCalls || 0,
    chatMessages: metrics.totalChats || 0,
    idleTicks: metrics.totalIdles || 0,
    failures: metrics.totalFailures || 0,
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
    toolCalls: result.toolCalls || 0,
    failures: result.failures || 0,
    chatMessages: result.chatMessages || 0,
    idleTicks: result.idleTicks || 0,
    ownerModel: result.ownerModel || OWNER_MODEL,
    ownerInteractions: result.ownerInteractions || 0,
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

  console.log(`\n  ${jobs.length} jobs, ${parallel} parallel workers, model: ${m}`);

  // Worker: pulls jobs from queue, runs them with assigned bot name
  async function worker(workerId) {
    const botName = parallel > 1 ? `Bench${workerId}` : 'BenchBot';
    while (jobIdx < jobs.length) {
      const idx = jobIdx++;
      const job = jobs[idx];
      console.log(`\n  [Worker ${workerId}] Job ${idx + 1}/${jobs.length}: ${job.benchId} (run ${job.run + 1})`);
      try {
        const result = await runBenchmark(job.benchId, botName);
        result.model = m;
        allResults.push(result);
        saveResult(result, m);
      } catch (err) {
        console.error(`  [Worker ${workerId}] ERROR: ${err.message}`);
        const failResult = { benchmark: job.benchId, success: false, error: err.message, model: m };
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

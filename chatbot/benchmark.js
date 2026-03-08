#!/usr/bin/env node
/**
 * Revival Bot Benchmark Runner
 *
 * Benchmarks:
 *   pick   — From empty inventory, craft a wooden_pickaxe
 *   food   — From wooden tools, kill an animal and cook food
 *   shears — From wooden tools + food, mine iron, smelt, craft shears
 *
 * Usage:
 *   node benchmark.js pick          # run one benchmark
 *   node benchmark.js pick food     # run multiple
 *   node benchmark.js all           # run all three
 *   node benchmark.js pick --runs 3 # run 3 times for avg
 */

import { rcon } from './shared.js';

const API = 'http://localhost:8765';
const BOT_NAME = 'BenchBot';
const OWNER = 'BrezzyTracks';

// ── Benchmark definitions ────────────────────────────────────────────

const BENCHMARKS = {
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
      'cobblestone 8', 'oak_planks 16', 'stick 8',
    ],
    goal: 'craft a furnace, place it, kill a cow or pig, smelt the raw meat with oak_planks as fuel',
    successItems: ['cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_rabbit'],
    timeout: 180_000,
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
  for (let i = 0; i < 36; i++) {
    try {
      const resp = await rcon(`data get entity ${player} Inventory[{Slot:${i}b}]`);
      if (resp.includes('No elements') || resp.includes('Found no')) continue;
      const m = resp.match(/id: "minecraft:(\w+)".*?count: (\d+)/);
      if (m) items.push({ name: m[1], count: parseInt(m[2]) });
    } catch { break; }
  }
  return items;
}

async function hasItem(player, itemNames) {
  const inv = await getInventory(player);
  return inv.some(i => itemNames.includes(i.name));
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

// ── Spawn location ──────────────────────────────────────────────────

// Known bench location with planted trees nearby
const DEFAULT_POS = { x: 99195, y: 70, z: -141695 };

async function getSpawnLocation() {
  // Try to spawn near samboyd, fall back to bench location
  try {
    const pos = await getPlayerPos('samboyd');
    if (pos.x !== 0 || pos.z !== 0) return pos;
  } catch {}
  return DEFAULT_POS;
}

// ── Run a single benchmark ──────────────────────────────────────────

async function runBenchmark(benchId) {
  const bench = BENCHMARKS[benchId];
  if (!bench) throw new Error(`Unknown benchmark: ${benchId}`);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  BENCHMARK: ${bench.name} (${benchId})`);
  console.log(`${'='.repeat(60)}`);

  // 1. Clean up any existing bot
  try { await rcon(`kick ${BOT_NAME}`); } catch {}
  await sleep(3000);

  // 2. Pardon + OP (deathban.immune) + spawn bot
  try { await rcon(`pardon ${BOT_NAME}`); } catch {}
  try { await rcon(`op ${BOT_NAME}`); } catch {}
  const pos = await getSpawnLocation();
  console.log(`  Spawning at ${pos.x}, ${pos.y}, ${pos.z}...`);
  await api('POST', '/revival', { reviver: OWNER, deadPlayer: BOT_NAME, ...pos });

  // 3. Wait for connection
  await waitForBot(BOT_NAME);
  console.log(`  Connected!`);
  await sleep(3000); // let it settle

  // 4. Set time to day, set up environment, set up inventory
  await rcon('time set day');
  // Ensure solid ground at spawn for all benchmarks
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      await rcon(`setblock ${pos.x + dx} ${pos.y - 1} ${pos.z + dz} minecraft:grass_block`);
    }
  }
  // (food cows spawned later, after greeting cycle)
  if (benchId === 'shears') {
    // Place iron_ore blocks spaced apart so each is individually reachable
    // (canDig=false for underground blocks prevents pathing through ore)
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
  if (benchId === 'pick') {
    // Clear a flat area and plant oak log columns right next to spawn
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        // Clear 3 blocks above ground level
        for (let dy = 0; dy <= 2; dy++) {
          await rcon(`setblock ${pos.x + dx} ${pos.y + dy} ${pos.z + dz} minecraft:air`);
        }
        // Ensure solid ground
        await rcon(`setblock ${pos.x + dx} ${pos.y - 1} ${pos.z + dz} minecraft:grass_block`);
      }
    }
    // Place 2 oak log columns 2 blocks away (easy to reach and mine)
    for (let y = 0; y < 4; y++) {
      await rcon(`setblock ${pos.x + 2} ${pos.y + y} ${pos.z} minecraft:oak_log`);
      await rcon(`setblock ${pos.x - 2} ${pos.y + y} ${pos.z} minecraft:oak_log`);
    }
  }
  await rcon(`clear ${BOT_NAME}`);
  for (const item of bench.startItems) {
    const [name, count] = item.split(' ');
    await rcon(`give ${BOT_NAME} minecraft:${name} ${count || 1}`);
  }
  if (bench.startItems.length > 0) {
    console.log(`  Inventory: ${bench.startItems.join(', ')}`);
  } else {
    console.log(`  Inventory: empty`);
  }

  // 5. Wait for greeting cycle to finish (bot goes idle with no pending)
  console.log(`  Waiting for greeting cycle...`);
  for (let i = 0; i < 15; i++) {
    await sleep(2000);
    const { bots } = await api('GET', '/rblist');
    const bot = bots.find(b => b.name === BOT_NAME);
    if (bot && bot.state === 'idle' && bot.pending === 0) break;
  }

  // 5b. Teleport bot back to spawn point (it may have wandered during greeting)
  await rcon(`tp ${BOT_NAME} ${pos.x} ${pos.y} ${pos.z}`);
  await sleep(1000);

  // 5c. Spawn animals for food bench (right before goal so they don't wander)
  if (benchId === 'food') {
    await rcon(`summon cow ${pos.x + 3} ${pos.y} ${pos.z}`);
    await rcon(`summon cow ${pos.x - 3} ${pos.y} ${pos.z}`);
    await rcon(`summon pig ${pos.x} ${pos.y} ${pos.z + 3}`);
  }

  // 6. Reset bench metrics and send goal
  await api('POST', `/bench/reset?bot=${BOT_NAME}`);
  console.log(`  Goal: ${bench.goal}`);
  await api('POST', '/rbsay', { bot: BOT_NAME, message: bench.goal, as: OWNER });
  const startTime = Date.now();
  console.log(`  Started at ${new Date().toLocaleTimeString()}`);
  console.log(`  Timeout: ${fmtTime(bench.timeout)}`);
  console.log(`  Waiting...`);

  // 7. Poll for completion
  let success = false;
  let lastState = '';
  let retries = 0;
  let lastToolTime = startTime;
  while (Date.now() - startTime < bench.timeout) {
    await sleep(5000);

    // Check inventory for success item
    try {
      if (await hasItem(BOT_NAME, bench.successItems)) {
        success = true;
        break;
      }
    } catch {}

    // Check if bot is still alive
    try {
      const { bots } = await api('GET', '/rblist');
      const bot = bots.find(b => b.name === BOT_NAME);
      if (!bot || !bot.connected) {
        console.log(`  Bot disconnected!`);
        break;
      }
      const stateStr = `${bot.state} | obj: ${bot.objectives?.map(o => o.text).join(', ') || 'none'}`;
      if (stateStr !== lastState) {
        console.log(`  [${fmtTime(Date.now() - startTime)}] ${stateStr}`);
        lastState = stateStr;
      }

      // If bot is idle for 20s, resend goal (max 4 retries)
      if (bot.state !== 'idle') {
        lastToolTime = Date.now();
      } else if (Date.now() - lastToolTime > 20_000 && retries < 4) {
        retries++;
        console.log(`  [${fmtTime(Date.now() - startTime)}] Bot stuck idle, resending goal (retry ${retries}/4)...`);
        await api('POST', '/rbsay', { bot: BOT_NAME, message: bench.goal, as: OWNER });
        lastToolTime = Date.now();
      }
    } catch {}
  }

  const elapsed = Date.now() - startTime;

  // 8. Collect metrics
  let metrics = {};
  try {
    metrics = await api('GET', `/bench/metrics?bot=${BOT_NAME}`);
  } catch {}

  // 9. Get final inventory
  let finalInv = [];
  try { finalInv = await getInventory(BOT_NAME); } catch {}

  // 10. Clean up
  try { await rcon(`kick ${BOT_NAME}`); } catch {}

  // 11. Build result
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
  };

  // 12. Print result
  console.log(`\n  ${'─'.repeat(40)}`);
  console.log(`  Result: ${success ? 'SUCCESS' : 'FAIL'}`);
  console.log(`  Time:   ${result.elapsedStr}`);
  console.log(`  Tools:  ${result.toolCalls} calls (${result.failures} failed)`);
  console.log(`  Chat:   ${result.chatMessages} messages`);
  console.log(`  Idles:  ${result.idleTicks} wasted ticks`);
  console.log(`  Final inventory: ${result.inventory.join(', ') || 'empty'}`);

  // Print tool call sequence
  const toolLog = result.log.filter(e => e.type === 'tool');
  if (toolLog.length > 0) {
    console.log(`\n  Tool sequence:`);
    for (const e of toolLog) {
      const params = Object.keys(e.params || {}).length > 0 ? JSON.stringify(e.params) : '';
      const t = result.log[0] ? Math.round((e.t - result.log[0].t) / 1000) : 0;
      console.log(`    +${t}s  ${e.name}(${params})`);
    }
  }

  return result;
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  let benchIds = [];
  let runs = 1;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--runs' && args[i + 1]) {
      runs = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === 'all') {
      benchIds = Object.keys(BENCHMARKS);
    } else if (BENCHMARKS[args[i]]) {
      benchIds.push(args[i]);
    } else {
      console.error(`Unknown benchmark or option: ${args[i]}`);
      console.error(`Available: ${Object.keys(BENCHMARKS).join(', ')}, all`);
      process.exit(1);
    }
  }

  if (benchIds.length === 0) {
    console.log('Revival Bot Benchmarks');
    console.log('Usage: node benchmark.js <bench> [<bench>...] [--runs N]');
    console.log(`Available: ${Object.keys(BENCHMARKS).join(', ')}, all`);
    process.exit(0);
  }

  const allResults = [];

  for (let run = 0; run < runs; run++) {
    if (runs > 1) {
      console.log(`\n${'#'.repeat(60)}`);
      console.log(`  RUN ${run + 1}/${runs}`);
      console.log(`${'#'.repeat(60)}`);
    }

    for (const id of benchIds) {
      try {
        const result = await runBenchmark(id);
        allResults.push(result);
      } catch (err) {
        console.error(`  ERROR: ${err.message}`);
        allResults.push({ benchmark: id, success: false, error: err.message });
      }
      // Wait between benchmarks
      if (benchIds.length > 1) await sleep(5000);
    }
  }

  // Summary
  if (allResults.length > 1) {
    console.log(`\n${'='.repeat(60)}`);
    console.log('  SUMMARY');
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

      console.log(`\n  ${BENCHMARKS[id]?.name || id}:`);
      console.log(`    Success rate: ${successes.length}/${results.length} (${Math.round(100 * successes.length / results.length)}%)`);
      if (avgTime) console.log(`    Avg time:     ${fmtTime(avgTime)}`);
      if (avgTools) console.log(`    Avg tools:    ${avgTools} calls`);
    }
  }

  console.log('\nDone.');
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });

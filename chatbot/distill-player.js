#!/usr/bin/env node
/**
 * Distill a specific player's chat style from server logs into a revival profile.
 *
 * Reads all .log.gz files + latest.log, filters to a single player's messages,
 * and generates a personality/style profile via LLM for use by RevivalBot.
 *
 * Usage:
 *   node distill-player.js <playerName>
 *   node distill-player.js <playerName> --force   # regenerate even if cached
 */

import 'dotenv/config';
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distillPrompt = readFileSync(join(__dirname, 'prompts', 'distill-player.md'), 'utf-8').trim();
const PROFILES_DIR = join(__dirname, 'revival-profiles');
if (!existsSync(PROFILES_DIR)) mkdirSync(PROFILES_DIR);

const LOGS_DIR = '/var/opt/minecraft/crafty/crafty-4/servers/2271dcb9-6aeb-4760-8adf-7722a8a3ee5c/logs';

// Bot usernames to filter out
const BOT_NAMES = new Set(['BrezzyTracks', 'qwksilver', 'Zold_', 'pepperoni_dude', 'Th3Martian', 'glowdust99', 'rnbw_shark', 'Crumbl7', 'vibecheck42', 'Wrenchiee', 'n0xVoid', 'dusty_wrld']);

const GENERIC_PROFILE = {
  personality: 'A confused but friendly player who just woke up from the dead. Speaks in short, dazed sentences.',
  chatStyle: 'Short lowercase messages, confused tone, occasional "..." and "wait what", dazed and disoriented.',
  samplePhrases: ['wait what', 'where am i', 'huh', 'i died...?', 'bro', 'what happened', 'im back??']
};

// ── Extract chat lines for a specific player ─────────────────────────

function extractPlayerChats(playerName) {
  const chatLines = [];
  const lowerName = playerName.toLowerCase();

  function parseChatLine(line) {
    const match = line.match(/\[Async Chat Thread[^\]]*\]:\s*(?:\[Not Secure\]\s*)?(\S+)\s+[»>]\s+(.+)/);
    if (!match) return null;
    const [, username, message] = match;
    if (username.toLowerCase() !== lowerName) return null;
    return { username, message: message.trim() };
  }

  // Read compressed logs
  try {
    const files = readdirSync(LOGS_DIR).filter(f => f.endsWith('.log.gz')).sort();
    for (const file of files) {
      try {
        const content = execSync(`zcat "${LOGS_DIR}/${file}"`, { maxBuffer: 10 * 1024 * 1024 }).toString();
        for (const line of content.split('\n')) {
          const parsed = parseChatLine(line);
          if (parsed) chatLines.push(parsed);
        }
      } catch { /* skip unreadable */ }
    }
  } catch { /* logs dir may not exist */ }

  // Read latest.log
  try {
    const latest = readFileSync(`${LOGS_DIR}/latest.log`, 'utf-8');
    for (const line of latest.split('\n')) {
      const parsed = parseChatLine(line);
      if (parsed) chatLines.push(parsed);
    }
  } catch { /* skip if unreadable */ }

  return chatLines;
}

// ── Call LLM to distill player profile ───────────────────────────────

async function distillPlayer(playerName, chats) {
  const client = new OpenAI({
    apiKey: process.env.XAI_API_KEY,
    baseURL: 'https://api.x.ai/v1'
  });

  const chatBlock = chats.map(c => `<${c.username}> ${c.message}`).join('\n');
  const prompt = distillPrompt.replace('{{playerName}}', playerName);

  const response = await client.chat.completions.create({
    model: 'grok-4-1-fast-non-reasoning',
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: `Here are ${chats.length} chat messages from ${playerName}:\n\n${chatBlock}` }
    ],
    max_tokens: 400,
    temperature: 0.4
  });

  const raw = response.choices[0].message.content.trim();
  try {
    return JSON.parse(raw);
  } catch {
    // Try extracting JSON from response if wrapped in markdown
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    throw new Error(`Failed to parse LLM response as JSON: ${raw.slice(0, 200)}`);
  }
}

// ── Public API: get or generate a player profile ─────────────────────

export async function getPlayerProfile(playerName, { force = false } = {}) {
  const cacheFile = join(PROFILES_DIR, `${playerName}.json`);

  // Return cached if available
  if (!force && existsSync(cacheFile)) {
    try {
      return JSON.parse(readFileSync(cacheFile, 'utf-8'));
    } catch { /* regenerate on parse error */ }
  }

  // Extract player's chat messages
  const chats = extractPlayerChats(playerName);
  console.log(`[Distill] Found ${chats.length} messages from ${playerName}`);

  // Fall back to generic profile if too few messages
  if (chats.length < 5) {
    console.log(`[Distill] <5 messages for ${playerName}, using generic profile`);
    const profile = { ...GENERIC_PROFILE, playerName };
    writeFileSync(cacheFile, JSON.stringify(profile, null, 2));
    return profile;
  }

  // Sample up to 200 messages evenly
  let sampled = chats;
  if (chats.length > 200) {
    const step = chats.length / 200;
    sampled = [];
    for (let i = 0; i < 200; i++) {
      sampled.push(chats[Math.floor(i * step)]);
    }
  }

  const profile = await distillPlayer(playerName, sampled);
  profile.playerName = playerName;
  writeFileSync(cacheFile, JSON.stringify(profile, null, 2));
  console.log(`[Distill] Profile for ${playerName} saved`);
  return profile;
}

// ── CLI entrypoint ───────────────────────────────────────────────────

const isMain = process.argv[1] && fileURLToPath(import.meta.url).endsWith(process.argv[1].replace(/.*\//, ''));
if (isMain) {
  const args = process.argv.slice(2);
  const playerName = args.find(a => !a.startsWith('--'));
  const force = args.includes('--force');

  if (!playerName) {
    console.error('Usage: node distill-player.js <playerName> [--force]');
    process.exit(1);
  }

  getPlayerProfile(playerName, { force }).then(profile => {
    console.log(JSON.stringify(profile, null, 2));
  }).catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}

#!/usr/bin/env node
/**
 * Distill Minecraft server chat logs into a style summary for bot prompts.
 *
 * Reads all .log.gz files + latest.log from the MC server logs directory,
 * extracts player chat lines, deduplicates, samples, and sends them to Grok
 * to produce a concise style guide that the bots can use as context.
 *
 * Usage:
 *   node distill-chat.js                  # prints style summary to stdout
 *   node distill-chat.js --out chat-style.txt  # writes to file
 *   node distill-chat.js --max-lines 500  # limit input sample size
 */

import 'dotenv/config';
import { readdirSync, readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distillPrompt = readFileSync(join(__dirname, 'prompts', 'distill.md'), 'utf-8').trim();

const LOGS_DIR = '/var/opt/minecraft/crafty/crafty-4/servers/2271dcb9-6aeb-4760-8adf-7722a8a3ee5c/logs';

// Bot usernames to filter out — we only want real player chat
const BOT_NAMES = new Set(['BrezzyTracks', 'qwksilver', 'Zold_', 'pepperoni_dude', 'Th3Martian', 'glowdust99', 'rnbw_shark', 'Crumbl7', 'vibecheck42', 'Wrenchiee', 'n0xVoid', 'dusty_wrld']);

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outFile = outIndex !== -1 ? args[outIndex + 1] : null;
const maxIndex = args.indexOf('--max-lines');
const maxLines = maxIndex !== -1 ? parseInt(args[maxIndex + 1]) : 600;

// ── Extract chat lines from logs ──────────────────────────────────────

function extractChats() {
  const chatLines = [];

  // Parse a single chat line, return { username, message } or null
  function parseChatLine(line) {
    // Format: [HH:MM:SS] [Async Chat Thread - #N/INFO]: [Not Secure] username » message
    //   or:  [HH:MM:SS] [Async Chat Thread - #N/INFO]: username » message
    const match = line.match(/\[Async Chat Thread[^\]]*\]:\s*(?:\[Not Secure\]\s*)?(\S+)\s+[»>]\s+(.+)/);
    if (!match) return null;
    const [, username, message] = match;
    if (BOT_NAMES.has(username)) return null;
    return { username, message: message.trim() };
  }

  // Read compressed logs
  const files = readdirSync(LOGS_DIR).filter(f => f.endsWith('.log.gz')).sort();
  for (const file of files) {
    try {
      const content = execSync(`zcat "${LOGS_DIR}/${file}"`, { maxBuffer: 10 * 1024 * 1024 }).toString();
      for (const line of content.split('\n')) {
        const parsed = parseChatLine(line);
        if (parsed) chatLines.push(parsed);
      }
    } catch {
      // skip unreadable files
    }
  }

  // Read latest.log
  try {
    const latest = readFileSync(`${LOGS_DIR}/latest.log`, 'utf-8');
    for (const line of latest.split('\n')) {
      const parsed = parseChatLine(line);
      if (parsed) chatLines.push(parsed);
    }
  } catch {
    // skip if unreadable
  }

  return chatLines;
}

// ── Sample and format for the LLM ────────────────────────────────────

function sampleChats(chats, max) {
  if (chats.length <= max) return chats;
  // Take evenly spaced samples to capture the full time range
  const step = chats.length / max;
  const sampled = [];
  for (let i = 0; i < max; i++) {
    sampled.push(chats[Math.floor(i * step)]);
  }
  return sampled;
}

// ── Call Grok to distill ─────────────────────────────────────────────

async function distill(chats) {
  const client = new OpenAI({
    apiKey: process.env.XAI_API_KEY,
    baseURL: 'https://api.x.ai/v1'
  });

  const chatBlock = chats.map(c => `<${c.username}> ${c.message}`).join('\n');
  const uniqueUsers = [...new Set(chats.map(c => c.username))];

  const response = await client.chat.completions.create({
    model: 'grok-4-1-fast-non-reasoning',
    messages: [
      {
        role: 'system',
        content: distillPrompt
      },
      {
        role: 'user',
        content: `Here are ${chats.length} chat messages from ${uniqueUsers.length} unique players on the Xandaris Minecraft server:\n\n${chatBlock}`
      }
    ],
    max_tokens: 800,
    temperature: 0.3
  });

  return response.choices[0].message.content.trim();
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.error('Extracting chat logs...');
  const allChats = extractChats();
  console.error(`Found ${allChats.length} player chat messages`);

  if (allChats.length === 0) {
    console.error('No chat messages found!');
    process.exit(1);
  }

  const sampled = sampleChats(allChats, maxLines);
  console.error(`Sampled ${sampled.length} messages for distillation`);

  console.error('Distilling chat style via Grok...');
  const summary = await distill(sampled);

  if (outFile) {
    writeFileSync(outFile, summary + '\n');
    console.error(`Style guide written to ${outFile}`);
  } else {
    console.log(summary);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

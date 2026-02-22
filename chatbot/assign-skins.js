#!/usr/bin/env node
/**
 * Assigns persistent skins to bots using SkinsRestorer.
 *
 * Each bot gets a deterministic skin based on a hash of their username,
 * so it never changes even if new bots are added.
 *
 * Usage: node assign-skins.js
 *   - Reads personalities.json for bot list
 *   - Reads botSkins/ directory for available skin source accounts
 *   - Assigns each bot a skin via RCON command (sr skin set <bot> <source>)
 *   - Saves assignments to skin-assignments.json for reference
 *
 * The skin source account name is extracted from the filename (e.g. 001_Technoblade.png → Technoblade)
 */

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import crypto from 'crypto';

const SKINS_DIR = './botSkins';
const ASSIGNMENTS_FILE = './skin-assignments.json';

// Get available skin sources from filenames
const skinFiles = readdirSync(SKINS_DIR)
  .filter(f => f.endsWith('.png'))
  .sort();
const skinSources = skinFiles.map(f => f.replace(/^\d+_/, '').replace('.png', ''));

if (skinSources.length === 0) {
  console.error('No skins found in botSkins/');
  process.exit(1);
}

// Deterministic assignment: hash the bot username to pick a skin index
function getSkinIndex(username) {
  const hash = crypto.createHash('md5').update(username).digest();
  const num = hash.readUInt32BE(0);
  return num % skinSources.length;
}

// Load existing assignments if any
let assignments = {};
if (existsSync(ASSIGNMENTS_FILE)) {
  assignments = JSON.parse(readFileSync(ASSIGNMENTS_FILE, 'utf-8'));
}

// Load bot list
const personalities = JSON.parse(readFileSync('./personalities.json', 'utf-8'));

// Find MC server PID
let mcPid;
try {
  mcPid = execSync('pgrep -f "server.jar"').toString().trim().split('\n')[0];
} catch {
  console.error('MC server not running');
  process.exit(1);
}

console.log(`Found MC server PID: ${mcPid}`);
console.log(`Available skins: ${skinSources.length}`);
console.log('');

for (const bot of personalities) {
  const idx = getSkinIndex(bot.username);
  const skinSource = skinSources[idx];
  assignments[bot.username] = skinSource;

  console.log(`${bot.username} → ${skinSource} (index ${idx})`);

  // Apply via server console (SkinsRestorer command)
  try {
    execSync(`sudo bash -c 'echo "sr skin set ${bot.username} ${skinSource}" > /proc/${mcPid}/fd/0'`);
  } catch (err) {
    console.error(`  Failed to apply: ${err.message}`);
  }

  // Small delay between commands
  execSync('sleep 1');
}

// Save assignments
writeFileSync(ASSIGNMENTS_FILE, JSON.stringify(assignments, null, 2) + '\n');
console.log(`\nAssignments saved to ${ASSIGNMENTS_FILE}`);
console.log('Skins should update on next rejoin or after /sr skin update');

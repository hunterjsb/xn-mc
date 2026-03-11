#!/usr/bin/env node
// Patches mineflayer-pathfinder pillar timing bug (https://github.com/PrismarineJS/mineflayer-pathfinder/issues/296)
// The bot tries to place blocks before reaching jump peak, causing desync.
// Fix: change jump check from `placingBlock.y + 1` to `placingBlock.y + 2.1`
// Fix: use `_placeBlockWithOptions` with `forceLook: true` for reliable placement

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexPath = join(__dirname, '..', 'node_modules', 'mineflayer-pathfinder', 'index.js');

let code = readFileSync(indexPath, 'utf-8');
let patched = false;

// Patch 1: Jump height threshold (y + 1 → y + 2.1)
if (code.includes('placingBlock.y + 1 <') && !code.includes('placingBlock.y + 2.1 <')) {
  code = code.replace('placingBlock.y + 1 <', 'placingBlock.y + 2.1 <');
  patched = true;
  console.log('[pathfinder-patch] Applied pillar jump threshold fix');
}

// Patch 2: Use _placeBlockWithOptions with forceLook
if (code.includes('bot.placeBlock(refBlock,') && !code.includes('bot._placeBlockWithOptions(refBlock,')) {
  code = code.replace(
    /bot\.placeBlock\(refBlock, new Vec3\(placingBlock\.dx, placingBlock\.dy, placingBlock\.dz\)\)/,
    "bot._placeBlockWithOptions(refBlock, new Vec3(placingBlock.dx, placingBlock.dy, placingBlock.dz), { swingArm: 'right', forceLook: true })"
  );
  patched = true;
  console.log('[pathfinder-patch] Applied forceLook placement fix');
}

if (patched) {
  writeFileSync(indexPath, code);
  console.log('[pathfinder-patch] Saved patched index.js');
} else {
  console.log('[pathfinder-patch] Already patched or structure changed — no changes');
}

#!/usr/bin/env node
/**
 * Downloads Minecraft skins from real accounts and saves them to botSkins/
 * Each skin is saved as a PNG file named by index (001.png, 002.png, etc.)
 */

import { writeFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';

const SKINS_DIR = './botSkins';
mkdirSync(SKINS_DIR, { recursive: true });

// 50+ real Minecraft accounts with distinctive skins (mix of styles)
const ACCOUNTS = [
  // Popular/unique skins
  'Technoblade', 'Ph1LzA', 'Purpled', 'Ranboo', 'Tubbo',
  'Punz', 'Foolish_Gamers', 'ConnorEatsPants', 'CaptainSparklez', 'AntVenom',
  'ItsFundy', 'Skeppy', 'awesamdude', 'HBomb94', 'Smajor1995',
  'InTheLittleWood', 'Shubble', 'GeminiTay', 'fWhip', 'Scar',
  // More varied skins
  'Grian', 'MumboJumbo', 'Bdubs', 'Etho', 'VintageBeef',
  'Iskall85', 'ZombieCleo', 'FalseSymmetry', 'RenDog', 'Cubfan135',
  'JoeHills', 'Keralis', 'TangoTek', 'Xisuma', 'Stressmonster',
  'PearlescentMoon', 'SmallishBeans', 'LDShadowLady', 'Dangthatsalongname', 'Solidarity',
  // More accounts
  'Quig', 'fruitberries', 'Illumina', 'Seapeekay', 'PeteZahHutt',
  'SB737', 'Krinios', 'Wisp', 'TapL', 'Nestor',
  'Hannahxxrose', 'Eret', 'KarlJacobs', 'Nihachu', 'JackManifoldTV',
];

async function downloadSkin(username, index) {
  try {
    // Get UUID from Mojang
    const profileJson = execSync(
      `curl -sf "https://api.mojang.com/users/profiles/minecraft/${username}"`,
      { timeout: 10000 }
    ).toString();
    const profile = JSON.parse(profileJson);
    if (!profile.id) return false;

    // Get skin texture URL from session server
    const sessionJson = execSync(
      `curl -sf "https://sessionserver.mojang.com/session/minecraft/profile/${profile.id}"`,
      { timeout: 10000 }
    ).toString();
    const session = JSON.parse(sessionJson);
    const texturesProp = session.properties?.find(p => p.name === 'textures');
    if (!texturesProp) return false;

    const texturesData = JSON.parse(Buffer.from(texturesProp.value, 'base64').toString());
    const skinUrl = texturesData.textures?.SKIN?.url;
    if (!skinUrl) return false;

    // Download the skin PNG
    const filename = `${SKINS_DIR}/${String(index).padStart(3, '0')}_${username}.png`;
    execSync(`curl -sf -o "${filename}" "${skinUrl}"`, { timeout: 10000 });
    console.log(`[${index}] ${username} ✓`);
    return true;
  } catch (err) {
    console.log(`[${index}] ${username} ✗ (${err.message?.slice(0, 40)})`);
    return false;
  }
}

async function main() {
  let downloaded = 0;
  for (let i = 0; i < ACCOUNTS.length && downloaded < 50; i++) {
    const ok = await downloadSkin(ACCOUNTS[i], downloaded + 1);
    if (ok) downloaded++;
    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 200));
  }
  console.log(`\nDownloaded ${downloaded} skins to ${SKINS_DIR}/`);
}

main();

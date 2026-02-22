/**
 * Fuzzy bot-mention detector.
 *
 * Given a chat message and a list of bot profiles, determines which bot
 * (if any) is being addressed. Handles:
 *   - Full username:   "Steve_Builder come here"
 *   - Short name:      "steve come help"
 *   - No underscore:   "stevebuilder"
 *   - Slight typos:    "steve_bilder", "luна", "knightx"
 *   - Case insensitive
 */

// Levenshtein distance (bounded — bails early if > maxDist)
function editDistance(a, b, maxDist = 2) {
  if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > maxDist) return maxDist + 1;
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * Build name variants for a bot username.
 * "Steve_Builder" → ["steve_builder", "stevebuilder", "steve", "builder"]
 * "xKnightx"     → ["xknightx", "knight"]
 */
function buildAliases(username) {
  const lower = username.toLowerCase();
  const aliases = new Set([lower]);

  // Without underscores
  aliases.add(lower.replace(/_/g, ''));

  // Split on underscores → each part is an alias
  const parts = lower.split('_').filter(p => p.length >= 3);
  for (const part of parts) aliases.add(part);

  // Strip leading/trailing 'x' for names like "xKnightx"
  const stripped = lower.replace(/^x+|x+$/g, '');
  if (stripped.length >= 3) aliases.add(stripped);

  return [...aliases];
}

/**
 * Determine which bot (if any) a message is directed at.
 * Returns the first/best single match.
 *
 * @param {string} message     - The chat message text
 * @param {Array}  botProfiles - Array of { username, ... }
 * @returns {string|null}      - The bot username that was mentioned, or null
 */
export function findMentionedBot(message, botProfiles) {
  const matches = findMentionedBots(message, botProfiles);
  return matches.length > 0 ? matches[0] : null;
}

/**
 * Find ALL bots mentioned in a message.
 *
 * @param {string} message     - The chat message text
 * @param {Array}  botProfiles - Array of { username, ... }
 * @returns {string[]}         - Array of bot usernames mentioned (may be empty)
 */
export function findMentionedBots(message, botProfiles) {
  const lower = message.toLowerCase();
  const tokens = lower.split(/[\s,!?.;:'"]+/).filter(t => t.length >= 2);

  const found = new Set();  // exact or substring matches
  const fuzzy = new Map();  // username → best edit distance

  for (const profile of botProfiles) {
    const aliases = buildAliases(profile.username);
    let matched = false;

    for (const alias of aliases) {
      if (matched) break;

      // Check each token for exact match
      for (const token of tokens) {
        if (token === alias) {
          found.add(profile.username);
          matched = true;
          break;
        }
      }

      // Substring match for long aliases
      if (!matched && alias.length >= 5 && lower.includes(alias)) {
        found.add(profile.username);
        matched = true;
      }

      // Fuzzy match — track best distance
      if (!matched) {
        for (const token of tokens) {
          const maxDist = alias.length <= 4 ? 1 : 2;
          const dist = editDistance(token, alias, maxDist);
          if (dist <= maxDist) {
            const prev = fuzzy.get(profile.username) ?? Infinity;
            if (dist < prev) fuzzy.set(profile.username, dist);
          }
        }
      }
    }
  }

  // Combine: exact matches first, then fuzzy matches sorted by distance
  const result = [...found];
  for (const [name, dist] of [...fuzzy.entries()].sort((a, b) => a[1] - b[1])) {
    if (!found.has(name)) result.push(name);
  }

  return result;
}

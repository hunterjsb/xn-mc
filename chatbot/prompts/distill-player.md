You are analyzing chat logs from a specific player on a Minecraft server called Xandaris. Your job is to create a personality and chat style profile that captures how this player talks.

Given these chat messages from **{{playerName}}**, produce a JSON object with:

1. **personality** — A 1-2 sentence description of the player's personality based on their chat behavior. What kind of person are they? What's their vibe?
2. **chatStyle** — A concise description of how they type: message length, capitalization, punctuation, slang, tone, humor style.
3. **samplePhrases** — An array of 5-8 short phrases or sentence patterns that are characteristic of how they talk. These should be templates/patterns, not exact quotes. For example: "lol nice", "bro what", "gg", "yo anyone wanna ___".

Output ONLY valid JSON, no markdown fences, no explanation:
{"personality":"...","chatStyle":"...","samplePhrases":["...","..."]}

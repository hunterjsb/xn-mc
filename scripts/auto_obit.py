#!/usr/bin/env python3
"""Auto-generate and publish daily obituary wiki pages.

Uses obit_tools.build_briefing() to gather death data, then calls
claude -p to generate wikitext, validates the output, and publishes
to the wiki.

Scheduled: daily at 07:00 UTC via /etc/cron.d/auto-obit
"""

import argparse
import os
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone

from obit_tools import build_briefing
from utils.config import Config
from utils.players import load_bot_names
from utils.wiki import edit_page, fetch_page, page_exists, purge_page

# ── System prompt ────────────────────────────────────────

SYSTEM_PROMPT = r"""You are the obituary editor for the Xandaris Minecraft wiki. You write daily obituary pages in MediaWiki markup.

## Output Format

Output ONLY raw wikitext. No markdown code fences, no commentary, no preamble.

## Page Structure (follow this exact order)

1. {{DISPLAYTITLE:Obituaries — <Month Day, Year>}}
2. __NOTOC__
3. [[Category:Events]]
4. [[Category:Obituaries]]
5. Opening paragraph (2-4 sentences summarizing the day: total deaths, notable events, PvP kills, standout moments)
6. == Death Toll == section with sortable wikitable
7. == Notable Deaths == section with subsections for interesting deaths
8. == Statistics == section with summary wikitable

## Death Toll Table Format

{| class="wikitable sortable" style="width:100%;"
|-
! # !! Time (EST) !! Player !! Cause of Death !! Playtime !! Advancements
|-
| 1 || 12:28 AM || [[Player:Name|Name]] || Cause || ~duration || count
|}

- Use 12-hour format with AM/PM for times
- Link every player name: [[Player:Name|Name]]
- Bold PvP kills: '''Slain by [[Player:Killer|Killer]]''' using [WeaponName]
- Format playtime naturally: "19 sec", "~7 min 30 sec", "~4 hrs 20 min"
- Advancements column is just the count (number)

## Notable Deaths Sections

=== PlayerName — Short Title (Time) ===

- Write 1-4 paragraphs per notable death
- Use {{quote|message text|SpeakerName}} for player chat quotes — ONLY quote messages that appear in the briefing data
- Use {{main|Player:Name}} if the player has an existing wiki page (briefing says "Wiki page: Player:Name")
- Bold advancement names: '''[Diamonds!]''', '''[Monster Hunter]'''
- Bold significant stats: '''220 villager trades''', '''19 seconds'''
- Include reconnection attempt tables where relevant (use nested wikitable)
- Player wiki links: [[Player:Name|Name]]

### What makes a death notable:
- PvP kills (always notable)
- Sub-60-second deaths
- Unusually long survival (hours)
- High advancement counts (5+)
- Interesting chat context or quotes
- Ironic circumstances
- Dual-boxing / alt accounts

### Deaths that are NOT notable:
- Generic mob deaths with no interesting context, short playtime, few advancements, and no chat
- Skip these entirely (they only appear in the Death Toll table)

## Statistics Table Format

{| class="wikitable"
|-
! Stat !! Value
|-
| Total Deaths || count
|-
| PvP Kills || count (Killer → Victim) or 0
|-
| By Skeleton/Stray || count (names)
|-
| By Zombie || count (names)
|-
| By Creeper || count (names)
|-
| By Fall || count (names)
|-
| ... other causes ...
|-
| Fastest Death || name (duration)
|-
| Longest Survival || name (duration)
|-
| First-Time Players || X of Y
|-
| Total Advancements Earned || count
|}

Group deaths by cause category. Include player names in parentheses for each category.

## Editorial Style

- Journalistic and conversational — like a sports obituary column
- Dark humor is encouraged but never cruel
- Celebrate accomplishments even in death
- Note ironic timing, close calls, and dramatic moments
- Connect related deaths (simultaneous deaths, same killer, etc.)

## Safety Rules

- NEVER include coordinates (X, Y, Z values) of any kind
- NEVER fabricate quotes — only use chat messages that appear in the briefing
- NEVER feature these bot accounts as notable deaths or give them narrative focus: {bot_names}
  (Bots may be mentioned in passing if they appear in a real player's chat context)
- NEVER add commentary outside the wikitext (no "Here is the page:" etc.)

## Main Page Headline

At the VERY END of the wikitext, add a single HTML comment with a 1-2 sentence editorial headline:

<!-- HEADLINE: Brief summary with [[Player:Name|Name]] wiki links, notable events, key quotes. -->

This headline will be extracted and displayed on the Main Page. Do NOT include the death count or date — those are added automatically. Focus on the most interesting 1-2 events of the day.
"""


def get_system_prompt():
    """Build system prompt with current bot names injected."""
    bot_names = load_bot_names()
    return SYSTEM_PROMPT.replace("{bot_names}", ", ".join(sorted(bot_names)))


# ── Claude subprocess ────────────────────────────────────


def call_claude(briefing, system_prompt):
    """Call claude -p via subprocess, return (stdout, stderr, returncode)."""
    env = os.environ.copy()
    # Nested claude sessions are blocked — unset these markers
    env.pop("CLAUDECODE", None)
    env.pop("CLAUDE_CODE_ENTRYPOINT", None)

    user_message = (
        "Write the obituary wiki page for the following day. "
        "Use ONLY the data below.\n\n"
        + briefing
    )

    cmd = [
        "/home/ubuntu/.local/bin/claude", "-p",
        "--model", "sonnet",
        "--max-budget-usd", "3.00",
        "--system-prompt", system_prompt,
    ]

    result = subprocess.run(
        cmd,
        input=user_message,
        capture_output=True,
        text=True,
        env=env,
        timeout=600,
    )
    return result.stdout, result.stderr, result.returncode


# ── Validation ───────────────────────────────────────────

REQUIRED_PATTERNS = [
    r"\{\{DISPLAYTITLE:",
    r"== Death Toll ==",
    r'\{\| class="wikitable',
    r"\[\[Category:Events\]\]",
    r"\[\[Category:Obituaries\]\]",
    r"== Notable Deaths ==",
    r"== Statistics ==",
]

FORBIDDEN_PATTERNS = [
    (r"^```", "Markdown code fence"),
    (r"(?i)here is the wikitext", "LLM commentary"),
    (r"(?i)here'?s the (?:wiki|obituary|page)", "LLM commentary"),
    (r"(?i)^sure[,!]", "LLM commentary"),
    (r"X:\s*-?\d+.*Y:\s*-?\d+", "Coordinate leak"),
    (r"(?i)coordinates?\s*[:=]\s*-?\d+", "Coordinate leak"),
]


def validate_output(text):
    """Validate generated wikitext. Returns list of error strings (empty = OK)."""
    errors = []

    for pattern in REQUIRED_PATTERNS:
        if not re.search(pattern, text):
            errors.append(f"Missing required pattern: {pattern}")

    for pattern, desc in FORBIDDEN_PATTERNS:
        if re.search(pattern, text, re.MULTILINE):
            errors.append(f"Forbidden content ({desc}): {pattern}")

    return errors


def strip_fences(text):
    """Remove markdown code fences if claude wrapped the output."""
    text = text.strip()
    if text.startswith("```"):
        # Remove opening fence (possibly with language tag)
        text = re.sub(r"^```\w*\n?", "", text, count=1)
    if text.endswith("```"):
        text = text[:-3]
    return text.strip()


def extract_headline(text):
    """Extract and remove <!-- HEADLINE: ... --> comment. Returns (clean_text, headline)."""
    m = re.search(r"<!--\s*HEADLINE:\s*(.+?)\s*-->", text)
    if not m:
        return text, None
    headline = m.group(1).strip()
    clean = text[:m.start()].rstrip() + text[m.end():]
    return clean.strip(), headline


# ── Main Page update ─────────────────────────────────────

MAX_RECENT_ROWS = 7


def update_main_page(dt, death_count, headline):
    """Add a new row to the Main Page's Recent Events table."""
    main_text = fetch_page("Main_Page")
    if not main_text:
        print("WARNING: Could not fetch Main_Page", file=sys.stderr)
        return False

    # Build the new row
    month_day = dt.strftime("%B %-d")       # "March 2"
    short_date = dt.strftime("%b %-d")      # "Mar 2"
    link = f"[[Event:Obituaries {month_day}|{death_count} death{'s' if death_count != 1 else ''}]]"
    row_content = f"| '''{short_date}''' || {link}. {headline}"
    new_row = f"|-\n{row_content}"

    # Find the Recent Events table body — insert after the header row
    header_pattern = r"(! Date !! Headlines\n)"
    m = re.search(header_pattern, main_text)
    if not m:
        print("WARNING: Could not find Recent Events table header", file=sys.stderr)
        return False

    insert_pos = m.end()
    updated = main_text[:insert_pos] + "|-\n" + row_content + "\n" + main_text[insert_pos:]

    # Trim to MAX_RECENT_ROWS data rows
    # Count |- delimiters between the header and |} closing
    table_match = re.search(
        r"(== Recent Events ==.*?! Date !! Headlines\n)(.*?)(\|})",
        updated, re.DOTALL,
    )
    if table_match:
        body = table_match.group(2)
        # Split into rows (each starts with |-)
        rows = re.split(r"(?=\|-\n\|)", body)
        rows = [r for r in rows if r.strip()]
        if len(rows) > MAX_RECENT_ROWS:
            rows = rows[:MAX_RECENT_ROWS]
            trimmed_body = "".join(rows)
            updated = (
                updated[:table_match.start(2)]
                + trimmed_body
                + table_match.group(3)
                + updated[table_match.end(3):]
            )

    summary = f"Auto-add obituary headline for {month_day}"
    ok = edit_page("Main_Page", updated, summary)
    if ok:
        purge_page("Main_Page")
    return ok


# ── Main ─────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(
        description="Auto-generate daily obituary wiki pages"
    )
    parser.add_argument(
        "--date",
        help="Date in YYYY-MM-DD (default: yesterday UTC)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print wikitext without publishing",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Overwrite existing wiki page",
    )
    args = parser.parse_args()

    # Resolve date
    if args.date:
        date_str = args.date
    else:
        yesterday = datetime.now(timezone.utc) - timedelta(days=1)
        date_str = yesterday.strftime("%Y-%m-%d")

    dt = datetime.strptime(date_str, "%Y-%m-%d")
    wiki_title = f"Event:Obituaries {dt.strftime('%B %-d')}"

    print(f"Date: {date_str}", file=sys.stderr)
    print(f"Wiki page: {wiki_title}", file=sys.stderr)

    # Check if page already exists
    if not args.force and not args.dry_run and page_exists(wiki_title):
        print(f"Page already exists: {wiki_title} (use --force to overwrite)", file=sys.stderr)
        return

    # Generate briefing
    cfg = Config()
    print("Generating briefing...", file=sys.stderr)
    briefing = build_briefing(date_str, cfg)

    # Check death count from briefing header
    death_match = re.search(r"^# Deaths: (\d+)", briefing, re.MULTILINE)
    death_count = int(death_match.group(1)) if death_match else 0

    if death_count == 0:
        print(f"No deaths on {date_str}, nothing to generate.", file=sys.stderr)
        return

    print(f"Deaths found: {death_count}", file=sys.stderr)

    # Call claude
    system_prompt = get_system_prompt()
    print("Calling claude...", file=sys.stderr)
    stdout, stderr, rc = call_claude(briefing, system_prompt)

    if rc != 0:
        print(f"claude exited with code {rc}", file=sys.stderr)
        if stderr:
            print(stderr, file=sys.stderr)
        if stdout:
            print(stdout, file=sys.stderr)
        sys.exit(1)

    # Claude writes budget errors to stdout
    if stdout.startswith("Error:"):
        print(f"claude error: {stdout.strip()}", file=sys.stderr)
        sys.exit(1)

    wikitext = strip_fences(stdout)

    # Extract headline before validation (it's a comment, not page content)
    wikitext, headline = extract_headline(wikitext)
    if headline:
        print(f"Headline: {headline}", file=sys.stderr)
    else:
        print("WARNING: No headline comment found in output", file=sys.stderr)

    # Validate
    errors = validate_output(wikitext)
    if errors:
        print("Validation errors:", file=sys.stderr)
        for e in errors:
            print(f"  - {e}", file=sys.stderr)
        print("\nRaw output:", file=sys.stderr)
        print(wikitext, file=sys.stderr)
        sys.exit(1)

    print("Validation passed.", file=sys.stderr)

    # Dry-run: print and exit
    if args.dry_run:
        print(wikitext)
        if headline:
            print(f"\n[Main Page headline: {headline}]", file=sys.stderr)
        return

    # Publish obituary page
    print(f"Publishing to {wiki_title}...", file=sys.stderr)
    ok = edit_page(wiki_title, wikitext, "Auto-generated obituaries")
    if not ok:
        print("Failed to publish.", file=sys.stderr)
        sys.exit(1)

    purge_page(wiki_title)
    print(f"Published: {wiki_title}", file=sys.stderr)

    # Update Main Page headline
    if headline:
        print("Updating Main Page...", file=sys.stderr)
        if update_main_page(dt, death_count, headline):
            print("Main Page updated.", file=sys.stderr)
        else:
            print("WARNING: Main Page update failed.", file=sys.stderr)


if __name__ == "__main__":
    main()

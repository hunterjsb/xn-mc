#!/usr/bin/env python3
"""Migrate manual wikitable infoboxes to {{Infobox Player/Event/Location}} templates."""

import argparse
import difflib
import os
import re
import subprocess
import sys

import requests

WIKI_BASE = "https://wiki.xandaris.space"
MEDIAWIKI_DIR = "/var/www/mediawiki"

# ── Pages to migrate ────────────────────────────────────────────────────────

PAGES_TO_MIGRATE = {
    # Player pages (vertical wikitable infoboxes)
    "Player:Asa Akiraa": "player",
    "Player:AwesomeAG99": "player",
    "Player:BurritoSupBeing": "player",
    "Player:chickenfiesta": "player",
    "Player:CoboElFuerte": "player",
    "Player:Dirt1358": "player",
    "Player:Djspookymegan": "player",
    "Player:embiie": "player",
    "Player:GigglyBall": "player",
    "Player:ImmAidenn": "player",
    "Player:Kitten9337": "player",
    "Player:lionclad": "player",
    "Player:Meat Mattress": "player",
    "Player:Molsaac": "player",
    "Player:OneStarNoTip": "player",
    "Player:Orangebubly": "player",
    "Player:Piggycore99": "player",
    "Player:PluckedHorseHair": "player",
    "Player:PurpleBumblebeez": "player",
    "Player:samboyd": "player",
    "Player:Silmarillion 1": "player",
    "Player:skogsloparen": "player",
    "Player:slippy 10": "player",
    "Player:SP8RLS": "player",
    "Player:tuodjw": "player",
    "Player:WalkZDog": "player",
    "Player:WEIDO344": "player",
    "Player:Xcis": "player",
    "Player:YTKreoCraft": "player",
    # Event pages
    "Event:The Killing of OneStarNoTip": "event",
    # Location pages
    "Location:World Spawn": "location",
    "Location:vphlIo's Farm Base": "location",
}

# ── Label → parameter mapping ───────────────────────────────────────────────

PLAYER_LABEL_MAP = {
    "status": "status",
    "first join": "first_join",
    "first joined": "first_join",
    "joined": "first_join",
    "role": "role",
    "known accounts": "known_accounts",
    "accounts": "known_accounts",
    "deaths": "deaths",
    "total deaths": "total_deaths",
    "killed by": "killed_by",
    "death message": "death_message",
    "death cause": "death_causes",
    "death causes": "death_causes",
    "play time": "play_time",
    "playtime": "play_time",
    "total play time": "total_play_time",
    "mob kills": "mob_kills",
    "total mob kills": "total_mob_kills",
    "player kills": "player_kills",
    "kills": "player_kills",
    "advancements": "advancements",
    "damage dealt": "damage_dealt",
    "distance walked": "distance_walked",
    "distance traveled": "distance_walked",
    "distance": "distance_walked",
    "distance by elytra": "distance_elytra",
    "elytra distance": "distance_elytra",
    "total distance": "total_distance",
    "animals bred": "animals_bred",
    "villager trades": "villager_trades",
    "nickname": "nickname",
    "also known as": "also_known_as",
    "aka": "also_known_as",
    "alt accounts": "alt_accounts",
    "alt of": "alt_of",
    "associated with": "associated_with",
    "base": "base",
    "spawn point": "spawn_point",
    "image": "image",
    "uuid": "uuid",
    "logins": "logins",
    "sessions": "sessions",
    "session length": "session_length",
    "banned": "banned_date",
    "banned date": "banned_date",
    "banned by": "banned_by",
    "ban reason": "ban_reason",
    "team": "team",
    "previous server": "previous_server",
    "language": "language",
    "fish caught": "fish_caught",
    "buttons crafted": "buttons_crafted",
    "alt flag": "alt_flag",
    "possible alt": "possible_alt",
}

EVENT_LABEL_MAP = {
    "date": "date",
    "location": "location",
    "victim": "victim",
    "victim 2": "victim2",
    "victim 3": "victim3",
    "killer": "killer",
    "killer 2": "killer2",
    "killer 3": "killer3",
    "weapon": "weapon",
    "motive": "motive",
    "witnesses": "witnesses",
    "outcome": "outcome",
    "preceded by": "preceded_by",
    "followed by": "followed_by",
    "image": "image",
}

LOCATION_LABEL_MAP = {
    "coordinates": "coordinates",
    "biome": "biome",
    "theme": "theme",
    "founded": "founded",
    "founded by": "founded_by",
    "status": "status",
    "image": "image",
}

# Ordered parameter lists for template output
PLAYER_PARAM_ORDER = [
    "name", "image", "uuid", "status", "status_raw", "status_note",
    "first_join", "role", "logins", "sessions", "session_length",
    "known_accounts", "deaths", "total_deaths", "killed_by", "death_causes",
    "death_message", "banned_date", "banned_by", "ban_reason",
    "play_time", "total_play_time", "mob_kills", "total_mob_kills",
    "player_kills", "advancements", "damage_dealt", "distance_walked",
    "distance_elytra", "total_distance", "animals_bred", "villager_trades",
    "fish_caught", "buttons_crafted", "nickname", "also_known_as",
    "alt_accounts", "alt_of", "alt_flag", "possible_alt",
    "associated_with", "team", "previous_server", "language",
    "base", "spawn_point",
]

EVENT_PARAM_ORDER = [
    "name", "image", "date", "location",
    "victim", "victim2", "victim3",
    "killer", "killer2", "killer3",
    "weapon", "motive", "witnesses", "outcome",
    "preceded_by", "followed_by",
]

LOCATION_PARAM_ORDER = [
    "name", "image", "coordinates", "biome", "theme",
    "founded", "founded_by", "status",
]

# ── New template fields to add ──────────────────────────────────────────────

# (param_name, label, insert_after_param)
NEW_PLAYER_FIELDS = [
    ("uuid", "UUID", "image"),
    ("logins", "Logins", "role"),
    ("sessions", "Sessions", "logins"),
    ("session_length", "Session Length", "sessions"),
    ("death_causes", "Death Causes", "killed_by"),
    ("banned_date", "Banned", "death_message"),
    ("banned_by", "Banned By", "banned_date"),
    ("ban_reason", "Ban Reason", "banned_by"),
    ("team", "Team", "associated_with"),
    ("previous_server", "Previous Server", "team"),
    ("language", "Language", "previous_server"),
    ("fish_caught", "Fish Caught", "villager_trades"),
    ("buttons_crafted", "Buttons Crafted", "fish_caught"),
    ("alt_flag", "Alt Flag", "alt_of"),
    ("possible_alt", "Possible Alt", "alt_flag"),
]


# ── Wiki I/O ────────────────────────────────────────────────────────────────

def fetch_page(title):
    """Fetch raw wikitext for a page."""
    resp = requests.get(
        f"{WIKI_BASE}/index.php",
        params={"title": title, "action": "raw"},
        timeout=15,
    )
    resp.raise_for_status()
    return resp.text


def edit_page(title, content, summary):
    """Write page content via maintenance script."""
    cmd = [
        "sudo", "-u", "www-data", "php",
        os.path.join(MEDIAWIKI_DIR, "maintenance", "run.php"),
        "edit", "--summary", summary, title,
    ]
    result = subprocess.run(
        cmd, input=content, capture_output=True, text=True, cwd=MEDIAWIKI_DIR,
    )
    if result.returncode != 0:
        print(f"  ERROR editing {title}: {result.stderr}", file=sys.stderr)
        return False
    print(f"  Published {title}: {result.stdout.strip()}")
    return True


def purge_page(title):
    """Purge cache for a page."""
    resp = requests.post(
        f"{WIKI_BASE}/api.php",
        data={"action": "purge", "titles": title, "format": "json"},
        timeout=15,
    )
    if resp.ok:
        print(f"  Purged cache: {title}")


# ── Status parsing ──────────────────────────────────────────────────────────

def parse_status(raw_value):
    """Parse status cell value into template params.

    Examples:
        {{color|green|Alive}}                    → status=alive
        {{color|red|Dead}}                       → status=dead
        {{color|red|Dead}} (shot by Skeleton)    → status=dead, status_note=shot by Skeleton
        {{color|red|Dead}} ([[Event:...|...]])   → status=dead, status_note=[[Event:...|...]]
        {{color|red|Banned}}                     → status=banned
    """
    result = {}
    raw_value = raw_value.strip()

    # Match {{color|...|Word}} or {{status|Word}}
    m = re.match(
        r"\{\{(?:color\|[^|]+\|(\w+)|status\|(\w+))\}\}\s*(.*)",
        raw_value,
        re.DOTALL,
    )
    if m:
        word = (m.group(1) or m.group(2)).lower()
        remainder = m.group(3).strip()
        result["status"] = word

        # Extract parenthetical note: (...) or (wikilink)
        if remainder:
            note_match = re.match(r"\((.+)\)$", remainder, re.DOTALL)
            if note_match:
                result["status_note"] = note_match.group(1).strip()
            else:
                # Bare remainder (no parens)
                result["status_note"] = remainder
    else:
        # Fallback: use raw value
        result["status"] = raw_value
        result["status_raw"] = "yes"

    return result


# ── Infobox parsing ─────────────────────────────────────────────────────────

def _find_table_end(wikitext, start):
    """Find matching |} for a {| at position start, handling nesting."""
    depth = 0
    i = start
    while i < len(wikitext):
        if wikitext[i:i+2] == '{|':
            depth += 1
            i += 2
        elif wikitext[i:i+2] == '|}':
            depth -= 1
            if depth == 0:
                end = i + 2
                return end
            i += 2
        else:
            i += 1
    return None


def find_infobox_table(wikitext, require_float_right=True):
    """Find the wikitable infobox and return (start, end, table_text).

    If require_float_right is True, only matches float:right styled tables.
    If False, matches the first wikitable in the Overview section.
    """
    if require_float_right:
        pattern = r'\{\|\s*class="wikitable"\s*style="float:\s*right;\s*margin-left:\s*1em;"'
    else:
        # Match first wikitable after == Overview == heading
        overview_match = re.search(r'==\s*Overview\s*==', wikitext)
        search_start = overview_match.end() if overview_match else 0
        pattern = r'\{\|\s*class="wikitable"'
        m = re.search(pattern, wikitext[search_start:])
        if not m:
            return None
        start = search_start + m.start()
        end = _find_table_end(wikitext, start)
        if end is None:
            return None
        return start, end, wikitext[start:end]

    m = re.search(pattern, wikitext)
    if not m:
        return None

    start = m.start()
    end = _find_table_end(wikitext, start)
    if end is None:
        return None
    return start, end, wikitext[start:end]


def parse_vertical_infobox(wikitext, label_map):
    """Parse a vertical wikitable infobox into {param: value} dict.

    Format:
        {| class="wikitable" style="float:right; margin-left:1em;"
        |-
        ! colspan="2" | Title
        |-
        | '''Label''' || Value
        ...
        |}
    """
    result = find_infobox_table(wikitext, require_float_right=True)
    if not result:
        return None, None, None
    start, end, table_text = result

    fields = {}

    for line in table_text.split('\n'):
        line = line.strip()

        # Data row: | '''Label''' || Value
        row = re.match(r"\|\s*'''(.+?)'''\s*\|\|\s*(.*)", line)
        if row:
            label = row.group(1).strip()
            value = row.group(2).strip()
            label_lower = label.lower()
            param = label_map.get(label_lower)
            if param:
                if param == "status":
                    fields.update(parse_status(value))
                else:
                    fields[param] = value
            else:
                print(f"  WARNING: Unknown label '{label}' — skipping")

    return fields, start, end


def parse_horizontal_infobox(wikitext, label_map):
    """Parse a horizontal wikitable infobox into {param: value} dict.

    Format:
        {| class="wikitable"
        |-
        ! Header1 !! Header2 !! ...
        |-
        | Value1 || Value2 || ...
        |}
    """
    result = find_infobox_table(wikitext, require_float_right=False)
    if not result:
        return None, None, None
    start, end, table_text = result

    lines = [l.strip() for l in table_text.split('\n') if l.strip()]
    headers = []
    values = []

    for line in lines:
        if line.startswith('!') and '!!' in line:
            # Header row with !! separators
            raw = line.lstrip('!').strip()
            headers = [h.strip() for h in re.split(r'\s*!!\s*', raw)]
        elif line.startswith('|') and '||' in line and not line.startswith('{|') and not line.startswith('|}'):
            # Value row with || separators
            raw = line[1:].strip()  # strip leading |
            values = [v.strip() for v in re.split(r'\s*\|\|\s*', raw)]

    if not headers or not values:
        return None, None, None

    fields = {}
    for hdr, val in zip(headers, values):
        label_lower = hdr.lower().strip()
        param = label_map.get(label_lower)
        if param:
            if param == "status":
                fields.update(parse_status(val))
            else:
                fields[param] = val
        elif label_lower:
            print(f"  WARNING: Unknown label '{hdr}' — skipping")

    return fields, start, end


# ── Template building ───────────────────────────────────────────────────────

def build_template_call(template_name, params, param_order):
    """Build a formatted template transclusion string.

    Example output:
        {{Infobox Player
        | name          = vphlIo
        | status        = alive
        | first_join    = February 15, 2026
        }}
    """
    # Filter to only params that have values
    active = [(k, v) for k in param_order if (v := params.get(k)) is not None]
    if not active:
        return ""

    # Calculate padding for alignment
    max_key_len = max(len(k) for k, _ in active) if active else 0

    lines = [f"{{{{{template_name}"]
    for key, value in active:
        padding = " " * (max_key_len - len(key))
        lines.append(f"| {key}{padding} = {value}")
    lines.append("}}")

    return '\n'.join(lines)


# ── Hatnote replacement ────────────────────────────────────────────────────

def replace_hatnotes(wikitext):
    """Replace italic main-article hatnotes with {{main}} template.

    ''Main article: [[Page Title]]'' → {{main|Page Title}}
    ''Main article: [[Page Title|Display]]'' → {{main|Page Title}}
    """
    return re.sub(
        r"''Main article:\s*\[\[([^|\]]+)(?:\|[^\]]+)?\]\]''",
        r"{{main|\1}}",
        wikitext,
    )


# ── Page migration ─────────────────────────────────────────────────────────

def migrate_page(title, page_type, wikitext):
    """Migrate a single page's infobox from wikitable to template.

    Returns (old_text, new_text) or None if no changes needed.
    """
    if page_type == "player":
        label_map = PLAYER_LABEL_MAP
        template_name = "Infobox Player"
        param_order = PLAYER_PARAM_ORDER
    elif page_type == "event":
        label_map = EVENT_LABEL_MAP
        template_name = "Infobox Event"
        param_order = EVENT_PARAM_ORDER
    elif page_type == "location":
        label_map = LOCATION_LABEL_MAP
        template_name = "Infobox Location"
        param_order = LOCATION_PARAM_ORDER
    else:
        return None

    # Skip if already using a template
    if f"{{{{{template_name}" in wikitext:
        print(f"  SKIP: {title} — already uses {{{{{template_name}}}}}")
        return None

    # Try vertical parse first (most common)
    fields, start, end = parse_vertical_infobox(wikitext, label_map)
    if fields is None:
        # Try horizontal
        fields, start, end = parse_horizontal_infobox(wikitext, label_map)
    if fields is None:
        print(f"  SKIP: {title} — no wikitable infobox found")
        return None
    if not fields:
        print(f"  SKIP: {title} — infobox found but no fields extracted")
        return None

    params = dict(fields)

    # Build template call
    template_call = build_template_call(template_name, params, param_order)

    # Replace the wikitable with the template call
    new_wikitext = wikitext[:start] + template_call + wikitext[end:]

    # Replace hatnotes
    new_wikitext = replace_hatnotes(new_wikitext)

    if new_wikitext == wikitext:
        return None

    return wikitext, new_wikitext


# ── Layout fixup ────────────────────────────────────────────────────────────

# Pages already migrated (by prior runs or manually) that also need layout fix
ALREADY_MIGRATED = {
    "Player:vphlIo": "player",
    "Player:Sigward f": "player",
    "Player:JimmyyJohn": "player",
    "Event:The Murder of Sigward f": "event",
    "Location:The Island": "location",
}


def fix_layout(title, wikitext):
    """Move {{Infobox ...}} call to the top and clean up empty Overview sections.

    Returns (old_text, new_text) or None if no changes needed.
    """
    # Find the infobox template call
    infobox_match = re.search(
        r'\{\{Infobox (?:Player|Event|Location)\n.*?\}\}',
        wikitext,
        re.DOTALL,
    )
    if not infobox_match:
        return None

    infobox_call = infobox_match.group()
    infobox_start = infobox_match.start()
    infobox_end = infobox_match.end()

    # Check if it's already at the top (before any == heading)
    first_heading = re.search(r'^==\s', wikitext, re.MULTILINE)
    if first_heading and infobox_start < first_heading.start():
        return None  # Already at top

    # Remove the infobox from its current position
    new_wikitext = wikitext[:infobox_start] + wikitext[infobox_end:]

    # Clean up empty Overview section: "== Overview ==\n\n" with nothing else
    new_wikitext = re.sub(
        r'==\s*Overview\s*==\s*\n\s*(?=\n==|\Z)',
        '',
        new_wikitext,
    )

    # Find insert point: after {{DISPLAYTITLE:...}} line, or after the intro
    # paragraph (first blank line after the opening text)
    dt_match = re.search(r'\{\{DISPLAYTITLE:[^}]+\}\}\n', new_wikitext)
    if dt_match:
        insert_pos = dt_match.end()
    else:
        insert_pos = 0

    # Insert the infobox right after DISPLAYTITLE (or at the top)
    new_wikitext = (
        new_wikitext[:insert_pos]
        + infobox_call + "\n"
        + new_wikitext[insert_pos:]
    )

    if new_wikitext == wikitext:
        return None

    return wikitext, new_wikitext


# ── Template update ─────────────────────────────────────────────────────────

def make_field_block(param, label):
    """Generate a {{#if}} field block for the Infobox Player template."""
    # MediaWiki syntax has too many braces for f-strings, use concatenation
    return (
        "{{#if:{{{" + param + "|}}}|\n"
        "{{!}}-\n"
        "{{!}} '''" + label + "''' {{!}}{{!}} {{{" + param + "}}}\n"
        "}}"
    )


def update_player_template(dry_run):
    """Add missing fields to Template:Infobox Player."""
    title = "Template:Infobox Player"
    wikitext = fetch_page(title)

    new_wikitext = wikitext

    for param, label, insert_after in NEW_PLAYER_FIELDS:
        # Check if this field already exists (look for {{{param|}}} pattern)
        check_str = "{{{" + param + "|}}}"
        if check_str in new_wikitext:
            continue

        new_block = make_field_block(param, label)

        # Find the insert_after field's entire #if block and insert after it.
        # Pattern: {{#if:{{{PARAM|}}}|...anything...\n}}
        block_pattern = (
            r"\{\{#if:\{\{\{" + re.escape(insert_after) + r"\|\}\}\}\|.*?\n\}\}"
        )
        m = re.search(block_pattern, new_wikitext, re.DOTALL)
        if m:
            insert_pos = m.end()
            new_wikitext = new_wikitext[:insert_pos] + "\n" + new_block + new_wikitext[insert_pos:]
        else:
            print(f"  WARNING: Could not find insert point for '{param}' (after '{insert_after}')")

    # Update noinclude documentation
    doc_params = "\n".join(
        f"| {p:<20s} = " for p, _, _ in NEW_PLAYER_FIELDS
    )
    # Check if there's a noinclude doc section; if so, add new params
    if "<noinclude>" in new_wikitext and "}}</noinclude>" in new_wikitext:
        # Insert new param docs before the closing }} in the noinclude
        new_wikitext = re.sub(
            r"(\}\})\s*</noinclude>",
            f"{doc_params}\n\\1\n</noinclude>",
            new_wikitext,
            count=1,
        )

    if new_wikitext == wikitext:
        print("Template:Infobox Player — no changes needed")
        return

    # Show diff
    diff = difflib.unified_diff(
        wikitext.splitlines(keepends=True),
        new_wikitext.splitlines(keepends=True),
        fromfile=f"a/{title}",
        tofile=f"b/{title}",
    )
    diff_text = ''.join(diff)

    if dry_run:
        print(f"\n{'='*60}")
        print(f"DRY RUN: {title}")
        print(f"{'='*60}")
        print(diff_text)
        return

    if edit_page(title, new_wikitext, "Add missing infobox fields"):
        purge_page(title)


# ── Main ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Migrate manual wikitable infoboxes to template transclusions.",
    )
    parser.add_argument(
        "--apply", action="store_true",
        help="Publish changes (default: dry-run showing diffs)",
    )
    parser.add_argument(
        "--update-templates", action="store_true",
        help="Add missing fields to Infobox Player template",
    )
    parser.add_argument(
        "--page", type=str, default=None,
        help="Process a single page only (e.g. 'Player:slippy 10')",
    )
    parser.add_argument(
        "--fix-layout", action="store_true",
        help="Move infobox to top of page and clean up empty Overview sections",
    )
    args = parser.parse_args()
    dry_run = not args.apply

    if dry_run:
        print("=== DRY RUN MODE (use --apply to publish) ===\n")

    # Step 1: Update templates if requested
    if args.update_templates:
        print("── Updating Template:Infobox Player ──")
        update_player_template(dry_run)
        print()

    # Layout fix mode
    if args.fix_layout:
        all_pages = {**PAGES_TO_MIGRATE, **ALREADY_MIGRATED}
        if args.page:
            all_pages = {args.page: all_pages.get(args.page, "player")}

        success, skipped, errors = 0, 0, 0
        for title in all_pages:
            print(f"── {title} ──")
            try:
                wikitext = fetch_page(title)
            except requests.HTTPError as e:
                print(f"  ERROR fetching: {e}")
                errors += 1
                continue

            result = fix_layout(title, wikitext)
            if result is None:
                print("  SKIP: no layout change needed")
                skipped += 1
                continue

            old_text, new_text = result
            diff = difflib.unified_diff(
                old_text.splitlines(keepends=True),
                new_text.splitlines(keepends=True),
                fromfile=f"a/{title}",
                tofile=f"b/{title}",
            )
            diff_text = ''.join(diff)

            if dry_run:
                print(diff_text)
            else:
                if edit_page(title, new_text, "Move infobox to top of page"):
                    purge_page(title)
                    success += 1
                else:
                    errors += 1
            print()

        total = len(all_pages)
        if dry_run:
            print(f"\n{'='*60}")
            print(f"DRY RUN SUMMARY: {total} pages, {total - skipped} would be updated, {skipped} skipped")
        else:
            print(f"\n{'='*60}")
            print(f"SUMMARY: {success} published, {skipped} skipped, {errors} errors")
        return

    # Step 2: Migrate pages
    if args.page:
        pages = {args.page: PAGES_TO_MIGRATE.get(args.page)}
        if pages[args.page] is None:
            print(f"ERROR: '{args.page}' not in migration list")
            sys.exit(1)
    else:
        pages = PAGES_TO_MIGRATE

    success, skipped, errors = 0, 0, 0

    for title, page_type in pages.items():
        print(f"── {title} ──")
        try:
            wikitext = fetch_page(title)
        except requests.HTTPError as e:
            print(f"  ERROR fetching: {e}")
            errors += 1
            continue

        result = migrate_page(title, page_type, wikitext)
        if result is None:
            skipped += 1
            continue

        old_text, new_text = result

        # Show diff
        diff = difflib.unified_diff(
            old_text.splitlines(keepends=True),
            new_text.splitlines(keepends=True),
            fromfile=f"a/{title}",
            tofile=f"b/{title}",
        )
        diff_text = ''.join(diff)

        if dry_run:
            print(diff_text)
        else:
            if edit_page(title, new_text, "Migrate infobox to template"):
                purge_page(title)
                success += 1
            else:
                errors += 1

        print()

    # Summary
    total = len(pages)
    if dry_run:
        print(f"\n{'='*60}")
        print(f"DRY RUN SUMMARY: {total} pages checked, {total - skipped} would be updated, {skipped} skipped")
    else:
        print(f"\n{'='*60}")
        print(f"SUMMARY: {success} published, {skipped} skipped, {errors} errors")


if __name__ == "__main__":
    main()

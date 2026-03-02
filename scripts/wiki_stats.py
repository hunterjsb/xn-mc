#!/usr/bin/env python3
"""Auto-update numerical stats on the Xandaris wiki.

Updates: Main_Page, Players, Server_History
Scheduled: daily at 06:00 UTC via /etc/cron.d/wiki-stats
"""

import argparse
import json
import os
import re
from pathlib import Path

import requests

from utils.config import Config
from utils.players import load_bans, load_bot_names, load_usercache
from utils.wiki import WIKI_BASE, edit_page, fetch_page, purge_page


# ── Stats computation ─────────────────────────────────────


def compute_records(server_dir, uuid_to_name, bot_names):
    """Compute per-player record values from stat JSONs."""
    stats_dir = os.path.join(server_dir, "world", "stats")
    keys = [
        "play_time", "mob_kills", "player_kills", "walk_one_cm", "jump",
        "traded_with_villager", "animals_bred", "boat_one_cm",
        "sleep_in_bed", "deaths", "zero_deaths_time",
        "aviate_one_cm", "items_crafted", "diamonds_mined",
    ]
    records = {k: (0, "Unknown") for k in keys}

    for stats_file in Path(stats_dir).glob("*.json"):
        uuid = stats_file.stem
        name = uuid_to_name.get(uuid)
        if not name or name in bot_names:
            continue

        try:
            with open(stats_file) as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError):
            continue

        s = data.get("stats", {})
        custom = s.get("minecraft:custom", {})
        mined = s.get("minecraft:mined", {})
        crafted = s.get("minecraft:crafted", {})

        for rk, sk in [
            ("play_time", "minecraft:play_time"),
            ("mob_kills", "minecraft:mob_kills"),
            ("player_kills", "minecraft:player_kills"),
            ("walk_one_cm", "minecraft:walk_one_cm"),
            ("jump", "minecraft:jump"),
            ("traded_with_villager", "minecraft:traded_with_villager"),
            ("animals_bred", "minecraft:animals_bred"),
            ("boat_one_cm", "minecraft:boat_one_cm"),
            ("sleep_in_bed", "minecraft:sleep_in_bed"),
            ("deaths", "minecraft:deaths"),
            ("aviate_one_cm", "minecraft:aviate_one_cm"),
        ]:
            val = custom.get(sk, 0)
            if val > records[rk][0]:
                records[rk] = (val, name)

        # Zero deaths: longest play_time where deaths == 0
        if custom.get("minecraft:deaths", 0) == 0:
            pt = custom.get("minecraft:play_time", 0)
            if pt > records["zero_deaths_time"][0]:
                records["zero_deaths_time"] = (pt, name)

        # Total items crafted
        tc = sum(crafted.values())
        if tc > records["items_crafted"][0]:
            records["items_crafted"] = (tc, name)

        # Diamonds mined (regular + deepslate)
        dm = (mined.get("minecraft:diamond_ore", 0) +
              mined.get("minecraft:deepslate_diamond_ore", 0))
        if dm > records["diamonds_mined"][0]:
            records["diamonds_mined"] = (dm, name)

    return records


def compute_aggregates(server_dir, uuid_to_name, bot_names):
    """Compute server-wide aggregate stats."""
    stats_dir = os.path.join(server_dir, "world", "stats")
    totals = dict(play_time=0, mob_kills=0, player_kills=0,
                  distance=0, trades=0)

    for stats_file in Path(stats_dir).glob("*.json"):
        uuid = stats_file.stem
        name = uuid_to_name.get(uuid)
        if not name or name in bot_names:
            continue
        try:
            with open(stats_file) as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError):
            continue

        c = data.get("stats", {}).get("minecraft:custom", {})
        totals["play_time"] += c.get("minecraft:play_time", 0)
        totals["mob_kills"] += c.get("minecraft:mob_kills", 0)
        totals["player_kills"] += c.get("minecraft:player_kills", 0)
        totals["distance"] += (c.get("minecraft:walk_one_cm", 0) +
                               c.get("minecraft:sprint_one_cm", 0) +
                               c.get("minecraft:aviate_one_cm", 0))
        totals["trades"] += c.get("minecraft:traded_with_villager", 0)

    return totals


def count_pages_by_namespace():
    """Count wiki pages per content namespace."""
    counts = {}
    for ns, label in [(0, "main"), (10, "template"), (3000, "player"),
                      (3002, "event"), (3004, "location"), (3006, "group")]:
        resp = requests.get(f"{WIKI_BASE}/api.php", params={
            "action": "query", "list": "allpages", "apnamespace": ns,
            "aplimit": "max", "format": "json",
        }, timeout=15)
        counts[label] = len(resp.json().get("query", {}).get("allpages", []))
    counts["total"] = sum(counts.values())
    return counts


# ── Formatting helpers ────────────────────────────────────


def fmt(raw, unit):
    """Format a stat value for display."""
    if unit == "hours":
        return f"{raw / 72000:,.1f} hours"
    if unit == "km":
        return f"{raw / 100000:,.1f} km"
    return f"{raw:,}"


def plink(name):
    """Wiki player link."""
    return f"[[Player:{name}|{name}]]"


# ── Table helpers ─────────────────────────────────────────


def extract_preserved_rows(text, preserve_labels):
    """Extract wikitable rows matching any preserve label (case-insensitive)."""
    preserved = []
    for label in preserve_labels:
        pattern = r'(\|-\n\| ' + re.escape(label) + r' \|\|[^\n]+)'
        m = re.search(pattern, text, re.IGNORECASE)
        if m:
            preserved.append(m.group(1))
    return preserved


# ── Page updaters ─────────────────────────────────────────


def update_players_page(text, records, total, alive, dead, hack_count, player_pages):
    """Update Server Records table and Statistics on Players page."""
    preserved = extract_preserved_rows(text,
        ["Fastest death", "Fastest Spawn Death", "Fastest spawn death"])

    # Build records table
    before_preserved = [
        ("Most play time",       "play_time",            "hours"),
        ("Most mob kills",       "mob_kills",            "count"),
        ("Most player kills",    "player_kills",         "count"),
        ("Longest walk",         "walk_one_cm",          "km"),
        ("Most jumps",           "jump",                 "count"),
        ("Most villager trades", "traded_with_villager",  "count"),
        ("Most animals bred",    "animals_bred",         "count"),
        ("Longest boat journey", "boat_one_cm",          "km"),
        ("Zero-death record",    "zero_deaths_time",     "hours"),
    ]
    after_preserved = [
        ("Most elytra flight",   "aviate_one_cm",  "km"),
        ("Most items crafted",   "items_crafted",   "count"),
        ("Most diamonds mined",  "diamonds_mined",  "count"),
    ]

    lines = [
        '== Server Records ==',
        '',
        '{| class="wikitable"',
        '|-',
        '! Record !! Player !! Value',
    ]
    for display, key, unit in before_preserved:
        raw, name = records[key]
        lines.extend(['|-', f'| {display} || {plink(name)} || {fmt(raw, unit)}'])
    for row in preserved:
        lines.append(row)
    for display, key, unit in after_preserved:
        raw, name = records[key]
        lines.extend(['|-', f'| {display} || {plink(name)} || {fmt(raw, unit)}'])
    lines.append('|}')

    new_section = '\n'.join(lines) + '\n'
    text = re.sub(
        r'== Server Records ==\n.*?(?=\n== Statistics ==)',
        new_section, text, count=1, flags=re.DOTALL,
    )

    # Update statistics bullets
    replacements = [
        (r"\* '''Total unique players:'''[^\n]*",
         f"* '''Total unique players:''' {total}"),
        (r"\* '''Currently alive:'''[^\n]*",
         f"* '''Currently alive:''' ~{alive}"),
        (r"\* '''Deathbanned:'''[^\n]*",
         f"* '''Deathbanned:''' {dead}"),
        (r"\* '''Permanently dead:'''[^\n]*",
         f"* '''Deathbanned:''' {dead}"),
        (r"\* '''Banned \(hacking\):'''[^\n]*",
         f"* '''Banned (hacking):''' {hack_count}"),
        (r"\* '''Player pages on this wiki:'''[^\n]*",
         f"* '''Player pages on this wiki:''' {player_pages}"),
    ]
    for pattern, repl in replacements:
        text = re.sub(pattern, repl, text)

    return text


def update_main_page(text, records, total, alive, dead, aggregates, page_counts):
    """Update Main_Page: Browse counts, records table, Server at a Glance."""

    # Update Browse section page counts
    text = re.sub(r"'''(\d+)''' player pages",
                  f"'''{page_counts['player']}''' player pages", text)
    text = re.sub(r"'''(\d+)''' event pages",
                  f"'''{page_counts['event']}''' event pages", text)
    text = re.sub(r"'''(\d+)''' locations",
                  f"'''{page_counts['location']}''' locations", text)

    # Rebuild Server Records table (preserving manual rows)
    preserved = extract_preserved_rows(text,
        ["Fastest death", "Most accounts"])

    row_defs = [
        ("Most time played",     "play_time",            "hours"),
        ("Most mob kills",       "mob_kills",            "count"),
        ("Zero-death record",    "zero_deaths_time",     "hours"),
        ("Most player kills",    "player_kills",         "count"),
        ("Most villager trades", "traded_with_villager",  "count"),
        ("Longest walk",         "walk_one_cm",          "km"),
        ("Most elytra flight",   "aviate_one_cm",        "km"),
    ]

    lines = [
        '== Server Records ==',
        '',
        '{| class="wikitable" style="width:100%;"',
        '|-',
        '! Record !! Player !! Value',
    ]
    for display, key, unit in row_defs:
        raw, name = records[key]
        lines.extend(['|-', f'| {display} || {plink(name)} || {fmt(raw, unit)}'])
    for row in preserved:
        lines.append(row)
    lines.append('|}')

    new_section = '\n'.join(lines) + '\n'
    text = re.sub(
        r'== Server Records ==\n.*?(?=\n== Server Features ==)',
        new_section, text, count=1, flags=re.DOTALL,
    )

    # Update "Server at a Glance" table row
    rate = f"{alive / total * 100:.0f}%" if total > 0 else "N/A"
    total_hours = f"{aggregates['play_time'] / 72000:,.0f}"
    text = re.sub(
        r'\| February 15, 2026 \|\|[^\n]+',
        f'| February 15, 2026 || {total}+ || {rate} || {dead}'
        f' || {total_hours} hours || {page_counts["total"]}',
        text, count=1,
    )

    return text


def update_server_history(text, total, dead, aggregates):
    """Update Server Statistics table on Server History page."""
    rate = f"{(total - dead) / total * 100:.0f}%" if total > 0 else "N/A"
    replacements = [
        (r'\| Total unique players \|\|[^\n]+',
         f'| Total unique players || {total}+'),
        (r'\| Total deathbans \|\|[^\n]+',
         f'| Total deathbans || {dead}'),
        (r'\| Survival rate \|\|[^\n]+',
         f'| Survival rate || {rate}'),
        (r'\| Total play time \|\|[^\n]+',
         f'| Total play time || {aggregates["play_time"] / 72000:,.0f} hours'),
        (r'\| Total mob kills \|\|[^\n]+',
         f'| Total mob kills || {aggregates["mob_kills"]:,}'),
        (r'\| Total player kills \|\|[^\n]+',
         f'| Total player kills || {aggregates["player_kills"]:,}'),
        (r'\| Total distance traveled \|\|[^\n]+',
         f'| Total distance traveled || {aggregates["distance"] / 100000:,.0f} km'),
        (r'\| Total villager trades \|\|[^\n]+',
         f'| Total villager trades || {aggregates["trades"]:,}'),
    ]
    for pattern, repl in replacements:
        text = re.sub(pattern, repl, text)
    return text


# ── Main ──────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(description="Auto-update wiki stats")
    parser.add_argument("--dry-run", action="store_true",
                        help="Show diffs without publishing")
    args = parser.parse_args()

    cfg = Config()
    server_dir = cfg["SERVER_FP"]

    # Load data
    bot_names = load_bot_names()
    uuid_to_name = load_usercache(server_dir)
    deathbanned, hackbanned = load_bans(server_dir, bot_names)
    records = compute_records(server_dir, uuid_to_name, bot_names)
    aggregates = compute_aggregates(server_dir, uuid_to_name, bot_names)
    page_counts = count_pages_by_namespace()

    # Compute player counts
    all_names = {n for n in uuid_to_name.values() if n not in bot_names}
    total = len(all_names)
    dead = len(deathbanned)
    hacked = len(hackbanned)
    alive = total - dead - hacked

    print(f"Players: {total} total, {alive} alive, {dead} dead, {hacked} hack-banned")
    print(f"Wiki pages: {page_counts}")
    print(f"Bots filtered: {len(bot_names)}")
    print()

    for key, unit, display in [
        ("play_time", "hours", "Most Play Time"),
        ("mob_kills", "count", "Most Mob Kills"),
        ("player_kills", "count", "Most Player Kills"),
        ("walk_one_cm", "km", "Longest Walk"),
        ("jump", "count", "Most Jumps"),
        ("traded_with_villager", "count", "Most Villager Trades"),
        ("animals_bred", "count", "Most Animals Bred"),
        ("boat_one_cm", "km", "Longest Boat Journey"),
        ("sleep_in_bed", "count", "Most Beds Slept In"),
        ("deaths", "count", "Most Deaths"),
        ("zero_deaths_time", "hours", "Zero Deaths (longest)"),
        ("aviate_one_cm", "km", "Most Elytra Flight"),
        ("items_crafted", "count", "Most Items Crafted"),
        ("diamonds_mined", "count", "Most Diamonds Mined"),
    ]:
        raw, name = records[key]
        print(f"  {display}: {name} — {fmt(raw, unit)}")
    print()

    # Fetch current pages
    players_text = fetch_page("Players")
    main_text = fetch_page("Main_Page")
    history_text = fetch_page("Server_History")

    # Apply updates
    new_players = update_players_page(
        players_text, records, total, alive, dead, hacked,
        page_counts["player"])
    new_main = update_main_page(
        main_text, records, total, alive, dead, aggregates, page_counts)
    new_history = update_server_history(
        history_text, total, dead, aggregates)

    pages = [
        ("Players", players_text, new_players),
        ("Main_Page", main_text, new_main),
        ("Server_History", history_text, new_history),
    ]

    if args.dry_run:
        for title, old, new in pages:
            if old == new:
                print(f"=== {title}: no changes ===")
                continue
            print(f"=== {title}: changed ===")
            old_lines = old.splitlines()
            new_lines = new.splitlines()
            for i, (o, n) in enumerate(zip(old_lines, new_lines)):
                if o != n:
                    print(f"  -{i+1}: {o}")
                    print(f"  +{i+1}: {n}")
            # Handle length differences
            if len(new_lines) > len(old_lines):
                for i in range(len(old_lines), len(new_lines)):
                    print(f"  +{i+1}: {new_lines[i]}")
            elif len(old_lines) > len(new_lines):
                for i in range(len(new_lines), len(old_lines)):
                    print(f"  -{i+1}: {old_lines[i]}")
            print()
        return

    print("Publishing...")
    for title, old, new in pages:
        if old == new:
            print(f"  {title}: unchanged, skipping")
            continue
        edit_page(title, new, "Auto-update stats")
        purge_page(title)

    print("Done.")


if __name__ == "__main__":
    main()

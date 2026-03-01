#!/usr/bin/env python3
"""Auto-update numerical stats on the Xandaris wiki."""

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import requests

from utils.config import Config


WIKI_BASE = "https://wiki.xandaris.space"
MEDIAWIKI_DIR = "/var/www/mediawiki"


def load_bot_names():
    """Load bot usernames from chatbot personalities."""
    path = Path(__file__).parent.parent / "chatbot" / "personalities.json"
    with open(path) as f:
        return {p["username"] for p in json.load(f)}


def load_usercache(server_dir):
    """Load UUID→name map from usercache.json."""
    with open(os.path.join(server_dir, "usercache.json")) as f:
        return {e["uuid"]: e["name"] for e in json.load(f)}


def load_bans(server_dir, bot_names):
    """Return (deathbanned_names, hackbanned_names) sets."""
    with open(os.path.join(server_dir, "banned-players.json")) as f:
        bans = json.load(f)
    deathbanned, hackbanned = set(), set()
    for ban in bans:
        name = ban["name"]
        if name in bot_names:
            continue
        reason = ban.get("reason", "")
        if "Deathban" in reason or "Game Over" in reason:
            deathbanned.add(name)
        else:
            hackbanned.add(name)
    return deathbanned, hackbanned


def compute_records(server_dir, uuid_to_name, bot_names):
    """Compute all record values from player stat JSONs."""
    stats_dir = os.path.join(server_dir, "world", "stats")
    records = {k: (0, "Unknown") for k in [
        "play_time", "mob_kills", "walk_one_cm", "jump",
        "traded_with_villager", "animals_bred", "boat_one_cm",
        "sleep_in_bed", "deaths", "zero_deaths_time",
        "aviate_one_cm", "items_crafted", "diamonds_mined",
    ]}

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


def fmt(raw, unit):
    """Format a stat value for display."""
    if unit == "hours":
        return f"{raw / 72000:,.1f} hours"
    if unit == "km":
        return f"{raw / 100000:,.1f} km"
    return f"{raw:,}"


def fmt_short(raw, unit):
    """Short format for Main_Page bullets."""
    if unit == "hours":
        return f"{raw / 72000:,.1f}h"
    if unit == "km":
        return f"{raw / 100000:,.1f} km"
    return f"{raw:,}"


def plink(name):
    """Wiki player link."""
    return f"[[Player:{name}|{name}]]"


# -- Page updaters --


def update_players_page(text, records, total, alive, dead, hack_count):
    """Update Server Records table and Statistics section on Players page."""
    # Extract preserved rows (Fastest Death, Fastest Spawn Death)
    preserved = []
    for label in ["Fastest Death", "Fastest Spawn Death"]:
        m = re.search(r'(\|-\n\| ' + re.escape(label) + r' \|\|[^\n]+)', text)
        if m:
            preserved.append(m.group(1))

    # Build records table
    row_defs = [
        ("Most Play Time",        "play_time",            "hours"),
        ("Most Mob Kills",        "mob_kills",            "count"),
        ("Longest Walk",          "walk_one_cm",          "km"),
        ("Most Jumps",            "jump",                 "count"),
        ("Most Villager Trades",  "traded_with_villager", "count"),
        ("Most Animals Bred",     "animals_bred",         "count"),
        ("Longest Boat Journey",  "boat_one_cm",          "km"),
        ("Most Beds Slept In",    "sleep_in_bed",         "count"),
        ("Most Deaths",           "deaths",               "count"),
        ("Zero Deaths (longest)", "zero_deaths_time",     "hours"),
    ]
    lines = [
        '== Server Records ==',
        '',
        '{| class="wikitable"',
        '|-',
        '! Record !! Player !! Value',
    ]
    for display, key, unit in row_defs:
        raw, name = records[key]
        lines.append('|-')
        lines.append(f'| {display} || {plink(name)} || {fmt(raw, unit)}')

    # Preserved rows (Fastest Death, Fastest Spawn Death)
    for row in preserved:
        lines.append(row)

    # Remaining computed records after preserved rows
    for display, key, unit in [
        ("Most Elytra Flight",  "aviate_one_cm",  "km"),
        ("Most Items Crafted",  "items_crafted",   "count"),
        ("Most Diamonds Mined", "diamonds_mined",  "count"),
    ]:
        raw, name = records[key]
        lines.append('|-')
        lines.append(f'| {display} || {plink(name)} || {fmt(raw, unit)}')
    lines.append('|}')

    new_section = '\n'.join(lines)
    text = re.sub(
        r'== Server Records ==\n.*?(?=\n== Statistics ==)',
        new_section, text, count=1, flags=re.DOTALL,
    )

    # Update statistics bullets (replace only the 4 stat lines, keep the rest)
    text = re.sub(r"\* '''Total unique players:'''[^\n]*",
                  f"* '''Total unique players:''' {total}", text)
    text = re.sub(r"\* '''Currently alive:'''[^\n]*",
                  f"* '''Currently alive:''' {alive}", text)
    text = re.sub(r"\* '''Permanently dead:'''[^\n]*",
                  f"* '''Permanently dead:''' {dead}", text)
    text = re.sub(r"\* '''Banned \(hacking\):'''[^\n]*",
                  f"* '''Banned (hacking):''' {hack_count}", text)

    return text


def update_main_page(text, records, total, alive):
    """Update Server Records bullets and Quick Stats on Main_Page."""
    # Extract preserved bullet (Fastest death)
    preserved = []
    m = re.search(r"(\* '''Fastest death:'''[^\n]+)", text)
    if m:
        preserved.append(m.group(1))

    # Build server records bullet list
    bullet_defs = [
        ("Most time played",   "play_time",       "hours"),
        ("Most mob kills",     "mob_kills",        "count"),
        ("Longest walk",       "walk_one_cm",      "km"),
        ("Zero deaths record", "zero_deaths_time", "hours"),
    ]
    lines = ['=== Server Records ===']
    for display, key, unit in bullet_defs:
        raw, name = records[key]
        lines.append(f"* '''{display}:''' {plink(name)} ({fmt_short(raw, unit)})")
    lines.extend(preserved)
    for display, key, unit in [
        ("Most elytra flight", "aviate_one_cm", "km"),
    ]:
        raw, name = records[key]
        lines.append(f"* '''{display}:''' {plink(name)} ({fmt_short(raw, unit)})")

    new_bullets = '\n'.join(lines)
    text = re.sub(
        r'=== Server Records ===\n.*?(?=\n\|\})',
        new_bullets, text, count=1, flags=re.DOTALL,
    )

    # Update Quick Stats table (Players Joined + Survival Rate cells only)
    rate = f"{alive / total * 100:.0f}%" if total > 0 else "N/A"
    text = re.sub(
        r'(\| February 15, 2026 \|\| )\S+( \|\| )[^|]+(\|\|)',
        rf'\g<1>{total}\g<2>{rate} \3',
        text, count=1,
    )

    return text


# -- Wiki I/O --


def fetch_page(title):
    """Fetch raw wikitext for a page."""
    resp = requests.get(f"{WIKI_BASE}/index.php",
                        params={"title": title, "action": "raw"}, timeout=15)
    resp.raise_for_status()
    return resp.text


def edit_page(title, content, summary):
    """Write page content via maintenance script."""
    cmd = [
        "sudo", "-u", "www-data", "php",
        os.path.join(MEDIAWIKI_DIR, "maintenance", "run.php"),
        "edit", "--summary", summary, title,
    ]
    result = subprocess.run(cmd, input=content, capture_output=True, text=True,
                            cwd=MEDIAWIKI_DIR)
    if result.returncode != 0:
        print(f"ERROR editing {title}: {result.stderr}", file=sys.stderr)
        return False
    print(f"Updated {title}: {result.stdout.strip()}")
    return True


def main():
    parser = argparse.ArgumentParser(description="Auto-update wiki stats")
    parser.add_argument("--dry-run", action="store_true",
                        help="Print changes without publishing")
    args = parser.parse_args()

    cfg = Config()
    server_dir = cfg["SERVER_FP"]

    # Load data
    bot_names = load_bot_names()
    uuid_to_name = load_usercache(server_dir)
    deathbanned, hackbanned = load_bans(server_dir, bot_names)
    records = compute_records(server_dir, uuid_to_name, bot_names)

    # Compute aggregate stats
    all_names = {n for n in uuid_to_name.values() if n not in bot_names}
    total = len(all_names)
    dead = len(deathbanned)
    hacked = len(hackbanned)
    alive = total - dead - hacked

    print(f"Players: {total} total, {alive} alive, {dead} dead, {hacked} hack-banned")
    print(f"Bots filtered: {len(bot_names)}")
    print()
    for key, unit, display in [
        ("play_time", "hours", "Most Play Time"),
        ("mob_kills", "count", "Most Mob Kills"),
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

    # Apply updates
    new_players = update_players_page(players_text, records, total, alive, dead, hacked)
    new_main = update_main_page(main_text, records, total, alive)

    if args.dry_run:
        print("=== Players page (updated) ===")
        print(new_players)
        print()
        print("=== Main_Page (updated) ===")
        print(new_main)
        return

    edit_page("Players", new_players, "Auto-update stats")
    edit_page("Main_Page", new_main, "Auto-update stats")


if __name__ == "__main__":
    main()

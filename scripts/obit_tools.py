#!/usr/bin/env python3
"""Obituary pre-processing tools for Claude Code.

Subcommands:
    briefing  — Full pre-processed briefing for a date
    deaths    — Compact death table
    chat      — Chat messages around a player/time
    player    — Full player profile
    publish   — Publish wikitext from stdin to the wiki
"""

import argparse
import re
import sys
from datetime import datetime, timedelta, timezone

from utils.config import Config
from utils.logs import (
    EST,
    UTC,
    extract_advancements,
    extract_all_chat,
    extract_chat_context,
    extract_deaths,
    extract_sessions,
    fmt_est,
    fmt_est_full,
    parse_log_lines,
    resolve_log_files,
)
from utils.players import (
    format_advancement,
    get_player_advancements,
    get_player_stats,
    load_ban_details,
    load_bans,
    load_bot_names,
    load_usercache,
    name_to_uuid,
    summarize_player_stats,
)
from utils.wiki import edit_page, fetch_page, page_exists, purge_page


def _load_lines(server_dir, date_str, bot_names):
    """Resolve log files and parse all lines into a reusable list."""
    files = resolve_log_files(server_dir, date_str)
    if not files:
        print(f"No log files found for {date_str}", file=sys.stderr)
        sys.exit(1)
    return list(parse_log_lines(files, date_str))


def _date_display(date_str):
    """Format YYYY-MM-DD as 'Month DD, YYYY'."""
    dt = datetime.strptime(date_str, "%Y-%m-%d")
    return dt.strftime("%B %d, %Y").replace(" 0", " ")


def _fmt_duration(seconds):
    """Format seconds as compact duration string."""
    if seconds < 60:
        return f"{seconds}s"
    m, s = divmod(seconds, 60)
    h, m = divmod(m, 60)
    if h > 0:
        return f"{h}h{m}m{s}s"
    return f"{m}m{s}s"


# ── briefing ─────────────────────────────────────────────


def cmd_briefing(args, cfg):
    server_dir = cfg["SERVER_FP"]
    bot_names = load_bot_names()
    uuid_map = load_usercache(server_dir)
    n2u = name_to_uuid(uuid_map)
    ban_details = load_ban_details(server_dir)

    lines = _load_lines(server_dir, args.date, bot_names)
    deaths = extract_deaths(lines, bot_names)
    sessions = extract_sessions(lines, bot_names)
    advs_log = extract_advancements(lines, bot_names)
    all_chat = extract_all_chat(lines, bot_names)

    date_display = _date_display(args.date)
    obit_title = f"Event:Obituaries {datetime.strptime(args.date, '%Y-%m-%d').strftime('%B %-d')}"

    # Check which players are already documented (look for Player: links in table)
    existing_page = fetch_page(obit_title)
    already_documented = set()
    if existing_page:
        for m in re.finditer(r'\[\[Player:[^|]*\|([^\]]+)\]\]', existing_page):
            already_documented.add(m.group(1))

    wiki_status = "EXISTS" if existing_page else "NEW"

    # Header
    out = []
    out.append(f"# OBITUARY BRIEFING: {date_display}")
    out.append(f"# Deaths: {len(deaths)}")
    out.append(f"# Wiki page: {obit_title} ({wiki_status})")
    if already_documented:
        out.append(f"# Already documented: {', '.join(sorted(already_documented))}")
    out.append("")

    # Deaths summary
    out.append("## DEATHS")
    for i, d in enumerate(deaths, 1):
        out.append(
            f"{i}. {fmt_est(d['time_est'])} — **{d['player']}** — {d['cause']}"
        )
    out.append("")

    # Per-death detail
    for i, d in enumerate(deaths, 1):
        player = d["player"]
        uuid = n2u.get(player.lower())

        out.append(f"## DEATH {i}: {player}")
        out.append(f"Time: {fmt_est(d['time_est'])} EST ({d['time_utc'].strftime('%H:%M:%S')} UTC)")
        out.append(f"Cause: {d['cause']}")

        # Ban info
        ban = ban_details.get(player)
        if ban:
            out.append(f"Banned: {ban.get('created', 'unknown')}")
        else:
            out.append("Banned: not found in ban list")

        # Wiki page
        player_page = f"Player:{player}"
        if page_exists(player_page):
            out.append(f"Wiki page: {player_page}")
        else:
            out.append("Wiki page: none")

        # Stats
        if uuid:
            stats_data = get_player_stats(server_dir, uuid)
            summary = summarize_player_stats(stats_data)
            if summary:
                out.append(f"Playtime: {summary['play_display']}")
                out.append(
                    f"Mob kills: {summary['mob_kills']}, "
                    f"Deaths: {summary['deaths']}, "
                    f"Diamonds: {summary['diamonds']}"
                )
                out.append(
                    f"Blocks mined: {summary['blocks_mined']}, "
                    f"Items crafted: {summary['items_crafted']}, "
                    f"Villager trades: {summary['villager_trades']}"
                )
                if summary["top_killed"]:
                    out.append(f"Top kills: {', '.join(summary['top_killed'])}")
                if summary["top_killed_by"]:
                    out.append(f"Killed by: {', '.join(summary['top_killed_by'])}")

            # Advancements from stats file
            file_advs = get_player_advancements(server_dir, uuid)
            named_advs = [format_advancement(a) for a in file_advs]
            if named_advs:
                out.append(f"Advancements ({len(named_advs)}): {', '.join(named_advs)}")
        else:
            out.append("Stats: UUID not found")

        # Advancements from logs
        player_advs = advs_log.get(player, [])
        if player_advs:
            out.append("Advancements (from logs):")
            for a in player_advs:
                out.append(f"  {fmt_est(a['time_est'])}: [{a['name']}]")

        # Sessions
        player_sessions = sessions.get(player, [])
        if player_sessions:
            out.append(f"Sessions ({len(player_sessions)}):")
            for s in player_sessions:
                tag = " [Game Over]" if s["gameover"] else ""
                out.append(
                    f"  {s['join'].strftime('%H:%M:%S')}-{s['leave'].strftime('%H:%M:%S')} "
                    f"({_fmt_duration(s['duration_sec'])}){tag}"
                )

        # Chat context
        chat = extract_chat_context(lines, player, d["time_utc"], bot_names)
        if chat:
            out.append(f"Chat ({len(chat)} messages):")
            for c in chat:
                marker = " <<<" if c["is_target"] else ""
                out.append(
                    f"  [{fmt_est_full(c['time_est'])}] <{c['speaker']}> {c['message']}{marker}"
                )

        out.append("")

    # Context section
    active_players = sorted({c["speaker"] for c in all_chat})
    out.append("## CONTEXT")
    out.append(f"Total player chat messages: {len(all_chat)}")
    out.append(f"Active players: {', '.join(active_players)}")

    print("\n".join(out))


# ── deaths ───────────────────────────────────────────────


def cmd_deaths(args, cfg):
    server_dir = cfg["SERVER_FP"]
    bot_names = load_bot_names()

    lines = _load_lines(server_dir, args.date, bot_names)
    deaths = extract_deaths(lines, bot_names)

    print(f"{'#':<4} {'Time EST':<14} {'Player':<21} Cause")
    for i, d in enumerate(deaths, 1):
        print(
            f"{i:<4} {fmt_est(d['time_est']):<14} {d['player']:<21} {d['cause']}"
        )


# ── chat ─────────────────────────────────────────────────


def cmd_chat(args, cfg):
    server_dir = cfg["SERVER_FP"]
    bot_names = load_bot_names()
    lines = _load_lines(server_dir, args.date, bot_names)

    if args.player:
        # Find death time for this player, or use --around
        deaths = extract_deaths(lines, bot_names)
        player_death = next((d for d in deaths if d["player"] == args.player), None)

        if player_death:
            center_time = player_death["time_utc"]
        elif args.around:
            h, m, s = map(int, args.around.split(":"))
            base_date = datetime.strptime(args.date, "%Y-%m-%d").replace(tzinfo=UTC)
            center_time = base_date.replace(hour=h, minute=m, second=s)
        else:
            # Show all chat by this player
            all_chat = extract_all_chat(lines, bot_names)
            player_msgs = [c for c in all_chat if c["speaker"] == args.player]
            for c in player_msgs:
                print(f"[{fmt_est_full(c['time_est'])}] <{c['speaker']}> {c['message']}")
            return

        window = args.window or 30
        chat = extract_chat_context(lines, args.player, center_time, bot_names,
                                    window_before=window, window_after=5)
        for c in chat:
            marker = " <<<" if c["is_target"] else ""
            print(f"[{fmt_est_full(c['time_est'])}] <{c['speaker']}> {c['message']}{marker}")

    elif args.around:
        h, m, s = map(int, args.around.split(":"))
        base_date = datetime.strptime(args.date, "%Y-%m-%d").replace(tzinfo=UTC)
        center_time = base_date.replace(hour=h, minute=m, second=s)
        window = args.window or 10

        all_chat = extract_all_chat(lines, bot_names)
        t_start = center_time - timedelta(minutes=window)
        t_end = center_time + timedelta(minutes=window)
        for c in all_chat:
            if t_start <= c["time_utc"] <= t_end:
                print(f"[{fmt_est_full(c['time_est'])}] <{c['speaker']}> {c['message']}")
    else:
        # All chat for the day
        all_chat = extract_all_chat(lines, bot_names)
        for c in all_chat:
            print(f"[{fmt_est_full(c['time_est'])}] <{c['speaker']}> {c['message']}")


# ── player ───────────────────────────────────────────────


def cmd_player(args, cfg):
    server_dir = cfg["SERVER_FP"]
    bot_names = load_bot_names()
    uuid_map = load_usercache(server_dir)
    n2u = name_to_uuid(uuid_map)
    ban_details = load_ban_details(server_dir)
    deathbanned, hackbanned = load_bans(server_dir, bot_names)

    name = args.name
    uuid = n2u.get(name.lower())

    out = []
    out.append(f"# Player: {name}")
    out.append(f"UUID: {uuid or 'not found'}")

    # Status
    if name in deathbanned:
        out.append("Status: DEATHBANNED")
    elif name in hackbanned:
        out.append("Status: HACK-BANNED")
    else:
        out.append("Status: ALIVE")

    # Ban details
    ban = ban_details.get(name)
    if ban:
        out.append(f"Ban date: {ban.get('created', 'unknown')}")
        reason_first_line = ban.get("reason", "").split("\n")[0]
        out.append(f"Ban reason: {reason_first_line}")

    # Wiki page
    player_page = f"Player:{name}"
    out.append(f"Wiki page: {'exists' if page_exists(player_page) else 'none'}")

    # Stats
    if uuid:
        stats_data = get_player_stats(server_dir, uuid)
        summary = summarize_player_stats(stats_data)
        if summary:
            out.append(f"Playtime: {summary['play_display']}")
            out.append(
                f"Mob kills: {summary['mob_kills']}, "
                f"Player kills: {summary['player_kills']}, "
                f"Deaths: {summary['deaths']}"
            )
            out.append(f"Diamonds mined: {summary['diamonds']}")
            out.append(
                f"Blocks mined: {summary['blocks_mined']}, "
                f"Items crafted: {summary['items_crafted']}, "
                f"Villager trades: {summary['villager_trades']}"
            )
            if summary["top_killed"]:
                out.append(f"Top kills: {', '.join(summary['top_killed'])}")
            if summary["top_killed_by"]:
                out.append(f"Killed by: {', '.join(summary['top_killed_by'])}")
            if summary["top_mined"]:
                out.append(f"Top mined: {', '.join(summary['top_mined'])}")
            if summary["top_crafted"]:
                out.append(f"Top crafted: {', '.join(summary['top_crafted'])}")

        # Advancements
        file_advs = get_player_advancements(server_dir, uuid)
        named_advs = [format_advancement(a) for a in file_advs]
        if named_advs:
            out.append(f"Advancements ({len(named_advs)}): {', '.join(named_advs)}")
        else:
            out.append("Advancements: none")
    else:
        out.append("Stats: UUID not found in usercache")

    print("\n".join(out))


# ── publish ──────────────────────────────────────────────


def cmd_publish(args, cfg):
    content = sys.stdin.read()
    if not content.strip():
        print("ERROR: no content on stdin", file=sys.stderr)
        sys.exit(1)

    title = args.title
    summary = args.summary or "Auto-generated obituaries"

    ok = edit_page(title, content, summary)
    if ok:
        purge_page(title)
        print(f"Published: {title}")
    else:
        sys.exit(1)


# ── CLI ──────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(
        description="Obituary pre-processing tools for Claude Code",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    # briefing
    p = sub.add_parser("briefing", help="Full pre-processed briefing for a date")
    p.add_argument("--date", required=True, help="Date in YYYY-MM-DD format")

    # deaths
    p = sub.add_parser("deaths", help="Compact death table")
    p.add_argument("--date", required=True, help="Date in YYYY-MM-DD format")

    # chat
    p = sub.add_parser("chat", help="Chat messages around a player/time")
    p.add_argument("--date", required=True, help="Date in YYYY-MM-DD format")
    p.add_argument("--player", help="Player name to focus on")
    p.add_argument("--around", help="UTC time to center on (HH:MM:SS)")
    p.add_argument("--window", type=int, help="Minutes before center time")

    # player
    p = sub.add_parser("player", help="Full player profile")
    p.add_argument("--name", required=True, help="Player name")

    # publish
    p = sub.add_parser("publish", help="Publish wikitext from stdin")
    p.add_argument("--title", required=True, help="Wiki page title")
    p.add_argument("--summary", help="Edit summary")

    args = parser.parse_args()
    cfg = Config()

    cmd_map = {
        "briefing": cmd_briefing,
        "deaths": cmd_deaths,
        "chat": cmd_chat,
        "player": cmd_player,
        "publish": cmd_publish,
    }
    cmd_map[args.command](args, cfg)


if __name__ == "__main__":
    main()

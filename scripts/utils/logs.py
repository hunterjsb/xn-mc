"""Log parsing engine for Minecraft server logs."""

import gzip
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Timezones
UTC = timezone.utc
EST = timezone(timedelta(hours=-5))

# ── Regex patterns ────────────────────────────────────────

# Log line envelope: [HH:MM:SS] [Thread/LEVEL]: Message
LINE_RE = re.compile(
    r'^\[(\d{2}:\d{2}:\d{2})\] \[([^/]+)/(\w+)\]: (.+)$'
)

# Death: ☠ Player cause (Extra: World:..., X:..., Y:..., Z:...)
# Captures player and cause ONLY — coordinates are excluded by design.
DEATH_RE = re.compile(
    r'^☠ (\S+) (.+?) \(Extra: World:\w+, X:-?\d+, Y:-?\d+, Z:-?\d+\)$'
)

# Chat: optional [Not Secure] prefix, player » message
CHAT_RE = re.compile(
    r'^(?:\[Not Secure\] )?(\S+) \u00bb (.+)$'
)

# Join/leave
JOIN_RE = re.compile(r'^(\S+) joined the game$')
LEAVE_RE = re.compile(r'^(\S+) left the game$')

# Game Over — with or without IP
GAMEOVER_RE = re.compile(r'^(\S+)(?: \([^)]+\))? lost connection: Game Over!$')

# Advancement
ADV_RE = re.compile(r'^(\S+) has made the advancement \[(.+)\]$')

# Grim anticheat (filtered)
GRIM_RE = re.compile(r'^Grim » ')


# ── Log file resolution ──────────────────────────────────


def resolve_log_files(server_dir, date_str):
    """Return sorted list of log file Paths for a given date (YYYY-MM-DD).

    Includes archived .log.gz files matching the date prefix, and latest.log
    if its birth/creation date matches.
    """
    logs_dir = Path(server_dir) / "logs"
    files = []

    # Archived logs: YYYY-MM-DD-N.log.gz, sorted by N numerically
    gz_files = list(logs_dir.glob(f"{date_str}-*.log.gz"))
    gz_files.sort(key=lambda p: int(Path(p.stem).stem.rsplit("-", 1)[-1]))
    files.extend(gz_files)

    # latest.log: include if its ctime matches the requested date
    latest = logs_dir / "latest.log"
    if latest.exists():
        ctime = datetime.fromtimestamp(latest.stat().st_ctime, tz=UTC)
        if ctime.strftime("%Y-%m-%d") == date_str:
            files.append(latest)

    return files


# ── Line parsing ─────────────────────────────────────────


def parse_log_lines(files, date_str):
    """Yield (datetime_utc, thread, level, message) from log files.

    Times are combined with date_str to produce full UTC datetimes.
    """
    base_date = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=UTC)

    for fpath in files:
        opener = gzip.open if fpath.suffix == ".gz" else open
        with opener(fpath, "rt", errors="replace") as f:
            for raw_line in f:
                line = raw_line.rstrip("\n")
                m = LINE_RE.match(line)
                if not m:
                    continue
                time_str, thread, level, msg = m.groups()
                h, mn, s = map(int, time_str.split(":"))
                ts = base_date.replace(hour=h, minute=mn, second=s)
                yield ts, thread, level, msg


# ── Extraction functions ─────────────────────────────────


def extract_deaths(lines, bot_names):
    """Extract deaths from parsed log lines. Returns list of dicts.

    Each dict has: player, time_utc, time_est, cause.
    Coordinates are never included — stripped by DEATH_RE.
    """
    deaths = []
    for ts, _thread, _level, msg in lines:
        m = DEATH_RE.match(msg)
        if not m:
            continue
        player, cause = m.groups()
        if player in bot_names:
            continue
        est_time = ts.astimezone(EST)
        deaths.append({
            "player": player,
            "time_utc": ts,
            "time_est": est_time,
            "cause": cause,
        })
    return deaths


def extract_chat_context(lines, player, death_time_utc, bot_names,
                         window_before=30, window_after=5):
    """Extract chat messages around a death event.

    Returns list of {time_est, speaker, message, is_target} dicts.
    Filters out bot messages and Grim anticheat lines.
    """
    t_start = death_time_utc - timedelta(minutes=window_before)
    t_end = death_time_utc + timedelta(minutes=window_after)

    messages = []
    for ts, _thread, _level, msg in lines:
        if ts < t_start or ts > t_end:
            continue
        cm = CHAT_RE.match(msg)
        if not cm:
            continue
        speaker, text = cm.groups()
        if speaker in bot_names:
            continue
        if GRIM_RE.match(msg):
            continue
        est_time = ts.astimezone(EST)
        messages.append({
            "time_est": est_time,
            "speaker": speaker,
            "message": text,
            "is_target": speaker == player,
        })
    return messages


def extract_sessions(lines, bot_names):
    """Extract player sessions from join/leave/gameover events.

    Returns dict: player -> list of {join, leave, duration_sec, gameover} dicts.
    """
    sessions = {}  # player -> list of session dicts
    open_sessions = {}  # player -> join timestamp

    for ts, _thread, _level, msg in lines:
        jm = JOIN_RE.match(msg)
        if jm:
            player = jm.group(1)
            if player in bot_names:
                continue
            open_sessions[player] = ts
            continue

        lm = LEAVE_RE.match(msg)
        gm = GAMEOVER_RE.match(msg)

        if lm or gm:
            player = (lm or gm).group(1)
            if player in bot_names:
                continue
            join_ts = open_sessions.pop(player, None)
            if join_ts is None:
                continue
            dur = int((ts - join_ts).total_seconds())
            sessions.setdefault(player, []).append({
                "join": join_ts,
                "leave": ts,
                "duration_sec": dur,
                "gameover": gm is not None,
            })

    return sessions


def extract_advancements(lines, bot_names):
    """Extract advancements from log lines.

    Returns dict: player -> list of {time_utc, time_est, name} dicts.
    """
    advs = {}
    for ts, _thread, _level, msg in lines:
        m = ADV_RE.match(msg)
        if not m:
            continue
        player, name = m.groups()
        if player in bot_names:
            continue
        est_time = ts.astimezone(EST)
        advs.setdefault(player, []).append({
            "time_utc": ts,
            "time_est": est_time,
            "name": name,
        })
    return advs


def extract_all_chat(lines, bot_names):
    """Extract all non-bot chat messages. Returns list of dicts."""
    messages = []
    for ts, _thread, _level, msg in lines:
        if GRIM_RE.match(msg):
            continue
        cm = CHAT_RE.match(msg)
        if not cm:
            continue
        speaker, text = cm.groups()
        if speaker in bot_names:
            continue
        est_time = ts.astimezone(EST)
        messages.append({
            "time_utc": ts,
            "time_est": est_time,
            "speaker": speaker,
            "message": text,
        })
    return messages


def fmt_est(dt):
    """Format a datetime as 'HH:MM AM/PM EST'."""
    return dt.strftime("%-I:%M %p")


def fmt_est_full(dt):
    """Format a datetime as 'HH:MM:SS AM/PM'."""
    return dt.strftime("%-I:%M:%S %p")

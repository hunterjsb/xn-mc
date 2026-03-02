"""Wiki I/O helpers for the Xandaris wiki."""

import os
import subprocess
import sys

import requests

WIKI_BASE = "https://wiki.xandaris.space"
MEDIAWIKI_DIR = "/var/www/mediawiki"


def fetch_page(title):
    """Fetch raw wikitext for a page. Returns "" on 404."""
    resp = requests.get(
        f"{WIKI_BASE}/index.php",
        params={"title": title, "action": "raw"},
        timeout=15,
    )
    if resp.status_code == 404:
        return ""
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
        print(f"ERROR editing {title}: {result.stderr}", file=sys.stderr)
        return False
    print(f"  {title}: {result.stdout.strip()}")
    return True


def purge_page(title):
    """Purge parser cache for a page."""
    requests.post(
        f"{WIKI_BASE}/api.php",
        data={"action": "purge", "titles": title, "format": "json"},
        timeout=10,
    )


def page_exists(title):
    """Check whether a wiki page exists."""
    resp = requests.get(
        f"{WIKI_BASE}/api.php",
        params={
            "action": "query",
            "titles": title,
            "format": "json",
        },
        timeout=15,
    )
    pages = resp.json().get("query", {}).get("pages", {})
    return all(int(pid) > 0 for pid in pages)

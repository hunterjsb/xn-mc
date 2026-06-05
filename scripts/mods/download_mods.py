#!/usr/bin/env python3
"""Download Fabric mods for the version specified in manifest.json."""

import json
import sys
import time
import urllib.request
from pathlib import Path

MANIFEST = Path(__file__).parent / "manifest.json"
API = "https://api.modrinth.com/v2"
HEADERS = {"User-Agent": "xn-mc-mod-downloader/1.0 (hunterjsb@gmail.com)"}


def fetch(url: str) -> dict | list:
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())


def download(url: str, dest: Path) -> None:
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=30) as r, open(dest, "wb") as f:
        f.write(r.read())


def get_latest_version(slug: str, mc_version: str, loader: str = "fabric") -> dict | None:
    try:
        versions = fetch(
            f"{API}/project/{slug}/version"
            f"?game_versions=%5B%22{mc_version}%22%5D"
            f"&loaders=%5B%22{loader}%22%5D"
        )
    except urllib.error.HTTPError:
        return None
    if not versions:
        return None
    return versions[0]


def main() -> None:
    manifest = json.loads(MANIFEST.read_text())
    mc = manifest["mc_version"]
    loader_ver = manifest["fabric_loader"]

    out_dir = Path(__file__).parent / f"mods-{mc}"
    out_dir.mkdir(exist_ok=True)

    print(f"Downloading mods for MC {mc} / Fabric {loader_ver}")
    print(f"Output: {out_dir}\n")

    ok, skipped, failed = [], [], []

    for mod in manifest["mods"]:
        name = mod["name"]
        slug = mod.get("slug")

        if slug is None:
            note = mod.get("note", "no slug — manual download required")
            print(f"  SKIP  {name}: {note}")
            skipped.append((name, note))
            continue

        print(f"  ...   {name}", end="", flush=True)
        version = get_latest_version(slug, mc)
        time.sleep(0.2)

        if version is None:
            print(f" — NOT FOUND for {mc}")
            failed.append(name)
            continue

        files = [f for f in version["files"] if f.get("primary")]
        if not files:
            files = version["files"]
        if not files:
            print(" — no files attached")
            failed.append(name)
            continue

        file_info = files[0]
        filename = file_info["filename"]
        dest = out_dir / filename

        if dest.exists():
            print(f" — already exists, skipping")
            ok.append(name)
            continue

        download(file_info["url"], dest)
        size_kb = dest.stat().st_size // 1024
        print(f" — {filename} ({size_kb} KB)")
        ok.append(name)

    print(f"\nDone: {len(ok)} downloaded, {len(skipped)} skipped, {len(failed)} failed")
    if skipped:
        print("\nManual downloads needed:")
        for name, note in skipped:
            print(f"  {name}: {note}")
    if failed:
        print("\nFailed (not available for this MC version):")
        for name in failed:
            print(f"  {name}")


if __name__ == "__main__":
    main()

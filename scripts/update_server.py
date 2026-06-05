#!/usr/bin/env python3
"""Download the latest Paper build for a given MC version and update the server jar."""

import argparse
import os
import sys
import urllib.request
import json
import shutil

PAPER_API = "https://api.papermc.io/v2/projects/paper"
SERVER_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server")


def fetch(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "xn-mc-updater/1.0"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())


def latest_mc_version() -> str:
    data = fetch(PAPER_API)
    return data["versions"][-1]


def latest_build(mc_version: str) -> int:
    data = fetch(f"{PAPER_API}/versions/{mc_version}")
    return data["builds"][-1]


def download_jar(mc_version: str, build: int, dest: str) -> None:
    name = f"paper-{mc_version}-{build}.jar"
    url = f"{PAPER_API}/versions/{mc_version}/builds/{build}/downloads/{name}"
    print(f"Downloading {name}...", flush=True)
    req = urllib.request.Request(url, headers={"User-Agent": "xn-mc-updater/1.0"})
    with urllib.request.urlopen(req, timeout=300) as r, open(dest, "wb") as f:
        total = int(r.headers.get("Content-Length", 0))
        downloaded = 0
        while chunk := r.read(65536):
            f.write(chunk)
            downloaded += len(chunk)
            if total:
                pct = downloaded / total * 100
                sys.stdout.write(f"\r  {downloaded // (1024*1024)}/{total // (1024*1024)} MB ({pct:.0f}%)")
                sys.stdout.flush()
    print(f"\n  Done → {dest}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Update Paper server jar")
    parser.add_argument("--mc-version", help="MC version (default: latest Paper supports)")
    parser.add_argument("--build", type=int, help="Specific build number (default: latest)")
    args = parser.parse_args()

    mc_version = args.mc_version or latest_mc_version()
    build = args.build or latest_build(mc_version)

    jar_name = f"paper-{mc_version}-{build}.jar"
    dest = os.path.join(SERVER_DIR, jar_name)

    if os.path.exists(dest):
        print(f"Already have {jar_name}, nothing to do. Use --build to force a specific build.")
        return

    # Remove old paper jars
    for f in os.listdir(SERVER_DIR):
        if f.startswith("paper-") and f.endswith(".jar") and f != jar_name:
            old = os.path.join(SERVER_DIR, f)
            print(f"Removing old jar: {f}")
            os.remove(old)

    download_jar(mc_version, build, dest)
    print(f"\nServer updated to Paper {mc_version} build {build}")
    print(f"Start with: java -Xms2G -Xmx4G -jar {jar_name} nogui")


if __name__ == "__main__":
    main()

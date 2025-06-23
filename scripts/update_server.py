#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
Script to check for the latest Minecraft server JAR (release or snapshot)
and update the local server.jar to this version.
"""

import argparse
import json
import os
import requests
import shutil
import sys
import time

VERSION_MANIFEST_URL = "https://launchermeta.mojang.com/mc/game/version_manifest.json"
SERVER_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server")
VERSIONS_DIR = os.path.join(SERVER_DIR, "versions")
SERVER_JAR_SYMLINK = os.path.join(SERVER_DIR, "server.jar")

def main():
    """Main function to handle script logic."""
    parser = argparse.ArgumentParser(description="Minecraft Server Updater")
    parser.add_argument(
        "--type",
        choices=["release", "snapshot"],
        default="release",
        help="Type of version to update to (default: release)"
    )
    parser.add_argument(
        "--version_id",
        type=str,
        default=None,
        help="Specific version ID to download (e.g., 1.19.4, 23w07a). Overrides --type."
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Force download and update even if the version appears to be current."
    )

    args = parser.parse_args()

    print("Starting Minecraft Server Updater...")

    # Placeholder for future implementation
    print(f"Server directory: {SERVER_DIR}")
    print(f"Versions directory: {VERSIONS_DIR}")
    print(f"Server JAR symlink: {SERVER_JAR_SYMLINK}")
    print(f"Arguments: Type={args.type}, VersionID={args.version_id}, Force={args.force}")

    if not os.path.exists(VERSIONS_DIR):
        print(f"Creating versions directory: {VERSIONS_DIR}")
        os.makedirs(VERSIONS_DIR)

    # 1. Fetch and parse Minecraft version data
    target_version_id, target_version_url = get_target_version_info(args)

    if not target_version_id or not target_version_url:
        print("Could not determine target version. Exiting.")
        sys.exit(1)

    print(f"Target version ID: {target_version_id}")
    print(f"Target version manifest URL: {target_version_url}")

    # 2. Download the server JAR
    jar_download_url, downloaded_jar_path = download_server_jar(target_version_id, target_version_url)

    if not jar_download_url or not downloaded_jar_path:
        print("Failed to download server JAR. Exiting.")
        sys.exit(1)

    print(f"Server JAR for {target_version_id} downloaded to: {downloaded_jar_path}")

    # 3. Update the active server JAR
    if not update_symlink(downloaded_jar_path, SERVER_JAR_SYMLINK, target_version_id, args.force):
        sys.exit(1)

    # TODO:
    # 4. Add error handling and more user feedback (some is already present)

    print(f"Update to {target_version_id} complete!")


def update_symlink(target_jar_path, symlink_path, new_version_id, force_update):
    """
    Updates the server.jar symlink to point to the new JAR.
    Returns True on success, False on failure.
    """
    print(f"Attempting to update symlink {symlink_path} to point to {target_jar_path}")

    # Check if symlink already points to the target JAR
    if os.path.islink(symlink_path):
        try:
            current_target = os.path.realpath(symlink_path)
            if current_target == os.path.realpath(target_jar_path):
                if not force_update:
                    print(f"{symlink_path} already points to the target version {new_version_id}. No update needed.")
                    print("Use --force to update anyway.")
                    return True # Or False if we want to indicate no action was taken? For now, True.
                else:
                    print(f"--force specified. Proceeding with re-linking {symlink_path}.")
        except OSError as e:
            print(f"Warning: Could not read existing symlink target {symlink_path}: {e}")


    if os.path.lexists(symlink_path): # Use lexists to check symlink itself, not its target
        try:
            if os.path.islink(symlink_path):
                print(f"Removing existing symlink: {symlink_path}")
                os.remove(symlink_path)
            else:
                # It's a file, back it up
                backup_name = f"{symlink_path}.old.{int(time.time())}"
                print(f"Backing up existing file {symlink_path} to {backup_name}")
                shutil.move(symlink_path, backup_name)
        except OSError as e:
            print(f"Error removing or backing up existing {symlink_path}: {e}")
            return False

    try:
        # Create the new symlink. Need relative path for portability if SERVER_DIR is moved/symlinked.
        # os.path.relpath(target_jar_path, SERVER_DIR) will create a path like ../versions/1.xx/server-1.xx.jar
        # from the perspective of SERVER_DIR where the symlink SERVER_JAR_SYMLINK is created.
        relative_target_jar_path = os.path.relpath(target_jar_path, os.path.dirname(symlink_path))
        print(f"Creating new symlink from {symlink_path} to {relative_target_jar_path} (absolute: {target_jar_path})")
        os.symlink(relative_target_jar_path, symlink_path)
        print(f"Successfully updated {symlink_path} to point to {new_version_id}.")
        return True
    except OSError as e:
        print(f"Error creating symlink {symlink_path}: {e}")
        print("Please ensure you have permissions to create symlinks.")
        print(f"You may need to manually link: ln -s {relative_target_jar_path} {symlink_path}")
        return False


def download_server_jar(version_id, version_manifest_url):
    """
    Downloads the server JAR for the given version.
    Returns the download URL and the path to the downloaded JAR.
    """
    version_data = fetch_json(version_manifest_url, f"manifest for version {version_id}")
    if not version_data:
        return None, None

    try:
        jar_download_url = version_data["downloads"]["server"]["url"]
        sha1_hash = version_data["downloads"]["server"]["sha1"] # For future verification
        size_bytes = version_data["downloads"]["server"]["size"]
    except KeyError:
        print(f"Error: Could not find server JAR download information in manifest for {version_id}.")
        return None, None

    print(f"Found server JAR URL: {jar_download_url} (Size: {size_bytes / (1024*1024):.2f} MB)")

    version_specific_dir = os.path.join(VERSIONS_DIR, version_id)
    if not os.path.exists(version_specific_dir):
        print(f"Creating directory for version {version_id}: {version_specific_dir}")
        os.makedirs(version_specific_dir)

    jar_filename = f"server-{version_id}.jar"
    downloaded_jar_path = os.path.join(version_specific_dir, jar_filename)

    print(f"Downloading {jar_filename} to {downloaded_jar_path}...")
    try:
        with requests.get(jar_download_url, stream=True, timeout=300) as r: # Timeout 5 mins
            r.raise_for_status()
            total_size = int(r.headers.get('content-length', 0))
            bytes_downloaded = 0
            start_time = time.time()

            with open(downloaded_jar_path, 'wb') as f:
                for chunk in r.iter_content(chunk_size=8192):
                    f.write(chunk)
                    bytes_downloaded += len(chunk)
                    # Basic progress display
                    progress = (bytes_downloaded / total_size) * 100 if total_size > 0 else 0
                    elapsed_time = time.time() - start_time
                    speed = bytes_downloaded / elapsed_time if elapsed_time > 0 else 0
                    speed_mbps = (speed * 8) / (1024 * 1024)
                    sys.stdout.write(f"\rDownloading: {bytes_downloaded}/{total_size} bytes ({progress:.2f}%) {speed_mbps:.2f} Mbps")
                    sys.stdout.flush()
            sys.stdout.write("\nDownload complete.\n")

        # TODO: Add SHA1 verification here using `sha1_hash`

        return jar_download_url, downloaded_jar_path
    except requests.exceptions.RequestException as e:
        print(f"\nError downloading server JAR: {e}")
        if os.path.exists(downloaded_jar_path): # Clean up partial download
            os.remove(downloaded_jar_path)
        return None, None
    except IOError as e:
        print(f"\nError writing server JAR to disk: {e}")
        if os.path.exists(downloaded_jar_path):
            os.remove(downloaded_jar_path)
        return None, None


def fetch_json(url, description="data"):
    """Fetches JSON data from a URL."""
    try:
        print(f"Fetching {description} from {url}...")
        response = requests.get(url, timeout=10)
        response.raise_for_status()  # Raise an exception for bad status codes
        return response.json()
    except requests.exceptions.RequestException as e:
        print(f"Error fetching {description}: {e}")
        return None

def get_target_version_info(args):
    """
    Determines the target version ID and its manifest URL based on arguments.
    """
    version_manifest = fetch_json(VERSION_MANIFEST_URL, "main version manifest")
    if not version_manifest:
        return None, None

    if args.version_id:
        # User specified a version
        print(f"Looking for specified version: {args.version_id}")
        for version in version_manifest.get("versions", []):
            if version.get("id") == args.version_id:
                return version.get("id"), version.get("url")
        print(f"Error: Version ID '{args.version_id}' not found in the manifest.")
        return None, None
    else:
        # Use latest release or snapshot
        latest_type = args.type
        print(f"Looking for latest {latest_type} version...")
        latest_version_id = version_manifest.get("latest", {}).get(latest_type)
        if not latest_version_id:
            print(f"Error: Could not find latest {latest_type} version in the manifest.")
            return None, None

        for version in version_manifest.get("versions", []):
            if version.get("id") == latest_version_id:
                return version.get("id"), version.get("url")
        print(f"Error: Details for latest {latest_type} version ID '{latest_version_id}' not found.")
        return None, None

if __name__ == "__main__":
    main()

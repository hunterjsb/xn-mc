
# xn-mc

Welcome to **xn-mc**, a repository dedicated to advanced Minecraft server management and configuration.
Our goal is to leverage **free-tier** cloud resources to improve server performance and stability while decreasing cost.

## Features

- **Server Optimization**: Scripts and configurations to boost server performance.
- **Custom Plugins**: A selection of custom-built plugins for Minecraft servers.
- **Network Management**: Tools for managing and monitoring server networks.

## Getting Started

To get started with **xn-mc**, clone this repository to your local machine:

```bash
git clone https://github.com/hunterjsb/xn-mc.git
```

Navigate to the specific directories for detailed instructions on each tool or script.

### Server Update Script (`scripts/update_server.py`)

This script automates the process of downloading and updating the Minecraft server JAR to the latest release, latest snapshot, or a specific version.

**Usage:**

```bash
python scripts/update_server.py [options]
```

**Options:**

*   `--type {release,snapshot}`: Specify whether to download the latest 'release' (default) or 'snapshot' version.
*   `--version_id <id>`: Download a specific Minecraft version by its ID (e.g., `1.20.4`, `24w03a`). This overrides the `--type` option.
*   `--force`: Force download and update the symlink even if the script detects the current version is already the target version.
*   `-h, --help`: Show the help message and exit.

**How it works:**

1.  Fetches the official Minecraft version manifest to determine available versions.
2.  Based on the provided arguments (or defaults), it selects a target version.
3.  Downloads the server JAR for the target version into the `server/versions/<version_id>/` directory.
4.  Updates the `server/server.jar` symlink to point to the newly downloaded JAR.
    *   If `server/server.jar` was a regular file, it's backed up (e.g., `server/server.jar.old.<timestamp>`) before being replaced by the symlink.
    *   If it was an existing symlink, it's removed and recreated.

The `server/start.sh` script is expected to use `server/server.jar`, so it will automatically use the updated version on the next server start.

## Contribution

Contributions to **xn-mc** are welcome! If you have a feature request, bug report, or a pull request, please feel free to contribute.

1. Fork the repository.
2. Create a new branch (`git checkout -b feature-branch`).
3. Make your changes and commit them (`git commit -am 'Add some feature'`).
4. Push to the branch (`git push origin feature-branch`).
5. Create a new Pull Request.

## License

This project is licensed under the MIT license - see the LICENSE file for details.

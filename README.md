# ani-web

ani-web is a small web interface for [ani-cli](https://github.com/pystardust/ani-cli). It runs locally, keeps track of watched episodes and playback progress, and works on both a Docker host and an Android phone through Termux.

The player runs in the browser, so you can also install the site as a PWA from Chrome.

## Run with Docker

You need Docker with the Compose plugin.

```sh
git clone https://github.com/SkaziBavaria/ani-web.git
cd ani-web
docker compose up -d --build
```

Open [http://localhost:7831](http://localhost:7831).

To update later:

```sh
cd ani-web
git pull --ff-only
docker compose up -d --build
```

Docker stores the database, ani-cli history, logs, and downloaded episodes in the local `data/` directory. Rebuilding or restarting the container does not remove them.

## Run on Android with Termux

Install a current version of Termux from F-Droid or GitHub. The old Play Store build is not supported.

Inside Termux, run:

```sh
pkg install -y curl
curl -fsSL https://raw.githubusercontent.com/SkaziBavaria/ani-web/main/scripts/install-termux.sh | sh
```

The installer adds the required Termux packages, checks Node and SQLite, installs the same pinned and patched ani-cli build used by Docker, and places ani-web in `~/ani-web`.

Start it with:

```sh
ani-web
```

Then open [http://127.0.0.1:7831](http://127.0.0.1:7831) in Chrome. If you want to download episodes to shared storage, run `termux-setup-storage` once and accept Android's permission prompt.

To update the Termux installation, run the installer again. It only fast-forwards a clean checkout and will leave local changes alone.

Android may stop Termux in the background. Setting Termux battery usage to **Unrestricted** usually fixes that. You can also run `termux-wake-lock` while using the server.

## Sync between devices

Library entries, watched episodes, playback positions, SUB/DUB choices, and settings can be synced between installations. Video files, caches, and job logs stay local.

### GitHub

GitHub is the easiest option for local and Termux installations because it does not require a public domain or HTTPS callback.

1. Create a GitHub OAuth App in **GitHub Settings → Developer settings → OAuth Apps**.
2. Use your ani-web address as the homepage. The required callback field can be `http://127.0.0.1` because Device Flow does not use it.
3. Enable **Device Flow** in the OAuth App settings.
4. Copy its Client ID into **Settings → Cloud sync → GitHub** in ani-web.
5. Choose a different device name on each installation, save, and connect.

ani-web creates a private repository named `aniweb-sync-data`. Each device writes its own sync file, and records are merged instead of replacing the complete database. The OAuth `repo` scope is required to create and update a private repository, so only connect an OAuth App you trust.

### Google Drive

Google Drive is also supported, but it requires a Google Cloud OAuth Web client and an authorized HTTPS redirect URI. The exact callback URI is shown in **Settings → Cloud sync → Google Drive**.

## Useful environment variables

- `ANI_WEB_PORT=7832` changes the port.
- `ANI_WEB_HOST=0.0.0.0` exposes the server on the local network. Only do this on a network you trust.
- `ANI_WEB_CLIENT_PLAYBACK=1` forces browser playback.
- `ANI_CLI_BIN=/path/to/ani-cli` selects a different ani-cli executable.
- `ANI_CLI_DOWNLOAD_DIR=/path/to/downloads` changes the download directory.

The native installation requires Node 22.16 or newer. The Docker image includes a compatible Node version and all runtime dependencies.

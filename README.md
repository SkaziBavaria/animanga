# AniManga

Self-hosted anime player and manga reader with library tracking, downloads, cross-device sync, and an installable browser PWA.

## Install with npm

Requires Node.js 22.16+, `curl`, and `ffmpeg` for episode downloads.

```sh
npm install -g animanga
animanga start
```

Open [http://localhost:7831](http://localhost:7831). Data is stored in the platform user-data directory, outside the npm package.

```sh
animanga doctor                  # dependency and config checks
animanga --help                  # flags and environment variables
animanga start --host 0.0.0.0    # LAN access
npm install -g animanga@latest   # update
```

## Run with Docker

Requires the Compose plugin.

```sh
git clone https://github.com/SkaziBavaria/animanga.git
cd animanga
docker compose up -d --build
```

Open [http://localhost:7831](http://localhost:7831), or `http://<host-ip>:7831` on your LAN. Persistent data lives under `data/`.

```sh
git pull --ff-only && docker compose up -d --build   # update
```

### Network access

AniManga is open by default. Set a password before exposing it beyond a trusted device:

```sh
ANIMANGA_ACCESS_TOKEN='use-a-long-random-password' docker compose up -d --build
```

Default username: `animanga`. Password: the access token. Host publish options (`ANIMANGA_BIND_ADDRESS`, `ANIMANGA_PUBLISH_PORT`, and related env vars) are listed in `animanga --help`.

Do not expose AniManga directly to the public internet. Use HTTPS through a trusted reverse proxy when remote access is required.

## Sync between devices

Sync covers libraries, history, progress, archive state, SUB/DUB choices, release watches, and supported settings. Downloads, caches, and job logs stay local.

**GitHub** (no public domain needed): create an OAuth App with Device Flow enabled, enter the Client ID under **Settings → Cloud sync → GitHub**, and connect each device with a unique name. AniManga creates a private `animanga-sync-data` repository and merges per-device files.

**Google Drive**: create a Google Cloud OAuth Web client. AniManga shows the exact callback URI under **Settings → Cloud sync → Google Drive**. Behind a reverse proxy, set `ANIMANGA_PUBLIC_URL` to the public origin.

OAuth secrets and tokens are stored in the local SQLite database — protect the data directory.

## Development

```sh
npm ci
npm run check
npx playwright install chromium && npm run test:e2e
npm run test:smoke:npm
npm run test:smoke:docker
RUN_CONTRACT=1 npm run test:contract   # live providers; slower
```

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
animanga start --host 0.0.0.0    # LAN access
animanga start --data-dir /path  # custom data directory
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

Default username: `animanga`. Password: the access token.

Bind to localhost only with `ANIMANGA_BIND_ADDRESS=127.0.0.1`. Do not expose AniManga directly to the public internet; use HTTPS through a trusted reverse proxy when remote access is required.

## Sync between devices

Sync covers libraries, history, progress, archive state, SUB/DUB choices, release watches, and supported settings. Downloads, caches, and job logs stay local.

**GitHub** (no public domain needed): create an OAuth App with Device Flow enabled, enter the Client ID under **Settings → Cloud sync → GitHub**, and connect each device with a unique name. AniManga creates a private `animanga-sync-data` repository and merges per-device files.

**Google Drive**: create a Google Cloud OAuth Web client. AniManga shows the exact callback URI under **Settings → Cloud sync → Google Drive**. Behind a reverse proxy, set `ANIMANGA_PUBLIC_URL` to the public origin.

OAuth secrets and tokens are stored in the local SQLite database — protect the data directory.

## Configuration

| Variable | Purpose |
| --- | --- |
| `ANIMANGA_HOST` / `ANIMANGA_PORT` | Listen address and port |
| `ANIMANGA_DATA_DIR` / `ANIMANGA_DOWNLOAD_DIR` | Data and download directories |
| `ANIMANGA_ACCESS_TOKEN` / `ANIMANGA_ACCESS_USERNAME` | HTTP Basic auth |
| `ANIMANGA_PUBLIC_URL` | External origin for OAuth callbacks |
| `ANIMANGA_BIND_ADDRESS` / `ANIMANGA_PUBLISH_PORT` | Docker publish interface and port |
| `ANIMANGA_DATA_VOLUME` | Docker host path mounted at `/data` |

Less common environment variables:

- `ANIMANGA_CURL_IMPERSONATE` — curl binary for Cloudflare-challenged providers (Docker already includes one)
- `ANIMANGA_TRUST_PROXY` — trust forwarded headers (requires `ANIMANGA_PUBLIC_URL`)
- `ANIMANGA_PROXY_SECRET` — HMAC secret for signed media proxy URLs
- `ANIMANGA_DOWNLOAD_CONCURRENCY` — episode download parallelism for new installs (1–8)
- `ANIMANGA_CLIENT_PLAYBACK=0` — seed Android MPV playback for new installs
- `ANIMANGA_COMICK_API` / `ANIMANGA_MANGADEX_API` — override provider API origins

If a provider shows a Cloudflare challenge on a native install, install [curl-impersonate](https://github.com/lexiforest/curl-impersonate/releases) and point `ANIMANGA_CURL_IMPERSONATE` at that binary.

## Development

```sh
npm ci
npm run check
npx playwright install chromium && npm run test:e2e
npm run test:smoke:npm
npm run test:smoke:docker
RUN_CONTRACT=1 npm run test:contract   # live providers; slower
```

Contributor architecture and provider rules live in [`AGENTS.md`](AGENTS.md).

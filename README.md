# AniManga

AniManga is a self-hosted anime player and manga reader. Anime and manga metadata, pages, browser playback, and downloads are resolved by the Node server. Episode downloads are written with ffmpeg.

The player runs in the browser, so you can also install the site as a PWA from Chrome.

## Install with npm

You need Node 22.16 or newer. Install ffmpeg as well if you want to download anime episodes; manga downloads do not require it.

```sh
npm install -g animanga
animanga start
```

Open [http://localhost:7831](http://localhost:7831). AniManga stores application data in the platform user-data directory, not inside the global npm package. Run `animanga doctor` to check Node, storage, provider crypto, and optional playback tools.

Useful CLI options:

```sh
animanga start --host 0.0.0.0 --port 7831
animanga start --data-dir /path/to/data
```

The npm package does not install or modify system programs. Browser playback and manga work through the built-in Node adapters. Anime episode downloads use the `ffmpeg` executable available on your system.

To update later:

```sh
npm install -g animanga@latest
```

## Run with Docker

You need Docker with the Compose plugin.

```sh
git clone https://github.com/SkaziBavaria/animanga.git
cd animanga
docker compose up -d --build
```

Open [http://localhost:7831](http://localhost:7831). On your LAN, open `http://<host-ip>:7831` from another device.

Optional password lock:

```sh
ANIMANGA_ACCESS_TOKEN='use-a-long-random-password' docker compose up -d --build
```

To keep the published port on localhost only:

```sh
ANIMANGA_BIND_ADDRESS=127.0.0.1 docker compose up -d --build
```

`ANIMANGA_PUBLISH_PORT` changes the host port if `7831` is already taken.

With a token set, the browser asks for a username and password. The default username is `animanga`; the password is your access token. Do not expose AniManga directly to the public internet. Use HTTPS through a trusted reverse proxy if it must be reachable outside your home network.

To update later:

```sh
cd animanga
git pull --ff-only
docker compose up -d --build
```

Docker stores the database, logs, downloaded episodes, and downloaded manga pages in the local `data/` directory. Rebuilding or restarting the container does not remove them. On the first start of the hardened image, existing files in that directory are assigned to the container's unprivileged `node` user; the application process itself does not run as root. The image includes a healthcheck and ffmpeg.

## Sync between devices

Library entries, watched episodes, playback positions, SUB/DUB choices, and settings can be synced between installations. Video files, caches, and job logs stay local.

### GitHub

GitHub is the easiest option for local installations because it does not require a public domain or HTTPS callback.

1. Create a GitHub OAuth App in **GitHub Settings → Developer settings → OAuth Apps**.
2. Use your AniManga address as the homepage. The required callback field can be `http://127.0.0.1` because Device Flow does not use it.
3. Enable **Device Flow** in the OAuth App settings.
4. Copy its Client ID into **Settings → Cloud sync → GitHub** in AniManga.
5. Choose a different device name on each installation, save, and connect.

AniManga creates a private repository named `animanga-sync-data`. Each device writes its own sync file, and records are merged instead of replacing the complete database. The OAuth `repo` scope is required to create and update a private repository, so only connect an OAuth App you trust.

### Google Drive

Google Drive is also supported, but it requires a Google Cloud OAuth Web client and an authorized HTTPS redirect URI. The exact callback URI is shown in **Settings → Cloud sync → Google Drive**.
When AniManga is reached through a LAN address or reverse proxy, set `ANIMANGA_PUBLIC_URL` to its externally visible origin, for example `https://animanga.example.com`. The OAuth callback is then derived from that fixed origin and cannot be changed through request headers.

OAuth client secrets and access tokens are stored in the local SQLite database. AniManga restricts its data directories, database, backups, history, and job logs to the current operating-system user where the platform supports Unix permissions. Protect the `data/` directory as you would any credential store.

## Useful environment variables

- `ANIMANGA_PORT=7832` changes the port.
- `ANIMANGA_HOST=0.0.0.0` exposes the server on the local network. Only do this on a network you trust.
- `ANIMANGA_ACCESS_TOKEN=...` optional HTTP Basic password. Without it the app stays open on whatever address it listens on. With it set, the browser asks for username/password (default username `animanga`). Mutating API calls also require a same-origin browser request (or a non-browser client) so cross-site forms cannot reuse a cached password.
- `ANIMANGA_ACCESS_USERNAME=animanga` changes the Basic-auth username.
- `ANIMANGA_PUBLIC_URL=https://animanga.example.com` fixes the external origin used for OAuth callbacks.
- `ANIMANGA_TRUST_PROXY=1` accepts forwarded host/protocol headers when a fixed public URL cannot be used. Enable it only behind a trusted reverse proxy that overwrites those headers. `ANIMANGA_PUBLIC_URL` is required when this is set.
- `ANIMANGA_PROXY_SECRET=...` optional HMAC secret for signed `/api/proxy` URLs. Defaults to the access token, or a generated file under the data directory.
- `ANIMANGA_CLIENT_PLAYBACK=0` prefers the Android MPV intent instead of the in-browser player.
- `ANIMANGA_DATA_DIR=/path/to/data` selects the persistent application-data directory.
- `ANIMANGA_DOWNLOAD_DIR=/path/to/downloads` changes the anime episode download directory.

The native installation requires Node 22.16 or newer. The Docker image includes a compatible Node version and all runtime dependencies.

## Development checks

Install the locked development dependencies and run the same static checks and unit tests used by CI:

```sh
npm ci
npm run check
```

For browser tests, install Chromium once and run the E2E suite:

```sh
npx playwright install chromium
npm run test:e2e
```

Install smokes verify the two supported delivery paths:

```sh
npm run test:smoke:npm
npm run test:smoke:docker
```

`RUN_CONTRACT=1 npm run test:contract` runs the slower live-provider checks. They verify current AllAnime/AllManga crypto, manga page decryption, browser playback, byte-range video access, and AniSkip. These checks are scheduled separately because upstream availability is outside AniManga's control.

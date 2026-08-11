# AniManga

AniManga is a self-hosted anime player and manga reader with library tracking, downloads, cross-device sync, and an installable browser PWA.

Anime metadata and streams come from [anidb.app](https://anidb.app). Manga metadata comes from [ComicK](https://comick.dev), while chapter pages use independently verified page resolvers.

## Install with npm

Requirements:

- Node.js 22.16 or newer
- `curl`
- `ffmpeg` for episode downloads

```sh
npm install -g animanga
animanga start
```

Open [http://localhost:7831](http://localhost:7831). Application data is stored in the platform's user-data directory, outside the global npm package.

Run the built-in checks if something does not work:

```sh
animanga doctor
```

AniManga uses ordinary system curl when possible. If a provider presents a Cloudflare challenge, install a compatible binary from [curl-impersonate](https://github.com/lexiforest/curl-impersonate/releases) and place it on `PATH`, or configure it explicitly:

```sh
ANIMANGA_CURL_IMPERSONATE=/path/to/curl_chrome136 animanga start
```

Useful start options:

```sh
animanga start --host 0.0.0.0 --port 7831
animanga start --data-dir /path/to/data
```

The npm package does not install or modify system programs.

### Update an npm installation

```sh
npm install -g animanga@latest
```

## Run with Docker

Docker requires the Compose plugin.

```sh
git clone https://github.com/SkaziBavaria/animanga.git
cd animanga
docker compose up -d --build
```

Open [http://localhost:7831](http://localhost:7831), or use `http://<host-ip>:7831` from another device on your LAN.

Docker stores persistent data under `data/`. Rebuilding or restarting the container does not remove the database or downloads. The image includes ffmpeg, curl-impersonate, and a health check.

### Protect network access

AniManga is open by default. Set a password before exposing it beyond a trusted device:

```sh
ANIMANGA_ACCESS_TOKEN='use-a-long-random-password' docker compose up -d --build
```

The browser then asks for a username and password. The default username is `animanga`, and the password is the access token.

To publish the Docker port only on localhost:

```sh
ANIMANGA_BIND_ADDRESS=127.0.0.1 docker compose up -d --build
```

Do not expose AniManga directly to the public internet. Use HTTPS through a trusted reverse proxy when remote access is required.

### Update a Docker installation

```sh
cd animanga
git pull --ff-only
docker compose up -d --build
```

## Sync between devices

AniManga can sync libraries, watch and reading history, playback positions, archive state, SUB/DUB choices, release watches, and supported settings. Downloads, caches, and job logs remain local.

### GitHub

GitHub sync works without a public domain or HTTPS callback:

1. Create a GitHub OAuth App under **GitHub Settings -> Developer settings -> OAuth Apps**.
2. Use the AniManga address as its homepage. The callback field can be `http://127.0.0.1` because Device Flow does not use it.
3. Enable **Device Flow**.
4. Enter the Client ID under **Settings -> Cloud sync -> GitHub** in AniManga.
5. Give each installation a unique device name, save, and connect.

AniManga creates a private repository named `animanga-sync-data`. Each device writes a separate sync file, and records are merged rather than replacing the complete database. The OAuth `repo` scope is required to create and update that private repository.

### Google Drive

Google Drive sync requires a Google Cloud OAuth Web client and an authorized HTTPS redirect URI. AniManga displays the exact callback URI under **Settings -> Cloud sync -> Google Drive**.

For a reverse proxy, set `ANIMANGA_PUBLIC_URL` to the externally visible origin, such as `https://animanga.example.com`.

OAuth secrets and tokens are stored in the local SQLite database. Protect the AniManga data directory as you would any credential store.

## Configuration

Common settings:

- `ANIMANGA_HOST=0.0.0.0` listens on the local network.
- `ANIMANGA_PORT=7832` changes the application port.
- `ANIMANGA_DATA_DIR=/path/to/data` changes the persistent data directory.
- `ANIMANGA_DOWNLOAD_DIR=/path/to/downloads` changes the episode download directory.
- `ANIMANGA_ACCESS_TOKEN=...` enables HTTP Basic authentication.
- `ANIMANGA_ACCESS_USERNAME=animanga` changes the authentication username.
- `ANIMANGA_PUBLIC_URL=https://animanga.example.com` sets the fixed external origin used for OAuth callbacks.
- `ANIMANGA_DOWNLOAD_CONCURRENCY=2` seeds the episode download limit for new installations (1-8).
- `ANIMANGA_CLIENT_PLAYBACK=0` seeds Android MPV playback for new installations.

Advanced settings:

- `ANIMANGA_CURL_IMPERSONATE=/path/to/curl_chrome136` selects a curl binary.
- `ANIMANGA_TRUST_PROXY=1` trusts forwarded host and protocol headers. This requires `ANIMANGA_PUBLIC_URL` and a trusted proxy that overwrites those headers.
- `ANIMANGA_PROXY_SECRET=...` sets the HMAC secret for signed media proxy URLs.
- `ANIMANGA_ANIDB_ORIGIN=https://anidb.app` overrides the anime provider origin.
- `ANIMANGA_COMICK_API=https://api.comick.dev` overrides the ComicK API origin.
- `ANIMANGA_MANGADEX_API=https://api.mangadex.org` overrides the MangaDex API origin.

Docker also supports:

- `ANIMANGA_BIND_ADDRESS=127.0.0.1` controls the published interface.
- `ANIMANGA_PUBLISH_PORT=7832` changes the published host port.
- `ANIMANGA_DATA_VOLUME=/path/to/data` changes the host directory mounted at `/data`.

## Development

Install locked dependencies and run lint plus unit tests:

```sh
npm ci
npm run check
```

Run browser tests:

```sh
npx playwright install chromium
npm run test:e2e
```

Installation smoke tests:

```sh
npm run test:smoke:npm
npm run test:smoke:docker
```

Live provider contract checks are slower and depend on external availability:

```sh
RUN_CONTRACT=1 npm run test:contract
```

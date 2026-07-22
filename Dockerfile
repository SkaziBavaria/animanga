FROM node:26-bookworm-slim

# Keep the last known compatible upstream script as a stable patch base.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    curl ca-certificates grep sed openssl fzf ffmpeg aria2 \
  && rm -rf /var/lib/apt/lists/*

ADD https://raw.githubusercontent.com/pystardust/ani-cli/cc45a5530af350fb0e1a759e1d962814df5876fe/ani-cli /usr/local/bin/ani-cli
COPY scripts/patch-ani-cli-crypto.js /tmp/patch-ani-cli-crypto.js
COPY lib/mkissa-crypto.js /tmp/mkissa-crypto.js

# Patch aaReq material from live mkissa bootstrap (master ani-cli no longer ships it).
RUN node /tmp/patch-ani-cli-crypto.js /usr/local/bin/ani-cli \
  && sh -n /usr/local/bin/ani-cli \
  && chmod +x /usr/local/bin/ani-cli \
  && rm -f /tmp/patch-ani-cli-crypto.js /tmp/mkissa-crypto.js

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public

ENV ANIMANGA_HOST=0.0.0.0
ENV ANIMANGA_PORT=7831
ENV ANIMANGA_CLIENT_PLAYBACK=1
ENV ANIMANGA_DATA_DIR=/data/app
ENV ANI_CLI_DOWNLOAD_DIR=/data/downloads
ENV ANI_CLI_HIST_DIR=/data/ani-cli

EXPOSE 7831

CMD ["node", "server.js"]

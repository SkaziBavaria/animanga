FROM node:26-bookworm-slim

# Keep the last known compatible upstream script as a stable patch base.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    curl ca-certificates grep sed openssl fzf ffmpeg aria2 \
  && rm -rf /var/lib/apt/lists/*

ADD https://raw.githubusercontent.com/pystardust/ani-cli/cc45a5530af350fb0e1a759e1d962814df5876fe/ani-cli /usr/local/bin/ani-cli
COPY scripts/patch-ani-cli-crypto.js /tmp/patch-ani-cli-crypto.js
COPY lib/mkissa-crypto.js /tmp/mkissa-crypto.js

# Build-time patch as a fallback snapshot when runtime refresh cannot reach mkissa.
RUN node /tmp/patch-ani-cli-crypto.js /usr/local/bin/ani-cli \
  && sh -n /usr/local/bin/ani-cli \
  && chmod +x /usr/local/bin/ani-cli \
  && rm -f /tmp/patch-ani-cli-crypto.js /tmp/mkissa-crypto.js

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public
COPY scripts ./scripts

RUN chmod +x /app/scripts/docker-entrypoint.sh /app/scripts/refresh-ani-cli-crypto.js

ENV ANIMANGA_HOST=0.0.0.0
ENV ANIMANGA_PORT=7831
ENV ANIMANGA_CLIENT_PLAYBACK=1
ENV ANIMANGA_DATA_DIR=/data/app
ENV ANI_CLI_DOWNLOAD_DIR=/data/downloads
ENV ANI_CLI_HIST_DIR=/data/ani-cli
ENV ANI_CLI_BIN=/usr/local/bin/ani-cli

EXPOSE 7831

ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]

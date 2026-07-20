FROM node:26-bookworm-slim

# Keep the last known compatible upstream script as a stable patch base.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    curl ca-certificates grep sed openssl fzf ffmpeg aria2 \
  && rm -rf /var/lib/apt/lists/*

ADD https://raw.githubusercontent.com/pystardust/ani-cli/cc45a5530af350fb0e1a759e1d962814df5876fe/ani-cli /usr/local/bin/ani-cli
ADD https://raw.githubusercontent.com/pystardust/ani-cli/fix/ani-cli /tmp/ani-cli-reference
COPY scripts/patch-ani-cli-crypto.js /tmp/patch-ani-cli-crypto.js

RUN node /tmp/patch-ani-cli-crypto.js /usr/local/bin/ani-cli /tmp/ani-cli-reference \
  && sh -n /usr/local/bin/ani-cli \
  && chmod +x /usr/local/bin/ani-cli \
  && rm -f /tmp/ani-cli-reference /tmp/patch-ani-cli-crypto.js

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public

ENV ANI_WEB_HOST=0.0.0.0
ENV ANI_WEB_PORT=7831
ENV ANI_WEB_CLIENT_PLAYBACK=1
ENV ANI_WEB_DATA_DIR=/data/app
ENV ANI_CLI_DOWNLOAD_DIR=/data/downloads
ENV ANI_CLI_HIST_DIR=/data/ani-cli

EXPOSE 7831

CMD ["node", "server.js"]

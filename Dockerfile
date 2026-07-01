FROM node:20-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    curl ca-certificates grep sed openssl fzf ffmpeg aria2 \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://raw.githubusercontent.com/pystardust/ani-cli/master/ani-cli -o /usr/local/bin/ani-cli \
  && chmod +x /usr/local/bin/ani-cli

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

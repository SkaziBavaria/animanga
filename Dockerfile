FROM node:26-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY public ./public

ENV ANIMANGA_HOST=0.0.0.0
ENV ANIMANGA_PORT=7831
ENV ANIMANGA_CLIENT_PLAYBACK=1
ENV ANIMANGA_DATA_DIR=/data/app
ENV ANIMANGA_DOWNLOAD_DIR=/data/downloads
ENV ANIMANGA_ANI_CLI_FALLBACK=0

EXPOSE 7831

CMD ["node", "server.js"]

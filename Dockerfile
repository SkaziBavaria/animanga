FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates ffmpeg gosu \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --chown=node:node package.json ./
COPY --chown=node:node server.js ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public
COPY --chown=node:node scripts/healthcheck.js ./scripts/healthcheck.js
COPY scripts/docker-entrypoint.sh /usr/local/bin/animanga-entrypoint

RUN chmod 0755 /usr/local/bin/animanga-entrypoint \
  && mkdir -p /data/app /data/downloads \
  && chown -R node:node /app /data

ENV ANIMANGA_HOST=0.0.0.0
ENV ANIMANGA_PORT=7831
ENV ANIMANGA_CLIENT_PLAYBACK=1
ENV ANIMANGA_DATA_DIR=/data/app
ENV ANIMANGA_DOWNLOAD_DIR=/data/downloads
ENV ANIMANGA_ANI_CLI_FALLBACK=0

EXPOSE 7831

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "scripts/healthcheck.js"]

ENTRYPOINT ["animanga-entrypoint"]
CMD ["node", "server.js"]

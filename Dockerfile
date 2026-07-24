FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates ffmpeg \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf \
    /usr/local/lib/node_modules/npm \
    /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm \
    /usr/local/bin/npx \
    /usr/local/bin/corepack \
    /usr/local/bin/yarn \
    /usr/local/bin/yarnpkg

WORKDIR /app

COPY --chown=node:node package.json ./
COPY --chown=node:node server.js ./
COPY --chown=node:node lib ./lib
COPY --chown=node:node public ./public
COPY --chown=node:node scripts/healthcheck.js ./scripts/healthcheck.js
COPY scripts/docker-entrypoint.sh /usr/local/bin/animanga-entrypoint

RUN sed -i 's/\r$//' /usr/local/bin/animanga-entrypoint \
  && chmod 0755 /usr/local/bin/animanga-entrypoint \
  && mkdir -p /data/app /data/downloads \
  && chown -R node:node /app /data

ENV ANIMANGA_HOST=0.0.0.0
ENV ANIMANGA_PORT=7831
ENV ANIMANGA_CLIENT_PLAYBACK=1
ENV ANIMANGA_INSTALL=docker
ENV ANIMANGA_DATA_DIR=/data/app
ENV ANIMANGA_DOWNLOAD_DIR=/data/downloads

EXPOSE 7831

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "scripts/healthcheck.js"]

ENTRYPOINT ["animanga-entrypoint"]
CMD ["node", "server.js"]

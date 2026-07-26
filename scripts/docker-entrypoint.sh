#!/bin/sh
set -eu

mkdir -p /data/app /data/downloads

if [ ! -f /data/.animanga-node-owner ]; then
  chown -R node:node /data
  touch /data/.animanga-node-owner
  chown node:node /data/.animanga-node-owner
fi

# setpriv keeps the root entrypoint environment; drop HOME so child spawns
# (ffmpeg downloads use cwd=homedir) are not blocked by /root permissions.
export HOME=/home/node
export USER=node
export LOGNAME=node

exec setpriv --reuid=node --regid=node --init-groups -- "$@"

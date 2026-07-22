#!/bin/sh
set -eu

mkdir -p /data/app /data/downloads

if [ ! -f /data/.animanga-node-owner ]; then
  chown -R node:node /data
  touch /data/.animanga-node-owner
  chown node:node /data/.animanga-node-owner
fi

exec gosu node "$@"

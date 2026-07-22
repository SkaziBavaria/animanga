#!/bin/sh
set -eu
cd /app
# Best-effort live aaReq refresh so Docker build-cache cannot pin stale crypto forever.
node scripts/refresh-ani-cli-crypto.js || printf 'ani-cli crypto refresh warning: continuing with previous file\n' >&2
exec node server.js

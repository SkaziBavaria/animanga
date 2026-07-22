#!/data/data/com.termux/files/usr/bin/sh
SCRIPT_PATH="$(readlink -f "$0" 2>/dev/null || printf '%s' "$0")"
cd "$(dirname "$SCRIPT_PATH")" || exit 1
export ANIMANGA_CLIENT_PLAYBACK="${ANIMANGA_CLIENT_PLAYBACK:-${ANI_WEB_CLIENT_PLAYBACK:-1}}"
exec node server.js

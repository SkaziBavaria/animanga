'use strict';

const { commandExists } = require('./process');

function clientPlaybackEnabled() {
  // Browser playback is the default everywhere. Set ANIMANGA_CLIENT_PLAYBACK=0
  // to prefer the Android MPV intent when Activity Manager is available.
  return process.env.ANIMANGA_CLIENT_PLAYBACK !== '0';
}

function resolvePlaybackMode(body) {
  const browserPlayer = body.player === 'android_mpv'
    || body.player === 'vlc'
    || !body.player
    || body.player === 'default';
  const useBrowserPlayback = !body.download && (
    body.clientPlayback
    || body.resolveOnly
    || browserPlayer && (clientPlaybackEnabled() || commandExists('am'))
  );
  return { useBrowserPlayback };
}

module.exports = {
  clientPlaybackEnabled,
  resolvePlaybackMode,
};

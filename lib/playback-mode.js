'use strict';

const { commandExists } = require('./process');

function clientPlaybackEnabled() {
  const setting = process.env.ANIMANGA_CLIENT_PLAYBACK;
  if (setting === '0') return false;
  if (setting === '1') return true;
  return !commandExists('am');
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

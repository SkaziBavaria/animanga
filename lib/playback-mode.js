'use strict';

const { commandExists } = require('./process');

function clientPlaybackEnabled() {
  // Prefer the live Settings value. Env ANIMANGA_CLIENT_PLAYBACK only seeds the
  // default for fresh installs (see defaultSettings).
  try {
    const { readState } = require('./state');
    const setting = readState().settings?.clientPlayback;
    if (typeof setting === 'boolean') return setting;
  } catch {}
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

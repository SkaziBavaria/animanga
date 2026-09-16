'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

async function loadHlsPlayer() {
  const source = fs.readFileSync(path.join(__dirname, '../../public/js/hls-player.js'), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

test('detects HiAnime proxy playlists as HLS', async () => {
  const { isHlsPlaybackUrl } = await loadHlsPlayer();
  assert.equal(isHlsPlaybackUrl('https://cdn.example/1080/index.m3u8'), true);
  assert.equal(
    isHlsPlaybackUrl('/api/proxy?url=https%3A%2F%2Fcdn.example%2F1080%2Findex.m3u8&referrer=https%3A%2F%2Fzokoanime.video%2F'),
    true,
  );
  assert.equal(isHlsPlaybackUrl('/e2e-blank.mp4'), false);
});

test('browser HLS options keep in-band captions off so sidecar English can win', async () => {
  const { browserHlsOptions, disableNativeVideoTextTracks } = await loadHlsPlayer();
  assert.equal(browserHlsOptions().enableCEA708Captions, false);
  assert.equal(browserHlsOptions().enableWebVTT, false);
  assert.equal(browserHlsOptions().subtitleDisplay, false);
  const tracks = [{ mode: 'showing' }, { mode: 'hidden' }];
  disableNativeVideoTextTracks({ textTracks: tracks });
  assert.deepEqual(tracks.map((track) => track.mode), ['disabled', 'disabled']);
});

test('Chrome uses MSE HLS while Safari can keep native playback', async () => {
  const { hlsPlaybackStrategy } = await loadHlsPlayer();
  const proxy = '/api/proxy?url=https%3A%2F%2Fcdn.example%2Findex.m3u8';
  assert.equal(hlsPlaybackStrategy({
    url: proxy,
    sourceUrl: 'https://cdn.example/index.m3u8',
    canPlayNativeHls: false,
    mseHlsSupported: true,
  }), 'mse');
  assert.equal(hlsPlaybackStrategy({
    url: proxy,
    sourceUrl: 'https://cdn.example/index.m3u8',
    canPlayNativeHls: true,
    mseHlsSupported: true,
  }), 'mse');
  assert.equal(hlsPlaybackStrategy({
    url: proxy,
    sourceUrl: 'https://cdn.example/index.m3u8',
    canPlayNativeHls: true,
    mseHlsSupported: false,
  }), 'native');
  assert.equal(hlsPlaybackStrategy({
    url: '/e2e-blank.mp4',
    sourceUrl: '/e2e-blank.mp4',
    canPlayNativeHls: false,
    mseHlsSupported: true,
  }), 'progressive');
  assert.equal(hlsPlaybackStrategy({
    url: proxy,
    sourceUrl: 'https://cdn.example/index.m3u8',
    canPlayNativeHls: false,
    mseHlsSupported: false,
  }), 'unsupported');
});

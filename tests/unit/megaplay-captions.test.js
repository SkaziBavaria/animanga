'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseMegaplayPlayerId,
  mapMegaplayCaptionTracks,
  fetchMegaplayCaptionConfig,
} = require('../../lib/megaplay-captions');

test('MegaPlay player id is read from the player node only', () => {
  assert.equal(parseMegaplayPlayerId('<div data-id="wrong"></div><div id="megaplay-player" data-id="abc123"></div>'), 'abc123');
  assert.equal(parseMegaplayPlayerId('<div data-id="ok456" id="megaplay-player"></div>'), 'ok456');
  assert.equal(parseMegaplayPlayerId('<div id="megaplay-player" data-id="bad id"></div>'), '');
});

test('MegaPlay caption mapping keeps caption files and drops thumbnails', () => {
  assert.deepEqual(mapMegaplayCaptionTracks([
    { file: 'https://cdn.example/en.vtt', label: 'English (CR)', kind: 'captions', default: true },
    { file: 'https://cdn.example/thumbs.vtt', kind: 'thumbnails' },
    { label: 'English' },
  ]), [{
    src: 'https://cdn.example/en.vtt',
    lang: undefined,
    label: 'English (CR)',
    default: true,
  }]);
});

test('MegaPlay caption fetch uses getSources tracks and ignores enc', async () => {
  const urls = [];
  const fetchText = async (url) => {
    urls.push(String(url).replace(/^https?:\/\/[^/]+/, 'origin'));
    if (String(url).includes('/stream/getSources')) {
      return JSON.stringify({
        enc: 'unused-ciphertext',
        tracks: [
          { file: 'https://cdn.example/en.vtt', label: 'English (CR)', kind: 'captions', default: true },
        ],
      });
    }
    return '<div id="megaplay-player" data-id="abc123"></div>';
  };
  const config = await fetchMegaplayCaptionConfig('https://player.example/e/s-2/x/sub', { fetchText });
  assert.deepEqual(config, {
    subtitles: [{
      src: 'https://cdn.example/en.vtt',
      lang: undefined,
      label: 'English (CR)',
      default: true,
    }],
    baseUrl: 'https://player.example',
    referrer: 'https://player.example/',
  });
  assert.deepEqual(urls, [
    'origin/e/s-2/x/sub',
    'origin/stream/getSources?id=abc123',
  ]);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveEpisodePlayback,
  selectQuality,
  setFetchForTests,
} = require('../../lib/anime-resolver');

test.afterEach(() => setFetchForTests(null));

test('selectQuality uses exact, lower, best and worst quality choices', () => {
  const links = [1080, 720, 480].map((quality) => ({ url: `https://cdn.example/${quality}.mp4`, quality }));
  assert.equal(selectQuality(links, 'best').quality, 1080);
  assert.equal(selectQuality(links, 'worst').quality, 480);
  assert.equal(selectQuality(links, '720p').quality, 720);
  assert.equal(selectQuality(links, '900').quality, 720);
});

test('resolveEpisodePlayback follows anidb episode -> languages -> embed -> m3u8', async () => {
  setFetchForTests(async (url) => {
    const value = String(url);
    if (value.includes('/api/frontend/anime/21/episodes')) {
      return JSON.stringify([{ id: 55, number: 1 }]);
    }
    if (value.includes('/api/frontend/episode/55/languages')) {
      return JSON.stringify([{ lang: 'jpn', embed_url: 'https://embed.example/player' }]);
    }
    if (value.includes('embed.example/player')) {
      return "player.setup({ file: 'https://cdn.example/master.m3u8' });";
    }
    if (value.includes('cdn.example/master.m3u8')) {
      return [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:RESOLUTION=1280x720',
        'https://cdn.example/720.m3u8',
        '#EXT-X-STREAM-INF:RESOLUTION=1920x1080',
        'https://cdn.example/1080.m3u8',
      ].join('\n');
    }
    throw new Error(`unexpected url ${value}`);
  });

  const playback = await resolveEpisodePlayback({
    showId: 'one-piece-21',
    episode: '1',
    mode: 'sub',
    quality: 'best',
  });
  assert.equal(playback.url, 'https://cdn.example/1080.m3u8');
  assert.equal(playback.provider, 'anidb');
  assert.equal(playback.quality, 1080);
});

test('resolveEpisodePlayback fails clearly when dub language is missing', async () => {
  setFetchForTests(async (url) => {
    const value = String(url);
    if (value.includes('/episodes')) return JSON.stringify([{ id: 9, number: 1 }]);
    if (value.includes('/languages')) return JSON.stringify([{ lang: 'jpn', embed_url: 'https://embed.example/sub' }]);
    throw new Error(`unexpected url ${value}`);
  });
  await assert.rejects(
    () => resolveEpisodePlayback({ showId: 'demo-1', episode: 1, mode: 'dub' }),
    /No dub sources/
  );
});

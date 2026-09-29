'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveEpisodePlayback, parseSupportedServers } = require('../../lib/hianime');
const { decodeMegaplaySource } = require('../../lib/megaplay');
const { setTextFetcherForTests } = require('../../lib/web-fetch');

const ENCRYPTED_SOURCE = 'wdeBruh3qqn_i5wUNnyaPTy540Ur0tbBB1G9Xpgdcf9YNX2zSoI83maMzsZHuxzs';
const MASTER = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1920x1080\n1080.m3u8\n';

test.afterEach(() => setTextFetcherForTests(null));

function server(name, mode = 'sub', host = 'player.example') {
  const hash = Buffer.from(`https://${host}/embed/episode`).toString('base64');
  return `<div class="server-item" data-type="${mode}" data-server-name="${name}" data-hash="${hash}"></div>`;
}

function fixtures({ servers = server('Vidstream-2'), zokoFails = false, slug = 'example-1', payload, playlist = MASTER } = {}) {
  const requests = [];
  setTextFetcherForTests(async (url, options) => {
    requests.push(url);
    const parsed = new URL(url);
    if (parsed.pathname === '/api/theme/episode/list/1') {
      return JSON.stringify({ html: `<a class="ep-item" data-number="1" data-id="10" href="/watch/${slug}?ep=10"></a>` });
    }
    if (parsed.pathname === '/api/theme/episode/servers') return JSON.stringify({ html: servers });
    if (parsed.hostname === 'zoko.example') {
      if (zokoFails) throw new Error('Zoko unavailable');
      const json = Buffer.from(JSON.stringify({ src: 'https://zoko-video.example/master.m3u8' }));
      const key = Buffer.from('otaku-embed-v1');
      const blob = Buffer.from(json.map((byte, i) => byte ^ key[i % key.length])).toString('base64');
      return `window.__P="${blob}"`;
    }
    if (parsed.pathname === '/embed/episode') return '<div id="megaplay-player" data-id="fixture"></div>';
    if (parsed.pathname === '/stream/getSources') {
      assert.equal(parsed.searchParams.get('id'), 'fixture');
      assert.equal(options.headers.Referer, 'https://player.example/embed/episode');
      assert.equal(options.headers['X-Requested-With'], 'XMLHttpRequest');
      return JSON.stringify(payload || {
        enc: ENCRYPTED_SOURCE,
        tracks: [{ file: 'https://captions.example/en.vtt', label: 'English', kind: 'captions', default: true }],
      });
    }
    if (parsed.pathname === '/master.m3u8') {
      assert.equal(options.headers.Referer, parsed.hostname === 'zoko-video.example' ? 'https://zoko.example/' : 'https://player.example/');
      return playlist;
    }
    throw new Error('Unexpected fixture request');
  });
  return requests;
}

const play = (mode = 'sub') => resolveEpisodePlayback({ showId: 'example-1', episode: '1', mode });

test('Vidstream-2 plays when Zoko is absent, preserving quality and captions', async () => {
  const requests = fixtures();
  const result = await play();
  assert.equal(result.server, 'Vidstream-2');
  assert.equal(result.url, 'https://video.example/1080.m3u8');
  assert.equal(result.quality, 1080);
  assert.equal(result.referrer, 'https://player.example/');
  assert.equal(result.subtitle, 'https://captions.example/en.vtt');
  assert.equal(result.subtitleTracks.length, 1);
  assert.equal(requests.filter(url => url.includes('/stream/getSources')).length, 1);
});

test('Zoko stays first even when Vidstream-2 is listed first', async () => {
  const requests = fixtures({ servers: server('Vidstream-2') + server('ZokoAnime', 'sub', 'zoko.example') });
  const result = await play();
  assert.equal(result.server, 'ZokoAnime');
  assert.equal(result.url, 'https://zoko-video.example/1080.m3u8');
  assert.ok(!requests.includes('https://video.example/master.m3u8'));
});

test('a failed Zoko falls back without fetching MegaPlay captions and sources twice', async () => {
  const requests = fixtures({ servers: server('ZokoAnime', 'sub', 'zoko.example') + server('Vidstream-2'), zokoFails: true });
  assert.equal((await play()).server, 'Vidstream-2');
  assert.equal(requests.filter(url => url.includes('/stream/getSources')).length, 1);
  assert.equal(requests.filter(url => url === 'https://player.example/embed/episode').length, 1);
});

test('Vidstream-2 does not cross language boundaries', async () => {
  const requests = fixtures({ servers: server('Vidstream-2', 'dub') });
  await assert.rejects(play(), /No sub HiAnime source/);
  assert.ok(!requests.some(url => url.includes('player.example')));
  assert.equal((await play('dub')).server, 'Vidstream-2');
});

test('wrong-title episodes fail before requesting any player', async () => {
  const requests = fixtures({ slug: 'other-title-1' });
  await assert.rejects(play(), /has no HiAnime sources/);
  assert.equal(requests.length, 1);
});

test('invalid source envelopes fail without exposing their contents', async () => {
  const requests = fixtures({ payload: { enc: 'private-invalid-payload' } });
  await assert.rejects(play(), { message: 'Vidstream-2 returned invalid source configuration' });
  assert.ok(!requests.some(url => url.includes('video.example')));
});

test('fallback rejects non-playlists and empty playlists', async () => {
  for (const playlist of ['<html>error</html>', '#EXTM3U\n']) {
    fixtures({ playlist });
    await assert.rejects(play(), /invalid playlist|empty playlist/);
  }
});

test('fallback accepts media playlists without variants or subtitle tracks', async () => {
  fixtures({ payload: { enc: ENCRYPTED_SOURCE }, playlist: '#EXTM3U\n#EXTINF:6,\nsegment.ts\n#EXT-X-ENDLIST\n' });
  const result = await play();
  assert.equal(result.url, 'https://video.example/master.m3u8');
  assert.equal(result.quality, null);
  assert.equal(result.subtitle, undefined);
});

test('the ordered server chain is bounded and excludes unknown players', () => {
  const html = server('HD-1') + server('Vidstream-2').repeat(5) + server('ZokoAnime').repeat(7);
  assert.deepEqual(parseSupportedServers(html, 'sub').map(s => s.name), [
    'ZokoAnime', 'ZokoAnime', 'ZokoAnime', 'ZokoAnime', 'Vidstream-2', 'Vidstream-2',
  ]);
});

test('MegaPlay source decoder accepts its observed envelope and rejects invalid URLs', () => {
  assert.equal(decodeMegaplaySource({ enc: ENCRYPTED_SOURCE }), 'https://video.example/master.m3u8');
  assert.equal(decodeMegaplaySource({ sources: { file: 'https://video.example/master.m3u8' } }), 'https://video.example/master.m3u8');
  for (const file of ['javascript:alert(1)', 'https://user:password@video.example/a.m3u8', '/relative.m3u8', 'https://video.example/error.html']) {
    assert.throws(() => decodeMegaplaySource({ sources: { file } }), /invalid playlist URL/);
  }
});

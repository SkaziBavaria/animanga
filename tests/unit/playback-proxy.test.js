'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { withPlaybackProxies } = require('../../lib/routes/playback');

test('playback proxies both the stream and sidecar subtitle with the same referrer', () => {
  const playback = withPlaybackProxies({
    url: 'https://cdn.example/1080.m3u8',
    subtitle: 'https://cdn.example/en.vtt',
    referrer: 'https://player.example/',
    provider: 'hianime',
  });
  const stream = new URL(playback.proxyUrl, 'http://local.invalid').searchParams;
  const captions = new URL(playback.subtitleProxyUrl, 'http://local.invalid').searchParams;
  assert.equal(stream.get('url'), 'https://cdn.example/1080.m3u8');
  assert.equal(captions.get('url'), 'https://cdn.example/en.vtt');
  assert.equal(stream.get('referrer'), 'https://player.example/');
  assert.equal(captions.get('referrer'), 'https://player.example/');
  assert.ok(stream.get('sig'));
  assert.ok(captions.get('sig'));
});

test('playback proxies sidecar captions with a dedicated subtitle referrer', () => {
  const playback = withPlaybackProxies({
    url: 'https://cdn.example/1080.m3u8',
    subtitle: 'https://captions.example/en.vtt',
    referrer: 'https://video-player.example/',
    subtitleReferrer: 'https://caption-player.example/',
    provider: 'hianime',
  });
  const stream = new URL(playback.proxyUrl, 'http://local.invalid').searchParams;
  const captions = new URL(playback.subtitleProxyUrl, 'http://local.invalid').searchParams;
  assert.equal(stream.get('referrer'), 'https://video-player.example/');
  assert.equal(captions.get('referrer'), 'https://caption-player.example/');
  assert.equal(captions.get('url'), 'https://captions.example/en.vtt');
});

test('playback omits subtitle proxy when the provider did not return captions', () => {
  const playback = withPlaybackProxies({
    url: 'https://cdn.example/1080.m3u8',
    referrer: 'https://player.example/',
  });
  assert.equal(playback.subtitleProxyUrl, undefined);
});

test('playback proxies every caption track and selects the catalog default', () => {
  const playback = withPlaybackProxies({
    url: 'https://cdn.example/1080.m3u8',
    referrer: 'https://player.example/',
    subtitle: 'https://cdn.example/es.vtt',
    subtitleTracks: [
      { src: 'https://cdn.example/es.vtt', lang: 'es', label: 'Spanish', referrer: 'https://caption-player.example/' },
      { src: 'https://cdn.example/en.vtt', lang: 'en', label: 'English', default: true, referrer: 'https://caption-player.example/' },
    ],
  });
  assert.equal(playback.subtitle, undefined);
  assert.equal(playback.subtitleTracks.length, 2);
  assert.equal(playback.subtitleLabel, 'English');
  assert.equal(playback.subtitleLang, 'en');
  const selected = new URL(playback.subtitleProxyUrl, 'http://local.invalid').searchParams;
  assert.equal(selected.get('url'), 'https://cdn.example/en.vtt');
  assert.equal(selected.get('referrer'), 'https://caption-player.example/');
  assert.equal(playback.subtitleTracks[0].src, undefined);
  assert.equal(new URL(playback.subtitleTracks[1].subtitleProxyUrl, 'http://local.invalid').searchParams.get('url'), 'https://cdn.example/en.vtt');
});

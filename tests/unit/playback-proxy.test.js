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

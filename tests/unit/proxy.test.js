'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isPrivateIp, parseProxyTarget, pinnedRequestOptions, resolvePublicTarget, rewriteM3u8 } = require('../../lib/proxy');

test('parseProxyTarget accepts http and https urls', () => {
  assert.equal(parseProxyTarget('https://cdn.example.com/video.mp4'), 'https://cdn.example.com/video.mp4');
  assert.equal(parseProxyTarget('http://cdn.example.com/video.mp4'), 'http://cdn.example.com/video.mp4');
});

test('parseProxyTarget rejects unsupported schemes and private hosts', () => {
  assert.throws(() => parseProxyTarget('file:///etc/passwd'), /http or https/);
  assert.throws(() => parseProxyTarget('http://localhost:8080/video.mp4'), /private host/);
  assert.throws(() => parseProxyTarget('http://127.0.0.1/video.mp4'), /private host/);
  assert.throws(() => parseProxyTarget('http://192.168.1.10/video.mp4'), /private host/);
  assert.throws(() => parseProxyTarget('http://[::1]/video.mp4'), /private host/);
  assert.throws(() => parseProxyTarget('http://[::ffff:7f00:1]/video.mp4'), /private host/);
  assert.throws(() => parseProxyTarget('https://user:pass@example.com/video.mp4'), /credentials/);
});

test('recognizes non-public IPv4 and IPv6 ranges', () => {
  for (const address of ['10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.1.2', '172.16.0.1', '192.168.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) {
    assert.equal(isPrivateIp(address), true, address);
  }
  assert.equal(isPrivateIp('1.1.1.1'), false);
  assert.equal(isPrivateIp('2606:4700:4700::1111'), false);
});

test('rejects hostnames when any resolved address is private', async () => {
  await assert.rejects(
    resolvePublicTarget('https://video.example/file.mp4', async () => [
      { address: '203.0.114.10', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]),
    /resolves to a private address/
  );
});

test('pins a validated public DNS result', async () => {
  const target = await resolvePublicTarget('https://video.example/file.mp4', async () => [
    { address: '203.0.114.10', family: 4 },
  ]);
  assert.equal(target.url.href, 'https://video.example/file.mp4');
  assert.equal(target.address, '203.0.114.10');
  assert.equal(target.family, 4);
});

test('connects directly to the validated address while preserving TLS and HTTP routing', () => {
  const signal = new AbortController().signal;
  const options = pinnedRequestOptions({
    url: new URL('https://video.example:8443/media/file.mp4?quality=720'),
    address: '203.0.114.10',
    family: 4,
  }, { Range: 'bytes=0-99' }, signal);
  assert.equal(options.hostname, '203.0.114.10');
  assert.equal(options.port, '8443');
  assert.equal(options.path, '/media/file.mp4?quality=720');
  assert.equal(options.headers.Host, 'video.example:8443');
  assert.equal(options.servername, 'video.example');
  assert.equal(options.signal, signal);
  assert.equal('lookup' in options, false);
});

test('rewriteM3u8 rewrites relative segment URIs through the proxy', () => {
  const playlist = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXTINF:10.0,',
    'segment0.ts',
    '#EXTINF:10.0,',
    '../media/segment1.ts',
  ].join('\n');
  const mockProxy = (url, referrer) => `/api/proxy?url=${encodeURIComponent(url)}&referrer=${encodeURIComponent(referrer)}`;
  const out = rewriteM3u8(
    playlist,
    'https://cdn.example/hls/master.m3u8',
    'https://embed.example/',
    mockProxy,
  );
  assert.match(out, /\/api\/proxy\?url=https%3A%2F%2Fcdn\.example%2Fhls%2Fsegment0\.ts/);
  assert.match(out, /\/api\/proxy\?url=https%3A%2F%2Fcdn\.example%2Fmedia%2Fsegment1\.ts/);
  assert.match(out, /referrer=https%3A%2F%2Fembed\.example%2F/);
  assert.match(out, /^#EXTINF:10\.0,$/m);
});

test('rewriteM3u8 rewrites absolute segment URIs through the proxy', () => {
  const playlist = [
    '#EXTM3U',
    '#EXTINF:6.0,',
    'https://other-cdn.example/streams/seg-001.ts',
  ].join('\n');
  const mockProxy = (url) => `[proxy:${url}]`;
  const out = rewriteM3u8(playlist, 'https://cdn.example/master.m3u8', 'https://ref.example/', mockProxy);
  assert.equal(out.split('\n').pop(), '[proxy:https://other-cdn.example/streams/seg-001.ts]');
});

test('rewriteM3u8 rewrites URI attributes in HLS tags', () => {
  const playlist = [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=AES-128,URI="enc.key"',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",URI="audio/en.m3u8"',
    '#EXTINF:4.0,',
    'seg.ts',
  ].join('\n');
  const mockProxy = (url) => `[proxy:${url}]`;
  const out = rewriteM3u8(playlist, 'https://cdn.example/live/playlist.m3u8', 'https://ref.example/', mockProxy);
  assert.match(out, /URI="\[proxy:https:\/\/cdn\.example\/live\/enc\.key\]"/);
  assert.match(out, /URI="\[proxy:https:\/\/cdn\.example\/live\/init\.mp4\]"/);
  assert.match(out, /URI="\[proxy:https:\/\/cdn\.example\/live\/audio\/en\.m3u8\]"/);
  assert.match(out, /^\[proxy:https:\/\/cdn\.example\/live\/seg\.ts\]$/m);
});

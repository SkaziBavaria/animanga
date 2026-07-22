'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isPrivateIp, parseProxyTarget, resolvePublicTarget } = require('../../lib/proxy');

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

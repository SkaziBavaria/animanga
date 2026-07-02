'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseProxyTarget } = require('../../lib/proxy');

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
});

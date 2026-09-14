'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

async function loadCaptions() {
  const source = fs.readFileSync(path.join(__dirname, '../../public/js/captions.js'), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

test('sidecar captions use the signed proxy path, not a remote subtitle URL', async () => {
  const { sidecarSubtitleSrc, sidecarTrackProps } = await loadCaptions();
  assert.equal(sidecarSubtitleSrc({
    subtitle: 'https://cdn.example/en.vtt',
    subtitleProxyUrl: '/api/proxy?url=https%3A%2F%2Fcdn.example%2Fen.vtt',
  }), '/api/proxy?url=https%3A%2F%2Fcdn.example%2Fen.vtt');
  assert.equal(sidecarSubtitleSrc({ subtitle: 'https://cdn.example/en.vtt' }), '');
  assert.deepEqual(sidecarTrackProps({
    subtitleProxyUrl: '/api/proxy?url=https%3A%2F%2Fcdn.example%2Fen.vtt',
    subtitleLang: 'en',
    subtitleLabel: 'English',
  }), {
    kind: 'subtitles',
    srclang: 'en',
    label: 'English',
    src: '/api/proxy?url=https%3A%2F%2Fcdn.example%2Fen.vtt',
    default: true,
  });
  assert.equal(sidecarTrackProps({}), null);
});

test('WebVTT parser reads minute-second cues and strips markup', async () => {
  const { parseWebVtt, activeCueText } = await loadCaptions();
  const cues = parseWebVtt('WEBVTT\r\n\r\n00:03.950 --> 00:05.500\r\n<b>Hello there</b>\r\n\r\n00:06.830 --> 00:10.160\r\nNext line\r\n');
  assert.equal(cues.length, 2);
  assert.equal(cues[0].start, 3.95);
  assert.equal(cues[0].end, 5.5);
  assert.equal(activeCueText(cues, 4.2), 'Hello there');
  assert.equal(activeCueText(cues, 6), '');
  assert.equal(activeCueText(cues, 7), 'Next line');
});

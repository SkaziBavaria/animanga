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

test('playback caption tracks use the catalog default and keep a signed list', async () => {
  const { playbackCaptionTracks, selectedCaptionTrackId, captionTrackById, CAPTION_TRACK_OFF } = await loadCaptions();
  const tracks = playbackCaptionTracks({
    subtitleTracks: [
      {
        id: 'c0',
        lang: 'es',
        label: 'Spanish',
        subtitleProxyUrl: '/api/proxy?url=https%3A%2F%2Fcdn.example%2Fes.vtt',
      },
      {
        id: 'c1',
        lang: 'en',
        label: 'English',
        default: true,
        subtitleProxyUrl: '/api/proxy?url=https%3A%2F%2Fcdn.example%2Fen.vtt',
      },
    ],
  });
  assert.equal(selectedCaptionTrackId(tracks), 'c1');
  assert.equal(captionTrackById(tracks, 'c0').label, 'Spanish');
  assert.equal(captionTrackById(tracks, CAPTION_TRACK_OFF), null);
  assert.deepEqual(playbackCaptionTracks({
    subtitleProxyUrl: '/api/proxy?url=https%3A%2F%2Fcdn.example%2Fen.vtt',
    subtitleLang: 'en',
    subtitleLabel: 'English',
  }), [{
    id: 'c0',
    lang: 'en',
    label: 'English',
    default: true,
    subtitleProxyUrl: '/api/proxy?url=https%3A%2F%2Fcdn.example%2Fen.vtt',
  }]);
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
  const { cuePlainText } = await loadCaptions();
  assert.equal(cuePlainText('<b>Hi</b> &amp; <i>there</i>'), 'Hi & there');
  assert.equal(cuePlainText('<script'), 'script');
  assert.doesNotMatch(cuePlainText('<script'), /[<>]/);
  assert.equal(cuePlainText('A &amp;lt; B'), 'A &lt; B');
});

test('caption overlay sits on the picture in portrait letterbox instead of the bottom black bar', async () => {
  const { captionOverlayLayout } = await loadCaptions();
  const portrait = captionOverlayLayout({
    stageWidth: 390,
    stageHeight: 844,
    videoLeft: 0,
    videoTop: 0,
    videoWidth: 390,
    videoHeight: 844,
    mediaWidth: 1920,
    mediaHeight: 1080,
    controlsVisible: true,
  });
  assert.ok(portrait.bottom > 250);
  assert.ok(portrait.bottom < 400);
  const landscape = captionOverlayLayout({
    stageWidth: 844,
    stageHeight: 390,
    videoLeft: 0,
    videoTop: 0,
    videoWidth: 844,
    videoHeight: 390,
    mediaWidth: 1920,
    mediaHeight: 1080,
    controlsVisible: true,
  });
  assert.equal(landscape.bottom, 72);
  const portraitPicture = 390 / (1920 / 1080);
  const landscapePicture = 390;
  assert.equal(portrait.fontSize, Math.round(portraitPicture * 0.11));
  assert.equal(landscape.fontSize, Math.round(landscapePicture * 0.11));
  assert.ok(Math.abs(portrait.fontSize / portraitPicture - landscape.fontSize / landscapePicture) < 0.005);
  const { captionFontSizeFromPicture } = await loadCaptions();
  assert.equal(captionFontSizeFromPicture(540), 56);
  assert.equal(captionFontSizeFromPicture(1080), 56);
});

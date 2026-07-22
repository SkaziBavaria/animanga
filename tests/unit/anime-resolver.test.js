'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  decodeSourceUrl,
  collectClockLinks,
  selectQuality,
  resolveMp4Upload,
  setFetchForTests,
} = require('../../lib/anime-resolver');

function encodeSourceUrl(value) {
  return `--${Buffer.from(value).toString('hex').match(/../g).map((pair) => (Number.parseInt(pair, 16) ^ 0x38).toString(16).padStart(2, '0')).join('')}`;
}

test.afterEach(() => setFetchForTests(null));

test('decodes AllAnime XOR source paths and adds the clock JSON suffix', () => {
  assert.equal(decodeSourceUrl(encodeSourceUrl('/apivtwo/clock?id=abc')), '/apivtwo/clock.json?id=abc');
  assert.equal(decodeSourceUrl('https://cdn.example/video.mp4'), 'https://cdn.example/video.mp4');
});

test('collects playable links and inherited referrers from clock payloads', () => {
  const links = [];
  collectClockLinks({
    Referer: 'https://embed.example/',
    links: [
      { link: 'https://cdn.example/720.mp4', resolutionStr: '720' },
      { hls: true, url: 'https://cdn.example/master.m3u8', hardsub_lang: 'en-US' },
    ],
  }, links);
  assert.deepEqual(links.map((link) => ({ url: link.url, quality: link.quality, referrer: link.referrer })), [
    { url: 'https://cdn.example/720.mp4', quality: 720, referrer: 'https://embed.example/' },
    { url: 'https://cdn.example/master.m3u8', quality: null, referrer: 'https://embed.example/' },
  ]);
});

test('selectQuality uses exact, lower, best and worst quality choices', () => {
  const links = [1080, 720, 480].map((quality) => ({ url: `https://cdn.example/${quality}.mp4`, quality }));
  assert.equal(selectQuality(links, 'best').quality, 1080);
  assert.equal(selectQuality(links, 'worst').quality, 480);
  assert.equal(selectQuality(links, '720p').quality, 720);
  assert.equal(selectQuality(links, '900').quality, 720);
});

test('extracts the direct MP4 URL from Mp4Upload HTML', async () => {
  setFetchForTests(async () => ({
    ok: true,
    text: async () => '<script>player({ src: "https://cdn.example/video.mp4" })</script>',
  }));
  assert.deepEqual(await resolveMp4Upload('https://mp4upload.com/embed-test.html'), [{
    url: 'https://cdn.example/video.mp4',
    quality: null,
    referrer: 'https://www.mp4upload.com',
    provider: 'Mp4Upload',
  }]);
});

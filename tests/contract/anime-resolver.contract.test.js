'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { popularAnime, getShowDetails } = require('../../lib/allanime');
const { resolveEpisodePlayback } = require('../../lib/anime-resolver');
const { getSkipTimesForTitle } = require('../../lib/aniskip');
const { USER_AGENT } = require('../../lib/config');

const opts = {
  skip: process.env.RUN_CONTRACT === '1' ? false : 'set RUN_CONTRACT=1 to run the live anime resolver check',
  timeout: 120_000,
};

test('built-in resolver returns a playable URL', opts, async () => {
  const results = await popularAnime('0', 'sub');
  const show = results.find((item) => item?.id) || results[0];
  assert.ok(show?.id, 'live popular list should return a show id');

  const details = await getShowDetails(show.id, 'sub');
  // Prefer an early episode so the check covers multi-source expansion rather
  // than a brand-new release that may only expose a single embed host.
  const episode = details.episodes[0];
  assert.ok(episode, 'live show details should return an episode');

  const playback = await resolveEpisodePlayback({
    showId: show.id,
    episode,
    mode: 'sub',
    quality: 'best',
  });
  assert.equal(playback.resolver, 'node');
  assert.match(playback.url, /^https?:\/\//);
});

test('resolved playback supports byte-range access and AniSkip metadata when available', opts, async () => {
  const results = await popularAnime('0', 'sub');
  const show = results.find((item) => item?.id && (item.name || item.englishName)) || results[0];
  assert.ok(show?.id, 'live popular list should return a show id');

  const title = show.englishName || show.name;
  const playback = await resolveEpisodePlayback({
    showId: show.id,
    episode: '1',
    mode: 'sub',
    quality: 'best',
  });
  const response = await fetch(playback.url, {
    headers: {
      'user-agent': USER_AGENT,
      referer: playback.referrer,
      range: 'bytes=0-1023',
    },
    signal: AbortSignal.timeout(15_000),
  });
  assert.ok(response.status === 200 || response.status === 206, `playback source returned ${response.status}`);
  // Some CDNs serve playable media as application/octet-stream instead of video/*.
  assert.match(response.headers.get('content-type') || '', /^(video\/|application\/octet-stream\b)/i);
  await response.body?.cancel();

  const skip = await getSkipTimesForTitle({ cache: {} }, title, '1', 1420);
  if (!skip?.malId) return;
  assert.ok(Number.isFinite(skip.malId), 'AniSkip MAL id should be numeric when present');
  if (skip.op) assert.ok(skip.op.end > skip.op.start, 'opening interval should be ordered');
  if (skip.ed) assert.ok(skip.ed.end > skip.ed.start, 'ending interval should be ordered');
});

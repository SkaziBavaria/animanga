'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { searchAnime, getShowDetails } = require('../../lib/allanime');
const { resolveEpisodePlayback } = require('../../lib/anime-resolver');
const { getSkipTimesForTitle } = require('../../lib/aniskip');
const { USER_AGENT } = require('../../lib/config');

const opts = {
  skip: process.env.RUN_CONTRACT === '1' ? false : 'set RUN_CONTRACT=1 to run the live anime resolver check',
  timeout: 120_000,
};

test('built-in Node resolver returns a playable URL without ani-cli', opts, async () => {
  const results = await searchAnime('One Piece', 'sub');
  const show = results.find((item) => item.name === 'One Piece' || item.englishName === 'One Piece') || results[0];
  assert.ok(show?.id, 'live search should return a show id');

  const details = await getShowDetails(show.id, 'sub');
  // Use the oldest episode as a stable provider fixture. A just-released episode
  // can temporarily have only one embed host, which tests that host rather than
  // the resolver's ability to expand normal multi-source responses.
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

test('Solo Leveling S2 resolves a byte-range playable source and AniSkip metadata', opts, async () => {
  const title = 'Solo Leveling Season 2: Arise from the Shadow';
  const results = await searchAnime(title, 'sub');
  const show = results.find((item) => item.englishName === title || item.name === title);
  assert.ok(show?.id, 'Solo Leveling S2 should resolve to a show id');

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
  assert.match(response.headers.get('content-type') || '', /video\//i);
  await response.body?.cancel();

  const skip = await getSkipTimesForTitle({ cache: {} }, title, '1', 1420);
  assert.equal(skip.malId, 58567);
  assert.ok(skip.op?.end > skip.op?.start, 'opening interval should be available');
  assert.ok(skip.ed?.end > skip.ed?.start, 'ending interval should be available');
});

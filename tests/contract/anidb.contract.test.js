'use strict';

// Live contract tests against anidb.app. Opt-in only.
const test = require('node:test');
const assert = require('node:assert/strict');
const anidb = require('../../lib/anidb');
const { resolveCurlBinary } = require('../../lib/anidb-fetch');
const { resolveEpisodePlayback } = require('../../lib/anime-resolver');

const hasCurl = Boolean(resolveCurlBinary());
const opts = {
  skip: process.env.RUN_CONTRACT === '1' && hasCurl
    ? false
    : 'set RUN_CONTRACT=1 and install curl to run live anidb contracts',
};

test('anidb search returns shaped results', opts, async () => {
  const results = await anidb.searchAnime('one piece', 'sub');
  assert.ok(results.length > 0, 'expected search hits');
  assert.match(results[0].id, /-\d+$/);
  assert.ok(results[0].name);
});

test('anidb details expose an episode list', opts, async () => {
  const results = await anidb.searchAnime('one piece', 'sub');
  const show = results[0];
  assert.ok(show?.id);
  const details = await anidb.getShowDetails(show.id, 'sub');
  assert.ok(details.episodes.length > 0);
});

test('anidb playback resolves an m3u8 url', opts, async () => {
  const results = await anidb.searchAnime('one piece', 'sub');
  const show = results[0];
  const details = await anidb.getShowDetails(show.id, 'sub');
  const episode = details.episodes[0];
  const playback = await resolveEpisodePlayback({
    showId: show.id,
    episode,
    mode: 'sub',
    quality: 'best',
  });
  assert.match(playback.url, /^https?:\/\//i);
  assert.equal(playback.provider, 'anidb');
});

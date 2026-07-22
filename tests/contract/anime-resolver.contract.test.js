'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { searchAnime, getShowDetails } = require('../../lib/allanime');
const { resolveEpisodePlayback } = require('../../lib/anime-resolver');

const opts = {
  skip: process.env.RUN_CONTRACT === '1' ? false : 'set RUN_CONTRACT=1 to run the live anime resolver check',
  timeout: 120_000,
};

test('built-in Node resolver returns a playable URL without ani-cli', opts, async () => {
  const results = await searchAnime('One Piece', 'sub');
  const show = results.find((item) => item.name === 'One Piece' || item.englishName === 'One Piece') || results[0];
  assert.ok(show?.id, 'live search should return a show id');

  const details = await getShowDetails(show.id, 'sub');
  const episode = details.episodes.at(-1);
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

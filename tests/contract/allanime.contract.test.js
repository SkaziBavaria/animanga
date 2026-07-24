'use strict';

// Live contract tests against the real AllAnime API. Opt-in only
// (flaky by nature). Enable with RUN_CONTRACT=1.

const test = require('node:test');
const assert = require('node:assert/strict');
const allanime = require('../../lib/allanime');

const opts = { skip: process.env.RUN_CONTRACT === '1' ? false : 'set RUN_CONTRACT=1 to run live contract tests' };

test('AllAnime search returns shaped results', opts, async () => {
  const results = await allanime.searchAnime('a', 'sub');
  assert.ok(Array.isArray(results), 'results should be an array');
  assert.ok(results.length > 0, 'expected at least one result');
  const first = results[0];
  assert.ok(first.id, 'result should have an id');
  assert.ok(first.name, 'result should have a name');
  assert.ok(Number(first.episodeCount) > 0, 'result should have episodes');
});

test('AllAnime popular returns shaped results', opts, async () => {
  const results = await allanime.popularAnime('0', 'sub');
  assert.ok(results.length > 0, 'expected popular results');
  assert.ok(results[0].id, 'popular result should have an id');
});

test('AllAnime details expose an episode list', opts, async () => {
  const popular = await allanime.popularAnime('0', 'sub');
  assert.ok(popular[0]?.id, 'expected a popular show id');
  const details = await allanime.getShowDetails(popular[0].id, 'sub');
  assert.ok(Array.isArray(details.episodes), 'episodes should be an array');
  assert.ok(details.episodes.length > 0, 'expected at least one episode');
});

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

async function loadPlayerNav() {
  const source = fs.readFileSync(path.join(__dirname, '../../public/js/player-nav.js'), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

test('adjacentEpisode returns null after the last listed episode', async () => {
  const { adjacentEpisode } = await loadPlayerNav();
  const show = { episodes: ['1', '2', '3'], latestEpisode: '3' };
  assert.equal(adjacentEpisode(show, '2', 1), '3');
  assert.equal(adjacentEpisode(show, '3', 1), null);
  assert.equal(adjacentEpisode(show, '1', -1), null);
});

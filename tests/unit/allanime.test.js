'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const allanime = require('../../lib/allanime');

function stub(payload) {
  allanime.setRawFetcher(async () => JSON.stringify(payload));
}

test.afterEach(() => allanime.setRawFetcher(null));

test('processAllAnimeResponse passes through plain JSON', () => {
  const parsed = allanime.processAllAnimeResponse(JSON.stringify({ data: { ok: true } }));
  assert.deepEqual(parsed, { data: { ok: true } });
});

test('showSummary maps an edge into a card', () => {
  const card = allanime.showSummary({
    _id: 'abc',
    name: 'Bleach',
    englishName: 'Bleach',
    availableEpisodes: { sub: 366 },
    thumbnail: 'thumb.jpg',
    relatedShows: [],
  }, 0, 'sub');
  assert.equal(card.id, 'abc');
  assert.equal(card.episodeCount, 366);
  assert.equal(card.title, 'Bleach (366 episodes)');
  assert.equal(card.index, 1);
  assert.equal(card.mode, 'sub');
});

test('searchAnime maps edges and drops entries without episodes', async () => {
  stub({
    data: {
      shows: {
        edges: [
          { _id: 's1', name: 'Show One', availableEpisodes: { sub: 12 } },
          { _id: 's2', name: 'No Episodes', availableEpisodes: { sub: 0 } },
        ],
      },
    },
  });
  const results = await allanime.searchAnime('show', 'sub');
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 's1');
  assert.equal(results[0].episodeCount, 12);
});

test('searchAnime returns empty for a blank query without calling the network', async () => {
  allanime.setRawFetcher(async () => {
    throw new Error('should not be called');
  });
  assert.deepEqual(await allanime.searchAnime('  ', 'sub'), []);
});

test('popularAnime maps the anyCard recommendations', async () => {
  stub({
    data: {
      queryPopular: {
        recommendations: [
          { anyCard: { _id: 'p1', name: 'Popular One', availableEpisodes: { sub: 24 } } },
          { anyCard: null },
        ],
      },
    },
  });
  const results = await allanime.popularAnime('0', 'sub');
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'p1');
});

test('getShowDetails maps episodes and metadata', async () => {
  stub({
    data: {
      show: {
        _id: 'd1',
        name: 'Detail Show',
        availableEpisodes: { sub: 3 },
        availableEpisodesDetail: { sub: ['1', '2', '3'] },
        genres: ['Action'],
        description: 'A show.',
      },
    },
  });
  const details = await allanime.getShowDetails('d1', 'sub');
  assert.equal(details.id, 'd1');
  assert.deepEqual(details.episodes, ['1', '2', '3']);
  assert.equal(details.latestEpisode, '3');
  assert.equal(details.episodeCount, 3);
  assert.deepEqual(details.genres, ['Action']);
});

test('normalizeRelatedShows dedupes and cleans relations', () => {
  const relations = allanime.normalizeRelatedShows([
    { relation: 'sequel', showId: 'x' },
    { relation: 'sequel', showId: 'x' },
    { relation: '', showId: 'y' },
    { showId: '' },
  ]);
  assert.deepEqual(relations, [
    { relation: 'sequel', showId: 'x' },
    { relation: 'related', showId: 'y' },
  ]);
});

test('hasNextSeason detects a sequel relation', () => {
  assert.equal(allanime.hasNextSeason([{ relation: 'sequel', showId: 'x' }]), true);
  assert.equal(allanime.hasNextSeason([{ relation: 'prequel', showId: 'x' }]), false);
});

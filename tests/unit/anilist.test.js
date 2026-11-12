'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  enrichAnimeRelations,
  parseStreamingEpisodeTitles,
  setAniListFetcherForTests,
} = require('../../lib/anilist');

test('AniList identifies a related second season and supplies its aired years', async () => {
  setAniListFetcherForTests(async (url, options) => {
    assert.equal(url, 'https://graphql.anilist.co');
    assert.equal(options.method, 'POST');
    const request = JSON.parse(options.body);
    assert.equal(request.variables.search, 'Spare Me, Great Lord!');
    return {
      ok: true,
      json: async () => ({
        data: {
          Page: {
            media: [{
              title: { romaji: 'Dawang Raoming', english: null, native: '' },
              status: 'FINISHED',
              episodes: 12,
              startDate: { year: 2021, month: 4, day: 1 },
              endDate: { year: 2022, month: 3, day: 1 },
              synonyms: ['Spare Me, Great Lord!'],
              relations: {
                edges: [{
                  relationType: 'SEQUEL',
                  node: {
                    id: 201,
                    type: 'ANIME',
                    title: { romaji: 'Dawang Raoming 2', english: null, native: '' },
                    synonyms: ['Spare Me, Great Lord! 2'],
                    status: 'FINISHED',
                    episodes: 12,
                    startDate: { year: 2023, month: 12, day: 30 },
                    endDate: { year: 2024, month: 1, day: 27 },
                  },
                }],
              },
            }],
          },
        },
      }),
    };
  });
  try {
    const result = await enrichAnimeRelations('Spare Me, Great Lord!');
    assert.equal(result.anilistStatus, 'FINISHED');
    assert.equal(result.anilistAiredStart.year, 2021);
    assert.equal(result.anilistAiredEnd.year, 2022);
    assert.equal(result.nextSeason.relation, 'sequel');
    assert.equal(result.nextSeason.anilistStatus, 'FINISHED');
    assert.equal(result.nextSeason.anilistEpisodeCount, 12);
    assert.equal(result.nextSeason.airedStart.year, 2023);
    assert.equal(result.nextSeason.airedEnd.year, 2024);
    assert.equal(result.relations[0].relation, 'sequel');
  } finally {
    setAniListFetcherForTests(null);
  }
});

test('AniList maps streaming episode titles only when their numbers are explicit and unique', () => {
  assert.deepEqual(parseStreamingEpisodeTitles([
    { title: 'Episode 1 - The Beginning' },
    { title: 'Ep. 2: New Journey' },
    { title: 'Episode 3' },
    { title: 'Episode 4 - One title' },
    { title: 'Episode 4 - Conflicting title' },
    { title: 'Finale' },
  ]), {
    '1': 'The Beginning',
    '2': 'New Journey',
  });
});

test('AniList lookup returns no data for an unmatched parent title', async () => {
  setAniListFetcherForTests(async () => ({
    ok: true,
    json: async () => ({ data: { Page: { media: [] } } }),
  }));
  try {
    const result = await enrichAnimeRelations('Example Show');
    assert.equal(result, null);
  } finally {
    setAniListFetcherForTests(null);
  }
});

test('AniList non-season relation overrides HiAnime season ordering', async () => {
  setAniListFetcherForTests(async () => ({
    ok: true,
    json: async () => ({
      data: {
        Page: {
          media: [{
            title: { romaji: 'Example', english: null, native: null },
            synonyms: ['Example Show'],
            relations: {
              edges: [{
                relationType: 'SIDE_STORY',
                node: {
                  id: 202,
                  type: 'ANIME',
                  title: { romaji: 'Example Side Story', english: null, native: null },
                  synonyms: ['Example Show OVA'],
                  startDate: { year: 2022, month: 4, day: 1 },
                  endDate: { year: 2022, month: 4, day: 1 },
                },
              }, {
                relationType: 'SOURCE',
                node: {
                  id: 203,
                  type: 'MANGA',
                  format: 'NOVEL',
                  title: { romaji: 'Example Light Novel', english: null, native: null },
                  synonyms: [],
                },
              }],
            },
          }],
        },
      },
    }),
  }));
  try {
    const result = await enrichAnimeRelations('Example Show');
    assert.equal(result.relations[0].relation, 'related');
    assert.equal(result.nextSeason, null);
    assert.equal(result.relations[0].name, 'Example Side Story');
    assert.equal(result.relations[0].id, 'anilist:202');
    assert.equal(result.relations.some((item) => item.anilistId === 203), false);
  } finally {
    setAniListFetcherForTests(null);
  }
});

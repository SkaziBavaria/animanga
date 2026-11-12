'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAnimeProvider, normalizeDetails, providerIdentity, bindCatalogToLibrary } = require('../../lib/anime-provider');
const { touchShow } = require('../../lib/routes/shared');
const { pickMatch } = require('../../lib/hianime-migrate');
const { setRawFetcher } = require('../../lib/mal-episode-titles');
const { setAniListFetcherForTests } = require('../../lib/anilist');

test('provider details preserve library identity and normalize episode objects', async () => {
  const state = { settings: {}, shows: { 'legacy-1': { id: 'legacy-1', hianimeId: 'new-2', archived: true, watchedEpisodes: ['1'] } } };
  const service = createAnimeProvider({ hianime: { getShowDetails: async (id) => ({ id, episodes: [{ number: '1', title: 'First' }, { number: '2' }] }) } });
  const details = await service.details(state, 'legacy-1');
  assert.equal(details.id, 'legacy-1');
  assert.deepEqual(details.episodes, ['1', '2']);
  assert.equal(details.episodeTitles['1'], 'First');
  touchShow(state, 'legacy-1', details);
  assert.deepEqual(Object.keys(state.shows), ['legacy-1']);
  assert.deepEqual(state.shows['legacy-1'].watchedEpisodes, ['1']);
  assert.equal(state.shows['legacy-1'].archived, true);
});

test('episode title enrichment is opt-in so the episode list can load first', async () => {
  let lookups = 0;
  setRawFetcher(async () => {
    lookups += 1;
    throw new Error('unexpected title lookup');
  });
  try {
    const service = createAnimeProvider({ hianime: { getShowDetails: async (id) => ({ id, name: 'Example', episodes: ['1'] }) } });
    const details = await service.details({}, 'show-1');
    assert.deepEqual(details.episodes, ['1']);
    assert.equal(lookups, 0);
  } finally {
    setRawFetcher();
  }
});

test('stored provider mapping wins over client hints and slug shapes are not identities', () => {
  const state = { shows: { 'same-1': { id: 'same-1', hianimeId: 'correct-2' } } };
  assert.equal(providerIdentity(state, { id: 'same-1', hianimeId: 'wrong-3' }).providerId, 'correct-2');
  assert.equal(providerIdentity(state, 'unknown-1').provider, 'hianime');
  assert.equal(providerIdentity(state, { id: 'unknown-1', provider: 'hianime' }).provider, 'hianime');
});

test('unmapped library titles cannot be used as catalog ids', () => {
  const state = { shows: { 'legacy-1': { id: 'legacy-1', name: 'Custom' } } };
  assert.throws(() => providerIdentity(state, 'legacy-1'), /catalog match/);
});

test('wrong provider identity cannot be applied to stored history', () => {
  assert.throws(() => normalizeDetails({ id: 'local', providerId: 'right' }, { id: 'wrong' }), /wrong identity/);
  assert.throws(() => touchShow({ shows: { local: { id: 'local' } } }, 'local', { id: 'wrong' }), /wrong identity/);
});

test('playback uses the same provider mapping as metadata', async () => {
  const service = createAnimeProvider({ hianime: { resolveEpisodePlayback: async (options) => options } });
  const result = await service.playback({ shows: { old: { id: 'old', hianimeId: 'new' } } }, 'old', { episode: '15', mode: 'dub' });
  assert.deepEqual(result, { showId: 'new', episode: '15', mode: 'dub' });
});

test('automatic migration does not map a season to its sequel by prefix', () => {
  assert.equal(pickMatch({ name: 'Example' }, [{ id: 'sequel', name: 'Example Season 2' }]), null);
});

test('Discover reuses an archived library identity instead of creating a duplicate', () => {
  const state = { shows: { old: { id: 'old', archived: true, hianimeId: 'new' } } };
  const [result] = bindCatalogToLibrary(state, [{ id: 'new', hianimeId: 'new', name: 'Example' }]);
  assert.equal(result.id, 'old');
  assert.equal(result.hianimeId, 'new');
});

test('AniList relation lookup prefers the library season title over generic provider metadata', async () => {
  let queryTitle = '';
  setAniListFetcherForTests(async (_url, options) => {
    queryTitle = JSON.parse(options.body).variables.search;
    return {
      ok: true,
      json: async () => ({ data: { Page: { media: [{
        id: 303, type: 'ANIME', format: 'TV',
        title: { romaji: 'Example Show Part 3', english: 'Example Show Part 3', native: null },
        synonyms: [], status: 'FINISHED', episodes: 12, description: '', genres: [], coverImage: {},
        relations: { edges: [
          { relationType: 'PREQUEL', node: {
            id: 302, type: 'ANIME', format: 'TV',
            title: { romaji: 'Example Show Part 2', english: 'Example Show Part 2', native: null },
            synonyms: [], status: 'FINISHED', episodes: 12, startDate: { year: 2025, month: 1, day: 1 }, endDate: null,
            coverImage: {},
          } },
        ] },
      }] } } }),
    };
  });
  try {
    const service = createAnimeProvider({ hianime: {
      getShowDetails: async (id) => ({ id, name: 'Example Show', episodes: ['1'] }),
    } });
    const state = { settings: {}, shows: {
      'library-id': { id: 'library-id', name: 'Example Show Part 3', sourceName: 'Example Show', provider: 'hianime', providerId: 'provider-id' },
    } };
    const details = await service.details(state, 'library-id');
    assert.equal(queryTitle, 'Example Show Part 3');
    assert.equal(details.anilistId, 303);
    assert.equal(details.previousSeason?.anilistId, 302);
    assert.equal(details.nextSeason, undefined);
  } finally {
    setAniListFetcherForTests();
  }
});

test('AniList matcher picks the matching season and rejects a neighboring season', async () => {
  setAniListFetcherForTests(async () => ({
    ok: true,
    json: async () => ({ data: { Page: { media: [{
      id: 500, type: 'ANIME', format: 'TV',
      title: { romaji: 'Main Show', english: 'Main Show', native: null },
      synonyms: [], status: 'FINISHED', episodes: 12, description: '', genres: [], coverImage: {},
      relations: { edges: [{
        relationType: 'SEQUEL',
        node: {
          id: 502, type: 'ANIME', format: 'TV',
          title: { romaji: 'Example Show Season 2', english: 'Example Show Season 2', native: null },
          synonyms: ['Example Show 2nd Season'], status: 'FINISHED', episodes: 12,
          startDate: { year: 2024, month: 1, day: 1 }, endDate: null, coverImage: {},
        },
      }] },
    }] } } }),
  }));
  try {
    const catalog = {
      getShowDetails: async (id) => ({ id, name: 'Main Show', episodes: ['1'] }),
      searchAnime: async () => [
        { id: 'wrong-season-3', name: 'Example Show Season 3' },
        { id: 'right-season-2', name: 'Example Show 2nd Season' },
      ],
    };
    const service = createAnimeProvider({ hianime: catalog });
    const state = { settings: {}, shows: {
      main: { id: 'main', name: 'Main Show', provider: 'hianime', providerId: 'main' },
    } };
    const details = await service.details(state, 'main');
    assert.equal(details.nextSeason.providerId, 'right-season-2');
    assert.equal(details.nextSeason.name, 'Example Show Season 2');
    assert.equal(details.nextSeason.playable, true);
  } finally {
    setAniListFetcherForTests();
  }
});

test('AniList supplies season links and air dates without HiAnime status fallback', async () => {
  const summaries = [];
  const season = (id, relation, name) => ({
    id, provider: 'hianime', providerId: id, hianimeId: id, relation, name,
  });
  const adapter = {
    searchAnime: async (query) => [{ id: query.includes('Season 1') ? 'pre-1' : 'seq-2', name: query }],
    getShowDetails: async (id) => ({
      id, name: 'Current Show', episodes: ['1'],
      previousSeason: season('pre-1', 'prequel', 'Current Show Season 1'),
      nextSeason: season('seq-2', 'sequel', 'Current Show Season 3'),
      relations: [
        season('pre-1', 'prequel', 'Current Show Season 1'),
        season('seq-2', 'sequel', 'Current Show Season 3'),
      ],
    }),
    getShowSummary: async (id) => { summaries.push(id); return { status: 'Finished' }; },
  };
  setAniListFetcherForTests(async () => ({
    ok: true,
    json: async () => ({ data: { Page: { media: [{
      id: 777, type: 'ANIME', format: 'TV',
      title: { romaji: 'Current Show', english: 'Canonical Show', native: null },
      description: 'AniList synopsis', genres: ['Action'], coverImage: { large: 'https://img.example/cover.jpg' },
      streamingEpisodes: [{ title: 'Episode 1 - AniList episode name' }],
      synonyms: [],
      status: 'RELEASING',
      startDate: { year: 2022, month: 1, day: 1 },
      endDate: { year: 2024, month: 1, day: 1 },
      relations: { edges: [
        { relationType: 'PREQUEL', node: {
          id: 101, type: 'ANIME', title: { romaji: 'Current Show Season 1', english: null, native: null }, synonyms: [],
          status: 'FINISHED', episodes: 12, startDate: { year: 2020, month: 1, day: 1 }, endDate: { year: 2021, month: 1, day: 1 },
        } },
        { relationType: 'SEQUEL', node: {
          id: 103, type: 'ANIME', title: { romaji: 'Current Show Season 3', english: null, native: null }, synonyms: [],
          status: 'NOT_YET_RELEASED', episodes: null, startDate: { year: 2025, month: 1, day: 1 }, endDate: null,
        } },
      ] },
    }] } } }),
  }));
  try {
    const service = createAnimeProvider({ hianime: adapter });
    const details = await service.details({}, { id: 'current-2', provider: 'hianime' }, 'sub', { includeRelations: true });
    assert.equal(details.anilistStatus, 'RELEASING');
    assert.equal(details.anilistId, 777);
    assert.equal(details.providerId, 'current-2');
    assert.equal(details.name, 'Canonical Show');
    assert.equal(details.description, 'AniList synopsis');
    assert.deepEqual(details.genres, ['Action']);
    assert.equal(details.thumbnail, 'https://img.example/cover.jpg');
    assert.equal(details.episodeTitles['1'], 'AniList episode name');
    assert.equal(details.anilistAiredStart.year, 2022);
    assert.equal(details.previousSeason.anilistStatus, 'FINISHED');
    assert.equal(details.nextSeason.anilistStatus, 'NOT_YET_RELEASED');
    assert.equal(details.relations.find((item) => item.relation === 'prequel').anilistAiredEnd.year, 2021);
    assert.equal(details.previousSeason.playable, true);
    assert.equal(details.nextSeason.id, 'seq-2');
    assert.deepEqual(summaries, []);
  } finally {
    setAniListFetcherForTests(null);
  }
});

test('AniList relation type can clear a HiAnime next season label', async () => {
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
                  id: 404,
                  type: 'ANIME',
                  title: { romaji: 'Example Side Story', english: null, native: null },
                  synonyms: ['Example Show OVA'],
                  startDate: { year: 2022, month: 4, day: 1 },
                  endDate: { year: 2022, month: 4, day: 1 },
                },
              }],
            },
          }],
        },
      },
    }),
  }));
  try {
    const next = { id: 'ova', provider: 'hianime', providerId: 'ova', name: 'Example Show OVA', relation: 'sequel' };
    const service = createAnimeProvider({
      hianime: {
        getShowDetails: async (id) => ({
          id,
          name: 'Example Show',
          episodes: ['1'],
          nextSeason: next,
          hasNextSeason: true,
          relations: [next],
        }),
      },
    });
    const details = await service.details({}, { id: 'example', provider: 'hianime' }, 'sub', { includeRelations: true });
    assert.equal(details.relations[0].relation, 'related');
    assert.equal(details.nextSeason, undefined);
    assert.equal(details.hasNextSeason, false);
  } finally {
    setAniListFetcherForTests(null);
  }
});

test('details persist a generic catalog mapping beside the library id', async () => {
  const state = { settings: {}, shows: { 'legacy-1': { id: 'legacy-1', providerId: 'new-2' } } };
  const service = createAnimeProvider({ hianime: { getShowDetails: async (id) => ({ id, episodes: ['1'] }) } });
  const details = await service.details(state, 'legacy-1');
  assert.equal(details.id, 'legacy-1');
  assert.equal(details.provider, 'hianime');
  assert.equal(details.providerId, 'new-2');
  assert.equal(details.hianimeId, 'new-2');
});

test('concurrent details share a fetch but never share mutable returned objects', async () => {
  let calls = 0;
  const service = createAnimeProvider({ hianime: { getShowDetails: async (id) => { calls++; return { id, episodes: ['1'] }; } } });
  const input = { id: 'new', provider: 'hianime' };
  const [first, second] = await Promise.all([service.details({}, input), service.details({}, input)]);
  first.episodes.push('2');
  assert.deepEqual(second.episodes, ['1']);
  assert.equal(calls, 1);
  await service.details({}, input, 'sub', { force: true });
  assert.equal(calls, 2);
});

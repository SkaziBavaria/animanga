'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { enrichEpisodeTitles, setRawFetcher, usableEpisodeTitle } = require('../../lib/mal-episode-titles');

test.afterEach(() => setRawFetcher());

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

test('usable episode titles skip generic Episode N labels', () => {
  assert.equal(usableEpisodeTitle('The Future Is In Our Hands'), 'The Future Is In Our Hands');
  assert.equal(usableEpisodeTitle('Episode 12'), '');
  assert.equal(usableEpisodeTitle(''), '');
});

test('enrichment fills missing HiAnime titles after a matching MAL identity', async () => {
  const calls = [];
  setRawFetcher(async (url) => {
    calls.push(url);
    if (url.endsWith('/anime/61169')) {
      return jsonResponse({ data: { title: 'Black Torch', title_english: 'Black Torch', titles: [] } });
    }
    if (url.includes('/anime/61169/episodes')) {
      return jsonResponse({
        pagination: { has_next_page: false },
        data: [
          { mal_id: 1, title: 'The Future Is In Our Hands' },
          { mal_id: 2, title: 'Episode 2' },
          { mal_id: 3, title: 'The Choice Is Yours' },
        ],
      });
    }
    throw new Error(`unexpected ${url}`);
  });
  const details = await enrichEpisodeTitles({}, {
    name: 'Black Torch',
    malId: 61169,
    episodes: ['1', '2', '3'],
    episodeTitles: { 1: 'Keep HiAnime Name' },
  });
  assert.equal(details.episodeTitles['1'], 'Keep HiAnime Name');
  assert.equal(details.episodeTitles['2'], undefined);
  assert.equal(details.episodeTitles['3'], 'The Choice Is Yours');
  assert.equal(calls.length, 2);
});

test('enrichment rejects a MAL id bound to a different work', async () => {
  setRawFetcher(async (url) => {
    if (url.endsWith('/anime/21')) {
      return jsonResponse({ data: { title: 'One Piece', titles: [] } });
    }
    throw new Error(`unexpected ${url}`);
  });
  const details = await enrichEpisodeTitles({}, {
    name: 'Black Torch',
    malId: 21,
    episodes: ['1'],
    episodeTitles: {},
  });
  assert.deepEqual(details.episodeTitles, {});
});

test('enrichment does not look up titles when every episode already has a name', async () => {
  setRawFetcher(async () => { throw new Error('should not fetch'); });
  const details = await enrichEpisodeTitles({}, {
    name: 'Named Show',
    malId: 1,
    episodes: ['1'],
    episodeTitles: { 1: 'Already Named' },
  });
  assert.equal(details.episodeTitles['1'], 'Already Named');
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveMalId, fetchSkipTimes, getSkipTimesForTitle, setRawFetcher } = require('../../lib/aniskip');

function jsonResponse(data, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => data };
}

function freshState() {
  return { cache: {} };
}

test.afterEach(() => setRawFetcher(null));

test('resolveMalId picks the exact title match from Jikan search results', async () => {
  setRawFetcher(async (url) => {
    assert.match(url, /api\.jikan\.moe\/v4\/anime\?q=/);
    return jsonResponse({
      data: [
        { mal_id: 1, title: 'Not It' },
        { mal_id: 42, title: 'Bleach', title_english: 'Bleach' },
      ],
    });
  });
  const state = freshState();
  const id = await resolveMalId(state, 'Bleach');
  assert.equal(id, 42);
  assert.equal(state.cache.malIds.bleach.value.malId, 42);
});

test('resolveMalId falls back to the top result when no exact title matches', async () => {
  setRawFetcher(async () => jsonResponse({
    data: [{ mal_id: 99, title: 'Closest Guess' }],
  }));
  const state = freshState();
  const id = await resolveMalId(state, 'Some Obscure Show');
  assert.equal(id, 99);
});

test('resolveMalId caches a negative result to avoid repeat lookups', async () => {
  let calls = 0;
  setRawFetcher(async () => {
    calls += 1;
    return jsonResponse({ data: [] });
  });
  const state = freshState();
  const first = await resolveMalId(state, 'Totally Unknown Show');
  const second = await resolveMalId(state, 'Totally Unknown Show');
  assert.equal(first, null);
  assert.equal(second, null);
  assert.equal(calls, 1);
});

test('fetchSkipTimes maps op/ed intervals from the aniskip response', async () => {
  setRawFetcher(async (url) => {
    assert.match(url, /api\.aniskip\.com\/v2\/skip-times\/42\/5/);
    return jsonResponse({
      found: true,
      results: [
        { skipType: 'op', interval: { startTime: 10, endTime: 100 } },
        { skipType: 'ed', interval: { startTime: 1300, endTime: 1400 } },
      ],
    });
  });
  const state = freshState();
  const skip = await fetchSkipTimes(state, 42, '5', 1440);
  assert.deepEqual(skip.op, { start: 10, end: 100 });
  assert.deepEqual(skip.ed, { start: 1300, end: 1400 });
});

test('fetchSkipTimes returns empty result when nothing is found', async () => {
  setRawFetcher(async () => jsonResponse({ found: false, results: [] }));
  const state = freshState();
  const skip = await fetchSkipTimes(state, 42, '5', 1440);
  assert.deepEqual(skip, { op: null, ed: null });
});

test('fetchSkipTimes tolerates network failures', async () => {
  setRawFetcher(async () => jsonResponse({}, false));
  const state = freshState();
  const skip = await fetchSkipTimes(state, 42, '5', 1440);
  assert.deepEqual(skip, { op: null, ed: null });
});

test('getSkipTimesForTitle resolves the MAL id then fetches skip times', async () => {
  setRawFetcher(async (url) => {
    if (url.includes('jikan')) return jsonResponse({ data: [{ mal_id: 7, title: 'One Piece' }] });
    return jsonResponse({ found: true, results: [{ skipType: 'op', interval: { startTime: 0, endTime: 90 } }] });
  });
  const state = freshState();
  const skip = await getSkipTimesForTitle(state, 'One Piece', '1', 1440);
  assert.equal(skip.malId, 7);
  assert.deepEqual(skip.op, { start: 0, end: 90 });
  assert.equal(skip.ed, null);
});

test('getSkipTimesForTitle short-circuits when no MAL id is found', async () => {
  setRawFetcher(async () => jsonResponse({ data: [] }));
  const state = freshState();
  const skip = await getSkipTimesForTitle(state, 'Unknown Show XYZ', '1', 1440);
  assert.deepEqual(skip, { op: null, ed: null, malId: null });
});

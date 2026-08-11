'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  clearPosition,
  mangaPositionKey,
  presentMangaPositions,
  presentPositions,
  setMangaPosition,
  setPosition,
} = require('../../lib/progress');

test('stores a mid-episode position', () => {
  const state = {};
  const result = setPosition(state, { id: 'show', episode: '2', position: 300, duration: 1400 });
  assert.equal(result.position.position, 300);
  assert.equal(state.positions['show:2'].duration, 1400);
});

test('clears a position near the end of the episode', () => {
  const state = { positions: { 'show:2': { position: 100 } } };
  const result = setPosition(state, { id: 'show', episode: '2', position: 1390, duration: 1400 });
  assert.equal(result.cleared, true);
  assert.equal(state.positions['show:2'], undefined);
});

test('clears a position too close to the start', () => {
  const state = {};
  const result = setPosition(state, { id: 'show', episode: '2', position: 2, duration: 1400 });
  assert.equal(result.cleared, true);
  assert.equal(state.positions['show:2'], undefined);
});

test('ignores missing id or episode', () => {
  const state = {};
  assert.equal(setPosition(state, { episode: '2', position: 300 }).cleared, true);
  assert.equal(setPosition(state, { id: 'show', position: 300 }).cleared, true);
});

test('clearPosition removes a stored record', () => {
  const state = { positions: { 'show:1': { position: 50 } } };
  clearPosition(state, 'show', '1');
  assert.equal(state.positions['show:1'], undefined);
});

test('presentPositions returns the map', () => {
  const state = { positions: { 'a:1': { position: 10 } } };
  assert.deepEqual(presentPositions(state), { 'a:1': { position: 10 } });
});

test('stores one manga page position per chapter', () => {
  const state = {};
  setMangaPosition(state, { mangaId: 'manga', chapter: '2', page: 4, pageCount: 10 });
  assert.equal(state.mangaPositions[mangaPositionKey('manga', '2')].page, 4);
});

test('can store the last visible manga page without completing the chapter', () => {
  const state = {};
  const result = setMangaPosition(state, { mangaId: 'manga', chapter: '2', page: 10, pageCount: 10 });
  assert.equal(result.position.page, 10);
  assert.equal(presentMangaPositions(state)['manga:sub:2'].pageCount, 10);
});

test('clears manga page progress explicitly', () => {
  const state = { mangaPositions: { 'manga:sub:2': { page: 4 } } };
  const result = setMangaPosition(state, { mangaId: 'manga', chapter: '2', clear: true });
  assert.equal(result.cleared, true);
  assert.equal(state.mangaPositions['manga:sub:2'], undefined);
});

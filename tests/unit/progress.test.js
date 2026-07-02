'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setPosition, presentPositions, clearPosition } = require('../../lib/progress');

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

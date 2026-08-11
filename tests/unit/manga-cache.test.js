'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isVerifiedRemoteManifest } = require('../../lib/manga-cache');

const names = ['I Became A Married Man in Another World', 'The Otherworldly Family Man'];

test('remote manga cache requires matching ComicK and resolver identities', () => {
  const valid = {
    downloaded: false,
    pages: [{ number: 1, url: 'https://cdn.example/1.jpg' }],
    resolvedTitle: 'The Otherworldly Family Man',
    verifiedTitleMatch: true,
    catalogProvider: 'comick',
    catalogRequestId: 'married-man',
  };
  assert.equal(isVerifiedRemoteManifest(valid, 'married-man', names), true);
  assert.equal(isVerifiedRemoteManifest({ ...valid, catalogRequestId: 'solo-leveling' }, 'married-man', names), false);
  assert.equal(isVerifiedRemoteManifest({ ...valid, resolvedTitle: 'My Dress-Up Darling' }, 'married-man', names), false);
  assert.equal(isVerifiedRemoteManifest({ ...valid, catalogProvider: '' }, 'married-man', names), false);
});

test('legacy remote cache without catalog identity is rejected', () => {
  assert.equal(isVerifiedRemoteManifest({
    pages: [{ number: 1, url: 'https://cdn.example/1.jpg' }],
    resolvedTitle: 'The Otherworldly Family Man',
    verifiedTitleMatch: true,
  }, 'married-man', names), false);
});

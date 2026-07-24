'use strict';

const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { pathInside } = require('../../lib/static');

test('pathInside accepts files inside the public root', () => {
  const root = path.resolve('/app/public');
  assert.equal(pathInside(root, path.join(root, 'index.html')), true);
  assert.equal(pathInside(root, path.join(root, 'js', 'app.js')), true);
});

test('pathInside rejects sibling paths with matching prefixes', () => {
  const root = path.resolve('/app/public');
  assert.equal(pathInside(root, path.resolve('/app/public-old/secret.txt')), false);
  assert.equal(pathInside(root, path.resolve('/app/publicity/secret.txt')), false);
});

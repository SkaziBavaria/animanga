'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isOpenBind } = require('../../lib/bind-security');

test('detects open bind addresses', () => {
  assert.equal(isOpenBind('0.0.0.0'), true);
  assert.equal(isOpenBind('::'), true);
  assert.equal(isOpenBind('127.0.0.1'), false);
});

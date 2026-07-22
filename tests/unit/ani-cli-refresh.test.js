'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { refreshAniCliCrypto } = require('../../lib/ani-cli-refresh');

const key = 'f34fa715e2958b8c1ebc6efa4d089acd8f196d8b83d4b6201586c00c8a52e4a8';
const requestTail = '${allanime_api}/api" --data-urlencode "variables=${query_vars}" --data-urlencode "extensions=${query_ext}")"';

function stableFixture() {
  return [
    '#!/bin/sh',
    'node_crypto="',
    "const payload = JSON.stringify({v:1,ts:ts,epoch:4128,buildId:'9',qh:qh});",
    "const iv = crypto.createHash('sha256').update('4128:9:'+qh+':'+ts).digest();",
    '"',
    `    api_resp="$(curl -H "Origin: \${allanime_refr}" "${requestTail}`,
    'allanime_key="22196fa6afca95309fdabe9a3534b87cd2454e50efeabfcbdbdfd3de678b3982"',
    '',
  ].join('\n');
}

test('atomic refresh patches ani-cli only after a complete live config', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'animanga-ani-cli-'));
  const aniCliPath = path.join(dir, 'ani-cli');
  fs.writeFileSync(aniCliPath, stableFixture());
  const result = await refreshAniCliCrypto({
    aniCliPath,
    fetchConfig: async () => ({
      key,
      epoch: '6885',
      buildId: '64',
      origin: 'https://mkissa.to',
      source: 'mkissa',
    }),
    validateConfig: async () => ({ ok: true }),
  });
  assert.equal(result.ok, true);
  const patched = fs.readFileSync(aniCliPath, 'utf8');
  assert.match(patched, /epoch:6885,buildId:'64'/);
  assert.match(patched, new RegExp(key));
  assert.equal(fs.readdirSync(dir).some((name) => name.includes('.ani-cli.crypto-refresh.')), false);
});

test('failed atomic replacement leaves the previous ani-cli file unchanged', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'animanga-ani-cli-'));
  const aniCliPath = path.join(dir, 'ani-cli');
  const original = stableFixture();
  fs.writeFileSync(aniCliPath, original);
  const result = await refreshAniCliCrypto({
    aniCliPath,
    fetchConfig: async () => ({
      key,
      epoch: '6885',
      buildId: '64',
      origin: 'https://mkissa.to',
      source: 'mkissa',
    }),
    validateConfig: async () => ({ ok: true }),
    replaceFile: () => {
      throw new Error('atomic rename unavailable');
    },
  });
  assert.equal(result.ok, false);
  assert.equal(fs.readFileSync(aniCliPath, 'utf8'), original);
  assert.match(result.reason, /atomic rename unavailable/);
  assert.equal(fs.readdirSync(dir).some((name) => name.includes('.ani-cli.crypto-refresh.')), false);
});

test('failed refresh leaves the previous ani-cli file unchanged', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'animanga-ani-cli-'));
  const aniCliPath = path.join(dir, 'ani-cli');
  const original = stableFixture();
  fs.writeFileSync(aniCliPath, original);
  const result = await refreshAniCliCrypto({
    aniCliPath,
    fetchConfig: async () => {
      throw new Error('mkissa unavailable');
    },
  });
  assert.equal(result.ok, false);
  assert.equal(fs.readFileSync(aniCliPath, 'utf8'), original);
  assert.equal(fs.readdirSync(dir).some((name) => name.includes('.ani-cli.crypto-refresh.')), false);
  assert.doesNotMatch(result.reason || '', /[0-9a-f]{64}/i);
});

test('failed live validation keeps the previous ani-cli file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'animanga-ani-cli-'));
  const aniCliPath = path.join(dir, 'ani-cli');
  const original = stableFixture();
  fs.writeFileSync(aniCliPath, original);
  const result = await refreshAniCliCrypto({
    aniCliPath,
    fetchConfig: async () => ({
      key,
      epoch: '6885',
      buildId: '64',
      origin: 'https://mkissa.to',
      source: 'mkissa',
    }),
    validateConfig: async () => {
      throw new Error('AA_CRYPTO_STALE');
    },
  });
  assert.equal(result.ok, false);
  assert.equal(fs.readFileSync(aniCliPath, 'utf8'), original);
  assert.match(result.reason, /AA_CRYPTO_STALE/);
});

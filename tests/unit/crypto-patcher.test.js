'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractCryptoConfig, patchStableAniCli } = require('../../scripts/patch-ani-cli-crypto');

const key = 'f34fa715e2958b8c1ebc6efa4d089acd8f196d8b83d4b6201586c00c8a52e4a8';
const requestTail = '${allanime_api}/api" --data-urlencode "variables=${query_vars}" --data-urlencode "extensions=${query_ext}")"';

test('extracts current crypto parameters from an upstream reference', () => {
  const reference = [
    `    api_resp="$(curl -H "Origin: https://mkissa.to" -H "x-build-id: $allanime_build_id" "${requestTail}`,
    `allanime_key="${key}"`,
    'allanime_epoch=6884',
    'allanime_build_id=50',
  ].join('\n');
  assert.deepEqual(extractCryptoConfig(reference), {
    key,
    epoch: '6884',
    buildId: '50',
    origin: 'https://mkissa.to',
  });
});

test('patches the stable Node-based aaReq implementation', () => {
  const stable = [
    "const payload = JSON.stringify({v:1,ts:ts,epoch:4128,buildId:'9',qh:qh});",
    "const iv = crypto.createHash('sha256').update('4128:9:'+qh+':'+ts).digest();",
    `    api_resp="$(curl -H "Origin: ${'${allanime_refr}'}" "${requestTail}`,
    'allanime_key="22196fa6afca95309fdabe9a3534b87cd2454e50efeabfcbdbdfd3de678b3982"',
  ].join('\n');
  const output = patchStableAniCli(stable, {
    key,
    epoch: '6884',
    buildId: '50',
    origin: 'https://mkissa.to',
  });
  assert.match(output, /epoch:6884,buildId:'50'/);
  assert.match(output, /update\('6884:50:'\+qh\+':'\+ts\)/);
  assert.match(output, /Origin: https:\/\/mkissa\.to/);
  assert.match(output, /x-build-id: 50/);
  assert.match(output, new RegExp(key));
});

test('fails closed when upstream no longer exposes expected values', () => {
  assert.throws(() => extractCryptoConfig('unexpected upstream format'), /allanime_key/);
});

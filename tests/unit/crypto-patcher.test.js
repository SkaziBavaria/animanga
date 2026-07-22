'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractCryptoConfig, patchStableAniCli } = require('../../scripts/patch-ani-cli-crypto');
const { extractClientCrypto, deriveKey } = require('../../lib/mkissa-crypto');

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
    epoch: '6885',
    buildId: '63',
    origin: 'https://mkissa.to',
  });
  assert.match(output, /epoch:6885,buildId:'63'/);
  assert.match(output, /update\('6885:63:'\+qh\+':'\+ts\)/);
  assert.match(output, /Origin: https:\/\/mkissa\.to/);
  assert.match(output, /x-build-id: 63/);
  assert.match(output, new RegExp(key));
});

test('fails closed when upstream no longer exposes expected values', () => {
  assert.throws(() => extractCryptoConfig('unexpected upstream format'), /allanime_key/);
});

test('extractClientCrypto reads mask and buildId from the mkissa crypto chunk shape', () => {
  const legacy = [
    'noise',
    'const qd="a39b86dbbcf57f884f3e9074969e7fe26656c74012e4545605896621ffa441c1",kr=yt(183)!=="string"?"63":"";',
    'function sign(){ return aaReq; }',
  ].join('\n');
  assert.deepEqual(extractClientCrypto(legacy), {
    maskHex: 'a39b86dbbcf57f884f3e9074969e7fe26656c74012e4545605896621ffa441c1',
    buildId: '63',
  });

  const current = [
    'noise aaReq',
    'const Ba=ht(383)!=="string"?"70bb5e6260e19a806b3609dc0b6eb718899b09edbd0c23703a5de00e544de128":"",ln="64";',
  ].join('\n');
  assert.deepEqual(extractClientCrypto(current), {
    maskHex: '70bb5e6260e19a806b3609dc0b6eb718899b09edbd0c23703a5de00e544de128',
    buildId: '64',
  });
});

test('deriveKey XORs the client mask with partB', () => {
  const mask = Buffer.alloc(32, 0x0f);
  const partB = Buffer.alloc(32, 0xf0);
  assert.equal(deriveKey(mask, partB).toString('hex'), Buffer.alloc(32, 0xff).toString('hex'));
});

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..', '..');

test('Termux and Docker install the same patched ani-cli sources', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const installer = fs.readFileSync(path.join(root, 'scripts', 'install-termux.sh'), 'utf8');
  const urls = [...dockerfile.matchAll(/https:\/\/raw\.githubusercontent\.com\/pystardust\/ani-cli\/[^\s]+\/ani-cli/g)]
    .map((match) => match[0]);
  assert.equal(urls.length, 2);
  for (const url of urls) assert.match(installer, new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(installer, /patch-ani-cli-crypto\.js/);
  assert.match(installer, /sh -n "\$PATCH_DIR\/ani-cli"/);
});

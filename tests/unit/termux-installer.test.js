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
  assert.equal(urls.length, 1);
  assert.match(urls[0], /cc45a5530af350fb0e1a759e1d962814df5876fe/);
  assert.match(installer, new RegExp(urls[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(dockerfile, /mkissa-crypto\.js/);
  assert.match(installer, /patch-ani-cli-crypto\.js/);
  assert.match(installer, /sh -n "\$PATCH_DIR\/ani-cli"/);
  assert.doesNotMatch(installer, /ani-cli-reference/);
});

test('Termux installer accepts BRANCH while keeping main as the default', () => {
  const installer = fs.readFileSync(path.join(root, 'scripts', 'install-termux.sh'), 'utf8');
  assert.match(installer, /BRANCH="\$\{ANIMANGA_BRANCH:-\$\{ANI_WEB_BRANCH:-\$\{BRANCH:-main\}\}\}"/);
  assert.match(installer, /fetch origin "\$BRANCH:refs\/remotes\/origin\/\$BRANCH"/);
  assert.match(installer, /checkout -b "\$BRANCH" --track "origin\/\$BRANCH"/);
});

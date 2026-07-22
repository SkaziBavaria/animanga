'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..', '..');

test('Termux and Docker provide ffmpeg downloads without installing ani-cli', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const installer = fs.readFileSync(path.join(root, 'scripts', 'install-termux.sh'), 'utf8');
  const startSh = fs.readFileSync(path.join(root, 'start.sh'), 'utf8');
  assert.match(dockerfile, /ca-certificates ffmpeg/);
  assert.match(dockerfile, /ANIMANGA_ANI_CLI_FALLBACK=0/);
  assert.match(installer, /pkg install -y .*ffmpeg/);
  assert.match(installer, /command -v ffmpeg/);
  assert.doesNotMatch(dockerfile, /pystardust|patch-ani-cli|\/usr\/local\/bin\/ani-cli/);
  assert.doesNotMatch(installer, /pystardust|patch-ani-cli|ANI_CLI_STABLE_URL/);
  assert.doesNotMatch(startSh, /refresh-ani-cli-crypto/);
});

test('Termux installer accepts BRANCH while keeping main as the default', () => {
  const installer = fs.readFileSync(path.join(root, 'scripts', 'install-termux.sh'), 'utf8');
  assert.match(installer, /BRANCH="\$\{ANIMANGA_BRANCH:-\$\{ANI_WEB_BRANCH:-\$\{BRANCH:-main\}\}\}"/);
  assert.match(installer, /fetch origin "\$BRANCH:refs\/remotes\/origin\/\$BRANCH"/);
  assert.match(installer, /checkout -b "\$BRANCH" --track "origin\/\$BRANCH"/);
});

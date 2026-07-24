'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..', '..');

test('Termux and Docker provide ffmpeg downloads without ani-cli', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const installer = fs.readFileSync(path.join(root, 'scripts', 'install-termux.sh'), 'utf8');
  const startSh = fs.readFileSync(path.join(root, 'start.sh'), 'utf8');
  assert.match(dockerfile, /ca-certificates ffmpeg/);
  assert.match(dockerfile, /FROM node:24-bookworm-slim/);
  assert.match(dockerfile, /ENTRYPOINT \["animanga-entrypoint"\]/);
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.match(dockerfile, /\/usr\/local\/lib\/node_modules\/npm/);
  assert.doesNotMatch(dockerfile, /\bgosu\b/);
  assert.doesNotMatch(dockerfile, /ANI_CLI|ani-cli/);
  assert.match(fs.readFileSync(path.join(root, 'scripts', 'docker-entrypoint.sh'), 'utf8'), /setpriv/);
  assert.match(
    fs.readFileSync(path.join(root, '.github', 'workflows', 'container-security.yml'), 'utf8'),
    /only-fixed:\s*true/,
  );
  assert.match(installer, /pkg install -y .*ffmpeg/);
  assert.match(installer, /command -v ffmpeg/);
  assert.doesNotMatch(installer, /ANI_WEB_|ani-cli|bin\/ani-web/);
  assert.doesNotMatch(startSh, /ANI_WEB_|ANI_CLI|ani-cli/);
});

test('Termux installer accepts BRANCH while keeping main as the default', () => {
  const installer = fs.readFileSync(path.join(root, 'scripts', 'install-termux.sh'), 'utf8');
  assert.match(installer, /BRANCH="\$\{ANIMANGA_BRANCH:-\$\{BRANCH:-main\}\}"/);
  assert.match(installer, /fetch origin "\$BRANCH:refs\/remotes\/origin\/\$BRANCH"/);
  assert.match(installer, /checkout -b "\$BRANCH" --track "origin\/\$BRANCH"/);
  assert.match(installer, /\$PREFIX\/bin\/animanga/);
  assert.doesNotMatch(installer, /bin\/ani-web/);
});

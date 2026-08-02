'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..', '..');

test('Docker image provides ffmpeg downloads via the built-in runtime', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /ca-certificates curl ffmpeg/);
  assert.match(dockerfile, /curl-impersonate/);
  assert.match(dockerfile, /curl_chrome136/);
  assert.match(dockerfile, /FROM node:24-bookworm-slim/);
  assert.match(dockerfile, /ENTRYPOINT \["animanga-entrypoint"\]/);
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.match(dockerfile, /\/usr\/local\/lib\/node_modules\/npm/);
  assert.doesNotMatch(dockerfile, /\bgosu\b/);
  assert.doesNotMatch(dockerfile, /ANI_CLI|ani-cli/);
  const entrypoint = fs.readFileSync(path.join(root, 'scripts', 'docker-entrypoint.sh'), 'utf8');
  assert.match(entrypoint, /setpriv/);
  assert.match(entrypoint, /export HOME=\/home\/node/);
  assert.match(
    fs.readFileSync(path.join(root, '.github', 'workflows', 'container-security.yml'), 'utf8'),
    /only-fixed:\s*true/,
  );
});

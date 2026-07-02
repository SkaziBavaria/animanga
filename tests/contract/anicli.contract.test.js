'use strict';

// Smoke test for the ani-cli dependency (installed from upstream master in the
// Docker image / CI). Enable with RUN_CONTRACT=1.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const opts = { skip: process.env.RUN_CONTRACT === '1' ? false : 'set RUN_CONTRACT=1 to run ani-cli smoke test' };
const BIN = process.env.ANI_CLI_BIN || 'ani-cli';

test('ani-cli is installed and runnable', opts, () => {
  const res = spawnSync(BIN, ['--version'], { encoding: 'utf8' });
  assert.equal(res.error, undefined, `ani-cli should be spawnable: ${res.error?.message || ''}`);
  const output = `${res.stdout || ''}${res.stderr || ''}`;
  assert.ok(output.trim().length > 0, 'ani-cli should print version/help output');
});

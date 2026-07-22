'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..', '..');

test('server closes cleanly on SIGTERM', { timeout: 10_000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'animanga-shutdown-'));
  const port = 20_000 + (process.pid % 20_000);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      ANIMANGA_HOST: '127.0.0.1',
      ANIMANGA_PORT: String(port),
      ANIMANGA_DATA_DIR: dataDir,
      ANIMANGA_DOWNLOAD_DIR: path.join(dataDir, 'downloads'),
      ANI_CLI_HIST_DIR: path.join(dataDir, 'history'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server did not start:\n${output}`)), 5000);
    child.stdout.on('data', () => {
      if (!output.includes(`Listening on 127.0.0.1:${port}`)) return;
      clearTimeout(timeout);
      resolve();
    });
    child.once('error', reject);
  });

  child.kill('SIGTERM');
  const result = await new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(result, { code: 0, signal: null });
  assert.match(output, /AniManga stopped cleanly/);
});

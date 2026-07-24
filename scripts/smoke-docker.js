'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const pkg = require('../package.json');

const root = path.join(__dirname, '..');

function fail(message) {
  process.stderr.write(`docker smoke: ${message}\n`);
  process.exitCode = 1;
}

function run(args, options = {}) {
  const result = spawnSync('docker', args, {
    cwd: options.cwd || root,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    fail(`command failed: docker ${args.join(' ')}\n${result.stdout || ''}${result.stderr || ''}`);
    throw new Error('abort');
  }
  return result;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForStatus(url, timeoutMs = 120_000) {
  const started = Date.now();
  let lastError = '';
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (response.ok) {
        const body = await response.json();
        if (body?.ok && body?.version === pkg.version) return body;
        lastError = `unexpected status payload: ${JSON.stringify(body)}`;
      } else {
        lastError = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastError = error.message;
    }
    await wait(2000);
  }
  throw new Error(`server did not become ready: ${lastError}`);
}

async function main() {
  const project = `animanga-smoke-${process.pid}`;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'animanga-docker-smoke-'));
  const dataDir = path.join(work, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const port = 27831 + Math.floor(Math.random() * 1000);
  const env = {
    ANIMANGA_BIND_ADDRESS: '127.0.0.1',
    ANIMANGA_PUBLISH_PORT: String(port),
    ANIMANGA_DATA_VOLUME: dataDir,
    COMPOSE_PROJECT_NAME: project,
  };

  process.stdout.write(`docker smoke: building and starting on ${port}\n`);
  try {
    run(['compose', '-f', path.join(root, 'docker-compose.yml'), 'up', '-d', '--build'], { env });

    const status = await waitForStatus(`http://127.0.0.1:${port}/api/status`);
    if (status.install !== 'docker') {
      throw new Error(`expected install=docker, got ${status.install}`);
    }
    process.stdout.write(`docker smoke: ok version=${status.version} install=${status.install}\n`);
  } finally {
    run(['compose', '-f', path.join(root, 'docker-compose.yml'), 'down', '-v', '--remove-orphans'], { env });
    try {
      fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (error) {
      process.stderr.write(`docker smoke: cleanup warning: ${error.message}\n`);
    }
  }
}

main().catch((error) => {
  fail(error.message || String(error));
});

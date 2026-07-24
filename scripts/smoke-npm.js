'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const pkg = require('../package.json');

const root = path.join(__dirname, '..');
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function fail(message) {
  process.stderr.write(`npm smoke: ${message}\n`);
  process.exitCode = 1;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    env: { ...process.env, ...(options.env || {}) },
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    fail(`command failed: ${command} ${args.join(' ')}\n${result.stdout || ''}${result.stderr || ''}`);
    throw new Error('abort');
  }
  return result;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForStatus(url, timeoutMs = 30_000) {
  const started = Date.now();
  let lastError = '';
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
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
    await wait(500);
  }
  throw new Error(`server did not become ready: ${lastError}`);
}

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'animanga-npm-smoke-'));
  const prefix = path.join(work, 'prefix');
  const dataDir = path.join(work, 'data');
  const port = 17831 + Math.floor(Math.random() * 1000);
  fs.mkdirSync(prefix, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  process.stdout.write(`npm smoke: packing in ${work}\n`);
  run(npmCmd, ['pack', '--ignore-scripts', '--pack-destination', work]);
  const tarball = fs.readdirSync(work).find((name) => name.endsWith('.tgz'));
  if (!tarball) throw new Error('npm pack produced no tarball');

  const listing = run(process.platform === 'win32' ? 'tar.exe' : 'tar', ['-tzf', path.join(work, tarball)]);
  for (const required of [
    'package/bin/animanga.js',
    'package/server.js',
    'package/lib/config.js',
    'package/public/index.html',
  ]) {
    if (!listing.stdout.includes(required)) throw new Error(`tarball missing ${required}`);
  }

  process.stdout.write(`npm smoke: installing ${tarball}\n`);
  run(npmCmd, ['install', '-g', '--prefix', prefix, path.join(work, tarball)]);

  const binDir = process.platform === 'win32'
    ? path.join(prefix)
    : path.join(prefix, 'bin');
  const animangaBin = process.platform === 'win32'
    ? path.join(prefix, 'animanga.cmd')
    : path.join(prefix, 'bin', 'animanga');
  if (!fs.existsSync(animangaBin)) throw new Error(`missing installed binary: ${animangaBin}`);

  const version = run(animangaBin, ['--version'], {
    env: { PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}` },
  });
  if (version.stdout.trim() !== pkg.version) {
    throw new Error(`expected version ${pkg.version}, got ${version.stdout.trim()}`);
  }

  process.stdout.write(`npm smoke: starting server on ${port}\n`);
  const child = spawn(animangaBin, ['start', '--host', '127.0.0.1', '--port', String(port), '--data-dir', dataDir], {
    cwd: work,
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
      ANIMANGA_CLIENT_PLAYBACK: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });

  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });

  const stopServer = async () => {
    if (child.exitCode !== null || child.killed) return;
    if (process.platform === 'win32' && child.pid) {
      spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
    const started = Date.now();
    while (child.exitCode === null && Date.now() - started < 5000) await wait(100);
  };

  try {
    const status = await waitForStatus(`http://127.0.0.1:${port}/api/status`);
    process.stdout.write(`npm smoke: ok version=${status.version} install=${status.install}\n`);
  } catch (error) {
    process.stderr.write(output);
    throw error;
  } finally {
    await stopServer();
    await wait(500);
    try {
      fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (error) {
      process.stderr.write(`npm smoke: cleanup warning: ${error.message}\n`);
    }
  }
}

main().catch((error) => {
  fail(error.message || String(error));
});

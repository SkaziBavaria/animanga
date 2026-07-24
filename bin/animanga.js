#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const pkg = require('../package.json');

function usage() {
  return `AniManga ${pkg.version}

Usage:
  animanga [start] [options]
  animanga doctor

Options:
  --host <address>       Listen address (default: 127.0.0.1)
  --port <number>        Listen port (default: 7831)
  --data-dir <path>      Persistent data directory
  -h, --help             Show this help
  -v, --version          Show the installed version
`;
}

function takeValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith('-')) throw new Error(`${flag} requires a value`);
  return value;
}

function configureStart(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--host') process.env.ANIMANGA_HOST = takeValue(args, index++, arg);
    else if (arg === '--port') process.env.ANIMANGA_PORT = takeValue(args, index++, arg);
    else if (arg === '--data-dir') process.env.ANIMANGA_DATA_DIR = path.resolve(takeValue(args, index++, arg));
    else if (arg === '-h' || arg === '--help') {
      process.stdout.write(usage());
      return false;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return true;
}

function executable(name) {
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'sh', process.platform === 'win32'
    ? [name]
    : ['-c', 'command -v "$1" >/dev/null 2>&1', 'sh', name]);
  return result.status === 0;
}

async function doctor() {
  const checks = [];
  const add = (name, ok, detail, required = true) => checks.push({ name, ok, detail, required });
  const [major, minor] = process.versions.node.split('.').map(Number);
  add('Node.js', major > 22 || major === 22 && minor >= 16, process.version);
  try {
    require('node:sqlite');
    add('SQLite', true, 'node:sqlite available');
  } catch (error) {
    add('SQLite', false, error.message);
  }

  const { DATA_DIR, ALLANIME_API } = require('../lib/config');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const probe = path.join(DATA_DIR, `.doctor-${process.pid}`);
    fs.writeFileSync(probe, 'ok', { flag: 'wx' });
    fs.unlinkSync(probe);
    add('Data directory', true, DATA_DIR);
  } catch (error) {
    add('Data directory', false, `${DATA_DIR}: ${error.message}`);
  }

  try {
    const response = await fetch(ALLANIME_API, { method: 'HEAD', signal: AbortSignal.timeout(10_000) });
    add('AllAnime API', response.status < 500, `HTTP ${response.status}`, false);
  } catch (error) {
    add('AllAnime API', false, error.message, false);
  }

  try {
    const cryptoConfig = await require('../lib/mkissa-crypto').resolveCompleteCryptoConfig({
      forceRefresh: true,
      allowLastVerifiedFallback: false,
    });
    add('Provider crypto', true, `epoch ${cryptoConfig.epoch}, build ${cryptoConfig.buildId}`, false);
  } catch (error) {
    add('Provider crypto', false, error.message, false);
  }

  const { HOST, ACCESS_TOKEN, PUBLIC_URL } = require('../lib/config');
  const { isOpenBind } = require('../lib/bind-security');
  const inDocker = fs.existsSync('/.dockerenv');
  const allowInsecure = process.env.ANIMANGA_ALLOW_INSECURE === '1';
  if (isOpenBind(HOST) && !ACCESS_TOKEN && !inDocker && !allowInsecure) {
    add('Network bind', false, `${HOST} without ANIMANGA_ACCESS_TOKEN (server refuses to start)`, true);
  } else if (isOpenBind(HOST) && !ACCESS_TOKEN) {
    add('Network bind', false, `${HOST} without authentication (set ANIMANGA_ACCESS_TOKEN)`, false);
  } else if (isOpenBind(HOST)) {
    add('Network bind', true, `${HOST} with authentication enabled`);
  } else {
    add('Network bind', true, `${HOST}`);
  }

  if (PUBLIC_URL) {
    add('Public URL', true, PUBLIC_URL, false);
  } else if (isOpenBind(HOST)) {
    add('Public URL', false, 'ANIMANGA_PUBLIC_URL recommended for Google OAuth and reverse proxies', false);
  } else {
    add('Public URL', true, 'not set (ok on localhost)', false);
  }

  for (const [label, binary, missing] of [
    ['ffmpeg downloads', 'ffmpeg', 'not installed (anime downloads unavailable)'],
    ['mpv native player', 'mpv', 'not installed (optional)'],
  ]) {
    const available = executable(binary);
    add(label, available, available ? 'available' : missing, false);
  }

  for (const check of checks) {
    const label = check.ok ? 'OK' : check.required ? 'FAIL' : 'WARN';
    process.stdout.write(`${label.padEnd(4)} ${check.name}: ${check.detail}\n`);
  }
  if (checks.some((check) => check.required && !check.ok)) process.exitCode = 1;
}

async function main(argv) {
  const args = [...argv];
  if (args.includes('-v') || args.includes('--version')) {
    process.stdout.write(`${pkg.version}\n`);
    return;
  }
  if (args[0] === '-h' || args[0] === '--help' || args[0] === 'help') {
    process.stdout.write(usage());
    return;
  }

  const command = args[0] && !args[0].startsWith('-') ? args.shift() : 'start';
  if (command === 'doctor') {
    if (args.length) throw new Error(`Unknown doctor option: ${args[0]}`);
    await doctor();
    return;
  }
  if (command !== 'start') throw new Error(`Unknown command: ${command}`);
  if (!configureStart(args)) return;
  require('../server');
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`AniManga: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { configureStart, usage, doctor, main };

'use strict';

const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { ANI_CLI, JOB_LOG_DIR, ALLANIME_REFERER } = require('../config');
const registry = require('../registry');
const { readState } = require('../state');
const { aniCliQueryTitle, normalizeEpisode, normalizeMode } = require('../episodes');
const { commandExists, isUtilLinuxScript, shellJoinCommand, stripAnsi } = require('../process');
const { searchAnime } = require('../allanime');

function clientPlaybackEnabled() {
  const setting = process.env.ANIMANGA_CLIENT_PLAYBACK ?? process.env.ANI_WEB_CLIENT_PLAYBACK;
  if (setting === '0') return false;
  if (setting === '1') return true;
  return !commandExists('am');
}

function parseDebugPlayback(output) {
  const text = stripAnsi(output);
  const url = text.match(/Selected link:\s*\n([^\s]+)/)?.[1]?.trim();
  if (!url) throw new Error('ani-cli did not find a playable link');
  const linkLine = text.split(/\r?\n/).find((line) => line.includes(`>${url}`) || line.endsWith(url)) || '';
  let referrer = ALLANIME_REFERER;
  if (/mp4upload/i.test(linkLine)) referrer = 'https://www.mp4upload.com';
  if (/sharepoint/i.test(linkLine)) referrer = '';
  return { url, referrer };
}

function resolvePlaybackMode(body) {
  const browserPlayer = body.player === 'android_mpv'
    || body.player === 'vlc'
    || !body.player
    || body.player === 'default';
  const useBrowserPlayback = !body.download && (
    body.clientPlayback
    || body.resolveOnly
    || browserPlayer && (clientPlaybackEnabled() || commandExists('am'))
  );
  const usePtyAniCli = !body.download
    && !useBrowserPlayback
    && (body.player === 'android_mpv'
      || (!body.player || body.player === 'default') && commandExists('am'));
  return { useBrowserPlayback, usePtyAniCli };
}

async function resolveAniCliIndex(payload, mode) {
  const queryTitle = aniCliQueryTitle(payload);
  if (!queryTitle) throw new Error('Missing title');
  if (!payload.id) return Number(payload.index) || 1;
  const found = (await searchAnime(queryTitle, mode)).find((item) => item.id === payload.id);
  if (!found) throw new Error('Could not find the anime in the ani-cli search right now');
  return found.index;
}

async function buildAniCliArgs(payload) {
  const state = readState();
  const mode = normalizeMode(payload.mode || state.settings.mode);
  const queryTitle = aniCliQueryTitle(payload);
  if (!queryTitle) throw new Error('Missing title');
  const args = [];
  if (mode === 'dub') args.push('--dub');
  if (payload.quality) args.push('-q', String(payload.quality));
  if (payload.player === 'vlc') args.push('--vlc');
  if (payload.download) args.push('--download');
  args.push('-S', String(await resolveAniCliIndex(payload, mode)));
  if (payload.episode) args.push('-e', normalizeEpisode(payload.episode));
  args.push(queryTitle);
  return args;
}

function createJob(label, args) {
  const job = {
    id: crypto.randomUUID(),
    label,
    args,
    status: 'running',
    output: '',
    startedAt: new Date().toISOString(),
  };
  registry.jobs.set(job.id, job);
  return job;
}

function spawnAniCli(args, envPatch = {}, options = {}) {
  return spawn(ANI_CLI, args, {
    cwd: os.homedir(),
    env: { ...process.env, ANI_CLI_EXTERNAL_MENU: '0', ...envPatch },
    ...options,
  });
}

function pipeJobOutput(job, child) {
  const append = (chunk) => {
    job.output = `${job.output}${chunk.toString('utf8')}`.slice(-16000);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
}

function finalizeJob(job, code, signal) {
  Object.assign(job, { status: code === 0 ? 'done' : 'failed', exitCode: code, signal, finishedAt: new Date().toISOString() });
}

function startPtyJob(label, args, envPatch = {}) {
  const id = crypto.randomUUID();
  const logFile = path.join(JOB_LOG_DIR, `${id}.log`);
  const job = {
    id,
    label,
    args,
    status: 'running',
    output: 'Starting ani-cli in a pseudo-terminal via script',
    logFile,
    startedAt: new Date().toISOString(),
  };
  registry.jobs.set(id, job);
  const scriptArgs = isUtilLinuxScript()
    ? ['-q', '-e', '-O', logFile, '-c', shellJoinCommand(ANI_CLI, args)]
    : ['-q', '-e', '-O', logFile, '--', ANI_CLI, ...args];
  const child = spawn('timeout', ['-k', '5', '45', 'script', ...scriptArgs], {
    cwd: os.homedir(),
    env: { ...process.env, ANI_CLI_EXTERNAL_MENU: '0', ...envPatch },
    stdio: 'ignore',
    detached: true,
  });
  job.pid = child.pid;
  child.on('error', (error) => Object.assign(job, {
    status: 'failed',
    error: error.message,
    finishedAt: new Date().toISOString(),
  }));
  child.unref();
  Object.assign(job, { status: 'launched', finishedAt: new Date().toISOString() });
  return job;
}

function runJobAndWait(label, args, envPatch = {}) {
  const job = createJob(label, args);
  return new Promise((resolve) => {
    const child = spawnAniCli(args, envPatch, { stdio: ['ignore', 'pipe', 'pipe'] });
    job.pid = child.pid;
    pipeJobOutput(job, child);
    child.on('error', (error) => {
      Object.assign(job, {
        status: 'failed',
        error: error.message,
        finishedAt: new Date().toISOString(),
      });
      resolve(job);
    });
    child.on('close', (code, signal) => {
      finalizeJob(job, code, signal);
      resolve(job);
    });
  });
}

module.exports = {
  buildAniCliArgs,
  resolveAniCliIndex,
  parseDebugPlayback,
  clientPlaybackEnabled,
  resolvePlaybackMode,
  startPtyJob,
  runJobAndWait,
};

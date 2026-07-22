'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const {
  ANI_CLI,
  JOB_LOG_DIR,
  ALLANIME_REFERER,
  DOWNLOAD_CONCURRENCY,
} = require('./config');
const registry = require('./registry');
const { readState } = require('./state');
const { aniCliQueryTitle, normalizeEpisode, normalizeMode } = require('./episodes');
const {
  commandExists,
  isUtilLinuxScript,
  shellJoinCommand,
  spawnWithScriptLog,
  stripAnsi,
} = require('./process');
const { searchAnime } = require('./allanime');

function clientPlaybackEnabled() {
  const setting = process.env.ANIMANGA_CLIENT_PLAYBACK ?? process.env.ANI_WEB_CLIENT_PLAYBACK;
  if (setting === '0') return false;
  if (setting === '1') return true;
  return !commandExists('am');
}

function parseDebugPlayback(output) {
  const text = stripAnsi(output);
  const selected = text.match(/Selected link:\s*\n([^\s]+)/);
  const url = selected?.[1]?.trim();
  if (!url) throw new Error('ani-cli did not find a playable link');

  const linkLine = text
    .split(/\r?\n/)
    .find((line) => line.includes(`>${url}`) || line.endsWith(url)) || '';
  let referrer = ALLANIME_REFERER;
  if (/mp4upload/i.test(linkLine)) referrer = 'https://www.mp4upload.com';
  if (/sharepoint/i.test(linkLine)) referrer = '';

  return { url, referrer };
}

function resolvePlaybackMode(body) {
  const useBrowserPlayback = !body.download && (
    body.clientPlayback ||
    body.resolveOnly ||
    clientPlaybackEnabled() && (
      body.player === 'android_mpv' ||
      body.player === 'vlc' ||
      !body.player ||
      body.player === 'default'
    ) ||
    (
      body.player === 'android_mpv' ||
      body.player === 'vlc' ||
      !body.player ||
      body.player === 'default'
    ) && commandExists('am')
  );
  const usePtyAniCli = !body.download && !useBrowserPlayback && (
    body.player === 'android_mpv' ||
    (!body.player || body.player === 'default') && commandExists('am')
  );
  return { useBrowserPlayback, usePtyAniCli };
}

async function resolveAniCliIndex(payload, mode) {
  const queryTitle = aniCliQueryTitle(payload);
  if (!queryTitle) throw new Error('Missing title');
  if (!payload.id) return Number(payload.index) || 1;

  const results = await searchAnime(queryTitle, mode);
  const found = results.find((item) => item.id === payload.id);
  if (!found) throw new Error('Could not find the anime in the ani-cli search right now');
  return found.index;
}

async function buildAniCliArgs(payload) {
  const state = readState();
  const mode = normalizeMode(payload.mode || state.settings.mode);
  const queryTitle = aniCliQueryTitle(payload);
  if (!queryTitle) throw new Error('Missing title');

  const index = await resolveAniCliIndex(payload, mode);

  const args = [];
  if (mode === 'dub') args.push('--dub');
  if (payload.quality) args.push('-q', String(payload.quality));
  if (payload.player === 'vlc') args.push('--vlc');
  if (payload.download) args.push('--download');
  args.push('-S', String(index));
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
  job.status = code === 0 ? 'done' : 'failed';
  job.exitCode = code;
  job.signal = signal;
  job.finishedAt = new Date().toISOString();
}

function failJob(job, err) {
  job.status = 'failed';
  job.error = err.message;
  job.finishedAt = new Date().toISOString();
}

function startJob(label, args, envPatch = {}, wait = false) {
  const job = createJob(label, args);
  const child = spawnAniCli(args, envPatch, {
    stdio: wait ? ['ignore', 'pipe', 'pipe'] : 'ignore',
    detached: !wait,
  });

  job.pid = child.pid;
  child.on('error', (err) => failJob(job, err));

  if (!wait) {
    child.unref();
    job.status = 'launched';
    job.finishedAt = new Date().toISOString();
    return job;
  }

  pipeJobOutput(job, child);
  child.on('close', (code, signal) => finalizeJob(job, code, signal));
  return job;
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
  child.on('error', (err) => {
    job.status = 'failed';
    job.error = err.message;
    job.finishedAt = new Date().toISOString();
  });
  child.unref();
  job.status = 'launched';
  job.finishedAt = new Date().toISOString();
  return job;
}

function startBackgroundJob(label, args, envPatch = {}, onUpdate = null) {
  const id = crypto.randomUUID();
  const logFile = path.join(JOB_LOG_DIR, `${id}.log`);
  const job = {
    id,
    label,
    args,
    status: 'queued',
    output: 'Queued for download',
    logFile,
    queuedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
  };
  registry.jobs.set(id, job);
  registry.downloadQueue.push({ job, args, envPatch, onUpdate, cancelled: false });
  setImmediate(processDownloadQueue);
  return job;
}

function processDownloadQueue() {
  while (registry.activeDownloads < DOWNLOAD_CONCURRENCY && registry.downloadQueue.length) {
    registry.activeDownloads += 1;
    runBackgroundJob(registry.downloadQueue.shift());
  }
}

function runBackgroundJob(item) {
  const { job, args, envPatch, onUpdate } = item;
  if (item.cancelled || job.status === 'cancelled') {
    onUpdate?.(job);
    return;
  }
  job.status = 'running';
  job.output = 'Download running';
  job.runStartedAt = new Date().toISOString();
  onUpdate?.(job);

  fs.writeFileSync(job.logFile, `${job.output}\n`, { flag: 'a' });
  const { child, closeOutput } = spawnWithScriptLog(job.logFile, ANI_CLI, args, envPatch);

  job.pid = child.pid;
  job.child = child;
  let outputClosed = false;
  let finished = false;
  const closeOutputSafe = () => {
    if (outputClosed) return;
    outputClosed = true;
    closeOutput();
  };
  const finish = () => {
    if (finished) return;
    finished = true;
    registry.activeDownloads = Math.max(0, registry.activeDownloads - 1);
    processDownloadQueue();
  };
  child.on('error', (err) => {
    closeOutputSafe();
    job.status = 'failed';
    job.error = err.message;
    job.finishedAt = new Date().toISOString();
    onUpdate?.(job);
    finish();
  });
  child.on('close', (code, signal) => {
    closeOutputSafe();
    job.status = job.status === 'cancelled' ? 'cancelled' : code === 0 ? 'done' : 'failed';
    job.exitCode = code;
    job.signal = signal;
    job.finishedAt = new Date().toISOString();
    onUpdate?.(job);
    finish();
  });
}

function hydrateJobLog(job) {
  if (!job?.logFile) return job;
  try {
    const output = fs.readFileSync(job.logFile, 'utf8');
    return {
      ...job,
      output: `${job.output || ''}${output ? `\n${output}` : ''}`.slice(-16000),
    };
  } catch {
    return job;
  }
}

function clearJobLogs() {
  const entries = fs.readdirSync(JOB_LOG_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    fs.rmSync(path.join(JOB_LOG_DIR, entry.name), { force: true });
  }
}

function runJobAndWait(label, args, envPatch = {}) {
  const job = createJob(label, args);
  return new Promise((resolve) => {
    const child = spawnAniCli(args, envPatch, { stdio: ['ignore', 'pipe', 'pipe'] });
    job.pid = child.pid;
    pipeJobOutput(job, child);
    child.on('error', (err) => {
      failJob(job, err);
      resolve(job);
    });
    child.on('close', (code, signal) => {
      finalizeJob(job, code, signal);
      resolve(job);
    });
  });
}

function parseArgsLine(input) {
  const args = [];
  let current = '';
  let quote = '';
  let escaped = false;
  for (const char of String(input || '')) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current) args.push(current);
  if (quote) throw new Error('Unclosed quote');
  return args;
}

module.exports = {
  buildAniCliArgs,
  resolveAniCliIndex,
  parseDebugPlayback,
  clientPlaybackEnabled,
  resolvePlaybackMode,
  startJob,
  startPtyJob,
  startBackgroundJob,
  processDownloadQueue,
  runBackgroundJob,
  hydrateJobLog,
  clearJobLogs,
  runJobAndWait,
  parseArgsLine,
};

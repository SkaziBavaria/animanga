'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { JOB_LOG_DIR, DOWNLOAD_CONCURRENCY } = require('./config');
const registry = require('./registry');

const DOWNLOAD_IDLE_TIMEOUT_MS = 3 * 60_000;

function readFfmpegProgress(logFile, startOffset = 0) {
  let fd;
  try {
    const stat = fs.statSync(logFile);
    const start = Math.max(0, Number(startOffset) || 0);
    const available = Math.max(0, stat.size - start);
    const length = Math.min(available, 32 * 1024);
    const buffer = Buffer.alloc(length);
    fd = fs.openSync(logFile, 'r');
    fs.readSync(fd, buffer, 0, length, Math.max(start, stat.size - length));
    const text = buffer.toString('utf8');
    const last = (key) => [...text.matchAll(new RegExp(`^${key}=(.*)$`, 'gm'))].at(-1)?.[1]?.trim();
    const outTimeUs = Number(last('out_time_us'));
    const totalBytes = Number(last('total_size'));
    const rawSpeed = last('speed');
    return {
      ...(Number.isFinite(outTimeUs) && outTimeUs >= 0 ? { outTimeUs } : {}),
      ...(Number.isFinite(totalBytes) && totalBytes >= 0 ? { totalBytes } : {}),
      ...(rawSpeed && rawSpeed !== 'N/A' && Number.isFinite(Number.parseFloat(rawSpeed))
        ? { speed: Number.parseFloat(rawSpeed) } : {}),
    };
  } catch {
    return {};
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function downloadConcurrencyLimit() {
  try {
    const { readState } = require('./state');
    const raw = Number(readState().settings?.downloadConcurrency);
    if (Number.isFinite(raw) && raw >= 1) return Math.min(8, Math.floor(raw));
  } catch {}
  return DOWNLOAD_CONCURRENCY;
}

function startBackgroundTask(label, task, onUpdate = null) {
  fs.mkdirSync(JOB_LOG_DIR, { recursive: true });
  const id = crypto.randomUUID();
  const logFile = path.join(JOB_LOG_DIR, `${id}.log`);
  const job = {
    id,
    label,
    args: [],
    status: 'queued',
    output: 'Queued for download',
    logFile,
    queuedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
  };
  registry.jobs.set(id, job);
  registry.downloadQueue.push({ job, task, onUpdate, cancelled: false });
  setImmediate(processDownloadQueue);
  return job;
}

function processDownloadQueue() {
  const limit = downloadConcurrencyLimit();
  while (registry.activeDownloads < limit && registry.downloadQueue.length) {
    registry.activeDownloads += 1;
    runBackgroundTask(registry.downloadQueue.shift());
  }
}

async function runBackgroundTask(item) {
  const { job, task, onUpdate } = item;
  if (item.cancelled || job.status === 'cancelled') {
    onUpdate?.(job);
    registry.activeDownloads = Math.max(0, registry.activeDownloads - 1);
    processDownloadQueue();
    return;
  }
  job.status = 'running';
  job.output = 'Resolving download source';
  job.runStartedAt = new Date().toISOString();
  onUpdate?.(job);
  fs.writeFileSync(job.logFile, `${job.output}\n`, { flag: 'a' });
  try {
    await task(job);
    if (job.status !== 'cancelled') job.status = 'done';
  } catch (error) {
    if (job.status !== 'cancelled') {
      job.status = 'failed';
      job.error = error.message;
      job.errorCode = error.code || null;
    }
  } finally {
    job.finishedAt = new Date().toISOString();
    onUpdate?.(job);
    registry.activeDownloads = Math.max(0, registry.activeDownloads - 1);
    processDownloadQueue();
  }
}

function spawnWorkingDirectory() {
  for (const dir of [os.homedir(), process.cwd(), os.tmpdir()]) {
    try {
      fs.accessSync(dir, fs.constants.R_OK | fs.constants.X_OK);
      return dir;
    } catch {}
  }
  return process.cwd();
}

function runLoggedProcess(job, command, args, envPatch = {}, {
  idleTimeoutMs = DOWNLOAD_IDLE_TIMEOUT_MS,
  monitorProgress = command === 'ffmpeg' && args.includes('-progress'),
} = {}) {
  return new Promise((resolve, reject) => {
    const output = fs.openSync(job.logFile, 'a');
    const progressStartOffset = fs.fstatSync(output).size;
    const child = spawn(command, args, {
      cwd: spawnWorkingDirectory(),
      env: { ...process.env, ...envPatch },
      stdio: ['ignore', output, output],
    });
    Object.assign(job, { command, args, pid: child.pid, child });
    let settled = false;
    let idleError = null;
    let lastProgressAt = Date.now();
    let lastOutTimeUs = 0;
    let lastTotalBytes = 0;
    const processStartedAt = Date.now();
    const monitor = monitorProgress
      ? setInterval(() => {
        const progress = readFfmpegProgress(job.logFile, progressStartOffset);
        const outTimeUs = progress.outTimeUs ?? lastOutTimeUs;
        const totalBytes = progress.totalBytes ?? lastTotalBytes;
        if (outTimeUs > lastOutTimeUs || totalBytes > lastTotalBytes) lastProgressAt = Date.now();
        lastOutTimeUs = Math.max(lastOutTimeUs, outTimeUs);
        lastTotalBytes = Math.max(lastTotalBytes, totalBytes);
        const now = Date.now();
        job.downloadProgress = {
          phase: 'downloading',
          elapsedSeconds: Math.floor((now - processStartedAt) / 1000),
          idleSeconds: Math.floor((now - lastProgressAt) / 1000),
          lastProgressAt: new Date(lastProgressAt).toISOString(),
          outTimeUs: lastOutTimeUs,
          totalBytes: lastTotalBytes,
          ...(progress.speed == null ? {} : { speed: progress.speed }),
        };
        if (!idleError && now - lastProgressAt >= idleTimeoutMs) {
          idleError = Object.assign(
            new Error(`No video data received for ${Math.ceil(idleTimeoutMs / 60_000)} minutes; the source or network stopped responding`),
            { code: 'DOWNLOAD_STALLED' },
          );
          child.kill('SIGTERM');
          const forceKill = setTimeout(() => {
            if (child.exitCode == null && child.signalCode == null) child.kill('SIGKILL');
          }, 2_000);
          forceKill.unref();
        }
      }, Math.min(1000, Math.max(100, idleTimeoutMs / 10)))
      : null;
    monitor?.unref();
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      if (monitor) clearInterval(monitor);
      try { fs.closeSync(output); } catch {}
      callback();
    };
    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (code, signal) => finish(() => {
      job.exitCode = code;
      job.signal = signal;
      if (job.status === 'cancelled') return reject(new Error('Download cancelled'));
      if (idleError) return reject(idleError);
      if (code !== 0) return reject(new Error(`${command} exited with code ${code}${signal ? ` (${signal})` : ''}`));
      resolve();
    }));
  });
}

function hydrateJobLog(job) {
  if (!job?.logFile) return job;
  try {
    const output = fs.readFileSync(job.logFile, 'utf8');
    return { ...job, output: `${job.output || ''}${output ? `\n${output}` : ''}`.slice(-16000) };
  } catch {
    return job;
  }
}

function clearJobLogs() {
  const entries = fs.readdirSync(JOB_LOG_DIR, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile()) fs.rmSync(path.join(JOB_LOG_DIR, entry.name), { force: true });
  }
}

async function shutdownJobs(timeoutMs = 3000) {
  for (const item of registry.downloadQueue.splice(0)) {
    item.cancelled = true;
    item.job.status = 'cancelled';
    item.job.finishedAt = new Date().toISOString();
    item.onUpdate?.(item.job);
  }
  for (const item of registry.mangaDownloadQueue.splice(0)) {
    item.job.cancelRequested = true;
    item.job.status = 'cancelled';
  }

  const children = Array.from(registry.jobs.values())
    .map((job) => job.child)
    .filter((child) => child && !child.killed);
  for (const child of children) {
    try { child.kill('SIGTERM'); } catch {}
  }
  await Promise.all(children.map((child) => new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once('close', finish);
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      finish();
    }, timeoutMs);
    timer.unref();
    child.once('close', () => clearTimeout(timer));
  })));

  const deadline = Date.now() + timeoutMs;
  while ((registry.activeDownloads || registry.activeMangaDownloads) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

module.exports = {
  downloadConcurrencyLimit,
  startBackgroundTask,
  processDownloadQueue,
  runBackgroundTask,
  runLoggedProcess,
  readFfmpegProgress,
  DOWNLOAD_IDLE_TIMEOUT_MS,
  spawnWorkingDirectory,
  hydrateJobLog,
  clearJobLogs,
  shutdownJobs,
};

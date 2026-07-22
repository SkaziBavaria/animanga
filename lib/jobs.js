'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { JOB_LOG_DIR, DOWNLOAD_CONCURRENCY } = require('./config');
const registry = require('./registry');

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
  while (registry.activeDownloads < DOWNLOAD_CONCURRENCY && registry.downloadQueue.length) {
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
    }
  } finally {
    job.finishedAt = new Date().toISOString();
    onUpdate?.(job);
    registry.activeDownloads = Math.max(0, registry.activeDownloads - 1);
    processDownloadQueue();
  }
}

function runLoggedProcess(job, command, args, envPatch = {}) {
  return new Promise((resolve, reject) => {
    const output = fs.openSync(job.logFile, 'a');
    const child = spawn(command, args, {
      cwd: os.homedir(),
      env: { ...process.env, ...envPatch },
      stdio: ['ignore', output, output],
    });
    Object.assign(job, { command, args, pid: child.pid, child });
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      try { fs.closeSync(output); } catch {}
      callback();
    };
    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (code, signal) => finish(() => {
      job.exitCode = code;
      job.signal = signal;
      if (job.status === 'cancelled') return reject(new Error('Download cancelled'));
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
  startBackgroundTask,
  processDownloadQueue,
  runBackgroundTask,
  runLoggedProcess,
  hydrateJobLog,
  clearJobLogs,
  shutdownJobs,
};

'use strict';

const fs = require('fs');
const path = require('path');
const { USER_AGENT } = require('./config');
const animeProvider = require('./anime-provider');
const { runLoggedProcess } = require('./jobs');

function ffmpegDownloadArgs(playback, outputPath) {
  const headers = [
    playback.referrer ? `Referer: ${playback.referrer}` : '',
    `User-Agent: ${USER_AGENT}`,
  ].filter(Boolean).join('\r\n');

  return [
    '-nostdin',
    '-hide_banner',
    '-loglevel', 'warning',
    '-y',
    '-user_agent', USER_AGENT,
    '-headers', `${headers}\r\n`,
    // Some HLS CDNs serve media segments with a non-media suffix.
    '-extension_picky', '0',
    '-rw_timeout', '20000000',
    '-reconnect', '1',
    '-reconnect_streamed', '1',
    '-reconnect_on_network_error', '1',
    '-reconnect_on_http_error', '408,429,5xx',
    '-reconnect_delay_max', '5',
    '-i', playback.url,
    '-map', '0:v:0?',
    '-map', '0:a:0?',
    '-c', 'copy',
    '-movflags', '+faststart',
    '-progress', 'pipe:2',
    '-nostats',
    outputPath,
  ];
}

function appendLog(job, message) {
  fs.appendFileSync(job.logFile, `${message}\n`);
  job.output = message;
}

function removePartial(filePath) {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {}
}

function createEpisodeDownloadTask(options, dependencies = {}) {
  const resolvePlayback = dependencies.resolvePlayback || ((options) => (
    animeProvider.playback({ shows: {} }, { id: options.showId, provider: 'hianime' }, options)
  ));
  const runProcess = dependencies.runProcess || runLoggedProcess;
  const outputPath = path.resolve(options.outputPath);
  const partialPath = `${outputPath}.part.mp4`;

  return async (job) => {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    removePartial(partialPath);

    try {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        job.downloadProgress = {
          phase: 'resolving', phaseStartedAt: new Date().toISOString(),
          elapsedSeconds: 0, idleSeconds: 0, outTimeUs: 0, totalBytes: 0,
        };
        try {
          const playback = await resolvePlayback({
            showId: options.showId,
            episode: options.episode,
            mode: options.mode,
            quality: options.quality,
          });
          if (job.status === 'cancelled') throw new Error('Download cancelled');

          appendLog(job, `Resolved ${playback.provider || 'catalog'}${playback.quality ? ` ${playback.quality}p` : ''}; downloading with ffmpeg`);
          job.downloadProgress = {
            phase: 'downloading', phaseStartedAt: new Date().toISOString(),
            elapsedSeconds: 0, idleSeconds: 0, outTimeUs: 0, totalBytes: 0,
          };
          await runProcess(job, 'ffmpeg', ffmpegDownloadArgs(playback, partialPath));
          if (job.status === 'cancelled') throw new Error('Download cancelled');

          if (!fs.existsSync(partialPath) || fs.statSync(partialPath).size === 0) {
            throw new Error('ffmpeg completed without creating a video file');
          }
        } catch (error) {
          removePartial(partialPath);
          if (job.status === 'cancelled' || attempt === 2) throw error;
          appendLog(job, 'Download attempt failed; resolving a fresh source for one retry');
          job.output = 'Retrying download source';
          job.downloadProgress = {
            phase: 'retrying', phaseStartedAt: new Date().toISOString(),
            elapsedSeconds: 0, idleSeconds: 0, outTimeUs: 0, totalBytes: 0,
          };
          continue;
        }
        fs.renameSync(partialPath, outputPath);
        appendLog(job, `Download complete: ${outputPath}`);
        return;
      }
    } catch (error) {
      removePartial(partialPath);
      throw error;
    }
  };
}

module.exports = {
  ffmpegDownloadArgs,
  createEpisodeDownloadTask,
};

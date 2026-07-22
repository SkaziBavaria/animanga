'use strict';

const fs = require('fs');
const path = require('path');
const { USER_AGENT } = require('./config');
const { resolveEpisodePlayback } = require('./anime-resolver');
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
  const resolvePlayback = dependencies.resolvePlayback || resolveEpisodePlayback;
  const runProcess = dependencies.runProcess || runLoggedProcess;
  const outputPath = path.resolve(options.outputPath);
  const partialPath = `${outputPath}.part.mp4`;

  return async (job) => {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    removePartial(partialPath);

    try {
      const playback = await resolvePlayback({
        showId: options.showId,
        episode: options.episode,
        mode: options.mode,
        quality: options.quality,
      });
      if (job.status === 'cancelled') throw new Error('Download cancelled');

      appendLog(job, `Resolved ${playback.provider || 'AllAnime'}${playback.quality ? ` ${playback.quality}p` : ''}; downloading with ffmpeg`);
      await runProcess(job, 'ffmpeg', ffmpegDownloadArgs(playback, partialPath));
      if (job.status === 'cancelled') throw new Error('Download cancelled');

      if (!fs.existsSync(partialPath) || fs.statSync(partialPath).size === 0) {
        throw new Error('ffmpeg completed without creating a video file');
      }
      fs.renameSync(partialPath, outputPath);
      appendLog(job, `Download complete: ${outputPath}`);
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

'use strict';

const { ANIME_RESOLVER, ANI_CLI_FALLBACK } = require('../config');
const { sendJson, sendError, readBody } = require('../http');
const { readState, saveState } = require('../state');
const { normalizeMode, normalizeEpisode } = require('../episodes');
const { getShowDetails } = require('../allanime');
const { resolveEpisodePlayback } = require('../anime-resolver');
const {
  buildAniCliArgs,
  parseDebugPlayback,
  resolvePlaybackMode,
  startPtyJob,
  runJobAndWait,
} = require('../legacy/ani-cli');
const { proxyStream } = require('../proxy');
const { touchShow } = require('./shared');

async function handlePlaybackRoutes(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/proxy') {
    return proxyStream(req, res, url);
  }

  if (req.method === 'POST' && url.pathname === '/api/play') {
    const body = await readBody(req);
    const state = readState();
    const mode = normalizeMode(body.mode || state.settings.mode);
    let details = null;

    if (body.id && body.episode) {
      details = await getShowDetails(body.id, mode);
      if (!details.episodes.includes(normalizeEpisode(body.episode))) {
        return sendError(res, 422, `Episode ${body.episode} is not available yet`, {
          latestEpisode: details.latestEpisode,
          episodeCount: details.episodeCount,
        });
      }
      if (touchShow(state, body.id, details)) saveState(state);
    }

    const playPayload = {
      id: body.id,
      episode: body.episode,
      mode: body.mode,
      quality: body.quality,
      player: body.player,
      skipIntro: body.skipIntro,
      resolveOnly: body.resolveOnly,
      clientPlayback: body.clientPlayback,
      ...(details || {}),
    };
    let args = null;
    const aniCliArgs = async (payload = playPayload) => {
      if (!args) args = await buildAniCliArgs(payload);
      return args;
    };
    const env = {};
    const { useBrowserPlayback, usePtyAniCli } = resolvePlaybackMode(body);
    if (body.player && body.player !== 'default' && body.player !== 'vlc') env.ANI_CLI_PLAYER = body.player;

    let job;
    let playback = null;
    if (useBrowserPlayback) {
      let nodeError = null;
      if (ANIME_RESOLVER === 'node' && body.id && body.episode) {
        try {
          playback = await resolveEpisodePlayback({
            showId: body.id,
            episode: body.episode,
            mode,
            quality: body.quality || state.settings.quality || 'best',
          });
          job = {
            status: 'done',
            label: `Resolve ${details?.name || body.title || body.id} ep ${body.episode}`,
            output: `Playback URL resolved by AniManga (${playback.provider || 'AllAnime'})`,
            resolver: 'node',
          };
        } catch (error) {
          nodeError = error;
        }
      }

      if (!playback) {
        if (ANIME_RESOLVER === 'node' && !ANI_CLI_FALLBACK) {
          return sendError(res, 422, 'AniManga could not fetch a playable link', nodeError?.message || 'No playable source');
        }
        args = await buildAniCliArgs({ ...playPayload, player: 'default' });
        job = await runJobAndWait(`Play ${body.title}`, args, { ANI_CLI_PLAYER: 'debug' });
        if (job.status !== 'done') {
          const detail = [nodeError?.message, job.output || job.error].filter(Boolean).join('\n');
          return sendError(res, 422, 'Could not fetch the video link', detail || job);
        }
        try {
          playback = { ...parseDebugPlayback(job.output || ''), resolver: 'ani-cli' };
          job.output = `${job.output || ''}\nPlayback URL sent to browser`;
        } catch (err) {
          job.status = 'failed';
          job.error = err.message;
          return sendError(res, 422, 'Could not fetch a playable link', err.message);
        }
      }
    } else if (usePtyAniCli) {
      args = await aniCliArgs();
      job = startPtyJob(`Play ${body.title}`, args, env);
    } else {
      args = await aniCliArgs();
      job = await runJobAndWait(body.download ? `Download ${body.title}` : `Play ${body.title}`, args, env);
      if (job.status !== 'done') {
        return sendError(res, 422, 'ani-cli could not start the episode', job.output || job.error || job);
      }

      if (/failed to open \/dev\/tty/i.test(job.output || '')) {
        return sendError(res, 422, 'ani-cli got stuck in interactive mode without a terminal', job.output || job);
      }
      if (!/Links Fetched|Playing episode/i.test(job.output || '')) {
        return sendError(res, 422, 'ani-cli exited without clear playback confirmation', job.output || job);
      }
    }

    return sendJson(res, 200, { job, playback });
  }

  return sendError(res, 404, 'Playback endpoint missing');
}

module.exports = { handlePlaybackRoutes };

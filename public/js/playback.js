import { api, reportBackgroundError, toast, postBeacon } from './api.js';
import { els } from './dom.js';
import { state } from './state.js';
import { usesBrowserPlayer } from './status.js';
import { positionFor, saveProgress } from './progress.js';
import { setupPlayerGestures } from './player-gestures.js';
import { refreshAnimeCards, syncAnimeShow } from './library.js';
import {
  presentAnimeCard,
  playbackPositionToSave,
} from './util.js';
import { loadSkipTimes, skipShowTitle } from './aniskip.js';
import {
  hlsPlaybackStrategy,
  loadHlsConstructor,
  nativeHlsSupported,
} from './hls-player.js';
import {
  sidecarSubtitleSrc,
  parseWebVtt,
  activeCueText,
} from './captions.js';

let currentContext = null;
let currentShow = null;
let lastSavedAt = 0;
let lastMediaTime = 0;
let lastMediaDuration = 0;
let captionCues = [];
let captionLoadId = 0;
let currentSkip = { op: null, ed: null };
let introSkipped = false;
let finishedMarked = false;
let playerSeeking = false;
let detachSkipTimes = null;
let playbackGeneration = 0;
let activeHls = null;
let awaitingHls = false;
let detachCaptions = null;
const controlsState = {
  hover: false,
  hideTimer: 0,
  ignoreStageClicksUntil: 0,
  ignoreControlClicksUntil: 0,
  pointerArmed: false,
  suppressRevealUntil: 0,
  stageClickTimer: 0,
  seekOsd: { side: null, total: 0, at: 0 },
  osdTimer: 0,
  ignoreStageDblClickUntil: 0,
};

const SEEK_CHAIN_MS = 900;

function adjacentEpisode(show, episode, dir) {
  const list = (show?.episodes || []).map(String);
  if (list.length) {
    const idx = list.indexOf(String(episode));
    if (idx !== -1) {
      const target = idx + dir;
      return target >= 0 && target < list.length ? list[target] : null;
    }
  }
  const num = Number(episode);
  if (!Number.isFinite(num)) return null;
  const candidate = num + dir;
  if (candidate < 1) return null;
  const latest = Number(show?.latestEpisode || show?.episodeCount);
  if (dir > 0 && Number.isFinite(latest) && latest > 0 && candidate > latest) return null;
  return String(candidate);
}

function updatePlayerNav() {
  const hasPrev = Boolean(currentShow && currentContext && adjacentEpisode(currentShow, currentContext.episode, -1));
  const hasNext = Boolean(currentShow && currentContext && adjacentEpisode(currentShow, currentContext.episode, 1));
  if (els.prevEpisodeBtn) els.prevEpisodeBtn.disabled = !hasPrev;
  if (els.nextEpisodeBtn) els.nextEpisodeBtn.disabled = !hasNext;
}

async function playAdjacent(dir) {
  if (!currentShow || !currentContext) return;
  const target = adjacentEpisode(currentShow, currentContext.episode, dir);
  if (!target) return;
  // Next marks the episode watched (like finishing via autoplay). Previous only saves resume progress.
  if (dir === 1) markEpisodeFinished();
  else persistProgress();
  const show = currentShow;
  try {
    const { playShow } = await import('./episodes.js');
    await playShow(show, target);
  } catch (err) {
    toast(err.message);
  }
}

function rememberMediaTime() {
  const video = els.playerVideo;
  const time = Number(video?.currentTime);
  const duration = Number(video?.duration);
  if (Number.isFinite(time) && time > 0) lastMediaTime = time;
  if (Number.isFinite(duration) && duration > 0) lastMediaDuration = duration;
}

function persistProgress() {
  if (!currentContext || finishedMarked) return;
  rememberMediaTime();
  const video = els.playerVideo;
  const resolved = playbackPositionToSave(video?.currentTime, video?.duration, {
    time: lastMediaTime,
    duration: lastMediaDuration,
  });
  if (!resolved) return;
  saveProgress(currentContext.showId, currentContext.episode, resolved.position, resolved.duration);
}

function attachResume(resumeSeconds) {
  if (!resumeSeconds || resumeSeconds < 5) return;
  const video = els.playerVideo;
  let applied = false;
  const apply = () => {
    if (applied) return;
    const duration = Number(video.duration);
    if (!Number.isFinite(duration) || duration <= resumeSeconds) return;
    const limit = duration - 5;
    if (resumeSeconds >= limit) return;
    try {
      video.currentTime = resumeSeconds;
      applied = true;
      updateCaptionOverlay();
    } catch {}
  };
  video.addEventListener('loadedmetadata', apply);
  video.addEventListener('durationchange', apply);
}

function attachSkipTimes(show, episode) {
  detachSkipTimes?.();
  detachSkipTimes = null;
  const title = skipShowTitle(show);
  if (!title) return;
  const video = els.playerVideo;
  const requestContext = currentContext;
  let lastDuration = null;

  const requestSkipTimes = () => {
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? Math.round(video.duration) : 0;
    if (!duration) return;
    if (duration === lastDuration) return;
    lastDuration = duration;
    loadSkipTimes(title, episode, duration).then((skip) => {
      if (currentContext !== requestContext) return;
      if (skip?.op || skip?.ed) currentSkip = skip;
    });
  };

  video.addEventListener('loadedmetadata', requestSkipTimes);
  video.addEventListener('durationchange', requestSkipTimes);
  detachSkipTimes = () => {
    video.removeEventListener('loadedmetadata', requestSkipTimes);
    video.removeEventListener('durationchange', requestSkipTimes);
  };
  requestSkipTimes();
}

function hideSkipButton() {
  if (!els.skipButton) return;
  els.skipButton.hidden = true;
  els.skipButton.onclick = null;
}

function showSkipButton(label, onClick) {
  if (!els.skipButton) return;
  els.skipButton.textContent = label;
  els.skipButton.hidden = false;
  els.skipButton.onclick = onClick;
}

function markEpisodeFinished() {
  if (!currentContext || finishedMarked) return;
  finishedMarked = true;
  const { showId, episode } = currentContext;
  const duration = els.playerVideo.duration;
  if (Number.isFinite(duration) && duration > 0) saveProgress(showId, episode, duration, duration);
  if (state.settings.autoTrackPlayed === false) return;
  postBeacon('/api/mark', { id: showId, episode, watched: true });
  const now = new Date().toISOString();
  const libraryShow = state.library.find((show) => show.id === showId);
  [...new Set([currentShow, state.activeShow, libraryShow].filter(Boolean))].forEach((show) => {
    show.watchedEpisodes = Array.from(new Set([...(show.watchedEpisodes || []), String(episode)]));
    show.lastActivityAt = now;
    syncAnimeShow(presentAnimeCard(show));
  });
  refreshAnimeCards();
  if (state.activeShow && state.activeShow.id === showId) {
    import('./episodes.js')
      .then(({ renderEpisodeGrid }) => renderEpisodeGrid(state.activeShow))
      .catch((error) => reportBackgroundError('Could not refresh episode list', error));
  }
}

function shouldMarkFinishedOnClose() {
  const video = els.playerVideo;
  const duration = Number(video?.duration);
  const currentTime = Number(video?.currentTime);
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(currentTime)) return false;
  if (duration - currentTime <= 15 || currentTime / duration >= 0.95) return true;

  const outroStart = Number(currentSkip.ed?.start);
  const credibleOutro = Number.isFinite(outroStart) && outroStart >= duration * 0.75;
  return credibleOutro && currentTime >= outroStart;
}

function handleSkipTimes() {
  if (!currentContext) return;
  const video = els.playerVideo;
  const t = video.currentTime;
  const { op, ed } = currentSkip;
  const inOp = op && t >= op.start && t < op.end;
  const inEd = ed && t >= ed.start && t < ed.end;

  if (inOp) {
    if (state.settings.skipIntro && !introSkipped) {
      introSkipped = true;
      video.currentTime = op.end;
      hideSkipButton();
    } else {
      showSkipButton('Skip Intro ▶', () => {
        introSkipped = true;
        video.currentTime = op.end;
        hideSkipButton();
      });
    }
    return;
  }

  if (inEd) {
    showSkipButton('Skip Outro ▶', () => {
      video.currentTime = Number.isFinite(ed.end) ? ed.end : video.duration;
      hideSkipButton();
    });
    return;
  }

  hideSkipButton();
}

function intentUrl(url, player, title) {
  const parsed = new URL(url, window.location.origin);
  const extras = [
    'action=android.intent.action.VIEW',
    'type=video/mp4',
    `S.title=${encodeURIComponent(title || 'AniManga')}`,
  ];
  if (player === 'android_mpv') extras.push('package=is.xyz.mpv');
  if (player === 'vlc') extras.push('package=org.videolan.vlc');
  return `intent://${parsed.host}${parsed.pathname}${parsed.search}#Intent;scheme=${parsed.protocol.replace(':', '')};${extras.join(';')};end`;
}

function proxyStreamUrl(playback) {
  if (playback.local || playback.url.startsWith('/')) {
    return new URL(playback.url, window.location.origin).href;
  }
  if (playback.proxyUrl) return playback.proxyUrl;
  const params = new URLSearchParams({ url: playback.url });
  if (playback.referrer) params.set('referrer', playback.referrer);
  return `/api/proxy?${params.toString()}`;
}

function canPlayDirect(playback) {
  if (playback.local || playback.url.startsWith('/')) return true;
  const url = playback.url || '';
  if (/wixstatic\.com|fast4speed|googlevideo|youtu\.be|youtube\.com/i.test(url)) return true;
  if (/mp4upload|sharepoint|streamwish|vidstream/i.test(url)) return false;
  return !playback.referrer;
}

function playbackStreamUrl(playback) {
  return canPlayDirect(playback) ? playback.url : proxyStreamUrl(playback);
}

function fullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function isPlayerStageFullscreen() {
  return Boolean(fullscreenElement()) || els.playerDialog?.classList.contains('player-fullscreen');
}

function focusPlayerStage() {
  els.playerStage?.focus({ preventScroll: true });
}

async function requestPlayerFullscreen() {
  els.playerDialog?.classList.add('player-fullscreen');
  document.body.classList.add('player-fullscreen-active');
  updateVideoControls();
  const root = document.documentElement;
  const request = root.requestFullscreen || root.webkitRequestFullscreen;
  if (request) await request.call(root);
  focusPlayerStage();
}

async function exitPlayerFullscreen() {
  els.playerDialog?.classList.remove('player-fullscreen');
  document.body.classList.remove('player-fullscreen-active');
  updateVideoControls();
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  if (fullscreenElement() && exit) await exit.call(document);
  focusPlayerStage();
}

async function togglePlayerFullscreen() {
  try {
    if (isPlayerStageFullscreen()) await exitPlayerFullscreen();
    else await requestPlayerFullscreen();
  } catch (error) {
    toast(`Fullscreen unavailable: ${error.message}`);
  }
}

function shouldHideVideoControls() {
  const video = els.playerVideo;
  return Boolean(currentContext && video && !video.paused && !playerSeeking && !controlsState.hover);
}

function setVideoControlsVisible(visible) {
  els.playerStage?.classList.toggle('controls-hidden', !visible);
  if (!visible) controlsState.pointerArmed = false;
}

function areVideoControlsHidden() {
  return els.playerStage?.classList.contains('controls-hidden') ?? false;
}

function scheduleVideoControlsHide() {
  clearTimeout(controlsState.hideTimer);
  if (!shouldHideVideoControls()) {
    setVideoControlsVisible(true);
    return;
  }
  controlsState.hideTimer = setTimeout(() => {
    if (shouldHideVideoControls()) setVideoControlsVisible(false);
  }, 2200);
}

function showVideoControlsTemporarily() {
  if (Date.now() < controlsState.suppressRevealUntil) return;
  setVideoControlsVisible(true);
  scheduleVideoControlsHide();
}

function revealVideoControlsOnly() {
  controlsState.pointerArmed = false;
  controlsState.ignoreControlClicksUntil = Date.now() + 1200;
  showVideoControlsTemporarily();
}

function toggleVideoControlsFromSurface() {
  if (areVideoControlsHidden()) {
    revealVideoControlsOnly();
  } else {
    clearTimeout(controlsState.hideTimer);
    controlsState.suppressRevealUntil = Date.now() + 450;
    setVideoControlsVisible(false);
  }
}

function showPlayerOsd(label, side = 'center') {
  const osd = els.playerOsd;
  if (!osd) return;
  osd.textContent = label;
  osd.classList.toggle('osd-left', side === 'left');
  osd.classList.toggle('osd-right', side === 'right');
  osd.classList.add('show');
  clearTimeout(controlsState.osdTimer);
  controlsState.osdTimer = setTimeout(() => {
    osd.classList.remove('show', 'osd-left', 'osd-right');
  }, 700);
}

function showAccumulatedSeekOsd(side, seconds) {
  const now = Date.now();
  if (controlsState.seekOsd.side === side && now - controlsState.seekOsd.at <= SEEK_CHAIN_MS) {
    controlsState.seekOsd.total += seconds;
  } else {
    controlsState.seekOsd = { side, total: seconds, at: now };
  }
  controlsState.seekOsd.at = now;
  showPlayerOsd(`${controlsState.seekOsd.total > 0 ? '+' : ''}${controlsState.seekOsd.total}s`, side);
}

function isSeekChainActive() {
  return Date.now() - controlsState.seekOsd.at <= SEEK_CHAIN_MS;
}

function seekByStagePosition(event) {
  const rect = els.playerStage?.getBoundingClientRect();
  if (!rect) return;
  const side = event.clientX < rect.left + rect.width / 2 ? 'left' : 'right';
  const seconds = side === 'right' ? 10 : -10;
  seekRelative(seconds, { silent: true });
  showAccumulatedSeekOsd(side, seconds);
}

function formatClock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const secs = String(total % 60).padStart(2, '0');
  return `${mins}:${secs}`;
}

function updateVideoControls() {
  const video = els.playerVideo;
  if (!video) return;

  if (els.playPauseBtn) {
    els.playPauseBtn.classList.toggle('is-paused', video.paused);
    els.playPauseBtn.classList.toggle('is-playing', !video.paused);
    els.playPauseBtn.title = video.paused ? 'Play' : 'Pause';
    els.playPauseBtn.setAttribute('aria-label', video.paused ? 'Play' : 'Pause');
  }
  if (els.muteBtn) {
    const muted = video.muted || video.volume === 0;
    els.muteBtn.classList.toggle('is-muted', muted);
    els.muteBtn.title = muted ? 'Unmute' : 'Mute';
    els.muteBtn.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
  }
  if (els.playerFullscreenBtn) {
    const fullscreen = isPlayerStageFullscreen();
    const path = fullscreen
      ? 'M9 4v5H4V7h3V4h2Zm6 0h2v3h3v2h-5V4ZM4 15h5v5H7v-3H4v-2Zm11 0h5v2h-3v3h-2v-5Z'
      : 'M4 9V4h5v2H6v3H4Zm11-5h5v5h-2V6h-3V4ZM6 15v3h3v2H4v-5h2Zm12 0h2v5h-5v-2h3v-3Z';
    els.playerFullscreenBtn.innerHTML = `<svg class="fullscreen-icon ${fullscreen ? 'fullscreen-exit' : 'fullscreen-enter'}" viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"></path></svg>`;
    els.playerFullscreenBtn.classList.toggle('is-fullscreen', fullscreen);
    els.playerFullscreenBtn.title = fullscreen ? 'Exit fullscreen' : 'Fullscreen';
    els.playerFullscreenBtn.setAttribute('aria-label', fullscreen ? 'Exit fullscreen' : 'Enter fullscreen');
  }

  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  if (els.playerTime) els.playerTime.textContent = `${formatClock(video.currentTime)} / ${formatClock(duration)}`;
  if (els.playerSeek && !playerSeeking) {
    els.playerSeek.disabled = duration <= 0;
    els.playerSeek.value = duration > 0 ? String(Math.round((video.currentTime / duration) * 1000)) : '0';
  }
  if (els.playerSeek) {
    const seekProgress = duration > 0 ? Math.max(0, Math.min(100, (video.currentTime / duration) * 100)) : 0;
    els.playerSeek.style.setProperty('--range-progress', `${seekProgress}%`);
  }
  if (els.playerVolume) {
    const volume = video.muted ? 0 : video.volume;
    els.playerVolume.value = String(volume);
    els.playerVolume.style.setProperty('--range-progress', `${Math.max(0, Math.min(100, volume * 100))}%`);
  }
}

function togglePlayback() {
  const video = els.playerVideo;
  if (!video) return;
  if (video.paused) video.play().catch(() => {});
  else video.pause();
}

function shouldIgnoreControlClick(event) {
  const ignore = !controlsState.pointerArmed || Date.now() < controlsState.ignoreControlClicksUntil;
  controlsState.pointerArmed = false;
  if (!ignore) return false;
  event.preventDefault();
  event.stopPropagation();
  return true;
}

function seekRelative(seconds, options = {}) {
  const video = els.playerVideo;
  if (!video || !Number.isFinite(video.currentTime)) return;
  const duration = Number.isFinite(video.duration) ? video.duration : Infinity;
  video.currentTime = Math.max(0, Math.min(duration, video.currentTime + seconds));
  updateVideoControls();
  if (!options.silent) showVideoControlsTemporarily();
}

function setPlayerVolume(value, options = {}) {
  const video = els.playerVideo;
  if (!video) return;
  const volume = Math.max(0, Math.min(1, value));
  video.volume = volume;
  video.muted = volume === 0;
  updateVideoControls();
  if (!options.silent) showVideoControlsTemporarily();
  if (!options.hideOsd) showPlayerOsd(volume === 0 ? 'Mute' : `Vol ${Math.round(volume * 100)}%`, 'right');
}

function adjustPlayerVolume(delta) {
  const video = els.playerVideo;
  if (!video) return;
  const base = video.muted ? 0 : video.volume;
  setPlayerVolume(base + delta);
}

function isPlayerControlTarget(target) {
  return target === els.skipButton || els.videoControls?.contains(target) || els.centerControls?.contains(target);
}

function toggleMute() {
  const video = els.playerVideo;
  if (!video) return;
  if (video.muted || video.volume === 0) {
    video.muted = false;
    if (video.volume === 0) video.volume = 1;
  } else {
    video.muted = true;
  }
  updateVideoControls();
}

function videoErrorMessage(video) {
  const code = Number(video?.error?.code) || 0;
  const message = String(video?.error?.message || '');
  if (code === 1) return 'Playback was aborted';
  if (code === 2) return 'Network error while loading the stream';
  if (code === 3) return 'This device could not decode the video';
  if (code === 4 || /no supported source/i.test(message)) return 'No playable stream format for this device';
  return message || 'Could not play this stream';
}

function detachHls() {
  awaitingHls = false;
  if (!activeHls) return;
  try { activeHls.destroy(); } catch {}
  activeHls = null;
}

function updateCaptionOverlay() {
  const overlay = els.playerCaptions;
  if (!overlay) return;
  const text = activeCueText(captionCues, els.playerVideo?.currentTime);
  overlay.hidden = !text;
  overlay.textContent = text;
}

function enableSidecarCaptions(playback) {
  detachCaptions?.();
  captionCues = [];
  updateCaptionOverlay();
  const src = sidecarSubtitleSrc(playback);
  if (!src) return;
  const loadId = ++captionLoadId;
  const controller = new AbortController();
  detachCaptions = () => {
    controller.abort();
    captionCues = [];
    updateCaptionOverlay();
    detachCaptions = null;
  };
  fetch(src, { signal: controller.signal }).then(async (response) => {
    if (!response.ok) return;
    const text = await response.text();
    if (loadId !== captionLoadId) return;
    captionCues = parseWebVtt(text);
    updateCaptionOverlay();
  }).catch((error) => {
    if (error?.name === 'AbortError') return;
  });
}

function resetVideoElement() {
  detachCaptions?.();
  detachHls();
  const video = els.playerVideo;
  if (!video) return;
  video.onerror = null;
  video.pause();
  video.removeAttribute('src');
  video.srcObject = null;
  // Do not call load() on an empty element: Chromium fires
  // MEDIA_ERR_SRC_NOT_SUPPORTED ("no supported source was found").
}

function startVideoPlayback() {
  const video = els.playerVideo;
  if (!video) return;
  video.play().then(() => {
    updateVideoControls();
    showVideoControlsTemporarily();
  }).catch((error) => {
    setVideoControlsVisible(true);
    if (error?.name === 'NotAllowedError') {
      toast('Tap play to start');
      return;
    }
    if (awaitingHls || activeHls) return;
    toast(error?.message || 'Could not start playback');
  });
}

function closeBlockingDialogs() {
  // Nested modal dialogs are unreliable across browsers; keep a single player dialog.
  if (els.dialog?.open) els.dialog.close();
  if (els.detailsDialog?.open) els.detailsDialog.close();
}

function attachProgressivePlayback(video, playback, failPlayback) {
  const direct = canPlayDirect(playback);
  video.src = playbackStreamUrl(playback);
  video.load();
  if (direct) {
    video.onerror = () => {
      video.onerror = failPlayback;
      video.src = proxyStreamUrl(playback);
      video.load();
      startVideoPlayback();
    };
  } else {
    video.onerror = failPlayback;
  }
  startVideoPlayback();
}

async function attachHlsPlayback(video, playback, { generation, failPlayback, resumeSeconds = 0 }) {
  const url = playbackStreamUrl(playback);
  let HlsCtor;
  try { HlsCtor = await loadHlsConstructor(); } catch (error) {
    if (generation !== playbackGeneration) return;
    awaitingHls = false;
    toast(error.message || 'Could not load HLS player');
    return;
  }
  if (generation !== playbackGeneration) return;
  const strategy = hlsPlaybackStrategy({
    url,
    sourceUrl: playback.url,
    canPlayNativeHls: nativeHlsSupported(video),
    mseHlsSupported: Boolean(HlsCtor?.isSupported?.()),
  });
  if (strategy === 'native' || strategy === 'progressive') {
    awaitingHls = false;
    attachProgressivePlayback(video, playback, failPlayback);
    return;
  }
  if (strategy !== 'mse' || !HlsCtor) {
    awaitingHls = false;
    toast('No playable stream format for this device');
    return;
  }
  const hls = new HlsCtor({
    enableWorker: true,
    renderTextTracksNatively: false,
    subtitleDisplay: false,
  });
  activeHls = hls;
  hls.on(HlsCtor.Events.MANIFEST_PARSED, () => {
    if (generation !== playbackGeneration) return;
    const resume = Number(resumeSeconds);
    const duration = Number(video.duration);
    if (resume >= 5 && Number.isFinite(duration) && resume < duration - 5) {
      try { video.currentTime = resume; } catch {}
    }
    updateCaptionOverlay();
    startVideoPlayback();
  });
  hls.on(HlsCtor.Events.ERROR, (_event, data) => {
    if (generation !== playbackGeneration || !data?.fatal) return;
    detachHls();
    setVideoControlsVisible(true);
    toast(videoErrorMessage(video));
  });
  hls.loadSource(url);
  hls.attachMedia(video);
}

function openBrowserPlayback(show, episode, playback) {
  const generation = ++playbackGeneration;
  currentContext = { showId: show.id, episode: String(episode) };
  currentShow = show;
  lastSavedAt = 0;
  lastMediaTime = 0;
  lastMediaDuration = 0;
  currentSkip = { op: null, ed: null };
  introSkipped = false;
  finishedMarked = false;
  hideSkipButton();
  updatePlayerNav();
  updateVideoControls();
  els.playerTitle.textContent = playback.title || `${show.name || show.title || 'Video'} ep ${episode}`;
  resetVideoElement();
  updateVideoControls();

  const resume = positionFor(show.id, episode)?.position || 0;
  const video = els.playerVideo;
  video.onerror = null;
  attachResume(resume);
  attachSkipTimes(show, episode);
  enableSidecarCaptions(playback);

  const failPlayback = () => {
    if (generation !== playbackGeneration) return;
    video.onerror = null;
    setVideoControlsVisible(true);
    toast(videoErrorMessage(video));
  };

  const url = playbackStreamUrl(playback);
  const strategy = hlsPlaybackStrategy({
    url,
    sourceUrl: playback.url,
    canPlayNativeHls: nativeHlsSupported(video),
    mseHlsSupported: true,
  });
  if (strategy === 'mse') {
    awaitingHls = true;
    attachHlsPlayback(video, playback, { generation, failPlayback, resumeSeconds: resume }).catch((error) => {
      if (generation !== playbackGeneration) return;
      toast(error.message || 'Could not play this stream');
    });
  } else {
    attachProgressivePlayback(video, playback, failPlayback);
  }

  closeBlockingDialogs();
  if (!els.playerDialog.open) els.playerDialog.showModal();
  focusPlayerStage();
  updateVideoControls();
  showVideoControlsTemporarily();
}

function openMpvPlayback(show, episode, playback) {
  window.location.href = intentUrl(playback.url, 'android_mpv', playback.title);
}

export function openPlayback(show, episode, playback) {
  if (usesBrowserPlayer()) {
    openBrowserPlayback(show, episode, playback);
    return;
  }
  openMpvPlayback(show, episode, playback);
}

export async function resolveMpvPlayback(show, episode) {
  const payload = {
    ...show,
    episode,
    resolveOnly: true,
    mode: show.mode || state.settings.mode,
    quality: state.settings.quality,
    player: 'android_mpv',
    skipIntro: state.settings.skipIntro,
  };
  const data = await api('/api/play', { method: 'POST', body: JSON.stringify(payload) });
  if (!data.playback?.url) throw new Error('No MPV link found');
  return {
    url: data.playback.url,
    title: `${show.name || show.title || 'Video'} ep ${episode}`,
    referrer: data.playback.referrer,
    // Signed proxy path from the server — required; unsigned /api/proxy is rejected.
    proxyUrl: data.playback.proxyUrl,
    subtitle: data.playback.subtitle,
    subtitleProxyUrl: data.playback.subtitleProxyUrl,
    subtitleLang: data.playback.subtitleLang,
    subtitleLabel: data.playback.subtitleLabel,
    provider: data.playback.provider,
    quality: data.playback.quality,
  };
}

export async function resolveLocalPlayback(show, episode) {
  try {
    const data = await api(`/api/downloads/${encodeURIComponent(show.id)}/${encodeURIComponent(episode)}/playback`);
    if (!data.playback?.url) return null;
    return {
      url: new URL(data.playback.url, window.location.origin).href,
      title: data.playback.title || `${show.name || show.title || 'Video'} ep ${episode}`,
      local: true,
    };
  } catch {
    return null;
  }
}

export function bindPlayerDialog() {
  els.closePlayerBtn.addEventListener('click', () => {
    els.playerVideo?.pause();
    if (els.playerDialog.open) els.playerDialog.close();
  });
  els.playerDialog.addEventListener('close', () => {
    playbackGeneration += 1;
    if (shouldMarkFinishedOnClose()) markEpisodeFinished();
    else persistProgress();
    refreshAnimeCards();
    resetVideoElement();
    hideSkipButton();
    detachSkipTimes?.();
    detachSkipTimes = null;
    if (els.playerDialog.classList.contains('player-fullscreen')) exitPlayerFullscreen();
    clearTimeout(controlsState.hideTimer);
    setVideoControlsVisible(true);
    updateVideoControls();
    currentContext = null;
    currentShow = null;
    refreshAnimeCards();
    if (state.activeShow) {
      import('./episodes.js')
        .then(({ renderEpisodeGrid }) => renderEpisodeGrid(state.activeShow))
        .catch((error) => reportBackgroundError('Could not refresh episode list', error));
    }
  });

  els.prevEpisodeBtn?.addEventListener('click', (event) => {
    if (shouldIgnoreControlClick(event)) return;
    event.stopPropagation();
    playAdjacent(-1);
    showVideoControlsTemporarily();
  });
  els.nextEpisodeBtn?.addEventListener('click', (event) => {
    if (shouldIgnoreControlClick(event)) return;
    event.stopPropagation();
    playAdjacent(1);
    showVideoControlsTemporarily();
  });
  els.playPauseBtn?.addEventListener('click', (event) => {
    if (shouldIgnoreControlClick(event)) return;
    event.stopPropagation();
    togglePlayback();
    showVideoControlsTemporarily();
  });
  els.muteBtn?.addEventListener('click', (event) => {
    if (shouldIgnoreControlClick(event)) return;
    event.stopPropagation();
    toggleMute();
    showVideoControlsTemporarily();
  });
  els.playerFullscreenBtn?.addEventListener('click', (event) => {
    if (shouldIgnoreControlClick(event)) return;
    event.stopPropagation();
    togglePlayerFullscreen();
    showVideoControlsTemporarily();
  });
  els.playerSeek?.addEventListener('input', () => {
    const video = els.playerVideo;
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;
    playerSeeking = true;
    video.currentTime = (Number(els.playerSeek.value) / 1000) * video.duration;
    updateVideoControls();
    updateCaptionOverlay();
    setVideoControlsVisible(true);
  });
  els.playerSeek?.addEventListener('change', () => {
    playerSeeking = false;
    updateVideoControls();
    persistProgress();
    showVideoControlsTemporarily();
  });
  els.playerVolume?.addEventListener('input', () => {
    setPlayerVolume(Number(els.playerVolume.value), { hideOsd: true });
  });
  els.videoControls?.addEventListener('mouseenter', () => {
    controlsState.hover = true;
    setVideoControlsVisible(true);
    clearTimeout(controlsState.hideTimer);
  });
  els.videoControls?.addEventListener('mouseleave', () => {
    controlsState.hover = false;
    scheduleVideoControlsHide();
  });
  els.videoControls?.addEventListener('focusin', () => {
    controlsState.hover = true;
    setVideoControlsVisible(true);
    clearTimeout(controlsState.hideTimer);
  });
  els.videoControls?.addEventListener('focusout', () => {
    controlsState.hover = false;
    scheduleVideoControlsHide();
  });
  const armControlPointer = () => {
    controlsState.pointerArmed = true;
    controlsState.ignoreControlClicksUntil = 0;
  };
  els.videoControls?.addEventListener('pointerdown', armControlPointer);
  els.centerControls?.addEventListener('pointerdown', armControlPointer);
  els.videoControls?.addEventListener('touchstart', armControlPointer, { passive: true });
  els.centerControls?.addEventListener('touchstart', armControlPointer, { passive: true });
  els.playerStage?.addEventListener('mousemove', showVideoControlsTemporarily);
  els.playerStage?.addEventListener('click', (event) => {
    if (isPlayerControlTarget(event.target)) return;
    if (Date.now() < controlsState.ignoreStageClicksUntil) {
      return;
    }
    if (isSeekChainActive()) {
      clearTimeout(controlsState.stageClickTimer);
      controlsState.suppressRevealUntil = Date.now() + 450;
      controlsState.ignoreStageDblClickUntil = Date.now() + 320;
      seekByStagePosition(event);
      return;
    }
    clearTimeout(controlsState.stageClickTimer);
    controlsState.stageClickTimer = setTimeout(() => {
      toggleVideoControlsFromSurface();
    }, 180);
  });
  els.playerStage?.addEventListener('dblclick', (event) => {
    if (event.target === els.skipButton || els.videoControls?.contains(event.target)) return;
    if (Date.now() < controlsState.ignoreStageDblClickUntil) return;
    clearTimeout(controlsState.stageClickTimer);
    controlsState.suppressRevealUntil = Date.now() + 450;
    seekByStagePosition(event);
  });
  els.playerStage?.addEventListener('wheel', (event) => {
    if (!currentContext || event.ctrlKey) return;
    event.preventDefault();
    if (!isPlayerControlTarget(event.target)) focusPlayerStage();
    adjustPlayerVolume(event.deltaY < 0 ? 0.05 : -0.05);
  }, { passive: false });
  const handleGestureTap = () => {
    controlsState.ignoreStageClicksUntil = Date.now() + 1200;
    toggleVideoControlsFromSurface();
  };
  const handleGestureSeek = (side, seconds) => {
    controlsState.ignoreStageClicksUntil = Date.now() + 1200;
    seekRelative(seconds, { silent: true });
    showAccumulatedSeekOsd(side, seconds);
  };
  document.addEventListener('keydown', (event) => {
    if (!currentContext) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') return;

    if (event.code === 'Space' || event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault();
      togglePlayback();
      showVideoControlsTemporarily();
      return;
    }

    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const seconds = event.key === 'ArrowRight' ? 10 : -10;
      const side = event.key === 'ArrowRight' ? 'right' : 'left';
      seekRelative(seconds, { silent: true });
      showAccumulatedSeekOsd(side, seconds);
      return;
    }

    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault();
      adjustPlayerVolume(event.key === 'ArrowUp' ? 0.05 : -0.05);
      return;
    }

    if (event.key.toLowerCase() === 'f') {
      event.preventDefault();
      togglePlayerFullscreen();
    }
  });
  document.addEventListener('fullscreenchange', updateVideoControls);
  document.addEventListener('webkitfullscreenchange', updateVideoControls);
  document.addEventListener('fullscreenchange', () => {
    if (!fullscreenElement()) {
      els.playerDialog?.classList.remove('player-fullscreen');
      document.body.classList.remove('player-fullscreen-active');
    }
    if (currentContext) focusPlayerStage();
  });
  document.addEventListener('webkitfullscreenchange', () => {
    if (!fullscreenElement()) {
      els.playerDialog?.classList.remove('player-fullscreen');
      document.body.classList.remove('player-fullscreen-active');
    }
    if (currentContext) focusPlayerStage();
  });

  setupPlayerGestures({
    onTap: handleGestureTap,
    onSeek: handleGestureSeek,
    isSeekChainActive,
  });

  els.playerVideo.addEventListener('seeked', updateCaptionOverlay);
  els.playerVideo.addEventListener('playing', updateCaptionOverlay);
  els.playerVideo.addEventListener('loadeddata', updateCaptionOverlay);
  els.playerVideo.addEventListener('timeupdate', () => {
    if (!currentContext) return;
    handleSkipTimes();
    updateVideoControls();
    updateCaptionOverlay();
    const now = Date.now();
    if (now - lastSavedAt < 5000) return;
    lastSavedAt = now;
    persistProgress();
  });
  els.playerVideo.addEventListener('pause', persistProgress);
  els.playerVideo.addEventListener('play', () => {
    updateVideoControls();
    showVideoControlsTemporarily();
  });
  els.playerVideo.addEventListener('pause', () => {
    updateVideoControls();
    setVideoControlsVisible(true);
    clearTimeout(controlsState.hideTimer);
  });
  els.playerVideo.addEventListener('loadedmetadata', updateVideoControls);
  els.playerVideo.addEventListener('durationchange', updateVideoControls);
  els.playerVideo.addEventListener('volumechange', updateVideoControls);
  els.playerVideo.addEventListener('ended', () => {
    if (!currentContext) return;
    markEpisodeFinished();
    if (els.autoplayNext?.checked && adjacentEpisode(currentShow, currentContext.episode, 1)) {
      playAdjacent(1);
    }
  });
  window.addEventListener('pagehide', persistProgress);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persistProgress();
  });
}

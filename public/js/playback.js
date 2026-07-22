import { api, toast, postBeacon } from './api.js';
import { els } from './dom.js';
import { state } from './state.js';
import { usesBrowserPlayer } from './status.js';
import { positionFor, saveProgress } from './progress.js';
import { setupPlayerGestures } from './player-gestures.js';
import { renderLibrary } from './library.js';
import { loadSkipTimes, skipShowTitle } from './aniskip.js';

let currentContext = null;
let currentShow = null;
let lastSavedAt = 0;
let currentSkip = { op: null, ed: null };
let introSkipped = false;
let finishedMarked = false;
let playerSeeking = false;
let detachSkipTimes = null;
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
  persistProgress();
  const show = currentShow;
  try {
    const { playShow } = await import('./episodes.js');
    await playShow(show, target);
  } catch (err) {
    toast(err.message);
  }
}

function persistProgress() {
  if (!currentContext || finishedMarked) return;
  const video = els.playerVideo;
  if (!video || !Number.isFinite(video.currentTime)) return;
  saveProgress(currentContext.showId, currentContext.episode, video.currentTime, video.duration);
}

function attachResume(resumeSeconds) {
  if (!resumeSeconds || resumeSeconds < 5) return;
  const video = els.playerVideo;
  const onLoaded = () => {
    video.removeEventListener('loadedmetadata', onLoaded);
    const limit = Number.isFinite(video.duration) ? video.duration - 5 : Infinity;
    if (resumeSeconds < limit) {
      try { video.currentTime = resumeSeconds; } catch {}
    }
  };
  video.addEventListener('loadedmetadata', onLoaded);
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
  const libraryShow = state.library.find((show) => show.id === showId);
  [...new Set([currentShow, state.activeShow, libraryShow].filter(Boolean))].forEach((show) => {
    show.lastWatched = episode;
    show.watchedEpisodes = Array.from(new Set([...(show.watchedEpisodes || []), episode]));
  });
  renderLibrary();
  if (state.activeShow && state.activeShow.id === showId) {
    import('./episodes.js').then(({ renderEpisodeGrid }) => renderEpisodeGrid(state.activeShow)).catch(() => {});
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
  const root = document.documentElement;
  const request = root.requestFullscreen || root.webkitRequestFullscreen;
  if (request) await request.call(root);
  focusPlayerStage();
}

async function exitPlayerFullscreen() {
  els.playerDialog?.classList.remove('player-fullscreen');
  document.body.classList.remove('player-fullscreen-active');
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  if (fullscreenElement() && exit) await exit.call(document);
  focusPlayerStage();
}

async function togglePlayerFullscreen() {
  try {
    if (isPlayerStageFullscreen()) await exitPlayerFullscreen();
    else await requestPlayerFullscreen();
  } catch {}
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
    els.playerFullscreenBtn.classList.toggle('is-fullscreen', fullscreen);
    els.playerFullscreenBtn.title = fullscreen ? 'Exit fullscreen' : 'Fullscreen';
    els.playerFullscreenBtn.setAttribute('aria-label', fullscreen ? 'Exit fullscreen' : 'Fullscreen');
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

function openBrowserPlayback(show, episode, playback) {
  currentContext = { showId: show.id, episode: String(episode) };
  currentShow = show;
  lastSavedAt = 0;
  currentSkip = { op: null, ed: null };
  introSkipped = false;
  finishedMarked = false;
  hideSkipButton();
  updatePlayerNav();
  updateVideoControls();
  els.playerTitle.textContent = playback.title || `${show.name || show.title || 'Video'} ep ${episode}`;
  els.playerVideo.pause();
  els.playerVideo.removeAttribute('src');
  els.playerVideo.load();
  updateVideoControls();

  const resume = positionFor(show.id, episode)?.position || 0;
  const direct = canPlayDirect(playback);
  els.playerVideo.onerror = null;
  attachResume(resume);
  attachSkipTimes(show, episode);
  els.playerVideo.src = playbackStreamUrl(playback);
  if (direct) {
    els.playerVideo.onerror = () => {
      els.playerVideo.onerror = null;
      attachResume(resume);
      els.playerVideo.src = proxyStreamUrl(playback);
      els.playerVideo.play().catch(() => {});
    };
  }

  if (!els.playerDialog.open) els.playerDialog.showModal();
  focusPlayerStage();
  els.playerVideo.play().catch(() => {});
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
    els.playerVideo.pause();
    els.playerDialog.close();
  });
  els.playerDialog.addEventListener('close', () => {
    if (shouldMarkFinishedOnClose()) markEpisodeFinished();
    else persistProgress();
    renderLibrary();
    els.playerVideo.pause();
    els.playerVideo.removeAttribute('src');
    els.playerVideo.load();
    hideSkipButton();
    detachSkipTimes?.();
    detachSkipTimes = null;
    if (els.playerDialog.classList.contains('player-fullscreen')) exitPlayerFullscreen();
    clearTimeout(controlsState.hideTimer);
    setVideoControlsVisible(true);
    updateVideoControls();
    currentContext = null;
    currentShow = null;
    renderLibrary();
    if (state.activeShow) {
      import('./episodes.js').then(({ renderEpisodeGrid }) => renderEpisodeGrid(state.activeShow)).catch(() => {});
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

  els.playerVideo.addEventListener('timeupdate', () => {
    if (!currentContext) return;
    handleSkipTimes();
    updateVideoControls();
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

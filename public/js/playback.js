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
let outroTriggered = false;
let finishedMarked = false;

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
  if (!currentContext) return;
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
  const title = skipShowTitle(show);
  if (!title) return;
  const video = els.playerVideo;
  const requestContext = currentContext;
  const onLoaded = () => {
    video.removeEventListener('loadedmetadata', onLoaded);
    loadSkipTimes(title, episode, video.duration).then((skip) => {
      if (currentContext !== requestContext) return;
      currentSkip = skip || { op: null, ed: null };
    });
  };
  video.addEventListener('loadedmetadata', onLoaded);
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
  if (currentShow) {
    currentShow.lastWatched = episode;
    currentShow.watchedEpisodes = Array.from(new Set([...(currentShow.watchedEpisodes || []), episode]));
  }
  renderLibrary();
  if (state.activeShow && state.activeShow.id === showId) {
    import('./episodes.js').then(({ renderEpisodeGrid }) => renderEpisodeGrid(state.activeShow)).catch(() => {});
  }
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
    if (!outroTriggered) {
      outroTriggered = true;
      markEpisodeFinished();
    }
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
    `S.title=${encodeURIComponent(title || 'Ani Web')}`,
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

function trackStarted(show, episode) {
  postBeacon('/api/mark', { id: show.id, episode, watched: true });
}

function openBrowserPlayback(show, episode, playback) {
  currentContext = { showId: show.id, episode: String(episode) };
  currentShow = show;
  lastSavedAt = 0;
  currentSkip = { op: null, ed: null };
  introSkipped = false;
  outroTriggered = false;
  finishedMarked = false;
  hideSkipButton();
  updatePlayerNav();
  els.playerTitle.textContent = playback.title || `${show.name || show.title || 'Video'} ep ${episode}`;
  els.playerVideo.pause();
  els.playerVideo.removeAttribute('src');
  els.playerVideo.load();

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
  els.playerVideo.play().catch(() => {});
}

function openMpvPlayback(show, episode, playback) {
  window.location.href = intentUrl(playback.url, 'android_mpv', playback.title);
  if (state.settings.autoTrackPlayed !== false) trackStarted(show, episode);
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
    persistProgress();
    els.playerVideo.pause();
    els.playerVideo.removeAttribute('src');
    els.playerVideo.load();
    hideSkipButton();
    currentContext = null;
    currentShow = null;
    renderLibrary();
    if (state.activeShow) {
      import('./episodes.js').then(({ renderEpisodeGrid }) => renderEpisodeGrid(state.activeShow)).catch(() => {});
    }
  });

  els.prevEpisodeBtn?.addEventListener('click', () => playAdjacent(-1));
  els.nextEpisodeBtn?.addEventListener('click', () => playAdjacent(1));

  setupPlayerGestures();

  els.playerVideo.addEventListener('timeupdate', () => {
    if (!currentContext) return;
    handleSkipTimes();
    const now = Date.now();
    if (now - lastSavedAt < 5000) return;
    lastSavedAt = now;
    persistProgress();
  });
  els.playerVideo.addEventListener('pause', persistProgress);
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

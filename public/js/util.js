export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  }[char]));
}

export function stripDescription(value) {
  const withBreaks = String(value || '').replace(/<br\s*\/?>/gi, '\n');
  const withoutTags = withBreaks.replace(/<[^>]+>/g, '');
  const textarea = document.createElement('textarea');
  textarea.innerHTML = withoutTags;
  return textarea.value.replace(/\n{3,}/g, '\n\n').trim();
}

export function episodeNumber(value) {
  if (value === null || value === undefined || value === '') return NaN;
  return Number(value);
}

export function hasStarted(show) {
  return Number.isFinite(episodeNumber(show.lastWatched));
}

export function latestEpisodeNumber(show) {
  const latest = episodeNumber(show.latestEpisode || show.episodeCount);
  return Number.isFinite(latest) ? latest : null;
}

export function highestWatchedEpisode(show) {
  return [...(show.watchedEpisodes || [])]
    .filter((episode) => Number.isFinite(Number(episode)))
    .sort((a, b) => Number(a) - Number(b))
    .at(-1);
}

export function nextEpisode(show) {
  const list = show.episodes || [];
  const watched = new Set(show.watchedEpisodes || []);
  const last = episodeNumber(show.lastWatched);
  if (list.length) {
    if (Number.isFinite(last)) {
      return list.find((ep) => Number(ep) > last) || list.at(-1);
    }
    return list.find((ep) => !watched.has(String(ep))) || list.at(-1);
  }

  const latest = episodeNumber(show.latestEpisode || show.episodeCount);
  if (Number.isFinite(last) && Number.isFinite(latest) && last < latest) return String(last + 1);
  if (!Number.isFinite(last)) return '1';
  if (Number.isFinite(latest)) return String(latest);
  return show.lastWatched || '1';
}

export function hasNewEpisodeToContinue(show) {
  if (Number(show.newCount) > 0) return true;
  const last = episodeNumber(show.lastWatched);
  if (!Number.isFinite(last)) return false;
  const latest = latestEpisodeNumber(show);
  if (latest !== null) return last < latest;
  return (show.episodes || []).some((ep) => Number(ep) > last);
}

export function isCompleted(show) {
  const latest = latestEpisodeNumber(show);
  const last = episodeNumber(show.lastWatched);
  return Number.isFinite(last) && latest !== null && last >= latest;
}

export function progressRatio(show) {
  const latest = latestEpisodeNumber(show);
  const last = episodeNumber(show.lastWatched);
  if (!Number.isFinite(last) || latest === null || latest <= 0) return 0;
  return Math.min(1, last / latest);
}

export function thumbnailUrl(show) {
  return show.thumbnail || show.thumbnails?.[0] || '';
}

export function showInitials(show) {
  const title = show.name || show.title || '?';
  return title
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}

export function episodeTitle(show, episode) {
  return show.episodeTitles?.[episode] || show.episodeTitles?.[String(episode)] || 'Episode';
}

export function busyLabel(action) {
  return {
    play: 'Starting...',
    download: 'Starting...',
    track: 'Saving...',
    remove: 'Removing...',
    episodes: 'Fetching...',
    details: 'Fetching...',
  }[action] || 'Working...';
}

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

export function dateFromAllAnimeDate(value) {
  if (!value || typeof value !== 'object') return null;
  const year = Number(value.year);
  const month = Number(value.month);
  const date = Number(value.date);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(date)) return null;
  const hour = Number.isFinite(Number(value.hour)) ? Number(value.hour) : 0;
  const minute = Number.isFinite(Number(value.minute)) ? Number(value.minute) : 0;
  const second = Number.isFinite(Number(value.second)) ? Number(value.second) : 0;
  return new Date(year, month, date, hour, minute, second);
}

export function dateFromUnixSeconds(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : null;
}

export function formatShortDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' }).format(date);
}

export function formatShortDateTime(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

export function dateFromIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function releasePills(show) {
  const pills = [];
  const season = show.season;
  if (season?.quarter && season?.year) pills.push(`Started ${season.quarter} ${season.year}`);

  const next = show.nextAiringEpisode;
  const nextDate = dateFromUnixSeconds(next?.airingAt || next?.airingAtUnix || next?.time);
  if (nextDate) {
    const ep = next?.episode ? `Ep ${next.episode}` : 'Next ep';
    pills.push(`${ep} ${formatShortDateTime(nextDate)}`);
  } else {
    const lastDate = dateFromUnixSeconds(show.lastEpisodeTimestamp) || dateFromAllAnimeDate(show.lastEpisodeDate);
    if (lastDate) pills.push(`Last ep ${formatShortDate(lastDate)}`);
  }

  const startDate = dateFromAllAnimeDate(show.airedStart);
  if (!pills.length && startDate) pills.push(`Started ${formatShortDate(startDate)}`);
  return pills;
}

export function episodeReleaseLabel(show, episode) {
  const value = show.episodeDates?.[episode] || show.episodeDates?.[String(episode)];
  const date = dateFromIso(value) || dateFromUnixSeconds(value);
  return date ? `Released ${formatShortDate(date)}` : '';
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

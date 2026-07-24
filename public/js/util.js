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
  let text = String(value || '').replace(/<br\s*\/?>/gi, '\n');
  // Repeat until stable so nested/crafted tags cannot reassemble (CodeQL).
  let previous;
  do {
    previous = text;
    text = text.replace(/<[^>]*>/g, '');
  } while (text !== previous);
  const textarea = document.createElement('textarea');
  textarea.innerHTML = text;
  return textarea.value.replace(/\n{3,}/g, '\n\n').trim();
}

export function formatCacheAge(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  if (value < 60) return 'just now';
  if (value < 3600) return `${Math.floor(value / 60)}m ago`;
  if (value < 86400) return `${Math.floor(value / 3600)}h ago`;
  return `${Math.floor(value / 86400)}d ago`;
}

export function cacheStatusLabel(data) {
  if (data?.offline) return `offline cache · ${formatCacheAge(data.offlineAgeSeconds ?? data.cache?.ageSeconds)}`;
  if (data?.cache?.offline) return `offline cache · ${formatCacheAge(data.cache.ageSeconds)}`;
  if (data?.cache?.cached) return `cached ${formatCacheAge(data.cache.ageSeconds)}`;
  return 'live';
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
  const watched = new Set((show.watchedEpisodes || []).map(String));
  const last = episodeNumber(show.lastWatched);
  if (list.length) {
    const unwatched = list.filter((ep) => !watched.has(String(ep)));
    if (!unwatched.length) return null;
    if (Number.isFinite(last)) {
      return unwatched.find((ep) => Number(ep) > last) || unwatched[0];
    }
    return unwatched[0];
  }

  const latest = episodeNumber(show.latestEpisode || show.episodeCount);
  if (Number.isFinite(latest)) {
    for (let episode = 1; episode <= latest; episode += 1) {
      const value = String(episode);
      if (!watched.has(value) && (!Number.isFinite(last) || episode > last)) return value;
    }
    for (let episode = 1; episode <= latest; episode += 1) {
      const value = String(episode);
      if (!watched.has(value)) return value;
    }
    return null;
  }
  return Number.isFinite(last) ? String(last + 1) : '1';
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

/** Mirror server presentShow for immediate card updates without a refetch. */
export function presentAnimeCard(show = {}) {
  const watchedEpisodes = Array.from(new Set((show.watchedEpisodes || []).map(String)));
  // Always derive from watched list (matches server) so rewatching an older ep cannot lower progress.
  const lastWatched = highestWatchedEpisode({ watchedEpisodes }) || show.lastWatched || '';
  const latestEpisode = show.latestEpisode || show.episodeCount || null;
  const latest = episodeNumber(latestEpisode);
  const last = episodeNumber(lastWatched);
  const newCount = Number.isFinite(latest) && Number.isFinite(last)
    ? Math.max(0, Math.floor(latest - last))
    : 0;
  return {
    ...show,
    watchedEpisodes,
    lastWatched,
    latestEpisode,
    newCount,
    watchedCount: watchedEpisodes.length,
  };
}

/** Mirror server presentManga for immediate card updates without a refetch. */
export function presentMangaCard(manga = {}) {
  const readChapters = Array.from(new Set((manga.readChapters || []).map(String)))
    .sort((a, b) => Number(a) - Number(b) || String(a).localeCompare(String(b)));
  // Always derive from read list (matches server) so rereading an older chapter cannot lower progress.
  const lastRead = readChapters
    .filter((chapter) => Number.isFinite(Number(chapter)))
    .sort((a, b) => Number(a) - Number(b))
    .at(-1) || manga.lastRead || '';
  const latestChapter = manga.latestChapter || manga.chapters?.at(-1) || manga.chapterCount || null;
  const last = episodeNumber(lastRead);
  const latest = episodeNumber(latestChapter);
  let newCount = 0;
  if (Array.isArray(manga.chapters) && manga.chapters.length) {
    newCount = manga.chapters.filter((chapter) => {
      const value = Number(chapter);
      return Number.isFinite(value) && Number.isFinite(last) && value > last;
    }).length;
  } else if (Number.isFinite(latest) && Number.isFinite(last)) {
    newCount = Math.max(0, Math.floor(latest - last));
  } else {
    newCount = Number(manga.newCount) || 0;
  }
  return {
    ...manga,
    readChapters,
    lastRead,
    latestChapter,
    newCount,
  };
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
  const status = String(show.status || '').toLowerCase();
  const startDate = dateFromAllAnimeDate(show.airedStart);
  const endDate = dateFromAllAnimeDate(show.airedEnd)
    || dateFromUnixSeconds(show.lastEpisodeTimestamp)
    || dateFromAllAnimeDate(show.lastEpisodeDate);
  const startYear = startDate?.getFullYear() || Number(show.season?.year) || null;
  const endYear = endDate?.getFullYear() || null;
  const finished = status.includes('finished') || status.includes('completed');
  const upcoming = status.includes('not yet') || status.includes('upcoming');
  const releasing = status.includes('releasing') || status.includes('ongoing');

  if (startYear) {
    if (upcoming) pills.push(`Announced · ${startYear}`);
    else if (finished || (!releasing && show.airedEnd)) pills.push(`${startYear}–${endYear || startYear}`);
    else pills.push(`${startYear}–ongoing`);
  }

  const next = show.nextAiringEpisode;
  const nextDate = dateFromUnixSeconds(next?.airingAt || next?.airingAtUnix || next?.time);
  if (nextDate) {
    const ep = next?.episode ? `Ep ${next.episode}` : 'Next ep';
    pills.push(`${ep} ${formatShortDateTime(nextDate)}`);
  } else if (releasing) {
    const lastTimestamp = Number(show.lastEpisodeTimestamp);
    const rawInterval = Number(show.broadcastInterval);
    const intervalMs = rawInterval > 0 && rawInterval < 10_000_000 ? rawInterval * 1000 : rawInterval;
    const expectedDate = Number.isFinite(lastTimestamp) && lastTimestamp > 0
      && Number.isFinite(intervalMs) && intervalMs > 0
      ? new Date((lastTimestamp * 1000) + intervalMs)
      : null;
    if (expectedDate && expectedDate.getTime() > Date.now()) {
      const latestEpisode = Number(show.latestEpisode || show.episodeCount);
      const episode = Number.isFinite(latestEpisode) && latestEpisode > 0 ? ` ep ${latestEpisode + 1}` : '';
      pills.push(`Expected${episode} ${formatShortDateTime(expectedDate)}`);
    }
  }
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
    archive: 'Archiving...',
    unarchive: 'Restoring...',
    remove: 'Removing...',
    episodes: 'Fetching...',
    details: 'Fetching...',
  }[action] || 'Working...';
}

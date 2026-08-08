import { state } from './state.js';
import {
  downloadedEpisodeCount,
} from './download-helpers.js';
import { latestPositionForShow } from './progress.js';
import {
  escapeHtml,
  hasNewEpisodeToContinue,
  hasStarted,
  highestWatchedEpisode,
  nextEpisode,
  releasePills,
  showInitials,
  thumbnailUrl,
} from './util.js';

function playActionLabel(show, source, resuming) {
  if (source !== 'library') return 'Play';
  if (resuming) return 'Resume';
  if (hasStarted(show) && hasNewEpisodeToContinue(show)) return 'Continue';
  return 'Play';
}

function playActionClass(label) {
  return `play-action play-action-${String(label || 'play').toLowerCase()}`;
}

function playButtonLabel(label, episode) {
  return episode ? `${label} ep ${episode}` : label;
}

function progressLabel(show, source) {
  const latest = show.latestEpisode || show.episodeCount || '';
  if (source !== 'library') return latest ? `Episodes ${latest}` : 'Episodes ?';
  const watched = show.lastWatched || highestWatchedEpisode(show) || '0';
  return latest ? `Progress ${watched} / ${latest}` : `Progress ${watched}`;
}

function modeSelector(show) {
  const current = show.mode || state.settings?.mode || 'sub';
  const counts = show.episodeCounts || {};
  const hasAvailability = Object.keys(counts).length > 0;
  const options = ['sub', 'dub'].map((mode) => {
    const count = Number(counts[mode] || 0);
    const unavailable = hasAvailability && count <= 0;
    return `<option value="${mode}"${mode === current ? ' selected' : ''}${unavailable ? ' disabled' : ''}>${mode.toUpperCase()}</option>`;
  }).join('');
  return `
    <label class="card-mode" title="Playback version">
      <select data-action="mode" aria-label="Playback version">${options}</select>
    </label>
  `;
}

function nextSeasonPill(show) {
  if (!show.hasNextSeason && !show.nextSeason) return '';
  const next = show.nextSeason || {};
  const status = String(next.status || '').toLowerCase();
  const episodeCount = Number(next.episodeCount || next.latestEpisode || 0);
  if (status.includes('not yet') || status.includes('upcoming')) {
    return '<span class="pill sequel upcoming" title="A sequel has been announced">Sequel announced</span>';
  }
  if (episodeCount > 0 || status.includes('finished') || status.includes('releasing') || status.includes('ongoing')) {
    return '<span class="pill sequel released" title="A sequel is available now">Sequel available</span>';
  }
  return '<span class="pill sequel" title="This title has a sequel">Has sequel</span>';
}

export function noSearchResultsHtml(query) {
  return `
    <div class="empty empty-action">
      <span>No results.</span>
      <button class="small-button secondary" data-action="watch-release" data-query="${escapeHtml(query)}" type="button">Watch release</button>
    </div>
  `;
}

export function showCard(show, source) {
  const resume = source === 'library' ? latestPositionForShow(show) : null;
  const next = resume?.episode || nextEpisode(show);
  const hasNews = source === 'library' && Number(show.newCount) > 0;
  const thumb = thumbnailUrl(show);
  const playLabel = playActionLabel(show, source, Boolean(resume));
  const playText = playButtonLabel(playLabel, next);
  const downloadedCount = downloadedEpisodeCount(show.id);
  const isTracked = source !== 'library' && state.library.some((item) => item.id === show.id);
  const schedulePills = releasePills(show);
  const showStatus = String(show.status || '').toLowerCase();
  const isUpcoming = showStatus.includes('not yet') || showStatus.includes('upcoming');
  const extraActions = source === 'library'
    ? `${show.archived
      ? '<button class="secondary" data-action="unarchive">Unarchive</button>'
      : '<button class="secondary" data-action="archive">Archive</button>'
    }<button class="danger" data-action="remove">Remove</button>`
    : isTracked
      ? '<button class="tracked" data-action="tracked" disabled>Tracked</button>'
      : '<button class="secondary" data-action="track">Track</button>';
  return `
    <article class="show-card${show.archived ? ' archived' : ''}" data-id="${escapeHtml(show.id)}" data-source="${source}">
      ${thumb
        ? `<img class="show-thumb" src="${escapeHtml(thumb)}" alt="" loading="lazy" decoding="async">`
        : `<div class="show-thumb placeholder" aria-hidden="true">${escapeHtml(showInitials(show))}</div>`}
      <div class="show-main">
        <div class="show-title">${escapeHtml(show.name || show.title)}</div>
        <div class="show-meta">
          <span class="pill${hasNews ? ' hot' : ''}"${hasNews ? ` title="${escapeHtml(`${show.newCount} new episode${Number(show.newCount) === 1 ? '' : 's'} available`)}"` : ''}>${escapeHtml(progressLabel(show, source))}</span>
          ${modeSelector(show)}
          ${show.archived ? '<span class="pill">Archived</span>' : ''}
          ${downloadedCount ? `<span class="pill downloaded">↓ ${downloadedCount} saved</span>` : ''}
          ${schedulePills.map((pill, index) => `<span class="pill schedule${isUpcoming && index === 0 ? ' upcoming' : ''}">${escapeHtml(pill)}</span>`).join('')}
          ${nextSeasonPill(show)}
          ${show.recommendationReason ? `<span class="pill reason">${escapeHtml(show.recommendationReason)}</span>` : ''}
          ${show.refreshError ? `<span class="pill danger">Refresh failed</span>` : ''}
        </div>
      </div>
      <div class="card-actions ${source === 'library' ? 'four' : 'three'}">
        <button class="primary ${playActionClass(playLabel)}" data-action="play" data-ep="${escapeHtml(next)}">${escapeHtml(playText)}</button>
        <button class="secondary" data-action="episodes">Episodes</button>
        <button class="secondary" data-action="details">About</button>
        ${extraActions}
      </div>
    </article>
  `;
}

function relationLabel(relation) {
  return {
    sequel: 'Next season',
    prequel: 'Previous season',
    summary: 'Summary',
    side_story: 'Side story',
    alternative: 'Alternative',
    other: 'Related',
  }[String(relation || '').toLowerCase()] || 'Related';
}

function relationSortValue(item) {
  return {
    sequel: 0,
    prequel: 1,
    side_story: 2,
    summary: 3,
    alternative: 4,
    other: 5,
  }[String(item.relation || '').toLowerCase()] ?? 9;
}

function relationYearLabel(item) {
  const start = Number(item?.airedStart?.year || item?.season?.year || item?.year) || null;
  const end = Number(item?.airedEnd?.year) || null;
  if (!start) return '';
  return end && end !== start ? `${start}–${end}` : String(start);
}

export function relatedSeasonSection(relations = []) {
  const items = [...relations].sort((a, b) => relationSortValue(a) - relationSortValue(b));
  if (!items.length) return '';
  return `
    <section class="related-section" aria-label="Related seasons">
      <h3>Related seasons</h3>
      <div class="related-list">
        ${items.map((item) => {
          const tracked = state.library.some((show) => show.id === item.id);
          const thumb = thumbnailUrl(item);
          const episodes = item.episodeCount ? `${item.episodeCount} episodes` : 'No episodes yet';
          const year = relationYearLabel(item);
          return `
            <article class="related-item" data-related-id="${escapeHtml(item.id)}">
              ${thumb
                ? `<img class="related-thumb" src="${escapeHtml(thumb)}" alt="" loading="lazy" decoding="async">`
                : `<div class="related-thumb placeholder" aria-hidden="true">${escapeHtml(showInitials(item))}</div>`}
              <div class="related-main">
                <span class="pill hot">${escapeHtml(relationLabel(item.relation))}</span>
                <strong>${escapeHtml(item.name || item.title || item.id)}</strong>
                <span>${escapeHtml([year, episodes, item.status].filter(Boolean).join(' · '))}</span>
              </div>
              <div class="related-actions">
                <button class="secondary small-button" data-action="related-details" type="button">About</button>
                ${tracked
                  ? '<button class="tracked small-button" data-action="related-tracked" type="button" disabled>Tracked</button>'
                  : '<button class="secondary small-button" data-action="related-track" type="button">Track</button>'}
              </div>
            </article>
          `;
        }).join('')}
      </div>
    </section>
  `;
}

export function findShow(card) {
  const id = card.dataset.id;
  const primary = card.dataset.source === 'library' ? state.library : state.searchResults;
  const secondary = card.dataset.source === 'library' ? state.searchResults : state.library;
  const found = primary.find((show) => show.id === id) || secondary.find((show) => show.id === id);
  if (found) return found;
  const title = card.querySelector('.show-title')?.textContent || '';
  return {
    id,
    name: title,
    title,
    mode: state.settings?.mode || 'sub',
  };
}

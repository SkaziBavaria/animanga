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

function progressLabel(show, source) {
  const latest = show.latestEpisode || show.episodeCount || '';
  if (source !== 'library') return latest ? `Episodes ${latest}` : 'Episodes ?';
  const watched = show.lastWatched || highestWatchedEpisode(show) || '0';
  return latest ? `Progress ${watched} / ${latest}` : `Progress ${watched}`;
}

function nextSeasonPill(show) {
  if (!show.hasNextSeason) return '';
  const next = show.nextSeason || {};
  const status = String(next.status || '').toLowerCase();
  const episodeCount = Number(next.episodeCount || next.latestEpisode || 0);
  if (status.includes('not yet') || status.includes('upcoming')) {
    return '<span class="pill sequel upcoming">Next: upcoming</span>';
  }
  if (episodeCount > 0 || status.includes('finished') || status.includes('releasing')) {
    return '<span class="pill sequel released">Next: released</span>';
  }
  return '<span class="pill sequel">Next season</span>';
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
  const resume = source === 'library' ? latestPositionForShow(show.id) : null;
  const next = resume?.episode || nextEpisode(show);
  const hasNews = Number(show.newCount) > 0;
  const thumb = thumbnailUrl(show);
  const playLabel = playActionLabel(show, source, Boolean(resume));
  const downloadedCount = downloadedEpisodeCount(show.id);
  const isTracked = source !== 'library' && state.library.some((item) => item.id === show.id);
  const schedulePills = releasePills(show);
  const extraActions = source === 'library'
    ? '<button class="danger" data-action="remove">Remove</button>'
    : isTracked
      ? '<button class="tracked" data-action="tracked" disabled>Tracked</button>'
      : '<button class="secondary" data-action="track">Track</button>';
  return `
    <article class="show-card" data-id="${escapeHtml(show.id)}" data-source="${source}">
      ${thumb
        ? `<img class="show-thumb" src="${escapeHtml(thumb)}" alt="" loading="lazy" decoding="async">`
        : `<div class="show-thumb placeholder" aria-hidden="true">${escapeHtml(showInitials(show))}</div>`}
      <div class="show-main">
        <div class="show-title">${escapeHtml(show.name || show.title)}</div>
        <div class="show-meta">
          <span class="pill">${escapeHtml(progressLabel(show, source))}</span>
          <span class="pill">${escapeHtml(show.mode || state.settings?.mode || 'sub')}</span>
          ${hasNews ? `<span class="pill hot">${show.newCount} new</span>` : ''}
          ${downloadedCount ? `<span class="pill downloaded">↓ ${downloadedCount} saved</span>` : ''}
          ${schedulePills.map((pill) => `<span class="pill schedule">${escapeHtml(pill)}</span>`).join('')}
          ${nextSeasonPill(show)}
          ${show.recommendationReason ? `<span class="pill reason">${escapeHtml(show.recommendationReason)}</span>` : ''}
          ${show.refreshError ? `<span class="pill danger">Refresh failed</span>` : ''}
        </div>
      </div>
      <div class="card-actions three">
        <button class="primary" data-action="play" data-ep="${escapeHtml(next)}">${escapeHtml(playLabel)}</button>
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
          const episodes = item.episodeCount ? `${item.episodeCount} episodes` : (item.status || 'No episodes yet');
          return `
            <article class="related-item" data-related-id="${escapeHtml(item.id)}">
              ${thumb
                ? `<img class="related-thumb" src="${escapeHtml(thumb)}" alt="" loading="lazy" decoding="async">`
                : `<div class="related-thumb placeholder" aria-hidden="true">${escapeHtml(showInitials(item))}</div>`}
              <div class="related-main">
                <span class="pill hot">${escapeHtml(relationLabel(item.relation))}</span>
                <strong>${escapeHtml(item.name || item.title || item.id)}</strong>
                <span>${escapeHtml([episodes, item.status].filter(Boolean).join(' · '))}</span>
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
  const fromLibrary = state.library.find((show) => show.id === id);
  if (fromLibrary) return fromLibrary;
  const fromSearch = state.searchResults.find((show) => show.id === id);
  if (fromSearch) return fromSearch;
  const title = card.querySelector('.show-title')?.textContent || '';
  const episodeCount = Number((card.querySelector('.show-meta .pill:nth-child(2)')?.textContent || '').replace(/\D+/g, '')) || undefined;
  return {
    id,
    name: title,
    title,
    episodeCount,
    mode: state.settings?.mode || 'sub',
  };
}

'use strict';

const hianime = require('./hianime');
const { enrichAnimeRelations, normalizeAnimeTitle } = require('./anilist');
const { normalizeEpisode, highestEpisode } = require('./episodes');
const { enrichEpisodeTitles } = require('./mal-episode-titles');
const {
  resolveAnimeCatalogIdentity,
  presentCatalogFields,
  bindCatalogToLibrary,
} = require('./library-identity');

// Library identity is independent of the upstream identifier. Stored mappings
// take precedence over client hints, including for archived entries.
function providerIdentity(state, input) {
  const request = typeof input === 'string' ? { id: input } : input;
  if (!request?.id || typeof request.id !== 'string') throw Object.assign(new Error('Missing show id'), { status: 422 });
  const identity = resolveAnimeCatalogIdentity(state.shows?.[request.id], request);
  if (!identity) throw Object.assign(new Error('Missing show id'), { status: 422 });
  if (identity.unsupported) throw Object.assign(new Error('Unsupported anime provider'), { status: 422 });
  if (identity.missing) {
    throw Object.assign(new Error('This title needs a catalog match before it can be used'), { status: 409 });
  }
  return identity;
}

function normalizeDetails(identity, details) {
  if (details.id !== identity.providerId) throw new Error('Anime provider returned the wrong identity');
  const rows = details.episodes || [];
  const episodes = [...new Set(rows.map((row) => normalizeEpisode(typeof row === 'object' ? row.number : row)).filter(Boolean))];
  return {
    ...details,
    id: identity.id,
    ...presentCatalogFields(identity),
    episodes,
    episodeTitles: { ...Object.fromEntries(rows.filter((row) => row && typeof row === 'object' && row.title).map((row) => [row.number, row.title])), ...details.episodeTitles },
    latestEpisode: highestEpisode(episodes) || details.latestEpisode || null,
  };
}


function catalogTitleKeys(item) {
  return [item?.name, item?.title, item?.englishName, item?.nativeName, ...(item?.alternativeTitles || []), ...(item?.synonyms || [])]
    .map(normalizeAnimeTitle).filter(Boolean);
}

async function mapAniListRelations(relations, catalog) {
  return Promise.all(relations.map(async (relation) => {
    if (!['sequel', 'prequel'].includes(relation.relation) || typeof catalog?.searchAnime !== 'function') return relation;
    const wanted = new Set(catalogTitleKeys({ alternativeTitles: relation.alternativeTitles }));
    for (const query of relation.alternativeTitles.slice(0, 3)) {
      let results;
      try { results = await catalog.searchAnime(query); } catch { continue; }
      const match = (results || []).find((candidate) => catalogTitleKeys(candidate).some((key) => wanted.has(key)));
      if (!match) continue;
      const providerId = String(match.providerId || match.hianimeId || match.id || '').trim();
      if (!providerId) continue;
      return {
        ...match,
        ...relation,
        id: String(match.id || providerId),
        name: relation.name,
        title: relation.title,
        sourceName: match.name || match.title || relation.name,
        provider: match.provider || 'hianime',
        providerId,
        hianimeId: match.hianimeId || providerId,
        playable: true,
      };
    }
    return relation;
  }));
}

function createAnimeProvider(adapters = { hianime }) {
  const catalog = adapters.catalog || adapters.hianime;
  const detailsCache = new Map();
  async function loadDetails(identity, mode, options) {
    const key = `${identity.provider}:${identity.providerId}:${mode}`;
    const cached = detailsCache.get(key);
    if (!options.force && cached && cached.expires > Date.now()) return structuredClone(await cached.value);
    const adapter = adapters[identity.provider] || catalog;
    if (!adapter?.getShowDetails) throw Object.assign(new Error('Unsupported anime provider'), { status: 422 });
    const entry = {
      expires: Date.now() + 5 * 60_000,
      value: Promise.resolve().then(() => adapter.getShowDetails(identity.providerId, mode, options)),
    };
    detailsCache.delete(key);
    detailsCache.set(key, entry);
    while (detailsCache.size > 128) detailsCache.delete(detailsCache.keys().next().value);
    try { return structuredClone(await entry.value); } catch (error) {
      if (detailsCache.get(key) === entry) detailsCache.delete(key);
      throw error;
    }
  }
  const service = {
    search(query) {
      return query ? catalog.searchAnime(query) : catalog.browseAnime('/recently-updated');
    },
    popular(range) {
      return catalog.popularAnime(range);
    },
    async details(state, input, mode = 'sub', options = {}) {
      const identity = providerIdentity(state, input);
      const value = await loadDetails(identity, mode, options);
      const normalized = normalizeDetails(identity, value);
      const stored = state?.shows?.[identity.id];
      if (stored) {
        normalized.malId = stored.malId || normalized.malId;
        normalized.episodeTitles = { ...stored.episodeTitles, ...normalized.episodeTitles };
      }
      let catalogRelations = null;
      try {
        catalogRelations = await enrichAnimeRelations(stored?.name || stored?.englishName || normalized.name || normalized.title);
      } catch { /* AniList is the source of anime relations and airing metadata. */ }
      if (catalogRelations) {
        normalized.anilistRelationsVerified = true;
        normalized.anilistStatus = catalogRelations.anilistStatus;
        normalized.anilistAiredStart = catalogRelations.anilistAiredStart;
        normalized.anilistAiredEnd = catalogRelations.anilistAiredEnd;
        normalized.anilistEpisodeCount = catalogRelations.anilistEpisodeCount;
        normalized.anilistId = catalogRelations.anilistId;
        normalized.anilistTitle = catalogRelations.anilistTitle;
        normalized.anilistEnglishTitle = catalogRelations.anilistEnglishTitle;
        normalized.anilistRomajiTitle = catalogRelations.anilistRomajiTitle;
        normalized.anilistNativeTitle = catalogRelations.anilistNativeTitle;
        normalized.anilistDescription = catalogRelations.anilistDescription;
        normalized.anilistFormat = catalogRelations.anilistFormat;
        normalized.anilistType = catalogRelations.anilistType;
        normalized.anilistGenres = catalogRelations.anilistGenres;
        normalized.anilistCoverImage = catalogRelations.anilistCoverImage;
        normalized.anilistEpisodeTitles = catalogRelations.anilistEpisodeTitles;
        if (catalogRelations.anilistTitle) {
          normalized.hianimeName = normalized.name || normalized.title || normalized.sourceName || '';
          normalized.name = catalogRelations.anilistTitle;
          normalized.title = catalogRelations.anilistTitle;
        }
        if (catalogRelations.anilistDescription) normalized.description = catalogRelations.anilistDescription;
        if (catalogRelations.anilistFormat) normalized.type = catalogRelations.anilistFormat;
        if (catalogRelations.anilistGenres) normalized.genres = catalogRelations.anilistGenres;
        if (catalogRelations.anilistCoverImage) normalized.thumbnail = catalogRelations.anilistCoverImage;
        const episodeTitles = { ...(normalized.episodeTitles || {}) };
        for (const [episode, title] of Object.entries(catalogRelations.anilistEpisodeTitles || {})) {
          const currentTitle = String(episodeTitles[episode] || '').trim();
          if (!currentTitle || /^episode\s*\d+(?:\.\d+)?$/i.test(currentTitle)) episodeTitles[episode] = title;
        }
        normalized.episodeTitles = episodeTitles;
        const mappedRelations = await mapAniListRelations(catalogRelations.relations, catalog);
        normalized.relations = mappedRelations;
        normalized.relatedShows = mappedRelations
          .filter((item) => item.playable)
          .map((item) => ({ relation: item.relation, showId: item.id }));
        normalized.previousSeason = mappedRelations.find((item) => item.relation === 'prequel') || undefined;
        normalized.nextSeason = mappedRelations.find((item) => item.relation === 'sequel') || undefined;
        normalized.hasNextSeason = Boolean(normalized.nextSeason);
      } else {
        normalized.anilistRelationsVerified = false;
        normalized.relations = [];
        normalized.relatedShows = [];
        delete normalized.previousSeason;
        delete normalized.nextSeason;
        normalized.hasNextSeason = false;
        delete normalized.anilistStatus;
        delete normalized.anilistAiredStart;
        delete normalized.anilistAiredEnd;
        delete normalized.anilistEpisodeCount;
        delete normalized.anilistId;
        delete normalized.anilistTitle;
        delete normalized.anilistEnglishTitle;
        delete normalized.anilistRomajiTitle;
        delete normalized.anilistNativeTitle;
        delete normalized.anilistDescription;
        delete normalized.anilistFormat;
        delete normalized.anilistType;
        delete normalized.anilistGenres;
        delete normalized.anilistCoverImage;
        delete normalized.anilistEpisodeTitles;
      }
      return options.enrichEpisodeTitles ? enrichEpisodeTitles(state, normalized) : normalized;
    },
    async playback(state, input, options) {
      const identity = providerIdentity(state, input);
      const adapter = adapters[identity.provider] || catalog;
      if (!adapter?.resolveEpisodePlayback) throw Object.assign(new Error('Unsupported anime provider'), { status: 422 });
      return adapter.resolveEpisodePlayback({ ...options, showId: identity.providerId });
    },
    async summaries(state, ids, mode) {
      const unique = [...new Set(ids.map(String))].slice(0, 40);
      const summaries = new Map();
      for (let offset = 0; offset < unique.length; offset += 3) {
        await Promise.all(unique.slice(offset, offset + 3).map(async (id) => {
          try { summaries.set(id, await service.details(state, id, mode)); }
          catch { /* Keep known relation metadata when its provider is unavailable. */ }
        }));
      }
      return summaries;
    },
  };
  return service;
}

module.exports = { ...createAnimeProvider(), createAnimeProvider, providerIdentity, normalizeDetails, bindCatalogToLibrary };

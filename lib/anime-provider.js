'use strict';

const hianime = require('./hianime');
const { enrichAnimeRelations, enrichAnimeCard, normalizeAnimeTitle } = require('./anilist');
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


function sequenceSignature(value) {
  const title = String(value || '').toLowerCase();
  const season = title.match(/\b(?:season|s)\s*(\d+)\b|\b(\d+)(?:st|nd|rd|th)\s+season\b/);
  const part = title.match(/\b(?:cour|part|course)\s*(\d+)\b|\b(\d+)(?:st|nd|rd|th)\s+(?:cour|part|course)\b/);
  return season || part ? {
    season: season ? Number(season[1] || season[2]) : null,
    part: part ? Number(part[1] || part[2]) : null,
  } : null;
}

function titleSimilarity(left, right) {
  const a = normalizeAnimeTitle(left);
  const b = normalizeAnimeTitle(right);
  if (!a || !b) return 0;
  if (a === b) return 100;
  const aTokens = new Set(a.split(' '));
  const bTokens = new Set(b.split(' '));
  const overlap = [...aTokens].filter((token) => bTokens.has(token)).length;
  const coverage = Math.min(overlap / aTokens.size, overlap / bTokens.size);
  return coverage >= 0.75 ? Math.round(coverage * 90) : 0;
}

function relationMatchScore(relation, candidate) {
  const relationTitles = [relation.name, relation.title, ...(relation.alternativeTitles || [])].filter(Boolean);
  const candidateTitles = [candidate.name, candidate.title, candidate.englishName, candidate.nativeName, ...(candidate.alternativeTitles || []), ...(candidate.synonyms || [])].filter(Boolean);
  const expected = relationTitles.map(sequenceSignature).find(Boolean);
  if (expected) {
    const compatibleSequence = candidateTitles.some((title) => {
      const actual = sequenceSignature(title);
      if (!actual) return false;
      if (expected.part !== null) return actual.part === expected.part;
      return actual.season === expected.season;
    });
    if (!compatibleSequence) return 0;
  }
  let score = 0;
  for (const left of relationTitles) {
    for (const right of candidateTitles) {
      const a = sequenceSignature(left);
      const b = sequenceSignature(right);
      if (a && b && ((a.part !== null && b.part !== null && a.part !== b.part)
        || (a.season !== null && b.season !== null && a.season !== b.season))) continue;
      score = Math.max(score, titleSimilarity(left, right));
    }
  }
  return score;
}

async function mapAniListRelations(relations, catalog) {
  return Promise.all(relations.map(async (relation) => {
    if (!['sequel', 'prequel'].includes(relation.relation) || typeof catalog?.searchAnime !== 'function') return relation;
    const queries = [...new Set([relation.name, relation.title, ...(relation.alternativeTitles || [])].filter(Boolean))].slice(0, 6);
    const candidates = new Map();
    for (const query of queries) {
      let results;
      try { results = await catalog.searchAnime(query); } catch { continue; }
      for (const candidate of results || []) {
        const providerId = String(candidate.providerId || candidate.hianimeId || candidate.id || '').trim();
        if (!providerId) continue;
        const score = relationMatchScore(relation, candidate);
        const previous = candidates.get(providerId);
        if (!previous || score > previous.score) candidates.set(providerId, { candidate, providerId, score });
      }
    }
    const ranked = [...candidates.values()].filter((item) => item.score >= 70)
      .sort((a, b) => b.score - a.score || a.providerId.localeCompare(b.providerId));
    if (!ranked.length || (ranked[1] && ranked[0].score - ranked[1].score < 8)) return relation;
    const { candidate, providerId, score } = ranked[0];
    if (score < 100 && typeof catalog.getShowSummary === 'function') {
      try {
        const verified = await catalog.getShowSummary(providerId);
        if (verified?.id && String(verified.id) !== providerId) return relation;
        if (verified?.malId && relation.anilistMalId && Number(verified.malId) !== Number(relation.anilistMalId)) return relation;
        const returnedTitle = verified?.name || verified?.title;
        if (returnedTitle && relationMatchScore(relation, { ...candidate, name: returnedTitle }) < 65) return relation;
        const expected = [relation.name, relation.title, ...(relation.alternativeTitles || [])].map(sequenceSignature).find(Boolean);
        const actual = sequenceSignature(returnedTitle);
        if (expected?.part !== null && expected?.part !== undefined && actual?.part !== null && actual?.part !== undefined && expected.part !== actual.part) return relation;
        if (expected?.season !== null && expected?.season !== undefined && actual?.season !== null && actual?.season !== undefined && expected.season !== actual.season) return relation;
      } catch {
        return relation;
      }
    }
    return {
      ...candidate,
      ...relation,
      id: String(candidate.id || providerId),
      name: relation.name,
      title: relation.title,
      sourceName: candidate.name || candidate.title || relation.name,
      provider: candidate.provider || 'hianime',
      providerId,
      hianimeId: candidate.hianimeId || providerId,
      playable: true,
    };
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
  async function enrichCards(items = []) {
    const results = Array.isArray(items) ? items : [];
    if (catalog !== hianime) return results;
    const enriched = [];
    for (let offset = 0; offset < results.length; offset += 3) {
      const chunk = results.slice(offset, offset + 3);
      const values = await Promise.all(chunk.map((item) => enrichAnimeCard(item).catch(() => item)));
      enriched.push(...values);
    }
    return enriched;
  }
  const service = {
    async search(query, options = {}) {
      const hasFilters = (Array.isArray(options.genres) && options.genres.length) || options.year;
      const results = hasFilters
        ? await catalog.searchAnime(query, options)
        : await (query ? catalog.searchAnime(query) : catalog.browseAnime('/recently-updated'));
      return enrichCards(results);
    },
    async popular(range) {
      return enrichCards(await catalog.popularAnime(range));
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

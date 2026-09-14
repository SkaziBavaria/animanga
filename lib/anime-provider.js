'use strict';

const hianime = require('./hianime');
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

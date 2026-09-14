'use strict';

const ANIME_CATALOG_PROVIDERS = new Set(['hianime']);

function catalogKey(provider, providerId) {
  const name = String(provider || '').trim();
  const id = String(providerId || '').trim();
  return name && id ? `${name}:${id}` : '';
}

function hasAnimeCatalogMapping(record) {
  return Boolean(String(record?.providerId || record?.hianimeId || '').trim());
}

function presentCatalogFields(identity) {
  if (!identity?.provider || !identity.providerId) return {};
  return {
    provider: identity.provider,
    providerId: identity.providerId,
    ...(identity.provider === 'hianime' ? { hianimeId: identity.providerId } : {}),
  };
}

function resolveAnimeCatalogIdentity(stored, request) {
  const source = stored || request;
  const libraryId = String(source?.id || '').trim();
  if (!libraryId) return null;
  const mappedId = String(source.providerId || source.hianimeId || '').trim();
  const declared = String(source.provider || '').trim();
  if (declared && !ANIME_CATALOG_PROVIDERS.has(declared)) {
    if (mappedId) {
      return { id: libraryId, provider: 'hianime', providerId: mappedId };
    }
    if (stored) return { id: libraryId, provider: declared, providerId: '', missing: true };
    return {
      id: libraryId,
      provider: declared,
      providerId: libraryId,
      unsupported: true,
    };
  }
  if (stored && !mappedId && declared !== 'hianime') {
    return { id: libraryId, provider: 'hianime', providerId: '', missing: true };
  }
  return {
    id: libraryId,
    provider: declared || 'hianime',
    providerId: mappedId || libraryId,
  };
}

function catalogIdFromItem(item) {
  if (!item) return '';
  return String(item.providerId || item.hianimeId || (item.provider ? item.id : '') || '').trim();
}

function applyAnimeCatalogMapping(record, { provider, providerId } = {}) {
  const id = String(record?.id || '').trim();
  const mappedId = String(providerId || '').trim();
  if (!id || !provider || !mappedId) return record;
  const mapped = {
    ...record,
    id,
    ...presentCatalogFields({ provider, providerId: mappedId }),
    providerMigrationStatus: 'migrated',
    providerMigrationReason: '',
    providerMigratedAt: new Date().toISOString(),
  };
  if (!hasAnimeCatalogMapping(record) && id !== mappedId) {
    mapped.legacyAnidbId = record.legacyAnidbId || record.id;
  }
  return mapped;
}

function indexAnimeByCatalog(shows) {
  const index = new Map();
  for (const show of Object.values(shows || {})) {
    const identity = resolveAnimeCatalogIdentity(show, show);
    const key = identity && !identity.unsupported && !identity.missing
      ? catalogKey(identity.provider, identity.providerId)
      : '';
    if (key && !index.has(key)) index.set(key, show);
  }
  return index;
}

function bindCatalogToLibrary(state, results) {
  const index = indexAnimeByCatalog(state?.shows);
  return (results || []).map((item) => {
    const provider = item.provider || (item.hianimeId || item.providerId ? 'hianime' : '');
    const existing = index.get(catalogKey(provider, catalogIdFromItem(item)));
    return existing ? { ...item, id: existing.id } : item;
  });
}

function catalogFieldsFromClient(body) {
  const providerId = String(body?.providerId || body?.hianimeId || '').trim();
  const provider = String(body?.provider || (providerId ? 'hianime' : '')).trim();
  if (!ANIME_CATALOG_PROVIDERS.has(provider) || !providerId) return {};
  return presentCatalogFields({ provider, providerId });
}

module.exports = {
  ANIME_CATALOG_PROVIDERS,
  catalogKey,
  hasAnimeCatalogMapping,
  presentCatalogFields,
  resolveAnimeCatalogIdentity,
  catalogIdFromItem,
  applyAnimeCatalogMapping,
  indexAnimeByCatalog,
  bindCatalogToLibrary,
  catalogFieldsFromClient,
};

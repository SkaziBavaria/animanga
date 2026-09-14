'use strict';

const providers = new Map();

function providerForUrl(value) {
  let host;
  try { host = new URL(String(value)).hostname.toLowerCase(); } catch { return null; }
  if (host === 'hianime.at' || host.endsWith('.hianime.at')) return 'hianime';
  if (host === 'api.comick.dev' || host.endsWith('.comick.dev')) return 'comick';
  if (host === 'api.mangadex.org' || host.endsWith('.mangadex.org')) return 'mangadex';
  if (host.includes('weebcentral')) return 'weebcentral';
  if (host.includes('mangapill')) return 'mangapill';
  if (host.includes('mangatown')) return 'mangatown';
  return null;
}

function safeFailure(error) {
  const text = String(error?.message || error || 'Upstream request failed');
  const status = Number(text.match(/(?:HTTP|error:)\s*(\d{3})/i)?.[1]) || null;
  let reason = status ? `HTTP ${status}` : 'Connection or response error';
  if (/maintenance/i.test(text)) reason = status ? `Maintenance (HTTP ${status})` : 'Maintenance';
  else if (/timed? ?out|timeout/i.test(text)) reason = 'Timeout';
  else if (/resolve|dns/i.test(text)) reason = 'DNS error';
  else if (/tls|ssl|certificate/i.test(text)) reason = 'TLS error';
  else if (/challenge|cloudflare/i.test(text)) reason = 'Upstream protection';
  else if (/mismatch|invalid|incomplete|non-json|error page/i.test(text)) reason = 'Invalid upstream response';
  return { status, reason };
}

function recordProviderSuccess(provider, now = Date.now()) {
  if (!provider) return;
  providers.set(provider, { provider, ok: true, checkedAt: new Date(now).toISOString() });
}

function recordProviderFailure(provider, error, { retryAt = null, now = Date.now() } = {}) {
  if (!provider) return;
  const safe = safeFailure(error);
  if (error instanceof Error) {
    const labels = { hianime: 'HiAnime', comick: 'ComicK', mangadex: 'MangaDex', weebcentral: 'WeebCentral', mangapill: 'MangaPill', mangatown: 'MangaTown' };
    error.publicFailure = {
      provider,
      mediaMode: provider === 'hianime' ? 'anime' : 'manga',
      upstreamStatus: safe.status,
      reason: safe.reason,
      code: safe.status ? 'UPSTREAM_HTTP' : ({ Timeout: 'UPSTREAM_TIMEOUT', 'DNS error': 'UPSTREAM_DNS', 'TLS error': 'UPSTREAM_TLS', 'Upstream protection': 'UPSTREAM_PROTECTION', 'Invalid upstream response': 'UPSTREAM_RESPONSE', Maintenance: 'UPSTREAM_MAINTENANCE' }[safe.reason] || 'UPSTREAM_CONNECTION'),
      error: safe.status ? `${labels[provider] || 'Provider'} unavailable (HTTP ${safe.status})` : `${labels[provider] || 'Provider'}: ${safe.reason}`,
    };
  }
  providers.set(provider, {
    provider,
    ok: false,
    ...safe,
    checkedAt: new Date(now).toISOString(),
    retryAt: retryAt ? new Date(retryAt).toISOString() : null,
  });
}

function providerHealth() {
  return Object.fromEntries([...providers.entries()].map(([key, value]) => [key, { ...value }]));
}

const RETIRED_PROVIDERS = new Set();
const FAILURE_VISIBLE_MS = 60_000;

function visibleProviderHealth(now = Date.now()) {
  return Object.fromEntries(
    Object.entries(providerHealth()).filter(([provider, value]) => {
      if (RETIRED_PROVIDERS.has(provider)) return false;
      if (value?.ok !== false) return true;
      const checked = Date.parse(value.checkedAt);
      return Number.isFinite(checked) && now - checked < FAILURE_VISIBLE_MS;
    }),
  );
}

function resetProviderHealth() {
  providers.clear();
}

function publicProviderFailure(error) {
  const seen = new Set();
  while (error && !seen.has(error)) {
    if (error.publicFailure) return error.publicFailure;
    seen.add(error);
    error = error.cause;
  }
  return null;
}

module.exports = {
  providerForUrl,
  recordProviderSuccess,
  recordProviderFailure,
  providerHealth,
  visibleProviderHealth,
  resetProviderHealth,
  publicProviderFailure,
  FAILURE_VISIBLE_MS,
};

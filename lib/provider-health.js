'use strict';

const providers = new Map();

function providerForUrl(value) {
  let host = '';
  try { host = new URL(String(value)).hostname.toLowerCase(); } catch { return null; }
  if (host === 'anidb.app' || host.endsWith('.anidb.app')) return 'anidb';
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

function resetProviderHealth() {
  providers.clear();
}

module.exports = {
  providerForUrl,
  recordProviderSuccess,
  recordProviderFailure,
  providerHealth,
  resetProviderHealth,
};

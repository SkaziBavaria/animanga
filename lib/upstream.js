'use strict';

const DEFAULT_UPSTREAM_TIMEOUT_MS = 15_000;

class UpstreamTimeoutError extends Error {
  constructor(timeoutMs, url = '') {
    super(`Upstream request timed out after ${timeoutMs}ms${url ? ` (${url})` : ''}`);
    this.name = 'UpstreamTimeoutError';
    this.code = 'UPSTREAM_TIMEOUT';
    this.status = 504;
  }
}

function combinedSignal(parent, timeout) {
  if (!parent) return timeout;
  return AbortSignal.any([parent, timeout]);
}

async function fetchWithTimeout(fetcher, url, options = {}, timeoutMs = DEFAULT_UPSTREAM_TIMEOUT_MS) {
  const timeout = AbortSignal.timeout(timeoutMs);
  try {
    return await fetcher(url, {
      ...options,
      signal: combinedSignal(options.signal, timeout),
    });
  } catch (error) {
    if (timeout.aborted) throw new UpstreamTimeoutError(timeoutMs, String(url));
    throw error;
  }
}

module.exports = {
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  UpstreamTimeoutError,
  fetchWithTimeout,
};

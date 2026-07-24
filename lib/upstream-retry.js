'use strict';

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(error) {
  const message = String(error?.message || error || '');
  return /try again in\s+\d+\s+seconds?/i.test(message)
    || /rate[\s_-]?limit/i.test(message)
    || /too many (?:requests|queries)/i.test(message)
    || /\b429\b/.test(message);
}

function retryDelay(error, attempt) {
  const seconds = Number(String(error?.message || '').match(/try again in\s+(\d+)\s+seconds?/i)?.[1]);
  if (Number.isFinite(seconds) && seconds > 0) return (seconds * 1000) + 150;
  if (isRateLimitError(error)) return Math.min(8000, 500 * (2 ** attempt));
  return 150 * (attempt + 1);
}

async function withUpstreamRetry(run, { attempts = 4, shouldRetry = isRateLimitError } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await run(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts - 1 || !shouldRetry(error)) throw error;
      await wait(retryDelay(error, attempt));
    }
  }
  throw lastError || new Error('Upstream request failed');
}

module.exports = {
  wait,
  isRateLimitError,
  retryDelay,
  withUpstreamRetry,
};

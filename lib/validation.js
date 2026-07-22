'use strict';

const { HttpError } = require('./http');

function invalid(message, details) {
  throw new HttpError(422, message, details);
}

function requiredString(body, key, options = {}) {
  const value = body?.[key];
  if (typeof value !== 'string' && typeof value !== 'number') {
    invalid(`Missing ${options.label || key}`);
  }
  const normalized = String(value).trim();
  if (!normalized) invalid(`Missing ${options.label || key}`);
  if (normalized.length > (options.maxLength || 500)) {
    invalid(`${options.label || key} is too long`);
  }
  return normalized;
}

function stringArray(body, key, options = {}) {
  const value = body?.[key];
  if (!Array.isArray(value)) invalid(`${options.label || key} must be an array`);
  const result = value.map((item) => String(item).trim()).filter(Boolean);
  if (result.some((item) => item.length > (options.maxLength || 100))) {
    invalid(`${options.label || key} contains an invalid value`);
  }
  return result;
}

function settingsPatch(body) {
  const allowed = new Set(['mode', 'quality', 'skipIntro', 'autoTrackPlayed']);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length) invalid('Unknown settings field', { fields: unknown });

  const patch = {};
  if (Object.hasOwn(body, 'mode')) {
    if (!['sub', 'dub'].includes(body.mode)) invalid('mode must be sub or dub');
    patch.mode = body.mode;
  }
  if (Object.hasOwn(body, 'quality')) {
    if (!['best', '1080', '720', '480', 'worst'].includes(String(body.quality))) {
      invalid('Unsupported quality');
    }
    patch.quality = String(body.quality);
  }
  for (const key of ['skipIntro', 'autoTrackPlayed']) {
    if (!Object.hasOwn(body, key)) continue;
    if (typeof body[key] !== 'boolean') invalid(`${key} must be a boolean`);
    patch[key] = body[key];
  }
  return patch;
}

module.exports = { invalid, requiredString, stringArray, settingsPatch };

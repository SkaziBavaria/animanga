'use strict';

const { normalizeEpisode } = require('./episodes');

const MIN_POSITION = 5;
const END_MARGIN = 15;
const END_RATIO = 0.95;

function positionKey(showId, episode) {
  return `${showId}:${normalizeEpisode(episode)}`;
}

function setPosition(state, { id, episode, position, duration }) {
  state.positions ||= {};
  if (!id || !episode) return { cleared: true };
  const key = positionKey(id, episode);
  const pos = Number(position);
  const dur = Number(duration);
  if (!Number.isFinite(pos) || pos < 0) return { cleared: true };

  const nearEnd = Number.isFinite(dur) && dur > 0 && (pos >= dur - END_MARGIN || pos / dur >= END_RATIO);
  if (pos < MIN_POSITION || nearEnd) {
    delete state.positions[key];
    return { cleared: true };
  }

  state.positions[key] = {
    showId: id,
    episode: normalizeEpisode(episode),
    position: pos,
    duration: Number.isFinite(dur) && dur > 0 ? dur : null,
    updatedAt: new Date().toISOString(),
  };
  return { position: state.positions[key] };
}

function clearPosition(state, id, episode) {
  state.positions ||= {};
  delete state.positions[positionKey(id, episode)];
}

function presentPositions(state) {
  return state.positions || {};
}

module.exports = {
  positionKey,
  setPosition,
  clearPosition,
  presentPositions,
};

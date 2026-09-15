export function visualViewportBox(viewport, fallback = {}) {
  const pick = (primary, secondary) => {
    const first = Number(primary);
    if (Number.isFinite(first) && first > 0) return Math.round(first);
    const next = Number(secondary);
    if (Number.isFinite(next) && next > 0) return Math.round(next);
    return 1;
  };
  return {
    width: pick(viewport?.width, fallback.width),
    height: pick(viewport?.height, fallback.height),
  };
}

export function applyPlayerFullscreenViewport(element, active, box = {}) {
  if (!element?.style) return;
  if (!active) {
    element.style.removeProperty('--player-fullscreen-width');
    element.style.removeProperty('--player-fullscreen-height');
    return;
  }
  const size = visualViewportBox(box, box);
  element.style.setProperty('--player-fullscreen-width', `${size.width}px`);
  element.style.setProperty('--player-fullscreen-height', `${size.height}px`);
}

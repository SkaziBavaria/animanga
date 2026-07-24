import { els } from './dom.js';

const MOVE_THRESHOLD = 8;
const DOUBLE_TAP_MS = 280;
const BRIGHTNESS_MIN = 0.1;
const BRIGHTNESS_MAX = 2;
const BRIGHTNESS_RANGE = 1.6;

let brightness = 1;
let lastTap = { at: 0, side: null };
let tapTimer = 0;

export function setupPlayerGestures({ onTap, onSeek, isSeekChainActive } = {}) {
  const stage = document.getElementById('playerStage');
  const osd = document.getElementById('playerOsd');
  const video = els.playerVideo;
  if (!stage || !osd || !video) return;

  const touchCapable = 'ontouchstart' in window
    || (window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  if (!touchCapable) return;
  stage.classList.add('touch-enabled');

  video.style.filter = `brightness(${brightness})`;

  let active = null;
  let osdTimer = 0;

  const showOsd = (label, percent, side = 'center') => {
    osd.textContent = percent == null ? label : `${label} ${Math.round(percent)}%`;
    osd.classList.toggle('osd-left', side === 'left');
    osd.classList.toggle('osd-right', side === 'right');
    osd.classList.add('show');
    clearTimeout(osdTimer);
    osdTimer = setTimeout(() => {
      osd.classList.remove('show', 'osd-left', 'osd-right');
    }, 700);
  };

  const onStart = (side, event) => {
    const touch = event.touches[0];
    active = {
      side,
      moved: false,
      startY: touch.clientY,
      startVolume: video.volume,
      startBrightness: brightness,
      height: event.currentTarget.clientHeight || video.clientHeight || 1,
    };
  };

  const onMove = (event) => {
    if (!active) return;
    const touch = event.touches[0];
    const deltaY = active.startY - touch.clientY;
    if (Math.abs(deltaY) > MOVE_THRESHOLD) active.moved = true;
    const ratio = deltaY / active.height;

    if (active.side === 'right') {
      const value = Math.min(1, Math.max(0, active.startVolume + ratio));
      video.volume = value;
      if (value > 0) video.muted = false;
      showOsd(value === 0 ? 'Mute' : 'Vol', value * 100, 'right');
    } else {
      const value = Math.min(BRIGHTNESS_MAX, Math.max(BRIGHTNESS_MIN, active.startBrightness + ratio * BRIGHTNESS_RANGE));
      brightness = value;
      video.style.filter = `brightness(${value})`;
      showOsd('Bright', value * 100, 'left');
    }
    event.preventDefault();
  };

  const onEnd = (event) => {
    if (active && !active.moved) {
      event.preventDefault();
      const now = Date.now();
      const seekSeconds = active.side === 'right' ? 10 : -10;

      if (isSeekChainActive?.()) {
        clearTimeout(tapTimer);
        lastTap = { at: 0, side: null };
        onSeek?.(active.side, seekSeconds);
      } else if (lastTap.side === active.side && now - lastTap.at <= DOUBLE_TAP_MS) {
        clearTimeout(tapTimer);
        lastTap = { at: 0, side: null };
        onSeek?.(active.side, seekSeconds);
      } else {
        lastTap = { at: now, side: active.side };
        clearTimeout(tapTimer);
        tapTimer = setTimeout(() => {
          onTap?.();
          lastTap = { at: 0, side: null };
        }, DOUBLE_TAP_MS);
      }
    }
    active = null;
  };

  const left = stage.querySelector('.gesture-left');
  const right = stage.querySelector('.gesture-right');
  if (!left || !right) return;

  left.addEventListener('touchstart', (event) => onStart('left', event), { passive: true });
  right.addEventListener('touchstart', (event) => onStart('right', event), { passive: true });
  for (const zone of [left, right]) {
    zone.addEventListener('touchmove', onMove, { passive: false });
    zone.addEventListener('touchend', onEnd, { passive: false });
    zone.addEventListener('touchcancel', onEnd, { passive: false });
  }
}

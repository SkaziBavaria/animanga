import { els } from './dom.js';

const MOVE_THRESHOLD = 8;
const BRIGHTNESS_MIN = 0.1;
const BRIGHTNESS_MAX = 2;
const BRIGHTNESS_RANGE = 1.6;

let brightness = 1;

export function setupPlayerGestures() {
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

  const showOsd = (icon, percent) => {
    osd.textContent = `${icon} ${Math.round(percent)}%`;
    osd.classList.add('show');
    clearTimeout(osdTimer);
    osdTimer = setTimeout(() => osd.classList.remove('show'), 700);
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

    if (active.side === 'volume') {
      const value = Math.min(1, Math.max(0, active.startVolume + ratio));
      video.volume = value;
      if (value > 0) video.muted = false;
      showOsd(value === 0 ? '🔇' : '🔊', value * 100);
    } else {
      const value = Math.min(BRIGHTNESS_MAX, Math.max(BRIGHTNESS_MIN, active.startBrightness + ratio * BRIGHTNESS_RANGE));
      brightness = value;
      video.style.filter = `brightness(${value})`;
      showOsd('☀', value * 100);
    }
    event.preventDefault();
  };

  const onEnd = () => {
    if (active && !active.moved) {
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    }
    active = null;
  };

  const left = stage.querySelector('.gesture-left');
  const right = stage.querySelector('.gesture-right');

  left.addEventListener('touchstart', (event) => onStart('brightness', event), { passive: true });
  right.addEventListener('touchstart', (event) => onStart('volume', event), { passive: true });
  for (const zone of [left, right]) {
    zone.addEventListener('touchmove', onMove, { passive: false });
    zone.addEventListener('touchend', onEnd);
    zone.addEventListener('touchcancel', onEnd);
  }
}

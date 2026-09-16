'use strict';

export const CAPTION_TRACK_OFF = 'off';

export function sidecarSubtitleSrc(playback) {
  const proxied = String(playback?.subtitleProxyUrl || '').trim();
  if (proxied.startsWith('/')) return proxied;
  const local = String(playback?.subtitle || '').trim();
  if (local.startsWith('/')) return local;
  return '';
}

function captionTrackFromPlayback(playback, fallbackId) {
  const src = sidecarSubtitleSrc(playback);
  if (!src) return null;
  return {
    id: fallbackId || 'c0',
    lang: String(playback?.subtitleLang || '').trim().slice(0, 16),
    label: String(playback?.subtitleLabel || 'Captions').trim().slice(0, 64) || 'Captions',
    default: true,
    subtitleProxyUrl: src,
  };
}

export function playbackCaptionTracks(playback) {
  const listed = Array.isArray(playback?.subtitleTracks) ? playback.subtitleTracks : [];
  const tracks = listed
    .map((track, index) => {
      const src = String(track?.subtitleProxyUrl || '').trim();
      if (!src.startsWith('/')) return null;
      return {
        id: String(track.id || `c${index}`),
        lang: String(track.lang || '').trim().slice(0, 16),
        label: String(track.label || 'Captions').trim().slice(0, 64) || 'Captions',
        default: Boolean(track.default),
        subtitleProxyUrl: src,
      };
    })
    .filter(Boolean);
  if (tracks.length) return tracks;
  const fallback = captionTrackFromPlayback(playback);
  return fallback ? [fallback] : [];
}

export function selectedCaptionTrackId(tracks) {
  const list = Array.isArray(tracks) ? tracks : [];
  return list.find((track) => track.default)?.id || list[0]?.id || CAPTION_TRACK_OFF;
}

export function captionTrackById(tracks, id) {
  if (id === CAPTION_TRACK_OFF) return null;
  return (Array.isArray(tracks) ? tracks : []).find((track) => track.id === id) || null;
}

export function sidecarTrackProps(playback) {
  const src = sidecarSubtitleSrc(playback);
  if (!src) return null;
  const lang = String(playback?.subtitleLang || 'en').trim().slice(0, 16) || 'en';
  const label = String(playback?.subtitleLabel || 'English').trim().slice(0, 64) || 'English';
  return {
    kind: 'subtitles',
    srclang: lang,
    label,
    src,
    default: true,
  };
}

export function parseVttTimestamp(value) {
  const text = String(value || '').trim().replace(',', '.');
  const parts = text.split(':');
  if (parts.length === 2) return (Number(parts[0]) * 60) + Number(parts[1]);
  if (parts.length === 3) return (Number(parts[0]) * 3600) + (Number(parts[1]) * 60) + Number(parts[2]);
  return Number.NaN;
}

export function parseWebVtt(source) {
  const text = String(source || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!/^WEBVTT/m.test(text)) return [];
  const cues = [];
  for (const block of text.split(/\n\n+/)) {
    const lines = block.split('\n').map((line) => line.trimEnd()).filter(Boolean);
    if (!lines.length || /^WEBVTT\b/i.test(lines[0]) || /^(NOTE|STYLE|REGION)\b/i.test(lines[0])) continue;
    const timeLine = lines.find((line) => line.includes('-->'));
    if (!timeLine) continue;
    const timed = timeLine.match(/(\S+)\s+-->\s+(\S+)/);
    if (!timed) continue;
    const start = parseVttTimestamp(timed[1]);
    const end = parseVttTimestamp(timed[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const payload = lines.slice(lines.indexOf(timeLine) + 1).join('\n').trim();
    if (!payload) continue;
    cues.push({ start, end, text: payload });
  }
  return cues;
}

export function cuePlainText(value) {
  let text = String(value || '');
  for (let n = 0; n < 8; n += 1) {
    const next = text.replace(/<[^>]*>/g, '');
    if (next === text) break;
    text = next;
  }
  return text
    .replace(/[<>]/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export function containedMediaBox(elementWidth, elementHeight, mediaWidth, mediaHeight) {
  const width = Number(elementWidth);
  const height = Number(elementHeight);
  const vw = Number(mediaWidth);
  const vh = Number(mediaHeight);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { left: 0, top: 0, width: 0, height: 0 };
  }
  if (!Number.isFinite(vw) || !Number.isFinite(vh) || vw <= 0 || vh <= 0) {
    return { left: 0, top: 0, width, height };
  }
  const mediaRatio = vw / vh;
  const elementRatio = width / height;
  if (elementRatio > mediaRatio) {
    const contentWidth = height * mediaRatio;
    return { left: (width - contentWidth) / 2, top: 0, width: contentWidth, height };
  }
  const contentHeight = width / mediaRatio;
  return { left: 0, top: (height - contentHeight) / 2, width, height: contentHeight };
}

export function captionFontSizeFromPicture(pictureHeight) {
  const height = Number(pictureHeight);
  if (!Number.isFinite(height) || height <= 0) return 18;
  // ~5% of picture height matches typical player "standard" subtitle size.
  return Math.round(Math.min(40, Math.max(16, height * 0.05)));
}

export function captionOverlayLayout({
  stageWidth,
  stageHeight,
  videoLeft,
  videoTop,
  videoWidth,
  videoHeight,
  mediaWidth,
  mediaHeight,
  controlsVisible,
} = {}) {
  const content = containedMediaBox(videoWidth, videoHeight, mediaWidth, mediaHeight);
  const contentLeft = Number(videoLeft || 0) + content.left;
  const contentBottom = Number(videoTop || 0) + content.top + content.height;
  const letterboxBottom = Math.max(0, Number(stageHeight || 0) - contentBottom);
  const minClearance = controlsVisible ? 56 : 16;
  const sidePad = Math.max(12, content.width * 0.06);
  return {
    bottom: Math.max(letterboxBottom + 12, minClearance),
    left: contentLeft + sidePad,
    right: Math.max(0, Number(stageWidth || 0) - (contentLeft + content.width) + sidePad),
    fontSize: captionFontSizeFromPicture(content.height),
  };
}

export function applyCaptionOverlayLayout(overlay, layout) {
  if (!overlay) return;
  if (!layout) {
    overlay.style.bottom = '';
    overlay.style.left = '';
    overlay.style.right = '';
    overlay.style.fontSize = '';
    return;
  }
  overlay.style.bottom = `${Math.round(layout.bottom)}px`;
  overlay.style.left = `${Math.round(layout.left)}px`;
  overlay.style.right = `${Math.round(layout.right)}px`;
  overlay.style.fontSize = `${Math.round(layout.fontSize)}px`;
}

export function activeCueText(cues, seconds) {
  const time = Number(seconds);
  if (!Number.isFinite(time) || !Array.isArray(cues) || !cues.length) return '';
  return cues
    .filter((cue) => time >= cue.start && time < cue.end)
    .map((cue) => cuePlainText(cue.text))
    .filter(Boolean)
    .join('\n');
}

'use strict';

export function sidecarSubtitleSrc(playback) {
  const proxied = String(playback?.subtitleProxyUrl || '').trim();
  if (proxied.startsWith('/')) return proxied;
  const local = String(playback?.subtitle || '').trim();
  if (local.startsWith('/')) return local;
  return '';
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

export function activeCueText(cues, seconds) {
  const time = Number(seconds);
  if (!Number.isFinite(time) || !Array.isArray(cues) || !cues.length) return '';
  return cues
    .filter((cue) => time >= cue.start && time < cue.end)
    .map((cue) => cuePlainText(cue.text))
    .filter(Boolean)
    .join('\n');
}

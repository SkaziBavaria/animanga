'use strict';

let hlsLoader = null;

export function isHlsPlaybackUrl(value) {
  return /\.m3u8(?:\b|$)/i.test(String(value || ''));
}

export function browserHlsOptions() {
  return {
    enableWorker: true,
    renderTextTracksNatively: false,
    subtitleDisplay: false,
    enableWebVTT: false,
    enableIMSC1: false,
    enableCEA708Captions: false,
  };
}

export function disableNativeVideoTextTracks(video) {
  const tracks = video?.textTracks;
  if (!tracks) return;
  for (let index = 0; index < tracks.length; index += 1) {
    tracks[index].mode = 'disabled';
  }
}

export function nativeHlsSupported(video) {
  if (!video?.canPlayType) return false;
  return Boolean(
    video.canPlayType('application/vnd.apple.mpegurl')
    || video.canPlayType('application/x-mpegURL'),
  );
}

export function hlsPlaybackStrategy({ url, sourceUrl, canPlayNativeHls, mseHlsSupported }) {
  if (!isHlsPlaybackUrl(url) && !isHlsPlaybackUrl(sourceUrl)) return 'progressive';
  // Chrome/Edge can advertise MPEG-URL support and still reject MPEG-TS
  // playlists via <video src>. Prefer MSE whenever it is available.
  if (mseHlsSupported) return 'mse';
  if (canPlayNativeHls) return 'native';
  return 'unsupported';
}

export function setHlsLoaderForTests(loader) {
  hlsLoader = typeof loader === 'function' ? loader : null;
}

export async function loadHlsConstructor() {
  if (hlsLoader) return hlsLoader();
  if (globalThis.Hls) return globalThis.Hls;
  if (typeof document === 'undefined') throw new Error('Could not load HLS player');
  await new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-animanga-hls]');
    if (existing) {
      if (globalThis.Hls) {
        resolve();
        return;
      }
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('Could not load HLS player')), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = '/vendor/hls.min.js';
    script.async = true;
    script.dataset.animangaHls = '1';
    script.addEventListener('load', () => resolve(), { once: true });
    script.addEventListener('error', () => reject(new Error('Could not load HLS player')), { once: true });
    document.head.appendChild(script);
  });
  if (!globalThis.Hls) throw new Error('Could not load HLS player');
  return globalThis.Hls;
}

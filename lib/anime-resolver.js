'use strict';

const { ANIDB_ORIGIN, ANIDB_REFERER } = require('./config');
const { normalizeEpisode, normalizeMode } = require('./episodes');
const {
  listEpisodes,
  parseLanguageSources,
  parseEmbedMaster,
  parseM3u8Qualities,
} = require('./anidb');
const { fetchAnidbText, setAnidbTextFetcherForTests } = require('./anidb-fetch');

function setFetchForTests(fetcher) {
  setAnidbTextFetcherForTests(fetcher);
}

function qualityNumber(value) {
  const match = String(value || '').match(/(\d{3,4})/);
  return match ? Number(match[1]) : null;
}

function selectQuality(links, quality = 'best') {
  const sorted = [...(links || [])]
    .filter((link) => link?.url)
    .sort((a, b) => Number(b.quality || 0) - Number(a.quality || 0));
  if (!sorted.length) return null;
  const choice = String(quality || 'best').toLowerCase();
  if (choice === 'best') return sorted[0];
  if (choice === 'worst') return sorted[sorted.length - 1];
  const target = qualityNumber(choice);
  if (!target) return sorted[0];
  const exactOrLower = sorted.filter((link) => link.quality && link.quality <= target);
  return sorted.find((link) => link.quality === target)
    || exactOrLower[0]
    || sorted[0];
}

async function resolveEpisodeLinks(showId, episode, mode = 'sub') {
  if (!showId) throw new Error('Missing anime id');
  const episodeString = normalizeEpisode(episode);
  if (!episodeString) throw new Error('Missing episode');

  const episodes = await listEpisodes(showId);
  const match = episodes.find((item) => item.number === episodeString);
  if (!match) throw new Error(`Episode ${episodeString} has no sources`);

  const languagesRaw = await fetchAnidbText(`/api/frontend/episode/${match.id}/languages`);
  const embedUrl = parseLanguageSources(languagesRaw, mode);
  if (!embedUrl) {
    throw new Error(`No ${normalizeMode(mode)} sources found for episode ${episodeString}`);
  }

  const embedHtml = await fetchAnidbText(embedUrl);
  const master = parseEmbedMaster(embedHtml);
  if (!master) throw new Error('anidb embed did not include an m3u8 playlist');

  const masterUrl = (() => {
    try {
      return new URL(master, embedUrl).href;
    } catch {
      return master;
    }
  })();
  const playlist = await fetchAnidbText(masterUrl);
  const links = parseM3u8Qualities(playlist)
    .map((link) => {
      if (!link.url) return null;
      try {
        return {
          ...link,
          url: new URL(link.url, masterUrl).href,
          referrer: link.referrer || ANIDB_REFERER,
          provider: 'anidb',
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  if (!links.length) {
    return [{
      url: masterUrl,
      quality: null,
      referrer: ANIDB_REFERER,
      provider: 'anidb',
    }];
  }
  return links;
}

async function resolveEpisodePlayback({ showId, episode, mode = 'sub', quality = 'best' }) {
  const links = await resolveEpisodeLinks(showId, episode, mode);
  const selected = selectQuality(links, quality);
  if (!selected) throw new Error('anidb returned no playable sources');
  return {
    url: selected.url,
    referrer: selected.referrer || ANIDB_REFERER,
    provider: selected.provider || 'anidb',
    quality: selected.quality,
    resolver: 'node',
  };
}

module.exports = {
  resolveEpisodePlayback,
  resolveEpisodeLinks,
  selectQuality,
  qualityNumber,
  setFetchForTests,
  ANIDB_ORIGIN,
};

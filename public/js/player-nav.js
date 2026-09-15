export function adjacentEpisode(show, episode, dir) {
  const list = (show?.episodes || []).map(String);
  if (list.length) {
    const idx = list.indexOf(String(episode));
    if (idx !== -1) {
      const target = idx + dir;
      return target >= 0 && target < list.length ? list[target] : null;
    }
  }
  const num = Number(episode);
  if (!Number.isFinite(num)) return null;
  const candidate = num + dir;
  if (candidate < 1) return null;
  const latest = Number(show?.latestEpisode || show?.episodeCount);
  if (dir > 0 && Number.isFinite(latest) && latest > 0 && candidate > latest) return null;
  return String(candidate);
}

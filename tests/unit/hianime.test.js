'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseSearchResults,
  parseEpisodes,
  decodeEmbedBlob,
  listSubtitleTracks,
  mergeSubtitleTracks,
  pickDefaultSubtitleTrack,
  resolveDefaultSubtitleTrack,
  pickSubtitleTrack,
  parseM3u8,
  parseChart,
  parseShowDetails,
  parseSupportedServers,
  parseMegaplayCaptionServers,
  resolvePopularBrowse,
} = require('../../lib/hianime');
const { pickMatch } = require('../../lib/hianime-migrate');

test('HiAnime search excludes sidebar duplicates and preserves slugs', () => {
  const html = '<div class="film-detail"><h3 class="film-name"><a href="/watch/foo-bar" title="Foo &amp; Bar"></a></h3><img data-src="/img.jpg"></div>'
    + '<div id="main-sidebar"><div class="film-detail"><a href="/watch/junk" title="Junk"></a></div></div>';
  assert.deepEqual(parseSearchResults(html), [{
    id: 'foo-bar', name: 'Foo & Bar', sourceName: 'Foo & Bar', englishName: 'Foo & Bar', thumbnail: 'https://hianime.at/img.jpg',
  }]);
});

test('HiAnime search cards keep sub dub and total episode ticks', () => {
  const html = '<div class="flw-item"><div class="film-poster"><div class="tick-item tick-sub">12</div><div class="tick-item tick-dub">10</div><div class="tick-item tick-eps">12</div>'
    + '<img src="/cover.jpg"></div><div class="film-detail"><a href="/example-show-1" title="Example Show"></a></div></div>'
    + '<div class="flw-item"><div class="film-poster"><div class="tick-item tick-sub">3</div><div class="tick-item tick-eps">3</div>'
    + '<img src="/other.jpg"></div><div class="film-detail"><a href="/other-show-2" title="Other Show"></a></div></div>';
  assert.deepEqual(parseSearchResults(html), [
    {
      id: 'example-show-1', name: 'Example Show', sourceName: 'Example Show', englishName: 'Example Show',
      thumbnail: 'https://hianime.at/cover.jpg', episodeCount: 12, latestEpisode: '12', episodeCounts: { sub: 12, dub: 10 },
      title: 'Example Show (12 episodes)',
    },
    {
      id: 'other-show-2', name: 'Other Show', sourceName: 'Other Show', englishName: 'Other Show',
      thumbnail: 'https://hianime.at/other.jpg', episodeCount: 3, latestEpisode: '3', episodeCounts: { sub: 3 },
      title: 'Other Show (3 episodes)',
    },
  ]);
});

test('HiAnime search cards keep type and language ticks', () => {
  const html = '<div class="flw-item"><div class="film-poster"><div class="tick-item tick-sub">7</div><div class="tick-item tick-dub">2</div><div class="tick-item tick-eps">10</div>'
    + '<img src="/cover.jpg"></div><div class="film-detail"><h3 class="film-name"><a href="/ongoing-cour-5" title="Ongoing Cour" class="dynamic-name" data-jname="Cour JP"></a></h3>'
    + '<div class="fd-infor"><span class="fdi-item">TV</span><span class="fdi-item fdi-duration">25m</span></div></div></div>';
  const [item] = parseSearchResults(html);
  assert.equal(item.episodeCount, 7);
  assert.equal(item.type, 'TV');
  assert.equal(item.nativeName, 'Cour JP');
  assert.deepEqual(item.episodeCounts, { sub: 7, dub: 2 });
});

test('HiAnime search ticks stay on their own card', () => {
  const html = '<div class="flw-item"><div class="film-poster"><div class="tick-item tick-sub">1</div><div class="tick-item tick-eps">1</div></div>'
    + '<div class="film-detail"><a href="/movie-1" title="Movie"></a></div></div>'
    + '<div class="anif-block"><div class="tick-item tick-sub">1177</div><div class="tick-item tick-eps">1177</div></div>';
  const [item] = parseSearchResults(html);
  assert.equal(item.id, 'movie-1');
  assert.equal(item.episodeCount, 1);
  assert.deepEqual(item.episodeCounts, { sub: 1 });
});

test('HiAnime search uses total tick when language ticks are missing', () => {
  const html = '<div class="flw-item"><div class="film-poster"><div class="tick-item tick-eps">24</div></div>'
    + '<div class="film-detail"><a href="/total-only-24" title="Total Only"></a></div></div>';
  assert.equal(parseSearchResults(html)[0].episodeCount, 24);
});

test('HiAnime charts read episode ticks from the current list item only', () => {
  const html = '<div id="top-viewed-week"><div class="film-detail"><a href="/first-1" title="First"></a><div class="tick-item tick-sub">24</div><div class="tick-item tick-dub">20</div></div>'
    + '<div class="film-detail"><a href="/second-2" title="Second"></a><div class="tick-item tick-sub">8</div></div></div>';
  assert.deepEqual(parseChart(html, '7').map((item) => [item.id, item.episodeCount, item.episodeCounts]), [
    ['first-1', 24, { sub: 24, dub: 20 }],
    ['second-2', 8, { sub: 8 }],
  ]);
});

test('HiAnime episode parser binds episodes to the requested slug', () => {
  const html = 'ep-item data-number="1" data-id="10" href="/watch/foo-bar?ep=10" ep-item data-number="2" data-id="11" href="/watch/other?ep=11"';
  assert.deepEqual(parseEpisodes(html, 'foo-bar').map((item) => [item.id, item.number]), [[10, '1']]);
});

test('HiAnime episode parser reads named titles and skips generic Episode N labels', () => {
  const html = JSON.stringify({
    status: true,
    html: '<a class="ssl-item ep-item" data-number="1" data-id="10" href="/watch/named-show-1?ep=10">'
      + '<div class="ep-name dynamic-name" title="The Journey&#039;s End">The Journey&#039;s End</div></a>'
      + '<a class="ssl-item ep-item" data-number="2" data-id="11" href="/watch/named-show-1?ep=11">'
      + '<div class="ep-name dynamic-name" title="Episode 2">Episode 2</div></a>',
  });
  assert.deepEqual(parseEpisodes(html, 'named-show-1').map((item) => [item.number, item.title]), [
    ['1', "The Journey's End"],
    ['2', ''],
  ]);
});

test('HiAnime episode titles drop nested markup instead of leaving tag fragments', () => {
  const html = '<a class="ssl-item ep-item" data-number="1" data-id="10" href="/watch/named-show-1?ep=10">'
    + '<div class="ep-name"><b>Hello</b></div></a>'
    + '<a class="ssl-item ep-item" data-number="2" data-id="11" href="/watch/named-show-1?ep=11">'
    + '<div class="ep-name"><</div></a>';
  assert.deepEqual(parseEpisodes(html, 'named-show-1').map((item) => [item.number, item.title]), [
    ['1', 'Hello'],
    ['2', ''],
  ]);
});

test('HiAnime embed decoder reverses the rotating XOR key', () => {
  const source = Buffer.from('otaku-embed-v1').map((byte, index) => byte ^ Buffer.from('otaku-embed-v1')[index]);
  assert.equal(decodeEmbedBlob(source.toString('base64')), 'otaku-embed-v1');
});

test('HiAnime subtitle picker uses the catalog default track', () => {
  assert.deepEqual(pickSubtitleTrack({
    subtitles: [
      { src: 'https://cdn.test/ar.vtt', lang: 'ar', label: 'Arabic', default: true },
      { src: '/subs/en.vtt', lang: 'en', label: 'English (CR)' },
    ],
  }, 'https://player.test/embed'), {
    src: 'https://cdn.test/ar.vtt',
    lang: 'ar',
    label: 'Arabic',
    default: true,
  });
  assert.equal(pickSubtitleTrack({
    subtitles: [
      { file: 'https://cdn.test/en.vtt', lang: 'en', label: 'English' },
      { src: 'https://cdn.test/es.vtt', lang: 'es', label: 'Spanish', default: true },
    ],
  }).src, 'https://cdn.test/es.vtt');
  assert.equal(pickSubtitleTrack({
    subtitles: [
      { src: 'https://cdn.test/es.vtt', lang: 'es', label: 'Spanish' },
      { src: 'https://cdn.test/ar.vtt', lang: 'ar', label: 'Arabic' },
    ],
  }).src, 'https://cdn.test/es.vtt');
  assert.equal(pickSubtitleTrack({ subtitles: [{ label: 'English' }] }), null);
});

test('HiAnime subtitle lists keep unique labels and prefer a marked default', () => {
  const primary = listSubtitleTracks({
    subtitles: [
      { src: 'https://cdn.test/es.vtt', lang: 'es', label: 'Spanish' },
      { src: 'https://cdn.test/th.vtt', lang: 'th', label: 'Thai' },
    ],
  });
  const extra = listSubtitleTracks({
    subtitles: [
      { src: 'https://cdn.test/en.vtt', lang: 'en', label: 'English', default: true },
      { src: 'https://cdn.test/es-alt.vtt', lang: 'es', label: 'Spanish' },
    ],
  });
  const merged = mergeSubtitleTracks(primary, extra);
  assert.deepEqual(merged.map((track) => track.label), ['Spanish', 'Thai', 'English']);
  assert.equal(pickDefaultSubtitleTrack(merged).src, 'https://cdn.test/en.vtt');
  assert.equal(resolveDefaultSubtitleTrack(primary, merged).src, 'https://cdn.test/es.vtt');
});

test('HiAnime m3u8 parser resolves relative variants and quality', () => {
  const links = parseM3u8('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=640x360\n360.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2,RESOLUTION=1920x1080\n1080.m3u8', 'https://cdn.test/path/master.m3u8', 'https://hianime.at/');
  assert.equal(links[0].quality, 1080);
  assert.equal(links[0].url, 'https://cdn.test/path/1080.m3u8');
});

test('HiAnime migration rejects ambiguous title matches', () => {
  assert.equal(pickMatch({ name: 'Example' }, [{ id: 'example-1', name: 'Example' }, { id: 'example-2', name: 'Example' }]), null);
});

test('HiAnime server parser reads JSON html payloads', () => {
  const html = JSON.stringify({
    status: true,
    html: '<div class="item server-item" data-type="sub" data-server-name="ZokoAnime" data-hash="abc"></div>'
      + '<div class="item server-item" data-type="dub" data-server-name="ZokoAnime" data-hash="def"></div>',
  });
  assert.deepEqual(parseSupportedServers(html, 'sub').map((item) => item.hash), ['abc']);
});

test('server parsing never crosses language or unsupported player boundaries', () => {
  const html = '<div class="server-item" data-type="sub" data-server-name="HD-1" data-hash="a"></div>'
    + '<div class="server-item" data-type="dub" data-server-name="ZokoAnime" data-hash="b"></div>'
    + '<div class="server-item" data-type="sub" data-server-name="ZokoAnime" data-hash="c"></div>';
  assert.deepEqual(parseSupportedServers(html, 'sub').map((item) => item.hash), ['c']);
  assert.deepEqual(parseSupportedServers(html, 'dub').map((item) => item.hash), ['b']);
});

test('MegaPlay caption servers stay off the Zoko video decoder list', () => {
  const html = '<div class="server-item" data-type="sub" data-server-name="ZokoAnime" data-hash="zoko"></div>'
    + '<div class="server-item" data-type="sub" data-server-name="HD-2" data-hash="hd2"></div>'
    + '<div class="server-item" data-type="sub" data-server-name="Vidstream-2" data-hash="vid2"></div>'
    + '<div class="server-item" data-type="sub" data-server-name="VidPlay-1" data-hash="vidplay"></div>'
    + '<div class="server-item" data-type="dub" data-server-name="HD-2" data-hash="dubhd"></div>';
  assert.deepEqual(parseSupportedServers(html, 'sub').map((item) => item.hash), ['zoko']);
  assert.deepEqual(parseMegaplayCaptionServers(html, 'sub').map((item) => [item.name, item.hash]), [
    ['HD-2', 'hd2'],
    ['Vidstream-2', 'vid2'],
  ]);
});

test('HiAnime charts keep the requested time period separate', () => {
  const html = ['day', 'week', 'month'].map((period) => `<div id="top-viewed-${period}"><div class="film-detail"><a href="/${period}-1" title="${period}"></a></div></div>`).join('');
  assert.deepEqual(parseChart(html, '7').map((item) => item.name), ['week']);
  assert.deepEqual(parseChart(html, '30').map((item) => item.name), ['month']);
});

test('catalog browse uses live HiAnime pages instead of leftover chart labels', () => {
  assert.deepEqual(resolvePopularBrowse('0'), { type: 'page', path: '/most-popular' });
  assert.deepEqual(resolvePopularBrowse('airing'), { type: 'page', path: '/top-airing' });
  assert.deepEqual(resolvePopularBrowse('favorite'), { type: 'page', path: '/most-favorite' });
  assert.deepEqual(resolvePopularBrowse('7'), { type: 'chart', period: 'week', range: '7' });
  assert.throws(() => resolvePopularBrowse('hot'), /Unknown catalog browse/);
});

test('HiAnime details exclude navigation genres and read attributes in either order', () => {
  const html = '<a href="https://hianime.at/genres/horror">Horror</a><img src="/cover.jpg" class="film-poster-img">'
    + '<h2 class="film-name dynamic-name" data-jname="Example JP">Example</h2><div class="film-description"><div class="text">A description.</div></div>'
    + '<div class="film-stats"><div class="tick"><div class="tick-item tick-pg">R</div><div class="tick-item tick-quality">HD</div>'
    + '<span class="item">TV</span><span class="item">25m</span></div></div>'
    + '<div class="anisc-info"><span class="item-head">Status:</span><span class="name">Currently Airing</span>'
    + '<span class="item-head">Aired:</span><span class="name">Jul 25, 2026 to ?</span>'
    + '<span class="item-head">MAL Score:</span><span class="name">9.03</span>'
    + '<a href="https://hianime.at/genres/action">Action</a><div class="film-text">';
  const details = parseShowDetails(html, 'example-1');
  assert.equal(details.description, 'A description.');
  assert.equal(details.thumbnail, 'https://hianime.at/cover.jpg');
  assert.deepEqual(details.genres, ['Action']);
  assert.equal(details.status, 'Currently Airing');
  assert.equal(details.type, 'TV');
  assert.equal(details.rating, 'R');
  assert.equal(details.sourceQuality, 'HD');
  assert.equal(details.score, '9.03');
  assert.equal(details.nativeName, 'Example JP');
  assert.deepEqual(details.airedStart, { year: 2026, month: 6, date: 25 });
  assert.deepEqual(details.relations, []);
  assert.throws(() => parseShowDetails('<html>Error</html>', 'example-1'), /invalid title/);
});

test('HiAnime details map More Seasons around the current title', () => {
  const html = '<h2 class="film-name">Current Cour</h2><div class="film-description"><div class="text">Desc.</div></div>'
    + '<section><h2 class="cat-heading">More Seasons</h2><div class="os-list">'
    + '<a href="https://hianime.at/first-cour-1" class="os-item" title="First Cour"><div class="title">Season 1</div>'
    + '<div class="season-poster" style="background-image: url(/first.webp);"></div></a>'
    + '<a href="https://hianime.at/current-cour-2" class="os-item active" title="Current Cour"><div class="title">Season 2</div></a>'
    + '<a href="https://hianime.at/next-cour-3" class="os-item" title="Next Cour"><div class="title">Season 3</div></a>'
    + '</div></section>'
    + '<section><h2 class="cat-heading">Related Anime</h2><ul><li>'
    + '<h3 class="film-name"><a href="https://hianime.at/side-ova-9" title="Side OVA">Side OVA</a></h3>'
    + '<div class="tick-item tick-sub">2</div><div class="tick-item tick-eps">2</div><div class="dot"></div> OVA'
    + '</li></ul></section>';
  const details = parseShowDetails(html, 'current-cour-2');
  assert.deepEqual(details.relatedShows, [
    { relation: 'prequel', showId: 'first-cour-1' },
    { relation: 'sequel', showId: 'next-cour-3' },
    { relation: 'related', showId: 'side-ova-9' },
  ]);
  assert.equal(details.nextSeason.id, 'next-cour-3');
  assert.equal(details.nextSeason.name, 'Next Cour');
  assert.equal(details.hasNextSeason, true);
  assert.equal(details.relations.find((item) => item.id === 'side-ova-9').type, 'OVA');
  assert.equal(details.relations.find((item) => item.id === 'side-ova-9').episodeCount, 2);
  assert.ok(!details.relations.some((item) => item.id === 'current-cour-2'));
});

test('HiAnime details ignore recommended titles outside related sections', () => {
  const html = '<h2 class="film-name">Solo</h2><div class="film-description"><div class="text">Desc.</div></div>'
    + '<section><h2 class="cat-heading">Recommended</h2><ul><li>'
    + '<h3 class="film-name"><a href="https://hianime.at/unrelated-99" title="Unrelated Hit">Unrelated Hit</a></h3>'
    + '</li></ul></section>';
  const details = parseShowDetails(html, 'solo-1');
  assert.deepEqual(details.relations, []);
  assert.equal(details.nextSeason, undefined);
});

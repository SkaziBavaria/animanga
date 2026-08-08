'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const anidb = require('../../lib/anidb');
const { pickBestMatch, titleScore } = require('../../lib/anidb-migrate');

const BROWSE_HTML = `
<html><body>
<a href="/anime/one-piece-21"><img src="/img/op.jpg" alt="One Piece"></a>
<a href="/anime/naruto-20" title="Naruto"><img src="https://cdn.example/n.jpg" alt="Naruto"></a>
</body></html>
`;

const SHOW_HTML = `
<html><head>
<meta property="og:title" content="One Piece">
<meta property="og:description" content="Pirates adventure">
<meta property="og:image" content="https://cdn.example/op.jpg">
<script type="application/ld+json">{"@type":"TVSeries","name":"One Piece","description":"Pirates adventure","genre":["Action","Adventure"],"image":"https://cdn.example/op.jpg","alternateName":"ワンピース"}</script>
</head><body>
<h1>One Piece</h1>
<a href="https://myanimelist.net/anime/21/One_Piece">MAL</a>
<a href="/genres/1" class="filter-chip foo">Action</a>
<a href="/genres/2" class="filter-chip foo">Adventure</a>
<a href="/browse?status=Finished+Airing" class="badge">Finished Airing</a>
<a href="/browse?season=fall&year=1999">Fall 1999</a>
<a href="/browse?type=TV">TV</a>
<span class="badge text-yellow-400"><svg></svg> 8.7</span>
<h3 class="font-semibold text-white leading-tight">Seasons</h3>
<a href="https://anidb.app/anime/one-piece-21" title="One Piece">
  <span class="absolute top-2 left-2 min-w-[1.5rem]">1</span>
  <p class="text-[11px] font-semibold text-white line-clamp-2">One Piece</p>
  <span>1999</span>
</a>
<a href="https://anidb.app/anime/one-piece-film-22" title="One Piece Film">
  <span class="absolute top-2 left-2 min-w-[1.5rem]">2</span>
  <p class="text-[11px] font-semibold text-white line-clamp-2">One Piece Film</p>
  <span>2000</span>
</a>
<div class="release-time-type-subs"><span class="release-time-episode-number">Episode 1150</span></div>
<time class="countdown-time" datetime="2026-08-10T15:00:00Z"></time>
</body></html>
`;

const SEQUEL_HTML = `
<html><head>
<meta property="og:title" content="One Piece Film">
</head><body>
<h1>One Piece Film</h1>
<a href="/browse?status=Currently+Airing" class="badge">Currently Airing</a>
<a href="/browse?season=winter&year=2000">Winter 2000</a>
<h3>Seasons</h3>
</body></html>
`;

const EPISODES_JSON = JSON.stringify([
  { id: 1001, number: 1, title: 'Romance Dawn' },
  { id: 1002, number: 2 },
]);

test.afterEach(() => anidb.setRawFetcher(null));

test('isAnidbShowId accepts slug-numeric ids', () => {
  assert.equal(anidb.isAnidbShowId('one-piece-21'), true);
  assert.equal(anidb.isAnidbShowId('ReooPAxPMsHM4KPMY'), false);
});

test('parseSearchResults extracts slug ids and titles', () => {
  const results = anidb.parseSearchResults(BROWSE_HTML);
  assert.equal(results.length, 2);
  assert.equal(results[0].id, 'one-piece-21');
  assert.equal(results[0].name, 'One Piece');
  assert.match(results[0].thumbnail, /op\.jpg$/);
});

test('search relevance requires every meaningful query word', () => {
  const results = anidb.relevantSearchResults('Ghost of Tsushima', [
    { name: 'Dusk Maiden of Amnesia: Ghost Girl', index: 1 },
    { name: 'Ghost Stories', index: 2 },
    { name: 'Ghost of Tsushima', index: 3 },
    { name: 'Ghost of Tsushima: Legends', index: 4 },
  ]);
  assert.deepEqual(results.map((item) => item.name), ['Ghost of Tsushima', 'Ghost of Tsushima: Legends']);
});

test('search relevance keeps related titles after an exact result', () => {
  const results = anidb.relevantSearchResults('One Piece', [
    { name: 'One Punch Man', index: 1 },
    { name: 'One Piece Film Red', index: 2 },
    { name: 'One Piece', index: 3 },
  ]);
  assert.deepEqual(results.map((item) => item.name), ['One Piece', 'One Piece Film Red']);
});

test('HTML text decoding is single-pass and safely removes nested title markup', () => {
  const page = anidb.parseShowPage('<h1><span>Fish &amp; Chips &amp;quot;Special&amp;quot;</span></h1>', 'fallback-1');
  assert.equal(page.name, 'Fish & Chips &quot;Special&quot;');
});

test('parseEpisodeList reads JSON episode maps', () => {
  const episodes = anidb.parseEpisodeList(EPISODES_JSON);
  assert.deepEqual(episodes.map((item) => [item.id, item.number, item.title]), [
    [1001, '1', 'Romance Dawn'],
    [1002, '2', ''],
  ]);
});

test('parseLanguageSources prefers jpn for sub and eng for dub', () => {
  const payload = JSON.stringify([
    { lang: 'eng', embed_url: 'https://embed.example/dub' },
    { lang: 'jpn', embed_url: 'https://embed.example/sub' },
  ]);
  assert.equal(anidb.parseLanguageSources(payload, 'sub'), 'https://embed.example/sub');
  assert.equal(anidb.parseLanguageSources(payload, 'dub'), 'https://embed.example/dub');
});

test('parseEmbedMaster and parseM3u8Qualities extract stream variants', () => {
  assert.equal(anidb.parseEmbedMaster("var x = { file: 'https://cdn.example/master.m3u8' };"), 'https://cdn.example/master.m3u8');
  const links = anidb.parseM3u8Qualities([
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1280x720',
    '720.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2,RESOLUTION=1920x1080',
    '1080.m3u8',
  ].join('\n'));
  assert.equal(links.length, 2);
  assert.equal(links[0].quality, 720);
  assert.equal(links[1].quality, 1080);
});

test('normalizeProviderStatus maps anidb badge text', () => {
  assert.equal(anidb.normalizeProviderStatus('Finished Airing'), 'Finished');
  assert.equal(anidb.normalizeProviderStatus('Currently Airing'), 'Ongoing');
  assert.equal(anidb.normalizeProviderStatus('Not yet aired'), 'Not Yet Released');
});

test('parseShowPage extracts metadata, MAL id, seasons and airing', () => {
  const page = anidb.parseShowPage(SHOW_HTML, 'one-piece-21');
  assert.equal(page.name, 'One Piece');
  assert.equal(page.malId, 21);
  assert.equal(page.status, 'Finished');
  assert.equal(page.season?.year, 1999);
  assert.equal(page.score, 8.7);
  assert.deepEqual(page.genres, ['Action', 'Adventure']);
  assert.equal(page.relatedShows[0].showId, 'one-piece-film-22');
  assert.equal(page.relatedShows[0].relation, 'sequel');
  assert.equal(page.nextAiringEpisode.episode, 1150);
});

test('searchAnime enriches cards with status and sequel info', async () => {
  anidb.setRawFetcher(async (url) => {
    const value = String(url);
    if (value.includes('/browse?q=one')) return BROWSE_HTML;
    if (value.includes('/episodes')) return EPISODES_JSON;
    if (value.includes('/anime/one-piece-film-22')) return SEQUEL_HTML;
    if (value.includes('/anime/')) return SHOW_HTML;
    throw new Error(`unexpected url ${url}`);
  });
  const results = await anidb.searchAnime('one', 'sub');
  assert.equal(results[0].id, 'one-piece-21');
  assert.equal(results[0].provider, 'anidb');
  assert.equal(results[0].status, 'Finished');
  assert.equal(results[0].airedStart?.year, 1999);
  assert.equal(results[0].episodeCount, 2);
  assert.equal(results[0].hasNextSeason, true);
  assert.equal(results[0].nextSeason?.status, 'Ongoing');
});

test('getShowDetails maps episodes and metadata', async () => {
  anidb.setRawFetcher(async (url) => {
    if (String(url).includes('/episodes')) return EPISODES_JSON;
    if (String(url).includes('/anime/one-piece-21')) return SHOW_HTML;
    throw new Error(`unexpected url ${url}`);
  });
  const details = await anidb.getShowDetails('one-piece-21', 'sub');
  assert.equal(details.episodeCount, 2);
  assert.deepEqual(details.episodes, ['1', '2']);
  assert.equal(details.episodeTitles['1'], 'Romance Dawn');
  assert.equal(details.malId, 21);
  assert.equal(details.status, 'Finished');
});

test('getShowDetails rejects non-anidb ids', async () => {
  await assert.rejects(() => anidb.getShowDetails('legacy-id', 'sub'), /Incomplete show details/);
});

test('title matching prefers exact names for migration', () => {
  assert.ok(titleScore('One Piece', { name: 'One Piece' }) >= 100);
  const match = pickBestMatch(
    { name: 'One Piece' },
    [{ id: 'one-piece-21', name: 'One Piece' }, { id: 'one-punch-man-1', name: 'One Punch Man' }]
  );
  assert.equal(match.id, 'one-piece-21');
});

test('migration title matching handles provider season and cour naming', () => {
  assert.equal(pickBestMatch(
    { name: 'Dr. Stone: Science Future Part 3' },
    [{ id: 'drstone-science-future-cour-3-1333', name: 'Dr.STONE SCIENCE FUTURE Cour 3' }],
  ).id, 'drstone-science-future-cour-3-1333');
  assert.equal(pickBestMatch(
    { name: 'ISHURA Season 2' },
    [{ id: 'ishura-2nd-season-2505', name: 'Ishura 2nd Season' }],
  ).id, 'ishura-2nd-season-2505');
});

const HOME_CHARTS_HTML = `
<html><body>
<h2>Top 10 Anime Charts</h2>
<h3 class="text-lg">Top 10 Today</h3>
<a href="https://anidb.app/anime/today-show-1" title="Today One"><img alt="Today One" src="/t1.jpg"></a>
<a href="https://anidb.app/anime/today-show-2" title="Today Two"><img alt="Today Two" src="/t2.jpg"></a>
<h3 class="text-lg">Top 10 This Week</h3>
<a href="https://anidb.app/anime/week-show-1" title="Week One"><img alt="Week One" src="/w1.jpg"></a>
<a href="https://anidb.app/anime/week-show-2" title="Week Two"><img alt="Week Two" src="/w2.jpg"></a>
<h3 class="text-lg">Top 10 This Month</h3>
<a href="https://anidb.app/anime/month-show-1" title="Month One"><img alt="Month One" src="/m1.jpg"></a>
</body></html>
`;

const POPULAR_BROWSE_HTML = `
<html><body>
<a href="/anime/attack-on-titan-457"><img src="/aot.jpg" alt="Attack on Titan"></a>
<a href="/anime/death-note-1199"><img src="/dn.jpg" alt="Death Note"></a>
</body></html>
`;

test('parseHomeChart isolates today/week/month lists', () => {
  assert.deepEqual(anidb.parseHomeChart(HOME_CHARTS_HTML, 'Top 10 Today').map((item) => item.id), [
    'today-show-1',
    'today-show-2',
  ]);
  assert.deepEqual(anidb.parseHomeChart(HOME_CHARTS_HTML, 'Top 10 This Week').map((item) => item.id), [
    'week-show-1',
    'week-show-2',
  ]);
  assert.deepEqual(anidb.parseHomeChart(HOME_CHARTS_HTML, 'Top 10 This Month').map((item) => item.id), [
    'month-show-1',
  ]);
});

test('popularAnime maps ranges to distinct anidb sources', async () => {
  assert.deepEqual(anidb.popularSourceForRange('0'), { kind: 'browse', path: '/browse?sort=order_popular' });
  assert.equal(anidb.popularSourceForRange('1').title, 'Top 10 Today');
  assert.equal(anidb.popularSourceForRange('7').title, 'Top 10 This Week');
  assert.equal(anidb.popularSourceForRange('30').title, 'Top 10 This Month');

  anidb.setRawFetcher(async (url) => {
    const value = String(url);
    if (value.includes('/home')) return HOME_CHARTS_HTML;
    if (value.includes('sort=order_popular')) return POPULAR_BROWSE_HTML;
    if (value.includes('/episodes')) return EPISODES_JSON;
    if (value.includes('/anime/')) return SHOW_HTML;
    throw new Error(`unexpected url ${url}`);
  });

  const popular = await anidb.popularAnime('0', 'sub');
  assert.equal(popular[0].id, 'attack-on-titan-457');

  const hot = await anidb.popularAnime('1', 'sub');
  assert.equal(hot[0].id, 'today-show-1');

  const week = await anidb.popularAnime('7', 'sub');
  assert.equal(week[0].id, 'week-show-1');

  const month = await anidb.popularAnime('30', 'sub');
  assert.equal(month[0].id, 'month-show-1');
});

test('searchAnime Latest_Update uses order_updated browse', async () => {
  anidb.setRawFetcher(async (url) => {
    const value = String(url);
    assert.match(value, /sort=order_updated/);
    if (value.includes('/episodes')) return EPISODES_JSON;
    if (value.includes('/anime/')) return SHOW_HTML;
    return POPULAR_BROWSE_HTML;
  });
  const results = await anidb.searchAnime('', 'sub', { sortBy: 'Latest_Update' });
  assert.equal(results[0].id, 'attack-on-titan-457');
});

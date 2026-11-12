'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSeriesSearch, resolveTitle, getChapterPagesByTitle } = require('../../lib/qiscans');
const { setTextFetcherForTests } = require('../../lib/web-fetch');

test.afterEach(() => setTextFetcherForTests(null));

const json = (value) => JSON.stringify(value);

test('parses series rows and ignores incomplete API records', () => {
  assert.deepEqual(parseSeriesSearch({ data: [
    { slug: 'demo-story', title: 'Demo Story' },
    { slug: '', title: 'Missing slug' },
    { slug: 'missing-title' },
  ] }), [{ id: 'demo-story', slug: 'demo-story', name: 'Demo Story' }]);
  assert.deepEqual(parseSeriesSearch({ data: 'unexpected' }), []);
});

test('resolves numeric chapter zero, canonical headers, and ordered HTTPS pages', async () => {
  const calls = [];
  setTextFetcherForTests(async (url, options) => {
    calls.push({ url, options });
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/series/search')) {
      return json({ data: [{ slug: 'demo-story', title: 'Demo Story' }] });
    }
    if (parsed.pathname.endsWith('/series/demo-story/chapters')) {
      return json({ data: [{ slug: 'chapter-zero', number: 0, createdAt: '2026-10-01T00:00:00.000Z' }], totalPages: 1, current: 1 });
    }
    if (parsed.pathname.endsWith('/series/demo-story/chapters/chapter-zero')) {
      return json({ images: [
        { url: 'https://cdn.example/page-2.jpg', order: 2 },
        { url: 'http://cdn.example/insecure.jpg', order: 0 },
        { url: 'https://cdn.example/page-1.jpg', order: 1 },
      ] });
    }
    throw new Error('Unexpected Qi Manga request: ' + url);
  });

  const result = await getChapterPagesByTitle(['Demo Story'], '0');

  assert.equal(calls.length, 3);
  assert.ok(calls.every(({ options }) => options.timeoutMs === 30000 && options.retries === 2));
  assert.equal(new URL(calls[0].url).origin, 'https://api.qimanga.com');
  assert.equal(new URL(calls[0].url).searchParams.get('q'), 'Demo Story');
  assert.equal(calls[0].options.headers.Origin, 'https://qimanga.com');
  assert.equal(calls[0].options.headers.Referer, 'https://qimanga.com/');
  assert.equal(new URL(calls[1].url).searchParams.get('perPage'), '100');
  assert.deepEqual(result.pages, [
    { number: 1, url: 'https://cdn.example/page-1.jpg' },
    { number: 2, url: 'https://cdn.example/page-2.jpg' },
  ]);
  assert.equal(result.sourceName, 'Qi Scans');
  assert.equal(result.resolvedTitle, 'Demo Story');
  assert.equal(result.verifiedTitleMatch, true);
  assert.equal(result.qiScansTitleSlug, 'demo-story');
  assert.equal(result.qiScansChapterSlug, 'chapter-zero');
});

test('tries title aliases and selects only a safe exact-like match', async () => {
  const queries = [];
  setTextFetcherForTests(async (url) => {
    const query = new URL(url).searchParams.get('q');
    queries.push(query);
    return json({ data: [query === 'Original Name'
      ? { slug: 'other-work', title: 'Unrelated Work' }
      : { slug: 'demo-story', title: 'Demo Story' }] });
  });

  const title = await resolveTitle(['Original Name', 'Demo Story']);

  assert.deepEqual(queries, ['Original Name', 'Demo Story']);
  assert.equal(title.slug, 'demo-story');
});

test('rejects conflicting matches found through different title aliases', async () => {
  setTextFetcherForTests(async (url) => {
    const query = new URL(url).searchParams.get('q');
    const title = query === 'Demo Story' ? 'Demo Story' : 'Demo Story 2';
    const slug = query === 'Demo Story' ? 'demo-story' : 'demo-story-2';
    return json({ data: [{ slug, title }] });
  });

  await assert.rejects(resolveTitle(['Demo Story', 'Demo Story 2']), /No safe Qi Scans match/);
});

test('rejects unrelated series before requesting chapters', async () => {
  let calls = 0;
  setTextFetcherForTests(async () => {
    calls += 1;
    return json({ data: [{ slug: 'solo-leveling', title: 'Solo Leveling' }] });
  });

  await assert.rejects(getChapterPagesByTitle(['Demo Story'], '1'), /No safe Qi Scans match/);
  assert.equal(calls, 1);
});

test('paginates to the requested chapter and rejects duplicate matches', async (t) => {
  await t.test('finds a chapter on the second page', async () => {
    const pages = [];
    setTextFetcherForTests(async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/series/search')) {
        return json({ data: [{ slug: 'demo-story', title: 'Demo Story' }] });
      }
      if (parsed.pathname.endsWith('/series/demo-story/chapters')) {
        const page = parsed.searchParams.get('page');
        pages.push(page);
        return json({
          data: page === '1' ? [{ slug: 'chapter-9', number: 9 }] : [{ slug: 'chapter-3', number: 3 }],
          totalPages: 2,
          current: Number(page),
        });
      }
      return json({ images: [{ url: 'https://cdn.example/page.jpg' }] });
    });

    const result = await getChapterPagesByTitle(['Demo Story'], '3');
    assert.deepEqual(pages, ['1', '2']);
    assert.equal(result.pages[0].url, 'https://cdn.example/page.jpg');
  });

  await t.test('rejects multiple chapters with the same numeric number', async () => {
    setTextFetcherForTests(async (url) => {
      if (new URL(url).pathname.endsWith('/series/search')) {
        return json({ data: [{ slug: 'demo-story', title: 'Demo Story' }] });
      }
      return json({
        data: [{ slug: 'chapter-a', number: 1 }, { slug: 'chapter-b', number: '1.0' }],
        totalPages: 1,
        current: 1,
      });
    });
    await assert.rejects(getChapterPagesByTitle(['Demo Story'], '1'), /Ambiguous Qi Scans chapter 1/);
  });
});

test('rejects purchased chapters, invalid chapter numbers, non-JSON, and unsafe pages', async (t) => {
  await t.test('rejects a chapter requiring purchase', async () => {
    setTextFetcherForTests(async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/series/search')) {
        return json({ data: [{ slug: 'demo-story', title: 'Demo Story' }] });
      }
      if (parsed.pathname.endsWith('/series/demo-story/chapters')) {
        return json({ data: [{ slug: 'chapter-1', number: 1 }], totalPages: 1, current: 1 });
      }
      return json({ requiresPurchase: true, images: [] });
    });
    await assert.rejects(getChapterPagesByTitle(['Demo Story'], '1'), /requires purchase/);
  });

  await t.test('rejects a chapter explicitly marked as not free', async () => {
    setTextFetcherForTests(async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/series/search')) {
        return json({ data: [{ slug: 'demo-story', title: 'Demo Story' }] });
      }
      if (parsed.pathname.endsWith('/series/demo-story/chapters')) {
        return json({ data: [{ slug: 'chapter-1', number: 1 }], totalPages: 1, current: 1 });
      }
      return json({ isFree: false, images: [] });
    });
    await assert.rejects(getChapterPagesByTitle(['Demo Story'], '1'), /requires purchase/);
  });

  await t.test('rejects an invalid chapter number', async () => {
    setTextFetcherForTests(async () => json({ data: [{ slug: 'demo-story', title: 'Demo Story' }] }));
    await assert.rejects(getChapterPagesByTitle(['Demo Story'], 'special'), /Invalid Qi Scans chapter number/);
  });

  await t.test('rejects non-JSON API responses', async () => {
    setTextFetcherForTests(async () => '<html>Unavailable</html>');
    await assert.rejects(resolveTitle(['Demo Story']), /Qi Scans returned non-JSON data/);
  });

  await t.test('rejects chapters without HTTPS pages', async () => {
    setTextFetcherForTests(async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/series/search')) {
        return json({ data: [{ slug: 'demo-story', title: 'Demo Story' }] });
      }
      if (parsed.pathname.endsWith('/series/demo-story/chapters')) {
        return json({ data: [{ slug: 'chapter-1', number: 1 }], totalPages: 1, current: 1 });
      }
      return json({ images: [{ url: 'http://cdn.example/page.jpg' }, { url: 'javascript:bad' }] });
    });
    await assert.rejects(getChapterPagesByTitle(['Demo Story'], '1'), /no readable pages/);
  });
});

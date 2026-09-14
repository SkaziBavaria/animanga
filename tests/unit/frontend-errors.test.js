'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');

function client(mediaMode = 'anime') {
  const classes = new Set();
  const events = [];
  const timeouts = [];
  const created = [];
  const state = { mediaMode };
  const context = vm.createContext({
    state, Date, console,
    els: { toast: {
      classList: {
        toggle(name, force) {
          if (force === true) classes.add(name);
          else if (force === false) classes.delete(name);
          else if (classes.has(name)) classes.delete(name);
          else classes.add(name);
        },
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name),
      },
      setAttribute() {}, replaceChildren() {}, append() {}, querySelector() {},
    } },
    document: { createElement: () => {
      const el = { className: '', setAttribute() {}, addEventListener() {} };
      created.push(el);
      return el;
    } },
    window: { addEventListener() {}, dispatchEvent: (event) => events.push(event) },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    setTimeout(_fn, ms) { timeouts.push(ms); }, clearTimeout() {}, queueMicrotask() {},
    fetch: async () => ({ ok: false, status: 503, headers: { get() {} }, json: async () => ({ error: 'Upstream unavailable (HTTP 503)', provider: 'hianime', mediaMode: 'anime', upstreamStatus: 503 }) }),
  });
  const source = fs.readFileSync(path.join(__dirname, '../../public/js/api.js'), 'utf8')
    .replace(/^import .*;\n/gm, '').replace(/export /g, '');
  vm.runInContext(source, context);
  return { context, classes, events, timeouts, created };
}

test('background errors update provider status without a popup, including caller re-toast', async () => {
  const { context, classes, events } = client();
  await assert.rejects(context.api('/api/test', { background: true }), (error) => {
    context.toast(error.message);
    return error.background === true;
  });
  assert.equal(classes.has('show'), false);
  assert.equal(events[0].detail.provider, 'hianime');
  await assert.rejects(context.api('/api/test'));
  assert.equal(classes.has('show'), true);
});

test('structured anime scope suppresses even generically worded errors on manga', async () => {
  const { context, classes } = client('manga');
  await assert.rejects(context.api('/api/test'));
  assert.equal(classes.has('show'), false);
});

test('HiAnime text errors stay on the anime page even without structured metadata', () => {
  const manga = client('manga');
  manga.context.toast('HiAnime: Timeout', { error: true });
  assert.equal(manga.classes.has('show'), false);
  const anime = client('anime');
  anime.context.toast('HiAnime: Timeout', { error: true });
  assert.equal(anime.classes.has('show'), true);
});

test('background network failures remain silent when callers re-toast', async () => {
  const { context, classes } = client();
  context.fetch = async () => { throw new Error('Failed to fetch'); };
  await assert.rejects(context.api('/api/test', { background: true }), (error) => {
    context.toast(error.message);
    return true;
  });
  assert.equal(classes.has('show'), false);
});

test('retired catalog messages are not special-cased off the toast', async () => {
  const { context, classes, events } = client();
  context.fetch = async () => ({
    ok: false,
    status: 503,
    headers: { get() {} },
    json: async () => ({ error: 'HiAnime unavailable (HTTP 503)', provider: 'hianime', mediaMode: 'anime', upstreamStatus: 503 }),
  });
  await assert.rejects(context.api('/api/test'));
  assert.equal(classes.has('show'), true);
  assert.equal(events[0].detail.provider, 'hianime');
});

test('playback source errors stay visible with a dismiss control', () => {
  const { context, classes, timeouts, created } = client();
  context.toast('Failed to load because no supported source was found');
  assert.equal(classes.has('show'), true);
  assert.equal(classes.has('error'), true);
  assert.equal(timeouts.includes(30_000), true);
  assert.equal(created.some((el) => el.className === 'toast-close'), true);
});

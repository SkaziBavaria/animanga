'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const AUTH_MODULES = ['../../lib/auth', '../../lib/config'];

function loadAuth({
  token = '',
  username = 'animanga',
  trustProxy = false,
} = {}) {
  process.env.ANIMANGA_ACCESS_TOKEN = token;
  process.env.ANIMANGA_ACCESS_USERNAME = username;
  process.env.ANIMANGA_TRUST_PROXY = trustProxy ? '1' : '';
  process.env.ANIMANGA_PUBLIC_URL = trustProxy ? 'https://animanga.example.com' : '';
  for (const module of AUTH_MODULES) delete require.cache[require.resolve(module)];
  return require('../../lib/auth');
}

function request(header = '', options = {}) {
  return {
    method: options.method || 'GET',
    headers: {
      authorization: header,
      ...(options.headers || {}),
    },
    socket: { remoteAddress: options.remoteAddress || '203.0.113.10' },
  };
}

function response() {
  return {
    headersSent: false,
    status: null,
    headers: {},
    body: '',
    writeHead(status, headers = {}) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    },
    end(body = '') {
      this.body = body;
    },
  };
}

function basic(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

test.afterEach(() => {
  delete process.env.ANIMANGA_ACCESS_TOKEN;
  delete process.env.ANIMANGA_ACCESS_USERNAME;
  delete process.env.ANIMANGA_TRUST_PROXY;
  delete process.env.ANIMANGA_PUBLIC_URL;
  for (const module of AUTH_MODULES) delete require.cache[require.resolve(module)];
});

test('allows requests when optional authentication is disabled', () => {
  const { requestAuthorized } = loadAuth();
  assert.equal(requestAuthorized(request()), true);
});

test('accepts only the configured Basic-auth credentials', () => {
  const { requestAuthorized } = loadAuth({ token: 'correct horse battery staple', username: 'owner' });
  assert.equal(requestAuthorized(request(basic('owner', 'correct horse battery staple'))), true);
  assert.equal(requestAuthorized(request(basic('owner', 'wrong'))), false);
  assert.equal(requestAuthorized(request(basic('animanga', 'correct horse battery staple'))), false);
  assert.equal(requestAuthorized(request('Bearer nope')), false);
});

test('parses passwords containing colons without truncating them', () => {
  const { basicCredentials } = loadAuth({ token: 'one:two' });
  assert.deepEqual(basicCredentials(basic('animanga', 'one:two')), {
    username: 'animanga',
    password: 'one:two',
  });
});

test('rejects oversized and ambiguously separated authorization headers', () => {
  const { basicCredentials } = loadAuth();
  assert.equal(basicCredentials(`Basic ${'A'.repeat(9 * 1024)}`), null);
  assert.equal(basicCredentials(`Basic  ${Buffer.from('animanga:secret').toString('base64')}`), null);
});

test('exempts only the Google OAuth callback from Basic auth', () => {
  const { requireAuthentication, isAuthExempt, GOOGLE_CALLBACK_PATH } = loadAuth({ token: 'secret' });
  assert.equal(isAuthExempt(GOOGLE_CALLBACK_PATH, 'GET'), true);
  assert.equal(isAuthExempt('/api/sync/google/connect', 'GET'), false);
  assert.equal(isAuthExempt(GOOGLE_CALLBACK_PATH, 'POST'), false);

  const callbackRes = response();
  assert.equal(requireAuthentication(request('', { method: 'GET' }), callbackRes, GOOGLE_CALLBACK_PATH), true);
  assert.equal(callbackRes.headersSent, false);

  const apiRes = response();
  assert.equal(requireAuthentication(request('', { method: 'GET' }), apiRes, '/api/sync'), false);
  assert.equal(apiRes.status, 401);
});

test('uses the first X-Forwarded-For address only when TRUST_PROXY is enabled', () => {
  const { clientIp } = loadAuth({ trustProxy: true });
  const req = request('', {
    remoteAddress: '10.0.0.1',
    headers: { 'x-forwarded-for': '198.51.100.4, 10.0.0.1' },
  });
  assert.equal(clientIp(req), '198.51.100.4');

  const withoutProxy = loadAuth({ trustProxy: false });
  assert.equal(withoutProxy.clientIp(req), '10.0.0.1');
});

test('rate limits repeated failed Basic auth attempts per IP', () => {
  const auth = loadAuth({ token: 'secret' });
  auth.resetAuthRateLimitForTests();

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const res = response();
    assert.equal(auth.requireAuthentication(request(basic('animanga', 'wrong')), res, '/api/sync'), false);
    assert.equal(res.status, 401);
  }

  const blocked = response();
  assert.equal(auth.requireAuthentication(request(basic('animanga', 'wrong')), blocked, '/api/sync'), false);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers['retry-after'], '300');
  assert.match(blocked.body, /Too many failed authentication attempts/);

  const allowed = response();
  assert.equal(auth.requireAuthentication(request(basic('animanga', 'secret')), allowed, '/api/sync'), true);
  assert.equal(allowed.headersSent, false);

  const stillBlocked = response();
  assert.equal(auth.requireAuthentication(request(basic('animanga', 'wrong')), stillBlocked, '/api/sync'), false);
  assert.equal(stillBlocked.status, 429);
});

test('missing Authorization does not consume the auth rate-limit budget', () => {
  const auth = loadAuth({ token: 'secret' });
  auth.resetAuthRateLimitForTests();

  for (let attempt = 0; attempt < 40; attempt += 1) {
    const res = response();
    assert.equal(auth.requireAuthentication(request(''), res, '/api/sync'), false);
    assert.equal(res.status, 401);
  }

  const wrong = response();
  assert.equal(auth.requireAuthentication(request(basic('animanga', 'wrong')), wrong, '/api/sync'), false);
  assert.equal(wrong.status, 401);
});

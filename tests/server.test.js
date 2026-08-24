'use strict';
// The Express proxy end-to-end (server.js) with the two upstreams —
// the hadrachot Apps Script and the staffing guides feed — faked via a
// global.fetch stub. No real network, URL, or credential is touched.

process.env.NODE_ENV = 'test';
process.env.APPS_SCRIPT_URL = 'https://apps-script.invalid/exec';
process.env.SHARED_SECRET = 'shared-secret-for-tests';
process.env.APP_PIN = '4321';
process.env.SESSION_SECRET = 's'.repeat(64);
process.env.STAFFING_GUIDES_URL = 'https://staffing.invalid/exec';
process.env.HADRACHOT_READ_SECRET = 'guides-read-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../server');

let server;
let base;
const realFetch = global.fetch;

// Per-test upstream stubs, keyed by URL prefix. Local requests (to the
// server under test) pass through to the real fetch.
let stubs = {};
global.fetch = async (url, init) => {
  const u = String(url);
  for (const prefix of Object.keys(stubs)) {
    if (u.startsWith(prefix)) return stubs[prefix](u, init);
  }
  return realFetch(url, init);
};

function jsonResponse(obj, ok) {
  return {
    ok: ok !== false,
    status: ok === false ? 500 : 200,
    text: async () => JSON.stringify(obj),
  };
}

async function http(method, path, body, token) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  if (token) init.headers['Authorization'] = 'Bearer ' + token;
  const resp = await realFetch(base + path, init);
  return { status: resp.status, body: await resp.json() };
}

let token;

test.before(async () => {
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = 'http://127.0.0.1:' + server.address().port;
  const login = await http('POST', '/api/login', { pin: '4321' });
  assert.equal(login.status, 200);
  token = login.body.token;
});

test.after(() => {
  server.close();
  global.fetch = realFetch;
});

test.beforeEach(() => { stubs = {}; });

test('login: wrong pin is 401, right pin issues a token', async () => {
  const bad = await http('POST', '/api/login', { pin: '0000' });
  assert.equal(bad.status, 401);
  assert.ok(token && token.includes('.'));
});

test('auth FAIL-CLOSED: every /api route except /api/login is 401 without a session — the board data endpoints included', async () => {
  // /api/data and /api/guides are what the board renders from; /api/session
  // is the boot gate; /api/action is every write. None may answer without a
  // valid token — no token, a garbage token, and a forged token all 401.
  for (const [method, path, body] of [
    ['GET', '/api/data'], ['GET', '/api/guides'], ['GET', '/api/session'],
    ['POST', '/api/action', { action: 'cancelHadracha', id: 'h1' }],
    ['POST', '/api/action', { action: 'baselineBatch', completedDate: '2026-08-24',
      items: [{ type: 'individual', guideName: 'עדי', house: 'hq' }] }],
  ]) {
    const noToken = await http(method, path, body);
    assert.equal(noToken.status, 401, method + ' ' + path);
    const badToken = await http(method, path, body, 'garbage.token');
    assert.equal(badToken.status, 401, method + ' ' + path + ' bad token');
    const forged = await http(method, path, body, token.replace(/.$/, c => (c === 'a' ? 'b' : 'a')));
    assert.equal(forged.status, 401, method + ' ' + path + ' forged token');
  }
});

test('/api/session: 200 { ok } with a valid session, no data beyond that', async () => {
  const resp = await http('GET', '/api/session', undefined, token);
  assert.equal(resp.status, 200);
  assert.deepEqual(resp.body, { ok: true });
});

test('there is no unauthenticated /api/health — unknown unauthenticated /api paths never return 200', async () => {
  const resp = await http('GET', '/api/health');
  assert.equal(resp.status, 404); // the route was removed; the JSON 404 fallback answers
});

test('/api/data proxies the Apps Script GET with the shared secret', async () => {
  let seenUrl = '';
  stubs['https://apps-script.invalid'] = async (url) => {
    seenUrl = url;
    return jsonResponse({ _status: 200, supervisors: [], hadrachot: [], settings: {} });
  };
  const resp = await http('GET', '/api/data', undefined, token);
  assert.equal(resp.status, 200);
  assert.deepEqual(resp.body, { supervisors: [], hadrachot: [], settings: {} });
  assert.ok(seenUrl.includes('secret=shared-secret-for-tests'));
});

test('/api/guides adds action and secret server-side and relays ONLY the guides key', async () => {
  let seenUrl = '';
  stubs['https://staffing.invalid'] = async (url) => {
    seenUrl = url;
    return jsonResponse({
      _status: 200,
      guides: [{ name: 'דנה לוי', house: 'ramot', active: true, startDate: '2026-08-01' }],
      workers: [{ salary: 99999 }],       // must never reach the client
      internalDebug: 'secret-stuff',
    });
  };
  const resp = await http('GET', '/api/guides', undefined, token);
  assert.equal(resp.status, 200);
  assert.deepEqual(Object.keys(resp.body), ['guides']);
  assert.equal(resp.body.guides[0].name, 'דנה לוי');
  assert.ok(seenUrl.includes('action=getGuidesForHadrachot'));
  assert.ok(seenUrl.includes('secret=guides-read-secret'));
});

test('/api/guides FAIL-CLOSED: upstream 401 becomes a generic 502, never data', async () => {
  stubs['https://staffing.invalid'] = async () =>
    jsonResponse({ _status: 401, error: 'unauthorized' });
  const resp = await http('GET', '/api/guides', undefined, token);
  assert.equal(resp.status, 502);
  assert.deepEqual(resp.body, { error: 'guides feed unavailable' });
});

test('/api/guides FAIL-CLOSED: non-JSON upstream (a Google sign-in page) is a 502', async () => {
  stubs['https://staffing.invalid'] = async () => ({
    ok: true, status: 200, text: async () => '<html>Sign in with Google</html>',
  });
  const resp = await http('GET', '/api/guides', undefined, token);
  assert.equal(resp.status, 502);
  assert.deepEqual(resp.body, { error: 'guides feed unavailable' });
});

test('/api/guides FAIL-CLOSED: a payload without a guides array is a 502, never []', async () => {
  stubs['https://staffing.invalid'] = async () => jsonResponse({ _status: 200, ok: true });
  const resp = await http('GET', '/api/guides', undefined, token);
  assert.equal(resp.status, 502);
});

test('/api/action rejects invalid payloads WITHOUT calling the upstream', async () => {
  let upstreamCalled = false;
  stubs['https://apps-script.invalid'] = async () => {
    upstreamCalled = true;
    return jsonResponse({ _status: 200, ok: true });
  };
  const resp = await http('POST', '/api/action',
    { action: 'addHadracha', hadracha: { guideName: 'א', house: 'narnia', quarter: '2026-Q3' } },
    token);
  assert.equal(resp.status, 400);
  assert.equal(upstreamCalled, false);
});

test('/api/action forwards the SANITIZED payload, not the raw body', async () => {
  let forwarded = null;
  stubs['https://apps-script.invalid'] = async (url, init) => {
    forwarded = JSON.parse(init.body);
    return jsonResponse({ _status: 200, ok: true });
  };
  const resp = await http('POST', '/api/action', {
    action: 'addHadracha',
    hadracha: {
      guideName: 'דנה', house: 'ramot', quarter: '2026-Q3',
      status: 'done', completedDate: '2026-01-01', salary: 9999,
    },
    extraTopLevel: 'nope',
  }, token);
  assert.equal(resp.status, 200);
  assert.equal(forwarded.hadracha.status, 'planned');
  assert.equal(forwarded.hadracha.completedDate, undefined);
  assert.equal(forwarded.hadracha.salary, undefined);
  assert.equal(forwarded.extraTopLevel, undefined);
});

test('/api/action baselineBatch: forwards the SANITIZED batch in one upstream call', async () => {
  const calls = [];
  stubs['https://apps-script.invalid'] = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return jsonResponse({ _status: 200, ok: true, count: 2 });
  };
  const resp = await http('POST', '/api/action', {
    action: 'baselineBatch',
    completedDate: '2026-08-24',
    items: [
      { type: 'individual', guideName: 'עדי', house: 'hq', salary: 9999 },
      { type: 'group', cluster: 'kesaria', attendance: ['דנה לוי'] },
    ],
  }, token);
  assert.equal(resp.status, 200);
  assert.equal(calls.length, 1); // the whole list in ONE backend action
  assert.equal(calls[0].action, 'baselineBatch');
  assert.equal(calls[0].items.length, 2);
  assert.equal(calls[0].items[0].salary, undefined);
});

test('unknown /api path is a JSON 404', async () => {
  const resp = await http('GET', '/api/nope', undefined, token);
  assert.equal(resp.status, 404);
});

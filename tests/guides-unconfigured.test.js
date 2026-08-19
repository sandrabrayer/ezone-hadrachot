'use strict';
// FAIL-CLOSED when the guides feed is NOT configured: /api/guides must answer
// 503 { error } — never 200 with an empty roster, which would read as "no
// guide needs a hadracha". Runs in its own file so server.js is required
// with a clean environment (each test file is a separate process).

process.env.NODE_ENV = 'test';
process.env.APPS_SCRIPT_URL = 'https://apps-script.invalid/exec';
process.env.SHARED_SECRET = 'shared-secret-for-tests';
process.env.APP_PIN = '4321';
process.env.SESSION_SECRET = 's'.repeat(64);
delete process.env.STAFFING_GUIDES_URL;
delete process.env.HADRACHOT_READ_SECRET;

const test = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../server');

let server;
let base;

test.before(async () => {
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = 'http://127.0.0.1:' + server.address().port;
});

test.after(() => server.close());

test('/api/guides answers 503 with an error while unconfigured', async () => {
  const login = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: '4321' }),
  });
  const { token } = await login.json();
  const resp = await fetch(base + '/api/guides', {
    headers: { Authorization: 'Bearer ' + token },
  });
  assert.equal(resp.status, 503);
  const body = await resp.json();
  assert.ok(body.error);
  assert.equal(body.guides, undefined);
});

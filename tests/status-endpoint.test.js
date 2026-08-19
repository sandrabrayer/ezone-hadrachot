'use strict';
// Guards for the read-only getFirstHadrachaStatus feed (apps-script/Code.gs).
//
// The Apps Script backend has no JS harness, so we evaluate Code.gs in a vm
// sandbox with the GAS services mocked and drive doGet end-to-end for the
// auth behaviour, then exercise the pure builder computeFirstHadrachaStatus_
// with an overridden reader for the field filtering.
//
// The two hard rules pinned here:
//   - FIELD FILTERING: the feed carries name / firstHadrachaDone /
//     firstCompletedDate and NOTHING else — no house, supervisor, quarter,
//     schedule, status, id, created_at.
//   - FAIL-CLOSED AUTH: missing HADRACHOT_STATUS_SECRET property, missing
//     secret, wrong secret, or the main SHARED_SECRET → 401 error, never data.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const GS_PATH = path.join(__dirname, '..', 'apps-script', 'Code.gs');
const gs = fs.readFileSync(GS_PATH, 'utf8');

// Evaluate Code.gs in a sandbox with the GAS surface the status path touches
// mocked out. `props` seeds the Script Properties store.
function loadCtx(props) {
  const store = Object.assign({}, props);
  const ctx = vm.createContext({
    Logger: { log() {} },
    PropertiesService: {
      getScriptProperties() {
        return {
          getProperty(k) {
            return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null;
          },
        };
      },
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput(s) { return { _text: s, setMimeType() { return this; } }; },
    },
    // Any touch of the spreadsheet from an unauthorized path must explode.
    SpreadsheetApp: {
      openById() { throw new Error('SpreadsheetApp must not be touched'); },
    },
  });
  vm.runInContext(gs, ctx);
  return ctx;
}

function out(o) { return JSON.parse(o._text); }

// Fixture rows exactly as readHadrachotSafe returns them — every field a raw
// sheet row carries, so any leak shows up.
function seedReader(ctx) {
  ctx.readHadrachotSafe = () => [
    { id: 'h1', guideName: 'דנה לוי', house: 'ramot', supervisorId: 's1',
      quarter: '2026-Q2', scheduledDate: '2026-05-01', completedDate: '2026-05-03',
      status: 'done', createdAt: '2026-05-01T00:00:00Z' },
    { id: 'h2', guideName: 'דנה לוי', house: 'ramot', supervisorId: 's2',
      quarter: '2026-Q3', scheduledDate: '2026-08-01', completedDate: '2026-08-02',
      status: 'done', createdAt: '2026-08-01T00:00:00Z' },
    { id: 'h3', guideName: 'יואב כהן', house: 'asher', supervisorId: 's1',
      quarter: '2026-Q3', scheduledDate: '2026-08-20', completedDate: '',
      status: 'planned', createdAt: '2026-08-01T00:00:00Z' },
    { id: 'h4', guideName: 'רות אשר', house: 'rehab', supervisorId: 's1',
      quarter: '2026-Q3', scheduledDate: '2026-08-10', completedDate: '2026-08-10',
      status: 'cancelled', createdAt: '2026-08-01T00:00:00Z' },
    { id: 'h5', guideName: '  נועה   בר ', house: 'hq', supervisorId: '',
      quarter: '2026-Q3', scheduledDate: '', completedDate: '2026-07-15',
      status: 'done', createdAt: '2026-07-01T00:00:00Z' },
  ];
}

const SECRET = 'status-feed-secret';
const MAIN = 'main-shared-secret';
const PROPS = { HADRACHOT_STATUS_SECRET: SECRET, SHARED_SECRET: MAIN };

function callFeed(ctx, secret) {
  return out(ctx.doGet({ parameter: { action: 'getFirstHadrachaStatus', secret } }));
}

// ---------------------------------------------------------------------------
// Fail-closed auth
// ---------------------------------------------------------------------------

test('feed: 401 when HADRACHOT_STATUS_SECRET property is unset — even with a matching guess', () => {
  const ctx = loadCtx({ SHARED_SECRET: MAIN });
  seedReader(ctx);
  for (const guess of ['', 'anything', MAIN]) {
    const body = callFeed(ctx, guess);
    assert.strictEqual(body._status, 401);
    assert.strictEqual(body.guides, undefined);
  }
});

test('feed: 401 on missing or wrong secret', () => {
  const ctx = loadCtx(PROPS);
  seedReader(ctx);
  assert.strictEqual(callFeed(ctx, undefined)._status, 401);
  assert.strictEqual(callFeed(ctx, '')._status, 401);
  assert.strictEqual(callFeed(ctx, 'wrong')._status, 401);
  assert.strictEqual(callFeed(ctx, SECRET + 'x')._status, 401);
});

test('feed: the main SHARED_SECRET does NOT unlock the status feed', () => {
  const ctx = loadCtx(PROPS);
  seedReader(ctx);
  const body = callFeed(ctx, MAIN);
  assert.strictEqual(body._status, 401);
  assert.strictEqual(body.guides, undefined);
});

test("feed's secret does NOT unlock the main doGet/doPost surface", () => {
  const ctx = loadCtx(PROPS);
  seedReader(ctx);
  const body = out(ctx.doGet({ parameter: { secret: SECRET } }));
  assert.strictEqual(body._status, 401);
  assert.strictEqual(body.supervisors, undefined);
});

test('main surface: 401 when SHARED_SECRET property is unset', () => {
  const ctx = loadCtx({});
  seedReader(ctx);
  const body = out(ctx.doGet({ parameter: { secret: '' } }));
  assert.strictEqual(body._status, 401);
});

// ---------------------------------------------------------------------------
// Field filtering
// ---------------------------------------------------------------------------

test('feed: only completed guides appear, with earliest date, and ONLY the three allowed fields', () => {
  const ctx = loadCtx(PROPS);
  seedReader(ctx);
  const body = callFeed(ctx, SECRET);
  assert.strictEqual(body._status, 200);

  const byName = {};
  body.guides.forEach(g => { byName[g.name] = g; });

  // דנה לוי has two done rows — the EARLIEST completed date is reported.
  assert.strictEqual(byName['דנה לוי'].firstCompletedDate, '2026-05-03');
  assert.strictEqual(byName['דנה לוי'].firstHadrachaDone, true);
  // Whitespace in the sheet cell is normalized to the cross-app name key.
  assert.strictEqual(byName['נועה בר'].firstCompletedDate, '2026-07-15');
  // planned (יואב) and cancelled (רות) rows never appear.
  assert.strictEqual(byName['יואב כהן'], undefined);
  assert.strictEqual(byName['רות אשר'], undefined);
  assert.strictEqual(body.guides.length, 2);

  const ALLOWED = ['name', 'firstHadrachaDone', 'firstCompletedDate'];
  const FORBIDDEN = ['id', 'house', 'supervisorId', 'quarter', 'scheduledDate', 'status', 'createdAt'];
  body.guides.forEach(g => {
    assert.deepStrictEqual(Object.keys(g).sort(), ALLOWED.slice().sort(),
      'entry carries exactly the allowed fields');
    FORBIDDEN.forEach(k => assert.strictEqual(g[k], undefined, k + ' must never leak'));
  });
});

test('feed: a done row with a malformed completed date is skipped, not emitted', () => {
  const ctx = loadCtx(PROPS);
  ctx.readHadrachotSafe = () => [
    { id: 'h1', guideName: 'דנה לוי', house: 'ramot', supervisorId: 's1',
      quarter: '2026-Q3', scheduledDate: '', completedDate: 'not-a-date',
      status: 'done', createdAt: '' },
  ];
  const body = callFeed(ctx, SECRET);
  assert.strictEqual(body._status, 200);
  assert.deepStrictEqual(body.guides, []);
});

test('feed: shape matches the staffing parser contract — guides array, firstHadrachaDone === true', () => {
  const ctx = loadCtx(PROPS);
  seedReader(ctx);
  const body = callFeed(ctx, SECRET);
  assert.ok(Array.isArray(body.guides));
  body.guides.forEach(g => assert.strictEqual(g.firstHadrachaDone, true));
});

'use strict';
// Migration safety for the sheet-backed backend (apps-script/Code.gs).
//
// The header arrays are APPEND-ONLY and position-mapped: the legacy column
// prefix is pinned here so nothing can ever be inserted mid-array, and the
// readers are driven against PRE-MIGRATION rows (fewer columns) to prove
// existing data keeps working with safe defaults. Also covered: the one-time
// אולגה seed and the attendance write path.
//
// Code.gs runs in a vm sandbox with the GAS surface mocked by an in-memory
// spreadsheet, same approach as status-endpoint.test.js.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const GS_PATH = path.join(__dirname, '..', 'apps-script', 'Code.gs');
const gs = fs.readFileSync(GS_PATH, 'utf8');

// ---- in-memory Sheets fakes ----

function fakeSheet(rows) {
  return {
    _rows: rows.map(r => r.slice()),
    getDataRange() {
      const self = this;
      return {
        getValues() {
          // Sheets pads every row to the widest column, like getValues does.
          const w = Math.max(1, ...self._rows.map(r => r.length));
          return self._rows.map(r => r.concat(new Array(w - r.length).fill('')));
        },
      };
    },
    getLastColumn() { return this._rows.length ? this._rows[0].length : 0; },
    getRange(row, col, numRows, numCols) {
      const self = this;
      return {
        setValues(vals) {
          for (let i = 0; i < (numRows || vals.length); i++) {
            while (self._rows.length < row + i) self._rows.push([]);
            const r = self._rows[row - 1 + i];
            for (let j = 0; j < (numCols || vals[i].length); j++) {
              while (r.length < col + j) r.push('');
              r[col - 1 + j] = vals[i][j];
            }
          }
        },
        setValue(v) { this.setValues([[v]]); },
        getValue() {
          const r = self._rows[row - 1] || [];
          return r[col - 1] === undefined ? '' : r[col - 1];
        },
      };
    },
    appendRow(vals) { this._rows.push(vals.slice()); },
    deleteRow(row) { this._rows.splice(row - 1, 1); },
    setFrozenRows() {},
  };
}

function loadCtx(sheets) {
  const book = {
    _sheets: sheets,
    getSheetByName(n) { return this._sheets[n] || null; },
    insertSheet(n) {
      const sh = fakeSheet([[]]);
      sh._rows = [];
      this._sheets[n] = sh;
      // A fresh sheet starts with one empty row the header lands on.
      sh._rows.push([]);
      return sh;
    },
  };
  const ctx = vm.createContext({
    Logger: { log() {} },
    PropertiesService: {
      getScriptProperties() {
        return { getProperty(k) { return k === 'SHEET_ID' ? 'fake' : 'secret'; } };
      },
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput(s) { return { _text: s, setMimeType() { return this; } }; },
    },
    SpreadsheetApp: { openById() { return book; } },
    LockService: {
      getScriptLock() { return { waitLock() {}, releaseLock() {} }; },
    },
    Utilities: { formatDate() { return ''; } },
    Session: { getScriptTimeZone() { return 'UTC'; } },
  });
  vm.runInContext(gs, ctx);
  ctx._book = book;
  return ctx;
}

// Top-level const bindings (the header arrays) live in the context's global
// lexical scope, not as context properties — read them by evaluating in the
// same context.
function constOf(ctx, name) {
  return plain(vm.runInContext(name, ctx));
}

// Values crossing out of the vm realm carry the sandbox's prototypes, which
// deepStrictEqual rejects — flatten to plain host objects first.
function plain(v) {
  return JSON.parse(JSON.stringify(v));
}

// Pre-migration tabs exactly as the 1.0 backend created them.
const LEGACY_SUP_HEADER = ['id', 'name', 'houses', 'max_per_quarter', 'active', 'created_at'];
const LEGACY_HAD_HEADER = [
  'id', 'guide_name', 'house', 'supervisor_id', 'quarter',
  'scheduled_date', 'completed_date', 'status', 'created_at',
];

function legacyBook() {
  return {
    Supervisors: fakeSheet([
      LEGACY_SUP_HEADER,
      ['s1', 'אורית', 'ramot,hq', 10, 'true', '2026-01-01T00:00:00Z'],
    ]),
    Hadrachot: fakeSheet([
      LEGACY_HAD_HEADER,
      ['h1', 'דנה לוי', 'ramot', 's1', '2026-Q2', '2026-05-01', '2026-05-03', 'done', '2026-05-01T00:00:00Z'],
    ]),
    Settings: fakeSheet([['key', 'value']]),
  };
}

// ---- append-only headers ----

test('header arrays keep the legacy columns as an untouched PREFIX — new columns at the END only', () => {
  const ctx = loadCtx(legacyBook());
  const supHeaders = constOf(ctx, 'HEADERS_SUPERVISORS');
  const hadHeaders = constOf(ctx, 'HEADERS_HADRACHOT');
  assert.deepStrictEqual(supHeaders.slice(0, 6), LEGACY_SUP_HEADER);
  assert.deepStrictEqual(supHeaders.slice(6),
    ['delivers_group', 'delivers_individual', 'delivers_refresher', 'roles']);
  assert.deepStrictEqual(hadHeaders.slice(0, 9), LEGACY_HAD_HEADER);
  assert.deepStrictEqual(hadHeaders.slice(9), ['type', 'cluster', 'attendance']);
});

test('ensureTabs_ APPENDS the missing header cells to a pre-migration sheet in place', () => {
  const ctx = loadCtx(legacyBook());
  ctx.ensureTabs_();
  assert.deepStrictEqual(ctx._book.getSheetByName('Supervisors')._rows[0],
    constOf(ctx, 'HEADERS_SUPERVISORS'));
  assert.deepStrictEqual(ctx._book.getSheetByName('Hadrachot')._rows[0],
    constOf(ctx, 'HEADERS_HADRACHOT'));
  // The legacy data row was not moved — position mapping intact.
  assert.strictEqual(ctx._book.getSheetByName('Hadrachot')._rows[1][0], 'h1');
  assert.strictEqual(ctx._book.getSheetByName('Hadrachot')._rows[1][7], 'done');
});

// ---- legacy rows keep working ----

test('readHadrachotSafe: a pre-migration row reads as an individual session with no cluster or attendance', () => {
  const ctx = loadCtx(legacyBook());
  const rows = plain(ctx.readHadrachotSafe());
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].type, 'individual');
  assert.strictEqual(rows[0].cluster, '');
  assert.deepStrictEqual(rows[0].attendance, []);
  assert.strictEqual(rows[0].status, 'done');
  assert.strictEqual(rows[0].completedDate, '2026-05-03');
});

test('readSupervisorsSafe: a pre-migration row defaults to group+individual true, refresher false, roles blank', () => {
  const ctx = loadCtx(legacyBook());
  const sups = plain(ctx.readSupervisorsSafe());
  assert.strictEqual(sups.length, 1);
  assert.strictEqual(sups[0].deliversGroup, true);
  assert.strictEqual(sups[0].deliversIndividual, true);
  assert.strictEqual(sups[0].deliversRefresher, false);
  assert.deepStrictEqual(sups[0].roles, []); // blank = all roles, frontend semantics
});

test('a new group row round-trips: cluster and attendance stored and read back', () => {
  const ctx = loadCtx(legacyBook());
  ctx.ensureTabs_();
  const added = ctx.addHadracha({ hadracha: {
    type: 'group', cluster: 'kesaria', supervisorId: 's1',
    quarter: '2026-Q3', scheduledDate: '2026-08-20',
  } }).hadracha;
  ctx.setAttendance({ id: added.id, attendance: ['דנה לוי', 'יואב כהן'] });
  const row = plain(ctx.readHadrachotSafe().find(h => h.id === added.id));
  assert.strictEqual(row.type, 'group');
  assert.strictEqual(row.cluster, 'kesaria');
  assert.deepStrictEqual(row.attendance, ['דנה לוי', 'יואב כהן']);
  assert.strictEqual(row.guideName, '');
});

test('setAttendance: rejected on a non-group session', () => {
  const ctx = loadCtx(legacyBook());
  ctx.ensureTabs_();
  assert.throws(() => ctx.setAttendance({ id: 'h1', attendance: ['דנה לוי'] }),
    err => err.status === 409);
});

test('one open planned session per track: same cluster twice → 409, same person+type twice → 409', () => {
  const ctx = loadCtx(legacyBook());
  ctx.ensureTabs_();
  ctx.addHadracha({ hadracha: {
    type: 'group', cluster: 'kesaria', quarter: '2026-Q3', scheduledDate: '2026-08-20',
  } });
  assert.throws(() => ctx.addHadracha({ hadracha: {
    type: 'group', cluster: 'kesaria', quarter: '2026-Q3', scheduledDate: '2026-08-27',
  } }), err => err.status === 409);
  ctx.addHadracha({ hadracha: {
    guideName: 'רות', house: 'hq', quarter: '2026-Q3', scheduledDate: '2026-08-20',
  } });
  assert.throws(() => ctx.addHadracha({ hadracha: {
    guideName: 'רות', house: 'hq', quarter: '2026-Q3', scheduledDate: '2026-08-27',
  } }), err => err.status === 409);
  // …but a refresher for the same person is a different track.
  ctx.addHadracha({ hadracha: {
    type: 'refresher', guideName: 'רות', house: 'hq', quarter: '2026-Q3', scheduledDate: '2026-08-27',
  } });
});

// ---- the baseline bulk action ----

test('baselineBatch: writes DONE rows dated the batch date for every track in one call', () => {
  const ctx = loadCtx(legacyBook());
  ctx.ensureTabs_();
  const out = plain(ctx.baselineBatch({
    completedDate: '2026-08-24',
    items: [
      { type: 'individual', guideName: 'עדי ברק', house: 'hq' },
      { type: 'refresher', guideName: 'דנה לוי', house: 'ofroni' },
      { type: 'group', cluster: 'kesaria', attendance: ['דנה לוי', 'יואב כהן'] },
    ],
  }));
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.count, 3);
  const rows = plain(ctx.readHadrachotSafe());
  const adi = rows.find(h => h.guideName === 'עדי ברק');
  assert.strictEqual(adi.status, 'done');
  assert.strictEqual(adi.type, 'individual');
  assert.strictEqual(adi.completedDate, '2026-08-24');
  assert.strictEqual(adi.scheduledDate, '2026-08-24');
  assert.strictEqual(adi.quarter, '2026-Q3');
  assert.strictEqual(adi.supervisorId, ''); // a baseline row has no supervisor
  const ref = rows.find(h => h.type === 'refresher');
  assert.strictEqual(ref.guideName, 'דנה לוי');
  assert.strictEqual(ref.status, 'done');
  const grp = rows.find(h => h.type === 'group');
  assert.strictEqual(grp.cluster, 'kesaria');
  assert.strictEqual(grp.status, 'done');
  assert.deepStrictEqual(grp.attendance, ['דנה לוי', 'יואב כהן']);
});

test('baselineBatch: mirrors the validators — bad items and duplicates are rejected whole', () => {
  const ctx = loadCtx(legacyBook());
  ctx.ensureTabs_();
  const before = plain(ctx.readHadrachotSafe()).length;
  assert.throws(() => ctx.baselineBatch({ completedDate: 'today', items: [
    { type: 'individual', guideName: 'עדי', house: 'hq' }] }), err => err.status === 400);
  assert.throws(() => ctx.baselineBatch({ completedDate: '2026-08-24', items: [] }),
    err => err.status === 400);
  assert.throws(() => ctx.baselineBatch({ completedDate: '2026-08-24', items: [
    { type: 'group', cluster: 'kesaria', attendance: [] }] }), err => err.status === 400);
  assert.throws(() => ctx.baselineBatch({ completedDate: '2026-08-24', items: [
    { type: 'individual', guideName: 'עדי', house: 'hq' },
    { type: 'individual', guideName: 'עדי', house: 'hq' }] }), err => err.status === 400);
  assert.strictEqual(plain(ctx.readHadrachotSafe()).length, before); // nothing written
});

// ---- the אולגה seed ----

test('ensureSeedData_ seeds אולגה once as a refresher-only guide instructor', () => {
  const ctx = loadCtx(legacyBook());
  ctx.ensureTabs_();
  ctx.ensureSeedData_();
  const sups = plain(ctx.readSupervisorsSafe());
  const olga = sups.find(s => s.name === 'אולגה');
  assert.ok(olga, 'אולגה seeded');
  assert.strictEqual(olga.active, true);
  assert.strictEqual(olga.deliversGroup, false);
  assert.strictEqual(olga.deliversIndividual, false);
  assert.strictEqual(olga.deliversRefresher, true);
  assert.deepStrictEqual(olga.roles, ['guide']);
  assert.strictEqual(ctx.readSettingsSafe()['seed.olga'], 'done');
  // Idempotent — a second run never duplicates her.
  ctx.ensureSeedData_();
  assert.strictEqual(ctx.readSupervisorsSafe().filter(s => s.name === 'אולגה').length, 1);
});

test('ensureSeedData_ does not add a second אולגה when one already exists', () => {
  const sheets = legacyBook();
  sheets.Supervisors.appendRow(
    ['s2', 'אולגה', 'ramot', 5, 'true', '2026-01-01T00:00:00Z']);
  const ctx = loadCtx(sheets);
  ctx.ensureTabs_();
  ctx.ensureSeedData_();
  assert.strictEqual(ctx.readSupervisorsSafe().filter(s => s.name === 'אולגה').length, 1);
  assert.strictEqual(ctx.readSettingsSafe()['seed.olga'], 'done');
});

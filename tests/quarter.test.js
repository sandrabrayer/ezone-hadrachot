'use strict';
// Calendar-quarter math in lib/scheduler.js — the foundation every
// compliance decision stands on, so the boundaries are pinned exactly.

const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lib/scheduler');

test('quarterOf: maps months to calendar quarters', () => {
  assert.equal(L.quarterOf('2026-01-01'), '2026-Q1');
  assert.equal(L.quarterOf('2026-03-31'), '2026-Q1');
  assert.equal(L.quarterOf('2026-04-01'), '2026-Q2');
  assert.equal(L.quarterOf('2026-06-30'), '2026-Q2');
  assert.equal(L.quarterOf('2026-07-01'), '2026-Q3');
  assert.equal(L.quarterOf('2026-09-30'), '2026-Q3');
  assert.equal(L.quarterOf('2026-10-01'), '2026-Q4');
  assert.equal(L.quarterOf('2026-12-31'), '2026-Q4');
});

test('quarterOf: malformed input yields empty string, never a quarter', () => {
  assert.equal(L.quarterOf(''), '');
  assert.equal(L.quarterOf('2026-13-01'.slice(0, 9)), '');
  assert.equal(L.quarterOf('01/08/2026'), '');
  assert.equal(L.quarterOf(null), '');
  assert.equal(L.quarterOf(undefined), '');
});

test('quarterStart and quarterEnd: exact boundaries for all four quarters', () => {
  assert.equal(L.quarterStart('2026-Q1'), '2026-01-01');
  assert.equal(L.quarterEnd('2026-Q1'), '2026-03-31');
  assert.equal(L.quarterStart('2026-Q2'), '2026-04-01');
  assert.equal(L.quarterEnd('2026-Q2'), '2026-06-30');
  assert.equal(L.quarterStart('2026-Q3'), '2026-07-01');
  assert.equal(L.quarterEnd('2026-Q3'), '2026-09-30');
  assert.equal(L.quarterStart('2026-Q4'), '2026-10-01');
  assert.equal(L.quarterEnd('2026-Q4'), '2026-12-31');
});

test('quarterStart/End: reject malformed quarters', () => {
  assert.equal(L.quarterStart('2026-Q5'), '');
  assert.equal(L.quarterEnd('2026Q1'), '');
  assert.equal(L.quarterStart(''), '');
});

test('nextQuarter: Q4 rolls into the next year', () => {
  assert.equal(L.nextQuarter('2026-Q1'), '2026-Q2');
  assert.equal(L.nextQuarter('2026-Q4'), '2027-Q1');
  assert.equal(L.nextQuarter('bad'), '');
});

test('addDays: crosses month and year boundaries', () => {
  assert.equal(L.addDays('2026-08-10', 7), '2026-08-17');
  assert.equal(L.addDays('2026-08-28', 7), '2026-09-04');
  assert.equal(L.addDays('2026-12-28', 7), '2027-01-04');
  assert.equal(L.addDays('2024-02-26', 4), '2024-03-01'); // leap year
  assert.equal(L.addDays('2026-02-26', 4), '2026-03-02'); // non-leap
  assert.equal(L.addDays('', 7), '');
});

test('daysBetween: whole days, null on malformed input', () => {
  assert.equal(L.daysBetween('2026-08-10', '2026-08-17'), 7);
  assert.equal(L.daysBetween('2026-08-17', '2026-08-10'), -7);
  assert.equal(L.daysBetween('2026-08-10', '2026-08-10'), 0);
  assert.equal(L.daysBetween('', '2026-08-10'), null);
  assert.equal(L.daysBetween('2026-08-10', 'oops'), null);
});

test('quarter boundary: a hadracha completed in Q2 does not satisfy Q3', () => {
  const guide = { name: 'דנה לוי', house: 'ramot', active: true, startDate: '2025-01-01' };
  const hadrachot = [{
    guideName: 'דנה לוי', house: 'ramot', supervisorId: 's1',
    quarter: '2026-Q2', scheduledDate: '2026-06-20', completedDate: '2026-06-25', status: 'done',
  }];
  const st = L.guideStatus(guide, hadrachot, '2026-07-01');
  assert.equal(st.quarter, '2026-Q3');
  assert.equal(st.status, 'none');
});

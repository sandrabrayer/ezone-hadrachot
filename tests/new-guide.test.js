'use strict';
// The 7-day new-guide rule: a guide inside their FIRST calendar quarter must
// complete a first hadracha within 7 days of start_date. Exactly 7 days is
// NOT overdue — strict "exceeds", mirroring the staffing app's grace logic.

const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lib/scheduler');

function guide(startDate) {
  return { name: 'יואב כהן', house: 'asher', active: true, startDate };
}

test('isNewGuide: true only inside the quarter containing start_date', () => {
  assert.equal(L.isNewGuide('2026-08-10', '2026-Q3'), true);
  assert.equal(L.isNewGuide('2026-06-30', '2026-Q3'), false); // previous quarter
  assert.equal(L.isNewGuide('', '2026-Q3'), false);           // no start date → never "new"
  assert.equal(L.isNewGuide('bad-date', '2026-Q3'), false);
});

test('firstHadrachaDeadline: start_date plus exactly 7 days', () => {
  assert.equal(L.firstHadrachaDeadline('2026-08-10'), '2026-08-17');
  assert.equal(L.firstHadrachaDeadline('2026-09-28'), '2026-10-05'); // spills into Q4
  assert.equal(L.firstHadrachaDeadline(''), '');
});

test('boundary: day 7 exactly is NOT overdue', () => {
  const st = L.guideStatus(guide('2026-08-10'), [], '2026-08-17');
  assert.equal(st.newGuide, true);
  assert.equal(st.deadline, '2026-08-17');
  assert.equal(st.overdue, false);
});

test('boundary: day 8 IS overdue', () => {
  const st = L.guideStatus(guide('2026-08-10'), [], '2026-08-18');
  assert.equal(st.newGuide, true);
  assert.equal(st.overdue, true);
});

test('a completed first hadracha clears the overdue flag past day 7', () => {
  const hadrachot = [{
    guideName: 'יואב כהן', house: 'asher', supervisorId: 's1',
    quarter: '2026-Q3', scheduledDate: '2026-08-12', completedDate: '2026-08-14', status: 'done',
  }];
  const st = L.guideStatus(guide('2026-08-10'), hadrachot, '2026-08-25');
  assert.equal(st.overdue, false);
  assert.equal(st.status, 'done');
  assert.equal(st.firstDone, '2026-08-14');
});

test('a planned-but-not-completed hadracha does NOT clear the 7-day rule', () => {
  const hadrachot = [{
    guideName: 'יואב כהן', house: 'asher', supervisorId: 's1',
    quarter: '2026-Q3', scheduledDate: '2026-08-20', completedDate: '', status: 'planned',
  }];
  const st = L.guideStatus(guide('2026-08-10'), hadrachot, '2026-08-18');
  assert.equal(st.status, 'planned');
  assert.equal(st.overdue, true);
});

test('a cancelled hadracha counts as nothing', () => {
  const hadrachot = [{
    guideName: 'יואב כהן', house: 'asher', supervisorId: 's1',
    quarter: '2026-Q3', scheduledDate: '2026-08-12', completedDate: '2026-08-12', status: 'cancelled',
  }];
  const st = L.guideStatus(guide('2026-08-10'), hadrachot, '2026-08-18');
  assert.equal(st.status, 'none');
  assert.equal(st.overdue, true);
});

test('once the first quarter ends the guide is regular — quarterly rule takes over', () => {
  // Started 2026-09-28 (Q3): in Q4 they are no longer "new"; the 7-day rule
  // no longer applies and the deadline is no longer shown.
  const st = L.guideStatus(guide('2026-09-28'), [], '2026-10-10');
  assert.equal(st.newGuide, false);
  assert.equal(st.deadline, '');
  assert.equal(st.quarter, '2026-Q4');
  assert.equal(st.status, 'none');
});

test('guide with no start date is never judged by the 7-day rule', () => {
  const st = L.guideStatus(guide(''), [], '2026-08-18');
  assert.equal(st.newGuide, false);
  assert.equal(st.overdue, false);
});

test('regular guide: a planned hadracha whose scheduled date slipped is overdue', () => {
  const hadrachot = [{
    guideName: 'יואב כהן', house: 'asher', supervisorId: 's1',
    quarter: '2026-Q3', scheduledDate: '2026-08-01', completedDate: '', status: 'planned',
  }];
  const st = L.guideStatus(guide('2025-01-01'), hadrachot, '2026-08-19');
  assert.equal(st.newGuide, false);
  assert.equal(st.overdue, true);
});

test('guide names are matched with normalized whitespace', () => {
  const hadrachot = [{
    guideName: '  יואב   כהן ', house: 'asher', supervisorId: 's1',
    quarter: '2026-Q3', scheduledDate: '2026-08-12', completedDate: '2026-08-12', status: 'done',
  }];
  const st = L.guideStatus(guide('2026-08-10'), hadrachot, '2026-08-25');
  assert.equal(st.status, 'done');
  assert.equal(st.overdue, false);
});

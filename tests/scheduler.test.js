'use strict';
// The auto-scheduler behind שבץ רבעון: same-house preference, load balancing
// against each supervisor's quarterly max, new-guide immediacy, and skipping
// guides who already have a live hadracha this quarter.

const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lib/scheduler');

const TODAY = '2026-08-19'; // inside 2026-Q3
const Q = '2026-Q3';

function sup(id, name, houses, max, active) {
  return { id, name, houses, maxPerQuarter: max, active: active !== false };
}
function g(name, house, startDate, active) {
  return { name, house, startDate: startDate || '2025-01-01', active: active !== false };
}

test('prefers a supervisor covering the guide house', () => {
  const out = L.scheduleQuarter({
    guides: [g('דנה', 'ramot')],
    supervisors: [
      sup('s1', 'אורית', ['asher'], 10),
      sup('s2', 'נועם', ['ramot'], 10),
    ],
    hadrachot: [], today: TODAY,
  });
  assert.equal(out.assignments.length, 1);
  assert.equal(out.assignments[0].supervisorId, 's2');
  assert.equal(out.assignments[0].quarter, Q);
});

test('falls back to an off-house supervisor when the same-house one is at capacity', () => {
  const existing = [{ guideName: 'x1', house: 'ramot', supervisorId: 's2', quarter: Q, status: 'planned' }];
  const out = L.scheduleQuarter({
    guides: [g('דנה', 'ramot')],
    supervisors: [
      sup('s1', 'אורית', ['asher'], 10),
      sup('s2', 'נועם', ['ramot'], 1), // full
    ],
    hadrachot: existing, today: TODAY,
  });
  assert.equal(out.assignments[0].supervisorId, 's1');
});

test('balances load by ratio of assigned to quarterly max', () => {
  // s1 max 10 with 4 existing (40%), s2 max 4 with 1 existing (25%) —
  // both cover the house; s2 is proportionally less loaded and must win.
  const existing = [
    { guideName: 'a', house: 'ramot', supervisorId: 's1', quarter: Q, status: 'planned' },
    { guideName: 'b', house: 'ramot', supervisorId: 's1', quarter: Q, status: 'planned' },
    { guideName: 'c', house: 'ramot', supervisorId: 's1', quarter: Q, status: 'done', completedDate: '2026-07-10' },
    { guideName: 'd', house: 'ramot', supervisorId: 's1', quarter: Q, status: 'planned' },
    { guideName: 'e', house: 'ramot', supervisorId: 's2', quarter: Q, status: 'planned' },
  ];
  const out = L.scheduleQuarter({
    guides: [g('דנה', 'ramot')],
    supervisors: [sup('s1', 'אורית', ['ramot'], 10), sup('s2', 'נועם', ['ramot'], 4)],
    hadrachot: existing, today: TODAY,
  });
  assert.equal(out.assignments[0].supervisorId, 's2');
});

test('cancelled rows do not count toward supervisor load', () => {
  const existing = [
    { guideName: 'a', house: 'ramot', supervisorId: 's1', quarter: Q, status: 'cancelled' },
  ];
  const out = L.scheduleQuarter({
    guides: [g('דנה', 'ramot')],
    supervisors: [sup('s1', 'אורית', ['ramot'], 1)],
    hadrachot: existing, today: TODAY,
  });
  assert.equal(out.assignments[0].supervisorId, 's1'); // capacity 1 still free
});

test('when every supervisor is at capacity the guide lands in unassigned', () => {
  const existing = [{ guideName: 'a', house: 'ramot', supervisorId: 's1', quarter: Q, status: 'planned' }];
  const out = L.scheduleQuarter({
    guides: [g('דנה', 'ramot')],
    supervisors: [sup('s1', 'אורית', ['ramot'], 1)],
    hadrachot: existing, today: TODAY,
  });
  assert.equal(out.assignments.length, 0);
  assert.deepEqual(out.unassigned, [{ guideName: 'דנה', house: 'ramot' }]);
});

test('skips guides who already have a live hadracha this quarter', () => {
  const existing = [
    { guideName: 'דנה', house: 'ramot', supervisorId: 's1', quarter: Q, status: 'planned' },
    { guideName: 'יואב', house: 'ramot', supervisorId: 's1', quarter: Q, status: 'done', completedDate: '2026-07-10' },
    { guideName: 'רות', house: 'ramot', supervisorId: 's1', quarter: Q, status: 'cancelled' },
  ];
  const out = L.scheduleQuarter({
    guides: [g('דנה', 'ramot'), g('יואב', 'ramot'), g('רות', 'ramot')],
    supervisors: [sup('s1', 'אורית', ['ramot'], 10)],
    hadrachot: existing, today: TODAY,
  });
  // Only רות (cancelled row = nothing) needs an assignment.
  assert.deepEqual(out.assignments.map(a => a.guideName), ['רות']);
});

test('a hadracha from another quarter does not block this quarter', () => {
  const existing = [
    { guideName: 'דנה', house: 'ramot', supervisorId: 's1', quarter: '2026-Q2', status: 'done', completedDate: '2026-05-10' },
  ];
  const out = L.scheduleQuarter({
    guides: [g('דנה', 'ramot')],
    supervisors: [sup('s1', 'אורית', ['ramot'], 10)],
    hadrachot: existing, today: TODAY,
  });
  assert.equal(out.assignments.length, 1);
});

test('inactive guides and inactive supervisors are excluded', () => {
  const out = L.scheduleQuarter({
    guides: [g('דנה', 'ramot', '2025-01-01', false), g('יואב', 'ramot')],
    supervisors: [
      sup('s1', 'אורית', ['ramot'], 10, false),
      sup('s2', 'נועם', ['asher'], 10),
    ],
    hadrachot: [], today: TODAY,
  });
  assert.equal(out.assignments.length, 1);
  assert.equal(out.assignments[0].guideName, 'יואב');
  assert.equal(out.assignments[0].supervisorId, 's2'); // s1 inactive despite same house
});

test('new guides are scheduled first, immediately, with the deadline attached', () => {
  const out = L.scheduleQuarter({
    guides: [g('ותיקה', 'ramot', '2024-01-01'), g('חדשה', 'ramot', '2026-08-16')],
    supervisors: [sup('s1', 'אורית', ['ramot'], 10)],
    hadrachot: [], today: TODAY,
  });
  assert.equal(out.assignments[0].guideName, 'חדשה');
  assert.equal(out.assignments[0].isNew, true);
  assert.equal(out.assignments[0].scheduledDate, TODAY);
  assert.equal(out.assignments[0].deadline, '2026-08-23');
  assert.equal(out.assignments[1].isNew, false);
  assert.equal(out.assignments[1].deadline, '');
});

test('regular guides are spread a week apart per supervisor, capped at quarter end', () => {
  const guides = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז'].map(n => g('מדריך ' + n, 'ramot'));
  const out = L.scheduleQuarter({
    guides,
    supervisors: [sup('s1', 'אורית', ['ramot'], 100)],
    hadrachot: [], today: '2026-08-19',
  });
  const dates = out.assignments.map(a => a.scheduledDate);
  assert.equal(dates[0], '2026-08-19');
  assert.equal(dates[1], '2026-08-26');
  assert.equal(dates[2], '2026-09-02');
  // 2026-Q3 ends 09-30 — the tail never spills past it.
  assert.ok(dates.every(d => d <= '2026-09-30'));
  assert.equal(dates[dates.length - 1], '2026-09-30');
});

test('a guide placed at two houses gets exactly one assignment', () => {
  const out = L.scheduleQuarter({
    guides: [g('דנה', 'ramot'), g('דנה', 'asher')],
    supervisors: [sup('s1', 'אורית', ['ramot', 'asher'], 10)],
    hadrachot: [], today: TODAY,
  });
  assert.equal(out.assignments.length, 1);
  assert.equal(out.assignments[0].house, 'ramot'); // first entry wins
});

test('supervisorCovers accepts both array and comma-string houses', () => {
  assert.equal(L.supervisorCovers({ houses: ['ramot', 'hq'] }, 'hq'), true);
  assert.equal(L.supervisorCovers({ houses: 'ramot, hq' }, 'hq'), true);
  assert.equal(L.supervisorCovers({ houses: 'ramot' }, 'hq'), false);
  assert.equal(L.supervisorCovers({ houses: '' }, 'hq'), false);
});

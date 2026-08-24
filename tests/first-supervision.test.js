'use strict';
// The 30-day first-supervision rule: EVERY role must complete a first
// supervision within 30 days of start_date. Exactly 30 days is NOT overdue —
// strict "exceeds". This rule replaced the old 7-day new-guide rule.

const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lib/scheduler');

function person(role, startDate) {
  return { name: 'יואב כהן', house: 'asher', role, active: true, startDate };
}

test('firstSupervisionDeadline: start_date plus exactly 30 days', () => {
  assert.equal(L.firstSupervisionDeadline('2026-08-10'), '2026-09-09');
  assert.equal(L.firstSupervisionDeadline('2026-12-15'), '2027-01-14'); // year roll
  assert.equal(L.firstSupervisionDeadline(''), '');
  assert.equal(L.firstSupervisionDeadline('bad-date'), '');
});

test('isFirstMonth: true through day 30, false from day 31 and before start', () => {
  assert.equal(L.isFirstMonth('2026-08-10', '2026-08-10'), true);  // day 0
  assert.equal(L.isFirstMonth('2026-08-10', '2026-09-09'), true);  // day 30
  assert.equal(L.isFirstMonth('2026-08-10', '2026-09-10'), false); // day 31
  assert.equal(L.isFirstMonth('2026-08-10', '2026-08-09'), false); // before start
  assert.equal(L.isFirstMonth('', '2026-08-10'), false);           // no start date
});

test('boundary: day 30 exactly is NOT overdue — every role', () => {
  L.ROLES.forEach(role => {
    const st = L.personStatus(person(role, '2026-08-10'), [], '2026-09-09');
    assert.equal(st.nextDue, '2026-09-09', role);
    assert.equal(st.overdue, false, role);
    assert.equal(st.daysOverdue, 0, role);
  });
});

test('boundary: day 31 IS overdue — every role', () => {
  L.ROLES.forEach(role => {
    const st = L.personStatus(person(role, '2026-08-10'), [], '2026-09-10');
    assert.equal(st.overdue, true, role);
    assert.equal(st.daysOverdue, 1, role);
  });
});

test('a completed first supervision clears the deadline and starts the cadence', () => {
  const sessions = [{
    guideName: 'יואב כהן', house: 'asher', supervisorId: 's1', quarter: '2026-Q3',
    scheduledDate: '2026-08-20', completedDate: '2026-08-20', status: 'done',
    type: 'individual', cluster: '', attendance: [],
  }];
  const st = L.personStatus(person('social_worker', '2026-08-10'), sessions, '2026-09-20');
  assert.equal(st.deadline, '');                // no longer on the 30-day rule
  assert.equal(st.nextDue, '2026-09-03');       // 14 days after completion
  assert.equal(st.overdue, true);               // …and that has since passed
});

test('a group session ATTENDED clears the 30-day rule for a clustered guide', () => {
  const sessions = [{
    guideName: '', house: '', supervisorId: 's1', quarter: '2026-Q3',
    scheduledDate: '2026-08-20', completedDate: '2026-08-20', status: 'done',
    type: 'group', cluster: 'raanana', attendance: ['יואב כהן'],
  }];
  const st = L.personStatus(person('guide', '2026-08-10'), sessions, '2026-09-01');
  assert.equal(st.lastDone, '2026-08-20');
  assert.equal(st.overdue, false);
});

test('a planned-but-not-completed session does NOT clear the 30-day rule', () => {
  const sessions = [{
    guideName: 'יואב כהן', house: 'asher', supervisorId: 's1', quarter: '2026-Q3',
    scheduledDate: '2026-09-15', completedDate: '', status: 'planned',
    type: 'individual', cluster: '', attendance: [],
  }];
  const st = L.personStatus(person('coordinator', '2026-08-10'), sessions, '2026-09-12');
  assert.equal(st.overdue, true);
  assert.ok(st.planned); // …but the planned row is surfaced
});

test('a cancelled session counts as nothing', () => {
  const sessions = [{
    guideName: 'יואב כהן', house: 'asher', supervisorId: 's1', quarter: '2026-Q3',
    scheduledDate: '2026-08-12', completedDate: '2026-08-12', status: 'cancelled',
    type: 'individual', cluster: '', attendance: [],
  }];
  const st = L.personStatus(person('house_manager', '2026-08-10'), sessions, '2026-09-12');
  assert.equal(st.lastDone, '');
  assert.equal(st.overdue, true);
});

test('person with no start date and no history is never judged — no invented deadline', () => {
  const st = L.personStatus(person('social_worker', ''), [], '2026-08-18');
  assert.equal(st.nextDue, '');
  assert.equal(st.overdue, false);
  assert.equal(st.firstMonth, false);
});

test('names are matched with normalized whitespace', () => {
  const sessions = [{
    guideName: '  יואב   כהן ', house: 'asher', supervisorId: 's1', quarter: '2026-Q3',
    scheduledDate: '2026-08-12', completedDate: '2026-08-12', status: 'done',
    type: 'individual', cluster: '', attendance: [],
  }];
  const st = L.personStatus(person('social_worker', '2026-08-10'), sessions, '2026-09-25');
  assert.equal(st.lastDone, '2026-08-12');
});

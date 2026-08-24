'use strict';
// Per-role cadence math in lib/scheduler.js — the foundation every
// compliance decision stands on, so the boundaries are pinned exactly.
//   guide          every 14 days, group sessions per cluster
//   social_worker  every 14 days, individual
//   house_manager  every  7 days, individual
//   coordinator    every 14 days, individual
// Refreshers: every 3 calendar months per guide, a separate track.

const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lib/scheduler');

test('the cadence table is exactly the agreed per-role model', () => {
  assert.deepEqual(L.ROLES, ['guide', 'social_worker', 'house_manager', 'coordinator']);
  assert.deepEqual(L.ROLE_CADENCE_DAYS, {
    guide: 14, social_worker: 14, house_manager: 7, coordinator: 14,
  });
  assert.equal(L.FIRST_SUPERVISION_GRACE_DAYS, 30);
  assert.equal(L.REFRESHER_INTERVAL_MONTHS, 3);
});

test('normalizeRole: feed roles pass through, anything else reads as guide', () => {
  assert.equal(L.normalizeRole('social_worker'), 'social_worker');
  assert.equal(L.normalizeRole('house_manager'), 'house_manager');
  assert.equal(L.normalizeRole(' coordinator '), 'coordinator');
  assert.equal(L.normalizeRole(''), 'guide');
  assert.equal(L.normalizeRole(undefined), 'guide');
  assert.equal(L.normalizeRole('roleDetail-never-appears'), 'guide');
});

test('addDays: crosses month and year boundaries', () => {
  assert.equal(L.addDays('2026-08-10', 14), '2026-08-24');
  assert.equal(L.addDays('2026-08-28', 7), '2026-09-04');
  assert.equal(L.addDays('2026-12-28', 7), '2027-01-04');
  assert.equal(L.addDays('2024-02-26', 4), '2024-03-01'); // leap year
  assert.equal(L.addDays('2026-02-26', 4), '2026-03-02'); // non-leap
  assert.equal(L.addDays('', 7), '');
});

test('addMonths: calendar months with day-of-month clamping', () => {
  assert.equal(L.addMonths('2026-05-15', 3), '2026-08-15');
  assert.equal(L.addMonths('2026-11-30', 3), '2027-02-28'); // clamp + year roll
  assert.equal(L.addMonths('2023-11-30', 3), '2024-02-29'); // leap February
  assert.equal(L.addMonths('2026-01-31', 3), '2026-04-30'); // 30-day month clamp
  assert.equal(L.addMonths('bad', 3), '');
  assert.equal(L.addMonths('', 3), '');
});

test('daysBetween: whole days, null on malformed input', () => {
  assert.equal(L.daysBetween('2026-08-10', '2026-08-24'), 14);
  assert.equal(L.daysBetween('2026-08-24', '2026-08-10'), -14);
  assert.equal(L.daysBetween('2026-08-10', '2026-08-10'), 0);
  assert.equal(L.daysBetween('', '2026-08-10'), null);
  assert.equal(L.daysBetween('2026-08-10', 'oops'), null);
});

// ---- per-role next-due math driven through personStatus ----

function person(role, house, startDate) {
  return { name: 'דנה לוי', house, role, active: true, startDate: startDate || '2025-01-01' };
}

function doneIndividual(date) {
  return {
    guideName: 'דנה לוי', house: 'hq', supervisorId: 's1', quarter: L.quarterOf(date),
    scheduledDate: date, completedDate: date, status: 'done', type: 'individual',
    cluster: '', attendance: [],
  };
}

test('social_worker: due 14 days after the last completed supervision', () => {
  const st = L.personStatus(person('social_worker', 'hq'), [doneIndividual('2026-08-01')], '2026-08-10');
  assert.equal(st.cadenceDays, 14);
  assert.equal(st.sessionType, 'individual');
  assert.equal(st.lastDone, '2026-08-01');
  assert.equal(st.nextDue, '2026-08-15');
  assert.equal(st.overdue, false);
});

test('cadence boundary: due day exactly is NOT overdue, the day after IS', () => {
  const sessions = [doneIndividual('2026-08-01')];
  const onDue = L.personStatus(person('social_worker', 'hq'), sessions, '2026-08-15');
  assert.equal(onDue.overdue, false);
  assert.equal(onDue.daysOverdue, 0);
  const past = L.personStatus(person('social_worker', 'hq'), sessions, '2026-08-16');
  assert.equal(past.overdue, true);
  assert.equal(past.daysOverdue, 1);
});

test('house_manager: 7-day cadence', () => {
  const sessions = [doneIndividual('2026-08-01')];
  const st = L.personStatus(person('house_manager', 'hq'), sessions, '2026-08-08');
  assert.equal(st.cadenceDays, 7);
  assert.equal(st.nextDue, '2026-08-08');
  assert.equal(st.overdue, false);
  const late = L.personStatus(person('house_manager', 'hq'), sessions, '2026-08-12');
  assert.equal(late.overdue, true);
  assert.equal(late.daysOverdue, 4);
});

test('coordinator: 14-day cadence', () => {
  const st = L.personStatus(person('coordinator', 'hq'), [doneIndividual('2026-08-01')], '2026-08-20');
  assert.equal(st.cadenceDays, 14);
  assert.equal(st.nextDue, '2026-08-15');
  assert.equal(st.daysOverdue, 5);
});

test('the LATEST completed session drives the cadence, not the earliest', () => {
  const sessions = [doneIndividual('2026-06-01'), doneIndividual('2026-08-01')];
  const st = L.personStatus(person('social_worker', 'hq'), sessions, '2026-08-10');
  assert.equal(st.lastDone, '2026-08-01');
  assert.equal(st.nextDue, '2026-08-15');
});

test('cancelled sessions never count toward the cadence', () => {
  const cancelled = Object.assign(doneIndividual('2026-08-01'), { status: 'cancelled' });
  const st = L.personStatus(person('social_worker', 'hq', '2026-05-01'), [cancelled], '2026-08-10');
  assert.equal(st.lastDone, '');
  // Falls back to the 30-day first-supervision deadline — long past.
  assert.equal(st.nextDue, '2026-05-31');
  assert.equal(st.overdue, true);
});

// ---- clusters ----

test('house clusters: kesaria = ofroni + rehab, raanana = asher + pardes + ramot', () => {
  assert.deepEqual(L.CLUSTER_IDS, ['kesaria', 'raanana']);
  assert.equal(L.clusterOfHouse('ofroni'), 'kesaria');
  assert.equal(L.clusterOfHouse('rehab'), 'kesaria');
  assert.equal(L.clusterOfHouse('asher'), 'raanana');
  assert.equal(L.clusterOfHouse('pardes'), 'raanana');
  assert.equal(L.clusterOfHouse('ramot'), 'raanana');
  // Houses outside every cluster have no group track.
  assert.equal(L.clusterOfHouse('sde_eliezer'), '');
  assert.equal(L.clusterOfHouse('hq'), '');
  assert.equal(L.clusterOfHouse(''), '');
  assert.deepEqual(L.clusterHouses('kesaria'), ['ofroni', 'rehab']);
  assert.deepEqual(L.clusterHouses('raanana'), ['asher', 'pardes', 'ramot']);
});

test('a clustered guide is on the group track, an unclustered guide is individual', () => {
  const clustered = L.personStatus(person('guide', 'ofroni'), [], '2026-08-10');
  assert.equal(clustered.cluster, 'kesaria');
  assert.equal(clustered.sessionType, 'group');
  const unclustered = L.personStatus(person('guide', 'sde_eliezer'), [], '2026-08-10');
  assert.equal(unclustered.cluster, '');
  assert.equal(unclustered.sessionType, 'individual');
  const socialWorker = L.personStatus(person('social_worker', 'ofroni'), [], '2026-08-10');
  assert.equal(socialWorker.cluster, '');
});

// ---- group attendance drives guide coverage ----

function groupDone(cluster, date, attendance) {
  return {
    guideName: '', house: '', supervisorId: 's1', quarter: L.quarterOf(date),
    scheduledDate: date, completedDate: date, status: 'done', type: 'group',
    cluster, attendance,
  };
}

test('a guide who ATTENDED a completed group session is covered for 14 days', () => {
  const sessions = [groupDone('kesaria', '2026-08-01', ['דנה לוי', 'יואב כהן'])];
  const st = L.personStatus(person('guide', 'ofroni'), sessions, '2026-08-10');
  assert.equal(st.lastDone, '2026-08-01');
  assert.equal(st.nextDue, '2026-08-15');
  assert.equal(st.overdue, false);
});

test('a guide NOT on the attendance list is not covered by the group session', () => {
  const sessions = [groupDone('kesaria', '2026-08-01', ['יואב כהן'])];
  const st = L.personStatus(person('guide', 'ofroni', '2026-05-01'), sessions, '2026-08-10');
  assert.equal(st.lastDone, '');
  assert.equal(st.overdue, true); // 30-day deadline long past
});

test('attendance accepts both arrays and the comma-separated sheet string', () => {
  assert.deepEqual(L.attendanceList({ attendance: ['דנה לוי', ' יואב  כהן '] }),
    ['דנה לוי', 'יואב כהן']);
  assert.deepEqual(L.attendanceList({ attendance: 'דנה לוי, יואב כהן' }),
    ['דנה לוי', 'יואב כהן']);
  assert.deepEqual(L.attendanceList({ attendance: '' }), []);
  assert.deepEqual(L.attendanceList({}), []);
});

test('legacy rows with no type field read as individual sessions', () => {
  const legacy = {
    guideName: 'דנה לוי', house: 'ramot', supervisorId: 's1', quarter: '2026-Q3',
    scheduledDate: '2026-08-01', completedDate: '2026-08-01', status: 'done',
  };
  assert.equal(L.sessionTypeOf(legacy), 'individual');
  const st = L.personStatus(person('social_worker', 'hq'), [legacy], '2026-08-10');
  assert.equal(st.lastDone, '2026-08-01');
});

// ---- refreshers — every 3 months per guide, a separate track ----

function refresherDone(date) {
  return {
    guideName: 'דנה לוי', house: 'ofroni', supervisorId: 's9', quarter: L.quarterOf(date),
    scheduledDate: date, completedDate: date, status: 'done', type: 'refresher',
    cluster: '', attendance: [],
  };
}

test('refresher due 3 months after the last completed refresher', () => {
  const sessions = [refresherDone('2026-05-10')];
  const st = L.personStatus(person('guide', 'ofroni'), sessions, '2026-08-01');
  assert.equal(st.nextRefresherDue, '2026-08-10');
  assert.equal(st.refresherOverdue, false);
  const late = L.personStatus(person('guide', 'ofroni'), sessions, '2026-08-11');
  assert.equal(late.refresherOverdue, true);
});

test('no refresher yet: first one is due 3 months after start_date', () => {
  const st = L.personStatus(person('guide', 'ofroni', '2026-06-01'), [], '2026-08-10');
  assert.equal(st.nextRefresherDue, '2026-09-01');
  assert.equal(st.refresherOverdue, false);
});

test('a refresher does NOT satisfy the regular 14-day cadence, nor the reverse', () => {
  const st = L.personStatus(person('guide', 'ofroni', '2026-05-01'),
    [refresherDone('2026-08-01')], '2026-08-10');
  assert.equal(st.lastDone, '');   // regular track untouched by the refresher
  assert.equal(st.overdue, true);  // 30-day first-supervision deadline passed

  const st2 = L.personStatus(person('guide', 'ofroni', '2026-05-01'),
    [groupDone('kesaria', '2026-08-01', ['דנה לוי'])], '2026-08-10');
  assert.equal(st2.nextRefresherDue, '2026-08-01'); // start + 3 months, unaffected
});

test('non-guide roles have no refresher track', () => {
  const st = L.personStatus(person('house_manager', 'hq'), [], '2026-08-10');
  assert.equal(st.nextRefresherDue, '');
  assert.equal(st.refresherOverdue, false);
  assert.equal(st.plannedRefresher, null);
});

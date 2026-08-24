'use strict';
// The auto-scheduler behind שבץ: per-role generation — one group session per
// cluster per 14 days for guides, individual sessions per person per their
// cadence for every other role, refreshers when due — respecting existing
// completed sessions, capability flags, and supervisor capacity.

const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lib/scheduler');

const TODAY = '2026-08-19';

function sup(id, name, houses, max, opts) {
  return Object.assign({
    id, name, houses, maxPerQuarter: max, active: true,
    deliversGroup: true, deliversIndividual: true, deliversRefresher: false,
    roles: L.ROLES.slice(),
  }, opts || {});
}
function p(name, role, house, startDate, active) {
  return { name, role, house, startDate: startDate || '2025-01-01', active: active !== false };
}
function doneIndividual(name, house, date) {
  return {
    guideName: name, house, supervisorId: 's1', quarter: L.quarterOf(date),
    scheduledDate: date, completedDate: date, status: 'done', type: 'individual',
    cluster: '', attendance: [],
  };
}
function doneGroup(cluster, date, attendance) {
  return {
    guideName: '', house: '', supervisorId: 's1', quarter: L.quarterOf(date),
    scheduledDate: date, completedDate: date, status: 'done', type: 'group',
    cluster, attendance,
  };
}
function run(people, supervisors, sessions) {
  return L.scheduleSessions({ people, supervisors, sessions: sessions || [], today: TODAY });
}

// ---- group sessions per cluster ----

test('creates ONE group session per cluster covering all its active guides', () => {
  const out = run(
    [p('א', 'guide', 'ofroni'), p('ב', 'guide', 'rehab'),
     p('ג', 'guide', 'asher'), p('ד', 'guide', 'pardes'), p('ה', 'guide', 'ramot')],
    [sup('s1', 'אורית', ['ofroni', 'rehab', 'asher', 'pardes', 'ramot'], 100)]);
  const groups = out.assignments.filter(a => a.type === 'group');
  assert.equal(groups.length, 2);
  const kesaria = groups.find(g => g.cluster === 'kesaria');
  const raanana = groups.find(g => g.cluster === 'raanana');
  assert.deepEqual(kesaria.guideNames.sort(), ['א', 'ב']);
  assert.deepEqual(raanana.guideNames.sort(), ['ג', 'ד', 'ה']);
  // A group row carries a cluster, never a single guide or house.
  assert.equal(kesaria.guideName, '');
  assert.equal(kesaria.house, '');
  assert.equal(kesaria.supervisorId, 's1');
});

test('a cluster with a live planned group session is skipped, not duplicated', () => {
  const planned = {
    guideName: '', house: '', supervisorId: 's1', quarter: '2026-Q3',
    scheduledDate: '2026-08-25', completedDate: '', status: 'planned',
    type: 'group', cluster: 'kesaria', attendance: [],
  };
  const out = run([p('א', 'guide', 'ofroni')], [sup('s1', 'אורית', ['ofroni'], 100)], [planned]);
  assert.equal(out.assignments.filter(a => a.type === 'group').length, 0);
});

test('group due date respects the last completed group session — 14 days later', () => {
  const sessions = [doneGroup('kesaria', '2026-08-10', ['א', 'ב'])];
  const out = run(
    [p('א', 'guide', 'ofroni'), p('ב', 'guide', 'rehab')],
    [sup('s1', 'אורית', ['ofroni'], 100)], sessions);
  const g = out.assignments.find(a => a.type === 'group');
  assert.equal(g.scheduledDate, '2026-08-24'); // 2026-08-10 + 14
});

test('an overdue cluster is scheduled TODAY, never in the past', () => {
  const sessions = [doneGroup('kesaria', '2026-07-01', ['א'])];
  const out = run([p('א', 'guide', 'ofroni')], [sup('s1', 'אורית', ['ofroni'], 100)], sessions);
  const g = out.assignments.find(a => a.type === 'group');
  assert.equal(g.scheduledDate, TODAY);
});

test('the MOST URGENT member drives the cluster date — an uncovered guide pulls it to today', () => {
  // א was covered 5 days ago; ב has never been supervised and started long
  // ago — the cluster session must not wait for א's 14 days.
  const sessions = [doneGroup('kesaria', '2026-08-14', ['א'])];
  const out = run(
    [p('א', 'guide', 'ofroni'), p('ב', 'guide', 'rehab', '2026-01-01')],
    [sup('s1', 'אורית', ['ofroni'], 100)], sessions);
  const g = out.assignments.find(a => a.type === 'group');
  assert.equal(g.scheduledDate, TODAY);
});

test('a group session needs a supervisor who DELIVERS GROUP sessions', () => {
  const out = run(
    [p('א', 'guide', 'ofroni')],
    [sup('s1', 'אורית', ['ofroni'], 100, { deliversGroup: false })]);
  assert.equal(out.assignments.filter(a => a.type === 'group').length, 0);
  assert.deepEqual(out.unassigned.filter(u => u.type === 'group'),
    [{ type: 'group', cluster: 'kesaria', guideName: '', role: 'guide', house: '' }]);
});

// ---- individual sessions per role cadence ----

test('non-guide roles get individual sessions at their cadence date', () => {
  const sessions = [
    doneIndividual('עדי', 'hq', '2026-08-10'),   // social worker, due +14 = 08-24
    doneIndividual('נעם', 'ramot', '2026-08-15'), // house manager, due +7 = 08-22
  ];
  const out = run(
    [p('עדי', 'social_worker', 'hq'), p('נעם', 'house_manager', 'ramot')],
    [sup('s1', 'אורית', ['hq', 'ramot'], 100)], sessions);
  const byName = {};
  out.assignments.forEach(a => { byName[a.guideName] = a; });
  assert.equal(byName['עדי'].type, 'individual');
  assert.equal(byName['עדי'].scheduledDate, '2026-08-24');
  assert.equal(byName['נעם'].scheduledDate, '2026-08-22');
});

test('a person never supervised is scheduled TODAY with the 30-day deadline attached', () => {
  const out = run(
    [p('עדי', 'social_worker', 'hq', '2026-08-16')],
    [sup('s1', 'אורית', ['hq'], 100)]);
  assert.equal(out.assignments.length, 1);
  assert.equal(out.assignments[0].scheduledDate, TODAY);
  assert.equal(out.assignments[0].deadline, '2026-09-15'); // start + 30
});

test('a person with a live planned individual session is skipped', () => {
  const planned = {
    guideName: 'עדי', house: 'hq', supervisorId: 's1', quarter: '2026-Q3',
    scheduledDate: '2026-08-25', completedDate: '', status: 'planned',
    type: 'individual', cluster: '', attendance: [],
  };
  const out = run([p('עדי', 'social_worker', 'hq')], [sup('s1', 'אורית', ['hq'], 100)], [planned]);
  assert.equal(out.assignments.length, 0);
});

test('guides OUTSIDE every cluster are supervised individually on the 14-day cadence', () => {
  const sessions = [doneIndividual('שי', 'sde_eliezer', '2026-08-10')];
  const out = run([p('שי', 'guide', 'sde_eliezer')], [sup('s1', 'אורית', ['sde_eliezer'], 100)], sessions);
  const a = out.assignments.find(x => x.guideName === 'שי' && x.type === 'individual');
  assert.ok(a);
  assert.equal(a.scheduledDate, '2026-08-24');
  assert.equal(out.assignments.filter(x => x.type === 'group').length, 0);
});

test('individual sessions need a supervisor covering the ROLE', () => {
  const out = run(
    [p('עדי', 'social_worker', 'hq')],
    [sup('s1', 'אורית', ['hq'], 100, { roles: ['guide'] })]);
  assert.equal(out.assignments.length, 0);
  assert.equal(out.unassigned[0].guideName, 'עדי');
  assert.equal(out.unassigned[0].role, 'social_worker');
});

test('individual sessions need a supervisor who DELIVERS INDIVIDUAL supervisions', () => {
  const out = run(
    [p('עדי', 'coordinator', 'hq')],
    [sup('s1', 'אורית', ['hq'], 100, { deliversIndividual: false })]);
  assert.equal(out.assignments.length, 0);
  assert.equal(out.unassigned[0].type, 'individual');
});

test('same-house supervisors are preferred for individual sessions', () => {
  const out = run(
    [p('עדי', 'social_worker', 'ramot')],
    [sup('s1', 'אורית', ['hq'], 100), sup('s2', 'נועם', ['ramot'], 100)]);
  assert.equal(out.assignments[0].supervisorId, 's2');
});

test('load balances by ratio of assigned to quarterly max', () => {
  const existing = [
    { guideName: 'x1', house: 'hq', supervisorId: 's1', quarter: '2026-Q3', status: 'planned', type: 'individual', cluster: '', attendance: [] },
    { guideName: 'x2', house: 'hq', supervisorId: 's1', quarter: '2026-Q3', status: 'planned', type: 'individual', cluster: '', attendance: [] },
  ];
  // s1: 2/10 = 20%; s2: 0/4 = 0% — s2 wins despite the lower max.
  const out = run(
    [p('עדי', 'social_worker', 'hq')],
    [sup('s1', 'אורית', ['hq'], 10), sup('s2', 'נועם', ['hq'], 4)], existing);
  assert.equal(out.assignments[0].supervisorId, 's2');
});

test('when every capable supervisor is at capacity the person lands in unassigned', () => {
  const existing = [
    { guideName: 'x1', house: 'hq', supervisorId: 's1', quarter: '2026-Q3', status: 'planned', type: 'individual', cluster: '', attendance: [] },
  ];
  const out = run([p('עדי', 'social_worker', 'hq')], [sup('s1', 'אורית', ['hq'], 1)], existing);
  assert.equal(out.assignments.length, 0);
  assert.equal(out.unassigned[0].guideName, 'עדי');
});

test('inactive people and inactive supervisors are excluded', () => {
  const out = run(
    [p('עדי', 'social_worker', 'hq', '2025-01-01', false), p('גיל', 'coordinator', 'hq')],
    [sup('s1', 'אורית', ['hq'], 100, { active: false }), sup('s2', 'נועם', ['asher'], 100)]);
  assert.equal(out.assignments.length, 1);
  assert.equal(out.assignments[0].guideName, 'גיל');
  assert.equal(out.assignments[0].supervisorId, 's2'); // s1 inactive despite same house
});

test('a duplicate feed entry for the same person+role yields one session only', () => {
  const out = run(
    [p('עדי', 'social_worker', 'hq'), p('עדי', 'social_worker', 'ramot')],
    [sup('s1', 'אורית', ['hq'], 100)]);
  assert.equal(out.assignments.length, 1);
  assert.equal(out.assignments[0].house, 'hq'); // first entry wins
});

test('most urgent individuals are scheduled first — a stable, testable order', () => {
  const sessions = [
    doneIndividual('רגועה', 'hq', '2026-08-18'), // due 09-01
    doneIndividual('דחופה', 'hq', '2026-07-01'), // due 07-15, long overdue
  ];
  const out = run(
    [p('רגועה', 'social_worker', 'hq'), p('דחופה', 'social_worker', 'hq')],
    [sup('s1', 'אורית', ['hq'], 100)], sessions);
  assert.deepEqual(out.assignments.map(a => a.guideName), ['דחופה', 'רגועה']);
});

// ---- refreshers — רענון ----

test('a refresher due within 14 days is scheduled with a refresher-capable supervisor', () => {
  const olga = sup('s9', 'אולגה', ['ofroni'], 100,
    { deliversGroup: false, deliversIndividual: false, deliversRefresher: true, roles: ['guide'] });
  const sessions = [
    doneGroup('kesaria', '2026-08-14', ['א']), // regular track covered
    { guideName: 'א', house: 'ofroni', supervisorId: 's9', quarter: '2026-Q2',
      scheduledDate: '2026-05-25', completedDate: '2026-05-25', status: 'done',
      type: 'refresher', cluster: '', attendance: [] },
  ];
  const out = run([p('א', 'guide', 'ofroni')],
    [sup('s1', 'אורית', ['ofroni'], 100), olga], sessions);
  const ref = out.assignments.find(a => a.type === 'refresher');
  assert.ok(ref);
  assert.equal(ref.guideName, 'א');
  assert.equal(ref.scheduledDate, '2026-08-25'); // 2026-05-25 + 3 months
  assert.equal(ref.supervisorId, 's9');          // אולגה — refreshers only
});

test('a refresher-only supervisor never receives group or regular individual sessions', () => {
  const olga = sup('s9', 'אולגה', ['ofroni', 'hq'], 100,
    { deliversGroup: false, deliversIndividual: false, deliversRefresher: true, roles: ['guide'] });
  const out = run(
    [p('א', 'guide', 'ofroni', '2026-08-01'), p('עדי', 'social_worker', 'hq', '2026-08-01')],
    [olga]);
  assert.equal(out.assignments.length, 0);
  assert.equal(out.unassigned.length, 2); // both tracks blocked — never silently dropped
});

test('a refresher due beyond the 14-day horizon is left for a later run', () => {
  const olga = sup('s9', 'אולגה', ['ofroni'], 100,
    { deliversGroup: false, deliversIndividual: false, deliversRefresher: true, roles: ['guide'] });
  // Started 2026-08-01 → first refresher due 2026-11-01, far beyond horizon.
  const out = run([p('א', 'guide', 'ofroni', '2026-08-01')],
    [sup('s1', 'אורית', ['ofroni'], 100), olga]);
  assert.equal(out.assignments.filter(a => a.type === 'refresher').length, 0);
});

test('a guide with a live planned refresher is not scheduled again', () => {
  const olga = sup('s9', 'אולגה', ['ofroni'], 100,
    { deliversGroup: false, deliversIndividual: false, deliversRefresher: true, roles: ['guide'] });
  const sessions = [
    doneGroup('kesaria', '2026-08-14', ['א']),
    { guideName: 'א', house: 'ofroni', supervisorId: 's9', quarter: '2026-Q3',
      scheduledDate: '2026-08-20', completedDate: '', status: 'planned',
      type: 'refresher', cluster: '', attendance: [] },
  ];
  const out = run([p('א', 'guide', 'ofroni', '2026-01-01')],
    [sup('s1', 'אורית', ['ofroni'], 100), olga], sessions);
  assert.equal(out.assignments.filter(a => a.type === 'refresher').length, 0);
});

// ---- the baseline reset — everyone marked done TODAY ----

function baselineIndividual(name, house, type) {
  return {
    guideName: name, house, supervisorId: '', quarter: L.quarterOf(TODAY),
    scheduledDate: TODAY, completedDate: TODAY, status: 'done',
    type: type || 'individual', cluster: '', attendance: [],
  };
}

test('baseline rows dated today clear overdue and push next-due a full cadence out', () => {
  // Long-overdue people of every individual role, then the baseline lands.
  const people = [
    p('עדי', 'social_worker', 'hq', '2026-01-01'),
    p('נעם', 'house_manager', 'ramot', '2026-01-01'),
    p('גיל', 'coordinator', 'hq', '2026-01-01'),
  ];
  people.forEach(person => {
    const before = L.personStatus(person, [], TODAY);
    assert.equal(before.overdue, true, person.name + ' overdue before baseline');
  });
  const baseline = people.map(person => baselineIndividual(person.name, person.house));
  people.forEach(person => {
    const st = L.personStatus(person, baseline, TODAY);
    assert.equal(st.overdue, false, person.name + ' clean after baseline');
    assert.equal(st.lastDone, TODAY);
    assert.equal(st.nextDue, L.addDays(TODAY, st.cadenceDays));
  });
});

test('the scheduler picks up baseline dates — next sessions land a cadence after today', () => {
  const sessions = [
    baselineIndividual('עדי', 'hq'),
    baselineIndividual('נעם', 'ramot'),
  ];
  const out = run(
    [p('עדי', 'social_worker', 'hq', '2026-01-01'), p('נעם', 'house_manager', 'ramot', '2026-01-01')],
    [sup('s1', 'אורית', ['hq', 'ramot'], 100)], sessions);
  const byName = {};
  out.assignments.forEach(a => { byName[a.guideName] = a; });
  assert.equal(byName['עדי'].scheduledDate, '2026-09-02'); // today + 14
  assert.equal(byName['נעם'].scheduledDate, '2026-08-26'); // today + 7
  assert.equal(byName['עדי'].deadline, ''); // no longer never-supervised
});

test('a baseline GROUP row with attendance resets the whole cluster to today + 14', () => {
  const baselineGroup = {
    guideName: '', house: '', supervisorId: '', quarter: L.quarterOf(TODAY),
    scheduledDate: TODAY, completedDate: TODAY, status: 'done',
    type: 'group', cluster: 'kesaria', attendance: ['א', 'ב'],
  };
  const people = [p('א', 'guide', 'ofroni', '2026-01-01'), p('ב', 'guide', 'rehab', '2026-01-01')];
  people.forEach(person => {
    const st = L.personStatus(person, [baselineGroup], TODAY);
    assert.equal(st.overdue, false, person.name);
    assert.equal(st.nextDue, '2026-09-02');
  });
  const out = run(people, [sup('s1', 'אורית', ['ofroni', 'rehab'], 100)], [baselineGroup]);
  const g = out.assignments.find(a => a.type === 'group');
  assert.equal(g.scheduledDate, '2026-09-02'); // today + 14, not today
});

test('a baseline refresher row resets the refresher track to today + 3 months', () => {
  const sessions = [
    baselineIndividual('א', 'ofroni', 'refresher'),
    { guideName: '', house: '', supervisorId: '', quarter: L.quarterOf(TODAY),
      scheduledDate: TODAY, completedDate: TODAY, status: 'done',
      type: 'group', cluster: 'kesaria', attendance: ['א'] },
  ];
  const st = L.personStatus(p('א', 'guide', 'ofroni', '2026-01-01'), sessions, TODAY);
  assert.equal(st.refresherOverdue, false);
  assert.equal(st.nextRefresherDue, '2026-11-19'); // today + 3 months
  // Far beyond the 14-day horizon — the scheduler creates no refresher now.
  const olga = sup('s9', 'אולגה', ['ofroni'], 100,
    { deliversGroup: false, deliversIndividual: false, deliversRefresher: true, roles: ['guide'] });
  const out = run([p('א', 'guide', 'ofroni', '2026-01-01')],
    [sup('s1', 'אורית', ['ofroni'], 100), olga], sessions);
  assert.equal(out.assignments.filter(a => a.type === 'refresher').length, 0);
});

// ---- supervisor helpers ----

test('supervisorCovers accepts both array and comma-string houses', () => {
  assert.equal(L.supervisorCovers({ houses: ['ramot', 'hq'] }, 'hq'), true);
  assert.equal(L.supervisorCovers({ houses: 'ramot, hq' }, 'hq'), true);
  assert.equal(L.supervisorCovers({ houses: 'ramot' }, 'hq'), false);
  assert.equal(L.supervisorCovers({ houses: '' }, 'hq'), false);
});

test('supervisorRoles: blank means ALL roles — legacy supervisors keep working', () => {
  assert.deepEqual(L.supervisorRoles({ roles: [] }), L.ROLES);
  assert.deepEqual(L.supervisorRoles({ roles: '' }), L.ROLES);
  assert.deepEqual(L.supervisorRoles({}), L.ROLES);
  assert.deepEqual(L.supervisorRoles({ roles: 'guide, coordinator' }), ['guide', 'coordinator']);
  assert.deepEqual(L.supervisorRoles({ roles: ['house_manager'] }), ['house_manager']);
});

test('capability flags: undefined defaults to group+individual true, refresher false', () => {
  assert.equal(L.deliversGroup({}), true);
  assert.equal(L.deliversIndividual({}), true);
  assert.equal(L.deliversRefresher({}), false);
  assert.equal(L.deliversGroup({ deliversGroup: false }), false);
  assert.equal(L.deliversIndividual({ deliversIndividual: false }), false);
  assert.equal(L.deliversRefresher({ deliversRefresher: true }), true);
});

'use strict';
// Input validation for every write endpoint (lib/validate.js) — nothing
// malformed may ever reach the Apps Script backend.

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateAction, HOUSE_IDS, CLUSTER_IDS, ROLES } = require('../lib/validate');

function rejects(body, status) {
  assert.throws(() => validateAction(body), err => {
    if (status) assert.equal(err.status, status);
    return true;
  });
}

test('unknown or missing action is rejected', () => {
  rejects({}, 400);
  rejects({ action: 'dropTables' }, 400);
  rejects(null, 400);
});

// ---- supervisors ----

test('addSupervisor: happy path normalizes, defaults active=true and legacy capabilities', () => {
  const out = validateAction({
    action: 'addSupervisor',
    supervisor: { name: '  אורית   לוי ', houses: ['ramot', 'hq', 'ramot'], maxPerQuarter: 12 },
  });
  assert.equal(out.supervisor.name, 'אורית לוי');
  assert.deepEqual(out.supervisor.houses, ['ramot', 'hq']); // deduped
  assert.equal(out.supervisor.maxPerQuarter, 12);
  assert.equal(out.supervisor.active, true);
  // Legacy payloads without capability fields keep the pre-rework behavior.
  assert.equal(out.supervisor.deliversGroup, true);
  assert.equal(out.supervisor.deliversIndividual, true);
  assert.equal(out.supervisor.deliversRefresher, false);
  assert.deepEqual(out.supervisor.roles, ROLES);
});

test('addSupervisor: capability flags and roles pass through — an Olga refresher-only profile', () => {
  const out = validateAction({
    action: 'addSupervisor',
    supervisor: {
      name: 'אולגה', houses: HOUSE_IDS.slice(), maxPerQuarter: 100,
      deliversGroup: false, deliversIndividual: false, deliversRefresher: true,
      roles: ['guide', 'guide'],
    },
  });
  assert.equal(out.supervisor.deliversGroup, false);
  assert.equal(out.supervisor.deliversIndividual, false);
  assert.equal(out.supervisor.deliversRefresher, true);
  assert.deepEqual(out.supervisor.roles, ['guide']); // deduped
});

test('addSupervisor: rejects unknown house, empty houses, bad max, bad roles, non-bool flags', () => {
  const base = { name: 'א', houses: ['ramot'], maxPerQuarter: 5 };
  rejects({ action: 'addSupervisor', supervisor: { ...base, houses: ['narnia'] } }, 400);
  rejects({ action: 'addSupervisor', supervisor: { ...base, houses: [] } }, 400);
  rejects({ action: 'addSupervisor', supervisor: { ...base, maxPerQuarter: 0 } }, 400);
  rejects({ action: 'addSupervisor', supervisor: { ...base, maxPerQuarter: 501 } }, 400);
  rejects({ action: 'addSupervisor', supervisor: { ...base, maxPerQuarter: 2.5 } }, 400);
  rejects({ action: 'addSupervisor', supervisor: { ...base, name: '' } }, 400);
  rejects({ action: 'addSupervisor', supervisor: { ...base, roles: ['wizard'] } }, 400);
  rejects({ action: 'addSupervisor', supervisor: { ...base, roles: [] } }, 400);
  rejects({ action: 'addSupervisor', supervisor: { ...base, deliversGroup: 'yes' } }, 400);
  rejects({ action: 'addSupervisor', supervisor: { ...base, deliversRefresher: 1 } }, 400);
});

test('updateSupervisor requires id; setSupervisorActive requires a real boolean', () => {
  rejects({ action: 'updateSupervisor', supervisor: { name: 'א', houses: ['ramot'], maxPerQuarter: 5 } }, 400);
  rejects({ action: 'setSupervisorActive', id: 's1', active: 'yes' }, 400);
  const out = validateAction({ action: 'setSupervisorActive', id: 's1', active: false });
  assert.equal(out.active, false);
});

test('all seven houses and both clusters are accepted', () => {
  assert.deepEqual(HOUSE_IDS, ['ramot', 'asher', 'ofroni', 'rehab', 'pardes', 'sde_eliezer', 'hq']);
  assert.deepEqual(CLUSTER_IDS, ['kesaria', 'raanana']);
  const out = validateAction({
    action: 'addSupervisor',
    supervisor: { name: 'א', houses: HOUSE_IDS.slice(), maxPerQuarter: 5 },
  });
  assert.equal(out.supervisor.houses.length, 7);
});

// ---- hadrachot ----

test('addHadracha: status is FORCED to planned — completion cannot be injected', () => {
  const out = validateAction({
    action: 'addHadracha',
    hadracha: {
      guideName: 'דנה לוי', house: 'ramot', supervisorId: 's1',
      quarter: '2026-Q3', scheduledDate: '2026-08-20',
      status: 'done', completedDate: '2026-08-01', // injection attempt
    },
  });
  assert.equal(out.hadracha.status, 'planned');
  assert.equal(out.hadracha.completedDate, undefined);
  // Legacy payloads without a type read as individual sessions.
  assert.equal(out.hadracha.type, 'individual');
  assert.equal(out.hadracha.cluster, '');
});

test('addHadracha: a GROUP session needs a cluster and carries no guide or house', () => {
  const out = validateAction({
    action: 'addHadracha',
    hadracha: {
      type: 'group', cluster: 'kesaria', supervisorId: 's1',
      quarter: '2026-Q3', scheduledDate: '2026-08-20',
      guideName: 'smuggled', house: 'ramot', // ignored — a group row has neither
    },
  });
  assert.equal(out.hadracha.type, 'group');
  assert.equal(out.hadracha.cluster, 'kesaria');
  assert.equal(out.hadracha.guideName, '');
  assert.equal(out.hadracha.house, '');
  rejects({
    action: 'addHadracha',
    hadracha: { type: 'group', quarter: '2026-Q3' }, // no cluster
  }, 400);
  rejects({
    action: 'addHadracha',
    hadracha: { type: 'group', cluster: 'narnia', quarter: '2026-Q3' },
  }, 400);
});

test('addHadracha: a refresher is an individual-shaped row with type refresher', () => {
  const out = validateAction({
    action: 'addHadracha',
    hadracha: {
      type: 'refresher', guideName: 'דנה לוי', house: 'ofroni',
      quarter: '2026-Q3', scheduledDate: '2026-08-25',
    },
  });
  assert.equal(out.hadracha.type, 'refresher');
  assert.equal(out.hadracha.guideName, 'דנה לוי');
  assert.equal(out.hadracha.cluster, '');
});

test('addHadracha: rejects bad type, quarter, house, and date formats', () => {
  const base = { guideName: 'דנה', house: 'ramot', quarter: '2026-Q3' };
  rejects({ action: 'addHadracha', hadracha: { ...base, type: 'party' } }, 400);
  rejects({ action: 'addHadracha', hadracha: { ...base, quarter: '2026-Q5' } }, 400);
  rejects({ action: 'addHadracha', hadracha: { ...base, quarter: 'Q3-2026' } }, 400);
  rejects({ action: 'addHadracha', hadracha: { ...base, house: 'narnia' } }, 400);
  rejects({ action: 'addHadracha', hadracha: { ...base, scheduledDate: '20/08/2026' } }, 400);
  rejects({ action: 'addHadracha', hadracha: { ...base, guideName: '   ' } }, 400);
});

test('addHadrachotBatch: validates every item and rejects duplicates per track', () => {
  const item = name => ({
    guideName: name, house: 'ramot', supervisorId: 's1',
    quarter: '2026-Q3', scheduledDate: '2026-08-20',
  });
  const group = cluster => ({
    type: 'group', cluster, supervisorId: 's1',
    quarter: '2026-Q3', scheduledDate: '2026-08-20',
  });
  const out = validateAction({
    action: 'addHadrachotBatch',
    items: [item('דנה'), group('kesaria'), group('raanana'),
      { ...item('דנה'), type: 'refresher' }], // same person, different track — fine
  });
  assert.equal(out.items.length, 4);
  rejects({ action: 'addHadrachotBatch', items: [] }, 400);
  // Two open sessions for the same person+type, or the same cluster, clash.
  rejects({ action: 'addHadrachotBatch', items: [item('דנה'), item('דנה')] }, 400);
  rejects({ action: 'addHadrachotBatch', items: [group('kesaria'), group('kesaria')] }, 400);
  rejects({
    action: 'addHadrachotBatch',
    items: [item('דנה'), { ...item('רות'), house: 'narnia' }],
  }, 400);
});

test('addHadrachotBatch: caps the batch size', () => {
  const items = [];
  for (let i = 0; i < 501; i++) {
    items.push({ guideName: 'איש ' + i, house: 'ramot', quarter: '2026-Q3' });
  }
  rejects({ action: 'addHadrachotBatch', items }, 400);
});

test('updateHadracha: forwards only the keys present in the payload', () => {
  const out = validateAction({
    action: 'updateHadracha', id: 'h1',
    hadracha: { supervisorId: 's2' },
  });
  assert.deepEqual(out.hadracha, { supervisorId: 's2' });
  assert.ok(!('scheduledDate' in out.hadracha));

  const cleared = validateAction({
    action: 'updateHadracha', id: 'h1',
    hadracha: { supervisorId: '', scheduledDate: '' },
  });
  assert.deepEqual(cleared.hadracha, { supervisorId: '', scheduledDate: '' });

  rejects({ action: 'updateHadracha', id: 'h1', hadracha: {} }, 400);
  rejects({ action: 'updateHadracha', id: 'h1', hadracha: { scheduledDate: 'bad' } }, 400);
  rejects({ action: 'updateHadracha', id: 'h1', hadracha: { house: 'narnia' } }, 400);
  rejects({ action: 'updateHadracha', hadracha: { supervisorId: 's2' } }, 400); // no id
});

test('setAttendance: normalizes and dedupes names, strips commas, allows clearing', () => {
  const out = validateAction({
    action: 'setAttendance', id: 'h1',
    attendance: ['  דנה   לוי ', 'יואב כהן', 'דנה לוי', 'רות,אשר'],
  });
  assert.deepEqual(out.attendance, ['דנה לוי', 'יואב כהן', 'רות אשר']);
  const cleared = validateAction({ action: 'setAttendance', id: 'h1', attendance: [] });
  assert.deepEqual(cleared.attendance, []);
  rejects({ action: 'setAttendance', id: 'h1', attendance: 'דנה' }, 400); // not an array
  rejects({ action: 'setAttendance', id: 'h1', attendance: ['  '] }, 400);
  rejects({ action: 'setAttendance', attendance: [] }, 400); // no id
  const many = [];
  for (let i = 0; i < 201; i++) many.push('איש ' + i);
  rejects({ action: 'setAttendance', id: 'h1', attendance: many }, 400);
});

test('completeHadracha: requires id and a well-formed date', () => {
  const out = validateAction({ action: 'completeHadracha', id: 'h1', completedDate: '2026-08-19' });
  assert.equal(out.completedDate, '2026-08-19');
  rejects({ action: 'completeHadracha', id: 'h1' }, 400);
  rejects({ action: 'completeHadracha', id: 'h1', completedDate: 'today' }, 400);
  rejects({ action: 'completeHadracha', completedDate: '2026-08-19' }, 400);
});

test('reopen, cancel, delete: id required', () => {
  ['reopenHadracha', 'cancelHadracha', 'deleteHadracha'].forEach(action => {
    const out = validateAction({ action, id: 'h1' });
    assert.equal(out.id, 'h1');
    rejects({ action }, 400);
  });
});

test('setSetting: key whitelist, value capped', () => {
  const out = validateAction({ action: 'setSetting', key: 'ui.note', value: 'x'.repeat(600) });
  assert.equal(out.value.length, 500);
  rejects({ action: 'setSetting', key: 'יש רווח', value: 'x' }, 400);
  rejects({ action: 'setSetting', key: '', value: 'x' }, 400);
});

test('no financial field is ever accepted anywhere', () => {
  // The validator whitelists keys; a salary smuggled into a supervisor or
  // hadracha payload simply never appears in the sanitized output.
  const sup = validateAction({
    action: 'addSupervisor',
    supervisor: { name: 'א', houses: ['ramot'], maxPerQuarter: 5, salary: 9999, hourlyRate: 80 },
  });
  assert.deepEqual(Object.keys(sup.supervisor).sort(), [
    'active', 'deliversGroup', 'deliversIndividual', 'deliversRefresher',
    'houses', 'maxPerQuarter', 'name', 'roles',
  ]);

  const had = validateAction({
    action: 'addHadracha',
    hadracha: { guideName: 'א', house: 'ramot', quarter: '2026-Q3', salary: 9999 },
  });
  assert.deepEqual(
    Object.keys(had.hadracha).sort(),
    ['cluster', 'guideName', 'house', 'quarter', 'scheduledDate', 'status', 'supervisorId', 'type']
  );
});

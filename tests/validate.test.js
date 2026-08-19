'use strict';
// Input validation for every write endpoint (lib/validate.js) — nothing
// malformed may ever reach the Apps Script backend.

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateAction, HOUSE_IDS } = require('../lib/validate');

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

test('addSupervisor: happy path normalizes and defaults active=true', () => {
  const out = validateAction({
    action: 'addSupervisor',
    supervisor: { name: '  אורית   לוי ', houses: ['ramot', 'hq', 'ramot'], maxPerQuarter: 12 },
  });
  assert.equal(out.supervisor.name, 'אורית לוי');
  assert.deepEqual(out.supervisor.houses, ['ramot', 'hq']); // deduped
  assert.equal(out.supervisor.maxPerQuarter, 12);
  assert.equal(out.supervisor.active, true);
});

test('addSupervisor: rejects unknown house, empty houses, bad max', () => {
  rejects({ action: 'addSupervisor', supervisor: { name: 'א', houses: ['narnia'], maxPerQuarter: 5 } }, 400);
  rejects({ action: 'addSupervisor', supervisor: { name: 'א', houses: [], maxPerQuarter: 5 } }, 400);
  rejects({ action: 'addSupervisor', supervisor: { name: 'א', houses: ['ramot'], maxPerQuarter: 0 } }, 400);
  rejects({ action: 'addSupervisor', supervisor: { name: 'א', houses: ['ramot'], maxPerQuarter: 501 } }, 400);
  rejects({ action: 'addSupervisor', supervisor: { name: 'א', houses: ['ramot'], maxPerQuarter: 2.5 } }, 400);
  rejects({ action: 'addSupervisor', supervisor: { name: '', houses: ['ramot'], maxPerQuarter: 5 } }, 400);
});

test('updateSupervisor requires id; setSupervisorActive requires a real boolean', () => {
  rejects({ action: 'updateSupervisor', supervisor: { name: 'א', houses: ['ramot'], maxPerQuarter: 5 } }, 400);
  rejects({ action: 'setSupervisorActive', id: 's1', active: 'yes' }, 400);
  const out = validateAction({ action: 'setSupervisorActive', id: 's1', active: false });
  assert.equal(out.active, false);
});

test('all seven houses are accepted', () => {
  assert.deepEqual(HOUSE_IDS, ['ramot', 'asher', 'ofroni', 'rehab', 'pardes', 'sde_eliezer', 'hq']);
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
});

test('addHadracha: rejects bad quarter, house, and date formats', () => {
  const base = { guideName: 'דנה', house: 'ramot', quarter: '2026-Q3' };
  rejects({ action: 'addHadracha', hadracha: { ...base, quarter: '2026-Q5' } }, 400);
  rejects({ action: 'addHadracha', hadracha: { ...base, quarter: 'Q3-2026' } }, 400);
  rejects({ action: 'addHadracha', hadracha: { ...base, house: 'narnia' } }, 400);
  rejects({ action: 'addHadracha', hadracha: { ...base, scheduledDate: '20/08/2026' } }, 400);
  rejects({ action: 'addHadracha', hadracha: { ...base, guideName: '   ' } }, 400);
});

test('addHadrachotBatch: validates every item and rejects duplicates', () => {
  const item = q => ({ guideName: 'דנה', house: 'ramot', supervisorId: 's1', quarter: q });
  const out = validateAction({ action: 'addHadrachotBatch', items: [item('2026-Q3'), item('2026-Q4')] });
  assert.equal(out.items.length, 2);
  rejects({ action: 'addHadrachotBatch', items: [] }, 400);
  rejects({ action: 'addHadrachotBatch', items: [item('2026-Q3'), item('2026-Q3')] }, 400);
  rejects({
    action: 'addHadrachotBatch',
    items: [item('2026-Q3'), { ...item('2026-Q4'), house: 'narnia' }],
  }, 400);
});

test('addHadrachotBatch: caps the batch size', () => {
  const items = [];
  for (let i = 0; i < 501; i++) {
    items.push({ guideName: 'מדריך ' + i, house: 'ramot', quarter: '2026-Q3' });
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
  assert.deepEqual(Object.keys(sup.supervisor).sort(), ['active', 'houses', 'maxPerQuarter', 'name']);

  const had = validateAction({
    action: 'addHadracha',
    hadracha: { guideName: 'א', house: 'ramot', quarter: '2026-Q3', salary: 9999 },
  });
  assert.deepEqual(
    Object.keys(had.hadracha).sort(),
    ['guideName', 'house', 'quarter', 'scheduledDate', 'status', 'supervisorId']
  );
});

'use strict';
/* SERVER-ONLY input validation for POST /api/action. Every write that reaches
   the Apps Script backend passes through validateAction first; Apps Script
   re-validates (defense in depth), but nothing malformed should ever leave
   this process. Mirrored constants live in apps-script/Code.gs — keep the two
   in lockstep.

   This app carries NO salary or money data anywhere — no financial field is
   accepted by any action. */

const HOUSE_IDS = [
  'ramot', 'asher', 'ofroni', 'rehab',
  'pardes', 'sde_eliezer',
  'hq',
];

// House clusters for GROUP guide sessions — mirror CLUSTERS in
// lib/scheduler.js. Internal house ids stay unchanged.
const CLUSTER_IDS = ['kesaria', 'raanana'];

// ASCII roles from the staffing feed — the role field is authoritative.
const ROLES = ['guide', 'social_worker', 'house_manager', 'coordinator'];

// ASCII session types stored in the sheet; the UI shows Hebrew labels
// (קבוצתית / אישית / רענון). Blank legacy cells read as 'individual'.
const SESSION_TYPES = ['group', 'individual', 'refresher'];

// ASCII status values stored in the sheet; the UI shows Hebrew labels
// (מתוכנן / בוצע / בוטל).
const HADRACHA_STATUSES = ['planned', 'done', 'cancelled'];

const NAME_MAX = 80;
const ID_MAX = 40;
const NOTE_MAX = 500;
const MAX_PER_QUARTER_MIN = 1;
const MAX_PER_QUARTER_MAX = 500;
const BATCH_MAX = 500;
const ATTENDANCE_MAX = 200;
const SETTING_KEY_RE = /^[A-Za-z0-9_.-]{1,50}$/;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const QUARTER_RE = /^\d{4}-Q[1-4]$/;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function isHouse(id) { return HOUSE_IDS.indexOf(id) >= 0; }
function isCluster(id) { return CLUSTER_IDS.indexOf(id) >= 0; }

function requiredString(v, label, max) {
  const s = String(v == null ? '' : v).trim().replace(/\s+/g, ' ').slice(0, max);
  if (!s) throw httpError(400, 'missing ' + label);
  return s;
}

function optionalString(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

function requiredDate(v, label) {
  const s = String(v == null ? '' : v).trim();
  if (!s) throw httpError(400, 'missing ' + label);
  if (!DATE_RE.test(s)) throw httpError(400, 'bad ' + label);
  return s;
}

function optionalDate(v, label) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (!DATE_RE.test(s)) throw httpError(400, 'bad ' + label);
  return s;
}

function requiredQuarter(v, label) {
  const s = String(v == null ? '' : v).trim();
  if (!s) throw httpError(400, 'missing ' + label);
  if (!QUARTER_RE.test(s)) throw httpError(400, 'bad ' + label);
  return s;
}

function requiredId(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) throw httpError(400, 'missing id');
  if (s.length > ID_MAX) throw httpError(400, 'bad id');
  return s;
}

function requiredBool(v, label) {
  if (v === true || v === false) return v;
  throw httpError(400, 'bad ' + label);
}

function optionalBool(v, label, dflt) {
  if (v === undefined) return dflt;
  return requiredBool(v, label);
}

// ---- supervisors ----

// { name, houses: [house ids], maxPerQuarter, active,
//   deliversGroup, deliversIndividual, deliversRefresher, roles: [roles] }
// Capability defaults keep legacy payloads working: group+individual true,
// refresher false, roles = all.
function validateSupervisor(s) {
  if (!s || typeof s !== 'object') throw httpError(400, 'supervisor required');
  const name = requiredString(s.name, 'name', NAME_MAX);
  if (!Array.isArray(s.houses) || !s.houses.length) {
    throw httpError(400, 'houses required');
  }
  const houses = [];
  s.houses.forEach(function (h) {
    const id = String(h == null ? '' : h).trim();
    if (!isHouse(id)) throw httpError(400, 'unknown house: ' + id.slice(0, 20));
    if (houses.indexOf(id) < 0) houses.push(id);
  });
  const maxPerQuarter = Number(s.maxPerQuarter);
  if (!Number.isInteger(maxPerQuarter)
      || maxPerQuarter < MAX_PER_QUARTER_MIN
      || maxPerQuarter > MAX_PER_QUARTER_MAX) {
    throw httpError(400, 'bad maxPerQuarter');
  }
  const active = s.active === undefined ? true : requiredBool(s.active, 'active');
  const deliversGroup = optionalBool(s.deliversGroup, 'deliversGroup', true);
  const deliversIndividual = optionalBool(s.deliversIndividual, 'deliversIndividual', true);
  const deliversRefresher = optionalBool(s.deliversRefresher, 'deliversRefresher', false);
  let roles;
  if (s.roles === undefined) {
    roles = ROLES.slice();
  } else {
    if (!Array.isArray(s.roles) || !s.roles.length) throw httpError(400, 'roles required');
    roles = [];
    s.roles.forEach(function (r) {
      const v = String(r == null ? '' : r).trim();
      if (ROLES.indexOf(v) < 0) throw httpError(400, 'unknown role: ' + v.slice(0, 20));
      if (roles.indexOf(v) < 0) roles.push(v);
    });
  }
  return {
    name: name, houses: houses, maxPerQuarter: maxPerQuarter, active: active,
    deliversGroup: deliversGroup, deliversIndividual: deliversIndividual,
    deliversRefresher: deliversRefresher, roles: roles,
  };
}

// ---- hadrachot ----

// A NEW session row. Status is forced to 'planned' — completion goes through
// completeHadracha only, so a completed row can never appear without a date.
// Type branches the shape: a GROUP session belongs to a cluster and carries
// no single guide; individual/refresher sessions belong to one person.
function validateNewHadracha(h) {
  if (!h || typeof h !== 'object') throw httpError(400, 'hadracha required');
  const type = h.type === undefined ? 'individual' : String(h.type).trim();
  if (SESSION_TYPES.indexOf(type) < 0) throw httpError(400, 'unknown type');
  const supervisorId = optionalString(h.supervisorId, ID_MAX);
  const quarter = requiredQuarter(h.quarter, 'quarter');
  const scheduledDate = optionalDate(h.scheduledDate, 'scheduledDate');

  if (type === 'group') {
    const cluster = String(h.cluster == null ? '' : h.cluster).trim();
    if (!isCluster(cluster)) throw httpError(400, 'unknown cluster');
    return {
      guideName: '', house: '', supervisorId: supervisorId,
      quarter: quarter, scheduledDate: scheduledDate,
      status: 'planned', type: type, cluster: cluster,
    };
  }

  const guideName = requiredString(h.guideName, 'guideName', NAME_MAX);
  if (!isHouse(h.house)) throw httpError(400, 'unknown house');
  return {
    guideName: guideName, house: h.house, supervisorId: supervisorId,
    quarter: quarter, scheduledDate: scheduledDate,
    status: 'planned', type: type, cluster: '',
  };
}

// The batch dedupe key — mirrors openPlannedKey_ in Code.gs: one OPEN
// planned group session per cluster, one per person+type otherwise.
function hadrachaKey(v) {
  return v.type === 'group'
    ? 'g|' + v.cluster
    : 'i|' + v.type + '|' + v.guideName;
}

// One item of the one-time baseline bulk action (סמן הכל כבוצע היום): a
// COMPLETED session created directly, dated by the batch's completedDate.
// Group items carry a cluster and the attending guides; individual and
// refresher items carry one person. No supervisor — a baseline row records
// a starting point, not a delivered session.
function validateBaselineItem(it) {
  if (!it || typeof it !== 'object') throw httpError(400, 'item required');
  const type = String(it.type == null ? '' : it.type).trim();
  if (SESSION_TYPES.indexOf(type) < 0) throw httpError(400, 'unknown type');
  if (type === 'group') {
    const cluster = String(it.cluster == null ? '' : it.cluster).trim();
    if (!isCluster(cluster)) throw httpError(400, 'unknown cluster');
    const attendance = validateAttendance(it.attendance);
    if (!attendance.length) throw httpError(400, 'attendance required');
    return { type: type, cluster: cluster, attendance: attendance, guideName: '', house: '' };
  }
  const guideName = requiredString(it.guideName, 'guideName', NAME_MAX);
  if (!isHouse(it.house)) throw httpError(400, 'unknown house');
  return { type: type, cluster: '', attendance: [], guideName: guideName, house: it.house };
}

// The baseline dedupe key: one group row per cluster, one row per
// person+type otherwise — mirrors baselineKey_ in Code.gs.
function baselineKey(v) {
  return v.type === 'group' ? 'g|' + v.cluster : 'i|' + v.type + '|' + v.guideName;
}

// Partial update for manual overrides (reassign supervisor / reschedule /
// fix the house). Only the keys PRESENT in the payload are forwarded —
// key presence is meaningful, so an untouched field is never blanked.
function validateHadrachaUpdate(h) {
  if (!h || typeof h !== 'object') throw httpError(400, 'hadracha required');
  const out = {};
  let any = false;
  if (Object.prototype.hasOwnProperty.call(h, 'supervisorId')) {
    out.supervisorId = optionalString(h.supervisorId, ID_MAX); // '' = unassign
    any = true;
  }
  if (Object.prototype.hasOwnProperty.call(h, 'scheduledDate')) {
    out.scheduledDate = optionalDate(h.scheduledDate, 'scheduledDate'); // '' = clear
    any = true;
  }
  if (Object.prototype.hasOwnProperty.call(h, 'house')) {
    if (!isHouse(h.house)) throw httpError(400, 'unknown house');
    out.house = h.house;
    any = true;
  }
  if (!any) throw httpError(400, 'nothing to update');
  return out;
}

// Attendance on a group session: an array of guide names, deduped and
// normalized. Commas are stripped from names — attendance is stored as a
// comma-separated cell. An empty array is valid (clears attendance).
function validateAttendance(list) {
  if (!Array.isArray(list)) throw httpError(400, 'attendance required');
  if (list.length > ATTENDANCE_MAX) throw httpError(400, 'too many attendance entries');
  const out = [];
  list.forEach(function (n) {
    const name = String(n == null ? '' : n)
      .replace(/,/g, ' ').trim().replace(/\s+/g, ' ').slice(0, NAME_MAX);
    if (!name) throw httpError(400, 'bad attendance name');
    if (out.indexOf(name) < 0) out.push(name);
  });
  return out;
}

// ---- action dispatch ----

function validateAction(body) {
  if (!body || typeof body !== 'object') throw httpError(400, 'body required');
  const action = String(body.action || '');
  switch (action) {
    case 'addSupervisor':
      return { action: action, supervisor: validateSupervisor(body.supervisor) };

    case 'updateSupervisor':
      return {
        action: action,
        id: requiredId(body.id),
        supervisor: validateSupervisor(body.supervisor),
      };

    case 'setSupervisorActive':
      return {
        action: action,
        id: requiredId(body.id),
        active: requiredBool(body.active, 'active'),
      };

    case 'addHadracha':
      return { action: action, hadracha: validateNewHadracha(body.hadracha) };

    case 'addHadrachotBatch': {
      if (!Array.isArray(body.items) || !body.items.length) {
        throw httpError(400, 'items required');
      }
      if (body.items.length > BATCH_MAX) throw httpError(400, 'too many items');
      const seen = Object.create(null);
      const items = body.items.map(function (it) {
        const v = validateNewHadracha(it);
        const key = hadrachaKey(v);
        if (seen[key]) throw httpError(400, 'duplicate session in request');
        seen[key] = true;
        return v;
      });
      return { action: action, items: items };
    }

    case 'baselineBatch': {
      const completedDate = requiredDate(body.completedDate, 'completedDate');
      if (!Array.isArray(body.items) || !body.items.length) {
        throw httpError(400, 'items required');
      }
      if (body.items.length > BATCH_MAX) throw httpError(400, 'too many items');
      const seen = Object.create(null);
      const items = body.items.map(function (it) {
        const v = validateBaselineItem(it);
        const key = baselineKey(v);
        if (seen[key]) throw httpError(400, 'duplicate baseline entry in request');
        seen[key] = true;
        return v;
      });
      return { action: action, completedDate: completedDate, items: items };
    }

    case 'updateHadracha':
      return {
        action: action,
        id: requiredId(body.id),
        hadracha: validateHadrachaUpdate(body.hadracha),
      };

    case 'setAttendance':
      return {
        action: action,
        id: requiredId(body.id),
        attendance: validateAttendance(body.attendance),
      };

    case 'completeHadracha':
      return {
        action: action,
        id: requiredId(body.id),
        completedDate: requiredDate(body.completedDate, 'completedDate'),
      };

    case 'reopenHadracha':
    case 'cancelHadracha':
    case 'deleteHadracha':
      return { action: action, id: requiredId(body.id) };

    case 'setSetting': {
      const key = String(body.key == null ? '' : body.key).trim();
      if (!SETTING_KEY_RE.test(key)) throw httpError(400, 'bad key');
      return { action: action, key: key, value: optionalString(body.value, NOTE_MAX) };
    }

    default:
      throw httpError(400, 'unknown action');
  }
}

module.exports = {
  HOUSE_IDS,
  CLUSTER_IDS,
  ROLES,
  SESSION_TYPES,
  HADRACHA_STATUSES,
  BATCH_MAX,
  ATTENDANCE_MAX,
  validateAction,
  validateSupervisor,
  validateNewHadracha,
  validateHadrachaUpdate,
  validateAttendance,
  validateBaselineItem,
};

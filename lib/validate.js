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

// ASCII status values stored in the sheet; the UI shows Hebrew labels
// (מתוכנן / בוצע / בוטל).
const HADRACHA_STATUSES = ['planned', 'done', 'cancelled'];

const NAME_MAX = 80;
const ID_MAX = 40;
const NOTE_MAX = 500;
const MAX_PER_QUARTER_MIN = 1;
const MAX_PER_QUARTER_MAX = 500;
const BATCH_MAX = 500;
const SETTING_KEY_RE = /^[A-Za-z0-9_.-]{1,50}$/;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const QUARTER_RE = /^\d{4}-Q[1-4]$/;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function isHouse(id) { return HOUSE_IDS.indexOf(id) >= 0; }

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

// ---- supervisors ----

// { name, houses: [house ids], maxPerQuarter, active }
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
  return { name: name, houses: houses, maxPerQuarter: maxPerQuarter, active: active };
}

// ---- hadrachot ----

// A NEW hadracha row. Status is forced to 'planned' — completion goes through
// completeHadracha only, so a completed row can never appear without a date.
function validateNewHadracha(h) {
  if (!h || typeof h !== 'object') throw httpError(400, 'hadracha required');
  const guideName = requiredString(h.guideName, 'guideName', NAME_MAX);
  if (!isHouse(h.house)) throw httpError(400, 'unknown house');
  const supervisorId = optionalString(h.supervisorId, ID_MAX);
  const quarter = requiredQuarter(h.quarter, 'quarter');
  const scheduledDate = optionalDate(h.scheduledDate, 'scheduledDate');
  return {
    guideName: guideName,
    house: h.house,
    supervisorId: supervisorId,
    quarter: quarter,
    scheduledDate: scheduledDate,
    status: 'planned',
  };
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
        const key = v.guideName + '|' + v.quarter;
        if (seen[key]) throw httpError(400, 'duplicate guide+quarter in request');
        seen[key] = true;
        return v;
      });
      return { action: action, items: items };
    }

    case 'updateHadracha':
      return {
        action: action,
        id: requiredId(body.id),
        hadracha: validateHadrachaUpdate(body.hadracha),
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
  HADRACHA_STATUSES,
  BATCH_MAX,
  validateAction,
  validateSupervisor,
  validateNewHadracha,
  validateHadrachaUpdate,
};

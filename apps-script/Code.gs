/* ============================================================
   E-ZONE Hadrachot — Apps Script backend
   Deployed as Web App (execute as: me, who has access: anyone).
   Auth is enforced via a shared secret passed in every request —
   the URL alone is NOT authorization.

   This backend serves RAW rows only. All cadence / compliance /
   scheduling logic lives in the frontend (lib/scheduler.js).
   NO salary or money data exists anywhere in this app.

   Script properties required:
     - SHARED_SECRET : must match server.js SHARED_SECRET env var
   Script properties optional:
     - SHEET_ID : overrides DEFAULT_SHEET_ID below
     - HADRACHOT_STATUS_SECRET : unlocks ONLY the read-only
       getFirstHadrachaStatus feed (doGet?action=getFirstHadrachaStatus)
       consumed by the STAFFING app. Fail-closed: while unset the feed
       always answers 401. Distinct from SHARED_SECRET on purpose —
       neither secret ever unlocks the other's surface.

   Data model — tabs are created automatically on first run.
   All header arrays are APPEND-ONLY and position-mapped: readers and
   writers map columns by POSITION, so a mid-array insert would shift
   every stored value one column right and corrupt every row. New
   columns go on the END only, never before an existing one. When a
   header row is shorter than its array (pre-migration sheet), the
   missing header cells are appended in place — existing rows keep
   working, their new cells read as blank and get safe defaults.

   Supervisors tab:
     id | name | houses | max_per_quarter | active | created_at |
     delivers_group | delivers_individual | delivers_refresher | roles
     `houses` is a comma-separated list of house ids. `roles` is a
     comma-separated list of feed roles the supervisor can supervise
     (blank = all). The three delivers_* flags are 'true'/'false';
     blank legacy cells default to group=true individual=true
     refresher=false. `active` is 'true'/'false'. A default refresher
     instructor named אולגה is seeded once (Settings key seed.olga).

   Hadrachot tab:
     id | guide_name | house | supervisor_id | quarter |
     scheduled_date | completed_date | status | created_at |
     type | cluster | attendance
     `type` is group / individual / refresher (blank legacy cells read
     as individual). A GROUP session has no single guide: guide_name
     and house are blank, `cluster` is kesaria / raanana, and
     `attendance` is a comma-separated list of guide names who
     attended. `status` is planned / done / cancelled — the UI shows
     מתוכנן / בוצע / בוטל. `quarter` ('YYYY-Qn') is legacy
     bookkeeping kept for position mapping. People are NOT stored in
     this app — guide_name joins to the staffing roster feed.

   Settings tab:
     key | value
   ============================================================ */

// Must mirror HOUSE_IDS in lib/validate.js.
const HOUSE_IDS = [
  'ramot', 'asher', 'ofroni', 'rehab',
  'pardes', 'sde_eliezer',
  'hq',
];

// Must mirror lib/validate.js / lib/scheduler.js.
const CLUSTER_IDS = ['kesaria', 'raanana'];
const ROLES = ['guide', 'social_worker', 'house_manager', 'coordinator'];
const SESSION_TYPES = ['group', 'individual', 'refresher'];

const SUPERVISORS_TAB = 'Supervisors';
const HADRACHOT_TAB = 'Hadrachot';
const SETTINGS_TAB = 'Settings';

// APPEND-ONLY (see the header note above).
const HEADERS_SUPERVISORS = [
  'id', 'name', 'houses', 'max_per_quarter', 'active', 'created_at',
  'delivers_group', 'delivers_individual', 'delivers_refresher', 'roles',
];
const HEADERS_HADRACHOT = [
  'id', 'guide_name', 'house', 'supervisor_id', 'quarter',
  'scheduled_date', 'completed_date', 'status', 'created_at',
  'type', 'cluster', 'attendance',
];
const HEADERS_SETTINGS = ['key', 'value'];

// ASCII statuses — mirror lib/validate.js. Hebrew labels live in the UI only.
const HADRACHA_STATUSES = ['planned', 'done', 'cancelled'];

// Caps — mirror lib/validate.js.
const NAME_MAX = 80;
const ID_MAX = 40;
const NOTE_MAX = 500;
const MAX_PER_QUARTER_MIN = 1;
const MAX_PER_QUARTER_MAX = 500;
const BATCH_MAX = 500;
const ATTENDANCE_MAX = 200;

// The default refresher instructor seeded once into Supervisors.
const SEED_OLGA_KEY = 'seed.olga';
const SEED_OLGA_NAME = 'אולגה';

// The hadrachot tracking spreadsheet. Not a secret (access is governed by
// the Google account, not by knowing the id); the SHEET_ID Script Property
// overrides it when set.
const DEFAULT_SHEET_ID = '1CbAEhM2PVX7f9l-zmbjhBJBrtNcOAz_8UTRAJ1PLPG8';

// ---------- entry points ----------

function doGet(e) {
  // Read-only first-supervision status feed for the staffing app. Routed
  // BEFORE the main SHARED_SECRET gate and authorized ONLY by
  // HADRACHOT_STATUS_SECRET (see the "Status feed" section below).
  if (e && e.parameter && e.parameter.action === 'getFirstHadrachaStatus') {
    return handleStatusRead_(e);
  }
  return handle(e, function () {
    ensureTabs_();
    ensureSeedData_();
    return {
      supervisors: readSupervisorsSafe(),
      hadrachot: readHadrachotSafe(),
      settings: readSettingsSafe(),
    };
  });
}

function doPost(e) {
  return handle(e, function () {
    const body = parseBody(e);
    ensureTabs_();
    switch (body.action) {
      case 'addSupervisor':       return addSupervisor(body);
      case 'updateSupervisor':    return updateSupervisor(body);
      case 'setSupervisorActive': return setSupervisorActive(body);
      case 'addHadracha':         return addHadracha(body);
      case 'addHadrachotBatch':   return addHadrachotBatch(body);
      case 'updateHadracha':      return updateHadracha(body);
      case 'setAttendance':       return setAttendance(body);
      case 'completeHadracha':    return completeHadracha(body);
      case 'reopenHadracha':      return reopenHadracha(body);
      case 'cancelHadracha':      return cancelHadracha(body);
      case 'deleteHadracha':      return deleteHadracha(body);
      case 'setSetting':          return setSetting(body);
      default: throw httpError(400, 'unknown action');
    }
  });
}

function handle(e, fn) {
  try {
    if (!authorized(e)) return json({ error: 'unauthorized' }, 401);
    return json(fn(), 200);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    const msg = (err && err.message) || String(err);
    return json({ error: msg }, status);
  }
}

function authorized(e) {
  const required = PropertiesService.getScriptProperties().getProperty('SHARED_SECRET');
  const provided = (e && e.parameter && e.parameter.secret) || '';
  return secretMatches_(required, provided);
}

// Constant-time secret comparison, fail-closed: an unset/empty stored
// secret matches NOTHING (an unconfigured surface must never open up).
function secretMatches_(required, provided) {
  if (!required) return false;
  const prov = String(provided || '');
  if (prov.length !== required.length) return false;
  let diff = 0;
  for (let i = 0; i < required.length; i++) {
    diff |= required.charCodeAt(i) ^ prov.charCodeAt(i);
  }
  return diff === 0;
}

function parseBody(e) {
  if (!e || !e.postData || !e.postData.contents) throw httpError(400, 'empty body');
  try { return JSON.parse(e.postData.contents); }
  catch (err) { throw httpError(400, 'bad json'); }
}

function json(obj, status) {
  const payload = Object.assign({ _status: status || 200 }, obj);
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// ---------- sheet plumbing ----------

function ss() {
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID') || DEFAULT_SHEET_ID;
  if (!id) throw httpError(500, 'SHEET_ID is not configured');
  return SpreadsheetApp.openById(id);
}

function sheetByName(name) {
  const sh = ss().getSheetByName(name);
  if (!sh) throw httpError(500, 'missing sheet: ' + name);
  return sh;
}

// Creates any missing tab with its headers, and APPENDS any header cells a
// pre-migration tab is missing (columns are only ever added at the END, so
// extending the header row is safe — existing rows keep their positions).
// Takes the lock only when something is actually missing, so the
// steady-state read path stays lock-free.
function ensureTabs_() {
  const book = ss();
  const wanted = [
    { name: SUPERVISORS_TAB, headers: HEADERS_SUPERVISORS },
    { name: HADRACHOT_TAB, headers: HEADERS_HADRACHOT },
    { name: SETTINGS_TAB, headers: HEADERS_SETTINGS },
  ];
  const needsWork = wanted.filter(function (w) {
    const sh = book.getSheetByName(w.name);
    return !sh || sh.getLastColumn() < w.headers.length;
  });
  if (!needsWork.length) return;
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    needsWork.forEach(function (w) {
      let sh = book.getSheetByName(w.name);
      if (!sh) {
        sh = book.insertSheet(w.name);
        sh.getRange(1, 1, 1, w.headers.length).setValues([w.headers]);
        sh.setFrozenRows(1);
        return;
      }
      const width = sh.getLastColumn();
      if (width >= w.headers.length) return; // raced — another call extended it
      const missing = w.headers.slice(width);
      sh.getRange(1, width + 1, 1, missing.length).setValues([missing]);
    });
  } finally {
    lock.releaseLock();
  }
}

// One-time seed of the default refresher instructor אולגה, recorded in
// Settings so the check stays cheap and never re-runs after the row is
// edited or deactivated. Idempotent under races (re-checked under lock).
function ensureSeedData_() {
  if (readSettingsSafe()[SEED_OLGA_KEY] === 'done') return;
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const settings = sheetByName(SETTINGS_TAB);
    if (findRow(settings, 0, SEED_OLGA_KEY) >= 0) return; // raced
    const exists = readSupervisorsSafe().some(function (s) {
      return normName_(s.name) === SEED_OLGA_NAME;
    });
    if (!exists) {
      const sh = sheetByName(SUPERVISORS_TAB);
      // Column order MUST match HEADERS_SUPERVISORS. Refreshers only:
      // no group sessions, no regular individual supervisions, guides only.
      sh.appendRow([
        newId('s'), SEED_OLGA_NAME, HOUSE_IDS.join(','), 100, 'true',
        new Date().toISOString(), 'false', 'false', 'true', 'guide',
      ]);
    }
    settings.appendRow([SEED_OLGA_KEY, 'done']);
  } finally {
    lock.releaseLock();
  }
}

function rowsOf(sheet) {
  if (!sheet) return [];
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  return values.slice(1).filter(function (r) {
    return String(r[0] || '').trim() !== '';
  });
}

function findRow(sheet, idColIndex, id) {
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][idColIndex]) === String(id)) return i + 1;
  }
  return -1;
}

function newId(prefix) {
  return (prefix || 'x') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function formatDateCell(cell) {
  if (cell instanceof Date) {
    return Utilities.formatDate(cell, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  const s = String(cell || '').trim();
  return s;
}

function cellToIso(cell) {
  if (cell instanceof Date) return cell.toISOString();
  return String(cell || '');
}

// A quarter cell → 'YYYY-Qn'. Stored as text, but guard against Sheets
// coercions anyway.
function formatQuarterCell(cell) {
  const s = String(cell || '').trim();
  const m = /^(\d{4}-Q[1-4])/.exec(s);
  return m ? m[1] : s;
}

// ---------- validators (mirror lib/validate.js) ----------

function isHouse(id) { return HOUSE_IDS.indexOf(id) >= 0; }
function isCluster(id) { return CLUSTER_IDS.indexOf(id) >= 0; }

function requiredString_(v, label, max) {
  const s = String(v === undefined || v === null ? '' : v)
    .trim().replace(/\s+/g, ' ').slice(0, max);
  if (!s) throw httpError(400, 'missing ' + label);
  return s;
}

function optionalString_(v, max) {
  return String(v === undefined || v === null ? '' : v).trim().slice(0, max);
}

function requiredDate_(v, label) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (!s) throw httpError(400, 'missing ' + label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw httpError(400, 'bad ' + label);
  return s;
}

function optionalDate_(v, label) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (!s) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw httpError(400, 'bad ' + label);
  return s;
}

function requiredQuarter_(v, label) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (!s) throw httpError(400, 'missing ' + label);
  if (!/^\d{4}-Q[1-4]$/.test(s)) throw httpError(400, 'bad ' + label);
  return s;
}

function requireBodyId(body) {
  const id = String((body && body.id) || '').trim();
  if (!id) throw httpError(400, 'missing id');
  if (id.length > ID_MAX) throw httpError(400, 'bad id');
  return id;
}

function requiredBool_(v, label) {
  if (v === true || v === false) return v;
  throw httpError(400, 'bad ' + label);
}

function optionalBool_(v, label, dflt) {
  if (v === undefined) return dflt;
  return requiredBool_(v, label);
}

function validateSupervisor(s) {
  if (!s || typeof s !== 'object') throw httpError(400, 'supervisor required');
  const name = requiredString_(s.name, 'name', NAME_MAX);
  if (!Array.isArray(s.houses) || !s.houses.length) throw httpError(400, 'houses required');
  const houses = [];
  s.houses.forEach(function (h) {
    const id = String(h === undefined || h === null ? '' : h).trim();
    if (!isHouse(id)) throw httpError(400, 'unknown house');
    if (houses.indexOf(id) < 0) houses.push(id);
  });
  const maxPerQuarter = Number(s.maxPerQuarter);
  if (!isFinite(maxPerQuarter) || maxPerQuarter !== Math.round(maxPerQuarter)
      || maxPerQuarter < MAX_PER_QUARTER_MIN || maxPerQuarter > MAX_PER_QUARTER_MAX) {
    throw httpError(400, 'bad maxPerQuarter');
  }
  const active = s.active === undefined ? true : requiredBool_(s.active, 'active');
  const deliversGroup = optionalBool_(s.deliversGroup, 'deliversGroup', true);
  const deliversIndividual = optionalBool_(s.deliversIndividual, 'deliversIndividual', true);
  const deliversRefresher = optionalBool_(s.deliversRefresher, 'deliversRefresher', false);
  let roles;
  if (s.roles === undefined) {
    roles = ROLES.slice();
  } else {
    if (!Array.isArray(s.roles) || !s.roles.length) throw httpError(400, 'roles required');
    roles = [];
    s.roles.forEach(function (r) {
      const v = String(r === undefined || r === null ? '' : r).trim();
      if (ROLES.indexOf(v) < 0) throw httpError(400, 'unknown role');
      if (roles.indexOf(v) < 0) roles.push(v);
    });
  }
  return {
    name: name, houses: houses, maxPerQuarter: maxPerQuarter, active: active,
    deliversGroup: deliversGroup, deliversIndividual: deliversIndividual,
    deliversRefresher: deliversRefresher, roles: roles,
  };
}

// A NEW session row — status is forced to 'planned' (completion only ever
// happens through completeHadracha, which stamps the date). A GROUP session
// belongs to a cluster and has no single guide; individual/refresher
// sessions belong to one person.
function validateNewHadracha(h) {
  if (!h || typeof h !== 'object') throw httpError(400, 'hadracha required');
  const type = h.type === undefined ? 'individual' : String(h.type).trim();
  if (SESSION_TYPES.indexOf(type) < 0) throw httpError(400, 'unknown type');
  const supervisorId = optionalString_(h.supervisorId, ID_MAX);
  const quarter = requiredQuarter_(h.quarter, 'quarter');
  const scheduledDate = optionalDate_(h.scheduledDate, 'scheduledDate');

  if (type === 'group') {
    const cluster = String(h.cluster === undefined || h.cluster === null ? '' : h.cluster).trim();
    if (!isCluster(cluster)) throw httpError(400, 'unknown cluster');
    return {
      guideName: '', house: '', supervisorId: supervisorId,
      quarter: quarter, scheduledDate: scheduledDate,
      status: 'planned', type: type, cluster: cluster,
    };
  }

  const guideName = requiredString_(h.guideName, 'guideName', NAME_MAX);
  if (!isHouse(h.house)) throw httpError(400, 'unknown house');
  return {
    guideName: guideName, house: h.house, supervisorId: supervisorId,
    quarter: quarter, scheduledDate: scheduledDate,
    status: 'planned', type: type, cluster: '',
  };
}

// ---------- readers (raw rows, position-mapped) ----------

// 'true'/'false' cells; blank legacy cells take the given default.
function boolCell_(cell, dflt) {
  const s = String(cell === undefined || cell === null ? '' : cell).trim();
  if (s === 'true') return true;
  if (s === 'false') return false;
  return dflt;
}

function listCell_(cell) {
  return String(cell === undefined || cell === null ? '' : cell)
    .split(',').map(function (v) { return v.trim(); }).filter(Boolean);
}

function readSupervisorsSafe() {
  const sh = ss().getSheetByName(SUPERVISORS_TAB);
  return rowsOf(sh).map(function (r) {
    return {
      id: String(r[0]),
      name: String(r[1] || ''),
      houses: listCell_(r[2]),
      maxPerQuarter: Number(r[3]) || 0,
      active: String(r[4]) === 'true',
      createdAt: cellToIso(r[5]),
      // Legacy rows: blank flags default to group+individual true,
      // refresher false; blank roles = all roles (frontend semantics).
      deliversGroup: boolCell_(r[6], true),
      deliversIndividual: boolCell_(r[7], true),
      deliversRefresher: boolCell_(r[8], false),
      roles: listCell_(r[9]),
    };
  });
}

// Blank/unknown type cells read as 'individual' — every pre-rework row was
// an individual supervision.
function normalizeType_(v) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  return SESSION_TYPES.indexOf(s) >= 0 ? s : 'individual';
}

function readHadrachotSafe() {
  const sh = ss().getSheetByName(HADRACHOT_TAB);
  return rowsOf(sh).map(function (r) {
    return {
      id: String(r[0]),
      guideName: String(r[1] || ''),
      house: String(r[2] || ''),
      supervisorId: String(r[3] || ''),
      quarter: formatQuarterCell(r[4]),
      scheduledDate: formatDateCell(r[5]),
      completedDate: formatDateCell(r[6]),
      status: normalizeStatus_(r[7]),
      createdAt: cellToIso(r[8]),
      type: normalizeType_(r[9]),
      cluster: String(r[10] === undefined || r[10] === null ? '' : r[10]).trim(),
      attendance: listCell_(r[11]),
    };
  });
}

// Blank/unknown status cells read as 'planned' — the safe default (a row
// nobody can ever mark done by accident stays visible as work to do).
function normalizeStatus_(v) {
  const s = String(v || '').trim();
  return HADRACHA_STATUSES.indexOf(s) >= 0 ? s : 'planned';
}

function readSettingsSafe() {
  const sh = ss().getSheetByName(SETTINGS_TAB);
  const out = {};
  rowsOf(sh).forEach(function (r) {
    out[String(r[0])] = String(r[1] === undefined || r[1] === null ? '' : r[1]);
  });
  return out;
}

// ---------- supervisor actions ----------

function addSupervisor(body) {
  const s = validateSupervisor(body.supervisor || {});
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = sheetByName(SUPERVISORS_TAB);
    const id = newId('s');
    const createdAt = new Date().toISOString();
    // Column order MUST match HEADERS_SUPERVISORS.
    sh.appendRow([
      id, s.name, s.houses.join(','), s.maxPerQuarter, String(s.active), createdAt,
      String(s.deliversGroup), String(s.deliversIndividual),
      String(s.deliversRefresher), s.roles.join(','),
    ]);
    return { ok: true, supervisor: {
      id: id, name: s.name, houses: s.houses,
      maxPerQuarter: s.maxPerQuarter, active: s.active, createdAt: createdAt,
      deliversGroup: s.deliversGroup, deliversIndividual: s.deliversIndividual,
      deliversRefresher: s.deliversRefresher, roles: s.roles,
    } };
  } finally {
    lock.releaseLock();
  }
}

function updateSupervisor(body) {
  const id = requireBodyId(body);
  const s = validateSupervisor(body.supervisor || {});
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = sheetByName(SUPERVISORS_TAB);
    const row = findRow(sh, 0, id);
    if (row < 0) throw httpError(404, 'supervisor not found');
    sh.getRange(row, 2, 1, 4).setValues([[
      s.name, s.houses.join(','), s.maxPerQuarter, String(s.active),
    ]]);
    // cols 7-10 = delivers_group | delivers_individual | delivers_refresher | roles
    sh.getRange(row, 7, 1, 4).setValues([[
      String(s.deliversGroup), String(s.deliversIndividual),
      String(s.deliversRefresher), s.roles.join(','),
    ]]);
    return { ok: true, supervisor: {
      id: id, name: s.name, houses: s.houses,
      maxPerQuarter: s.maxPerQuarter, active: s.active,
      deliversGroup: s.deliversGroup, deliversIndividual: s.deliversIndividual,
      deliversRefresher: s.deliversRefresher, roles: s.roles,
    } };
  } finally {
    lock.releaseLock();
  }
}

// Deactivate / reactivate without touching the other fields. Supervisors are
// never deleted — hadracha rows reference them by id and history must keep
// resolving.
function setSupervisorActive(body) {
  const id = requireBodyId(body);
  const active = requiredBool_(body.active, 'active');
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = sheetByName(SUPERVISORS_TAB);
    const row = findRow(sh, 0, id);
    if (row < 0) throw httpError(404, 'supervisor not found');
    sh.getRange(row, 5).setValue(String(active)); // col 5 = active
    return { ok: true, id: id, active: active };
  } finally {
    lock.releaseLock();
  }
}

// ---------- hadracha actions ----------

function appendHadrachaRow_(sh, h) {
  const id = newId('h');
  const createdAt = new Date().toISOString();
  // Column order MUST match HEADERS_HADRACHOT.
  sh.appendRow([
    id, h.guideName, h.house, h.supervisorId, h.quarter,
    h.scheduledDate, '', h.status, createdAt,
    h.type, h.cluster, '',
  ]);
  return Object.assign({ id: id, completedDate: '', attendance: [], createdAt: createdAt }, h);
}

// One OPEN planned session at a time per track: per cluster for group
// sessions, per person+type for individual/refresher. Completed history
// accumulates freely — cadence needs many rows per person.
function openPlannedKey_(h) {
  return h.type === 'group'
    ? 'g|' + h.cluster
    : 'i|' + h.type + '|' + normName_(h.guideName);
}

function assertNoOpenPlanned_(h, excludeId) {
  const key = openPlannedKey_(h);
  const dup = readHadrachotSafe().find(function (x) {
    return x.status === 'planned'
      && openPlannedKey_(x) === key
      && (!excludeId || x.id !== excludeId);
  });
  if (dup) {
    throw httpError(409, h.type === 'group'
      ? 'cluster already has a planned group session'
      : 'person already has a planned session of this type');
  }
}

function addHadracha(body) {
  const h = validateNewHadracha(body.hadracha || {});
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = sheetByName(HADRACHOT_TAB);
    assertNoOpenPlanned_(h, null);
    return { ok: true, hadracha: appendHadrachaRow_(sh, h) };
  } finally {
    lock.releaseLock();
  }
}

// The auto-scheduler's write: the frontend computes the assignments (all
// scheduling logic is client-side) and posts them as one batch. Items whose
// track already has an open planned session are SKIPPED, not duplicated —
// the scheduler may run on stale data.
function addHadrachotBatch(body) {
  if (!Array.isArray(body.items) || !body.items.length) throw httpError(400, 'items required');
  if (body.items.length > BATCH_MAX) throw httpError(400, 'too many items');
  const seen = {};
  const items = body.items.map(function (it) {
    const v = validateNewHadracha(it);
    const key = openPlannedKey_(v);
    if (seen[key]) throw httpError(400, 'duplicate session in request');
    seen[key] = true;
    return v;
  });
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = sheetByName(HADRACHOT_TAB);
    const open = {};
    readHadrachotSafe().forEach(function (h) {
      if (h.status !== 'planned') return;
      open[openPlannedKey_(h)] = true;
    });
    const added = [];
    const skipped = [];
    items.forEach(function (h) {
      const key = openPlannedKey_(h);
      if (open[key]) { skipped.push(h.type === 'group' ? h.cluster : h.guideName); return; }
      open[key] = true;
      added.push(appendHadrachaRow_(sh, h));
    });
    return { ok: true, added: added, count: added.length, skipped: skipped };
  } finally {
    lock.releaseLock();
  }
}

function normName_(name) {
  return String(name === undefined || name === null ? '' : name).trim().replace(/\s+/g, ' ');
}

// Manual override per row: reassign supervisor, reschedule, or fix the
// house. Only keys PRESENT in the payload are written; identity fields
// (guide, type, cluster) and status fields never change here.
function updateHadracha(body) {
  const id = requireBodyId(body);
  const h = body.hadracha;
  if (!h || typeof h !== 'object') throw httpError(400, 'hadracha required');
  const patch = {};
  let any = false;
  if (Object.prototype.hasOwnProperty.call(h, 'supervisorId')) {
    patch.supervisorId = optionalString_(h.supervisorId, ID_MAX);
    any = true;
  }
  if (Object.prototype.hasOwnProperty.call(h, 'scheduledDate')) {
    patch.scheduledDate = optionalDate_(h.scheduledDate, 'scheduledDate');
    any = true;
  }
  if (Object.prototype.hasOwnProperty.call(h, 'house')) {
    if (!isHouse(h.house)) throw httpError(400, 'unknown house');
    patch.house = h.house;
    any = true;
  }
  if (!any) throw httpError(400, 'nothing to update');

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = sheetByName(HADRACHOT_TAB);
    const row = findRow(sh, 0, id);
    if (row < 0) throw httpError(404, 'hadracha not found');
    if (patch.supervisorId !== undefined) sh.getRange(row, 4).setValue(patch.supervisorId);
    if (patch.scheduledDate !== undefined) sh.getRange(row, 6).setValue(patch.scheduledDate);
    if (patch.house !== undefined) sh.getRange(row, 3).setValue(patch.house);
    return { ok: true, id: id, hadracha: patch };
  } finally {
    lock.releaseLock();
  }
}

// Attendance on a GROUP session — marked per guide, stored comma-separated.
// Allowed on planned and done rows (fix-ups after completion are fine);
// never on cancelled rows.
function setAttendance(body) {
  const id = requireBodyId(body);
  if (!Array.isArray(body.attendance)) throw httpError(400, 'attendance required');
  if (body.attendance.length > ATTENDANCE_MAX) throw httpError(400, 'too many attendance entries');
  const names = [];
  body.attendance.forEach(function (n) {
    const name = String(n === undefined || n === null ? '' : n)
      .replace(/,/g, ' ').trim().replace(/\s+/g, ' ').slice(0, NAME_MAX);
    if (!name) throw httpError(400, 'bad attendance name');
    if (names.indexOf(name) < 0) names.push(name);
  });
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = sheetByName(HADRACHOT_TAB);
    const row = findRow(sh, 0, id);
    if (row < 0) throw httpError(404, 'hadracha not found');
    if (normalizeType_(sh.getRange(row, 10).getValue()) !== 'group') {
      throw httpError(409, 'attendance applies to group sessions only');
    }
    if (normalizeStatus_(sh.getRange(row, 8).getValue()) === 'cancelled') {
      throw httpError(409, 'cannot set attendance on a cancelled session');
    }
    sh.getRange(row, 12).setValue(names.join(',')); // col 12 = attendance
    return { ok: true, id: id, attendance: names };
  } finally {
    lock.releaseLock();
  }
}

// Completion flow — בוצע: planned → done with a completed date.
function completeHadracha(body) {
  const id = requireBodyId(body);
  const completedDate = requiredDate_(body.completedDate, 'completedDate');
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = sheetByName(HADRACHOT_TAB);
    const row = findRow(sh, 0, id);
    if (row < 0) throw httpError(404, 'hadracha not found');
    const status = normalizeStatus_(sh.getRange(row, 8).getValue());
    if (status !== 'planned') throw httpError(409, 'only a planned hadracha can be completed');
    sh.getRange(row, 7).setValue(completedDate); // col 7 = completed_date
    sh.getRange(row, 8).setValue('done');        // col 8 = status
    return { ok: true, id: id, status: 'done', completedDate: completedDate };
  } finally {
    lock.releaseLock();
  }
}

// Undo for a mistaken tap on בוצע: done → planned, completed date cleared.
function reopenHadracha(body) {
  const id = requireBodyId(body);
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = sheetByName(HADRACHOT_TAB);
    const row = findRow(sh, 0, id);
    if (row < 0) throw httpError(404, 'hadracha not found');
    const status = normalizeStatus_(sh.getRange(row, 8).getValue());
    if (status !== 'done') throw httpError(409, 'only a done hadracha can be reopened');
    sh.getRange(row, 7).setValue('');
    sh.getRange(row, 8).setValue('planned');
    return { ok: true, id: id, status: 'planned' };
  } finally {
    lock.releaseLock();
  }
}

function cancelHadracha(body) {
  const id = requireBodyId(body);
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = sheetByName(HADRACHOT_TAB);
    const row = findRow(sh, 0, id);
    if (row < 0) throw httpError(404, 'hadracha not found');
    const status = normalizeStatus_(sh.getRange(row, 8).getValue());
    if (status !== 'planned') throw httpError(409, 'only a planned hadracha can be cancelled');
    sh.getRange(row, 8).setValue('cancelled');
    return { ok: true, id: id, status: 'cancelled' };
  } finally {
    lock.releaseLock();
  }
}

// Hard delete is allowed for PLANNED rows only (scheduler mistakes).
// Completed history is protected — it feeds getFirstHadrachaStatus and
// every cadence computation.
function deleteHadracha(body) {
  const id = requireBodyId(body);
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = sheetByName(HADRACHOT_TAB);
    const row = findRow(sh, 0, id);
    if (row < 0) throw httpError(404, 'hadracha not found');
    const status = normalizeStatus_(sh.getRange(row, 8).getValue());
    if (status !== 'planned') throw httpError(409, 'only a planned hadracha can be deleted');
    sh.deleteRow(row);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

// ---------- settings ----------

function setSetting(body) {
  const key = String((body && body.key) || '').trim();
  if (!/^[A-Za-z0-9_.-]{1,50}$/.test(key)) throw httpError(400, 'bad key');
  const value = optionalString_(body.value, NOTE_MAX);
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = sheetByName(SETTINGS_TAB);
    const row = findRow(sh, 0, key);
    if (row < 0) sh.appendRow([key, value]);
    else sh.getRange(row, 2).setValue(value);
    return { ok: true, key: key, value: value };
  } finally {
    lock.releaseLock();
  }
}

/* ============================================================
   Status feed — getFirstHadrachaStatus
   ------------------------------------------------------------
   A read-only GET endpoint for the STAFFING app:
   doGet?action=getFirstHadrachaStatus&secret=<...>.

   Auth: its OWN Script Property secret, HADRACHOT_STATUS_SECRET,
   compared in constant time. Fail-closed: property unset, secret
   missing, or secret wrong → 401 { error }, never data. The main
   SHARED_SECRET does NOT unlock this feed (and this feed's secret
   does not unlock doGet/doPost).

   Payload — one entry per person who has COMPLETED a first
   supervision (individual/refresher by name, or a group session
   whose attendance lists them):
     name               — the person's display name (the cross-app key)
     firstHadrachaDone  — always true (the staffing parser filters on it)
     firstCompletedDate — 'YYYY-MM-DD', the earliest completed date

   HARD RULE: every other field is stripped. No house, supervisor,
   quarter, schedule, status, type, cluster, id, or created_at ever
   leaves this feed.
   ============================================================ */

const HADRACHOT_STATUS_SECRET_PROP = 'HADRACHOT_STATUS_SECRET';

function statusFeedAuthorized_(e) {
  const required = PropertiesService.getScriptProperties()
    .getProperty(HADRACHOT_STATUS_SECRET_PROP);
  const provided = (e && e.parameter && e.parameter.secret) || '';
  return secretMatches_(required, provided);
}

// Entry point for the feed (dispatched from doGet). Auth first — an
// unauthorized caller gets { error } and nothing else is even read.
function handleStatusRead_(e) {
  try {
    if (!statusFeedAuthorized_(e)) return json({ error: 'unauthorized' }, 401);
    return json({ guides: computeFirstHadrachaStatus_() }, 200);
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    return json({ error: (err && err.message) || String(err) }, status);
  }
}

// One entry per person with at least one DONE session carrying a completed
// date; the date reported is the earliest one. Group sessions count for
// every name on their attendance list. Reads guide_name / completed_date /
// status / type / attendance ONLY.
function computeFirstHadrachaStatus_() {
  const firstByName = {};
  function record(name, date) {
    const n = normName_(name);
    if (!n) return;
    if (!firstByName[n] || date < firstByName[n]) firstByName[n] = date;
  }
  readHadrachotSafe().forEach(function (h) {
    if (h.status !== 'done') return;
    const date = String(h.completedDate || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    if (h.type === 'group') {
      (h.attendance || []).forEach(function (name) { record(name, date); });
    } else {
      record(h.guideName, date);
    }
  });
  const guides = Object.keys(firstByName).map(function (name) {
    return { name: name, firstHadrachaDone: true, firstCompletedDate: firstByName[name] };
  });
  guides.sort(function (a, b) { return a.name.localeCompare(b.name); });
  return guides;
}

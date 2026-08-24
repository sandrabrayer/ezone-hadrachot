'use strict';
/* Shared CLIENT-SAFE supervision logic: per-role cadences, the 30-day
   first-supervision rule, guide refreshers, house clusters for group
   sessions, per-person compliance status, and the auto-scheduler behind the
   שבץ button. The backend serves raw rows only — every compliance / overdue
   decision lives here, in the frontend (and in node --test).

   Served to the browser at GET /lib/scheduler.js and required by tests.
   NO server-only code (no process.env, no crypto, no fs) may live here.

   Cadence model (the role field on each staffing-feed entry is authoritative):
     guide          — every 14 days, GROUP sessions per house cluster
     social_worker  — every 14 days, individual
     house_manager  — every  7 days, individual
     coordinator    — every 14 days, individual
   Everyone must have a FIRST supervision within 30 days of start_date.
   Guides additionally get a רענון refresher every 3 months, individual,
   type 'refresher' — a separate track that never satisfies the regular
   cadence and is never satisfied by it.

   Dates are 'YYYY-MM-DD' strings compared lexically. All day arithmetic is
   done in UTC so no timezone can shift a boundary. */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HadrachotLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  // ---- the cadence model ----

  const ROLES = ['guide', 'social_worker', 'house_manager', 'coordinator'];

  const ROLE_CADENCE_DAYS = {
    guide: 14,
    social_worker: 14,
    house_manager: 7,
    coordinator: 14,
  };

  // A person must complete a FIRST supervision within this many days of
  // start_date. Exactly 30 days is NOT overdue (strict "exceeds").
  const FIRST_SUPERVISION_GRACE_DAYS = 30;

  // Guide refreshers — רענון: every 3 calendar months per guide, individual,
  // session type 'refresher'.
  const REFRESHER_INTERVAL_MONTHS = 3;

  // How far ahead the scheduler creates refresher rows — a refresher due
  // beyond this horizon is left for a later run so the board stays current.
  const REFRESHER_SCHEDULE_HORIZON_DAYS = 14;

  const SESSION_TYPES = ['group', 'individual', 'refresher'];
  const HADRACHA_STATUSES = ['planned', 'done', 'cancelled'];

  // ---- house clusters (group sessions) ----
  // Internal house ids are unchanged; a cluster groups houses for GROUP guide
  // sessions. Houses outside every cluster (sde_eliezer, hq) have no group
  // track — their guides are supervised individually on the same cadence.

  const CLUSTERS = [
    { id: 'kesaria', houses: ['ofroni', 'rehab'] },
    { id: 'raanana', houses: ['asher', 'pardes', 'ramot'] },
  ];
  const CLUSTER_IDS = CLUSTERS.map(function (c) { return c.id; });

  function clusterOfHouse(house) {
    const h = String(house == null ? '' : house).trim();
    for (let i = 0; i < CLUSTERS.length; i++) {
      if (CLUSTERS[i].houses.indexOf(h) >= 0) return CLUSTERS[i].id;
    }
    return '';
  }

  function clusterHouses(clusterId) {
    for (let i = 0; i < CLUSTERS.length; i++) {
      if (CLUSTERS[i].id === clusterId) return CLUSTERS[i].houses.slice();
    }
    return [];
  }

  // ---- date plumbing ----

  function isValidDate(s) { return DATE_RE.test(String(s == null ? '' : s).trim()); }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // 'YYYY-MM-DD' → UTC ms, or null on malformed input.
  function dateToUtc(s) {
    if (!isValidDate(s)) return null;
    const str = String(s).trim();
    return Date.UTC(Number(str.slice(0, 4)), Number(str.slice(5, 7)) - 1, Number(str.slice(8, 10)));
  }

  function utcToDate(ms) {
    const d = new Date(ms);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }

  function addDays(dateStr, days) {
    const ms = dateToUtc(dateStr);
    if (ms === null) return '';
    return utcToDate(ms + days * 86400000);
  }

  // Calendar months forward, day-of-month clamped to the target month's last
  // day (2026-11-30 + 3 months = 2027-02-28, never a rollover into March).
  function addMonths(dateStr, months) {
    if (!isValidDate(dateStr)) return '';
    const s = String(dateStr).trim();
    const year = Number(s.slice(0, 4));
    const month = Number(s.slice(5, 7)) - 1;
    const day = Number(s.slice(8, 10));
    const total = month + months;
    const ty = year + Math.floor(total / 12);
    const tm = ((total % 12) + 12) % 12;
    const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
    return ty + '-' + pad2(tm + 1) + '-' + pad2(Math.min(day, lastDay));
  }

  // Whole days from `from` to `to` (negative when `to` is earlier); null on
  // malformed input — callers must treat null as "cannot judge", never as 0.
  function daysBetween(from, to) {
    const a = dateToUtc(from);
    const b = dateToUtc(to);
    if (a === null || b === null) return null;
    return Math.round((b - a) / 86400000);
  }

  // The quarter column is legacy bookkeeping — writes still fill it for
  // position-mapped compatibility, but no cadence decision reads it.
  function quarterOf(dateStr) {
    if (!isValidDate(dateStr)) return '';
    const s = String(dateStr).trim();
    const month = Number(s.slice(5, 7));
    return s.slice(0, 4) + '-Q' + (Math.floor((month - 1) / 3) + 1);
  }

  // ---- names and roles ----

  // People are matched across the two apps by display name (there is no
  // shared id), so normalize whitespace before every comparison. Mirrors
  // normalizeGuideName in the staffing app's lib/calc.js.
  function normalizeGuideName(name) {
    return String(name == null ? '' : name).trim().replace(/\s+/g, ' ');
  }

  // The feed's role field is authoritative. A blank/unknown role reads as
  // 'guide' — the migration default for feed entries predating roles.
  function normalizeRole(role) {
    const r = String(role == null ? '' : role).trim();
    return ROLES.indexOf(r) >= 0 ? r : 'guide';
  }

  // A session row's type; blank (legacy rows) reads as 'individual'.
  function sessionTypeOf(session) {
    const t = String((session && session.type) || '').trim();
    return SESSION_TYPES.indexOf(t) >= 0 ? t : 'individual';
  }

  // Attendance on a group session: the sheet stores a comma-separated string,
  // the UI works with arrays. Accept both, normalized.
  function attendanceList(session) {
    const raw = session && session.attendance;
    const parts = Array.isArray(raw) ? raw : String(raw || '').split(',');
    const out = [];
    parts.forEach(function (p) {
      const n = normalizeGuideName(p);
      if (n && out.indexOf(n) < 0) out.push(n);
    });
    return out;
  }

  // ---- coverage: which completed sessions count for whom ----

  // A completed session covers `name` on the REGULAR track when it is an
  // individual session for them, or a group session they attended.
  // Refreshers are a separate track and never count here.
  function sessionCoversRegular(session, name) {
    if (!session || session.status !== 'done' || !isValidDate(session.completedDate)) return false;
    const t = sessionTypeOf(session);
    if (t === 'refresher') return false;
    if (t === 'group') return attendanceList(session).indexOf(name) >= 0;
    return normalizeGuideName(session.guideName) === name;
  }

  function sessionCoversRefresher(session, name) {
    if (!session || session.status !== 'done' || !isValidDate(session.completedDate)) return false;
    return sessionTypeOf(session) === 'refresher'
      && normalizeGuideName(session.guideName) === name;
  }

  function latestDate(dates) {
    let out = '';
    dates.forEach(function (d) { if (d > out) out = d; });
    return out;
  }

  // Latest completed REGULAR supervision date for a person ('' when none).
  function lastCompletedFor(name, sessions) {
    const n = normalizeGuideName(name);
    return latestDate((sessions || [])
      .filter(function (s) { return sessionCoversRegular(s, n); })
      .map(function (s) { return s.completedDate; }));
  }

  // Latest completed refresher date for a guide ('' when none).
  function lastRefresherFor(name, sessions) {
    const n = normalizeGuideName(name);
    return latestDate((sessions || [])
      .filter(function (s) { return sessionCoversRefresher(s, n); })
      .map(function (s) { return s.completedDate; }));
  }

  // ---- the 30-day first-supervision rule ----

  function firstSupervisionDeadline(startDate) {
    if (!isValidDate(startDate)) return '';
    return addDays(startDate, FIRST_SUPERVISION_GRACE_DAYS);
  }

  // Inside the first 30 days after start_date — flagged prominently in the
  // UI. Day 30 exactly is still first-month. Blank/malformed start dates are
  // never first-month — a missing date must not invent a deadline.
  function isFirstMonth(startDate, today) {
    const days = daysBetween(startDate, today);
    return days != null && days >= 0 && days <= FIRST_SUPERVISION_GRACE_DAYS;
  }

  // ---- per-person status (all compliance logic lives here) ----

  // person:   { name, house, role, active, startDate } — one feed entry.
  // sessions: raw rows [{ guideName, house, supervisorId, quarter,
  //           scheduledDate, completedDate, status, type, cluster,
  //           attendance }].
  // today:    'YYYY-MM-DD'.
  //
  // Returns {
  //   role, cadenceDays,
  //   cluster        — the guide's house cluster ('' for other roles and
  //                    unclustered houses),
  //   sessionType    — 'group' for clustered guides, else 'individual',
  //   lastDone       — latest completed regular supervision ('' when none),
  //   nextDue        — lastDone + cadence, or start_date + 30 when never
  //                    supervised ('' when neither is known),
  //   overdue        — today is strictly past nextDue,
  //   daysOverdue    — whole days past nextDue (0 when not overdue),
  //   firstMonth     — within 30 days of start_date,
  //   deadline       — start_date + 30 while never supervised ('' after),
  //   planned        — the earliest live planned session covering them
  //                    (individual for them, or a group session of their
  //                    cluster), or null,
  //   nextRefresherDue / refresherOverdue / plannedRefresher — the refresher
  //                    track (guides only; '' / false / null otherwise),
  // }
  function personStatus(person, sessions, today) {
    const name = normalizeGuideName(person && person.name);
    const role = normalizeRole(person && person.role);
    const cadenceDays = ROLE_CADENCE_DAYS[role];
    const cluster = role === 'guide' ? clusterOfHouse(person && person.house) : '';
    const sessionType = cluster ? 'group' : 'individual';
    const live = (sessions || []).filter(function (s) { return s && s.status !== 'cancelled'; });
    const startDate = String((person && person.startDate) || '');

    const lastDone = lastCompletedFor(name, live);
    let nextDue = '';
    if (lastDone) nextDue = addDays(lastDone, cadenceDays);
    else if (isValidDate(startDate)) nextDue = firstSupervisionDeadline(startDate);

    let overdue = false;
    let daysOverdue = 0;
    if (nextDue) {
      const past = daysBetween(nextDue, today);
      if (past != null && past > 0) { overdue = true; daysOverdue = past; }
    }

    const plannedRows = live
      .filter(function (s) {
        if (s.status !== 'planned') return false;
        const t = sessionTypeOf(s);
        if (t === 'individual') return normalizeGuideName(s.guideName) === name;
        if (t === 'group') return cluster !== '' && s.cluster === cluster;
        return false;
      })
      .sort(function (a, b) {
        return String(a.scheduledDate || '').localeCompare(String(b.scheduledDate || ''));
      });

    const out = {
      role: role,
      cadenceDays: cadenceDays,
      cluster: cluster,
      sessionType: sessionType,
      lastDone: lastDone,
      nextDue: nextDue,
      overdue: overdue,
      daysOverdue: daysOverdue,
      firstMonth: isFirstMonth(startDate, today),
      deadline: !lastDone ? firstSupervisionDeadline(startDate) : '',
      planned: plannedRows.length ? plannedRows[0] : null,
      nextRefresherDue: '',
      refresherOverdue: false,
      plannedRefresher: null,
    };

    if (role === 'guide') {
      const lastRef = lastRefresherFor(name, live);
      let refDue = '';
      if (lastRef) refDue = addMonths(lastRef, REFRESHER_INTERVAL_MONTHS);
      else if (isValidDate(startDate)) refDue = addMonths(startDate, REFRESHER_INTERVAL_MONTHS);
      out.nextRefresherDue = refDue;
      if (refDue) {
        const past = daysBetween(refDue, today);
        out.refresherOverdue = past != null && past > 0;
      }
      const plannedRef = live
        .filter(function (s) {
          return s.status === 'planned' && sessionTypeOf(s) === 'refresher'
            && normalizeGuideName(s.guideName) === name;
        })
        .sort(function (a, b) {
          return String(a.scheduledDate || '').localeCompare(String(b.scheduledDate || ''));
        });
      out.plannedRefresher = plannedRef.length ? plannedRef[0] : null;
    }

    return out;
  }

  // ---- supervisors ----

  // The sheet stores houses as a comma-separated string; the UI works with
  // arrays. Accept both.
  function supervisorHouses(supervisor) {
    if (!supervisor) return [];
    if (Array.isArray(supervisor.houses)) return supervisor.houses.filter(Boolean);
    return String(supervisor.houses || '').split(',')
      .map(function (h) { return h.trim(); })
      .filter(Boolean);
  }

  function supervisorCovers(supervisor, house) {
    return supervisorHouses(supervisor).indexOf(house) >= 0;
  }

  // Roles a supervisor can supervise. A blank list (legacy rows) reads as ALL
  // roles — existing supervisors keep working unchanged.
  function supervisorRoles(supervisor) {
    if (!supervisor) return [];
    const raw = Array.isArray(supervisor.roles)
      ? supervisor.roles
      : String(supervisor.roles || '').split(',');
    const out = [];
    raw.forEach(function (r) {
      const v = String(r == null ? '' : r).trim();
      if (ROLES.indexOf(v) >= 0 && out.indexOf(v) < 0) out.push(v);
    });
    return out.length ? out : ROLES.slice();
  }

  function supervisorCanRole(supervisor, role) {
    return supervisorRoles(supervisor).indexOf(normalizeRole(role)) >= 0;
  }

  // Capability flags. Legacy rows (undefined) default to group+individual
  // true and refresher false — pre-rework supervisors delivered supervisions,
  // refreshers are a new capability granted explicitly.
  function deliversGroup(s) { return !s || s.deliversGroup === undefined ? true : s.deliversGroup === true; }
  function deliversIndividual(s) { return !s || s.deliversIndividual === undefined ? true : s.deliversIndividual === true; }
  function deliversRefresher(s) { return !!(s && s.deliversRefresher === true); }

  // ---- the auto-scheduler — שבץ ----

  // opts: { people, supervisors, sessions, today }
  //
  // Per-role generation, respecting existing completed sessions:
  //   * guides in a cluster — ONE group session per cluster per 14 days: if
  //     the cluster has no live planned group session, schedule one at the
  //     most urgent member's next-due date (never before today), assigned to
  //     an active supervisor who delivers group sessions and supervises
  //     guides;
  //   * guides outside every cluster, and every other role — one individual
  //     session per person per their cadence, same skip-if-planned rule,
  //     assigned to a supervisor who delivers individual supervisions and
  //     covers the person's role;
  //   * guide refreshers — when the next refresher is due within 14 days,
  //     one 'refresher' row per guide assigned to a supervisor who delivers
  //     refreshers — אולגה by default.
  //
  // A person never supervised is scheduled IMMEDIATELY (today) with the
  // 30-day deadline attached for display. Supervisor choice prefers house
  // coverage and balances load against max_per_quarter by ratio (then lowest
  // absolute load, then name). People or clusters no capable supervisor can
  // absorb land in `unassigned`, never silently dropped.
  //
  // Returns { assignments: [{ type, cluster, guideName, guideNames, role,
  //           house, supervisorId, quarter, scheduledDate, deadline }],
  //           unassigned: [{ type, cluster, guideName, role, house }] }.
  function scheduleSessions(opts) {
    const people = (opts && opts.people) || [];
    const supervisors = (opts && opts.supervisors) || [];
    const sessions = (opts && opts.sessions) || [];
    const today = (opts && opts.today) || '';

    const live = sessions.filter(function (s) { return s && s.status !== 'cancelled'; });

    // Deduped active people, one entry per name+role.
    const seen = {};
    const active = [];
    people.forEach(function (p) {
      if (!p || p.active === false) return;
      const name = normalizeGuideName(p.name);
      if (!name) return;
      const role = normalizeRole(p.role);
      const key = name + '|' + role;
      if (seen[key]) return;
      seen[key] = true;
      active.push({
        name: name, role: role,
        house: String(p.house || ''), startDate: String(p.startDate || ''),
      });
    });

    // Supervisor pool with per-run load bookkeeping. Load is measured in the
    // current quarter against max_per_quarter — a coarse capacity cap.
    const quarter = quarterOf(today);
    const pool = supervisors.filter(function (s) { return s && s.active !== false; });
    const load = {};
    pool.forEach(function (s) {
      load[s.id] = live.filter(function (h) {
        return h.supervisorId === s.id && h.quarter === quarter;
      }).length;
    });

    function maxOf(s) {
      const n = Number(s.maxPerQuarter);
      return Number.isFinite(n) && n > 0 ? n : 0;
    }

    // Pick the least-loaded capable supervisor, preferring house coverage.
    function pick(capable, houses) {
      const withCapacity = capable.filter(function (s) { return load[s.id] < maxOf(s); });
      if (!withCapacity.length) return null;
      const sameHouse = withCapacity.filter(function (s) {
        return houses.some(function (h) { return supervisorCovers(s, h); });
      });
      const candidates = sameHouse.length ? sameHouse : withCapacity;
      candidates.sort(function (a, b) {
        const ra = load[a.id] / maxOf(a);
        const rb = load[b.id] / maxOf(b);
        if (ra !== rb) return ra - rb;
        if (load[a.id] !== load[b.id]) return load[a.id] - load[b.id];
        return String(a.name || '').localeCompare(String(b.name || ''), 'he');
      });
      return candidates[0];
    }

    // '' = never supervised = schedule IMMEDIATELY (clamped to today) — the
    // 30-day deadline is a limit, not a target date to wait for.
    function dueFor(p) {
      const lastDone = lastCompletedFor(p.name, live);
      if (lastDone) return addDays(lastDone, ROLE_CADENCE_DAYS[p.role]);
      return '';
    }

    function clampToToday(d) { return d && d > today ? d : today; }

    const assignments = [];
    const unassigned = [];

    // -- group sessions, one per cluster --
    CLUSTERS.forEach(function (c) {
      const members = active.filter(function (p) {
        return p.role === 'guide' && c.houses.indexOf(p.house) >= 0;
      });
      if (!members.length) return;
      const hasPlanned = live.some(function (s) {
        return s.status === 'planned' && sessionTypeOf(s) === 'group' && s.cluster === c.id;
      });
      if (hasPlanned) return;
      // The most urgent member drives the date; a never-supervised member
      // ('' due) pulls the whole cluster to today.
      const dues = members.map(dueFor);
      const scheduledDate = dues.some(function (d) { return !d; })
        ? today
        : clampToToday(dues.sort()[0]);
      const sup = pick(pool.filter(function (s) {
        return deliversGroup(s) && supervisorCanRole(s, 'guide');
      }), c.houses);
      if (!sup) {
        unassigned.push({ type: 'group', cluster: c.id, guideName: '', role: 'guide', house: '' });
        return;
      }
      load[sup.id]++;
      assignments.push({
        type: 'group', cluster: c.id,
        guideName: '', guideNames: members.map(function (p) { return p.name; }),
        role: 'guide', house: '',
        supervisorId: sup.id,
        quarter: quarterOf(scheduledDate),
        scheduledDate: scheduledDate,
        deadline: '',
      });
    });

    // -- individual sessions: non-guide roles + unclustered guides --
    const individuals = active.filter(function (p) {
      return p.role !== 'guide' || clusterOfHouse(p.house) === '';
    });
    // Most urgent first (unknown due = never supervised without a start date
    // = schedule now), then by name — a stable, testable order.
    individuals.sort(function (a, b) {
      const da = dueFor(a) || today;
      const db = dueFor(b) || today;
      if (da !== db) return da.localeCompare(db);
      return a.name.localeCompare(b.name, 'he');
    });
    individuals.forEach(function (p) {
      const hasPlanned = live.some(function (s) {
        return s.status === 'planned' && sessionTypeOf(s) === 'individual'
          && normalizeGuideName(s.guideName) === p.name;
      });
      if (hasPlanned) return;
      const scheduledDate = clampToToday(dueFor(p));
      const sup = pick(pool.filter(function (s) {
        return deliversIndividual(s) && supervisorCanRole(s, p.role);
      }), [p.house]);
      if (!sup) {
        unassigned.push({ type: 'individual', cluster: '', guideName: p.name, role: p.role, house: p.house });
        return;
      }
      load[sup.id]++;
      const neverDone = !lastCompletedFor(p.name, live);
      assignments.push({
        type: 'individual', cluster: '',
        guideName: p.name, guideNames: [p.name],
        role: p.role, house: p.house,
        supervisorId: sup.id,
        quarter: quarterOf(scheduledDate),
        scheduledDate: scheduledDate,
        deadline: neverDone ? firstSupervisionDeadline(p.startDate) : '',
      });
    });

    // -- guide refreshers, when due within the horizon --
    const horizon = addDays(today, REFRESHER_SCHEDULE_HORIZON_DAYS);
    active.filter(function (p) { return p.role === 'guide'; }).forEach(function (p) {
      const lastRef = lastRefresherFor(p.name, live);
      let due = '';
      if (lastRef) due = addMonths(lastRef, REFRESHER_INTERVAL_MONTHS);
      else if (isValidDate(p.startDate)) due = addMonths(p.startDate, REFRESHER_INTERVAL_MONTHS);
      if (!due || due > horizon) return;
      const hasPlanned = live.some(function (s) {
        return s.status === 'planned' && sessionTypeOf(s) === 'refresher'
          && normalizeGuideName(s.guideName) === p.name;
      });
      if (hasPlanned) return;
      const scheduledDate = clampToToday(due);
      const sup = pick(pool.filter(deliversRefresher), [p.house]);
      if (!sup) {
        unassigned.push({ type: 'refresher', cluster: '', guideName: p.name, role: 'guide', house: p.house });
        return;
      }
      load[sup.id]++;
      assignments.push({
        type: 'refresher', cluster: '',
        guideName: p.name, guideNames: [p.name],
        role: 'guide', house: p.house,
        supervisorId: sup.id,
        quarter: quarterOf(scheduledDate),
        scheduledDate: scheduledDate,
        deadline: '',
      });
    });

    return { assignments: assignments, unassigned: unassigned };
  }

  return {
    ROLES: ROLES,
    ROLE_CADENCE_DAYS: ROLE_CADENCE_DAYS,
    FIRST_SUPERVISION_GRACE_DAYS: FIRST_SUPERVISION_GRACE_DAYS,
    REFRESHER_INTERVAL_MONTHS: REFRESHER_INTERVAL_MONTHS,
    REFRESHER_SCHEDULE_HORIZON_DAYS: REFRESHER_SCHEDULE_HORIZON_DAYS,
    SESSION_TYPES: SESSION_TYPES,
    HADRACHA_STATUSES: HADRACHA_STATUSES,
    CLUSTERS: CLUSTERS,
    CLUSTER_IDS: CLUSTER_IDS,
    clusterOfHouse: clusterOfHouse,
    clusterHouses: clusterHouses,
    isValidDate: isValidDate,
    addDays: addDays,
    addMonths: addMonths,
    daysBetween: daysBetween,
    quarterOf: quarterOf,
    normalizeGuideName: normalizeGuideName,
    normalizeRole: normalizeRole,
    sessionTypeOf: sessionTypeOf,
    attendanceList: attendanceList,
    sessionCoversRegular: sessionCoversRegular,
    sessionCoversRefresher: sessionCoversRefresher,
    lastCompletedFor: lastCompletedFor,
    lastRefresherFor: lastRefresherFor,
    firstSupervisionDeadline: firstSupervisionDeadline,
    isFirstMonth: isFirstMonth,
    personStatus: personStatus,
    supervisorHouses: supervisorHouses,
    supervisorCovers: supervisorCovers,
    supervisorRoles: supervisorRoles,
    supervisorCanRole: supervisorCanRole,
    deliversGroup: deliversGroup,
    deliversIndividual: deliversIndividual,
    deliversRefresher: deliversRefresher,
    scheduleSessions: scheduleSessions,
  };
});

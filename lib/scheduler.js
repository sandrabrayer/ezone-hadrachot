'use strict';
/* Shared CLIENT-SAFE hadrachot logic: calendar-quarter math, the 7-day
   new-guide rule, per-guide compliance status, and the auto-scheduler behind
   the שבץ רבעון button. The backend serves raw rows only — every compliance /
   overdue decision lives here, in the frontend (and in node --test).

   Served to the browser at GET /lib/scheduler.js and required by tests.
   NO server-only code (no process.env, no crypto, no fs) may live here.

   Dates are 'YYYY-MM-DD' strings compared lexically; quarters are 'YYYY-Qn'.
   All day arithmetic is done in UTC so no timezone can shift a boundary. */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HadrachotLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const QUARTER_RE = /^\d{4}-Q[1-4]$/;

  // A guide inside their first quarter must complete a FIRST hadracha within
  // this many days of start_date. Exactly 7 days is NOT overdue (strict
  // "exceeds") — mirrors FIRST_HADRACHA_GRACE_DAYS in the staffing app.
  const FIRST_HADRACHA_GRACE_DAYS = 7;

  const HADRACHA_STATUSES = ['planned', 'done', 'cancelled'];

  function isValidDate(s) { return DATE_RE.test(String(s == null ? '' : s).trim()); }
  function isValidQuarter(s) { return QUARTER_RE.test(String(s == null ? '' : s).trim()); }

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

  // Whole days from `from` to `to` (negative when `to` is earlier); null on
  // malformed input — callers must treat null as "cannot judge", never as 0.
  function daysBetween(from, to) {
    const a = dateToUtc(from);
    const b = dateToUtc(to);
    if (a === null || b === null) return null;
    return Math.round((b - a) / 86400000);
  }

  // ---- quarter math (calendar quarters) ----

  function quarterOf(dateStr) {
    if (!isValidDate(dateStr)) return '';
    const s = String(dateStr).trim();
    const month = Number(s.slice(5, 7));
    return s.slice(0, 4) + '-Q' + (Math.floor((month - 1) / 3) + 1);
  }

  function quarterStart(quarter) {
    if (!isValidQuarter(quarter)) return '';
    const n = Number(String(quarter).trim().slice(6));
    return String(quarter).trim().slice(0, 4) + '-' + pad2((n - 1) * 3 + 1) + '-01';
  }

  function quarterEnd(quarter) {
    if (!isValidQuarter(quarter)) return '';
    const q = String(quarter).trim();
    const year = Number(q.slice(0, 4));
    const endMonth = Number(q.slice(6)) * 3;
    // Day 0 of the following month = the quarter's last day.
    const lastDay = new Date(Date.UTC(year, endMonth, 0)).getUTCDate();
    return q.slice(0, 4) + '-' + pad2(endMonth) + '-' + pad2(lastDay);
  }

  // The quarter after 'YYYY-Qn' (Q4 rolls into next year's Q1).
  function nextQuarter(quarter) {
    if (!isValidQuarter(quarter)) return '';
    const q = String(quarter).trim();
    const year = Number(q.slice(0, 4));
    const n = Number(q.slice(6));
    return n === 4 ? (year + 1) + '-Q1' : year + '-Q' + (n + 1);
  }

  // ---- guide names ----

  // Guides are matched across the two apps by display name (there is no
  // shared id), so normalize whitespace before every comparison. Mirrors
  // normalizeGuideName in the staffing app's lib/calc.js.
  function normalizeGuideName(name) {
    return String(name == null ? '' : name).trim().replace(/\s+/g, ' ');
  }

  // ---- the 7-day new-guide rule ----

  // A guide is "new" while today is still inside the calendar quarter that
  // contains their start_date. Blank/malformed start dates are never "new" —
  // a missing date must not invent a deadline.
  function isNewGuide(startDate, quarter) {
    if (!isValidDate(startDate) || !isValidQuarter(quarter)) return false;
    return quarterOf(startDate) === String(quarter).trim();
  }

  function firstHadrachaDeadline(startDate) {
    if (!isValidDate(startDate)) return '';
    return addDays(startDate, FIRST_HADRACHA_GRACE_DAYS);
  }

  // ---- per-guide status (all compliance logic lives here) ----

  // guide:      { name, house, active, startDate } — one feed entry.
  // hadrachot:  raw rows [{ guideName, house, supervisorId, quarter,
  //             scheduledDate, completedDate, status }].
  // today:      'YYYY-MM-DD'.
  //
  // Returns {
  //   quarter    — the current calendar quarter,
  //   status     — 'done' | 'planned' | 'none' for the current quarter,
  //   newGuide   — inside their first quarter,
  //   deadline   — start_date + 7 days ('' unless a new guide),
  //   firstDone  — earliest completed date ever ('' when none),
  //   overdue    — needs highlighting NOW:
  //                 * new guide, no completed hadracha ever, today past the
  //                   7-day deadline (strictly more than 7 days), or
  //                 * any guide with nothing completed this quarter whose
  //                   planned hadracha's scheduled date already passed,
  //   planned    — the first planned row this quarter (or null),
  // }
  function guideStatus(guide, hadrachot, today) {
    const quarter = quarterOf(today);
    const name = normalizeGuideName(guide && guide.name);
    const mine = (hadrachot || []).filter(function (h) {
      return h && normalizeGuideName(h.guideName) === name && h.status !== 'cancelled';
    });
    const inQuarter = mine.filter(function (h) { return h.quarter === quarter; });
    const doneInQuarter = inQuarter.filter(function (h) {
      return h.status === 'done' && isValidDate(h.completedDate);
    });
    const plannedInQuarter = inQuarter
      .filter(function (h) { return h.status === 'planned'; })
      .sort(function (a, b) {
        return String(a.scheduledDate || '').localeCompare(String(b.scheduledDate || ''));
      });

    const completedDates = mine
      .filter(function (h) { return h.status === 'done' && isValidDate(h.completedDate); })
      .map(function (h) { return h.completedDate; })
      .sort();
    const firstDone = completedDates.length ? completedDates[0] : '';

    const newGuide = isNewGuide(guide && guide.startDate, quarter);
    const deadline = newGuide ? firstHadrachaDeadline(guide.startDate) : '';

    let overdue = false;
    if (newGuide && !firstDone) {
      const days = daysBetween(guide.startDate, today);
      if (days != null && days > FIRST_HADRACHA_GRACE_DAYS) overdue = true;
    }
    if (!doneInQuarter.length) {
      if (plannedInQuarter.some(function (h) {
        return isValidDate(h.scheduledDate) && h.scheduledDate < today;
      })) overdue = true;
    }

    return {
      quarter: quarter,
      status: doneInQuarter.length ? 'done' : (plannedInQuarter.length ? 'planned' : 'none'),
      newGuide: newGuide,
      deadline: deadline,
      firstDone: firstDone,
      overdue: overdue,
      planned: plannedInQuarter.length ? plannedInQuarter[0] : null,
    };
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

  // ---- the auto-scheduler (שבץ רבעון) ----

  // opts: { guides, supervisors, hadrachot, today, quarter? }
  //
  // For every ACTIVE guide with no live hadracha (planned or done) in the
  // quarter, pick a supervisor:
  //   1. only active supervisors with remaining quarterly capacity
  //      (existing non-cancelled rows this quarter + rows assigned in this
  //      run, measured against max_per_quarter) are candidates;
  //   2. prefer supervisors covering the guide's house; fall back to any
  //      supervisor with capacity when no same-house one has room;
  //   3. among candidates, take the lowest load-to-max ratio (then lowest
  //      absolute load, then name) so load stays balanced.
  //
  // New guides (first quarter) are scheduled first and IMMEDIATELY —
  // scheduled_date = today — with their 7-day deadline attached for display.
  // Everyone else is spread a week apart per supervisor, capped at quarter
  // end. A guide placed at two houses gets ONE hadracha (first entry wins).
  //
  // Returns { assignments: [{ guideName, house, supervisorId, quarter,
  //           scheduledDate, isNew, deadline }], unassigned: [{ guideName,
  //           house }] } — unassigned = every supervisor is at capacity.
  function scheduleQuarter(opts) {
    const guides = (opts && opts.guides) || [];
    const supervisors = (opts && opts.supervisors) || [];
    const hadrachot = (opts && opts.hadrachot) || [];
    const today = (opts && opts.today) || '';
    const quarter = (opts && opts.quarter) || quarterOf(today);
    const qEnd = quarterEnd(quarter);

    const covered = {};
    hadrachot.forEach(function (h) {
      if (!h || h.status === 'cancelled' || h.quarter !== quarter) return;
      covered[normalizeGuideName(h.guideName)] = true;
    });

    const seen = {};
    const need = [];
    guides.forEach(function (g) {
      if (!g || g.active === false) return;
      const name = normalizeGuideName(g.name);
      if (!name || seen[name] || covered[name]) return;
      seen[name] = true;
      need.push({ name: name, house: String(g.house || ''), startDate: String(g.startDate || '') });
    });

    // New guides first (tightest deadline), then alphabetically — a stable
    // order makes the run reproducible and testable.
    need.sort(function (a, b) {
      const an = isNewGuide(a.startDate, quarter) ? 0 : 1;
      const bn = isNewGuide(b.startDate, quarter) ? 0 : 1;
      if (an !== bn) return an - bn;
      return a.name.localeCompare(b.name, 'he');
    });

    const pool = supervisors.filter(function (s) { return s && s.active !== false; });
    const load = {};
    const assignedInRun = {};
    pool.forEach(function (s) {
      load[s.id] = hadrachot.filter(function (h) {
        return h && h.supervisorId === s.id && h.quarter === quarter && h.status !== 'cancelled';
      }).length;
      assignedInRun[s.id] = 0;
    });

    function maxOf(s) {
      const n = Number(s.maxPerQuarter);
      return Number.isFinite(n) && n > 0 ? n : 0;
    }

    function pick(house) {
      const withCapacity = pool.filter(function (s) { return load[s.id] < maxOf(s); });
      if (!withCapacity.length) return null;
      const sameHouse = withCapacity.filter(function (s) { return supervisorCovers(s, house); });
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

    const assignments = [];
    const unassigned = [];
    need.forEach(function (g) {
      const sup = pick(g.house);
      if (!sup) {
        unassigned.push({ guideName: g.name, house: g.house });
        return;
      }
      const isNew = isNewGuide(g.startDate, quarter);
      let scheduledDate;
      if (isNew) {
        scheduledDate = today;
      } else {
        scheduledDate = addDays(today, 7 * assignedInRun[sup.id]) || today;
        if (qEnd && scheduledDate > qEnd) scheduledDate = qEnd;
      }
      load[sup.id]++;
      assignedInRun[sup.id]++;
      assignments.push({
        guideName: g.name,
        house: g.house,
        supervisorId: sup.id,
        quarter: quarter,
        scheduledDate: scheduledDate,
        isNew: isNew,
        deadline: isNew ? firstHadrachaDeadline(g.startDate) : '',
      });
    });

    return { assignments: assignments, unassigned: unassigned };
  }

  return {
    FIRST_HADRACHA_GRACE_DAYS: FIRST_HADRACHA_GRACE_DAYS,
    HADRACHA_STATUSES: HADRACHA_STATUSES,
    isValidDate: isValidDate,
    isValidQuarter: isValidQuarter,
    addDays: addDays,
    daysBetween: daysBetween,
    quarterOf: quarterOf,
    quarterStart: quarterStart,
    quarterEnd: quarterEnd,
    nextQuarter: nextQuarter,
    normalizeGuideName: normalizeGuideName,
    isNewGuide: isNewGuide,
    firstHadrachaDeadline: firstHadrachaDeadline,
    guideStatus: guideStatus,
    supervisorHouses: supervisorHouses,
    supervisorCovers: supervisorCovers,
    scheduleQuarter: scheduleQuarter,
  };
});

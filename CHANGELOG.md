# Changelog — E-ZONE Hadrachot

## 1.0.0 — 2026-08-19 — initial build

A new app for tracking hadrachot for madrichim across the network's 7 houses
(ramot, asher, ofroni, rehab, pardes, sde_eliezer, hq). Same architecture as
ezone-staffing: a Node.js Express `server.js` proxying a Google Apps Script
backend bound to a Google Sheet, a single-page Hebrew RTL frontend in
`public/index.html`, PIN gate, deployed on Railway from `main`, Apps Script
deployed via clasp CI on merge.

**This app carries NO salary or money data anywhere** — not in the sheet, not
in any endpoint, not in the UI. The validators whitelist fields, so a
financial field smuggled into any payload never reaches the sheet.

### Data model (Google Sheet `1CbAEhM2PVX7f9l-zmbjhBJBrtNcOAz_8UTRAJ1PLPG8`)

The backend creates its tabs automatically on first run. All header arrays
are APPEND-ONLY and position-mapped — readers/writers map columns by
position, so new columns go on the END only, never before an existing one.

- **Supervisors**: `id | name | houses | max_per_quarter | active | created_at`
  — `houses` is a comma-separated list of house ids the supervisor covers.
  Supervisors are deactivated, never deleted (hadracha rows reference them).
- **Hadrachot**: `id | guide_name | house | supervisor_id | quarter |
  scheduled_date | completed_date | status | created_at` — `quarter` is
  `YYYY-Qn`; `status` is a raw ASCII value `planned` / `done` / `cancelled`
  with Hebrew UI labels מתוכנן / בוצע / בוטל. One live row per guide per
  quarter, enforced on write.
- **Settings**: `key | value`.

Guides are NOT stored locally. They are fetched live from the staffing
backend's `getGuidesForHadrachot` feed via `STAFFING_GUIDES_URL` +
`HADRACHOT_READ_SECRET`, through `server.js` only (the browser never sees
the feed URL or secret). Fail-closed: while unconfigured, `/api/guides`
answers 503; any upstream failure is a generic 502 — never an empty roster,
which would read as "no guide needs a hadracha".

### Features

1. **Guides board** grouped by house, each guide showing current-quarter
   hadracha status, with an overdue section highlighted at the top.
2. **Quarterly cycle** by calendar quarter — every active guide needs one
   completed hadracha per quarter. All quarter math in `lib/scheduler.js`.
3. **New-guide rule** — a guide within their first calendar quarter must
   complete a first hadracha within 7 days of `start_date`. Exactly 7 days
   is NOT overdue — strict "exceeds", mirroring the staffing app's grace
   logic. The scheduler assigns new guides immediately with the deadline
   shown.
4. **Auto-scheduler** — שבץ רבעון — for each active guide without a hadracha
   this quarter, assigns a supervisor preferring same-house coverage and
   balancing load by the ratio of assigned hadrachot to each supervisor's
   quarterly max. Runs entirely in the frontend; the confirmed plan is
   posted as one `addHadrachotBatch`. Manual override per row (supervisor
   select + date picker). Guides no supervisor can absorb are listed as
   unassigned, never silently dropped.
5. **Completion flow** — tap בוצע with a date picker defaulting to today
   — with an undo: בטל סימון reopens a mistakenly-completed row.
6. **Supervisors management** — add, edit, deactivate, with live
   current-quarter load shown against each supervisor's max.
7. **Read-only status feed for the staffing app** —
   `doGet?action=getFirstHadrachaStatus` returns only guide name +
   `firstHadrachaDone: true` + first completed hadracha date, protected by
   its own `HADRACHOT_STATUS_SECRET` Script Property, fail-closed
   (property unset / secret missing / wrong / the main SHARED_SECRET → 401,
   never data). Payload shape matches the staffing app's
   `parseHadrachotStatus` contract.

### Architecture rules

- The Apps Script backend serves RAW rows only; all compliance, overdue and
  scheduling logic lives in the frontend (`lib/scheduler.js`, shared with
  tests, served at `/lib/scheduler.js` — the only lib module exposed).
- Input validation on all write endpoints, twice: `lib/validate.js` in the
  Express proxy and mirrored validators in `Code.gs` (defense in depth).
- No secrets in code — Script Properties (`SHARED_SECRET`, optional
  `SHEET_ID`, `HADRACHOT_STATUS_SECRET`) and Railway env vars
  (`APPS_SCRIPT_URL`, `SHARED_SECRET`, `APP_PIN`, `SESSION_SECRET`,
  `STAFFING_GUIDES_URL`, `HADRACHOT_READ_SECRET`) only. Both secret gates
  compare in constant time and fail closed when unset.
- Hebrew UI with no parentheses in Hebrew strings.

### Tests (`node --test`, 74 tests)

- Scheduler logic: same-house preference, load balancing by ratio, capacity
  → unassigned, skip-existing, inactive exclusion, weekly spread capped at
  quarter end, dedupe across houses.
- Quarter math: quarter-of-date boundaries, quarter start/end for all four
  quarters, year rollover, day arithmetic across month/year/leap boundaries.
- 7-day new-guide boundary: day 7 not overdue, day 8 overdue, planned does
  not satisfy, cancelled counts as nothing, first-quarter scoping.
- Auth fail-closed: token/PIN primitives, all API routes 401 without a
  token, both Apps Script secret gates 401 when unset/wrong/crossed.
- Endpoint field filtering: `/api/guides` relays only the `guides` key;
  `getFirstHadrachaStatus` carries exactly name / firstHadrachaDone /
  firstCompletedDate (Code.gs driven in a vm sandbox); `/api/action`
  forwards only sanitized payloads.

### CI

- `test.yml` — full suite on every PR and push to `main`.
- `deploy-apps-script.yml` — same clasp CI as ezone-staffing: pushes
  `apps-script/**` on merge to `main`, redeploys the EXISTING deployment
  (stable /exec URL), then the anonymous-access smoke check (JSON, not a
  Google sign-in page) with retries — plus a guard failing loudly while
  `.clasp.json` still holds the placeholder Script ID.
- `validate-workflows.yml` — YAML validation for workflow changes.

# Changelog — E-ZONE Hadrachot

## 1.1.0 — 2026-08-24 — per-role cadences, clusters, refreshers, warm theme

The supervision model reworked from quarterly-per-guide to per-role
cadences. The staffing feed's `role` field (ASCII: `guide` /
`social_worker` / `house_manager` / `coordinator`) is authoritative and all
roles now appear on the board, not only guides.

### The new model

- **Cadences**: guide — every 14 days in GROUP sessions; social_worker —
  every 14 days individual; house_manager — every 7 days individual;
  coordinator — every 14 days individual.
- **30-day first-supervision rule**: everyone must complete a first
  supervision within 30 days of `start_date` — day 30 exactly is fine, day
  31 is overdue. Replaces the old 7-day new-guide rule everywhere,
  including the tests. People inside their first month are flagged
  prominently on the board and in the scheduler preview.
- **House clusters for group sessions**: kesaria = ofroni + rehab,
  raanana = asher + pardes + ramot. Internal house ids unchanged; display
  labels unchanged (קיסריה עפרוני, קיסריה ריהאב, רעננה אשר, רעננה הפרדס,
  רמות השבים). A group session belongs to a cluster, covers all its active
  guides, and attendance is marked per guide (checkbox row on the group
  session card, stored comma-separated, `setAttendance` action). Guides in
  houses outside every cluster (sde_eliezer, hq) are supervised
  individually on the same 14-day cadence.
- **Guide refreshers — רענון**: every 3 months per guide, individual, type
  `refresher` — a separate track that never satisfies the regular cadence
  and is never satisfied by it. The first refresher is due 3 months after
  `start_date`. The default instructor אולגה is seeded once into
  Supervisors (refresher-only, guides only; Settings key `seed.olga`
  records the seed so it never re-runs).
- **Supervisor capability flags**: delivers group sessions yes/no, delivers
  individual supervisions yes/no, delivers refreshers yes/no, plus the
  roles they can supervise. Legacy rows default to group+individual true,
  refresher false, all roles — existing supervisors keep working unchanged.
- **Scheduler שבץ — per-role generation**: one group session per cluster
  per 14 days assigned to a group-capable instructor (the most urgent
  member's due date drives the cluster date, a never-supervised member
  pulls it to today); individual sessions per person per their cadence;
  refreshers when due within 14 days. Existing completed sessions are
  respected when computing due dates; a track with a live planned session
  is skipped, never duplicated. Same-house preference and ratio-based load
  balancing against `max_per_quarter` kept. People or clusters no capable
  supervisor can absorb are listed as unassigned, never silently dropped.
- **Overdue view**: per-person next-due date and days-overdue, grouped by
  house, overdue first — with an alert section at the top sorted by days
  overdue.

### Data model — migration-safe, append-only

New columns APPENDED at the END of the header arrays only, never mid-array
(readers/writers are position-mapped). `ensureTabs_` now also appends the
missing header cells to a pre-migration sheet in place; existing rows keep
working — blank new cells read as safe defaults.

- **Hadrachot** gains `type` (group / individual / refresher; blank legacy
  cells read as individual), `cluster` (kesaria / raanana, group rows
  only) and `attendance` (comma-separated guide names). A group row has no
  single guide: `guide_name` and `house` are blank. `quarter` is kept as
  legacy bookkeeping; no cadence decision reads it.
- **Supervisors** gains `delivers_group`, `delivers_individual`,
  `delivers_refresher` and `roles`.
- The one-live-row-per-guide-per-quarter rule became one OPEN planned
  session per track: per cluster for group sessions, per person+type
  otherwise — completed history accumulates freely, the cadence needs it.
- `getFirstHadrachaStatus` counts done group sessions for every name on
  their attendance list; payload shape unchanged (name /
  firstHadrachaDone / firstCompletedDate only).

### Frontend theme

Restyled from the navy palette to a warm brown base with red and orange
accents and gold highlights for primary buttons and active states —
applied across all screens, states, badges and buttons. Dark-theme
contrast and RTL layout unchanged.

### Tests (`node --test`, 113 tests)

All cadence math rewritten: per-role next-due and days-overdue, the 30-day
boundary for every role, 3-calendar-month refresher math with day
clamping, cluster grouping and attendance-driven coverage, group session
generation per cluster, capability and role filtering, the אולגה seed,
attendance marking, and append-only header migration driven against
pre-migration sheets in a vm sandbox.

## 1.0.1 — 2026-08-22 — headless initial deployment

- New one-off workflow `create-deployment.yml` (`workflow_dispatch` only):
  creates the INITIAL Apps Script Web App deployment headlessly, so DEPLOY.md
  step 1.4 no longer needs the Apps Script editor. It verifies the manifest
  declares `webapp.executeAs: USER_DEPLOYING` + `webapp.access:
  ANYONE_ANONYMOUS` (clasp takes the web app config from the manifest),
  writes the `CLASPRC_JSON` credentials, `clasp push`es, runs `clasp deploy
  -d "production"`, and fails loudly unless clasp confirms a new VERSIONED
  deployment (`Deployed AKfyc…@<n>` — `@HEAD` does not count). The new
  deployment ID and `/exec` URL are printed prominently in the log and job
  summary with instructions to save them as the `DEPLOYMENT_ID` secret and
  `APPS_SCRIPT_EXEC_URL` variable. Ends with `clasp deployments` for the
  record and always removes the credentials from the runner, same as
  `deploy-apps-script.yml`; shares that workflow's concurrency group so a
  create never races a redeploy.
- DEPLOY.md step 1.4 rewritten around the headless flow (editor now the
  manual fallback), with a warning that re-running the one-off workflow
  mints ANOTHER deployment with ANOTHER `/exec` URL.

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

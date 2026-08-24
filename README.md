# E-ZONE Hadrachot — מעקב הדרכות

Tracking supervision sessions for the whole team across the network's 7
houses (ramot, asher, ofroni, rehab, pardes, sde_eliezer, hq). Same
architecture as [ezone-staffing](https://github.com/sandrabrayer/ezone-staffing):

```
Browser (public/index.html, Hebrew RTL SPA, PIN gate)
   │  Bearer token
   ▼
server.js (Express on Railway)
   │  ?secret=SHARED_SECRET                 │  ?secret=HADRACHOT_READ_SECRET
   ▼                                        ▼
Hadrachot Apps Script (/exec)          Staffing Apps Script (/exec)
   │                                        getGuidesForHadrachot
   ▼                                        (people are NEVER stored here)
Google Sheet (Supervisors / Hadrachot / Settings — created on first run)
```

**This app carries NO salary or money data anywhere.**

## The rules of the house

- The backend serves **raw rows only**. All cadence, compliance, overdue and
  scheduling logic lives in the frontend, in `lib/scheduler.js` — the single
  client-safe shared module, served at `/lib/scheduler.js` and unit-tested
  with `node --test`.
- The team roster comes live from the staffing app's read-only feed, through
  `server.js` only, **fail-closed**: unconfigured → 503, upstream failure →
  generic 502, never an empty roster. Each entry carries an authoritative
  ASCII `role` field: `guide` / `social_worker` / `house_manager` /
  `coordinator`.
- Every write is validated in `lib/validate.js` AND re-validated in
  `apps-script/Code.gs`. Field whitelisting means no financial field can be
  smuggled into the sheet.
- Secrets live in Script Properties and Railway env vars only. Both Apps
  Script secret gates (`SHARED_SECRET`, `HADRACHOT_STATUS_SECRET`) compare
  in constant time and fail closed while unset.
- Sheet header arrays are **append-only and position-mapped** — new columns
  at the END only.
- Hebrew UI with no parentheses in Hebrew strings.

## The supervision model

Per-role cadences — the feed's `role` field decides the track:

| role          | cadence       | session type                |
|---------------|---------------|-----------------------------|
| guide         | every 14 days | GROUP session per cluster   |
| social_worker | every 14 days | individual                  |
| house_manager | every 7 days  | individual                  |
| coordinator   | every 14 days | individual                  |

- **30-day first-supervision rule** — everyone must complete a first
  supervision within 30 days of `start_date`. Day 30 exactly is fine, day
  31 is overdue. People inside their first month are flagged prominently.
- **House clusters for group sessions** — kesaria = ofroni + rehab,
  raanana = asher + pardes + ramot (internal house ids unchanged). A group
  session belongs to a cluster and covers all its active guides; attendance
  is marked per guide. Guides in unclustered houses (sde_eliezer, hq) are
  supervised individually on the same 14-day cadence.
- **Guide refreshers — רענון** — every 3 months per guide, individual, type
  `refresher`, a separate track. The default instructor אולגה is seeded
  into Supervisors as refresher-only.
- **Supervisor capabilities** — delivers group sessions yes/no, delivers
  individual supervisions yes/no, delivers refreshers yes/no, plus the
  roles they can supervise.

## What it does

- Team board grouped by house showing per-person next-due date and
  days-overdue, overdue first, with first-month people flagged.
- Group session cards per cluster with per-guide attendance checkboxes.
- שבץ: per-role auto-scheduling — one group session per cluster per 14
  days, individual sessions per person per their cadence, refreshers when
  due — respecting existing completed sessions, capabilities and capacity;
  manual override per row.
- Completion flow: בוצע with a date picker defaulting to today.
- Supervisors screen: add, edit, deactivate, capability flags and roles.
- `getFirstHadrachaStatus`: read-only feed for the staffing app — person
  name and first completed supervision date only (group attendance counts),
  behind its own secret.

## Development

```bash
npm install
npm test          # node --test — no network, upstreams are faked
cp .env.example .env   # fill in, then:
npm start
```

Deployment (Railway + clasp CI + Script Properties): see [DEPLOY.md](DEPLOY.md).
Full build notes: [CHANGELOG.md](CHANGELOG.md).

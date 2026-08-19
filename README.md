# E-ZONE Hadrachot — מעקב הדרכות

Tracking hadrachot for madrichim across the network's 7 houses (ramot, asher,
ofroni, rehab, pardes, sde_eliezer, hq). Same architecture as
[ezone-staffing](https://github.com/sandrabrayer/ezone-staffing):

```
Browser (public/index.html, Hebrew RTL SPA, PIN gate)
   │  Bearer token
   ▼
server.js (Express on Railway)
   │  ?secret=SHARED_SECRET                 │  ?secret=HADRACHOT_READ_SECRET
   ▼                                        ▼
Hadrachot Apps Script (/exec)          Staffing Apps Script (/exec)
   │                                        getGuidesForHadrachot
   ▼                                        (guides are NEVER stored here)
Google Sheet (Supervisors / Hadrachot / Settings — created on first run)
```

**This app carries NO salary or money data anywhere.**

## The rules of the house

- The backend serves **raw rows only**. All compliance, overdue and
  scheduling logic lives in the frontend, in `lib/scheduler.js` — the single
  client-safe shared module, served at `/lib/scheduler.js` and unit-tested
  with `node --test`.
- Guides come live from the staffing app's read-only feed, through
  `server.js` only, **fail-closed**: unconfigured → 503, upstream failure →
  generic 502, never an empty roster.
- Every write is validated in `lib/validate.js` AND re-validated in
  `apps-script/Code.gs`. Field whitelisting means no financial field can be
  smuggled into the sheet.
- Secrets live in Script Properties and Railway env vars only. Both Apps
  Script secret gates (`SHARED_SECRET`, `HADRACHOT_STATUS_SECRET`) compare
  in constant time and fail closed while unset.
- Sheet header arrays are **append-only and position-mapped** — new columns
  at the END only.
- Hebrew UI with no parentheses in Hebrew strings.

## What it does

- Guides board grouped by house with each guide's current-quarter status and
  overdue highlighting at the top.
- Quarterly cycle: every active guide needs one completed hadracha per
  calendar quarter.
- New-guide rule: within their first quarter, a guide must complete a first
  hadracha within 7 days of start_date — day 7 exactly is fine, day 8 is
  overdue.
- שבץ רבעון: auto-assigns supervisors preferring same-house coverage,
  balancing load against each supervisor's quarterly max; manual override
  per row.
- Completion flow: בוצע with a date picker defaulting to today.
- Supervisors screen: add, edit, deactivate.
- `getFirstHadrachaStatus`: read-only feed for the staffing app — guide name
  and first completed hadracha date only, behind its own secret.

## Development

```bash
npm install
npm test          # node --test — no network, upstreams are faked
cp .env.example .env   # fill in, then:
npm start
```

Deployment (Railway + clasp CI + Script Properties): see [DEPLOY.md](DEPLOY.md).
Full build notes: [CHANGELOG.md](CHANGELOG.md).

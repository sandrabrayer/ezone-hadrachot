# Deploying E-ZONE Hadrachot

Two halves, same as ezone-staffing: the Apps Script backend (deployed by CI
via clasp) and the Express proxy (deployed by Railway from `main`).

## 1. Apps Script backend — one-time setup

1. Open https://script.google.com and create a project named
   `ezone-hadrachot`.
2. Copy the **Script ID** (Project settings → IDs) into `.clasp.json`,
   replacing `REPLACE_WITH_HADRACHOT_SCRIPT_ID`, and commit. The deploy
   workflow refuses to run while the placeholder is still there.
3. Set **Script Properties** (Project settings → Script properties):
   - `SHARED_SECRET` — long random hex; must match Railway's `SHARED_SECRET`.
     Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   - `HADRACHOT_STATUS_SECRET` — long random hex; unlocks ONLY the
     `getFirstHadrachaStatus` feed consumed by the staffing app. Give the
     same value to the staffing app's Railway `HADRACHOT_STATUS_SECRET`.
   - `SHEET_ID` — optional; defaults to the hadrachot sheet
     `1CbAEhM2PVX7f9l-zmbjhBJBrtNcOAz_8UTRAJ1PLPG8` baked into `Code.gs`.
4. Create the initial Web App deployment — **headless, recommended**: add
   the `CLASPRC_JSON` secret (section 2), then GitHub → Actions →
   **Create Apps Script Deployment (one-off)** → Run workflow. It pushes the
   code, creates a new versioned deployment described `production`, and
   prints the deployment ID (starts with `AKfyc`) and `/exec` URL in the log
   and job summary, with instructions to save them. The web app config —
   execute as the deploying user, access anyone anonymous — comes from
   `apps-script/appsscript.json` (`webapp.executeAs: USER_DEPLOYING`,
   `webapp.access: ANYONE_ANONYMOUS`), so no editor visit is needed.
   Re-running mints ANOTHER deployment with ANOTHER `/exec` URL — one-off
   means one-off. *(Manual alternative: Apps Script editor → Deploy → New
   deployment → Web app → execute as **Me**, who has access **Anyone**.)*
   Either way, copy the deployment ID and the `/exec` URL. The sheet's tabs
   (Supervisors / Hadrachot / Settings) are created automatically on the
   first authorized request.

## 2. clasp CI (deploys on merge to main)

GitHub → repo Settings → Secrets and variables → Actions:

- Secret `CLASPRC_JSON` — run `clasp login` locally with
  `@google/clasp@3.3.0` (version matters — 3.x credentials only) and paste
  the whole `~/.clasprc.json`. Needed by BOTH workflows, including the
  one-off deployment creator in step 1.4 — so set it first.
- Secret `DEPLOYMENT_ID` — the Web App deployment ID from step 1.4 (printed
  by the one-off workflow, or copied from Manage deployments).
- Variable `APPS_SCRIPT_EXEC_URL` — the `/exec` URL, used by the post-deploy
  smoke check that verifies the web app still answers **anonymously with
  JSON** (a programmatic redeploy can silently drop "Anyone" access and
  start serving Google's sign-in page — the check turns that into a loud
  failure).

The workflow redeploys the EXISTING deployment, so the `/exec` URL never
changes and consumers keep working. Creating that deployment in the first
place is what the one-off **Create Apps Script Deployment** workflow (step
1.4) is for — it needs only `CLASPRC_JSON`, and its log tells you exactly
what to save as `DEPLOYMENT_ID` and `APPS_SCRIPT_EXEC_URL`.

## 3. Railway (Express proxy)

Deploys from `main` using `railway.json`. Environment variables (see
`.env.example`):

| Var | Value |
| --- | --- |
| `APPS_SCRIPT_URL` | the hadrachot `/exec` URL from step 1.4 |
| `SHARED_SECRET` | same value as the Script Property |
| `APP_PIN` | the login PIN, 4-12 chars |
| `SESSION_SECRET` | long random hex, min 32 chars |
| `STAFFING_GUIDES_URL` | the STAFFING app's `/exec` URL |
| `HADRACHOT_READ_SECRET` | must match `HADRACHOT_READ_SECRET` in the STAFFING Apps Script's Script Properties |
| `SESSION_DAYS` | optional, default 7 |

The server refuses to start with any required var missing. `/api/guides` is
fail-closed: while `STAFFING_GUIDES_URL` / `HADRACHOT_READ_SECRET` are unset
it answers 503 and the UI shows an error instead of an empty roster.

## 4. Wire the staffing app to the status feed

In the STAFFING app's Railway service set:

- `HADRACHOT_STATUS_URL` = this app's `/exec` URL
- `HADRACHOT_STATUS_SECRET` = the value from step 1.3

Its dashboard banner then reads `getFirstHadrachaStatus` through its own
proxy. The feed returns only guide name, `firstHadrachaDone: true` and the
first completed hadracha date — nothing else.

'use strict';
/* Headless-browser check of the action-feedback layer in public/index.html:
   in-flight spinners, disabled controls, double-submit blocking, the
   מעבד… label + board veil on long operations, success and error toasts.

   NOT part of `npm test` (which stays network-free) — run manually:
     npm i --no-save playwright-core
     CHROMIUM=/path/to/chromium node scripts/ui-feedback-check.js
   The upstream Apps Script and staffing feed are faked in-process with an
   artificial delay so the in-flight window is wide enough to assert on. */
process.env.NODE_ENV = 'test';
process.env.APPS_SCRIPT_URL = 'https://apps-script.invalid/exec';
process.env.SHARED_SECRET = 'shared-secret-for-tests';
process.env.APP_PIN = '4321';
process.env.SESSION_SECRET = 's'.repeat(64);
process.env.STAFFING_GUIDES_URL = 'https://staffing.invalid/exec';
process.env.HADRACHOT_READ_SECRET = 'guides-read-secret';

const path = require('node:path');
const { app } = require(path.join(__dirname, '..', 'server.js'));
const { chromium } = require('playwright-core');

const SLOW_MS = 1200; // every fake upstream write takes this long
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Stateful fake upstreams. POST /action is SLOW and counts every call per
// action so double-submits are detectable. failNext makes one write fail.
const hadrachot = [];
const postCounts = {};
let failNext = false;
let idSeq = 0;
const realFetch = global.fetch;
global.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith('https://staffing.invalid')) {
    return { ok: true, status: 200, text: async () => JSON.stringify({ _status: 200, guides: [
      { name: 'דנה לוי', house: 'ofroni', role: 'guide', active: true, startDate: '2026-01-01' },
      { name: 'עדי ברק', house: 'hq', role: 'social_worker', active: true, startDate: '2026-01-01' },
    ] }) };
  }
  if (u.startsWith('https://apps-script.invalid')) {
    if (init && init.method === 'POST') {
      const body = JSON.parse(init.body);
      postCounts[body.action] = (postCounts[body.action] || 0) + 1;
      await sleep(SLOW_MS);
      if (failNext) {
        failNext = false;
        return { ok: true, status: 200, text: async () => JSON.stringify({ _status: 500, error: 'fake upstream failure' }) };
      }
      if (body.action === 'baselineBatch') {
        body.items.forEach(it => hadrachot.push({
          id: 'b' + (++idSeq), guideName: it.guideName, house: it.house, supervisorId: '',
          quarter: '2026-Q3', scheduledDate: body.completedDate, completedDate: body.completedDate,
          status: 'done', type: it.type, cluster: it.cluster, attendance: it.attendance,
        }));
        return { ok: true, status: 200, text: async () => JSON.stringify({ _status: 200, ok: true, count: body.items.length }) };
      }
      if (body.action === 'addHadracha') {
        const row = Object.assign({ id: 'h' + (++idSeq), completedDate: '', attendance: [] }, body.hadracha);
        hadrachot.push(row);
        return { ok: true, status: 200, text: async () => JSON.stringify({ _status: 200, ok: true, hadracha: row }) };
      }
      if (body.action === 'completeHadracha') {
        const row = hadrachot.find(h => h.id === body.id);
        if (row) { row.status = 'done'; row.completedDate = body.completedDate; }
        return { ok: true, status: 200, text: async () => JSON.stringify({ _status: 200, ok: true }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ _status: 200, ok: true, count: 0 }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ _status: 200, supervisors: [], hadrachot, settings: {} }) };
  }
  return realFetch(url, init);
};

(async () => {
  const server = await new Promise(res => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const executablePath = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
  const browser = await chromium.launch({ executablePath });
  const page = await browser.newPage({ viewport: { width: 1180, height: 950 } });
  const failures = [];
  const check = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name); if (!cond) failures.push(name); };

  // -- login: spinner + disabled + no double submit --
  // /api/login is served locally and resolves instantly, so throttle it at
  // the browser level to hold the in-flight window open for the assertions.
  let loginHits = 0;
  await page.route('**/api/login', async route => {
    loginHits++;
    await sleep(SLOW_MS);
    await route.continue();
  });
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.fill('#pinInput', '4321');
  await page.click('#loginBtn');
  await page.click('#loginBtn', { force: true }).catch(() => {});
  await page.waitForTimeout(150);
  check('login: button disabled while in flight', await page.$eval('#loginBtn', b => b.disabled));
  check('login: spinner shown inside the button', !!(await page.$('#loginBtn .spinner')));
  await page.waitForSelector('#appView', { state: 'visible' });
  check('login: exactly ONE login request despite the double click', loginHits === 1);
  await page.unroute('**/api/login');
  await page.waitForTimeout(400);

  // -- baseline (long op): confirm shows מעבד… + spinner, veil up, ONE post --
  await page.click('#baselineBtn');
  await page.waitForSelector('#baselineOverlay.open');
  await page.click('#baselineConfirm');
  await page.click('#baselineConfirm', { force: true }).catch(() => {});
  await page.waitForTimeout(200);
  check('baseline: confirm disabled with spinner', await page.$eval('#baselineConfirm', b => b.disabled && !!b.querySelector('.spinner')));
  check('baseline: label switched to מעבד…', (await page.textContent('#baselineConfirm')).includes('מעבד'));
  check('baseline: board veil shown during the operation', await page.$eval('#boardVeil', v => v.classList.contains('show')));
  await page.waitForFunction(() => !document.getElementById('boardVeil').classList.contains('show'), null, { timeout: 8000 });
  check('baseline: exactly ONE batched POST despite the double click', postCounts.baselineBatch === 1);
  check('baseline: success toast shown', (await page.textContent('#toast')).includes('בהצלחה'));
  check('baseline: veil hidden after refresh', !(await page.$eval('#boardVeil', v => v.classList.contains('show'))));

  // -- inline direct-complete via the modal: spinner, one submit, row flash --
  await page.waitForTimeout(2600); // let the toast clear
  const before = { add: postCounts.addHadracha || 0, complete: postCounts.completeHadracha || 0 };
  await page.click('[data-act=complete-direct]');
  await page.waitForSelector('#completeOverlay.open');
  await page.click('#completeConfirm');
  await page.click('#completeConfirm', { force: true }).catch(() => {});
  await page.waitForTimeout(200);
  check('complete: confirm disabled with spinner', await page.$eval('#completeConfirm', b => b.disabled && !!b.querySelector('.spinner')));
  await page.waitForFunction(() => !document.querySelector('#completeOverlay.open'), null, { timeout: 10000 });
  await page.waitForTimeout(300);
  check('complete: one create + one complete despite the double click',
    (postCounts.addHadracha || 0) === before.add + 1 && (postCounts.completeHadracha || 0) === before.complete + 1);
  check('complete: confirm button restored after success', await page.$eval('#completeConfirm', b => !b.disabled && !b.querySelector('.spinner')));

  // -- failure path: red toast, control re-enabled, modal stays open --
  await page.waitForTimeout(2600);
  failNext = true;
  await page.click('[data-act=complete-direct]');
  await page.waitForSelector('#completeOverlay.open');
  await page.click('#completeConfirm');
  await page.waitForFunction(() => document.getElementById('toast').classList.contains('show'), null, { timeout: 8000 });
  check('failure: red error toast shown', await page.$eval('#toast', t => t.classList.contains('error')));
  check('failure: modal stays open for retry', !!(await page.$('#completeOverlay.open')));
  check('failure: confirm button re-enabled', await page.$eval('#completeConfirm', b => !b.disabled && !b.querySelector('.spinner')));

  await browser.close(); server.close();
  console.log(failures.length ? 'UI FEEDBACK CHECK FAILED' : 'UI FEEDBACK CHECK OK');
  process.exit(failures.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

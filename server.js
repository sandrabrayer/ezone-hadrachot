'use strict';
const express = require('express');
const path = require('path');

const { signToken, verifyToken, checkPin } = require('./lib/auth');
const { validateAction } = require('./lib/validate');

const PORT = Number(process.env.PORT) || 3000;
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL || '';
const SHARED_SECRET = process.env.SHARED_SECRET || '';
const APP_PIN = process.env.APP_PIN || '';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const SESSION_DAYS = Number(process.env.SESSION_DAYS) || 7;
// The staffing app's read-only guide roster feed. Guides are NEVER stored in
// this app — every load fetches them live, through this proxy only, so the
// browser never sees the feed URL or its secret. Fail-closed: while either
// var is unset /api/guides answers 503 { error }, never an empty roster.
const STAFFING_GUIDES_URL = process.env.STAFFING_GUIDES_URL || '';
const HADRACHOT_READ_SECRET = process.env.HADRACHOT_READ_SECRET || '';

function fatal(msg) {
  console.error(`[fatal] ${msg}`);
  process.exit(1);
}

// In production, demand all secrets at startup. In tests, the module is
// required without these set — skip the check by inspecting NODE_ENV.
if (process.env.NODE_ENV !== 'test' && require.main === module) {
  if (!APPS_SCRIPT_URL) fatal('APPS_SCRIPT_URL is required');
  if (!SHARED_SECRET) fatal('SHARED_SECRET is required');
  if (!APP_PIN) fatal('APP_PIN is required');
  if (!SESSION_SECRET) fatal('SESSION_SECRET is required');
  if (SESSION_SECRET.length < 32) fatal('SESSION_SECRET must be at least 32 chars');
  if (!STAFFING_GUIDES_URL) fatal('STAFFING_GUIDES_URL is required');
  if (!HADRACHOT_READ_SECRET) fatal('HADRACHOT_READ_SECRET is required');
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '64kb' }));

// ---- static (public) but gate the index ----
app.use(express.static(path.join(__dirname, 'public'), { index: false }));
// Expose ONLY the shared client-safe module (scheduler.js). Server-only
// modules in lib/ (auth.js, validate.js) MUST NOT be exposed.
app.get('/lib/scheduler.js', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'lib', 'scheduler.js'));
});
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---- health ----
app.get('/api/health', (req, res) => {
  res.json({ ok: true, t: Date.now() });
});

// ---- login (rate-limited) ----
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX = 8;

function rateLimitLogin(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip) || { count: 0, resetAt: now + LOGIN_WINDOW_MS };
  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + LOGIN_WINDOW_MS;
  }
  entry.count++;
  loginAttempts.set(ip, entry);
  return entry.count <= LOGIN_MAX;
}

app.post('/api/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!rateLimitLogin(ip)) {
    return res.status(429).json({ error: 'יותר מדי ניסיונות. נסי שוב מאוחר יותר.' });
  }
  const pin = (req.body && req.body.pin) || '';
  if (!checkPin(String(pin), APP_PIN)) {
    return res.status(401).json({ error: 'קוד שגוי' });
  }
  const token = signToken(SESSION_SECRET, SESSION_DAYS);
  res.json({ token, expiresInDays: SESSION_DAYS });
});

// ---- auth middleware for everything below ----
function requireAuth(req, res, next) {
  const h = req.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  const token = m ? m[1] : '';
  if (!verifyToken(SESSION_SECRET, token)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// ---- Apps Script proxy (the hadrachot backend) ----
async function callAppsScript(method, body) {
  if (!APPS_SCRIPT_URL || !SHARED_SECRET) {
    throw Object.assign(new Error('server misconfigured'), { status: 500 });
  }
  const sep = APPS_SCRIPT_URL.includes('?') ? '&' : '?';
  const url = `${APPS_SCRIPT_URL}${sep}secret=${encodeURIComponent(SHARED_SECRET)}`;
  const init = {
    method,
    redirect: 'follow',
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  const resp = await fetch(url, init);
  const text = await resp.text();
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (e) {
    throw Object.assign(new Error('upstream non-JSON: ' + text.slice(0, 200)), { status: 502 });
  }
  const status = Number(parsed._status) || 200;
  delete parsed._status;
  if (status >= 400) {
    const err = new Error(parsed.error || 'upstream error');
    err.status = status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

app.get('/api/data', requireAuth, async (req, res) => {
  try {
    const data = await callAppsScript('GET');
    res.json(data);
  } catch (err) {
    console.error('[GET /api/data]', err.status || 500, err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ---- guides (live from the STAFFING backend, fail-closed) ----
// The one and only path guides enter this app. The secret is attached
// server-side; on ANY failure the client gets an error status, never an
// empty roster (an empty roster would read as "no guides need hadrachot").
app.get('/api/guides', requireAuth, async (req, res) => {
  if (!STAFFING_GUIDES_URL || !HADRACHOT_READ_SECRET) {
    return res.status(503).json({ error: 'guides feed not configured' });
  }
  try {
    const sep = STAFFING_GUIDES_URL.includes('?') ? '&' : '?';
    let url = STAFFING_GUIDES_URL;
    if (!/[?&]action=/.test(url)) url += `${sep}action=getGuidesForHadrachot`;
    url += `&secret=${encodeURIComponent(HADRACHOT_READ_SECRET)}`;
    const resp = await fetch(url, { redirect: 'follow' });
    const text = await resp.text();
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (e) {
      throw Object.assign(new Error('upstream non-JSON'), { status: 502 });
    }
    const status = Number(parsed._status) || (resp.ok ? 200 : resp.status || 502);
    if (status >= 400 || !Array.isArray(parsed.guides)) {
      throw Object.assign(new Error('upstream error ' + status), { status: 502 });
    }
    // Relay ONLY the guides key — never any other upstream field.
    res.json({ guides: parsed.guides });
  } catch (err) {
    console.error('[GET /api/guides]', err.status || 502, err.message);
    // Generic body on purpose — never echo upstream details to the browser.
    res.status(err.status || 502).json({ error: 'guides feed unavailable' });
  }
});

app.post('/api/action', requireAuth, async (req, res) => {
  let payload;
  try {
    payload = validateAction(req.body || {});
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  try {
    const result = await callAppsScript('POST', payload);
    res.json(result);
  } catch (err) {
    console.error('[POST /api/action]', err.status || 500, err.message);
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ---- 404 fallback for /api ----
app.use('/api', (req, res) => res.status(404).json({ error: 'not found' }));

// ---- start ----
if (require.main === module) {
  // Bind explicitly to 0.0.0.0 so Railway's edge router can reach us.
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`E-ZONE hadrachot server listening on 0.0.0.0:${PORT} (PORT=${PORT}, process.env.PORT=${process.env.PORT || '<unset>'})`);
  });
}

module.exports = { app, callAppsScript, _loginAttempts: loginAttempts };

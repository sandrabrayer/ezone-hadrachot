'use strict';
// CLAUDE.md must keep the "Repo footer" rule so every Claude reply to
// Sandra names the repo and branch (the app/web has no terminal status line).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const claudeMd = fs.readFileSync(path.join(__dirname, '..', 'CLAUDE.md'), 'utf8');

test('CLAUDE.md contains the repo footer rule', () => {
  assert.match(claudeMd, /^# CLAUDE\.md — ezone-hadrachot$/m);
  assert.match(claudeMd, /^## Rules$/m);
  assert.match(claudeMd, /\*\*Repo footer\.\*\*/);
  assert.ok(claudeMd.includes('`📁 Repo: sandrabrayer/ezone-hadrachot · Branch: <current branch>`'));
  assert.ok(claudeMd.includes('git branch --show-current'));
  assert.ok(claudeMd.includes('(not pushed)'));
});

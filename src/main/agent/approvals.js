'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const store = require('../store');

const DEFAULT_TIMEOUT_MS = 120000;
const MAX_LOG_ENTRIES = 1000;

/* ------------------------------------------------------------------ */
/* Activity log                                                       */
/* ------------------------------------------------------------------ */

function logPath() {
  // Keep the log beside the settings file so a relocated config (portable
  // installs, tests) keeps its history too.
  const dir = path.dirname(store.filePath());
  return path.join(dir, 'activity-log.json');
}

function readLog() {
  try {
    return JSON.parse(fs.readFileSync(logPath(), 'utf8'));
  } catch {
    return [];
  }
}

function appendLog(entry) {
  if (!store.getValue('telemetry', 'activityLog', true)) return;
  const rows = readLog();
  rows.push(entry);
  while (rows.length > MAX_LOG_ENTRIES) rows.shift();
  try {
    fs.writeFileSync(logPath(), JSON.stringify(rows, null, 2), 'utf8');
  } catch {}
}

function getLog(limit = 200) {
  const rows = readLog();
  return rows.slice(-limit).reverse();
}

function clearLog() {
  try {
    fs.writeFileSync(logPath(), '[]', 'utf8');
  } catch {}
}

/* ------------------------------------------------------------------ */
/* Approval requests                                                  */
/* ------------------------------------------------------------------ */

const pending = new Map();
let seq = 0;

/**
 * Ask the renderer to show an approval dialog and wait for the answer.
 *
 * @param {object} params
 * @param {import('electron').BrowserWindow} win
 * @param {{name:string, args:object, summary:string, risk:string, warnings:string[], step:number, purpose?:string}} params.tool
 * @returns {Promise<{approved:boolean, remember:boolean, reason?:string}>}
 */
function requestApproval(win, tool, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const id = `ap-${Date.now().toString(36)}-${(seq += 1)}`;
  const payload = {
    id,
    name: tool.name,
    args: tool.args,
    summary: tool.summary,
    risk: tool.risk,
    warnings: tool.warnings || [],
    step: tool.step,
    purpose: tool.purpose || '',
    autoDecision: null,
  };

  // A previously trusted pattern can be auto-approved, but only for the
  // narrower "allow" list the user explicitly opted into.
  if (!tool.risk || tool.risk === 'read') {
    if (store.getValue('pcControl', 'allowReadOnlyWithoutPrompt', true)) {
      return Promise.resolve({ approved: true, remember: false, reason: 'auto-read', auto: true });
    }
  }

  const allowlist = store.getValue('pcControl', 'allowlist', []) || [];
  const match = allowlist.find((entry) => matchesEntry(entry, tool));
  if (match) {
    appendLog({ at: new Date().toISOString(), tool: tool.name, risk: tool.risk, decision: 'auto-allow', matchedRule: match });
    return Promise.resolve({ approved: true, remember: false, reason: 'allowlist', auto: true });
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pending.delete(id)) {
        appendLog({ at: new Date().toISOString(), tool: tool.name, risk: tool.risk, decision: 'timeout' });
        resolve({ approved: false, reason: 'The approval request timed out, so nothing was run.' });
      }
    }, timeoutMs);

    pending.set(id, { resolve, timer, tool });
    send(win, payload);
    if (win && !win.isFocused()) {
      win.flashFrame(true);
      if (process.platform === 'darwin') app.dock?.bounce?.('informational');
    }
  });
}

function matchesEntry(entry, tool) {
  if (!entry || !entry.pattern) return false;
  if (entry.tool && entry.tool !== '*' && entry.tool !== tool.name) return false;
  const summary = String(tool.summary || '');
  const pattern = String(entry.pattern);
  if (entry.match === 'contains') return summary.toLowerCase().includes(pattern.toLowerCase());
  if (entry.match === 'prefix') return summary.toLowerCase().startsWith(pattern.toLowerCase());
  if (entry.match === 'equals') return summary.trim() === pattern;
  // 'regex'
  try {
    return new RegExp(pattern, 'i').test(summary);
  } catch {
    return false;
  }
}

function send(win, payload) {
  try {
    if (win && !win.isDestroyed()) win.webContents.send('shine:approval-request', payload);
  } catch {}
}

/**
 * Called from IPC when the user answers a dialog.
 */
function respond(id, decision) {
  const entry = pending.get(id);
  if (!entry) return { ok: false, error: 'That approval request has already expired.' };
  pending.delete(id);
  clearTimeout(entry.timer);

  const approved = decision?.approved === true;
  const remember = decision?.remember === true;

  if (approved && remember && decision?.rule) {
    const allowlist = store.getValue('pcControl', 'allowlist', []) || [];
    store.set('pcControl', {
      allowlist: [...allowlist, { ...decision.rule, tool: entry.tool.name, addedAt: new Date().toISOString() }],
    });
  }

  appendLog({
    at: new Date().toISOString(),
    tool: entry.tool.name,
    risk: entry.tool.risk,
    args: redactArgs(entry.tool.name, entry.tool.args),
    summary: entry.tool.summary,
    decision: approved ? (remember ? 'approved+remember' : 'approved') : 'denied',
    remember,
  });

  entry.resolve({
    approved,
    remember,
    reason: decision?.reason || (approved ? 'The user approved this action.' : 'The user denied this action.'),
  });

  return { ok: true };
}

function redactArgs(name, args) {
  const copy = { ...args };
  if (copy.content) copy.content = `<${String(copy.content).length} characters>`;
  if (copy.text) copy.text = `<${String(copy.text).length} characters>`;
  if (copy.key) copy.key = '***';
  return copy;
}

function rejectAll(reason = 'Shine stopped because PC Control was switched off.') {
  for (const [id, entry] of pending.entries()) {
    clearTimeout(entry.timer);
    entry.resolve({ approved: false, reason });
    pending.delete(id);
  }
}

function pendingCount() {
  return pending.size;
}

module.exports = { requestApproval, respond, rejectAll, pendingCount, appendLog, getLog, clearLog };
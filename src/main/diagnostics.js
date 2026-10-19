'use strict';

/**
 * Diagnostics helper for working on the desktop layer without DevTools.
 *
 * Enabled with:  npm start -- --debug-dump
 * Report is written to $SHINE_DIAGNOSTIC_OUT (default ./shine-diagnostics.json)
 *
 * Phase 1 installs an instrumentation recorder in the page.
 * Phase 2 dumps the state plus everything the recorder saw.
 */

const fs = require('node:fs');
const path = require('node:path');

const RECORD_SNIPPET = `(() => {
  if (window.__shineRecorder) return 'already';
  const rec = { clicks: [], keys: [], errors: [], start: Date.now() };
  window.__shineRecorder = rec;
  document.addEventListener('click', (e) => {
    const t = e.target;
    rec.clicks.push({
      at: Date.now() - rec.start,
      tag: t && t.tagName,
      cls: String((t && t.className) || '').slice(0, 60),
      text: String((t && (t.textContent || '')).trim()).slice(0, 40),
      trust: e.isTrusted,
    });
  }, true);
  document.addEventListener('keydown', (e) => {
    rec.keys.push({ at: Date.now() - rec.start, key: e.key, trust: e.isTrusted });
  }, true);
  window.addEventListener('error', (e) => {
    rec.errors.push(String((e.error && e.error.stack) || e.message).slice(0, 400));
  });
  return 'ok';
})()`;

const REPORT_SNIPPET = `(() => {
  const tb = document.querySelector('.shine-titlebar');
  const cs = tb ? getComputedStyle(tb) : null;
  return {
    recorder: window.__shineRecorder || null,
    wizardTrace: window.__wizardTrace || null,
    hasDesktopApi: typeof window.shineDesktop !== 'undefined',
    hasDesktopUi: !!window.__shineDesktopUi,
    hasDesktopGlobal: !!window.__shineDesktop,
    titlebar: tb ? { rect: tb.getBoundingClientRect().toJSON(), position: cs.position, z: cs.zIndex } : null,
    styleTags: [...document.querySelectorAll('style')].map(s => s.id || (s.textContent || '').slice(0, 30)),
    modalOpen: !!document.querySelector('.shine-modal-root.open'),
    modalTitle: (document.querySelector('.shine-modal-title') || {}).textContent || null,
    setupCompleted: null,
    bodyClasses: document.body.className,
    viewport: { w: innerWidth, h: innerHeight },
    scrollY,
  };
})()`;

function outPath() {
  return process.env.SHINE_DIAGNOSTIC_OUT || path.join(process.cwd(), 'shine-diagnostics.json');
}

function write(value, suffix) {
  const base = outPath();
  fs.writeFileSync(suffix ? base.replace(/\.json$/, `-${suffix}.json`) : base, JSON.stringify(value, null, 2), 'utf8');
}

function attach(win) {
  const run = async (label, suffix) => {
    try {
      const state = await win.webContents.executeJavaScript(REPORT_SNIPPET, true);
      let settings = null;
      try {
        settings = require('./store').all.setup;
      } catch {}
      write({ label, at: Date.now(), state, settings }, suffix);
    } catch (err) {
      write({ label, error: err.message }, suffix);
    }
  };

  win.webContents.on('dom-ready', () => {
    win.webContents.executeJavaScript(RECORD_SNIPPET, true).catch(() => {});
  });

  win.webContents.on('did-finish-load', () => {
    setTimeout(() => run('after-load', 'a'), 2500);
    setTimeout(() => run('later', 'b'), 9000);
    setTimeout(() => run('later', 'c'), 20000);
  });

  return run;
}

module.exports = { attach };
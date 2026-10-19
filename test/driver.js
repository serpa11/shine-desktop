'use strict';

/**
 * End-to-end driver used to exercise the PC Control agent without a real
 * provider key. Enabled with `--drive`.
 *
 * Env:
 *   SHINE_TEST_PROMPT     what to ask Shine (default: a PC Control request)
 *   SHINE_TEST_AUTOGRANT  1 = pre-seed an allowlist so writes auto-approve
 *   SHINE_TEST_BASEURL    mock provider base URL
 *   SHINE_TEST_DUMP       file to write a run report to
 */

const fs = require('node:fs');
const store = require('../src/main/store');

const BASE_URL = process.env.SHINE_TEST_BASEURL || 'http://127.0.0.1:8787/v1';
const PROMPT = process.env.SHINE_TEST_PROMPT || 'Check my PC and write a short report to shine-test-output.txt';
const AUTOGRANT = process.env.SHINE_TEST_AUTOGRANT === '1';
void AUTOGRANT;
const DUMP = process.env.SHINE_TEST_DUMP || '';

function seedSnippet(baseUrl) {
  const providerPatch = process.env.SHINE_TEST_NOPROVIDER === '1'
    ? "{ activeProvider: '' }"
    : `{ activeProvider: 'custom', custom: { key: 'mock-key', model: 'mock-model', baseUrl: ${JSON.stringify(baseUrl)}, authStyle: 'bearer', imageModel: '' } }`;

  return `(() => {
    const existing = (() => { try { return JSON.parse(localStorage.getItem('shineAISettings') || 'null'); } catch { return null; } })() || {};
    const settings = Object.assign(
      { activeProvider: '', openai: { key:'', model:'' }, claude: { key:'', model:'' }, gemini: { key:'', model:'' },
        grok: { key:'', model:'' }, bazaarlink: { key:'', model:'' },
        custom: { key:'', model:'', baseUrl:'', authStyle:'bearer', imageModel:'' }, removebg: { key:'' } },
      existing,
      ${providerPatch}
    );
    localStorage.setItem('shineAISettings', JSON.stringify(settings));
    return 'seeded provider=' + (settings.activeProvider || '(none)');
  })()`;
}

function report(value, name) {
  if (!DUMP) return;
  fs.writeFileSync(DUMP.replace(/\.json$/, `-${name}.json`), JSON.stringify(value, null, 2), 'utf8');
}

function attach(win) {
  let seeded = false;

  // Exercise minimise / maximise / full screen / show through the same IPC
  // path the titlebar buttons use, and record what the window actually did.
  if (process.env.SHINE_TEST_WINDOW === '1') {
    const wm = require('../src/main/window');
    const steps = [];
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const snap = (label) => steps.push({ label, ...wm.windowState(), bounds: wm.getWindow().getBounds() });

    setTimeout(async () => {
      snap('initial');
      wm.controls.minimize();
      await wait(400);
      snap('after minimize');
      wm.controls.show();
      await wait(400);
      snap('after show');

      wm.controls.toggleMaximize();
      await wait(500);
      snap('after maximize');
      wm.controls.toggleMaximize();
      await wait(500);
      snap('after restore');

      report({ windowControls: steps }, 'window');
    }, 4000);
  }

  // Open a desktop UI panel so it can be screenshotted.
  if (process.env.SHINE_TEST_UI) {
    const target = process.env.SHINE_TEST_UI;
    const script = {
      log: `window.__shineDesktop.log.open()`,
    }[target];

    const deadline = Date.now() + 30000;
    (function tryOpen() {
      if (!script) return;
      win.webContents
        .executeJavaScript('typeof window.__shineDesktop !== "undefined"', true)
        .then((ready) => {
          if (!ready) {
            if (Date.now() > deadline) return report({ error: 'desktop UI never became ready' }, 'ui-error');
            return setTimeout(tryOpen, 500);
          }
          return win.webContents.executeJavaScript(script, true).catch((e) => report({ error: e.message }, 'ui-error'));
        })
        .catch(() => {});
    })();
  }

  const runOnce = async () => {
    if (process.env.SHINE_TEST_UI) return; // UI panel mode drives instead

    // The Shine page reads its provider settings into module scope at load
    // time, so localStorage has to be written before the page boots.
    if (!seeded) {
      report(await win.webContents.executeJavaScript(seedSnippet(BASE_URL), true), 'seed');
      seeded = true;
      win.reload();
      return;
    }

    // PC Control is switched on before the window opens (see main.js) when
    // SHINE_TEST_PC is set. Wait for the renderer to pick it up; otherwise
    // just wait for the desktop layer itself.
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const ready = await win.webContents
        .executeJavaScript(
          'typeof window.__shineDesktop !== "undefined" && (!window.__shineDesktop.agent.enabled() || window.__shineDesktop.agent.enabled())',
          true
        )
        .catch(() => false);
      if (ready) break;
      await new Promise((r) => setTimeout(r, 400));
    }

    setTimeout(() => {
      win.webContents
        .executeJavaScript(`(async () => {
          if (typeof window.ask !== 'function') return 'no ask() on this page';
          await window.ask(${JSON.stringify(PROMPT)});
          return 'asked';
        })()`, true)
        .catch((err) => report({ error: err.message }, 'ask-error'));
    }, 1200);
  };

  win.webContents.on('did-finish-load', () => setTimeout(runOnce, 1500));

  // Collect whatever ends up in the conversation.
  if (process.env.SHINE_TEST_WINDOW === '1') return;
  setTimeout(async () => {
    try {
      const state = await win.webContents.executeJavaScript(
        `(() => ({
          messages: [...document.querySelectorAll('.conversation .message')].map(m => ({
            role: m.classList.contains('user') ? 'user' : 'assistant',
            text: (m.innerText || '').trim().slice(0, 400),
          })),
          modalOpen: !!document.querySelector('.shine-modal-root.open'),
          modalTitle: (document.querySelector('.shine-modal-title')||{}).textContent || null,
          pcEnabled: !!(window.__shineDesktop && window.__shineDesktop.agent.enabled()),
        }))()`,
        true
      );
      report(state, 'result');
    } catch (err) {
      report({ error: err.message }, 'result');
    }
  }, 32000);
}

module.exports = { attach };
'use strict';

/**
 * Drives a signed-in profile question through the real site to check that
 * nothing is added to what the user types.
 *
 * Run with the mock provider stopped and no AI provider configured.
 */

const path = require('node:path');

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function run(win, dump) {
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    const ready = await win.webContents
      .executeJavaScript('typeof window.__shineDesktop !== "undefined" && !!window.__shineDesktop.account', true)
      .catch(() => false);
    if (ready) break;
    await wait(400);
  }

  // Create an account so the profile is real.
  const made = await win.webContents.executeJavaScript(
    `(async () => {
      const r = await window.shineDesktop.account.signup({
        username: 'serpa11',
        password: 'a long enough password',
        displayName: 'serpa11',
        recoveryQuestion: 'First street',
        recoveryAnswer: 'Alder Way',
      });
      return r.ok ? 'created' : r.error;
    })()`,
    true
  );
  console.log('signup:', made);

  // Reload so the app boots signed-in, exactly like a fresh launch.
  win.reload();
  await wait(6000);

  const probe = await win.webContents.executeJavaScript(
    `(async () => {
      const hasApi = typeof window.__shineDesktop !== 'undefined';
      const before = hasApi && window.ask ? !!window.ask.__shineWrapped : null;
      if (hasApi) window.__shineDesktop.account.refresh();
      const after = hasApi && window.ask ? !!window.ask.__shineWrapped : null;
      const current = hasApi ? await window.shineDesktop.account.current() : null;
      return JSON.stringify({ hasApi, before, after, askType: typeof window.ask, askName: window.ask && window.ask.name, ui: typeof window.__shineDesktopUi, current, provider: JSON.parse(localStorage.getItem('shineAISettings')||'{}').activeProvider });
    })()`,
    true
  );
  console.log('state:', probe);

  // Make sure no AI provider is selected, so the non-AI path is used.
  await win.webContents.executeJavaScript(
    `(() => {
      const s = JSON.parse(localStorage.getItem('shineAISettings') || '{}');
      s.activeProvider = '';
      localStorage.setItem('shineAISettings', JSON.stringify(s));
    })()`,
    true
  );

  async function ask(text) {
    await win.webContents.executeJavaScript(
      `(async () => {
        const box = document.querySelector('.composer-wrap textarea') || document.getElementById('prompt');
        box.value = ${JSON.stringify(text)};
        box.dispatchEvent(new Event('input', { bubbles: true }));
        await window.ask();
        return 'sent';
      })()`,
      true
    );
    await wait(2500);

    return win.webContents.executeJavaScript(
      `(() => {
        const nodes = [...document.querySelectorAll('.conversation .message')];
        return nodes.slice(-2).map(n => ({
          role: n.classList.contains('user') ? 'user' : 'assistant',
          text: (n.innerText || '').trim().slice(0, 300),
        }));
      })()`,
      true
    );
  }

  const profile = await ask("what's my name");
  console.log('\nQ: "what\'s my name"');
  console.log(JSON.stringify(profile, null, 2));

  const normal = await ask('tell me a short story');
  console.log('\nQ: "tell me a short story"');
  console.log(JSON.stringify(normal, null, 2));

  require('node:fs').writeFileSync(dump, JSON.stringify({ profile, normal }, null, 2), 'utf8');
}

module.exports = { run, wait };
void path;
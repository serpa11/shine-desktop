'use strict';

/**
 * Drives PC Control end to end in the real app against the auth-enforcing
 * mock, and reports exactly where it stops.
 *
 * This is the path the user says does not work. The suspected cause was that
 * Agent.toggle() silently refuses to switch on when no provider is
 * configured, showing a toast that disappears in four seconds and leaving no
 * trace, so the button looked dead.
 *
 * Run the mock first:
 *   MOCK_REQUIRE_AUTH=sk-secret-123 node test/mock-provider.js 8787
 */

const fs = require('node:fs');

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Set by run(), so a failed run can still put the user's settings back.
let restoreOnExit = null;

/** Hands the user's provider settings back. Safe to call more than once. */
async function restoreSettings() {
  if (!restoreOnExit) return false;
  const fn = restoreOnExit;
  restoreOnExit = null;
  await fn();
  return true;
}

const CONFIGURE = `(() => {
  const s = JSON.parse(localStorage.getItem('shineAISettings') || '{}');
  s.custom = Object.assign({}, s.custom, {
    key: 'sk-secret-123',
    baseUrl: 'http://127.0.0.1:8787/v1',
    model: 'mock-model',
    authStyle: 'bearer',
    imageModel: '',
  });
  s.activeProvider = 'custom';
  localStorage.setItem('shineAISettings', JSON.stringify(s));
  return JSON.stringify(s.activeProvider);
})()`;

/**
 * Points the provider settings at the mock, and puts them back afterwards.
 *
 * The app and the dev run share %APPDATA%\Shine, localStorage included, so
 * writing the mock's URL and key here overwrote the settings the user's
 * installed app reads. That made Shine talk to a fake server and answer with
 * this script's canned replies.
 */
async function run(win, dump) {
  const result = { steps: [] };

  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const ready = await win.webContents
      .executeJavaScript('typeof window.shineDesktop !== "undefined"', true)
      .catch(() => false);
    if (ready) break;
    await wait(400);
  }

  // Whatever is there now belongs to the user. Put it back at the end, and
  // again on the way out if the run fails partway.
  const saved = await win.webContents.executeJavaScript(`localStorage.getItem('shineAISettings')`, true);
  result.savedSettings = saved ? 'captured' : 'none';

  const writeBack = async () => {
    await win.webContents
      .executeJavaScript(
        saved
          ? `localStorage.setItem('shineAISettings', ${JSON.stringify(saved)})`
          : `localStorage.removeItem('shineAISettings')`,
        true
      )
      .catch(() => {});
    console.log('provider settings restored');
  };
  const restore = writeBack;
  restoreOnExit = writeBack;

  const provider = await win.webContents.executeJavaScript(CONFIGURE, true);
  result.provider = provider;
  console.log('provider configured:', provider);
  await wait(800);

  // What does the button think is going on?
  const before = await win.webContents.executeJavaScript(
    `window.shineDesktop.pc.status().then(s => JSON.stringify({ enabled: s.enabled, maxSteps: s.maxSteps }))`,
    true
  );
  result.before = JSON.parse(before);
  console.log('status before:', before);

  // Turn it on exactly as the button does.
  const supported = await win.webContents.executeJavaScript(
    `window.shineDesktop.pc.isSupportedProvider('custom').then(s => JSON.stringify(s))`,
    true
  );
  result.supported = JSON.parse(supported);
  console.log('custom supported:', supported);

  await win.webContents.executeJavaScript(`window.shineDesktop.pc.setEnabled(true)`, true);
  await wait(600);

  const after = await win.webContents.executeJavaScript(
    `window.shineDesktop.pc.status().then(s => JSON.stringify({ enabled: s.enabled, maxSteps: s.maxSteps }))`,
    true
  );
  result.after = JSON.parse(after);
  console.log('status after enable:', after);

  // Now run a real agent request, the thing that actually has to work.
  console.log('running an agent request...');
  const outcome = await win.webContents.executeJavaScript(
    `window.shineDesktop.pc.run({
       provider: 'custom',
       model: 'mock-model',
       apiKey: 'sk-secret-123',
       baseUrl: 'http://127.0.0.1:8787/v1',
       authStyle: 'bearer',
       query: 'Tell me about this computer.',
       history: []
     }).then(r => JSON.stringify({ ok: r.ok, error: r.error, text: (r.text||'').slice(0,160), steps: r.steps, tools: (r.toolsUsed||[]).map(t => t.tool + ':' + t.decision) }))`,
    true
  );
  const parsed = JSON.parse(outcome);
  result.run = parsed;
  console.log('agent run:', outcome);

  await win.webContents.executeJavaScript(`window.shineDesktop.pc.setEnabled(false)`, true);
  await restore();

  fs.writeFileSync(dump, JSON.stringify(result, null, 2), 'utf8');

  const passed = result.after.enabled === true && parsed.ok === true;
  console.log(passed
    ? 'RESULT: PC Control switches on and runs'
    : 'RESULT: PC Control is broken');
  return passed;
}

module.exports = { run, wait, restoreSettings };

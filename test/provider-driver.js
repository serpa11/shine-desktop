'use strict';

/**
 * Drives a real provider request through the desktop app's fetch wrapper
 * against the auth-enforcing mock.
 *
 * This is the bug the user hit: "AI provider request failed: Invalid API Key"
 * on an attachment, with a key that works fine on the website.
 *
 * The website builds its request headers as a plain object literal, which has
 * no forEach. The proxy copied headers only when forEach existed, so the
 * Authorization header was silently dropped and every provider request went
 * out unauthenticated. The mock now enforces auth, so a dropped key is a
 * visible 401 rather than an invisible pass.
 *
 * Run the mock first:
 *   MOCK_REQUIRE_AUTH=sk-secret-123 node test/mock-provider.js 8787
 */

const fs = require('node:fs');

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* Configure the provider by writing the site's own settings key and
   reloading, so nothing can overwrite it. Poking the object directly does not
   stick: the page reloads aiSettings from localStorage at boot, and
   saveAISettings() reads the settings form back over it. */
const SETUP = (key) => `(() => {
  const s = JSON.parse(localStorage.getItem('shineAISettings') || '{}');
  s.custom = Object.assign({}, s.custom, {
    key: ${JSON.stringify(key)},
    baseUrl: 'http://127.0.0.1:8787/v1',
    model: 'mock-model',
    authStyle: 'bearer',
    imageModel: '',
  });
  s.activeProvider = 'custom';
  localStorage.setItem('shineAISettings', JSON.stringify(s));
  return 'ok';
})()`;

/* A plain object literal for headers, exactly as buildCustomRequest produces. */
const REQUEST = `(async () => {
  try {
    const cfg = aiSettings.custom;
    const headers = { 'Content-Type': 'application/json' };
    headers['Authorization'] = 'Bearer ' + cfg.key;
    const res = await fetch(cfg.baseUrl + '/chat/completions', {
      method: 'POST',
      headers,
      // Without this Electron's session replays the previous response, so a
      // rejected request would silently read as the one before it.
      cache: 'no-store',
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: 'user', content: 'nonce-NONCE_TOKEN' }],
      }),
    });
    const raw = await res.text();
    let data = {};
    try { data = JSON.parse(raw); } catch { /* keep raw */ }
    return JSON.stringify({
      keyInUse: cfg.key,
      headerSent: headers['Authorization'],
      status: res.status,
      ok: res.ok,
      freshResponse: raw.includes('nonce-NONCE_TOKEN'),
      error: data?.error?.message || null,
      hasContent: Boolean(data?.choices?.[0]?.message?.content),
      wrapped: Boolean(window.fetch && window.fetch.__shineWrapped),
    });
  } catch (err) {
    return JSON.stringify({ threw: err.message, wrapped: Boolean(window.fetch && window.fetch.__shineWrapped) });
  }
})()`;

async function run(win, dump) {
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    const ready = await win.webContents
      .executeJavaScript('typeof window.__shineDesktop !== "undefined"', true)
      .catch(() => false);
    if (ready) break;
    await wait(400);
  }

  const result = { steps: [] };

  async function attempt(label, key) {
    await win.webContents.executeJavaScript(SETUP(key), true);
    // Reload so the page rebuilds aiSettings from what we just stored.
    win.reload();
    await wait(9000);

    const cfg = JSON.parse(
      await win.webContents.executeJavaScript(
        `JSON.stringify({
          baseUrl: typeof aiSettings !== 'undefined' ? aiSettings.custom.baseUrl : null,
          key: typeof aiSettings !== 'undefined' ? aiSettings.custom.key : null,
          active: typeof aiSettings !== 'undefined' ? aiSettings.activeProvider : null,
        })`,
        true
      )
    );

    const nonce = `n${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const out = await win.webContents.executeJavaScript(REQUEST.split('NONCE_TOKEN').join(nonce), true);
    const parsed = JSON.parse(out);
    result.steps.push({ label, config: cfg, ...parsed });
    console.log(`${label.padEnd(11)} -> baseUrl=${cfg.baseUrl} status=${parsed.status} fresh=${parsed.freshResponse}`);
    return parsed;
  }

  const good = await attempt('valid key', 'sk-secret-123');
  const bad = await attempt('wrong key', 'sk-wrong-key');
  const none = await attempt('no key', '');

  fs.writeFileSync(dump, JSON.stringify(result, null, 2), 'utf8');

  // Guard against silently testing the wrong target: a run aimed at a real
  // provider would answer 401 for everything and look like a header failure.
  const aimedAtMock = result.steps.every((s) => s.config && /127\.0\.0\.1:8787/.test(s.config.baseUrl || ''));
  console.log(`aimed at the mock      : ${aimedAtMock}`);

  // The proof that matters: the header reaches the provider, so a valid key is
  // accepted while a wrong or missing one is rejected. The body of the reply is
  // not asserted - that depends on which canned answer the mock is scripted to
  // return, not on whether the key arrived.
  const passed =
    aimedAtMock &&
    good.wrapped === true &&
    good.ok === true &&
    bad.ok === false &&
    bad.error === 'Invalid API Key' &&
    none.ok === false &&
    none.error === 'Invalid API Key';

  console.log(`fetch wrapped by the app: ${good.wrapped}`);
  console.log(passed
    ? 'RESULT: headers are forwarded correctly'
    : 'RESULT: BROKEN - the Authorization header is being dropped');
  return passed;
}

module.exports = { run, wait };

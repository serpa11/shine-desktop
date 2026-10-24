'use strict';

/**
 * Clears a provider that points at a dead test server.
 *
 * A test run shares %APPDATA%\Shine with the installed app, so the mock's
 * address and key were written into the same localStorage the real app reads.
 * Shine then tried to reach 127.0.0.1:8787 and reported "fetch failed".
 *
 * Runs against the real userData directory, so it fixes the installed app.
 * It only clears a provider whose base URL is a loopback test address, and
 * leaves every other provider setting alone.
 */

const { app, BrowserWindow } = require('electron');

const DEAD = /^(https?:\/\/)?(127\.0\.0\.1|localhost)(:\d+)?/i;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 700 });
  try {
    await win.loadURL('https://shineai-9mr.pages.dev/');
    await new Promise((r) => setTimeout(r, 3000));

    const before = await win.webContents.executeJavaScript(`localStorage.getItem('shineAISettings') || ''`);
    console.log('BEFORE:', before || '(empty)');

    const report = await win.webContents.executeJavaScript(`(() => {
      const raw = localStorage.getItem('shineAISettings');
      if (!raw) return JSON.stringify({ changed: false, reason: 'nothing stored' });

      const s = JSON.parse(raw);
      const changed = [];

      // Only ever clear a provider pointing at a loopback test address.
      for (const [name, cfg] of Object.entries(s)) {
        if (!cfg || typeof cfg !== 'object' || !cfg.baseUrl) continue;
        if (DEAD.test(String(cfg.baseUrl))) {
          s[name] = { key: '', model: '', baseUrl: '', authStyle: 'bearer', imageModel: '' };
          changed.push(name);
        }
      }

      if (!changed.length) return JSON.stringify({ changed: false, reason: 'no test provider stored' });

      // Nothing is selected any more, so Shine cannot keep trying a dead one.
      s.activeProvider = '';
      localStorage.setItem('shineAISettings', JSON.stringify(s));
      return JSON.stringify({ changed: true, cleared: changed });
    })()`);

    console.log('REPORT:', report);

    const after = await win.webContents.executeJavaScript(`localStorage.getItem('shineAISettings') || ''`);
    console.log('AFTER :', after || '(empty)');
  } catch (err) {
    console.error('failed:', err.message);
    app.exit(1);
    return;
  }
  app.exit(0);
});

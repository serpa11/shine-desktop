'use strict';

const path = require('node:path');

const { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain, session, dialog } = require('electron');

const store = require('./store');
const windowManager = require('./window');
const agent = require('./agent');
const approvals = require('./agent/approvals');
const stt = require('./mic/stt');
const accounts = require('./accounts');
const profile = require('./profile');

const isDev = process.argv.includes('--dev');
const isDebugDump = process.argv.includes('--debug-dump');
const isDrive = process.argv.includes('--drive');

/* ------------------------------------------------------------------ */
/* Single instance                                                     */
/* ------------------------------------------------------------------ */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => windowManager.controls.show());
}

/* ------------------------------------------------------------------ */
/* Tray                                                                */
/* ------------------------------------------------------------------ */

let tray = null;

function createTray() {
  const image = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'build', 'icon.png'));
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 32, height: 32 }));

  tray.setToolTip('Shine');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Shine', click: () => windowManager.controls.show() },
      { type: 'separator' },
      {
        label: 'Control PC',
        type: 'checkbox',
        checked: agent.status().enabled,
        click: (item) => {
          agent.setEnabled(item.checked);
          broadcastPcStatus();
        },
      },
      { type: 'separator' },
      { label: 'Quit Shine', click: () => windowManager.controls.quit() },
    ])
  );
  tray.on('click', () => windowManager.controls.show());
}

function broadcastPcStatus() {
  const status = agent.status();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      try {
        win.webContents.send('shine:pc-status', status);
      } catch {
        /* the window is going away */
      }
    }
  }
  const pcItem = tray?.contextMenu?.items.find((i) => i.label === 'Control PC');
  if (pcItem) pcItem.checked = status.enabled;
}

/* ------------------------------------------------------------------ */
/* Permissions: the microphone is the site's own dictation button      */
/* ------------------------------------------------------------------ */

function configurePermissions() {
  const ses = session.defaultSession;

  ses.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const win = windowManager.getWindow();
    if (permission === 'media' && details?.mediaTypes?.includes('audio')) {
      return dialog
        .showMessageBox(win && !win.isDestroyed() ? win : undefined, {
          type: 'question',
          buttons: ['Allow', 'Block'],
          defaultId: 0,
          cancelId: 1,
          title: 'Shine needs the microphone',
          message: 'Shine wants to use your microphone so you can talk in the chat box.',
        })
        .then(({ response }) => callback(response === 0));
    }
    if (permission.startsWith('clipboard')) return callback(true);
    if (permission === 'fullscreen') return callback(true);
    if (permission === 'display-capture') return callback(true);
    return callback(false);
  });

  ses.setPermissionCheckHandler((_webContents, permission) => {
    if (permission === 'media') return true;
    if (permission.startsWith('clipboard')) return true;
    if (permission === 'fullscreen') return true;
    if (permission === 'display-capture') return true;
    return false;
  });
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

/** In-flight proxied requests, so the page's stop button can abort them. */
const inFlight = new Map();

function senderWindow(event) {
  return BrowserWindow.fromWebContents(event.sender) || windowManager.getWindow();
}

function send(win, channel, payload) {
  try {
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
  } catch {
    /* the window is going away */
  }
}

function registerIpc() {
  /* Window buttons */
  ipcMain.handle('window:minimize', () => windowManager.controls.minimize());
  ipcMain.handle('window:toggle-maximize', () => windowManager.controls.toggleMaximize());
  ipcMain.handle('window:state', () => windowManager.windowState());
  ipcMain.handle('window:quit', () => windowManager.controls.quit());

  ipcMain.handle('app:show-item', (_e, { path: p }) => {
    if (p) require('electron').shell.showItemInFolder(p);
    return { ok: true };
  });

  /* PC Control */
  ipcMain.handle('pc:status', () => agent.status());
  ipcMain.handle('pc:cancel', () => {
    agent.cancel();
    return { ok: true };
  });

  ipcMain.handle('pc:set-enabled', (_e, { enabled }) => {
    const status = agent.setEnabled(enabled);
    broadcastPcStatus();
    return status;
  });

  ipcMain.handle('pc:provider-supported', (_e, { provider }) => {
    const supported = new Set(['openai', 'claude', 'gemini', 'groq', 'openrouter', 'grok', 'bazaarlink', 'custom']);
    return { supported: supported.has(String(provider || '')) };
  });

  ipcMain.handle('pc:run', async (event, request) => {
    const win = senderWindow(event);
    try {
      const result = await agent.run(win, request || {});
      return { ok: true, ...result };
    } catch (err) {
      const message = err?.message || String(err);
      send(win, 'shine:pc-status', agent.status());
      return { ok: false, error: message };
    } finally {
      broadcastPcStatus();
    }
  });

  ipcMain.handle('approval:respond', (_e, { id, decision }) => approvals.respond(id, decision || {}));

  /* Dictation for the site's microphone button */
  ipcMain.handle('mic:transcribe', async (_event, payload) => {
    const config = store.get('mic') || {};
    const common = {
      audioBase64: payload?.audioBase64,
      model: payload?.model || config.model,
      language: payload?.language || config.language,
      modelPath: payload?.modelPath || config.voskModelPath,
      credentials: payload?.credentials || {},
    };

    let result = await stt.transcribe({ ...common, engine: payload?.engine || config.engine || 'api' });

    // If the online engine fails but a local model is present, fall back to it
    // so dictation keeps working without any settings to fiddle with.
    if (result.error && stt.voskInstalled() && stt.listVoskModels().length && common.engine !== 'vosk') {
      result = await stt.transcribe({ ...common, engine: 'vosk' });
    }

    return result.error ? { ok: false, error: result.error } : { ok: true, ...result };
  });

  /* Network proxy

     The page is served over https, so the browser refuses any http:// request
     from it - a local model such as Ollama or LM Studio on http://localhost
     just fails with "Failed to fetch", and CORS blocks custom hosts too.
     Forwarding calls through the main process removes both limits, and gives
     one place to attach the signed-in user's profile to the request. */
  ipcMain.handle('net:request', async (_event, { id, url, method, headers, body, provider }) => {
    const controller = new AbortController();
    if (id) inFlight.set(id, controller);
    try {
      let outgoingBody = body;
      let outgoingHeaders = headers || {};

      if (typeof body === 'string' && body.length) {
        const ctx = await profile.build();
        if (ctx) {
          try {
            const parsed = JSON.parse(body);
            if (profile.apply(provider, parsed, ctx)) {
              outgoingBody = JSON.stringify(parsed);
              outgoingHeaders = { ...outgoingHeaders, 'Content-Type': 'application/json' };
            }
          } catch {
            /* leave the body alone if it is not the JSON we expect */
          }
        }
      }

      const res = await fetch(url, {
        method: method || 'GET',
        headers: outgoingHeaders,
        body: outgoingBody,
        signal: controller.signal,
      });
      return { ok: true, status: res.status, body: await res.text() };
    } catch (err) {
      const cancelled = err?.name === 'AbortError';
      return { ok: false, cancelled, error: cancelled ? 'Cancelled.' : err?.message || String(err) };
    } finally {
      if (id) inFlight.delete(id);
    }
  });

  ipcMain.handle('net:cancel', (_e, { id }) => {
    try {
      inFlight.get(id)?.abort();
      inFlight.delete(id);
    } catch {}
    return { ok: true };
  });

  /* Accounts - stored on this PC, scrypt-hashed, no server involved */
  ipcMain.handle('account:current', () => accounts.current());
  ipcMain.handle('account:signup', (_e, payload) => accounts.signup(payload || {}));
  ipcMain.handle('account:signin', (_e, payload) => accounts.signin(payload || {}));
  ipcMain.handle('account:signout', () => accounts.signout());
  ipcMain.handle('account:forgot', (_e, payload) => accounts.forgotPassword(payload || {}));
  ipcMain.handle('account:recovery-question', (_e, { username }) => accounts.getRecoveryQuestion({ username }));
  ipcMain.handle('account:change-password', (_e, payload) => accounts.changePassword(payload || {}));
  ipcMain.handle('account:update-profile', (_e, payload) => accounts.updateProfile(payload || {}));
  ipcMain.handle('account:change-username', (_e, payload) => accounts.changeUsername(payload || {}));
  ipcMain.handle('account:choose-avatar', async (event, { username }) => {
    const win = senderWindow(event);
    const picked = await dialog.showOpenDialog(win && !win.isDestroyed() ? win : undefined, {
      title: 'Choose a profile picture',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
    });
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, cancelled: true };
    return accounts.setAvatar({ username, imagePath: picked.filePaths[0] });
  });
  ipcMain.handle('account:set-avatar', (_e, payload) => accounts.setAvatar(payload || {}));
  ipcMain.handle('account:clear-avatar', (_e, { username }) => accounts.clearAvatar({ username }));
  ipcMain.handle('account:avatar', async (_e, { username, size }) => {
    const account = accounts.find(username);
    const dataUrl = account ? await accounts.avatarDataUrl(account, size || 160) : null;
    return { ok: Boolean(dataUrl), dataUrl };
  });

  /* Activity log */
  ipcMain.handle('log:list', (_e, { limit } = {}) => approvals.getLog(limit));
  ipcMain.handle('log:clear', () => {
    approvals.clearLog();
    return { ok: true };
  });
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

if (typeof app.setAppUserModelId === 'function') app.setAppUserModelId('com.shine.desktop');

app.whenReady().then(() => {
  process.env.SHINE_APP_VERSION = app.getVersion();
  store.filePath();
  configurePermissions();
  registerIpc();
  createTray();

  // Test hooks: apply the switch before the window exists so the renderer
  // picks it up on its first status poll.
  if (isDrive && process.env.SHINE_TEST_PC === '1') {
    store.setValue('pcControl', 'enabled', true);
    if (process.env.SHINE_TEST_AUTOGRANT === '1') {
      store.set('pcControl', { allowlist: [{ pattern: 'shine-test-output.txt', match: 'equals', tool: 'write_file' }] });
    }
  }

  const win = windowManager.createWindow();
  if (isDebugDump) require('./diagnostics').attach(win);
  if (isDrive) require('../../test/driver').attach(win);
  if (process.argv.includes('--drive-provider')) {
    require('../../test/provider-driver')
      .run(win, process.argv[process.argv.indexOf('--drive-provider') + 1] || 'provider-result.json')
      .then((passed) => {
        console.log(passed ? 'PROVIDER_CHECK pass' : 'PROVIDER_CHECK fail');
        app.exit(passed ? 0 : 1);
      })
      .catch((err) => {
        console.error('provider driver failed:', err);
        app.exit(1);
      });
  }
  if (process.argv.includes('--drive-profile')) {
    require('../../test/profile-driver')
      .run(win, process.argv[process.argv.indexOf('--drive-profile') + 1] || 'profile-result.json')
      .then(() => app.quit())
      .catch((err) => {
        console.error('profile driver failed:', err);
        app.quit();
      });
  }

  win.webContents.on('did-finish-load', () => {
    send(win, 'shine:pc-status', agent.status());
    send(win, 'shine:window-state', windowManager.windowState());
  });

  // Development aid: capture the window itself and quit.
  // Use: electron . --shot out.png
  const shotIndex = process.argv.indexOf('--shot');
  if (shotIndex !== -1) {
    const out = process.argv[shotIndex + 1] || 'shine-shot.png';
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        // Occluded windows capture as blank, so lift it above everything.
        win.setAlwaysOnTop(true);
        win.show();
        win.focus();
        await new Promise((r) => setTimeout(r, 900));
        const image = await win.webContents.capturePage();
        require('node:fs').writeFileSync(out, image.toPNG());
        console.log(`wrote ${out}`);
        win.setAlwaysOnTop(false);
        app.quit();
      }, 3500);
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) windowManager.createWindow();
    else windowManager.controls.show();
  });
});

app.on('before-quit', () => {
  windowManager.setQuitting(true);
  agent.cancel();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

process.on('uncaughtException', (err) => console.error('[shine] uncaught exception:', err));
process.on('unhandledRejection', (reason) => console.error('[shine] unhandled rejection:', reason));

void isDev;
module.exports = { agent, store, stt };
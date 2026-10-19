'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { contextBridge, ipcRenderer, webFrame } = require('electron');

/**
 * The preload script runs in an isolated world with Node access and is the
 * only bridge between the Shine page and the desktop layer.
 *
 * It does two things:
 *   1. Exposes a small API as `window.shineDesktop`.
 *   2. Injects the window bar, approval dialog, activity log and request
 *      routing into the page's main world.
 */

const DESKTOP_DIR = path.join(__dirname, '..', 'renderer', 'desktop');

function readAsset(name) {
  try {
    return fs.readFileSync(path.join(DESKTOP_DIR, name), 'utf8');
  } catch (err) {
    console.error(`[preload] could not read ${name}:`, err.message);
    return '';
  }
}

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('shineDesktop', {
  isDesktop: true,
  platform: process.platform,
  appVersion: process.env.SHINE_APP_VERSION || '',

  /* Window buttons */
  window: {
    minimize: () => invoke('window:minimize'),
    toggleMaximize: () => invoke('window:toggle-maximize'),
    quit: () => invoke('window:quit'),
    onStateChange: (cb) => subscribe('shine:window-state', cb),
  },

  /* Small helpers used by the injected UI */
  app: {
    showItemInFolder: (p) => invoke('app:show-item', { path: p }),
  },

  /* PC Control */
  pc: {
    status: () => invoke('pc:status'),
    setEnabled: (enabled) => invoke('pc:set-enabled', { enabled }),
    cancel: () => invoke('pc:cancel'),
    run: (request) => invoke('pc:run', request),
    isSupportedProvider: (provider) => invoke('pc:provider-supported', { provider }),
    respondToApproval: (id, decision) => invoke('approval:respond', { id, decision }),
    onApprovalRequest: (cb) => subscribe('shine:approval-request', cb),
    onStatusChange: (cb) => subscribe('shine:pc-status', cb),
  },

  /* Dictation for the site's own microphone button */
  mic: {
    transcribe: (payload) => invoke('mic:transcribe', payload),
  },

  /* Network proxy: removes CORS / mixed-content limits and attaches the profile */
  net: {
    request: (payload) => invoke('net:request', payload),
    cancel: (id) => invoke('net:cancel', { id }),
  },

  /* Accounts */
  account: {
    current: () => invoke('account:current'),
    signup: (payload) => invoke('account:signup', payload),
    signin: (payload) => invoke('account:signin', payload),
    signout: () => invoke('account:signout'),
    forgot: (payload) => invoke('account:forgot', payload),
    recoveryQuestion: (username) => invoke('account:recovery-question', { username }),
    changePassword: (payload) => invoke('account:change-password', payload),
    updateProfile: (payload) => invoke('account:update-profile', payload),
    changeUsername: (payload) => invoke('account:change-username', payload),
    chooseAvatar: (username) => invoke('account:choose-avatar', { username }),
    clearAvatar: (username) => invoke('account:clear-avatar', { username }),
    avatar: (username, size) => invoke('account:avatar', { username, size }),
  },

  /* Activity log */
  log: {
    list: (limit) => invoke('log:list', { limit }),
    clear: () => invoke('log:clear'),
  },
});

/* ------------------------------------------------------------------ */
/* Inject the desktop UI into the page                                */
/* ------------------------------------------------------------------ */

const STYLE_ID = 'shine-desktop-style';

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const css = readAsset('desktop.css');
  if (!css) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = css;
  (document.head || document.documentElement).appendChild(style);
}

function injectScript() {
  const source = readAsset('desktop.js');
  if (!source) return 'desktop.js was empty';

  const runner = `(function(){ if (window.__shineDesktopUi) return 'already'; try { (0,eval)(${JSON.stringify(source)}); return 'ok'; } catch (e) { return 'error: ' + (e && e.message || e); } })()`;

  // Preferred: contextBridge runs the function directly in the page's world.
  if (typeof contextBridge.executeInMainWorld === 'function') {
    return contextBridge.executeInMainWorld({
      func: (code) => {
        try {
          // eslint-disable-next-line no-eval
          return eval(code);
        } catch (err) {
          return `error: ${err && err.message ? err.message : err}`;
        }
      },
      args: [runner],
    });
  }

  return webFrame.executeJavaScript(runner, true);
}

let injected = false;
function bootstrap() {
  if (injected) return;
  injectStyles();
  Promise.resolve(injectScript())
    .then((result) => console.log('[shine-desktop] injected:', result))
    .catch((err) => console.error('[shine-desktop] injection failed:', err));
  injected = true;
}

function startWhenReady() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
  } else {
    bootstrap();
  }
}

startWhenReady();

// If the page ever replaces its document, re-inject.
let lastUrl = location.href;
setInterval(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    injected = false;
    startWhenReady();
  }
}, 700);
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, screen, shell } = require('electron');

const store = require('./store');

const isDev = process.argv.includes('--dev');
const LOCAL_FALLBACK = path.join(__dirname, '..', '..', 'vendor', 'shine.html');
const REMOTE_ORIGIN = 'https://shineai-9mr.pages.dev';

let mainWindow = null;
let quitting = false;

/* ------------------------------------------------------------------ */
/* Edge snapping for a frameless window                                */
/* ------------------------------------------------------------------ */

let snapped = false;
let snappedEdge = null;

function clearSnap() {
  if (!snapped) return;
  snapped = false;
  safeSend(mainWindow, 'shine:window-state', windowState());
}

function updateSnap(area) {
  if (!area) {
    clearSnap();
    return;
  }
  const ratio = area.x / area.width;
  let edge = null;
  if (ratio <= 0.22) edge = 'left';
  else if (ratio >= 0.78) edge = 'right';
  if (!edge) {
    clearSnap();
    return;
  }
  if (snapped && snappedEdge === edge) return;
  clearSnap();

  const half = Math.round(area.width / 2);
  snapped = true;
  snappedEdge = edge;
  mainWindow.setBounds(
    edge === 'left'
      ? { x: area.x, y: area.y, width: half, height: area.height }
      : { x: area.x + half, y: area.y, width: area.width - half, height: area.height }
  );
  safeSend(mainWindow, 'shine:window-state', windowState());
}

/* ------------------------------------------------------------------ */
/* Window                                                              */
/* ------------------------------------------------------------------ */

function windowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return { maximized: false, focused: false, visible: false };
  return {
    maximized: mainWindow.isMaximized(),
    focused: mainWindow.isFocused(),
    visible: mainWindow.isVisible(),
    normal: mainWindow.getNormalBounds(),
  };
}

/** Send to a window that may already be gone (load races, quit, reload). */
function safeSend(win, channel, payload) {
  try {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return false;
    win.webContents.send(channel, payload);
    return true;
  } catch {
    return false;
  }
}

function createWindow() {
  const saved = store.get('window') || {};
  const width = Math.max(900, Math.min(saved.width || 1180, 6000));
  const height = Math.max(600, Math.min(saved.height || 820, 4000));

  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 860,
    minHeight: 600,
    x: saved.x,
    y: saved.y,
    show: false,
    frame: false,
    backgroundColor: '#000000',
    title: 'Shine',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true,
      backgroundThrottling: false,
      permissions: ['media', 'clipboard-read', 'clipboard-sanitized-write'],
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (saved.maximized) mainWindow.maximize();
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  mainWindow.on('maximize', () => safeSend(mainWindow, 'shine:window-state', windowState()));
  mainWindow.on('unmaximize', () => safeSend(mainWindow, 'shine:window-state', windowState()));
  mainWindow.on('focus', () => safeSend(mainWindow, 'shine:window-state', windowState()));
  mainWindow.on('blur', () => safeSend(mainWindow, 'shine:window-state', windowState()));

  // Closing the window quits.
  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    controls.quit();
  });

  const persistBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const bounds = mainWindow.getNormalBounds();
    store.set('window', { width: bounds.width, height: bounds.height, x: bounds.x, y: bounds.y, maximized: mainWindow.isMaximized() });
  };
  mainWindow.on('resized', persistBounds);
  mainWindow.on('moved', persistBounds);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const remote = store.getValue('app', 'remoteUrl', REMOTE_ORIGIN + '/');
    if (sameOrigin(url, remote) || sameOrigin(url, REMOTE_ORIGIN)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  const area = () => screen.getDisplayMatching(mainWindow.getBounds()).workArea;
  mainWindow.on('mouseenter', () => {
    snapped = false;
    snappedEdge = null;
  });
  mainWindow.on('mousemove', () => updateSnap(area()));
  mainWindow.on('mouseleave', clearSnap);

  loadContent(mainWindow);
  return mainWindow;
}

function sameOrigin(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.protocol === ub.protocol && ua.host === ub.host;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Content: live site first, bundled copy as fallback                 */
/* ------------------------------------------------------------------ */

function loadContent(win) {
  const app = store.get('app') || {};
  const remoteUrl = app.remoteUrl || `${REMOTE_ORIGIN}/`;
  const useRemote = app.useRemoteSite !== false;

  const fallback = (reason) => {
    if (win.isDestroyed() || !fs.existsSync(LOCAL_FALLBACK)) return;
    console.warn('[window] falling back to the bundled copy:', reason);
    safeSend(win, 'shine:content-mode', { mode: 'local', reason });
    win.loadFile(LOCAL_FALLBACK);
  };

  if (!useRemote) {
    if (fs.existsSync(LOCAL_FALLBACK)) win.loadFile(LOCAL_FALLBACK);
    return;
  }

  win.loadURL(remoteUrl).catch((err) => {
    if (win.isDestroyed()) return;
    console.error('[window] the live site failed to load:', err?.message || err);
    fallback('The live site could not be reached.');
  });

  win.webContents.once('did-fail-load', (_e, code, desc, url) => {
    if (url === remoteUrl) fallback(`${desc} (${code})`);
  });

  // If the live site hangs, drop to the bundled copy.
  setTimeout(() => {
    if (win.isDestroyed() || win.webContents.isLoading()) return;
    const current = win.webContents.getURL();
    if (current && !current.startsWith('file://') && current !== remoteUrl) fallback('The live site did not finish loading.');
  }, 20000);
}

/* ------------------------------------------------------------------ */
/* Window buttons                                                      */
/* ------------------------------------------------------------------ */

const controls = {
  minimize() {
    mainWindow?.minimize();
    return windowState();
  },
  toggleMaximize() {
    if (!mainWindow) return windowState();
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return windowState();
  },
  show() {
    if (!mainWindow) return windowState();
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    return windowState();
  },
  state: windowState,
  quit() {
    quitting = true;
    app.quit();
  },
};

function getWindow() {
  return mainWindow;
}

function setQuitting(value) {
  quitting = value;
}

module.exports = { createWindow, controls, getWindow, windowState, setQuitting, isDev, LOCAL_FALLBACK };
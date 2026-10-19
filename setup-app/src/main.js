'use strict';

const path = require('node:path');
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const installer = require('./installer');

const isUninstall = process.argv.includes('--uninstall');

function createWindow() {
  const win = new BrowserWindow({
    width: 660,
    height: 560,
    resizable: false,
    frame: false,
    backgroundColor: '#000000',
    title: isUninstall ? 'Uninstall Shine' : 'Shine Setup',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const pageIndex = process.argv.indexOf('--page');
  win.loadFile(path.join(__dirname, 'index.html'), {
    search: pageIndex !== -1 ? `page=${process.argv[pageIndex + 1]}` : '',
  });
  return win;
}

function registerIpc() {
  ipcMain.handle('setup:state', async () => ({
    mode: isUninstall ? 'uninstall' : 'install',
    defaultDir: installer.defaultInstallDir(),
    installed: await installer.isInstalled(installer.defaultInstallDir()),
    previous: await installer.previousInstall(),
    appName: installer.APP_NAME,
  }));

  ipcMain.handle('setup:choose-dir', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const picked = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return picked.canceled ? null : picked.filePaths[0];
  });

  ipcMain.handle('setup:check-disk', (_e, dir) => installer.checkDisk(dir));

  ipcMain.handle('setup:install', async (event, options) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return installer.install(options, (step, progress) => {
      win.webContents.send('setup:progress', { step, progress });
    });
  });

  ipcMain.handle('setup:uninstall', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return installer.uninstall((step, progress) => {
      win.webContents.send('setup:progress', { step, progress });
    });
  });

  ipcMain.handle('setup:launch', async (_e, exe) => {
    require('electron').shell.openPath(exe);
    return { ok: true };
  });

  ipcMain.handle('setup:quit', () => app.quit());

  ipcMain.handle('setup:minimize', () => {
    const win = BrowserWindow.getAllWindows()[0];
    win?.minimize();
    return { ok: true };
  });
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.shine.desktop.setup');
  registerIpc();
  const win = createWindow();
  app.on('window-all-closed', () => app.quit());

  // Development aid: capture this window itself and quit, which avoids
  // depending on window focus. Use: electron setup-app --shot out.png
  const shotIndex = process.argv.indexOf('--shot');
  if (shotIndex !== -1) {
    const out = process.argv[shotIndex + 1] || 'setup-shot.png';
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
      }, 1200);
    });
  }
});
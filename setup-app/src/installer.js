'use strict';

/**
 * Installer logic for ShineSetup.
 *
 * Copies the bundled app payload into the chosen folder, creates the shortcuts
 * the user asked for, registers itself in Add/Remove Programs, and drops an
 * uninstaller next to the app.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const APP_NAME = 'Shine';

// PowerShell registry provider paths need the "drive:" prefix. Without it,
// HKCU\Software\... is treated as a relative folder path and nothing is
// written to the registry.
const UNINSTALL_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Shine';

// Tests redirect these so they never touch the real desktop, Start Menu or
// registry.
const TEST_MODE = process.env.SHINE_INSTALLER_TEST === '1';
const TEST_KEY = 'HKCU:\\Software\\ShineInstallerTests\\Shine';
const registryKey = TEST_MODE ? TEST_KEY : UNINSTALL_KEY;

function desktopRoot() {
  return process.env.SHINE_TEST_DESKTOP_DIR || desktopDir();
}

function startMenuRoot() {
  if (process.env.SHINE_TEST_STARTMENU_DIR) return process.env.SHINE_TEST_STARTMENU_DIR;
  return startMenuDir();
}

function startupRoot() {
  if (process.env.SHINE_TEST_STARTMENU_DIR) return path.join(process.env.SHINE_TEST_STARTMENU_DIR, 'Startup');
  return startupDir();
}

/* ------------------------------------------------------------------ */
/* PowerShell                                                         */
/* ------------------------------------------------------------------ */

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runPowerShell(script, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    const payload = Buffer.from(script, 'utf16le').toString('base64');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', payload],
      { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim(), error: err })
    );
  });
}

/* ------------------------------------------------------------------ */
/* Locations                                                          */
/* ------------------------------------------------------------------ */

function defaultInstallDir() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'Programs', APP_NAME);
}

function desktopDir() {
  const candidates = [
    path.join(os.homedir(), 'Desktop'),
    path.join(os.homedir(), 'OneDrive', 'Desktop'),
    path.join(os.homedir(), 'OneDrive', 'Bureau'),
  ];
  return candidates.find((dir) => fs.existsSync(dir)) || path.join(os.homedir(), 'Desktop');
}

function startMenuDir() {
  const appData = process.env.APPDATA;
  if (!appData) return null;
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
}

function startupDir() {
  const appData = process.env.APPDATA;
  if (!appData) return null;
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

function payloadZip() {
  // Packaged next to the app's resources; in development it sits in the repo.
  const packaged = path.join(process.resourcesPath || '', 'payload', 'shine-app.zip');
  if (fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, '..', '..', 'release-payload', 'shine-app.zip');
}

/* ------------------------------------------------------------------ */
/* Steps                                                              */
/* ------------------------------------------------------------------ */

async function checkDisk(dir) {
  const bytesNeeded = 420 * 1024 * 1024;
  let free = null;
  try {
    const stats = await fsp.statfs(path.dirname(dir));
    free = stats.bavail * stats.bsize;
  } catch {
    /* ignore */
  }
  return { ok: free === null || free > bytesNeeded, free, bytesNeeded };
}

async function isInstalled(dir) {
  return fs.existsSync(path.join(dir, 'Shine.exe'));
}

async function previousInstall() {
  // Read the location recorded by a previous install, if there was one.
  const out = await runPowerShell(`try { (Get-ItemProperty -Path ${psQuote(registryKey)} -ErrorAction Stop).InstallLocation } catch { '' }`);
  const value = out.stdout.trim();
  return value && fs.existsSync(value) ? value : null;
}

async function extract(dir, onProgress) {
  const zip = payloadZip();
  if (!fs.existsSync(zip)) {
    throw new Error(`The Shine app files are missing from this installer (${zip}).`);
  }

  await fsp.mkdir(dir, { recursive: true });

  // Expand-Archive ships with Windows, so no extra tooling is needed.
  const script = `
    $ErrorActionPreference = 'Stop'
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::ExtractToDirectory(${psQuote(zip)}, ${psQuote(dir)})
  `;
  const result = await runPowerShell(script, { timeoutMs: 300000 });
  if (!result.ok) {
    throw new Error(`Could not unpack the app files: ${result.stderr || 'unknown error'}`);
  }
  onProgress?.(1);
}

async function writeUninstaller(dir) {
  const source = process.execPath;
  const target = path.join(dir, `Uninstall ${APP_NAME}.exe`);
  if (path.resolve(source) === path.resolve(target)) return target;
  await fsp.copyFile(source, target);
  return target;
}

async function createShortcut(target, shortcutPath, description) {
  await fsp.mkdir(path.dirname(shortcutPath), { recursive: true });
  const result = await runPowerShell(`
    $s = (New-Object -ComObject WScript.Shell).CreateShortcut(${psQuote(shortcutPath)})
    $s.TargetPath = ${psQuote(target)}
    $s.WorkingDirectory = ${psQuote(path.dirname(target))}
    $s.Description = ${psQuote(description)}
    $s.Save()
  `);
  if (!result.ok) throw new Error(`Could not create ${shortcutPath}: ${result.stderr}`);
}

async function setRunAtStartup(target, enabled) {
  const startup = startupRoot();
  if (!startup) return;
  const link = path.join(startup, `${APP_NAME}.lnk`);
  if (!enabled) {
    await fsp.rm(link, { force: true }).catch(() => {});
    return;
  }
  await createShortcut(target, link, APP_NAME);
}

async function registerUninstall(dir) {
  const uninstaller = path.join(dir, `Uninstall ${APP_NAME}.exe`);
  const result = await runPowerShell(`
    $ErrorActionPreference = 'Stop'
    $key = ${psQuote(registryKey)}
    New-Item -Path $key -Force | Out-Null
    Set-ItemProperty -Path $key -Name 'DisplayName' -Value ${psQuote(APP_NAME)} -Force
    Set-ItemProperty -Path $key -Name 'Publisher' -Value ${psQuote(APP_NAME)} -Force
    Set-ItemProperty -Path $key -Name 'InstallLocation' -Value ${psQuote(dir)} -Force
    Set-ItemProperty -Path $key -Name 'DisplayIcon' -Value ${psQuote(path.join(dir, 'Shine.exe'))} -Force
    Set-ItemProperty -Path $key -Name 'UninstallString' -Value ${psQuote(`"${uninstaller}" --uninstall`)} -Force
    Set-ItemProperty -Path $key -Name 'QuietUninstallString' -Value ${psQuote(`"${uninstaller}" --uninstall`)} -Force
    Set-ItemProperty -Path $key -Name 'NoModify' -Value 1 -Force
    Set-ItemProperty -Path $key -Name 'NoRepair' -Value 1 -Force
    Set-ItemProperty -Path $key -Name 'EstimatedSize' -Value 250000 -Force
  `);

  if (!result.ok) throw new Error(`Could not register Shine for uninstall: ${result.stderr || 'unknown error'}`);
}

/* ------------------------------------------------------------------ */
/* Install                                                            */
/* ------------------------------------------------------------------ */

async function install(options, onStep) {
  const dir = path.resolve(options.installDir);
  const exe = path.join(dir, 'Shine.exe');

  onStep?.('Removing any previous copy', 0.05);
  if (fs.existsSync(dir)) {
    // Leave the uninstaller alone so it can delete itself afterwards.
    await fsp.rm(dir, { recursive: true, force: true }).catch(async () => {
      await runPowerShell(`Remove-Item -LiteralPath ${psQuote(dir)} -Recurse -Force -ErrorAction SilentlyContinue`);
    });
  }

  onStep?.('Unpacking Shine', 0.2);
  await extract(dir, () => onStep?.('Unpacking Shine', 0.6));

  onStep?.('Finishing up', 0.8);
  await writeUninstaller(dir);
  await registerUninstall(dir);

  onStep?.('Creating shortcuts', 0.9);
  if (options.desktopShortcut) {
    await createShortcut(exe, path.join(desktopRoot(), `${APP_NAME}.lnk`), APP_NAME);
  }
  if (options.startMenuShortcut && startMenuRoot()) {
    await createShortcut(exe, path.join(startMenuRoot(), `${APP_NAME}.lnk`), APP_NAME);
  }
  await setRunAtStartup(exe, Boolean(options.runAtStartup));

  onStep?.('Done', 1);
  return { installDir: dir, exe };
}

/* ------------------------------------------------------------------ */
/* Uninstall                                                          */
/* ------------------------------------------------------------------ */

async function uninstall(onStep) {
  const installed = await previousInstall();
  const dir = installed || defaultInstallDir();

  onStep?.('Closing Shine', 0.1);
  await runPowerShell(`Get-Process -Name ${psQuote(APP_NAME)} -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue`);

  onStep?.('Removing shortcuts', 0.35);
  const shortcutPaths = [
    path.join(desktopRoot(), `${APP_NAME}.lnk`),
    startMenuRoot() ? path.join(startMenuRoot(), `${APP_NAME}.lnk`) : null,
    startupRoot() ? path.join(startupRoot(), `${APP_NAME}.lnk`) : null,
  ].filter(Boolean);
  await runPowerShell(
    shortcutPaths.map((p) => `Remove-Item -LiteralPath ${psQuote(p)} -Force -ErrorAction SilentlyContinue`).join('\n')
  );

  onStep?.('Deleting the application', 0.6);
  await runPowerShell(`
    Remove-Item -LiteralPath ${psQuote(dir)} -Recurse -Force -ErrorAction SilentlyContinue
  `);

  onStep?.('Cleaning up', 0.9);
  await runPowerShell(`Remove-Item -Path ${psQuote(registryKey)} -Recurse -Force -ErrorAction SilentlyContinue`);

  onStep?.('Done', 1);
  return { removed: dir };
}

module.exports = {
  APP_NAME, defaultInstallDir, desktopDir, startMenuDir, startupDir,
  checkDisk, isInstalled, previousInstall, install, uninstall, runPowerShell,
};
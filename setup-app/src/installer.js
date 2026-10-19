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
const TEST_KEY = process.env.SHINE_INSTALLER_TEST_KEY || 'HKCU:\\Software\\ShineInstallerTests\\Shine';
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

/**
 * electron-builder's portable target is a self-extracting wrapper: when you
 * launch ShineSetup.exe it unpacks itself into a temp folder and runs the copy
 * from there. So process.execPath is NOT the installer the user downloaded.
 *
 * Copying that instead produced an "Uninstall Shine.exe" that was a bare
 * Electron binary that looks for resources\ beside itself - and the next
 * thing beside it is Shine's own resources\app.asar. So double-clicking it
 * booted Shine instead of uninstalling it. PORTABLE_EXECUTABLE_FILE is the
 * real wrapper, and that is what has to be copied.
 */
function setupExePath() {
  const portable = process.env.PORTABLE_EXECUTABLE_FILE;
  if (portable && fs.existsSync(portable)) return portable;
  return process.execPath;
}

async function writeUninstaller(dir) {
  const source = setupExePath();
  const target = path.join(dir, `Uninstall ${APP_NAME}.exe`);
  if (path.resolve(source) === path.resolve(target)) return target;

  await fsp.copyFile(source, target);

  // A copy that silently produced an unusable file is what made uninstall
  // impossible, so prove the bytes arrived before carrying on.
  const [from, to] = await Promise.all([fsp.stat(source), fsp.stat(target)]);
  if (to.size !== from.size) {
    throw new Error(`The uninstaller could not be created (${to.size} of ${from.size} bytes written).`);
  }
  return target;
}

/* ------------------------------------------------------------------ */
/* Removing the folder the uninstaller is running from                 */
/* ------------------------------------------------------------------ */

/**
 * A running process cannot delete its own executable, and the uninstaller
 * lives inside the very folder it is meant to remove. That is why this could
 * never finish.
 *
 * Windows does allow a running .exe to be *renamed*, which frees the folder
 * completely. So the uninstaller steps itself out of the way first, the now
 * unlocked folder is deleted outright, and the leftover parked copy is handed
 * to MoveFileEx(MOVEFILE_DELAY_UNTIL_REBOOT) - which is a single in-process
 * API call, not a helper process, and cannot be lost when this app exits.
 *
 * The parked copy is also swept up by the next install, so in practice it
 * disappears long before a reboot is needed.
 */

const MOVEFILE_DELAY_UNTIL_REBOOT = 4;

function parkedName() {
  return `Shine-uninstall-${Date.now()}-${Math.floor(Math.random() * 1e6)}.exe`;
}

function parkedFiles() {
  const tmp = os.tmpdir();
  let names = [];
  try {
    names = fs.readdirSync(tmp);
  } catch {
    return [];
  }
  return names
    .filter((n) => /^Shine-uninstall-\d+-\d+\.exe$/.test(n))
    .map((n) => path.join(tmp, n));
}

/** Renames a file out of the install folder. Windows allows this even while it runs. */
async function parkExecutable(src) {
  if (!fs.existsSync(src)) return null;
  const parked = path.join(os.tmpdir(), parkedName());
  const moved = await runPowerShell(`
    $ErrorActionPreference = 'Stop'
    Move-Item -LiteralPath ${psQuote(src)} -Destination ${psQuote(parked)} -Force -ErrorAction Stop
  `);
  if (!moved.ok) return null;
  await scheduleRebootDelete(parked);
  return parked;
}

/** Asks Windows to delete the file at the next restart. Runs in-process. */
async function scheduleRebootDelete(file) {
  await runPowerShell(`
    $ErrorActionPreference = 'SilentlyContinue'
    Add-Type -Namespace ShineCleanup -Name Native -MemberDefinition '
      [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
      public static extern bool MoveFileEx(string existing, string newName, int flags);
    '
    [ShineCleanup.Native]::MoveFileEx(${psQuote(file)}, $null, ${MOVEFILE_DELAY_UNTIL_REBOOT}) | Out-Null
  `);
}

/** Deletes leftovers from previous uninstalls, which are unlocked by now. */
async function sweepParked() {
  for (const file of parkedFiles()) {
    await runPowerShell(`Remove-Item -LiteralPath ${psQuote(file)} -Force -ErrorAction SilentlyContinue`);
  }
}

/**
 * Confirms the app is really on disk before it is advertised in Add/Remove
 * Programs. Registering a half-extracted install is worse than not installing:
 * Windows would offer an Uninstall that launches a file which is not there,
 * and clicking it does nothing at all.
 */
async function verifyInstall(dir) {
  const required = ['Shine.exe', `Uninstall ${APP_NAME}.exe`, path.join('resources', 'app.asar')];
  const missing = required.filter((rel) => !fs.existsSync(path.join(dir, rel)));
  return { ok: missing.length === 0, missing };
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
/* Repair                                                             */
/* ------------------------------------------------------------------ */

/**
 * Repairs an installation in place.
 *
 * A repair replaces the program files with a clean copy from the payload and
 * restores whatever was lost - the app itself, the payload, the uninstaller
 * and the Add/Remove Programs entry. It deliberately leaves your account,
 * chats and every setting alone: those live in %APPDATA%\Shine, not in the
 * install folder.
 *
 * It works even when the install is badly broken, which is the whole point -
 * an uninstall that no longer exists leaves you with no way back except the
 * downloaded installer, which is exactly what "Repair" reaches for.
 */
async function repair(options, onStep) {
  const recorded = await previousInstall();
  const dir = path.resolve(options.installDir || recorded || defaultInstallDir());
  const exe = path.join(dir, 'Shine.exe');

  onStep?.('Checking the installation', 0.05);
  const before = await verifyInstall(dir);
  const wasBroken = !before.ok;

  onStep?.('Closing Shine', 0.12);
  await runPowerShell(`Get-Process -Name ${psQuote(APP_NAME)} -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue`);

  onStep?.('Replacing the program files', 0.2);
  await sweepParked();
  if (fs.existsSync(dir)) {
    // Renaming the folder rather than deleting it means a locked file cannot
    // leave a half-repaired install behind.
    const parked = `${dir}.repair-${Date.now()}`;
    const moved = await runPowerShell(`Move-Item -LiteralPath ${psQuote(dir)} -Destination ${psQuote(parked)} -Force -ErrorAction SilentlyContinue`);
    if (fs.existsSync(dir)) {
      throw new Error(`${dir} could not be replaced. Close anything using it and try again.`);
    }
    await runPowerShell(`Remove-Item -LiteralPath ${psQuote(parked)} -Recurse -Force -ErrorAction SilentlyContinue`);
  }

  onStep?.('Restoring Shine', 0.45);
  await extract(dir, () => onStep?.('Restoring Shine', 0.75));

  onStep?.('Restoring the uninstaller', 0.85);
  await writeUninstaller(dir);

  const after = await verifyInstall(dir);
  if (!after.ok) {
    throw new Error(`The repair did not complete - missing: ${after.missing.join(', ')}`);
  }
  await registerUninstall(dir);

  onStep?.('Creating shortcuts', 0.92);
  await applyShortcuts(exe, options);

  onStep?.('Done', 1);
  return { installDir: dir, exe, wasBroken, missing: before.missing };
}

/** Creates the shortcuts and startup entry the user asked for. */
async function applyShortcuts(exe, options) {
  if (options.desktopShortcut) {
    await createShortcut(exe, path.join(desktopRoot(), `${APP_NAME}.lnk`), APP_NAME);
  } else {
    await runPowerShell(`Remove-Item -LiteralPath ${psQuote(path.join(desktopRoot(), `${APP_NAME}.lnk`))} -Force -ErrorAction SilentlyContinue`);
  }

  if (startMenuRoot()) {
    const link = path.join(startMenuRoot(), `${APP_NAME}.lnk`);
    if (options.startMenuShortcut) {
      await createShortcut(exe, link, APP_NAME);
    } else {
      await runPowerShell(`Remove-Item -LiteralPath ${psQuote(link)} -Force -ErrorAction SilentlyContinue`);
    }
  }

  await setRunAtStartup(exe, Boolean(options.runAtStartup));
}

/* ------------------------------------------------------------------ */
/* Install                                                            */
/* ------------------------------------------------------------------ */

async function install(options, onStep) {
  const dir = path.resolve(options.installDir);
  const exe = path.join(dir, 'Shine.exe');

  onStep?.('Removing any previous copy', 0.05);
  await sweepParked();
  if (fs.existsSync(dir)) {
    // Nothing should be running out of the old folder now. If something is,
    // say so plainly rather than extracting on top of a broken copy.
    await runPowerShell(`Get-Process -Name ${psQuote(APP_NAME)} -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue`);
    await runPowerShell(`Remove-Item -LiteralPath ${psQuote(dir)} -Recurse -Force -ErrorAction SilentlyContinue`);
    if (fs.existsSync(dir)) {
      throw new Error(`The previous copy in ${dir} is still in use. Close Shine, then run this installer again.`);
    }
  }

  onStep?.('Unpacking Shine', 0.2);
  await extract(dir, () => onStep?.('Unpacking Shine', 0.6));

  onStep?.('Finishing up', 0.8);
  await writeUninstaller(dir);

  // Never register an install that cannot actually be started or removed.
  const verified = await verifyInstall(dir);
  if (!verified.ok) {
    throw new Error(`The install did not complete - missing: ${verified.missing.join(', ')}`);
  }

  await registerUninstall(dir);

  onStep?.('Creating shortcuts', 0.9);
  await applyShortcuts(exe, options);

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
  await runPowerShell(`
    Get-Process -Name ${psQuote(APP_NAME)} -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Get-Process -Name ${psQuote(`Uninstall ${APP_NAME}`)} -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  `);

  onStep?.('Removing shortcuts', 0.35);
  const shortcutPaths = [
    path.join(desktopRoot(), `${APP_NAME}.lnk`),
    startMenuRoot() ? path.join(startMenuRoot(), `${APP_NAME}.lnk`) : null,
    startupRoot() ? path.join(startupRoot(), `${APP_NAME}.lnk`) : null,
  ].filter(Boolean);
  await runPowerShell(
    shortcutPaths.map((p) => `Remove-Item -LiteralPath ${psQuote(p)} -Force -ErrorAction SilentlyContinue`).join('\n')
  );

  onStep?.('Cleaning up', 0.55);
  // The registry entry goes first: if the folder removal has to be deferred,
  // Add/Remove Programs must not keep offering an uninstall that is gone.
  await runPowerShell(`Remove-Item -Path ${psQuote(registryKey)} -Recurse -Force -ErrorAction SilentlyContinue`);

  onStep?.('Deleting the application', 0.7);
  if (fs.existsSync(dir)) {
    const remove = () => runPowerShell(`Remove-Item -LiteralPath ${psQuote(dir)} -Recurse -Force -ErrorAction SilentlyContinue`);

    // Try the cheap path first: when this uninstaller was launched from the
    // downloaded installer rather than from inside the folder, nothing is
    // locked and the folder goes away in one call.
    await remove();

    if (fs.existsSync(dir)) {
      // If this program IS the uninstaller sitting in the folder, step it out
      // by renaming before deleting. Otherwise the wrapper deletes the file it
      // is running from and cannot exit cleanly - it comes back with a
      // failure code even though the uninstall worked, which Windows Settings
      // reports to the user as a failed uninstall.
      const uninstallerPath = path.join(dir, `Uninstall ${APP_NAME}.exe`);
      const running = setupExePath();
      const runningTheUninstaller =
        path.resolve(running) === path.resolve(uninstallerPath) ||
        path.resolve(path.dirname(process.execPath)) === path.resolve(dir);

      if (runningTheUninstaller && fs.existsSync(uninstallerPath)) {
        await parkExecutable(uninstallerPath);
      }
      await remove();
    }

    if (fs.existsSync(dir)) {
      // Still held open by something we do not own. Say so plainly instead of
      // claiming success - the registry entry is already gone either way.
      return {
        removed: dir,
        complete: false,
        message: `Shine is no longer in Add/Remove Programs, but ${dir} could not be deleted because a file in it is in use. Close anything using it and delete the folder.`,
      };
    }
  }

  onStep?.('Done', 1);
  return { removed: dir, complete: true };
}

module.exports = {
  APP_NAME, defaultInstallDir, desktopDir, startMenuDir, startupDir,
  checkDisk, isInstalled, previousInstall, verifyInstall, install, repair,
  uninstall, setupExePath, parkExecutable, scheduleRebootDelete, sweepParked,
  parkedFiles, runPowerShell,
};
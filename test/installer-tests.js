'use strict';

/**
 * Installer tests. Run with: node test/installer-tests.js
 *
 * Instores Shine into a throwaway folder with the shortcuts and the registry
 * entry redirected, then uninstalls it again and checks everything is gone.
 * The real desktop, Start Menu and uninstall registry key are never touched.
 *
 * Needs a built app payload: run `npm run release` (or at least steps 1-2).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shine-installer-'));
process.env.SHINE_INSTALLER_TEST = '1';
process.env.SHINE_TEST_DESKTOP_DIR = path.join(tmp, 'Desktop');
process.env.SHINE_TEST_STARTMENU_DIR = path.join(tmp, 'StartMenu');

const installer = require('../setup-app/src/installer');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failed += 1;
    failures.push(name);
    console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

(async () => {
  const dir = path.join(tmp, 'Programs', 'Shine');
  const desktopLink = path.join(process.env.SHINE_TEST_DESKTOP_DIR, 'Shine.lnk');
  const startLink = path.join(process.env.SHINE_TEST_STARTMENU_DIR, 'Shine.lnk');
  const startupLink = path.join(process.env.SHINE_TEST_STARTMENU_DIR, 'Startup', 'Shine.lnk');

  console.log('\nPayload');
  const payload = path.join(__dirname, '..', 'release-payload', 'shine-app.zip');
  check('the app payload exists', fs.existsSync(payload), payload);
  if (!fs.existsSync(payload)) {
    console.log('\nRun "npm run release" first.');
    process.exit(1);
  }

  console.log('\nBefore installing');
  check('nothing is installed yet', (await installer.isInstalled(dir)) === false);

  console.log('\nInstalling');
  const steps = [];
  const result = await installer.install(
    {
      installDir: dir,
      desktopShortcut: true,
      startMenuShortcut: true,
      runAtStartup: true,
      version: '1.0.0',
    },
    (step, progress) => steps.push({ step, progress })
  );
  check('reports where it installed', result.installDir === dir, result.installDir);
  check('reports progress', steps.length >= 3 && steps[steps.length - 1].progress === 1);
  check('reports the exe', fs.existsSync(result.exe));
  check('installed the app', installer.isInstalled(dir));
  check('dropped an uninstaller', fs.existsSync(path.join(dir, 'Uninstall Shine.exe')));
  check('created a desktop shortcut', fs.existsSync(desktopLink), desktopLink);
  check('created a Start Menu shortcut', fs.existsSync(startLink), startLink);
  check('created a startup entry', fs.existsSync(startupLink), startupLink);
  check('records the install location', (await installer.previousInstall()) === dir);

  const registry = await installer.runPowerShell(
    `try { (Get-ItemProperty -Path 'HKCU:\\Software\\ShineInstallerTests\\Shine' -ErrorAction Stop).DisplayName } catch { 'ERR ' + $_.Exception.Message }`
  );
  check('registers in Add/Remove Programs', registry.stdout.trim() === 'Shine', registry.stdout);

  console.log('\nInstalling over the top');
  await installer.install({
    installDir: dir,
    desktopShortcut: false,
    startMenuShortcut: false,
    runAtStartup: false,
    version: '1.0.0',
  });
  check('re-install still works', installer.isInstalled(dir));
  check('startup entry removed when unchecked', !fs.existsSync(startupLink));

  console.log('\nRepairing');
  // Break the install the way it actually broke for a user: the root-level
  // binaries vanish (including the uninstaller) while the folders below
  // survive, which is what a half-finished extraction leaves behind.
  fs.rmSync(path.join(dir, 'Shine.exe'), { force: true });
  fs.rmSync(path.join(dir, 'Uninstall Shine.exe'), { force: true });
  fs.rmSync(path.join(dir, 'resources'), { recursive: true, force: true });
  check('damage is detected', !(await installer.verifyInstall(dir)).ok);

  const repair = await installer.repair({ installDir: dir, desktopShortcut: true, startMenuShortcut: true, runAtStartup: false });
  check('repair reports the install was broken', repair.wasBroken === true);
  check('repair lists what was missing', Array.isArray(repair.missing) && repair.missing.length > 0, String(repair.missing));
  check('repair restores Shine.exe', fs.existsSync(path.join(dir, 'Shine.exe')));
  check('repair restores the payload', fs.existsSync(path.join(dir, 'resources', 'app.asar')));
  check('repair restores the uninstaller', fs.existsSync(path.join(dir, 'Uninstall Shine.exe')));
  check('repair re-registers the uninstall entry', (await installer.previousInstall()) === dir);
  check('repair restores the shortcuts', fs.existsSync(desktopLink) && fs.existsSync(startLink));
  check('repair leaves the folder verified', (await installer.verifyInstall(dir)).ok);

  // A repair with nothing wrong should still succeed quietly.
  const second = await installer.repair({ installDir: dir, desktopShortcut: true, startMenuShortcut: true, runAtStartup: false });
  check('repairing a healthy install is a no-op success', second.wasBroken === false);

  // Repair must work with no options at all, which is how the button behaves
  // when it is pressed straight from the first screen.
  const third = await installer.repair({});
  check('repair works with no options', (await installer.verifyInstall(third.installDir)).ok);

  console.log('\nUninstalling');
  await installer.uninstall();
  check('removes the app', !fs.existsSync(dir));
  check('removes the desktop shortcut', !fs.existsSync(desktopLink));
  check('removes the Start Menu shortcut', !fs.existsSync(startLink));
  check('clears the registry entry', (await installer.previousInstall()) === null);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log(`failures:\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
})().catch((err) => {
  console.error('\ninstaller tests threw:', err);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(1);
});
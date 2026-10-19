'use strict';

/**
 * Full install -> uninstall round trip, driven by the real ShineSetup.exe.
 *
 * The other installer tests call installer.install() in-process, which cannot
 * catch the failures that actually happen to users:
 *
 *   - the uninstaller is a copy of the running setup program, so under the
 *     test runner it is a copy of node.exe and "exists" is all it proves
 *   - Windows will not delete an executable that is running, and the
 *     uninstaller sits inside the folder it is meant to delete
 *   - if the uninstaller is missing, Add/Remove Programs runs a file that is
 *     not there and the uninstall silently does nothing
 *
 * So this drives the built binary end to end and checks the resulting state
 * of the machine, not just return values.
 *
 * Skips itself if ShineSetup.exe has not been built.
 *
 * Run with: node test/roundtrip-tests.js
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');

const root = path.join(__dirname, '..');
const setupExe = path.join(root, 'release-setup', 'ShineSetup.exe');

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

function section(title) {
  console.log(`\n${title}`);
}

function run(exe, args, timeoutMs = 300000) {
  return new Promise((resolve) => {
    execFile(
      exe,
      args,
      { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') })
    );
  });
}

function ps(script) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], 60000);
}

const TEST_KEY = 'HKCU:\\Software\\ShineRoundTripTests\\Shine';
const TEST_DESKTOP = path.join(os.tmpdir(), 'shine-roundtrip-desktop');
const TEST_STARTMENU = path.join(os.tmpdir(), 'shine-roundtrip-startmenu');

/**
 * The portable wrapper does not pass its child's stdout through, so success
 * is judged on the exit code and on what is actually left on disk - which is
 * the only thing that matters to the person uninstalling anyway.
 */
function ranOk(result) {
  return result.ok;
}

(async () => {
  if (!fs.existsSync(setupExe)) {
    console.log('\nShineSetup.exe has not been built - skipping the round trip.');
    console.log('Build it with: node scripts/build-all.js');
    process.exit(0);
  }

  const dir = path.join(os.tmpdir(), 'shine-roundtrip-install');
  const env = {
    ...process.env,
    SHINE_INSTALLER_TEST: '1',
    SHINE_INSTALLER_TEST_KEY: TEST_KEY,
    SHINE_TEST_DESKTOP_DIR: TEST_DESKTOP,
    SHINE_TEST_STARTMENU_DIR: TEST_STARTMENU,
  };

  // Clean up whatever a previous run left behind.
  await ps(`Remove-Item -LiteralPath '${dir}' -Recurse -Force -ErrorAction SilentlyContinue`);
  await ps(`Remove-Item -Path '${TEST_KEY}' -Recurse -Force -ErrorAction SilentlyContinue`);
  await ps(`Remove-Item -LiteralPath '${TEST_DESKTOP}' -Recurse -Force -ErrorAction SilentlyContinue`);
  await ps(`Remove-Item -LiteralPath '${TEST_STARTMENU}' -Recurse -Force -ErrorAction SilentlyContinue`);

  function runSetup(args) {
    return runExe(setupExe, args);
  }

  function runExe(exe, args) {
    return new Promise((resolve) => {
      execFile(exe, args, { timeout: 300000, windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, env }, (err, stdout, stderr) =>
        resolve({ ok: !err, killed: Boolean(err && err.killed), stdout: String(stdout || ''), stderr: String(stderr || '') })
      );
    });
  }

  /** Pulls the executable path out of a registered UninstallString. */
  function exeFromUninstallString(value) {
    const match = String(value).match(/"([^"]+)"/);
    return match ? match[1] : String(value).trim().split(/\s+/)[0];
  }

  /* ---------------------------------------------------------------- */
  section('Installing with the real ShineSetup.exe');
  const install = await runSetup(['--silent', '--install-dir', dir, '--shortcuts']);
  check('setup exits cleanly', install.ok, install.stderr.slice(0, 400));

  const appExe = path.join(dir, 'Shine.exe');
  const uninstallerExe = path.join(dir, 'Uninstall Shine.exe');

  check('Shine.exe was installed', fs.existsSync(appExe));
  check('the app.asar payload is present', fs.existsSync(path.join(dir, 'resources', 'app.asar')));

  // The exact failure the user hit: Add/Remove Programs ran a file that was
  // not there, so uninstall did nothing at all.
  check('Uninstall Shine.exe exists', fs.existsSync(uninstallerExe), 'Add/Remove Programs would do nothing without it');

  if (fs.existsSync(uninstallerExe) && fs.existsSync(setupExe)) {
    const a = fs.statSync(uninstallerExe).size;
    const b = fs.statSync(setupExe).size;
    check(
      'the uninstaller is a copy of the installer, not an extracted stub',
      a === b,
      `${a} bytes vs ${b} - a bare Electron binary would boot Shine instead of uninstalling it`
    );
  }

  section('The uninstall entry points at a file that exists');
  const reg = await ps(`try { (Get-ItemProperty -Path '${TEST_KEY}' -ErrorAction Stop).UninstallString } catch { '' }`);
  const uninstallString = reg.stdout.trim();
  check('an uninstall entry is registered', Boolean(uninstallString), uninstallString);

  let registeredUninstaller = null;
  if (uninstallString) {
    registeredUninstaller = exeFromUninstallString(uninstallString);
    check('the registered uninstaller path exists', fs.existsSync(registeredUninstaller), registeredUninstaller);
  }

  /* ---------------------------------------------------------------- */
  section('Repairing through the real ShineSetup.exe');
  // Break it the way it actually broke: the root-level binaries and the
  // uninstaller disappear, the folders below survive.
  fs.rmSync(appExe, { force: true });
  fs.rmSync(uninstallerExe, { force: true });
  fs.rmSync(path.join(dir, 'resources'), { recursive: true, force: true });
  check('the install is broken before repairing', !fs.existsSync(appExe) && !fs.existsSync(uninstallerExe));

  const repair = await runSetup(['--silent', '--repair']);
  check('repair exits cleanly', ranOk(repair), (repair.stdout + repair.stderr).slice(0, 400));
  check('repair restores Shine.exe', fs.existsSync(appExe));
  check('repair restores the payload', fs.existsSync(path.join(dir, 'resources', 'app.asar')));
  check('repair restores the uninstaller', fs.existsSync(uninstallerExe));

  const regAfterRepair = await ps(`try { (Get-ItemProperty -Path '${TEST_KEY}' -ErrorAction Stop).UninstallString } catch { '' }`);
  check('repair restores the uninstall entry', regAfterRepair.stdout.trim() !== '', regAfterRepair.stdout.trim());

  /* ---------------------------------------------------------------- */
  section('Uninstalling by running the installed uninstaller');
  // This is the path a real user takes: Settings > Apps > Shine > Uninstall,
  // which runs whatever UninstallString points at. Running the downloaded
  // installer instead would skip the very thing that was broken.
  if (!registeredUninstaller || !fs.existsSync(registeredUninstaller)) {
    check('the registered uninstaller could be launched', false, 'nothing to run');
  } else {
    const uninstall = await runExe(registeredUninstaller, ['--silent', '--uninstall']);
    // A wrapper that deletes its own file reports a failure code even when the
    // uninstall succeeded, so success is judged below on disk. What this
    // catches is the other failure mode: an uninstaller that hangs forever and
    // has to be killed - which is what the broken build did.
    check(
      'the installed uninstaller does not hang',
      !uninstall.killed,
      uninstall.killed ? 'timed out and had to be killed' : ''
    );
  }

  // The portable wrapper extracts itself before running, so the whole
  // uninstall takes a while. Wait for the outcome rather than the exit code.
  let gone = false;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (!fs.existsSync(dir)) {
      gone = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  check('the install folder is completely gone', gone, gone ? '' : `still contains ${fs.existsSync(dir) ? fs.readdirSync(dir).join(', ') : ''}`);
  check('nothing was left behind in the folder', !fs.existsSync(uninstallerExe), 'Uninstall Shine.exe should not survive');

  const regAfter = await ps(`try { (Get-ItemProperty -Path '${TEST_KEY}' -ErrorAction Stop).UninstallString } catch { '' }`);
  check('the uninstall entry is cleared', regAfter.stdout.trim() === '', regAfter.stdout.trim());

  /* ---------------------------------------------------------------- */
  section('Installing again over a fresh folder still works');
  const again = await runSetup(['--silent', '--install-dir', dir]);
  check('second install succeeds', again.ok, again.stderr.slice(0, 300));
  check('Shine.exe is back', fs.existsSync(appExe));
  check('the uninstaller is back', fs.existsSync(uninstallerExe));

  await runSetup(['--silent', '--uninstall']);
  await ps(`Remove-Item -LiteralPath '${dir}' -Recurse -Force -ErrorAction SilentlyContinue`);
  await ps(`Remove-Item -Path '${TEST_KEY}' -Recurse -Force -ErrorAction SilentlyContinue`);
  await ps(`Remove-Item -LiteralPath '${TEST_DESKTOP}' -Recurse -Force -ErrorAction SilentlyContinue`);
  await ps(`Remove-Item -LiteralPath '${TEST_STARTMENU}' -Recurse -Force -ErrorAction SilentlyContinue`);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log(`failures:\n  - ${failures.join('\n  - ')}`);
    process.exit(1);
  }
})();

'use strict';

/* Shine Setup - the installer front end. */

const $ = (id) => document.getElementById(id);

const pages = {
  intro: $('page-intro'),
  options: $('page-options'),
  progress: $('page-progress'),
  done: $('page-done'),
};

let state = null;
let stage = 'intro';
let busy = false;

function show(name) {
  Object.values(pages).forEach((node) => node.classList.remove('show'));
  pages[name].classList.add('show');
}

/**
 * The footer is the same set of actions wherever you are:
 *   Install Shine Desktop  - fresh install over the chosen folder
 *   Repair Installation    - restore program files, keep your account
 *   Uninstall              - offered only when this is the uninstaller
 */
function setFooter({ cancel, install, repair, uninstall, disabled } = {}) {
  $('btnCancel').style.display = cancel === false ? 'none' : '';
  $('btnNext').style.display = install === false ? 'none' : '';
  $('btnNext').textContent = install || 'Install Shine Desktop';
  $('btnRepair').style.display = repair === false ? 'none' : '';
  $('btnUninstall').style.display = uninstall === false ? 'none' : '';
  $('btnNext').disabled = Boolean(disabled);
  $('btnRepair').disabled = Boolean(disabled);
  $('btnUninstall').disabled = Boolean(disabled);
}

const BUSY_FOOTER = { cancel: false, install: false, repair: false, uninstall: false };

/* ------------------------------------------------------------------ */

async function init() {
  state = await window.setup.state();

  $('btnMin').addEventListener('click', () => window.setup.minimize());
  $('btnQuit').addEventListener('click', () => window.setup.quit());
  $('btnCancel').addEventListener('click', onCancel);
  $('btnNext').addEventListener('click', onInstall);
  $('btnRepair').addEventListener('click', onRepair);
  $('btnUninstall').addEventListener('click', onUninstall);
  $('btnBrowse').addEventListener('click', onBrowse);
  $('installDir').addEventListener('input', refreshDiskHint);

  window.setup.onProgress(({ step, progress }) => {
    $('progressStep').textContent = step;
    $('progressFill').style.width = `${Math.round(progress * 100)}%`;
  });

  // Both windows offer the same three choices; the uninstaller adds Uninstall.
  const isUninstaller = state.mode === 'uninstall';
  $('installDir').value = state.previous || state.defaultDir;
  await refreshDiskHint();

  if (isUninstaller) {
    $('barTitle').textContent = 'Uninstall Shine';
    $('introTitle').textContent = 'Uninstall Shine';
    $('introText').textContent = state.previous
      ? `Shine is installed in ${state.previous}. Uninstalling removes the app and its shortcuts; your chats and account stay on this PC. Repairing puts the program files back if any are missing, and leaves your account alone.`
      : 'Shine does not appear to be installed. You can still run this to clean up leftover shortcuts, or repair an installation to restore it.';
  } else {
    $('introTitle').textContent = 'Shine Setup';
    $('introText').textContent = state.previous
      ? `Shine will be installed into ${state.previous}, replacing the existing copy.`
      : 'Shine will be installed on this PC.';
  }

  show('intro');
  setFooter({ uninstall: isUninstaller ? 'Uninstall' : false });

  // Development aid: open straight onto a page, e.g. ?page=options
  const startPage = new URLSearchParams(location.search).get('page');
  if (startPage === 'options' || startPage === 'done') {
    stage = 'options';
    show('options');
    setFooter({ cancel: 'Back', repair: false });
  }
}

/* ------------------------------------------------------------------ */

async function refreshDiskHint() {
  const dir = $('installDir').value.trim();
  if (!dir) {
    $('diskHint').textContent = 'Choose a folder.';
    return false;
  }
  const disk = await window.setup.checkDisk(dir);
  if (!disk.ok) {
    $('diskHint').textContent = 'That drive does not have enough free space (about 400 MB is needed).';
    return false;
  }
  const free = disk.free ? ` ${Math.round(disk.free / 1024 / 1024 / 1024)} GB free.` : '';
  $('diskHint').textContent = `Shine needs about 400 MB of space.${free}`;
  return true;
}

async function onBrowse() {
  const dir = await window.setup.chooseDir();
  if (!dir) return;
  $('installDir').value = dir;
  await refreshDiskHint();
}

async function onInstall() {
  if (busy) return;

  if (stage === 'intro') {
    show('options');
    setFooter({ cancel: 'Back', repair: false });
    stage = 'options';
    return;
  }

  if (stage === 'options') {
    const ok = await refreshDiskHint();
    if (!ok) return;
    return runInstall();
  }

  if (stage === 'done') window.setup.quit();
}

/** Repairs in place - keeps the account, chats and every setting. */
async function onRepair() {
  if (busy) return;
  if (stage === 'progress') return;

  const target = $('installDir').value.trim() || state.previous || state.defaultDir;

  busy = true;
  stage = 'progress';
  show('progress');
  $('progressTitle').textContent = 'Repairing Shine';
  $('progressStep').textContent = 'Checking the installation...';
  $('progressFill').style.width = '0%';
  setFooter(BUSY_FOOTER);

  try {
    const result = await window.setup.repair({
      installDir: target,
      desktopShortcut: $('optDesktop').checked,
      startMenuShortcut: $('optStartMenu').checked,
      runAtStartup: $('optStartup').checked,
    });

    $('progressFill').style.width = '100%';
    stage = 'done';
    $('doneTitle').textContent = 'Shine has been repaired';
    $('doneText').textContent = result.wasBroken
      ? `Restored into ${result.installDir}. Missing again: ${result.missing.join(', ')}. Your account and chats were left alone.`
      : `Reinstalled cleanly into ${result.installDir}. Your account and chats were left alone.`;
    show('done');
    setFooter({ cancel: false, install: 'Finish', repair: false, uninstall: false });
  } catch (err) {
    busy = false;
    stage = 'intro';
    show('intro');
    setFooter({ uninstall: state.mode === 'uninstall' ? 'Uninstall' : false });
    $('introText').textContent = `Repair failed: ${err.message}`;
  }
}

async function onUninstall() {
  if (busy) return;
  return runUninstall();
}

async function onCancel() {
  if (stage === 'progress') return; // never interrupt mid-install
  if (stage === 'intro') return window.setup.quit();
  show('intro');
  setFooter({ uninstall: state.mode === 'uninstall' ? 'Uninstall' : false });
  stage = 'intro';
}

/* ------------------------------------------------------------------ */

async function runInstall() {
  busy = true;
  stage = 'progress';
  show('progress');
  $('progressTitle').textContent = 'Installing Shine';
  $('progressStep').textContent = 'Preparing...';
  $('progressFill').style.width = '0%';
  setFooter(BUSY_FOOTER);

  try {
    const result = await window.setup.install({
      installDir: $('installDir').value.trim(),
      desktopShortcut: $('optDesktop').checked,
      startMenuShortcut: $('optStartMenu').checked,
      runAtStartup: $('optStartup').checked,
    });

    $('progressFill').style.width = '100%';
    stage = 'done';
    $('doneTitle').textContent = 'Shine is installed';
    $('doneText').textContent = `Installed into ${result.installDir}.`;
    show('done');
    setFooter({ cancel: false, install: $('optLaunch').checked ? 'Open Shine' : 'Finish', repair: false, uninstall: false });

    if ($('optLaunch').checked) {
      $('btnNext').addEventListener(
        'click',
        () => window.setup.launch(result.exe),
        { once: true }
      );
    }
  } catch (err) {
    busy = false;
    stage = 'options';
    show('options');
    setFooter({ cancel: 'Back', repair: false });
    $('diskHint').textContent = `Install failed: ${err.message}`;
  }
}

async function runUninstall() {
  busy = true;
  stage = 'progress';
  show('progress');
  $('progressTitle').textContent = 'Uninstalling Shine';
  $('progressStep').textContent = 'Preparing...';
  $('progressFill').style.width = '0%';
  setFooter(BUSY_FOOTER);

  try {
    const result = await window.setup.uninstall();
    stage = 'done';
    if (result && result.complete === false) {
      // The folder is deleted by a helper once this window closes, because
      // Windows will not let a running program delete itself.
      $('doneTitle').textContent = 'Shine has been uninstalled';
      $('doneText').textContent = result.message;
    } else {
      $('doneTitle').textContent = 'Shine has been uninstalled';
      $('doneText').textContent = 'The application and its shortcuts were removed. Your account and chats were left alone.';
    }
    show('done');
    setFooter({ cancel: false, install: 'Finish', repair: false, uninstall: false });
  } catch (err) {
    busy = false;
    stage = 'intro';
    show('intro');
    setFooter({ uninstall: 'Uninstall' });
    $('introText').textContent = `Uninstall failed: ${err.message}`;
  }
}

init();
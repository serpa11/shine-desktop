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

function setFooter({ cancel, next, nextDisabled }) {
  $('btnCancel').style.display = cancel === false ? 'none' : '';
  $('btnNext').style.display = next === false ? 'none' : '';
  $('btnNext').textContent = next || 'Next';
  $('btnNext').disabled = Boolean(nextDisabled);
}

/* ------------------------------------------------------------------ */

async function init() {
  state = await window.setup.state();

  $('btnMin').addEventListener('click', () => window.setup.minimize());
  $('btnQuit').addEventListener('click', () => window.setup.quit());
  $('btnCancel').addEventListener('click', onCancel);
  $('btnNext').addEventListener('click', onNext);
  $('btnBrowse').addEventListener('click', onBrowse);
  $('installDir').addEventListener('input', refreshDiskHint);

  window.setup.onProgress(({ step, progress }) => {
    $('progressStep').textContent = step;
    $('progressFill').style.width = `${Math.round(progress * 100)}%`;
  });

  if (state.mode === 'uninstall') {
    $('barTitle').textContent = 'Uninstall Shine';
    $('introTitle').textContent = 'Uninstall Shine';
    $('introText').textContent = state.previous
      ? `Shine is installed in ${state.previous}. This removes the app and its shortcuts. Your chats and account stay on this PC.`
      : 'Shine does not appear to be installed. You can still run this to clean up leftover shortcuts.';
    $('btnNext').textContent = 'Uninstall';
    show('intro');
    setFooter({});
    return;
  }

  $('introTitle').textContent = 'Shine Setup';
  $('introText').textContent = state.previous
    ? `Shine will be installed into ${state.previous}, replacing the existing copy.`
    : 'Shine will be installed on this PC.';

  $('installDir').value = state.previous || state.defaultDir;
  await refreshDiskHint();
  show('intro');
  setFooter({});

  // Development aid: open straight onto a page, e.g. ?page=options
  const startPage = new URLSearchParams(location.search).get('page');
  if (startPage === 'options' || startPage === 'done') {
    stage = 'options';
    show('options');
    setFooter({ next: 'Install' });
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

async function onNext() {
  if (busy) return;

  if (stage === 'intro') {
    if (state.mode === 'uninstall') return runUninstall();
    show('options');
    setFooter({ next: 'Install' });
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

async function onCancel() {
  if (stage === 'progress') return; // never interrupt mid-install
  if (stage === 'intro') return window.setup.quit();
  show('intro');
  setFooter({});
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
  setFooter({ cancel: false, next: false });

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
    setFooter({ cancel: false, next: $('optLaunch').checked ? 'Open Shine' : 'Finish' });

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
    setFooter({ next: 'Install' });
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
  setFooter({ cancel: false, next: false });

  try {
    await window.setup.uninstall();
    stage = 'done';
    $('doneTitle').textContent = 'Shine has been uninstalled';
    $('doneText').textContent = 'The application and its shortcuts were removed. Your account and chats were left alone.';
    show('done');
    setFooter({ cancel: false, next: 'Finish' });
  } catch (err) {
    busy = false;
    stage = 'intro';
    show('intro');
    setFooter({});
    $('introText').textContent = `Uninstall failed: ${err.message}`;
  }
}

init();
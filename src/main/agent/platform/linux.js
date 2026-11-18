'use strict';

/**
 * The POSIX shell bridge.
 *
 * There is no second shell to choose between here, which is the whole point:
 * on Windows a command has to be classified as cmd or PowerShell before it
 * can run, and getting that wrong is silent. Linux reads everything with one
 * shell, so looksLikeCmd() and its parse-error retry have no counterpart.
 *
 * The script is passed as a single argv element to `bash -c` rather than
 * being concatenated into a command line, so quoting is never involved - the
 * problem that makes the Windows side awkward does not exist here.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { requireOk } = require('../result');

/**
 * Wraps a command so a failed one reports as a failure.
 *
 * set -e makes a non-zero exit terminate the script with that status, which
 * is the counterpart of the PowerShell wrapper's $ErrorActionPreference =
 * 'Stop': without it a shell that ran `false; echo ok` would exit 0 and
 * Shine would believe the first part worked.
 *
 * pipefail needs bash - it is not in POSIX and dash, which is /bin/sh on
 * Debian and Ubuntu, rejects it with "Illegal option". It is therefore
 * opted into by runCommand() only when bash is actually in use.
 */
function shWrapper(command, { pipefail = false } = {}) {
  const lines = [];
  if (pipefail) lines.push('set -o pipefail');
  lines.push('set -e');
  lines.push(String(command));
  return lines.join('\n');
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function runShell(bin, script, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    execFile(
      bin,
      ['-c', script],
      { timeout: timeoutMs, maxBuffer: 12 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const missing = Boolean(err && err.code === 'ENOENT');
        const code = err && typeof err.code === 'number' ? err.code : err ? 1 : 0;
        resolve({
          ok: !err,
          code,
          missing,
          stdout: String(stdout || '').trim(),
          stderr: String(stderr || '').trim(),
          timedOut: Boolean(err && err.killed),
        });
      }
    );
  });
}

/**
 * Which shell to run a command in.
 *
 * bash is preferred when it exists because `[[ ]]`, arrays and pipefail are
 * what people actually write; sh is the fallback for a system without it.
 * An explicit shell is honoured only if it is one of these two - PowerShell
 * names are meaningless here and silently falling back beats failing.
 */
function pickShell(requested) {
  const asked = String(requested || '').trim().toLowerCase();
  if (asked === 'sh') return { name: 'sh', bin: 'sh', pipefail: false };
  // bash for everything else, including a Windows shell name: cmd and
  // PowerShell mean nothing here, and quietly running the command beats
  // refusing it over a spelling the caller had no reason to know was wrong.
  return { name: 'bash', bin: 'bash', pipefail: true };
}

/**
 * Runs one command.
 *
 * Falls back from bash to sh when bash is not installed, rather than failing
 * the command: a minimal system should still be controllable.
 *
 * @param {string} command
 * @param {{timeoutMs?:number, shell?:string}} [options]
 * @returns {Promise<{ok:boolean, code:number, stdout:string, stderr:string,
 *   timedOut:boolean, shell:string}>}
 */
async function runCommand(command, { timeoutMs = 30000, shell } = {}) {
  const chosen = pickShell(shell);
  const script = shWrapper(command, { pipefail: chosen.pipefail });

  let res = await runShell(chosen.bin, script, { timeoutMs });
  let used = chosen.name;

  if (res.missing && chosen.bin !== 'sh') {
    res = await runShell('sh', shWrapper(command, { pipefail: false }), { timeoutMs });
    used = 'sh';
  }

  const { missing, ...rest } = res;
  return { ...rest, shell: used };
}

/* ------------------------------------------------------------------ */
/* Applications                                                        */
/* ------------------------------------------------------------------ */

/**
 * Where .desktop entries live, in the order desktop environments search them.
 *
 * Windows keeps this in the App Paths registry and the Start Menu; here it
 * is files on disk, which makes the search testable - a test can point
 * findApplications() at a directory it built itself instead of needing a real
 * desktop installed.
 */
const APP_DIRS = [
  '/usr/share/applications',
  '/usr/local/share/applications',
  path.join(os.homedir(), '.local', 'share', 'applications'),
];

/**
 * Every .desktop file under dir, a couple of levels deep.
 *
 * The depth is bounded on purpose: /usr/share/applications holds a couple of
 * thousand entries, and an unbounded walk would turn a question about one app
 * into a scan of the whole system.
 */
function desktopFiles(dir, depth = 2) {
  const out = [];
  if (depth < 0) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // a menu directory that does not exist is normal
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...desktopFiles(full, depth - 1));
    else if (entry.isFile() && entry.name.endsWith('.desktop')) out.push(full);
  }
  return out;
}

/**
 * Reads the two fields Shine needs out of a .desktop file.
 *
 * A desktop entry is an INI file with one group that matters. Only the
 * untranslated Name= is used - Name[fr]= would match "firefox" for nobody -
 * and hidden entries are dropped so a search does not surface an application
 * the desktop has deliberately stopped showing.
 */
function readDesktopEntry(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const entry = { file, name: null, exec: null, type: null, hidden: false };
  let inEntry = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inEntry = line === '[Desktop Entry]';
      continue;
    }
    if (!inEntry) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1).trim();
    if (key === 'Name' && !entry.name) entry.name = value;
    else if (key === 'Exec' && !entry.exec) entry.exec = value;
    else if (key === 'Type') entry.type = value;
    else if ((key === 'NoDisplay' || key === 'Hidden') && value === 'true') entry.hidden = true;
  }
  if (!entry.name || !entry.exec) return null;
  if (entry.hidden) return null;
  if (entry.type && entry.type !== 'Application') return null;
  return entry;
}

/**
 * Finds installed applications by name.
 *
 * @param {string} query
 * @param {{limit?:number, dirs?:string[]}} [options]
 * @returns {Promise<{matches:string[], searched:string}>}
 */
async function findApplications(query, { limit = 15, dirs = APP_DIRS } = {}) {
  const needle = String(query || '').toLowerCase().trim();
  if (!needle) return { matches: [], searched: 'application menus' };

  const matches = [];
  const seen = new Set();

  for (const dir of dirs) {
    for (const file of desktopFiles(dir)) {
      const entry = readDesktopEntry(file);
      if (!entry) continue;
      const haystack = `${entry.name} ${path.basename(file, '.desktop')}`.toLowerCase();
      if (!haystack.includes(needle)) continue;
      if (seen.has(entry.name)) continue;
      seen.add(entry.name);
      matches.push(entry.exec);
      if (matches.length >= limit) return { matches, searched: 'application menus' };
    }
  }

  return { matches, searched: 'application menus' };
}

/**
 * Removes the desktop's field codes from an Exec line.
 *
 * %f, %u and friends are replaced by the desktop environment with a file or
 * URL to open. Shine has none of those to give, and leaving the code in would
 * pass a literal "%u" as the first argument - which is enough to stop most
 * programs from starting at all.
 */
function stripFieldCodes(exec) {
  return String(exec)
    .replace(/%[fFuUdDnNickvm]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The first word of a command, quotes resolved, for an existence check. */
function firstToken(command) {
  const s = String(command).trim();
  let out = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "'" || ch === '"') {
      const end = s.indexOf(ch, i + 1);
      if (end < 0) return out || s;
      out += s.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (/\s/.test(ch)) break;
    out += ch;
    i += 1;
  }
  return out;
}

/** Opens a file or folder with whatever the desktop has associated with it. */
async function openPath(target) {
  return runCommand(`xdg-open ${shellQuote(target)}`);
}

async function openUrl(url) {
  return runCommand(`xdg-open ${shellQuote(url)}`);
}

/**
 * Starts a program and returns as soon as it is running.
 *
 * The program is sent to the background with its output discarded, for two
 * reasons that are easy to get wrong:
 *
 *   - A GUI program that does not fork off its own process would otherwise
 *     hold the shell open until the timeout, and killing it at that point
 *     would mean killing the very application we just started.
 *   - An inherited stdout keeps the pipe open for as long as the child lives,
 *     so the caller would wait on the browser instead of the launch.
 *
 * Existence is therefore checked before starting rather than through the exit
 * status, because a backgrounded job's failure is invisible: `bash -c 'nope &'`
 * returns 0.
 */
async function launchApplication(name, { arguments: argv, limit = 15, dirs = APP_DIRS } = {}) {
  const found = await findApplications(name, { limit, dirs });

  for (const exec of found.matches) {
    const command = stripFieldCodes(exec);
    const launched = await startDetached(command, argv);
    if (launched) return { launched: true, path: exec, via: 'search' };
  }

  // Last resort: PATH resolution, which handles a bare name like "htop".
  if (await startDetached(name, argv)) {
    return { launched: true, executable: name, via: 'path' };
  }

  return { launched: false, matches: found.matches };
}

async function startDetached(command, argv) {
  const token = firstToken(command);
  if (!token) return false;
  const script = [
    `command -v ${shellQuote(token)} >/dev/null 2>&1 || { echo 'NOT_FOUND'; exit 127; }`,
    argv
      ? `${command} ${shellQuote(String(argv))} >/dev/null 2>&1 &`
      : `${command} >/dev/null 2>&1 &`,
    'echo LAUNCHED',
  ].join('\n');

  const res = await runCommand(script, { timeoutMs: 20000 });
  return res.ok && /LAUNCHED/.test(res.stdout || '');
}

/* ------------------------------------------------------------------ */
/* Processes and windows                                               */
/* ------------------------------------------------------------------ */

/**
 * Processes Shine refuses to force-end by name.
 *
 * The Windows list lived in executor.js and moved with the tool. These are
 * the ones that make the same claim here: the session, the display server and
 * the audio daemon. Kernel threads are deliberately not in the list - see
 * isProtected, which has to recognise them without knowing their names.
 */
const PROTECTED = [
  'systemd',
  'init',
  'kthreadd',
  'dbus-daemon',
  'dbus-broker',
  'sshd',
  'gdm',
  'gdm3',
  'lightdm',
  'sddm',
  'xorg',
  'gnome-shell',
  'kwin_x11',
  'plasmashell',
  'pipewire',
  'pipewire-pulse',
  'pulseaudio',
  'seatd',
  'logind',
  'systemd-logind',
  'shine',
];

/**
 * Reads a process's name without the kernel's fifteen-character cap.
 *
 * /proc/<pid>/comm is truncated by the kernel, which is fine for "firefox"
 * but turns "xdg-desktop-portal" into something the user then cannot search
 * for. The exe symlink has no such limit, so it is tried first and comm is
 * the fallback for a process that will not say what it is - a zombie, or one
 * belonging to somebody else.
 *
 * @param {number} pid
 * @param {string} [procDir] overridable so tests need no /proc
 */
function procName(pid, procDir = '/proc') {
  try {
    return path.basename(fs.readlinkSync(path.join(procDir, String(Number(pid)), 'exe')));
  } catch {
    /* not readable, or not there */
  }
  try {
    return fs.readFileSync(path.join(procDir, String(Number(pid)), 'comm'), 'utf8').trim();
  } catch {
    /* gone */
  }
  return '';
}

/** Every process, as {pid, name}. */
function processNames(procDir = '/proc') {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(procDir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const name = procName(Number(entry), procDir);
    if (name) out.push({ pid: Number(entry), name });
  }
  return out;
}

/**
 * Whether force-ending this would take the machine with it.
 *
 * The name list answers first. The second answer is a kernel thread, which
 * has an empty cmdline - pid 3 and 4 are always kernel threads, but their
 * names change with every kernel and configuration, so matching on the number
 * would be wrong. cmdline is world readable, so this also works for processes
 * belonging to anyone else; a process whose cmdline cannot be read at all is
 * left for the kill to reject rather than refused here for the wrong reason.
 */
function isProtected(pid, name, procDir = '/proc') {
  if (PROTECTED.includes(String(name || '').toLowerCase())) return true;
  try {
    return fs.readFileSync(path.join(procDir, String(Number(pid)), 'cmdline'), 'utf8').length === 0;
  } catch {
    return false;
  }
}

function procAlive(pid, procDir = '/proc') {
  return fs.existsSync(path.join(procDir, String(Number(pid))));
}

/**
 * Parses `ps -eo pid=,rss=` output.
 *
 * ps reports memory in kilobytes while /proc reports it in pages, and Node
 * has no portable way to ask how big a page is - guessing would silently
 * scale every number in the list. That is why ps supplies the memory and
 * /proc supplies only the names.
 */
function parsePsRss(stdout) {
  const rows = [];
  for (const line of String(stdout || '').split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), kb: Number(m[2]) });
  }
  return rows;
}

function isWayland() {
  return process.env.XDG_SESSION_TYPE === 'wayland' || Boolean(process.env.WAYLAND_DISPLAY);
}

/**
 * Lists every visible window, or says why there are none.
 *
 * xdotool talks to the X server directly, which is why it cannot see a
 * Wayland session's windows at all. That is reported rather than quietly
 * returning an empty list, because "there are no windows" and "the display
 * server will not show them to me" are identical to everything downstream -
 * and the difference is the entire answer to "why can it not find my
 * window?".
 *
 * stderr is deliberately not suppressed on the search: with no X server the
 * command still exits successfully with no output, and the error it wrote is
 * the only thing that says so.
 */
const WINDOW_SCAN = [
  "command -v xdotool >/dev/null 2>&1 || { echo 'NO_XDOTOOL'; exit 127; }",
  "for id in $(xdotool search --onlyvisible --name '.*'); do",
  '  title=$(xdotool getwindowname "$id" 2>/dev/null) || continue',
  '  [ -n "$title" ] || continue',
  '  pid=$(xdotool getwindowpid "$id" 2>/dev/null || echo 0)',
  "  printf '%s\\t%s\\t%s\\n' \"$id\" \"$pid\" \"$title\"",
  'done',
].join('\n');

async function scanWindows() {
  const res = await runCommand(WINDOW_SCAN, { timeoutMs: 20000 });
  if (/NO_XDOTOOL/.test(res.stdout || '')) return { ok: false, reason: 'xdotool' };

  const windows = [];
  for (const line of String(res.stdout || '').split('\n')) {
    if (!line) continue;
    const [id, pid, ...rest] = line.split('\t');
    const title = rest.join('\t').trim();
    if (!id || !title) continue;
    windows.push({ id, pid: Number(pid) || 0, title });
  }

  if (windows.length > 0) return { ok: true, windows };
  if (isWayland()) return { ok: false, reason: 'wayland' };
  const detail = String(res.stderr || res.stdout || '').trim();
  if (detail) return { ok: false, reason: 'failed', detail };
  return { ok: true, windows };
}

/** The message for a window listing that cannot work here. */
function windowsUnavailable(scan) {
  if (scan.reason === 'xdotool') {
    return 'xdotool is not installed, so Shine cannot see this desktop\'s windows. Install it with "sudo apt install xdotool" (or "sudo dnf install xdotool"), then ask again.';
  }
  if (scan.reason === 'wayland') {
    return 'This is a Wayland session, and xdotool can only see X11 windows - so Shine cannot list or focus windows here. Choosing "Ubuntu on Xorg" or "GNOME on Xorg" at the sign-in screen switches to a session it can drive.';
  }
  return `Could not list windows${scan.detail ? `: ${String(scan.detail).slice(0, 400)}` : ''}.`;
}

/**
 * The tools whose behaviour *is* the desktop.
 *
 * The counterpart of windows.js's toolImpls. Nothing here is translated from
 * Windows: what closing, focusing, listing and killing mean is defined by
 * this machine, so each side carries its own copy of the whole method and
 * executor.js assembles impl from platform.toolImpls.
 */
const toolImpls = {
  async close_app(args) {
    const name = String(args.name || '').trim();
    const needle = name.toLowerCase();
    const matches = processNames().filter((p) => p.name.toLowerCase().includes(needle));
    if (matches.length === 0) throw new Error(`No running app matching "${name}" was found.`);

    // Not our own process: asking "close shine" should not be a way to end
    // the session mid-answer.
    const pids = matches.map((p) => p.pid).filter((pid) => pid !== process.pid);
    if (pids.length === 0) return { app: name, closed: 0 };

    // SIGTERM first - it is the same message the title bar's close button
    // sends, so an app with unsaved work still gets its chance to ask.
    await runCommand(`kill ${pids.join(' ')}`, { timeoutMs: 10000 });
    await new Promise((resolve) => setTimeout(resolve, 900));

    // And then insist, for the ones that ignored it.
    const survivors = pids.filter((pid) => procAlive(pid));
    if (survivors.length) await runCommand(`kill -9 ${survivors.join(' ')}`, { timeoutMs: 10000 });

    return { app: name, closed: pids.length };
  },

  async kill_process(args) {
    const pid = Number(args.pid);
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('kill_process needs a valid pid.');
    if (pid === process.pid) throw new Error('Shine refused to kill its own process.');

    const name = procName(pid);
    if (isProtected(pid, name)) {
      throw new Error(`Shine refuses to force-end "${name}" because it is a critical Linux process.`);
    }

    const r = await runCommand(`kill -9 ${pid}`, { timeoutMs: 10000 });
    await requireOk(r, 'kill_process');
    return { pid, process: name, killed: true };
  },

  async focus_window(args) {
    const title = String(args.title || '').trim();
    const scan = await scanWindows();
    if (!scan.ok) throw new Error(windowsUnavailable(scan));

    const match = scan.windows.find((w) => w.title.toLowerCase().includes(title.toLowerCase()));
    if (!match) throw new Error(`No open window title contains "${title}".`);

    const r = await runCommand(`xdotool windowactivate --sync ${shellQuote(match.id)}`, { timeoutMs: 10000 });
    if (!r.ok) {
      throw new Error(`Could not focus "${match.title}": ${String(r.stderr || r.stdout || 'xdotool failed').slice(0, 400)}`);
    }
    return { title: match.title, focused: true };
  },

  async list_windows() {
    const scan = await scanWindows();
    if (!scan.ok) throw new Error(windowsUnavailable(scan));
    const windows = scan.windows.map(({ pid, title }) => ({ title, pid }));
    return { count: windows.length, windows: windows.slice(0, 60) };
  },

  async list_processes(args) {
    const filter = String(args.filter || '').trim().toLowerCase();
    const rows = await processRows();
    const filtered = filter ? rows.filter((p) => String(p.ProcessName).toLowerCase().includes(filter)) : rows;
    filtered.sort((a, b) => (b.MemoryMB || 0) - (a.MemoryMB || 0));
    return { count: filtered.length, processes: filtered.slice(0, 120) };
  },
};

/**
 * Every process with the four fields Windows reports.
 *
 * The field names match Windows exactly because they are what the tool's
 * description promises the model; renaming them per platform would make the
 * same prompt mean two different things.
 */
async function processRows(procDir = '/proc') {
  const res = await runCommand('ps -eo pid=,rss=', { timeoutMs: 20000 });
  await requireOk(res, 'list_processes');

  const titles = new Map();
  const scan = await scanWindows();
  if (scan.ok) {
    for (const w of scan.windows) {
      if (w.pid && !titles.has(w.pid)) titles.set(w.pid, w.title);
    }
  }

  return parsePsRss(res.stdout).map(({ pid, kb }) => ({
    Id: pid,
    ProcessName: procName(pid, procDir) || `pid ${pid}`,
    MemoryMB: Math.round((kb / 1024) * 10) / 10,
    Window: titles.get(pid) || '',
  }));
}

module.exports = {
  toolImpls,
  runCommand,
  shWrapper,
  shellQuote,
  runShell,
  pickShell,
  APP_DIRS,
  desktopFiles,
  readDesktopEntry,
  findApplications,
  stripFieldCodes,
  firstToken,
  openPath,
  openUrl,
  launchApplication,
  // Exported for the tests: these are the parts that can be pinned without a
  // display, a shell or a running system.
  procName,
  processNames,
  isProtected,
  parsePsRss,
  isWayland,
  scanWindows,
  windowsUnavailable,
  processRows,
};

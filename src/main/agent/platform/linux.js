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
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { requireOk } = require('../result');
const { clamp, resolvePath } = require('../util');

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

/* ------------------------------------------------------------------ */
/* Pointer, keyboard and terminals                                      */
/* ------------------------------------------------------------------ */

/**
 * Reads the pointer position.
 *
 * The same shape the Windows side reports - "x,y" - so nothing downstream
 * has to care which one answered.
 */
function parseMouseLocation(stdout) {
  const x = /^x=(-?\d+)\s*$/m.exec(String(stdout || ''));
  const y = /^y=(-?\d+)\s*$/m.exec(String(stdout || ''));
  if (!x || !y) return null;
  return `${x[1]},${y[1]}`;
}

async function cursorPosition() {
  const r = await runCommand('xdotool getmouselocation --shell', { timeoutMs: 10000 });
  return parseMouseLocation(r.stdout);
}

/**
 * SendKeys spellings, translated to xdotool keysyms.
 *
 * Windows writes a key as {ENTER} and a chord as ^c; xdotool writes Return
 * and ctrl+c. Rather than documenting the Linux spelling and hoping the
 * model reads it, the Windows one is translated, so the same prompt works on
 * both machines - and because it is a pure function it can be pinned by a
 * test instead of by typing into a real window.
 */
const KEY_ALIASES = {
  ENTER: 'Return',
  RETURN: 'Return',
  TAB: 'Tab',
  ESC: 'Escape',
  ESCAPE: 'Escape',
  BACKSPACE: 'BackSpace',
  BS: 'BackSpace',
  DELETE: 'Delete',
  DEL: 'Delete',
  INSERT: 'Insert',
  INS: 'Insert',
  UP: 'Up',
  DOWN: 'Down',
  LEFT: 'Left',
  RIGHT: 'Right',
  HOME: 'Home',
  END: 'End',
  PGUP: 'Prior',
  PGDN: 'Next',
  PAGEUP: 'Prior',
  PAGEDOWN: 'Next',
  SPACE: 'space',
  CAPSLOCK: 'Caps_Lock',
  NUMLOCK: 'Num_Lock',
  SCROLLLOCK: 'Scroll_Lock',
  PRINTSCREEN: 'Print',
  WINDOW: 'Super_L',
  WIN: 'Super_L',
  MENU: 'Menu',
};

function translateChunk(chunk) {
  // {F5}, {ENTER}, and {+} for a literal plus - SendKeys writes a printable
  // key inside braces when it collides with a modifier character.
  const braced = /^\{([^{}]*)\}$/.exec(chunk);
  if (braced) {
    const name = braced[1].toUpperCase();
    if (/^F\d{1,2}$/.test(name)) return name;
    if (KEY_ALIASES[name]) return KEY_ALIASES[name];
    if (braced[1].length === 1) return braced[1];
    return chunk; // unknown name: leave it for xdotool to reject by name
  }

  // A leading run of ^ + % is ctrl, shift and alt applied to the next key.
  const mods = /^([~^+%]+)(\S+)$/.exec(chunk);
  if (mods) {
    const keys = [];
    let key = mods[2];
    for (const c of mods[1]) {
      if (c === '^') keys.push('ctrl');
      else if (c === '+') keys.push('shift');
      else if (c === '%') keys.push('alt');
      else if (c === '~') key = 'Return'; // ~ means Enter
    }
    return [...keys, key].join('+');
  }

  return chunk;
}

/**
 * Turns a key string into the list of keysyms xdotool should press.
 *
 * A space is returned as its own keysym rather than left as the separator,
 * because that is what it means in SendKeys - `a b` is three keystrokes, not
 * two - and each result is passed to xdotool as its own quoted argument, so
 * a key name can never be read as shell syntax.
 *
 * @param {string} spec
 * @returns {string[]}
 */
function toXdotoolKeys(spec) {
  const s = String(spec || '');
  if (!s.trim()) return [];
  const out = [];
  for (const chunk of s.split(/(\s+)/)) {
    if (!chunk) continue;
    if (/^\s+$/.test(chunk)) {
      out.push('space');
      continue;
    }
    const translated = translateChunk(chunk);
    if (translated) out.push(translated);
  }
  return out;
}

const TERMINALS = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'kitty', 'alacritty', 'xterm'];

/**
 * Opens a terminal and returns as soon as it is on its way.
 *
 * Each desktop names its terminal differently and they daemonise in their
 * own way, so the first one that exists is started in the background with
 * its output discarded - the same two rules as starting any other program,
 * for the same two reasons.
 */
async function openTerminal() {
  for (const term of TERMINALS) {
    const res = await runCommand(
      [`command -v ${shellQuote(term)} >/dev/null 2>&1 || exit 3`, `${term} >/dev/null 2>&1 &`, 'echo LAUNCHED'].join('\n'),
      { timeoutMs: 15000 }
    );
    if (res.ok && /LAUNCHED/.test(res.stdout || '')) return term;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Audio                                                               */
/* ------------------------------------------------------------------ */

/**
 * wpctl's `Volume: 0.50 [MUTED]` line.
 *
 * WirePlumber speaks in fractions, Windows speaks in percent, and Shine
 * reports percent everywhere, so the conversion happens here rather than in
 * three call sites.
 */
function parseWpctlVolume(stdout) {
  const m = /^Volume:\s*([0-9.]+)/m.exec(String(stdout || ''));
  if (!m) return null;
  return { level: Math.min(100, Math.round(Number(m[1]) * 100)), muted: /\[MUTED\]/i.test(String(stdout)) };
}

/**
 * pactl's `front-left: 32768 / 50% / -18.75 dB` line.
 *
 * pactl prints one line per channel; the first percentage is the one, since
 * a balance-shifted pair still agrees on the average a user would mean.
 */
function parsePactlVolume(stdout) {
  const m = /\/\s*(\d+)%/.exec(String(stdout || ''));
  if (!m) return null;
  return { level: Math.min(100, Number(m[1])), muted: false };
}

/**
 * Which volume tool this machine has.
 *
 * wpctl is WirePlumber (the default on any current distribution), pactl is
 * PulseAudio (still common, and what PipeWire's compatibility layer answers
 * to). ALSA's amixer is left out deliberately: it has no notion of a default
 * sink, so on a machine with two cards it would guess.
 */
async function audioBackend() {
  for (const bin of ['wpctl', 'pactl']) {
    const r = await runCommand(`command -v ${bin} >/dev/null 2>&1`, { timeoutMs: 5000 });
    if (r.ok) return bin;
  }
  return null;
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

  async move_cursor(args) {
    const x = Number(args.x);
    const y = Number(args.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error('move_cursor needs numeric x and y screen coordinates. Use list_windows or take_screenshot to find where to click.');
    }
    const r = await runCommand(`xdotool mousemove ${Math.round(x)} ${Math.round(y)}`, { timeoutMs: 10000 });
    if (!r.ok) throw new Error(`Could not move the cursor: ${r.stderr || r.stdout}`);
    return { x: Math.round(x), y: Math.round(y), position: await cursorPosition() };
  },

  async click(args) {
    const x = args.x === undefined ? NaN : Number(args.x);
    const y = args.y === undefined ? NaN : Number(args.y);
    const button = String(args.button || 'left').toLowerCase();
    const BUTTONS = { left: 1, middle: 2, right: 3 };
    if (BUTTONS[button] === undefined) {
      throw new Error(`Unknown mouse button "${args.button}". Use left, right or middle.`);
    }

    const times = Math.max(1, Math.min(5, Number(args.clicks) || 1));
    const steps = [];

    if (Number.isFinite(x) && Number.isFinite(y)) {
      steps.push(`xdotool mousemove ${Math.round(x)} ${Math.round(y)}`);
      steps.push(`sleep ${Math.max(60, Number(args.settle) || 120) / 1000}`);
    }

    if (args.wheel !== undefined && args.wheel !== null && Number(args.wheel) !== 0) {
      // 4 is wheel up and 5 is wheel down - the numbering X11 has used since
      // long before xdotool existed.
      const notches = Math.max(-10, Math.min(10, Number(args.wheel) || 0));
      const key = notches > 0 ? 4 : 5;
      for (let i = 0; i < Math.abs(notches); i += 1) steps.push(`xdotool click ${key}`);
      steps.push('sleep 0.15');
    }

    for (let i = 0; i < times; i += 1) {
      steps.push(`xdotool click ${BUTTONS[button]}`);
      if (i < times - 1) steps.push('sleep 0.07');
    }

    steps.push('sleep 0.15');
    // Read-back is not fatal: the clicks already happened, and a pointer
    // position that cannot be read should not turn a success into a failure.
    steps.push('xdotool getmouselocation --shell 2>/dev/null || true');

    const r = await runCommand(steps.join('\n'), { timeoutMs: 20000 });
    if (!r.ok) throw new Error(`Could not click: ${r.stderr || r.stdout}`);
    return {
      button: args.button || 'left',
      clicks: args.clicks ?? 1,
      at: Number.isFinite(x) ? { x: Math.round(x), y: Math.round(y) } : 'current position',
      position: parseMouseLocation(r.stdout),
    };
  },

  async type_text(args) {
    const text = String(args.text ?? '');
    if (!text) throw new Error('type_text needs text.');
    // The same pause the Windows side takes before SendKeys, so the window
    // has a moment to take focus; --delay paces the keystrokes after that.
    await requireOk(
      await runCommand(`sleep 0.25 && xdotool type --clearmodifiers --delay 12 ${shellQuote(text)}`, { timeoutMs: 20000 }),
      'type_text'
    );
    return { typed: text.length, note: 'Text was sent to the focused window.' };
  },

  async type_command(args) {
    const command = String(args.command || '').trim();
    if (!command) throw new Error('type_command needs a command.');
    const shell = String(args.shell || 'bash').toLowerCase();
    if (!['bash', 'sh', 'terminal'].includes(shell)) {
      throw new Error(`shell must be "bash", "sh" or "terminal", not "${shell}".`);
    }

    const opened = await openTerminal();
    if (!opened) {
      throw new Error('No terminal was found on this desktop. Install one - "sudo apt install xterm" is the smallest - and try again.');
    }

    // Give the window time to appear and take focus before anything is typed
    // into it: whatever has focus when xdotool runs is what receives the keys.
    await new Promise((resolve) => setTimeout(resolve, 1400));

    const keys = `xdotool type --clearmodifiers --delay 12 ${shellQuote(command)}`;
    const enter = args.pressEnter === false ? '' : '\nxdotool key Return';
    const r = await runCommand(`sleep 0.2 && ${keys}${enter}`, { timeoutMs: 40000 });
    if (!r.ok) throw new Error(`Could not type the command: ${r.stderr || r.stdout}`);

    return {
      command,
      shell,
      pressedEnter: args.pressEnter !== false,
      note:
        args.pressEnter === false
          ? 'The command was typed into a new terminal window and left there for you to read.'
          : 'The command was typed into a new terminal window and run.',
    };
  },

  async press_keys(args) {
    const keys = String(args.keys || '');
    if (!keys) throw new Error('press_keys needs a key string.');

    const syms = toXdotoolKeys(keys);
    // Each keysym is quoted separately so it arrives as its own argument:
    // a key name must never be read as shell syntax, and xdotool takes a
    // list of keysyms rather than one string.
    const list = syms.map(shellQuote).join(' ');
    await requireOk(await runCommand(`xdotool key --clearmodifiers ${list}`, { timeoutMs: 15000 }), 'press_keys');
    return { keys, sent: true };
  },

  async delete_path(args) {
    const target = resolvePath(args.path);
    const st = await fsp.lstat(target).catch(() => null);
    if (!st) throw new Error(`Nothing to delete at ${target}`);

    if (!args.permanent) {
      // gio trash is the freedesktop standard that GNOME, KDE and XFCE all
      // answer to; trash-put is the older standalone tool some setups still
      // ship. Either way the file comes back with undo, which is the point -
      // and like the Windows side, a trash that is not available falls
      // through to a permanent delete rather than refusing the request.
      const res = await runCommand(`gio trash ${shellQuote(target)} 2>/dev/null || trash-put ${shellQuote(target)}`, {
        timeoutMs: 30000,
      });
      if (res.ok) return { path: target, deleted: true, permanent: false, note: 'Moved to the trash.' };
    }

    await fsp.rm(target, { recursive: true, force: true });
    return { path: target, deleted: true, permanent: true, note: 'Permanently deleted.' };
  },

  async run_script_file(args) {
    const file = String(args.path || '').trim();
    if (!file) throw new Error('run_script_file needs a path to a .sh file.');
    if (!fs.existsSync(file)) throw new Error(`That script does not exist: ${file}`);
    const ext = path.extname(file).toLowerCase();
    if (!['.sh', '.bash'].includes(ext)) {
      throw new Error(`run_script_file only runs .sh and .bash files, not "${ext}".`);
    }
    // bash rather than sh: a script asking to be run is asking for the shell
    // it was written for, and bash is what every .sh on a desktop assumes.
    // The file does not need to be executable - the interpreter is named
    // rather than invoked - which is what makes a downloaded script run.
    const r = await runCommand(`bash ${shellQuote(file)}`, { timeoutMs: 120000 });
    return {
      path: file,
      exitCode: r.code,
      ok: r.ok,
      stdout: String(r.stdout || '').slice(0, 4000),
      stderr: String(r.stderr || '').slice(0, 2000),
    };
  },

  async get_volume() {
    const backend = await audioBackend();
    if (backend === 'wpctl') {
      const r = await runCommand('wpctl get-volume @DEFAULT_AUDIO_SINK@', { timeoutMs: 15000 });
      if (!r.ok) throw new Error(`Could not read the volume: ${r.stderr || r.stdout}`);
      const v = parseWpctlVolume(r.stdout);
      if (!v) throw new Error(`Could not read the volume: ${r.stdout || 'no output'}`);
      return v;
    }
    if (backend === 'pactl') {
      const vol = await runCommand('pactl get-sink-volume @DEFAULT_SINK@', { timeoutMs: 15000 });
      if (!vol.ok) throw new Error(`Could not read the volume: ${vol.stderr || vol.stdout}`);
      const v = parsePactlVolume(vol.stdout);
      if (!v) throw new Error(`Could not read the volume: ${vol.stdout || 'no output'}`);
      const mute = await runCommand('pactl get-sink-mute @DEFAULT_SINK@', { timeoutMs: 15000 });
      return { level: v.level, muted: mute.ok ? /\byes\b/i.test(mute.stdout) : false };
    }
    throw new Error('No volume control was found. Install wireplumber (wpctl) or pulseaudio-utils (pactl).');
  },

  async set_volume(args) {
    const hasLevel = typeof args.level === 'number' && !Number.isNaN(args.level);
    const hasMute = typeof args.mute === 'boolean';
    if (!hasLevel && !hasMute) throw new Error('set_volume needs a level (0-100) or a mute flag.');

    const backend = await audioBackend();
    if (!backend) throw new Error('No volume control was found. Install wireplumber (wpctl) or pulseaudio-utils (pactl).');

    const steps = [];
    if (hasLevel) {
      const level = clamp(Math.round(args.level), 0, 100);
      // wpctl takes a fraction and pactl a percentage; each is given the
      // spelling it documents rather than one guessed to work on both.
      steps.push(
        backend === 'wpctl'
          ? `wpctl set-volume @DEFAULT_AUDIO_SINK@ ${(level / 100).toFixed(2)}`
          : `pactl set-sink-volume @DEFAULT_SINK@ ${level}%`
      );
    }
    if (hasMute) {
      steps.push(
        backend === 'wpctl'
          ? `wpctl set-mute @DEFAULT_AUDIO_SINK@ ${args.mute ? '1' : '0'}`
          : `pactl set-sink-mute @DEFAULT_SINK@ ${args.mute ? '1' : '0'}`
      );
    }

    await requireOk(await runCommand(steps.join('\n'), { timeoutMs: 20000 }), 'set_volume');
    return hasLevel ? { level: clamp(Math.round(args.level), 0, 100) } : { mute: args.mute };
  },

  async system_power(args) {
    const action = String(args.action || '').toLowerCase();
    const delay = clamp(Number(args.delaySeconds ?? 15), 0, 300);
    const grace = delay > 0 ? `sleep ${delay}\n` : '';

    // Each action tries its commands in order until one is understood, which
    // is how a machine is met halfway: loginctl on a systemd session, the
    // desktop's own logout on GNOME, systemctl for the two that have no
    // desktop-specific spelling worth preferring.
    const ACTIONS = {
      lock: {
        cmds: ['loginctl lock-session', 'xdg-screensaver lock', 'gnome-screensaver-command -l'],
        note: 'The PC locks when the timer finishes.',
      },
      signout: {
        cmds: ['gnome-session-quit --logout --no-prompt', 'loginctl terminate-session "$XDG_SESSION_ID"'],
        note: 'Sign-out was requested.',
      },
      sleep: { cmds: ['systemctl suspend'], note: null },
      restart: { cmds: ['systemctl reboot'], note: 'Shutting down. Everything open will close.' },
      shutdown: { cmds: ['systemctl poweroff'], note: 'Shutting down. Everything open will close.' },
    };

    const plan = ACTIONS[action];
    if (!plan) throw new Error(`Unknown power action "${action}".`);

    const r = await runCommand(`${grace}${plan.cmds.join(' || ')}`, { timeoutMs: (delay + 20) * 1000 });
    if (!r.ok) throw new Error(`Could not ${action}: ${r.stderr || r.stdout}`);

    const out = { action, delaySeconds: delay };
    if (plan.note) out.note = plan.note;
    return out;
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
  parseMouseLocation,
  toXdotoolKeys,
  translateChunk,
  TERMINALS,
  openTerminal,
  parseWpctlVolume,
  parsePactlVolume,
  audioBackend,
};

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

module.exports = {
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
};

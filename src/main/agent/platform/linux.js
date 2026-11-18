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

module.exports = { runCommand, shWrapper, shellQuote, runShell, pickShell };

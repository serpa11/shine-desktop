'use strict';

/**
 * The Windows shell bridge.
 *
 * Two shells, chosen per command rather than globally, because they are not
 * interchangeable:
 *
 *   - PowerShell understands cmdlets but Windows PowerShell 5.1 cannot even
 *     parse `&&`, and `type` there is Get-Content rather than a file dump.
 *   - cmd.exe understands the syntax models naturally reach for, but cannot
 *     run a cmdlet.
 *
 * runCommand() picks between them and reports which one it used, so the
 * activity log says what actually happened.
 */

const { exec, execFile } = require('node:child_process');

/**
 * Runs a PowerShell script.
 *
 * The script travels as -EncodedCommand so we never have to worry about
 * quoting a user- or model-supplied string into a command line.
 */
function runPowerShell(script, { timeoutMs = 30000, sta = false } = {}) {
  return new Promise((resolve) => {
    const payload = Buffer.from(script, 'utf16le').toString('base64');
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', payload];
    if (sta) args.splice(1, 0, '-STA');

    execFile(
      'powershell.exe',
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 12 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const code = err && typeof err.code === 'number' ? err.code : err ? 1 : 0;
        resolve({
          ok: !err,
          code,
          stdout: String(stdout || '').trim(),
          stderr: String(stderr || '').trim(),
          timedOut: Boolean(err && err.killed),
        });
      }
    );
  });
}

/**
 * Runs a cmd.exe-style command.
 *
 * This deliberately does not use execFile('cmd.exe', ['/c', command]). Node
 * escapes that argument with backslash-escaped quotes, and cmd.exe has no \"
 * escape: it reads the stray quote as a terminator, so every command that
 * quotes a path fails with "The filename, directory name, or volume label
 * syntax is incorrect". Handing the string to child_process to run through
 * the platform shell is the only form that survives quoted paths, && chains,
 * pipes and `type nul` alike - all four were checked against each other
 * before this was written. Leaving `shell` unset also means the OS default is
 * used, so the same call works when Shine is ported to Linux.
 */
function runCmd(command, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    exec(
      command,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 12 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const code = err && typeof err.code === 'number' ? err.code : err ? 1 : 0;
        resolve({
          ok: !err,
          code,
          stdout: String(stdout || '').trim(),
          stderr: String(stderr || '').trim(),
          timedOut: Boolean(err && err.killed),
        });
      }
    );
  });
}

/**
 * True when a command is written for cmd.exe rather than PowerShell.
 *
 * run_command used to hand everything to PowerShell, which made cmd spelling
 * either misbehave or not run at all: `type` is Get-Content there, so
 * "type nul > file" tries to read a path called nul, and Windows PowerShell
 * 5.1 has no && - that one is a *parse* error, which kills the entire script
 * so not even the rest of the line executes. A model retrying with a
 * different phrasing of the same cmd syntax just hits the same wall.
 *
 * Only syntax that genuinely cannot mean the same thing in both shells is
 * listed. A false negative is covered by the parse-error retry below.
 */
function looksLikeCmd(command) {
  const c = String(command);
  if (/&&|\|\|/.test(c)) return true; // PowerShell 5.1 cannot parse it
  if (/\bnul\b/i.test(c)) return true; // type nul >, > nul, 2> nul
  if (/%[A-Za-z_][A-Za-z0-9_]*%/.test(c)) return true; // %USERNAME% expansion
  if (/^\s*@?echo\s+(off|on)\b/i.test(c)) return true;
  // "echo x > file" means the same words in both shells but writes different
  // bytes: cmd writes plain text, Windows PowerShell 5.1 writes UTF-16 with a
  // BOM. A .bat created that way is one cmd.exe refuses to run, so the cmd
  // reading is the one that behaves as written.
  if (/^\s*@?echo\s[^<>\n]*[>]{1,2}\s*\S/.test(c)) return true;
  // cmd builtins used with cmd-only switches: dir /w, del /f /q, copy /y,
  // cd /d. A forward slash after a space, so C:/Users is not mistaken for one.
  if (/^\s*(cd|dir|copy|del|erase|move|ren|rename|md|rd|attrib|type)\b[^\n]*\s\/[a-zA-Z]/.test(c)) return true;
  return false;
}

/**
 * True when PowerShell refused to parse the script, meaning nothing ran.
 *
 * This is the safety net for a cmd command the detector missed: re-running
 * through cmd.exe cannot make matters worse, because PowerShell never got as
 * far as executing anything.
 */
function looksLikeParseError(result) {
  const text = `${result.stderr || ''}\n${result.stdout || ''}`;
  return /ParserError|InvalidEndOfLine|not a valid statement separator|Unexpected token|The token '/i.test(text);
}

/**
 * The wrapper around a single command.
 *
 * Errors are terminating inside it so that a failed command is reported as a
 * failure. PowerShell otherwise exits 0 even when the command was not found,
 * which would make Shine believe it worked.
 */
function psWrapper(command) {
  return [
    '$ProgressPreference = "SilentlyContinue"',
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$__exit = 0',
    'try {',
    '  $ErrorActionPreference = "Stop"',
    `  ${command}`,
    '  if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { $__exit = $LASTEXITCODE }',
    '} catch {',
    '  [Console]::Error.WriteLine($_.Exception.Message)',
    '  $__exit = 1',
    '}',
    'exit $__exit',
  ].join('\n');
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Runs one command, deciding which shell reads it.
 *
 * @param {string} command
 * @param {{timeoutMs?:number, shell?:string}} [options]
 * @returns {Promise<{ok:boolean, code:number, stdout:string, stderr:string,
 *   timedOut:boolean, shell:string}>}
 */
async function runCommand(command, { timeoutMs = 30000, shell } = {}) {
  const requested = String(shell || '').trim().toLowerCase();
  const forced = requested === 'cmd' || requested === 'powershell' || requested === 'pwsh';
  const useCmd = forced ? requested === 'cmd' : looksLikeCmd(command);

  let res;
  let used = useCmd ? 'cmd' : 'powershell';
  if (useCmd) {
    res = await runCmd(command, { timeoutMs });
  } else {
    res = await runPowerShell(psWrapper(command), { timeoutMs, sta: true });
    if (!res.ok && looksLikeParseError(res)) {
      res = await runCmd(command, { timeoutMs });
      used = 'cmd';
    }
  }

  return { ...res, shell: used };
}

module.exports = {
  runCommand,
  runPowerShell,
  runCmd,
  psWrapper,
  psQuote,
  looksLikeCmd,
  looksLikeParseError,
};

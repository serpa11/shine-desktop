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

const path = require('node:path');
const { exec, execFile } = require('node:child_process');

// requireOk lives in its own file because a platform module cannot import
// it from executor.js without the two importing each other.
const { requireOk } = require('../result');
const { USER32_CSHARP } = require('./win32');

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

/**
 * Builds the PowerShell that hunts for installed applications.
 *
 * Start-Process only resolves whatever is on PATH, which is almost nothing
 * that is actually installed, so "open spotify" failed for most apps. Windows
 * keeps the real answer in three places, and this checks all of them:
 *
 *   1. the App Paths registry key, which installers write for every app
 *   2. both Start Menu folders, which hold shortcuts for installed programs
 *   3. Program Files and System32, for anything else portable
 *
 * The user can also hand over a path directly, which is checked first so
 * "open D:\Games\thing.exe" always does exactly what was asked.
 */
function appSearchScript(query, limit, doLaunch, argPart = '') {
  const direct = path.extname(query).toLowerCase() === '.exe' ? `, ${psQuote(query)}` : '';

  return `
$ErrorActionPreference = 'SilentlyContinue'
$query = ${psQuote(query)}
$limit = ${limit}
$found = New-Object System.Collections.Generic.List[string]

function Add-Match($p) {
  if ($p -and (Test-Path -LiteralPath $p) -and -not $found.Contains($p)) { $found.Add($p) }
}

# A full path was given - use it as-is.
if ($query -match '^[A-Za-z]:\\\\') { Add-Match $query }

# 1. App Paths registry: written by installers, the most reliable source.
foreach ($root in @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths',
                    'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths',
                    'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths')) {
  foreach ($k in @(Get-ChildItem -Path $root -ErrorAction SilentlyContinue |
                   Where-Object { $_.PSChildName -like "*$query*" } | Select-Object -First $limit)) {
    Add-Match (Get-ItemProperty -Path $k.PSPath -ErrorAction SilentlyContinue).'(default)'
  }
}

# 2. Start Menu shortcuts. Resolve the target so the result is a real exe.
$shell = New-Object -ComObject WScript.Shell
foreach ($menu in @("$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs",
                    "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs")) {
  if (-not (Test-Path $menu)) { continue }
  Get-ChildItem -Path $menu -Filter *.lnk -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.BaseName -like "*$query*" } | Select-Object -First $limit |
    ForEach-Object { Add-Match ($shell.CreateShortcut($_.FullName).TargetPath) }
}

# 3. Program Files and the system folder, shallow.
$dirs = @($env:ProgramFiles, "\${env:ProgramFiles(x86)}", "$env:SystemRoot\\System32")
foreach ($d in $dirs) {
  if (-not $d -or -not (Test-Path $d)) { continue }
  Get-ChildItem -Path $d -Filter "*$query*.exe" -Recurse -Depth 2 -ErrorAction SilentlyContinue |
    Select-Object -First $limit | ForEach-Object { Add-Match $_.FullName }
}

if ($found.Count -eq 0) { Write-Output 'NOT_FOUND'; exit 0 }
Write-Output ('MATCHES:' + ($found -join '|'))

${doLaunch
    ? `Start-Process -FilePath $found[0] -ErrorAction Stop
Write-Output ('LAUNCHED:' + $found[0])`
    : `$found | Select-Object -First $limit | ForEach-Object { Write-Output ('MATCH:' + $_) }`}
`;
}

function parseAppMatches(stdout) {
  const line = /MATCHES:(.+)/.exec(String(stdout || ''));
  const raw = line ? line[1].split('|') : [];
  return raw
    .concat([...String(stdout || '').matchAll(/^MATCH:(.+)$/gm)].map((m) => m[1]))
    .map((s) => s.trim())
    .filter((s, i, arr) => s && arr.indexOf(s) === i);
}

/** Opens a file or folder with whatever Windows has associated with it. */
async function openPath(target) {
  return runPowerShell(`Start-Process -FilePath ${psQuote(target)}`);
}

async function openUrl(url) {
  return runPowerShell(`Start-Process ${psQuote(url)}`);
}

async function findApplications(query, limit) {
  const r = await runPowerShell(appSearchScript(query, limit, false), { timeoutMs: 45000 });
  return { matches: parseAppMatches(r.stdout), searched: 'Start Menu, App Paths registry, Program Files' };
}

async function launchApplication(name, { arguments: argv, limit = 5 } = {}) {
  const argPart = argv ? ` -ArgumentList ${psQuote(String(argv))}` : '';

  const script = appSearchScript(name, limit, true, argPart);
  const r = await runPowerShell(script, { timeoutMs: 60000 });
  const launched = /LAUNCHED:(.+)/.exec(r.stdout || '');
  if (launched) return { launched: true, path: launched[1].trim(), via: 'search' };

  // Last resort: the shell's own resolution, which handles bare names on PATH.
  for (const candidate of [name, `${name}.exe`]) {
    const attempt = await runPowerShell(`Start-Process ${psQuote(candidate)}${argPart} -ErrorAction Stop`);
    if (attempt.ok) return { launched: true, executable: candidate, via: 'path' };
  }

  return { launched: false, matches: parseAppMatches(r.stdout) };
}

/**
 * The tools whose behaviour *is* the desktop.
 *
 * Nothing here is translated: closing, focusing, listing and killing are
 * defined by this machine, so each platform carries its own copy of the
 * whole method and executor.js assembles impl from platform.toolImpls.
 * These were moved as-is - the Windows behaviour is meant to be identical.
 */
const toolImpls = {
  async close_app(args) {
    const name = String(args.name || '').trim();
    const script = `$p = Get-Process | Where-Object { $_.ProcessName -like ${psQuote(`*${name}*`)} -or $_.MainWindowTitle -like ${psQuote(`*${name}*`)} };
if (-not $p) { Write-Output "NOT_FOUND"; exit 0 }
$n = 0
foreach ($x in $p) { try { if ($x.MainWindowHandle -ne 0) { $x.CloseMainWindow() | Out-Null; $n++ } else { Stop-Process -Id $x.Id -Force; $n++ } } catch {} }
Start-Sleep -Milliseconds 900
Get-Process | Where-Object { $_.ProcessName -like ${psQuote(`*${name}*`)} } | ForEach-Object { try { Stop-Process -Id $_.Id -Force } catch {} }
Write-Output ("CLOSED:" + $n)`;
    const r = await runPowerShell(script, { timeoutMs: 20000 });
    const closed = /CLOSED:(\d+)/.exec(r.stdout || '');
    if (/NOT_FOUND/.test(r.stdout || '')) throw new Error(`No running app matching "${name}" was found.`);
    return { app: name, closed: Number(closed?.[1] || 0) };
  },
  async kill_process(args) {
    const pid = Number(args.pid);
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('kill_process needs a valid pid.');
    if (pid === process.pid) throw new Error('Shine refused to kill its own process.');
    const info = await runPowerShell(`$p = Get-Process -Id ${pid} -ErrorAction Stop; $p.ProcessName`);
    const name = (info.stdout || '').trim();
    if (['shinedesktop', 'electron', 'explorer', 'winlogon', 'csrss', 'system', 'services', 'lsass'].includes(name.toLowerCase())) {
      throw new Error(`Shine refuses to force-end "${name}" because it is a critical Windows process.`);
    }
    const r = await runPowerShell(`Stop-Process -Id ${pid} -Force`);
    await requireOk(r, 'kill_process');
    return { pid, process: name, killed: true };
  },
  async focus_window(args) {
    const title = String(args.title || '').trim();
    const script = `${USER32_CSHARP}
$p = Get-Process | Where-Object { $_.MainWindowTitle -like ${psQuote(`*${title}*`)} } | Select-Object -First 1
if (-not $p) { Write-Output "NOT_FOUND"; exit 0 }
[void][Win]::ShowWindow($p.MainWindowHandle, 9)
Start-Sleep -Milliseconds 120
[void][Win]::SetForegroundWindow($p.MainWindowHandle)
Write-Output ("FOCUSED:" + $p.MainWindowTitle)`;
    const r = await runPowerShell(script, { timeoutMs: 15000 });
    if (/NOT_FOUND/.test(r.stdout || '')) throw new Error(`No open window title contains "${title}".`);
    return { title: (r.stdout || '').replace(/^FOCUSED:/, '').trim(), focused: true };
  },
  async list_windows() {
    const script = `Add-Type -Namespace Native -Name Win -MemberDefinition @"
[DllImport(\\"user32.dll\\")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport(\\"user32.dll\\")] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder s, int n);
"@
$found = @()
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  delegate bool EnumProc(IntPtr h, IntPtr l);
  public static List<string> List() {
    var res = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, 512);
      var t = sb.ToString().Trim();
      if (t.Length == 0) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      res.Add(t + "\\t" + pid);
      return true;
    }, IntPtr.Zero);
    return res;
  }
}
"@
[W]::List() | ForEach-Object { $_ }`;
    const r = await runPowerShell(script, { timeoutMs: 15000 });
    const windows = (r.stdout || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [title, pid] = line.split('\t');
        return { title, pid: Number(pid) };
      });
    return { count: windows.length, windows: windows.slice(0, 60) };
  },
  async list_processes(args) {
    const filter = String(args.filter || '').trim().toLowerCase();
    const script = `Get-Process | Where-Object { $_.ProcessName } | Select-Object Id,ProcessName,@{n='MemoryMB';e={[math]::Round($_.WorkingSet64/1MB,1)}},@{n='Window';e={$_.MainWindowTitle}} | ConvertTo-Json -Compress`;
    const r = await requireOk(await runPowerShell(script, { timeoutMs: 20000 }), 'list_processes');
    let rows = [];
    try {
      const parsed = JSON.parse(r.stdout || '[]');
      rows = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      rows = [];
    }
    const filtered = filter ? rows.filter((p) => String(p.ProcessName).toLowerCase().includes(filter)) : rows;
    filtered.sort((a, b) => (b.MemoryMB || 0) - (a.MemoryMB || 0));
    return { count: filtered.length, processes: filtered.slice(0, 120) };
  },
};

module.exports = {
  toolImpls,
  runCommand,
  runPowerShell,
  runCmd,
  psWrapper,
  psQuote,
  looksLikeCmd,
  looksLikeParseError,
  openPath,
  openUrl,
  findApplications,
  launchApplication,
};

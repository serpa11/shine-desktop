'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn, execFile } = require('node:child_process');

const { TOOL_MAP, normaliseArgs } = require('./tools');

/* ------------------------------------------------------------------ */
/* PowerShell bridge                                                  */
/* ------------------------------------------------------------------ */

/**
 * PowerShell is invoked through -EncodedCommand so we never have to worry
 * about quoting a user/model supplied string into a command line.
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

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function requireOk(result, label) {
  if (!result.ok) {
    const detail = result.stderr || result.stdout || `exit code ${result.code}`;
    throw new Error(`${label} failed: ${detail.slice(0, 1200)}`);
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Formatting helpers                                                 */
/* ------------------------------------------------------------------ */

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n)) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatWhen(ms) {
  if (!ms) return '-';
  const d = new Date(Number(ms));
  const diff = Date.now() - Number(ms);
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return d.toISOString().slice(0, 16).replace('T', ' ');
}

/* ------------------------------------------------------------------ */
/* Windows helpers                                                    */
/* ------------------------------------------------------------------ */

const CORE_AUDIO_CSHARP = `
using System;
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int _0(); int _1(); int _2(); int _3();
  int SetMasterVolumeLevelScalar(float level, ref Guid ctx);
  int _5();
  int GetMasterVolumeLevelScalar(out float level);
  int _7();
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
  int GetMute(out bool mute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref System.Guid id, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int _0(); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice dev); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
public static class Audio {
  static IAudioEndpointVolume Vol() {
    var e = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
    IMMDevice dev;
    Marshal.ThrowExceptionForHR(e.GetDefaultAudioEndpoint(0, 1, out dev));
    var iid = typeof(IAudioEndpointVolume).GUID;
    object o;
    Marshal.ThrowExceptionForHR(dev.Activate(ref iid, 23, IntPtr.Zero, out o));
    return (IAudioEndpointVolume)o;
  }
  public static int GetVolume() { float v; Marshal.ThrowExceptionForHR(Vol().GetMasterVolumeLevelScalar(out v)); return (int)Math.Round(v * 100); }
  public static bool GetMute() { bool m; Marshal.ThrowExceptionForHR(Vol().GetMute(out m)); return m; }
  public static void SetVolume(int level) { var g = Guid.Empty; Vol().SetMasterVolumeLevelScalar(Math.Max(0, Math.Min(100, level)) / 100f, ref g); }
  public static void SetMute(bool mute) { var g = Guid.Empty; Vol().SetMute(mute, ref g); }
}
`;

const USER32_CSHARP = `
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Win {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c, string n);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
`;

/* ------------------------------------------------------------------ */
/* Tool implementations                                               */
/* ------------------------------------------------------------------ */

const impl = {
  async system_info() {
    const disk = await fsp.statfs(os.homedir()).catch(() => null);
    let drives = 'unavailable';
    try {
      const r = await requireOk(
        await runPowerShell("Get-PSDrive -PSProvider FileSystem | Select-Object Name,@{n='FreeGB';e={[math]::Round($_.Free/1GB,1)}},@{n='UsedGB';e={[math]::Round($_.Used/1GB,1)}} | ConvertTo-Json -Compress"),
        'Disk query'
      );
      drives = r.stdout;
    } catch {}

    return {
      hostname: os.hostname(),
      username: os.userInfo().username,
      os: `${os.type()} ${os.release()} (${process.platform})`,
      osVersion: safeOsVersion(),
      arch: os.arch(),
      cpu: os.cpus()[0]?.model?.trim() || 'unknown',
      cpuCores: os.cpus().length,
      totalMemoryGB: Number((os.totalmem() / 1024 ** 3).toFixed(1)),
      freeMemoryGB: Number((os.freemem() / 1024 ** 3).toFixed(1)),
      homeDirectory: os.homedir(),
      desktop: path.join(os.homedir(), 'Desktop'),
      downloads: path.join(os.homedir(), 'Downloads'),
      documents: path.join(os.homedir(), 'Documents'),
      uptimeHours: Number((os.uptime() / 3600).toFixed(1)),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      localTime: new Date().toString(),
      drives,
    };
  },

  async list_directory(args) {
    const dir = resolvePath(args.path || os.homedir());
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const rows = [];
    for (const entry of entries.slice(0, 500)) {
      const full = path.join(dir, entry.name);
      let size = null;
      let mtime = null;
      if (entry.isFile()) {
        const st = await fsp.stat(full).catch(() => null);
        if (st) {
          size = st.size;
          mtime = st.mtimeMs;
        }
      }
      rows.push({
        name: entry.name,
        type: entry.isDirectory() ? 'folder' : 'file',
        size: size === null ? null : formatBytes(size),
        modified: mtime ? formatWhen(mtime) : null,
      });
    }
    return { path: dir, count: rows.length, entries: rows };
  },

  async search_files(args) {
    const root = resolvePath(args.path || os.homedir());
    const query = String(args.query || '').toLowerCase();
    const maxDepth = clamp(Number(args.maxDepth || 4), 1, 10);
    const limit = clamp(Number(args.limit || 50), 1, 300);
    const results = [];
    const skip = new Set(['node_modules', '.git', 'AppData', '$Recycle.Bin', 'System Volume Information', '.cache']);

    async function walk(dir, depth) {
      if (depth > maxDepth || results.length >= limit) return;
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (results.length >= limit) return;
        if (skip.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        const matches = !query || entry.name.toLowerCase().includes(query);
        if (matches) {
          const st = await fsp.stat(full).catch(() => null);
          results.push({
            name: entry.name,
            path: full,
            type: entry.isDirectory() ? 'folder' : 'file',
            size: st?.isFile() ? formatBytes(st.size) : null,
            modified: st ? formatWhen(st.mtimeMs) : null,
          });
        }
        if (entry.isDirectory()) await walk(full, depth + 1);
      }
    }

    await walk(root, 0);
    return { searchedIn: root, query, matches: results.length, results: results.slice(0, limit) };
  },

  async read_file(args) {
    const file = resolvePath(args.path);
    const maxBytes = clamp(Number(args.maxBytes || 200000), 1, 5 * 1024 * 1024);
    const st = await fsp.stat(file).catch(() => null);
    if (!st) throw new Error(`File not found: ${file}`);
    if (st.isDirectory()) throw new Error(`${file} is a folder. Use list_directory instead.`);
    const handle = await fsp.open(file, 'r');
    try {
      const length = Math.min(st.size, maxBytes);
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, 0);
      return {
        path: file,
        size: formatBytes(st.size),
        truncated: st.size > maxBytes,
        content: buf.toString('utf8'),
      };
    } finally {
      await handle.close();
    }
  },

  async write_file(args) {
    const file = resolvePath(args.path);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const mode = args.append ? 'a' : 'w';
    const existed = fs.existsSync(file);
    await fsp.writeFile(file, String(args.content ?? ''), { encoding: 'utf8', flag: mode });
    return { path: file, action: mode === 'a' ? 'appended' : existed ? 'overwritten' : 'created', bytes: Buffer.byteLength(String(args.content ?? '')) };
  },

  async create_directory(args) {
    const dir = resolvePath(args.path);
    await fsp.mkdir(dir, { recursive: true });
    return { path: dir, created: true };
  },

  async delete_path(args) {
    const target = resolvePath(args.path);
    const st = await fsp.lstat(target).catch(() => null);
    if (!st) throw new Error(`Nothing to delete at ${target}`);

    if (!args.permanent) {
      const script = st.isDirectory()
        ? `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory(${psQuote(target)}, 'OnlyErrorDialogs', 'SendToRecycleBin')`
        : `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(${psQuote(target)}, 'OnlyErrorDialogs', 'SendToRecycleBin')`;
      const res = await runPowerShell(script, { timeoutMs: 30000 });
      if (res.ok) return { path: target, deleted: true, permanent: false, note: 'Moved to the Recycle Bin.' };
    }

    await fsp.rm(target, { recursive: true, force: true });
    return { path: target, deleted: true, permanent: true, note: 'Permanently deleted.' };
  },

  async move_path(args) {
    const from = resolvePath(args.from);
    const to = resolvePath(args.to);
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.rename(from, to).catch(async (err) => {
      if (err.code === 'EXDEV') {
        await fsp.cp(from, to, { recursive: true });
        await fsp.rm(from, { recursive: true, force: true });
        return;
      }
      throw err;
    });
    return { from, to, moved: true };
  },

  async copy_path(args) {
    const from = resolvePath(args.from);
    const to = resolvePath(args.to);
    await fsp.mkdir(path.dirname(to), { recursive: true });
    const st = await fsp.stat(from).catch(() => null);
    if (!st) throw new Error(`Nothing to copy at ${from}`);
    await fsp.cp(from, to, { recursive: true, force: true });
    return { from, to, copied: true };
  },

  async run_command(args) {
    const command = String(args.command || '').trim();
    if (!command) throw new Error('run_command needs a command.');
    const timeoutMs = clamp(Number(args.timeoutMs || 30000), 1000, 300000);

    // Errors are made terminating inside the wrapper so that a failed command is
// reported as a failure. PowerShell otherwise exits 0 even when the command
// was not found, which would make Shine believe it worked.
const script = [
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

    const res = await runPowerShell(script, { timeoutMs, sta: true });
    const out = (res.stdout || '').slice(0, 40000);
    const err = (res.stderr || '').slice(0, 12000);
    return {
      command,
      exitCode: res.code,
      timedOut: res.timedOut,
      stdout: out || '(no output)',
      stderr: err || null,
      success: res.ok,
    };
  },

  async open_path(args) {
    const target = resolvePath(args.path);
    if (!fs.existsSync(target)) throw new Error(`Nothing found at ${target}`);
    const r = await runPowerShell(`Start-Process -FilePath ${psQuote(target)}`);
    await requireOk(r, 'open_path');
    return { path: target, opened: true };
  },

  async open_url(args) {
    const url = String(args.url || '').trim();
    if (!/^https?:\/\//i.test(url)) throw new Error(`Refusing to open "${url}" - only http and https URLs are allowed.`);
    const r = await runPowerShell(`Start-Process ${psQuote(url)}`);
    await requireOk(r, 'open_url');
    return { url, opened: true };
  },

  async launch_app(args) {
    const name = String(args.name || '').trim();
    if (!name) throw new Error('launch_app needs an app name.');
    const argPart = args.arguments ? ` -ArgumentList ${psQuote(String(args.arguments))}` : '';
    const candidates = [name, `${name}.exe`];
    for (const candidate of candidates) {
      const r = await runPowerShell(`Start-Process ${psQuote(candidate)}${argPart} -ErrorAction Stop`);
      if (r.ok) return { app: name, launched: true, executable: candidate };
    }
    throw new Error(`Could not launch "${name}". Make sure it is installed, or use run_command to install it (for example "winget install <name>").`);
  },

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

  async type_text(args) {
    const text = String(args.text ?? '');
    if (!text) throw new Error('type_text needs text.');
    await requireOk(await runPowerShell(`Start-Sleep -Milliseconds 250; Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(${psQuote(text)}); Start-Sleep -Milliseconds 150`, { sta: true, timeoutMs: 20000 }), 'type_text');
    return { typed: text.length, note: 'Text was sent to the focused window.' };
  },

  async press_keys(args) {
    const keys = String(args.keys || '');
    if (!keys) throw new Error('press_keys needs a key string.');
    await requireOk(await runPowerShell(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(${psQuote(keys)})`, { sta: true, timeoutMs: 15000 }), 'press_keys');
    return { keys, sent: true };
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

  async take_screenshot() {
    // Loaded lazily so the module stays usable outside Electron.
    const { desktopCapturer, screen } = require('electron');
    const display = screen.getPrimaryDisplay();
    const { width, height } = display.size;
    const scale = display.scaleFactor || 1;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) },
      fetchWindowIcons: false,
    });
    const source = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
    if (!source?.thumbnail || source.thumbnail.isEmpty()) throw new Error('Screen capture was blocked or unavailable.');

    const dir = path.join(require('electron').app.getPath('userData'), 'screenshots');
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, `shine-${Date.now()}.png`);
    await fsp.writeFile(file, source.thumbnail.toPNG());

    return {
      path: file,
      width: source.thumbnail.getSize().width,
      height: source.thumbnail.getSize().height,
      note: 'Saved as a PNG. Offer the file to the user with open_path, or open it yourself to look at it.',
    };
  },

  async get_volume() {
    const r = await runPowerShell(`Add-Type -TypeDefinition @'\n${CORE_AUDIO_CSHARP}\n'@ -Language CSharp; [Audio]::GetVolume(); [Audio]::GetMute()`, { timeoutMs: 20000 });
    const [level, mute] = (r.stdout || '').split(/\s+/);
    if (!r.ok) throw new Error(`Could not read the volume: ${r.stderr || 'unknown error'}`);
    return { level: Number(level) || 0, muted: String(mute).trim().toLowerCase() === 'true' };
  },

  async set_volume(args) {
    const parts = [];
    if (typeof args.level === 'number' && !Number.isNaN(args.level)) {
      const level = clamp(Math.round(args.level), 0, 100);
      parts.push(`[Audio]::SetVolume(${level})`);
    }
    if (typeof args.mute === 'boolean') {
      parts.push(`[Audio]::SetMute(${args.mute ? '$true' : '$false'})`);
    }
    if (!parts.length) throw new Error('set_volume needs a level (0-100) or a mute flag.');
    const r = await runPowerShell(`Add-Type -TypeDefinition @'\n${CORE_AUDIO_CSHARP}\n'@ -Language CSharp; ${parts.join('; ')}`, { timeoutMs: 20000 });
    await requireOk(r, 'set_volume');
    return { level: typeof args.level === 'number' ? clamp(Math.round(args.level), 0, 100) : undefined, mute: args.mute };
  },

  async read_clipboard() {
    const { clipboard } = require('electron');
    const text = clipboard.readText();
    return { text, length: text.length };
  },

  async set_clipboard(args) {
    const { clipboard } = require('electron');
    const text = String(args.text ?? '');
    clipboard.writeText(text);
    return { length: text.length, written: true };
  },

  async system_power(args) {
    const action = String(args.action || '').toLowerCase();
    const delay = clamp(Number(args.delaySeconds ?? 15), 0, 300);
    const grace = delay > 0 ? `Start-Sleep -Seconds ${delay}; ` : '';

    switch (action) {
      case 'lock':
        await runPowerShell(`${grace}rundll32.exe user32.dll,LockWorkStation`, { timeoutMs: (delay + 10) * 1000 });
        return { action, delaySeconds: delay, note: 'The PC locks when the timer finishes.' };
      case 'signout':
        await runPowerShell(`${grace}(New-Object -ComObject WScript.Shell).SendKeys('%{F4}'); Start-Sleep -Milliseconds 400`, { timeoutMs: (delay + 10) * 1000 });
        return { action, note: 'Sign-out was requested through the window close dialog.' };
      case 'sleep':
        await runPowerShell(`${grace}rundll32.exe powrprof.dll,SetSuspendState 0,1,0`, { timeoutMs: (delay + 15) * 1000 });
        return { action, delaySeconds: delay };
      case 'restart':
        await runPowerShell(`${grace}Stop-Computer -Force`, { timeoutMs: (delay + 15) * 1000 });
        return { action, delaySeconds: delay, note: 'Shutting down. Everything open will close.' };
      case 'shutdown':
        await runPowerShell(`${grace}Stop-Computer -Force`, { timeoutMs: (delay + 15) * 1000 });
        return { action, delaySeconds: delay, note: 'Shutting down. Everything open will close.' };
      default:
        throw new Error(`Unknown power action "${action}".`);
    }
  },
};

/* ------------------------------------------------------------------ */
/* Dispatch                                                           */
/* ------------------------------------------------------------------ */

function clamp(n, min, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}

function resolvePath(p) {
  const raw = String(p ?? '').trim().replace(/^~(?=$|[\\/])/, os.homedir());
  if (!raw) return os.homedir();
  return path.resolve(raw);
}

function safeOsVersion() {
  try {
    return require('node:child_process')
      .execFileSync('cmd.exe', ['/c', 'ver'], { encoding: 'utf8', windowsHide: true })
      .trim();
  } catch {
    return 'unknown';
  }
}

/**
 * Execute one approved tool call.
 * @returns {Promise<{ok:boolean, output?:any, error?:string, meta?:object}>}
 */
async function execute(name, rawArgs) {
  const spec = TOOL_MAP.get(name);
  if (!spec) return { ok: false, error: `There is no tool called "${name}".` };
  const args = normaliseArgs(name, rawArgs);
  try {
    const output = await impl[name](args);
    return { ok: true, output, meta: { risk: spec.risk } };
  } catch (err) {
    return { ok: false, error: err?.message || String(err), meta: { risk: spec.risk } };
  }
}

/** A short human summary shown in the approval dialog and the activity log. */
function summarise(name, rawArgs) {
  const args = normaliseArgs(name, rawArgs);
  switch (name) {
    case 'run_command':
      return String(args.command || '');
    case 'write_file':
      return `${args.path}${args.append ? ' (append)' : ''}`;
    case 'read_file':
    case 'open_path':
    case 'delete_path':
    case 'create_directory':
      return String(args.path || '');
    case 'move_path':
      return `${args.from}  ->  ${args.to}`;
    case 'copy_path':
      return `${args.from}  ->  ${args.to}`;
    case 'search_files':
      return `"${args.query}" in ${args.path || 'your profile'}`;
    case 'type_text':
    case 'set_clipboard':
      return preview(String(args.text ?? ''));
    case 'press_keys':
      return args.keys;
    case 'system_power':
      return String(args.action || '').toUpperCase();
    case 'launch_app':
      return args.name + (args.arguments ? ` ${args.arguments}` : '');
    case 'close_app':
    case 'focus_window':
    case 'kill_process':
      return name === 'kill_process' ? `PID ${args.pid}` : String(args.name || args.title || '');
    case 'set_volume':
      return args.level !== undefined ? `volume ${args.level}%` : `mute ${args.mute ? 'on' : 'off'}`;
    case 'list_processes':
      return args.filter ? `filter: ${args.filter}` : 'all processes';
    default:
      return '';
  }
}

function preview(text, max = 400) {
  const t = String(text);
  return t.length > max ? `${t.slice(0, max)}\n... (${t.length} characters total)` : t;
}

/** A short one-line description of an action, for the approval list and log. */
function summaryLine(name, rawArgs) {
  const summary = String(summarise(name, rawArgs) || '').split('\n')[0].trim();
  return summary.length > 110 ? `${summary.slice(0, 107)}...` : summary;
}

module.exports = { execute, summarise, summaryLine, runPowerShell, impl };
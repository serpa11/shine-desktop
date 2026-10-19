'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn, execFile } = require('node:child_process');

const { TOOL_MAP, normaliseArgs } = require('./tools');

/* ------------------------------------------------------------------ */
/* Windows settings Shine knows how to change                         */
/* ------------------------------------------------------------------ */

/**
 * The settings change_windows_setting is allowed to touch.
 *
 * This is deliberately a fixed list rather than free-form registry writes.
 * "Change any Windows setting" built on a registry string would let the model
 * corrupt the machine; built on a table, it can only ever reach settings
 * someone chose to expose. Keys are HKCU so nothing needs administrator.
 */
const ACCESSIBILITY_KEY = 'HKCU:\\Control Panel\\Accessibility';
const PERSONALIZE = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize';
const DESKTOP = 'HKCU:\\Control Panel\\Desktop';
const EXPLORER = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced';
const FEATURES = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\FeatureConfig';

const WINDOWS_SETTINGS = {
  // Appearance
  dark_mode: { group: 'appearance', kind: 'theme', key: PERSONALIZE, name: 'AppsUseLightTheme', description: 'Windows and apps in dark mode. Off means light mode.' },
  transparency: { group: 'appearance', kind: 'spi', spi: '0x0013', spiFlags: 0, description: 'Transparency effects behind windows and in menus.' },
  animations: { group: 'appearance', kind: 'spi', spi: '0x0048', description: 'Window minimise and maximise animations.' },
  taskbar_alignment: { group: 'appearance', kind: 'reg', key: EXPLORER + '\\TaskbarSi', name: 'TaskbarAl', type: 'dword', description: 'Where taskbar icons sit: 0 left, 1 centre, 2 right.' },
  show_desktop_icons: { group: 'appearance', kind: 'reg', key: EXPLORER + '\\Desktop', name: 'HideIcons', type: 'dword', description: 'Hide all desktop icons when off.' },
  transparency_taskbar: { group: 'appearance', kind: 'reg', key: PERSONALIZE, name: 'EnableTransparency', type: 'dword', description: 'Transparent taskbar.' },
  start_sound: { group: 'appearance', kind: 'reg', key: DESKTOP, name: 'MNS', type: 'dword', description: 'Play a sound when Windows starts.' },

  // Accessibility
  magnifier: { group: 'accessibility', kind: 'reg', key: ACCESSIBILITY_KEY, name: 'Magnifier', type: 'dword', description: 'The screen magnifier.' },
  narrator: { group: 'accessibility', kind: 'reg', key: `HKCU:\\Control Panel\\Accessibility\\Narrator`, name: 'Narrator', type: 'dword', description: 'Screen reader that reads text aloud.' },
  narrator_verbose: { group: 'accessibility', kind: 'reg', key: `HKCU:\\Control Panel\\Accessibility\\Narrator`, name: 'Verbose', type: 'dword', description: 'Narrator verbosity.' },
  high_contrast: { group: 'accessibility', kind: 'reg', key: ACCESSIBILITY_KEY, name: 'HighContrast', type: 'dword', description: 'High contrast colour scheme.' },
  sticky_keys: { group: 'accessibility', kind: 'reg', key: ACCESSIBILITY_KEY + '\\StickyKeys', name: 'Flags', type: 'dword', description: 'Sticky keys, so modifier keys latch.' },
  filter_keys: { group: 'accessibility', kind: 'reg', key: ACCESSIBILITY_KEY + '\\Keyboard Response', name: 'Flags', type: 'dword', description: 'Filter keys, ignores brief keystrokes.' },
  toggle_keys: { group: 'accessibility', kind: 'reg', key: ACCESSIBILITY_KEY + '\\ToggleKeys', name: 'Flags', type: 'dword', description: 'Toggle keys, Num Lock and Caps Lock.' },
  mouse_keys: { group: 'accessibility', kind: 'reg', key: ACCESSIBILITY_KEY + '\\MouseKeys', name: 'Flags', type: 'dword', description: 'Move the pointer with the number pad.' },
  keyboard_repeat_delay: { group: 'accessibility', kind: 'reg', key: DESKTOP, name: 'KeyboardDelay', type: 'dword', description: 'Delay before a held key repeats, in milliseconds.' },
  cursor_trails: { group: 'accessibility', kind: 'reg', key: ACCESSIBILITY_KEY + '\\CursorTrails', name: 'Flags', type: 'dword', description: 'Leave a trail behind the pointer.' },
  cursor_size: { group: 'accessibility', kind: 'reg', key: DESKTOP, name: 'CursorSize', type: 'dword', description: 'Pointer size, 1 small to 15 huge.' },
  scrollbar_width: { group: 'accessibility', kind: 'reg', key: DESKTOP, name: 'ScrollbarWidth', type: 'dword', description: 'Scrollbar width in pixels.' },
  animation_disabled_systemwide: { group: 'accessibility', kind: 'reg', key: `HKCU:\\Control Panel\\Desktop\\WindowMetrics`, name: 'MinAnimate', type: 'dword', description: 'Disable all window animations system wide.' },
  smooth_scrolling: { group: 'accessibility', kind: 'reg', key: DESKTOP, name: 'UserPreferencesMask', type: 'dword', description: 'Smooth scrolling bitmask.' },

  // Experimental / insider feature flags
  dev_mode: { group: 'features', kind: 'reg', key: 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModelUnlock', name: 'AllowDevelopmentWithoutDevLicense', type: 'dword', description: 'Developer Mode. Needs administrator.' },
  feature_explorer: { group: 'features', kind: 'reg', key: FEATURES, name: 'ShowFeatureUpdatesUI', type: 'dword', description: 'Show the Windows Insider feature flight control.' },
  telemetry: { group: 'features', kind: 'reg', key: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\DataCollection', name: 'AllowTelemetry', type: 'dword', description: 'Diagnostics and telemetry level, 0 off to 3 full.' },
  ads: { group: 'features', kind: 'reg', key: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager', name: 'SubscribedContent-338388Enabled', type: 'dword', description: 'Suggested apps and tips in Start.' },
  tips: { group: 'features', kind: 'reg', key: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager', name: 'SystemPaneSuggestionsEnabled', type: 'dword', description: 'Windows tips and suggestions.' },
  suggestions: { group: 'features', kind: 'reg', key: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager', name: 'SilentInstalledAppsEnabled', type: 'dword', description: 'Silently installed suggested apps.' },
  web_search: { group: 'features', kind: 'reg', key: DESKTOP, name: 'DisableSearchBoxSuggestions', type: 'dword', description: 'Stop Bing web results appearing in the Start search box.' },
  file_extensions_hidden: { group: 'features', kind: 'reg', key: EXPLORER + '\\FileExts', name: 'HideFileExt', type: 'dword', description: 'Hide known file extensions.' },
  compact_start: { group: 'features', kind: 'reg', key: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced', name: 'Start_TrackDocs', type: 'dword', description: 'Show recently opened items in Start and Explorer.' },
};

/* ------------------------------------------------------------------ */
/* Finding installed applications                                      */
/* ------------------------------------------------------------------ */

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
 * "open D:\\Games\\thing.exe" always does exactly what was asked.
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
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern short VkKeyScan(char c);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004;
  public const uint RIGHTDOWN = 0x0008, RIGHTUP = 0x0010;
  public const uint MIDDLEDOWN = 0x0020, MIDDLEUP = 0x0040;
  public const uint WHEEL = 0x0800, MOVE = 0x0001, ABSOLUTE = 0x8000;
}
`;

/** Reads the mouse pointer position, for confirming where a move landed. */
const GET_CURSOR_PS = `
$p = New-Object Win+POINT
[void][Win]::GetCursorPos([ref]$p)
Write-Output ("CURSOR:" + $p.X + "," + $p.Y)
`;

/**
 * Moves the pointer and optionally clicks.
 *
 * This is what lets Shine drive an app it has no API for - the user asked for
 * VMware specifically, where every step is a click somewhere on screen. There
 * is no mouse control at all without this.
 */
function mouseScript({ x, y, button = 'left', clicks = 1, wheel, settle = 120 }) {
  const btn = String(button || 'left').toLowerCase();
  const down = { left: 'LEFTDOWN', right: 'RIGHTDOWN', middle: 'MIDDLEDOWN' }[btn];
  const up = { left: 'LEFTUP', right: 'RIGHTUP', middle: 'MIDDLEUP' }[btn];
  if (!down) throw new Error(`Unknown mouse button "${button}". Use left, right or middle.`);

  const times = Math.max(1, Math.min(5, Number(clicks) || 1));
  const steps = [];

  if (Number.isFinite(x) && Number.isFinite(y)) {
    steps.push(`[void][Win]::SetCursorPos(${Math.round(x)}, ${Math.round(y)})`);
    steps.push(`Start-Sleep -Milliseconds ${Math.max(60, Number(settle) || 120)}`);
  }

  if (wheel !== undefined && wheel !== null && Number(wheel) !== 0) {
    // One notch is 120, the value Windows sends for a wheel click.
    const notches = Math.max(-10, Math.min(10, Number(wheel) || 0));
    steps.push(`[Win]::mouse_event([Win]::WHEEL, 0, 0, ${notches * 120}, [IntPtr]::Zero)`);
    steps.push('Start-Sleep -Milliseconds 150');
  }

  for (let i = 0; i < times; i += 1) {
    steps.push(`[Win]::mouse_event([Win]::${down}, 0, 0, 0, [IntPtr]::Zero)`);
    steps.push('Start-Sleep -Milliseconds 45');
    steps.push(`[Win]::mouse_event([Win]::${up}, 0, 0, 0, [IntPtr]::Zero)`);
    if (i < times - 1) steps.push('Start-Sleep -Milliseconds 70');
  }

  steps.push('Start-Sleep -Milliseconds 150');
  steps.push(GET_CURSOR_PS.trim());

  return `${USER32_CSHARP}
Add-Type -AssemblyName System.Windows.Forms
[void][Win]::SetProcessDPIAware()
${steps.join('\n')}`;
}

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

  async move_cursor(args) {
    const x = Number(args.x);
    const y = Number(args.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error('move_cursor needs numeric x and y screen coordinates. Use list_windows or take_screenshot to find where to click.');
    }
    const r = await runPowerShell(mouseScript({ x, y }), { sta: true, timeoutMs: 20000 });
    if (!r.ok) throw new Error(`Could not move the cursor: ${r.stderr}`);
    return { x: Math.round(x), y: Math.round(y), position: /CURSOR:(\d+,\d+)/.exec(r.stdout)?.[1] || null };
  },

  async click(args) {
    const r = await runPowerShell(
      mouseScript({
        x: args.x === undefined ? NaN : Number(args.x),
        y: args.y === undefined ? NaN : Number(args.y),
        button: args.button || 'left',
        clicks: args.clicks ?? 1,
        wheel: args.wheel,
        settle: args.settle,
      }),
      { sta: true, timeoutMs: 20000 }
    );
    if (!r.ok) throw new Error(`Could not click: ${r.stderr}`);
    return {
      button: args.button || 'left',
      clicks: args.clicks ?? 1,
      at: Number.isFinite(Number(args.x)) ? { x: Math.round(Number(args.x)), y: Math.round(Number(args.y)) } : 'current position',
      position: /CURSOR:(\d+,\d+)/.exec(r.stdout)?.[1] || null,
    };
  },

  async type_text(args) {
    const text = String(args.text ?? '');
    if (!text) throw new Error('type_text needs text.');
    await requireOk(await runPowerShell(`Start-Sleep -Milliseconds 250; Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(${psQuote(text)}); Start-Sleep -Milliseconds 150`, { sta: true, timeoutMs: 20000 }), 'type_text');
    return { typed: text.length, note: 'Text was sent to the focused window.' };
  },

  /**
   * Types a command out for the user to see, rather than running it quietly.
   *
   * This is what the user asked for: Shine should be able to write a cmd or
   * PowerShell command into their terminal so they can read it, run it
   * themselves, or let Shine go on to press Enter.
   */
  async type_command(args) {
    const command = String(args.command || '').trim();
    if (!command) throw new Error('type_command needs a command.');
    const shell = String(args.shell || 'powershell').toLowerCase();
    if (!['powershell', 'cmd', 'terminal'].includes(shell)) {
      throw new Error(`shell must be "powershell", "cmd" or "terminal", not "${shell}".`);
    }

    // Open a terminal of the requested kind, unless one is already focused.
    const launch =
      shell === 'cmd'
        ? `Start-Process cmd.exe -ArgumentList '/k' -WindowStyle Normal`
        : `Start-Process powershell.exe -ArgumentList '-NoExit','-Command','' -WindowStyle Normal`;

    const script = `
${launch}
Start-Sleep -Milliseconds 1400
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('+')
Start-Sleep -Milliseconds 200
[System.Windows.Forms.SendKeys]::SendWait(${psQuote(command.replace(/([+^%~(){}[\]])/g, '{$1}'))})
Start-Sleep -Milliseconds 200
${args.pressEnter === false ? '' : "[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')"}
Write-Output "TYPED"`;

    const r = await runPowerShell(script, { sta: true, timeoutMs: 40000 });
    if (!r.ok) throw new Error(`Could not type the command: ${r.stderr}`);
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

  /** Runs a .bat, .cmd or .ps1 script the user points at. */
  async run_script_file(args) {
    const file = String(args.path || '').trim();
    if (!file) throw new Error('run_script_file needs a path to a .bat, .cmd or .ps1 file.');
    if (!fs.existsSync(file)) throw new Error(`That script does not exist: ${file}`);
    const ext = path.extname(file).toLowerCase();
    if (!['.bat', '.cmd', '.ps1'].includes(ext)) {
      throw new Error(`run_script_file only runs .bat, .cmd and .ps1 files, not "${ext}".`);
    }
    const command = ext === '.ps1' ? `& ${psQuote(file)}` : `cmd.exe /c ${psQuote(file)}`;
    const r = await runPowerShell(command, { timeoutMs: 120000 });
    return {
      path: file,
      exitCode: r.code,
      ok: r.ok,
      stdout: String(r.stdout || '').slice(0, 4000),
      stderr: String(r.stderr || '').slice(0, 2000),
    };
  },

  /**
   * Edits the text inside a document.
   *
   * read_file plus write_file could do this, but the user asked for it as one
   * action, and doing it in a single read-modify-write avoids the risk of
   * overwriting a file with a version read before something else changed it.
   */
  async edit_document(args) {
    const file = String(args.path || '').trim();
    if (!file) throw new Error('edit_document needs a path to a text document.');
    if (!fs.existsSync(file)) throw new Error(`That document does not exist: ${file}`);

    const mode = String(args.mode || 'replace').toLowerCase();
    const find = args.find === undefined ? '' : String(args.find);
    const replaceWith = args.replace === undefined ? '' : String(args.replace);
    const original = await fsp.readFile(file, 'utf8');

    let updated;
    if (mode === 'append') {
      const joiner = original.endsWith('\n') ? '' : '\n';
      updated = `${original}${joiner}${replaceWith}`;
    } else if (mode === 'prepend') {
      updated = `${replaceWith}\n${original}`;
    } else if (mode === 'find_replace') {
      if (!find) throw new Error('find_replace needs "find" and "replace".');
      if (!original.includes(find)) {
        throw new Error(`That text was not found in ${path.basename(file)}, so nothing was changed.`);
      }
      updated = original.split(find).join(replaceWith);
    } else if (mode === 'overwrite') {
      updated = replaceWith;
    } else {
      throw new Error(`Unknown mode "${mode}". Use replace (default), find_replace, append, prepend or overwrite.`);
    }

    await fsp.writeFile(file, updated, 'utf8');
    return {
      path: file,
      mode,
      changed: updated !== original,
      beforeBytes: Buffer.byteLength(original),
      afterBytes: Buffer.byteLength(updated),
      preview: updated.slice(0, 600),
    };
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

  /**
   * Finds installed applications by name.
   *
   * Start-Process only resolves things on PATH, which covers almost nothing
   * that is actually installed, so most "open spotify" attempts failed. This
   * searches where Windows really keeps programs: the App Paths registry key
   * (which every installer writes), both Start Menu folders, and Program Files.
   */
  async find_applications(args) {
    const query = String(args.name || '').trim();
    if (!query) throw new Error('find_applications needs a name to look for.');
    const limit = clamp(Number(args.limit ?? 15), 1, 50);
    const r = await runPowerShell(appSearchScript(query, limit, false), { timeoutMs: 45000 });
    const found = parseAppMatches(r.stdout);
    return { query, matches: found, searched: 'Start Menu, App Paths registry, Program Files', count: found.length };
  },

  async launch_app(args) {
    const name = String(args.name || '').trim();
    if (!name) throw new Error('launch_app needs an app name.');
    const argPart = args.arguments ? ` -ArgumentList ${psQuote(String(args.arguments))}` : '';

    const script = appSearchScript(name, 5, true, argPart);
    const r = await runPowerShell(script, { timeoutMs: 60000 });
    const launched = /LAUNCHED:(.+)/.exec(r.stdout || '');
    if (launched) {
      return { app: name, launched: true, path: launched[1].trim(), via: 'search' };
    }

    // Last resort: the shell's own resolution, which handles bare names on PATH.
    for (const candidate of [name, `${name}.exe`]) {
      const attempt = await runPowerShell(`Start-Process ${psQuote(candidate)}${argPart} -ErrorAction Stop`);
      if (attempt.ok) return { app: name, launched: true, executable: candidate, via: 'path' };
    }

    const matches = parseAppMatches(r.stdout);
    const hint = matches.length ? ` Closest matches: ${matches.slice(0, 5).join(', ')}.` : '';
    throw new Error(
      `Could not find an application called "${name}" on this PC.${hint} Use find_applications to look, or run_command with a winget install command to install it.`
    );
  },

  /**
   * Windows appearance settings: light or dark mode, transparency and
   * animation effects, night light.
   *
   * Light/dark is a pair of registry values under Personalize, and Windows
   * only repaints when it is told to, so the script also broadcasts the
   * change. Everything else goes through SystemParametersInfo, which is what
   * Settings itself calls - no restart needed.
   */
  /**
   * Changes a named Windows setting.
   *
   * The user asked for this to be a whole settings changer rather than just
   * theme switching, so it covers the groups people actually ask for:
   * appearance, accessibility, and experimental feature flags.
   *
   * Every setting is looked up in a table rather than passed through to the
   * registry raw, so the model can only ever reach settings that are listed
   * here. That matters: "change any Windows setting" written as free-form
   * registry writes would be an unbounded way to break someone's PC.
   */
  async change_windows_setting(args) {
    const setting = String(args.setting || '').trim();
    const value = args.value;
    const enabled = value === undefined ? true : value === true || String(value).toLowerCase() === 'true' || String(value).toLowerCase() === 'on' || value === 1;

    const entry = WINDOWS_SETTINGS[setting];
    if (!entry) {
      const groups = [...new Set(Object.values(WINDOWS_SETTINGS).map((s) => s.group))].join(', ');
      throw new Error(
        `There is no Windows setting called "${setting}" in Shine's list. Available groups: ${groups}. Call list_windows_settings to see every setting Shine knows how to change.`
      );
    }

    if (entry.kind === 'theme') {
      const mode = String(enabled ? 'dark' : 'light').toLowerCase();
      const r = await execute('set_appearance', { theme: mode });
      return { setting, group: entry.group, value: mode, ...r.output };
    }

    if (entry.kind === 'spi') {
      const on = enabled ? 1 : 0;
      const r = await runPowerShell(
        `${USER32_CSHARP}
$sig = @'
[DllImport("user32.dll")] public static extern int SystemParametersInfo(uint a, uint b, uint c, uint d);
'@
$t = Add-Type -MemberDefinition $sig -Name 'SpiS' -Namespace 'ShineS' -PassThru
$t::SystemParametersInfo(${entry.spi}, 0, ${on}, ${entry.spiFlags ?? 3}) | Out-Null
$r2 = Add-Type -MemberDefinition $sig -Name 'SpiR' -Namespace 'ShineR' -PassThru
$r2::SystemParametersInfo(0x031A, 0, 0, 0x0002) | Out-Null
Write-Output "SET"`,
        { timeoutMs: 20000 }
      );
      if (!r.ok) throw new Error(`Could not change ${setting}: ${r.stderr}`);
      return { setting, group: entry.group, value: enabled };
    }

    // Everything else is a DWORD or string under HKCU.
    const type = entry.type === 'string' ? 'String' : 'DWord';
    const stored = type === 'DWord' ? (enabled ? 1 : 0) : String(enabled ? 1 : value);
    const script = `
$ErrorActionPreference = 'Stop'
$key = ${psQuote(entry.key)}
if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
Set-ItemProperty -Path $key -Name ${psQuote(entry.name)} -Value ${psQuote(stored)} -Type ${type} -Force
Write-Output "SET"`;
    const r = await runPowerShell(script, { timeoutMs: 20000 });
    if (!r.ok) throw new Error(`Could not change ${setting}: ${r.stderr}`);
    return { setting, group: entry.group, value: enabled, key: entry.key, name: entry.name };
  },

  /** Reports what every supported Windows setting is currently set to. */
  async list_windows_settings(args) {
    const rows = [];
    for (const [name, entry] of Object.entries(WINDOWS_SETTINGS)) {
      let current = null;
      if (entry.kind === 'reg') {
        const r = await runPowerShell(
          `try { $v = (Get-ItemProperty -Path ${psQuote(entry.key)} -Name ${psQuote(entry.name)} -ErrorAction Stop).${entry.name}; if ($v -eq 1) { 'on' } elseif ($v -eq 0) { 'off' } else { [string]$v } } catch { 'not set' }`,
          { timeoutMs: 12000 }
        );
        current = r.stdout.trim() || 'unknown';
      } else if (entry.kind === 'theme') {
        const r = await runPowerShell(
          `$v = (Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize' -Name AppsUseLightTheme -ErrorAction SilentlyContinue).AppsUseLightTheme
if ($v -eq 1) { 'light' } elseif ($v -eq 0) { 'dark' } else { 'system' }`,
          { timeoutMs: 12000 }
        );
        current = r.stdout.trim() || 'system';
      } else {
        // Animation and transparency effects live in the window manager, not
        // the registry, so there is nothing to read back here. Saying so beats
        // reporting a value that is not real.
        current = 'not readable - Shine sets it but Windows does not report it';
      }
      rows.push({ setting: name, group: entry.group, current, description: entry.description });
    }
    return { count: rows.length, settings: rows };
  },

  async set_appearance(args) {
    const changes = [];
    const parts = [];

    const mode = String(args.theme || '').toLowerCase();
    if (mode) {
      if (!['light', 'dark', 'system'].includes(mode)) {
        throw new Error(`theme must be "light", "dark" or "system", not "${mode}".`);
      }
      // 0 = dark, 1 = light. "system" clears both so Windows follows the
      // accent setting again.
      const light = mode === 'light' ? 1 : mode === 'dark' ? 0 : null;
      parts.push(`
$key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'
if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
${light === null
  ? `Remove-ItemProperty -Path $key -Name AppsUseLightTheme -ErrorAction SilentlyContinue
Remove-ItemProperty -Path $key -Name SystemUsesLightTheme -ErrorAction SilentlyContinue`
  : `Set-ItemProperty -Path $key -Name AppsUseLightTheme -Value ${light} -Type DWord -Force
Set-ItemProperty -Path $key -Name SystemUsesLightTheme -Value ${light} -Type DWord -Force`}
Write-Output "THEME_SET"`.trim());
      changes.push(`theme=${mode}`);
    }

    if (args.transparency !== undefined) {
      const on = args.transparency ? 1 : 0;
      parts.push(`
$sig = @'
[DllImport("user32.dll")] public static extern int SystemParametersInfo(uint a, uint b, uint c, uint d);
'@
$t = Add-Type -MemberDefinition $sig -Name 'Spi' -Namespace 'Shine' -PassThru
$t::SystemParametersInfo(0x0013, 0, ${on}, 0x0000) | Out-Null
Write-Output "TRANSPARENCY_SET"`.trim());
      changes.push(`transparency=${args.transparency ? 'on' : 'off'}`);
    }

    if (args.animations !== undefined) {
      const on = args.animations ? 1 : 0;
      parts.push(`
$sig2 = @'
[DllImport("user32.dll")] public static extern int SystemParametersInfo(uint a, uint b, uint c, uint d);
'@
$t2 = Add-Type -MemberDefinition $sig2 -Name 'Spi2' -Namespace 'Shine2' -PassThru
$t2::SystemParametersInfo(0x0048, 0, ${on}, 0x0003) | Out-Null
Write-Output "ANIMATIONS_SET"`.trim());
      changes.push(`animations=${args.animations ? 'on' : 'off'}`);
    }

    if (!parts.length) {
      throw new Error('set_appearance needs at least one of: theme, transparency, animations.');
    }

    // Nudge every top-level window into repainting so the change is instant.
    const refresh = `
$sigR = @'
[DllImport("user32.dll")] public static extern int SystemParametersInfo(uint a, uint b, uint c, uint d);
'@
$r = Add-Type -MemberDefinition $sigR -Name 'SpiR' -Namespace 'ShineR' -PassThru
$r::SystemParametersInfo(0x031A, 0, 0, 0x0002) | Out-Null`;

    const script = `${parts.join('\n')}\n${refresh}\nWrite-Output "DONE"`;
    const r = await runPowerShell(script, { timeoutMs: 30000 });
    if (!r.ok) throw new Error(`Could not change the appearance settings: ${r.stderr || 'unknown error'}`);
    return { changed: changes, note: 'Sign-out and back in if some windows do not repaint immediately.' };
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
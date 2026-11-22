'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawn, execFile } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const { TOOL_MAP, normaliseArgs } = require('./tools');
const { requireOk } = require('./result');
const { clamp, resolvePath } = require('./util');

/**
 * Everything that depends on which machine this is runs in platform/.
 * runPowerShell and psQuote are still the Windows spellings used below by the
 * tools that have no Linux counterpart yet; runCommand is the shared entry
 * point, because picking a shell is exactly the part that differs per OS.
 */
const platform = require('./platform');
const { runCommand, runPowerShell, psQuote } = platform;

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

/**
 * The user32 declarations. Extracted into platform/win32.js so that both
 * this file and the moved focus_window share one copy - see that module for
 * why it is not simply imported from platform/.
 */
const { USER32_CSHARP } = require('./platform/win32');


/* ------------------------------------------------------------------ */
/* Tool implementations                                               */
/* ------------------------------------------------------------------ */

const impl = {
  ...platform.toolImpls,
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

  /**
   * Streams a URL to disk.
   *
   * Deliberately not run_command with curl: the model should not have to get
   * shell quoting right just to save a file, and an allow-listed http(s) URL
   * is a far smaller blast radius than a free-form shell line. The body is
   * streamed rather than buffered, so an installer does not have to fit in
   * memory, and a failed download is left as .shine-partial instead of a
   * truncated file that looks finished.
   */
  async download_file(args) {
    const url = String(args.url || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      throw new Error(`Refusing to download "${url}" - only http and https URLs are allowed.`);
    }
    const timeoutMs = clamp(Number(args.timeoutMs || 600000), 5000, 1800000);
    const to = resolvePath(args.to);
    await fsp.mkdir(path.dirname(to), { recursive: true });

    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': 'Shine/1.0' },
    });
    if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText} for ${url}`);
    if (!res.body) throw new Error(`Nothing came back from ${url}`);

    const partial = `${to}.shine-partial`;
    try {
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(partial));
      await fsp.rename(partial, to);
    } catch (err) {
      await fsp.unlink(partial).catch(() => {});
      throw err;
    }

    const st = await fsp.stat(to);
    return {
      url,
      to,
      bytes: st.size,
      contentType: res.headers.get('content-type') || null,
      saved: true,
    };
  },

  async run_command(args) {
    const command = String(args.command || '').trim();
    if (!command) throw new Error('run_command needs a command.');
    const timeoutMs = clamp(Number(args.timeoutMs || 30000), 1000, 300000);

    // Which shell reads it, and how cmd and PowerShell are told apart, live in
    // platform/: that decision is the part that differs per machine, and it is
    // the part that silently broke when every command went to PowerShell.
    const res = await runCommand(command, { timeoutMs, shell: args.shell });

    const out = (res.stdout || '').slice(0, 40000);
    const err = (res.stderr || '').slice(0, 12000);
    return {
      command,
      shell: res.shell,
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
    const r = await platform.openPath(target);
    await requireOk(r, 'open_path');
    return { path: target, opened: true };
  },

  async open_url(args) {
    const url = String(args.url || '').trim();
    if (!/^https?:\/\//i.test(url)) throw new Error(`Refusing to open "${url}" - only http and https URLs are allowed.`);
    const r = await platform.openUrl(url);
    await requireOk(r, 'open_url');
    return { url, opened: true };
  },

  // launch_app is defined properly further down. It used to be defined twice,
  // and an object literal keeps the last duplicate, so this copy never ran -
  // it has been removed rather than ported twice.






  /**
   * Types a command out for the user to see, rather than running it quietly.
   *
   * This is what the user asked for: Shine should be able to write a cmd or
   * PowerShell command into their terminal so they can read it, run it
   * themselves, or let Shine go on to press Enter.
   */

  /** Runs a .bat, .cmd or .ps1 script the user points at. */

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
   * that is actually installed, so most "open spotify" attempts failed. Where
   * programs are really kept is per machine: the App Paths registry key and
   * Start Menu folders on Windows, .desktop entries on Linux. The search
   * itself lives in platform/ - the list of places is the whole difference.
   */
  async find_applications(args) {
    const query = String(args.name || '').trim();
    if (!query) throw new Error('find_applications needs a name to look for.');
    const limit = clamp(Number(args.limit ?? 15), 1, 50);
    const found = await platform.findApplications(query, limit);
    return { query, matches: found.matches, searched: found.searched, count: found.matches.length };
  },

  async launch_app(args) {
    const name = String(args.name || '').trim();
    if (!name) throw new Error('launch_app needs an app name.');

    const res = await platform.launchApplication(name, { arguments: args.arguments, limit: 5 });
    if (res.launched) {
      const out = { app: name, launched: true, via: res.via };
      if (res.path) out.path = res.path;
      if (res.executable) out.executable = res.executable;
      return out;
    }

    const matches = res.matches || [];
    const hint = matches.length ? ` Closest matches: ${matches.slice(0, 5).join(', ')}.` : '';
    const install = platform.isWindows
      ? 'run_command with a winget install command to install it'
      : 'run_command with your package manager (apt, dnf, pacman) to install it';
    throw new Error(
      `Could not find an application called "${name}" on this PC.${hint} Use find_applications to look, or ${install}.`
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
};

/* ------------------------------------------------------------------ */
/* Dispatch                                                           */
/* ------------------------------------------------------------------ */

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

module.exports = {
  execute,
  summarise,
  summaryLine,
  runCommand,
  runPowerShell,
  // Re-exported so the shell-routing tests can assert on the real predicates
  // rather than a copy that could drift from the shipped code.
  looksLikeCmd: platform.looksLikeCmd,
  looksLikeParseError: platform.looksLikeParseError,
  impl,
};
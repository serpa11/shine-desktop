'use strict';

/**
 * Tool registry for Shine PC Control.
 *
 * Every tool declares a `risk` level:
 *   'read'   - inspects the PC, never mutates anything.
 *   'write'  - changes files or settings.
 *   'exec'   - runs commands or drives the UI.
 *   'system' - affects the whole machine (power, processes, network).
 *
 * risk only drives *wording* in the approval dialog. Nothing is auto-approved
 * unless the user has explicitly enabled "allow read-only without asking".
 */

const T = (name, description, parameters, risk) => ({ name, description, parameters, risk });

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const num = (description, extra = {}) => ({ type: 'number', description, ...extra });
const bool = (description, extra = {}) => ({ type: 'boolean', description, ...extra });

const TOOLS = [
  T(
    'system_info',
    'Get details about this PC: operating system, CPU, RAM, disk usage, uptime, username and time. Use this before deciding how to do a task.',
    { type: 'object', properties: {}, additionalProperties: false },
    'read'
  ),
  T(
    'list_directory',
    'List the files and folders at a path. Returns name, type, size and modified time.',
    {
      type: 'object',
      properties: {
        path: str('Absolute folder path. Defaults to the user profile folder.'),
      },
      additionalProperties: false,
    },
    'read'
  ),
  T(
    'search_files',
    'Find files by name or extension inside a folder (recursive, depth limited).',
    {
      type: 'object',
      properties: {
        query: str('File name or extension to look for, e.g. "report" or ".pdf".'),
        path: str('Folder to search inside. Defaults to the user profile folder.'),
        maxDepth: num('How deep to recurse. Default 4, maximum 10.'),
        limit: num('Maximum results to return. Default 50.'),
      },
      additionalProperties: false,
    },
    'read'
  ),
  T(
    'read_file',
    'Read the text contents of a file. Truncated for very large files.',
    {
      type: 'object',
      properties: {
        path: str('Absolute path to the file.'),
        maxBytes: num('Maximum bytes to read. Default 200000.'),
      },
      additionalProperties: false,
    },
    'read'
  ),
  T(
    'read_clipboard',
    'Read the text currently on the clipboard.',
    { type: 'object', properties: {}, additionalProperties: false },
    'read'
  ),
  T(
    'list_processes',
    'List running applications and processes.',
    {
      type: 'object',
      properties: {
        filter: str('Only show processes whose name contains this text.'),
      },
      additionalProperties: false,
    },
    'read'
  ),
  T(
    'list_windows',
    'List the windows that are currently open on screen.',
    { type: 'object', properties: {}, additionalProperties: false },
    'read'
  ),
  T(
    'take_screenshot',
    'Take a screenshot of the primary screen so you can see what the user is looking at.',
    { type: 'object', properties: {}, additionalProperties: false },
    'read'
  ),
  T(
    'get_volume',
    'Read the current system output volume level (0-100) and mute state.',
    { type: 'object', properties: {}, additionalProperties: false },
    'read'
  ),

  T(
    'write_file',
    'Create a new text file or overwrite an existing text file with the given content.',
    {
      type: 'object',
      properties: {
        path: str('Absolute path to the file to write.'),
        content: str('The full text content to write.'),
        append: bool('Append to the file instead of overwriting. Default false.'),
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    'write'
  ),
  T(
    'create_directory',
    'Create a folder (including parent folders).',
    {
      type: 'object',
      properties: { path: str('Absolute path of the folder to create.') },
      required: ['path'],
      additionalProperties: false,
    },
    'write'
  ),
  T(
    'delete_path',
    'Delete a file or folder. Folders go to the Recycle Bin when possible so they can be restored.',
    {
      type: 'object',
      properties: {
        path: str('Absolute path to delete.'),
        permanent: bool('Bypass the Recycle Bin. Requires explicit user confirmation.'),
      },
      required: ['path'],
      additionalProperties: false,
    },
    'write'
  ),
  T(
    'move_path',
    'Move or rename a file or folder.',
    {
      type: 'object',
      properties: {
        from: str('Absolute path of the existing file or folder.'),
        to: str('Absolute destination path.'),
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    'write'
  ),
  T(
    'copy_path',
    'Copy a file or folder to a new location.',
    {
      type: 'object',
      properties: {
        from: str('Absolute path of the source file or folder.'),
        to: str('Absolute destination path.'),
      },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    'write'
  ),

  T(
    'run_command',
    'Run a Windows command and return its output. PowerShell is available. Use it for things no other tool covers (git, npm, winget, ffmpeg, curl, ...). Give it one command at a time and quote paths.',
    {
      type: 'object',
      properties: {
        command: str('The exact command to run, e.g. "winget list --name Discord".'),
        timeoutMs: num('How long to wait before giving up. Default 30000, maximum 300000.'),
      },
      required: ['command'],
      additionalProperties: false,
    },
    'exec'
  ),
  T(
    'open_path',
    'Open a file or folder in its default Windows application.',
    {
      type: 'object',
      properties: { path: str('Absolute path to open.') },
      required: ['path'],
      additionalProperties: false,
    },
    'exec'
  ),
  T(
    'open_url',
    'Open a web page in the default browser.',
    {
      type: 'object',
      properties: { url: str('The full URL including https://') },
      required: ['url'],
      additionalProperties: false,
    },
    'exec'
  ),
  T(
    'launch_app',
    'Start an installed application by its executable name or Start Menu name, e.g. "notepad", "calc", "spotify".',
    {
      type: 'object',
      properties: {
        name: str('Executable or app name.'),
        arguments: str('Optional command line arguments.'),
      },
      required: ['name'],
      additionalProperties: false,
    },
    'exec'
  ),
  T(
    'close_app',
    'Close a running application. Asks the app to quit first so it can save.',
    {
      type: 'object',
      properties: { name: str('Process or window title of the app to close.') },
      required: ['name'],
      additionalProperties: false,
    },
    'exec'
  ),
  T(
    'kill_process',
    'Force end a running process by PID. Unsaved work in that process will be lost.',
    {
      type: 'object',
      properties: {
        pid: num('The process ID to end.'),
        force: bool('Force the kill instead of asking politely. Default true.'),
      },
      required: ['pid'],
      additionalProperties: false,
    },
    'exec'
  ),
  T(
    'type_text',
    'Type text into whatever window currently has keyboard focus. Do not use this immediately after opening a window; give it a moment to appear first.',
    {
      type: 'object',
      properties: { text: str('The text to type. Use SendKeys syntax: ^ for Ctrl, % for Alt, + for Shift.') },
      required: ['text'],
      additionalProperties: false,
    },
    'exec'
  ),
  T(
    'press_keys',
    'Send a single key or shortcut to the focused window, e.g. "^s" for Ctrl+S or "{ENTER}".',
    {
      type: 'object',
      properties: { keys: str('SendKeys string, e.g. "^v", "{ESC}", "%{F4}".') },
      required: ['keys'],
      additionalProperties: false,
    },
    'exec'
  ),
  T(
    'focus_window',
    'Bring a window to the foreground by its title.',
    {
      type: 'object',
      properties: { title: str('Part of the window title to match.') },
      required: ['title'],
      additionalProperties: false,
    },
    'exec'
  ),
  T(
    'set_clipboard',
    'Put text on the clipboard.',
    {
      type: 'object',
      properties: { text: str('The text to copy to the clipboard.') },
      required: ['text'],
      additionalProperties: false,
    },
    'exec'
  ),
  T(
    'set_volume',
    'Change the system output volume or toggle mute.',
    {
      type: 'object',
      properties: {
        level: num('Target volume between 0 and 100.'),
        mute: bool('Set mute on or off.'),
      },
      additionalProperties: false,
    },
    'exec'
  ),

  T(
    'system_power',
    'Lock, sleep, restart or shut down this PC. Shutdown and restart always require the user to confirm a second time.',
    {
      type: 'object',
      properties: {
        action: str('One of: lock, sleep, restart, shutdown, signout.', { enum: ['lock', 'sleep', 'restart', 'shutdown', 'signout'] }),
        delaySeconds: num('Warn the user this many seconds before the action happens. Default 15.'),
      },
      required: ['action'],
      additionalProperties: false,
    },
    'system'
  ),
];

const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

function isReadOnly(name) {
  return TOOL_MAP.get(name)?.risk === 'read';
}

function openAiTools() {
  return TOOLS.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

function anthropicTools() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

function geminiTools() {
  return TOOLS.map((t) => ({
    functionDeclarations: [
      { name: t.name, description: t.description, parameters: stripUnsupported(t.parameters) },
    ],
  }));
}

/** Gemini rejects JSON Schema keywords it does not implement. */
function stripUnsupported(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'additionalProperties' || k === '$schema') continue;
    out[k] = Array.isArray(v) ? v.map(stripUnsupported) : stripUnsupported(v);
  }
  return out;
}

function normaliseArgs(name, raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return {};
}

module.exports = {
  TOOLS,
  TOOL_MAP,
  isReadOnly,
  openAiTools,
  anthropicTools,
  geminiTools,
  stripUnsupported,
  normaliseArgs,
};
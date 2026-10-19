'use strict';

/**
 * Safety guard for PC Control.
 *
 * Two layers:
 *   1. BLOCKLIST  - patterns that are refused outright unless the user has
 *                   explicitly turned on "danger mode" in Settings.
 *   2. RISK       - per-action risk classification used to decide whether the
 *                   approval dialog should show extra warnings.
 */

const path = require('node:path');
const fs = require('node:fs');

const BLOCK_PATTERNS = [
  { re: /rm\s+(-[a-z]*\s+)*-[a-z]*[rR][a-z]*[fF]/, why: 'recursive force delete (rm -rf)' },
  { re: /Remove-Item[^\n]*-Recurse[^\n]*-Force/i, why: 'recursive force delete (Remove-Item -Recurse -Force)' },
  { re: /Remove-Item[^\n]*-Recurse[^\n]*(C:\\|D:\\|E:\\)\s*$/im, why: 'recursive delete of a drive root' },
  { re: /rd\s+\/s\/q|rmdir\s+\/s/i, why: 'recursive directory delete' },
  { re: /del\s+\/[sfq]{2,}/i, why: 'forced recursive delete' },
  { re: /format\s+[a-z]:/i, why: 'disk format' },
  { re: /vssadmin\s+delete\s+shadows/i, why: 'shadow copy deletion' },
  { re: /bcdedit\s+\/set\b/i, why: 'boot configuration change' },
  { re: /cipher\s+\/w/i, why: 'free space wiping' },
  { re: /reg\s+delete\b/i, why: 'registry deletion' },
  { re: /Remove-Item\b[^\n]*["']?\$?env:SystemRoot["']?/i, why: 'Windows directory deletion' },
  { re: /del(\s|\/)*[^\n]*\\Windows\\/i, why: 'Windows directory deletion' },
  { re: /takeown\s+\/f\s+[a-z]:\\?\s*$/im, why: 'taking ownership of an entire drive' },
  { re: /icacls\b[^\n]*\/reset/i, why: 'mass permission reset' },
  { re: /Set-MpPreference\b[^\n]*DisableRealtimeMonitoring/i, why: 'disabling Defender realtime protection' },
  { re: /Add-MpPreference\b[^\n]*ExclusionPath/i, why: 'adding a Defender exclusion' },
  { re: /Set-ExecutionPolicy\s+(Bypass|Unrestricted)/i, why: 'weakening execution policy' },
  { re: /New-NetFirewallRule[\s\S]{0,200}?Direction\s+Inbound[\s\S]{0,80}?Action\s+Allow/i, why: 'opening an inbound firewall rule' },
  { re: /net\s+user\s+\S+\s+\S+\s+\/add/i, why: 'creating or modifying a user account' },
  { re: /net\s+localgroup\s+Administrators\s+\S+/i, why: 'adding an account to Administrators' },
  { re: /(shutdown|Stop-Computer|Restart-Computer)\b[\s\S]{0,60}?(-t\s*0|\/t\s*0|-force|\/f\b)/i, why: 'immediate forced shutdown/restart' },
  { re: /cipher\s|optimize\s+-volume|wipefs|mkfs|dd\s+if=/i, why: 'raw disk write' },
  { re: /:\(\)\s*\{\s*:\|:&\s*\}\s*;\s*:/, why: 'fork bomb' },
  { re: /\bcurl\b[\s\S]{0,120}?\|\s*(ba)?sh\b/i, why: 'piping a downloaded script straight into a shell' },
  { re: /Invoke-Expression\b|\biex\b\s+/i, why: 'dynamic code execution (Invoke-Expression)' },
];

const RISKY_WRITE_DIRS = ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData', 'System32'];

const DESTRUCTIVE_VERB =
  /\b(rm|del|erase|remove|remove-item|rmdir|rd|format|diskpart|clear-disk|initialize-disk|uninstall|stop-process|taskkill|takeown|icacls|move-item|mv|rename-item|ren|attrib)\b/i;

function stripQuotes(s) {
  return String(s || '').replace(/^["']|["']$/g, '');
}

function normaliseForScan(input) {
  return String(input || '').replace(/\r/g, '');
}

function isProtectedPath(p) {
  const resolved = path.resolve(stripQuotes(p));
  return RISKY_WRITE_DIRS.some((dir) => {
    const d = path.resolve(dir).toLowerCase();
    return resolved.toLowerCase() === d || resolved.toLowerCase().startsWith(d + path.sep);
  });
}

function isDriveRoot(p) {
  const resolved = path.resolve(stripQuotes(p));
  return /^[a-z]:\\?$/i.test(resolved) || resolved === path.parse(resolved).root;
}

/**
 * @returns {{blocked:boolean, reason?:string, rule?:string, warnings:string[]}}
 */
function inspect({ kind, command, target, paths = [], dangerMode = false }) {
  const warnings = [];
  const text = normaliseForScan(command || '');
  const haystack = [text, ...paths.map(String), target ? String(target) : ''].join('\n');

  if (!dangerMode) {
    for (const rule of BLOCK_PATTERNS) {
      if (rule.re.test(haystack)) {
        return {
          blocked: true,
          reason: `Blocked by the Shine safety guard: ${rule.why}. Open Settings -> PC Control and enable "Allow dangerous operations" if you really need this.`,
          rule: rule.why,
          warnings,
        };
      }
    }
  }

  if (paths.length) {
    for (const p of paths) {
      if (isDriveRoot(p)) {
        return {
          blocked: true,
          reason: `Blocked: "${stripQuotes(p)}" is a drive root. Deleting or replacing an entire drive is not allowed.`,
          rule: 'drive-root',
          warnings,
        };
      }
      if (isProtectedPath(p)) {
        warnings.push(`This touches a protected system location (${path.resolve(stripQuotes(p))}).`);
      }
    }
  }

  if (kind === 'run_command') {
    if (DESTRUCTIVE_VERB.test(text) && !/\b(ls|dir|get|echo|write|read|echo)\b/i.test(text.split(/\s+/)[0] || '')) {
      warnings.push('The command contains a destructive verb (delete/remove/stop/uninstall).');
    }
    if (/(^|\s)(sudo|runas)\b/i.test(text)) {
      warnings.push('The command requests elevated privileges.');
    }
    if (/\s-{1,2}(force|yes|confirm|recursive|permanent)\b/i.test(text)) {
      warnings.push('The command forces an action without asking for confirmation.');
    }
  }

  if (kind === 'system_power' && ['shutdown', 'restart', 'hibernate'].includes(String(target || '').toLowerCase())) {
    warnings.push('This will end every running program on this PC.');
  }

  if (kind === 'kill_process') warnings.push('Force-closing an app discards unsaved work.');
  if (kind === 'delete_path') warnings.push('Files moved to the Recycle Bin can be restored, but deleted files can be lost permanently.');
  if (kind === 'type_text') warnings.push('Keystrokes are injected into whichever window currently has focus.');

  return { blocked: false, warnings };
}

function ensureInsideWorkspace(candidate) {
  const resolved = path.resolve(candidate);
  const home = path.resolve(require('node:os').homedir());
  const ok = resolved === home || resolved.startsWith(home + path.sep);
  if (!ok) {
    const err = new Error(`Refused: ${resolved} is outside your home folder (${home}). Shine only touches files inside your user profile by default.`);
    err.code = 'EOUTSIDEHOME';
    throw err;
  }
  return resolved;
}

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

module.exports = { inspect, ensureInsideWorkspace, isProtectedPath, isDriveRoot, exists, BLOCK_PATTERNS };
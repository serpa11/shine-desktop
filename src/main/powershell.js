'use strict';

const { execFile } = require('node:child_process');

/** Shared PowerShell bridge. */
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

module.exports = { runPowerShell };
'use strict';

/**
 * Helpers that mean the same thing on every machine.
 *
 * clamp and resolvePath used to sit at the bottom of executor.js, where only
 * executor could reach them. The tools are moving into platform/ a batch at a
 * time and delete_path, run_script_file and system_power all need one or both,
 * so they now live in a file that neither side has to import the other to get
 * at - the same reason requireOk is in result.js rather than in executor.js.
 */

const os = require('node:os');
const path = require('node:path');

/**
 * Clamps a number into a range.
 *
 * Anything that does not parse as a number becomes the minimum rather than
 * NaN, so a bad argument cannot silently produce a nonsense volume level.
 */
function clamp(n, min, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}

/**
 * Resolves a path against the home directory.
 *
 * `~/notes` and `~\notes` both expand, and an empty value means the home
 * directory itself, which is what the model usually meant.
 */
function resolvePath(p) {
  const raw = String(p ?? '').trim().replace(/^~(?=$|[\\/])/, os.homedir());
  if (!raw) return os.homedir();
  return path.resolve(raw);
}

module.exports = { clamp, resolvePath };

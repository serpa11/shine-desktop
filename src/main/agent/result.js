'use strict';

/**
 * Turns a failed command into a message that names what was being attempted.
 *
 * It lives in its own file for one reason: the platform implementations need
 * it too, and a platform module cannot import it from executor.js without the
 * two importing each other. Everything else about it - the label-first error,
 * the stderr-then-stdout-then-exit-code fallback - is behaviour callers now
 * depend on, so it is written once.
 *
 * @param {{ok:boolean, stderr?:string, stdout?:string, code?:number}} result
 * @param {string} label what the caller was trying to do
 */
async function requireOk(result, label) {
  if (!result.ok) {
    const detail = result.stderr || result.stdout || `exit code ${result.code}`;
    throw new Error(`${label} failed: ${detail.slice(0, 1200)}`);
  }
  return result;
}

module.exports = { requireOk };

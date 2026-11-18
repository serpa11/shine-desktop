'use strict';

/**
 * Everything that depends on which machine Shine is running on.
 *
 * Callers require this file rather than windows.js or linux.js directly, so
 * the platform decision lives in exactly one place and the rest of the code
 * can be written once. Each implementation exports the same interface;
 * process.platform is the only switch in the tree.
 */

const isWindows = process.platform === 'win32';
const impl = isWindows ? require('./windows') : require('./linux');

module.exports = {
  ...impl,
  // Kept here rather than in either implementation: it is the one question the
  // rest of the code still asks directly, and it gets answered once.
  isWindows,
};

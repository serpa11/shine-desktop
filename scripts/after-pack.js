'use strict';

/**
 * electron-builder `afterPack` hook.
 *
 * Stamps the application icon and version metadata onto the packaged exe
 * before the NSIS installer is built, so the installed app and its shortcuts
 * show the Shine icon instead of the default Electron one.
 *
 * electron-builder skips this itself because the winCodeSign bundle it uses
 * ships macOS symlinks that 7-Zip cannot create on Windows without Developer
 * Mode (hence `signAndEditExecutable: false` in package.json).
 */

const { main } = require('./stamp-icon');

module.exports = async function afterPack(context) {
  await main(context && context.appOutDir ? context.appOutDir : undefined);
};
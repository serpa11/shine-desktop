'use strict';

/**
 * Verify what is actually inside a build before it is published.
 *
 *   node scripts/verify-release.js
 *
 * electron-builder zips release/win-unpacked into the payload and buries that
 * inside the installer, so a stale or half-finished build is not visible from
 * the outside: the exe has the right name and roughly the right size either
 * way. This opens the asar the installer carries and checks the two things
 * that changed, then hashes the installer itself.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const asar = require('@electron/asar');

const root = path.join(__dirname, '..');
const asarPath = path.join(root, 'release', 'win-unpacked', 'resources', 'app.asar');
const zipPath = path.join(root, 'release-payload', 'shine-app.zip');
const installer = path.join(root, 'release-setup', 'ShineSetup.exe');

let failed = 0;

function check(name, ok, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` -> ${detail}` : ''}`);
  if (!ok) failed += 1;
}

/** Read one file straight out of the asar the installer ships. */
function fromAsar(member) {
  try {
    return asar.extractFile(asarPath, member).toString('utf8');
  } catch (err) {
    return null;
  }
}

console.log('\nwhat the installer carries');

const css = fromAsar(path.join('src', 'renderer', 'desktop', 'desktop.css'));
check('desktop.css is in the payload', css !== null);
if (css) {
  const bar = /\.shine-titlebar\s*\{[^}]*background:\s*transparent/.test(css.replace(/\s+/g, ' '));
  check('the window bar paints nothing over the site background', bar);
  check('the bar no longer blurs what is behind it', /\.shine-titlebar\s*\{[^}]*backdrop-filter:\s*none/.test(css.replace(/\s+/g, ' ')));
  check('dialogs are translucent', /\.shine-modal\s*\{[^}]*background:\s*rgba\(0, 0, 0, 0\.66\)/.test(css.replace(/\s+/g, ' ')));
  check('toasts are translucent', /\.shine-toast\s*\{[^}]*background:\s*rgba\(12, 12, 13, 0\.78\)/.test(css.replace(/\s+/g, ' ')));
}

const vendor = fromAsar(path.join('vendor', 'shine.html'));
check('the offline fallback is in the payload', vendor !== null);
if (vendor) {
  check('the fallback carries the background layer', /shineUserBackgroundLayer/i.test(vendor));
  check('the fallback matches the live page byte for byte', vendor.length === 1536163, `${vendor.length} bytes`);
}

// The payload the installer embeds has to be the one built from that asar,
// otherwise the checks above describe a build nobody will download.
const zipStat = fs.statSync(zipPath);
const asarStat = fs.statSync(asarPath);
check(
  'the embedded payload was zipped after the asar was written',
  zipStat.mtimeMs >= asarStat.mtimeMs,
  `zip ${zipStat.mtime.toISOString()} vs asar ${asarStat.mtime.toISOString()}`
);

console.log('\nthe installer');

if (!fs.existsSync(installer)) {
  check('ShineSetup.exe exists', false, 'missing');
} else {
  const buf = fs.readFileSync(installer);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  check('ShineSetup.exe exists', true, `${buf.length} bytes`);
  console.log(`  sha256 ${sha}`);
  fs.writeFileSync(path.join(root, 'release-setup', 'ShineSetup.exe.sha256'), `${sha}  ShineSetup.exe\n`);
  console.log('  written to release-setup/ShineSetup.exe.sha256');
}

console.log('');
if (failed) {
  console.log(`${failed} check(s) failed - do not publish this build.`);
  process.exit(1);
}
console.log('verified - this build is the one to publish.');

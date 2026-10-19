'use strict';

/**
 * Stamps the application icon and version metadata onto the packaged exe.
 *
 * electron-builder normally does this with the winCodeSign bundle, but that
 * archive ships macOS libraries as symlinks which 7-Zip cannot create on
 * Windows without Developer Mode, so the whole extraction fails. Setting
 * `signAndEditExecutable: false` in package.json skips that step; this script
 * does the same job with the standalone rcedit binary, extracting only the
 * Windows parts of the archive.
 *
 * Run with: npm run postbuild   (or node scripts/stamp-icon.js)
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const RCEDIT_VERSION = '2.6.0';
const WIN_CODESIGN = `winCodeSign-${RCEDIT_VERSION}`;
const URL = `https://github.com/electron-userland/electron-builder-binaries/releases/download/${WIN_CODESIGN}/${WIN_CODESIGN}.7z`;

const root = path.join(__dirname, '..');
const iconPath = path.join(root, 'build', 'icon.ico');

const cacheRoot = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'electron-builder',
  'Cache'
);

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function sevenZip() {
  const local = path.join(root, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
  if (!fs.existsSync(local)) throw new Error('7za.exe not found. Run npm install first.');
  return local;
}

async function ensureRcedit() {
  const dir = path.join(cacheRoot, WIN_CODESIGN);
  const binary = path.join(dir, 'rcedit-x64.exe');
  if (fs.existsSync(binary)) return binary;

  fs.mkdirSync(cacheRoot, { recursive: true });
  const archive = path.join(cacheRoot, `${WIN_CODESIGN}.7z`);
  if (!fs.existsSync(archive)) {
    console.log('Fetching rcedit...');
    const res = await fetch(URL);
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  }

  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  // -x!darwin: those entries are symlinks and need elevated privileges.
  console.log('Extracting the Windows tools...');
  execFileSync(sevenZip(), ['x', '-bd', '-y', archive, `-o${dir}`, '-x!darwin'], { stdio: 'inherit' });

  if (!fs.existsSync(binary)) throw new Error('rcedit-x64.exe was not found in the archive.');
  return binary;
}

async function main(appDirOverride) {
  const appDir = appDirOverride || process.env.SHINE_APP_OUT_DIR || path.join(root, 'release', 'win-unpacked');
  const exePath = path.join(appDir, 'Shine.exe');
  if (!fs.existsSync(exePath)) {
    console.log(`Nothing to stamp: ${exePath} does not exist yet.`);
    return;
  }

  const rcedit = await ensureRcedit();
  const version = pkg.version;

  console.log(`Stamping the icon and version info onto ${path.basename(exePath)}...`);
  execFileSync(rcedit, [
    exePath,
    '--set-icon', iconPath,
    '--set-version-string', 'FileDescription', 'Shine AI desktop app',
    '--set-version-string', 'ProductName', 'Shine',
    '--set-version-string', 'CompanyName', 'Shine',
    '--set-file-version', `${version}.0`,
    '--set-product-version', `${version}.0`,
  ], { stdio: 'inherit' });

  console.log('Done.');
}

module.exports = { main, ensureRcedit };

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
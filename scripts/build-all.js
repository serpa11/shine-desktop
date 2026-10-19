'use strict';

/**
 * Full build:
 *   1. package the Shine app with electron-builder (produces release/win-unpacked)
 *   2. zip that folder into release-payload/shine-app.zip
 *   3. package ShineSetup with that zip bundled inside it
 *
 * Run with: npm run release
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const payloadDir = path.join(root, 'release-payload');
const winUnpacked = path.join(root, 'release', 'win-unpacked');
const zipPath = path.join(payloadDir, 'shine-app.zip');
const setupOut = path.join(root, 'release-setup');
const setupConfig = path.join(root, 'scripts', 'setup-builder.json');

const BUILDER_CLI = path.join(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');

function run(args, cwd) {
  // Invoked through node directly so paths containing spaces stay intact.
  console.log(`\n> electron-builder ${args.join(' ')}`);
  const result = spawnSync(process.execPath, [BUILDER_CLI, ...args], { cwd, stdio: 'inherit', shell: false });
  if (result.status !== 0) throw new Error(`electron-builder exited with ${result.status}`);
}

function zipPayload() {
  fs.rmSync(payloadDir, { recursive: true, force: true });
  fs.mkdirSync(payloadDir, { recursive: true });

  console.log('\n> zipping the app payload');
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command',
      `Compress-Archive -Path '${winUnpacked}\\*' -DestinationPath '${zipPath}' -Force -CompressionLevel Optimal`,
    ],
    { stdio: 'inherit', windowsHide: true }
  );

  const mb = fs.statSync(zipPath).size / 1024 / 1024;
  console.log(`  payload is ${mb.toFixed(1)} MB`);
  if (mb < 5) throw new Error('The payload zip looks empty; refusing to build the installer.');
}

function writeSetupConfig() {
  fs.writeFileSync(
    setupConfig,
    JSON.stringify(
      {
        appId: 'com.shine.desktop.setup',
        productName: 'ShineSetup',
        copyright: 'Copyright (c) 2026 Shine',
        asar: true,
        directories: {
          app: path.join(root, 'setup-app'),
          output: setupOut,
          buildResources: path.join(root, 'build'),
        },
        files: ['src/**/*', 'package.json'],
        extraResources: [{ from: zipPath, to: 'payload/shine-app.zip' }],
        // Same reason as the main app: the winCodeSign archive ships macOS
        // symlinks that 7-Zip cannot create without Developer Mode. The icon
        // is stamped by the afterPack hook instead.
        afterPack: path.join(root, 'scripts', 'after-pack.js'),
        win: {
          target: [{ target: 'portable', arch: ['x64'] }],
          icon: path.join(root, 'build', 'icon.ico'),
          signAndEditExecutable: false,
        },
        portable: {
          artifactName: 'ShineSetup.exe',
          unpackDirName: 'ShineSetup',
        },
      },
      null,
      2
    ),
    'utf8'
  );
}

function main() {
  const only = process.argv.includes('--setup-only');

  if (!only) {
    console.log('=== 1/3 packaging the Shine app ===');
    run(['--win', 'dir', '--x64'], root);

    console.log('\n=== 2/3 zipping the app payload ===');
    zipPayload();
  }

  console.log('\n=== 3/3 packaging ShineSetup ===');
  writeSetupConfig();
  fs.rmSync(setupOut, { recursive: true, force: true });
  // The setup app's own executable is named differently to the app's.
  process.env.SHINE_EXE_NAME = 'ShineSetup.exe';
  run(['--config', setupConfig, '--win', 'portable', '--x64'], root);
  delete process.env.SHINE_EXE_NAME;

  const setupExe = path.join(setupOut, 'ShineSetup.exe');
  if (!fs.existsSync(setupExe)) throw new Error(`Expected ${setupExe} to exist.`);

  const mb = fs.statSync(setupExe).size / 1024 / 1024;
  console.log('\nDone.');
  console.log(`  app        : ${path.join(root, 'release', 'win-unpacked', 'Shine.exe')}`);
  console.log(`  installer  : ${setupExe} (${mb.toFixed(1)} MB)`);
}

try {
  main();
} catch (err) {
  console.error(`\nBuild failed: ${err.message}`);
  process.exit(1);
}
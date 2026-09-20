#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const asar = require('@electron/asar');
const { readAsarHeader } = require('app-builder-lib/out/asar/asar');

async function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const asarPath = path.join(projectRoot, 'release', 'win-unpacked', 'resources', 'app.asar');

  if (!fs.existsSync(asarPath)) {
    throw new Error(`Windows app.asar was not found: ${asarPath}`);
  }

  console.log(`electron-builder: ${require('electron-builder/package.json').version}`);
  console.log(`app-builder-lib: ${require('app-builder-lib/package.json').version}`);
  console.log(`asar: ${asarPath}`);

  const stats = fs.statSync(asarPath);
  console.log(`size: ${stats.size}`);

  const header = await readAsarHeader(asarPath);
  console.log(`readAsarHeader: ok (header bytes=${header.size})`);

  const entries = await asar.listPackage(asarPath);
  console.log(`@electron/asar listPackage: ok (entries=${entries.length})`);

  console.log('result: app.asar is readable outside the electron-builder Windows packaging flow');
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});

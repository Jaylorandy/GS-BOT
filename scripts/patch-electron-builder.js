'use strict';

// Patch electron-builder so it works on Node < 20.17 (no require(ESM) support).
//
// app-builder-lib@26 imports the ESM-only `@noble/hashes@2` via require() in
// out/targets/blockmap/blockmap.js. On Node 20.11 that throws ERR_REQUIRE_ESM
// and aborts every `dist` build. We swap that one require() for our vendored
// pure-CJS blake2b (byte-identical output), leaving the rest of the file alone.
//
// Idempotent: safe to run repeatedly. Wired into `postinstall` so it survives
// `npm install`. If app-builder-lib changes its import shape, the patch simply
// no-ops with a warning instead of breaking the build.

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(
  PROJECT_ROOT,
  'node_modules',
  'app-builder-lib',
  'out',
  'targets',
  'blockmap',
  'blockmap.js',
);
// Relative path from blockmap.js back to our vendored module.
const VENDOR_REL = path.relative(path.dirname(TARGET), path.join(PROJECT_ROOT, 'scripts', 'vendor', 'blake2b-cjs.js'));
const VENDOR_REQUIRE = VENDOR_REL.split(path.sep).join('/');

const ORIGINAL_REQUIRE = 'require("@noble/hashes/blake2.js")';
const ORIGINAL_REQUIRE_ALT = "require('@noble/hashes/blake2.js')";
const BLAKE2B_PATCH_MARKER = '/* gsbot-blake2b-cjs-patch */';
const ASAR_INTEGRITY_PATCH_MARKER = '/* gsbot-asar-integrity-appledouble-patch */';

function patchBlockmap() {
  if (!fs.existsSync(TARGET)) {
    console.log(`[patch-electron-builder] blockmap target not found, skipping: ${TARGET}`);
    return;
  }

  let src = fs.readFileSync(TARGET, 'utf8');

  if (src.includes(BLAKE2B_PATCH_MARKER)) {
    console.log('[patch-electron-builder] blockmap already patched.');
    return;
  }

  const replacement = `require(${JSON.stringify(VENDOR_REQUIRE)}) ${BLAKE2B_PATCH_MARKER}`;

  if (src.includes(ORIGINAL_REQUIRE)) {
    src = src.replace(ORIGINAL_REQUIRE, replacement);
  } else if (src.includes(ORIGINAL_REQUIRE_ALT)) {
    src = src.replace(ORIGINAL_REQUIRE_ALT, replacement);
  } else {
    console.warn('[patch-electron-builder] WARNING: expected @noble/hashes require not found. '
      + 'app-builder-lib may have changed — build may fail. Inspect blockmap.js manually.');
    return;
  }

  fs.writeFileSync(TARGET, src, 'utf8');
  console.log(`[patch-electron-builder] patched blockmap.js → ${VENDOR_REQUIRE}`);
}

function patchAsarIntegrity() {
  // macOS writes AppleDouble sidecar files (._*) on non-HFS volumes. When the
  // packaged Resources directory contains ._app.asar / ._default_app.asar,
  // electron-builder's integrity calculator treats them as asar archives and
  // crashes parsing the 4KB AppleDouble header. Filter them out.
  const integrityPath = path.join(
    PROJECT_ROOT,
    'node_modules',
    'app-builder-lib',
    'out',
    'asar',
    'integrity.js',
  );

  if (!fs.existsSync(integrityPath)) {
    console.log(`[patch-electron-builder] integrity target not found, skipping: ${integrityPath}`);
    return;
  }

  let src = fs.readFileSync(integrityPath, 'utf8');

  if (src.includes(ASAR_INTEGRITY_PATCH_MARKER)) {
    console.log('[patch-electron-builder] asar integrity already patched.');
    return;
  }

  const original = 'const resources = await (0, promises_1.readdir)(resourcesPath);';
  const replacement = `const resources = (await (0, promises_1.readdir)(resourcesPath)).filter(filename => !path.basename(filename).startsWith('._')); ${ASAR_INTEGRITY_PATCH_MARKER}`;

  if (!src.includes(original)) {
    console.warn('[patch-electron-builder] WARNING: expected asar integrity readdir line not found. '
      + 'app-builder-lib may have changed — macOS AppleDouble sidecars may break the build.');
    return;
  }

  src = src.replace(original, replacement);
  fs.writeFileSync(integrityPath, src, 'utf8');
  console.log('[patch-electron-builder] patched asar integrity to ignore AppleDouble sidecars');
}

function main() {
  patchBlockmap();
  patchAsarIntegrity();
}

main();

const fs = require('fs');
const path = require('path');

function removeAppleDoubleFiles(targetPath) {
  if (!targetPath || !fs.existsSync(targetPath)) {
    return 0;
  }

  const stats = fs.statSync(targetPath);
  if (stats.isFile()) {
    if (/^\._/.test(path.basename(targetPath))) {
      fs.rmSync(targetPath, { force: true });
      return 1;
    }
    return 0;
  }

  let removed = 0;
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    removed += removeAppleDoubleFiles(path.join(targetPath, entry.name));
  }
  return removed;
}

exports.default = async function cleanWindowsAfterPack(context) {
  if (context?.electronPlatformName !== 'win32') {
    return;
  }

  const removed = removeAppleDoubleFiles(context.appOutDir);
  if (removed > 0) {
    console.log(`[afterPack] Removed ${removed} AppleDouble files from ${context.appOutDir}`);
  }

  // Remove stale app.asar.bak backups that electron-builder may leave behind.
  const asarBakPath = path.join(context.appOutDir, 'resources', 'app.asar.bak');
  if (fs.existsSync(asarBakPath)) {
    fs.rmSync(asarBakPath, { force: true });
    console.log('[afterPack] Removed stale app.asar.bak');
  }

  // Remove the stray 'acked' duplicate payload (~300MB). It was created by the
  // 2026-09-04 manual asar repack accident (truncated path) and is a full copy
  // of the app payload with zero code references. It must never ship.
  const ackedPath = path.join(context.appOutDir, 'resources', 'app.asar.unpacked', 'acked');
  if (fs.existsSync(ackedPath)) {
    fs.rmSync(ackedPath, { recursive: true, force: true, maxRetries: 3 });
    console.log('[afterPack] Removed stray app.asar.unpacked/acked duplicate payload');
  }

  // Windows package ships ONLY the win32-x64 onnxruntime binary (build.files
  // excludes darwin/linux/win32-arm64, saving ~148MB). Fail loudly if the
  // exclusion ever cuts too much and the required binary disappears.
  // Slim cross-platform onnxruntime binaries: Windows package only needs
  // win32/x64. Do it here (afterPack) rather than via files globs — negative
  // glob patterns in build.files/win.files break the whitelist semantics and
  // cause electron-builder to pack the entire project directory (~2.3GB asar).
  const ortBin = path.join(
    context.appOutDir, 'resources', 'app.asar.unpacked', 'node_modules',
    'onnxruntime-node', 'bin', 'napi-v3',
  );
  if (fs.existsSync(ortBin)) {
    const stalePlatforms = ['darwin', 'linux'];
    for (const plat of stalePlatforms) {
      const p2 = path.join(ortBin, plat);
      if (fs.existsSync(p2)) {
        fs.rmSync(p2, { recursive: true, force: true, maxRetries: 3 });
        console.log(`[afterPack] Slimmed onnxruntime platform ${plat}/`);
      }
    }
    const arm64 = path.join(ortBin, 'win32', 'arm64');
    if (fs.existsSync(arm64)) {
      fs.rmSync(arm64, { recursive: true, force: true, maxRetries: 3 });
      console.log('[afterPack] Slimmed onnxruntime platform win32/arm64/');
    }
  }

  const ortX64 = path.join(
    context.appOutDir, 'resources', 'app.asar.unpacked', 'node_modules',
    'onnxruntime-node', 'bin', 'napi-v3', 'win32', 'x64',
  );
  if (!fs.existsSync(ortX64)) {
    throw new Error(
      '[afterPack] onnxruntime win32-x64 binary missing after platform slimming. '
      + 'Check build.win.files exclusions in package.json.',
    );
  }
  console.log('[afterPack] ✓ onnxruntime win32-x64 binary present (platforms slimmed).');

  // Verify the win32-x64 sharp binary actually shipped. Without it the app
  // crashes on launch with "Could not load the sharp module". Fail the build
  // loudly here rather than discovering it after install.
  const out = context.appOutDir;
  let found = false;
  const stack = [out];
  while (stack.length && !found) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { entries = []; }
    for (const entry of entries) {
      const fp = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Only descend into resources / node_modules / @img to keep it fast.
        if (/resources|node_modules|@img|sharp/i.test(entry.name) || dir.length > out.length) {
          stack.push(fp);
        }
      } else if (/sharp-win32-x64/i.test(fp) && /\.(?:node|dll)$/i.test(entry.name)) {
        found = true;
        break;
      }
    }
  }
  if (found) {
    console.log('[afterPack] ✓ Verified sharp-win32-x64 native binary is bundled.');
  } else {
    throw new Error(
      '[afterPack] sharp-win32-x64 native binary NOT found in the packaged Windows app. '
      + 'The app would crash on launch. Run `node scripts/ensure-sharp-win.js` and rebuild.',
    );
  }
};

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Ensure electron-builder is patched for Node < 20.17 (require(ESM) gap) before
// any app-builder-lib module is loaded by the dist step.
require('./patch-electron-builder.js');

const projectRoot = path.resolve(__dirname, '..');
const releaseDir = path.join(projectRoot, 'release');
const stageDir = path.join('/tmp', 'gsbot-mac-distribution');
const guideSourcePath = path.join(projectRoot, 'docs', 'mac-install-guide.txt');
const packageJson = require(path.join(projectRoot, 'package.json'));
const appName = 'GS Bot.app';
const version = packageJson.version || '1.0.0';
const dmgName = `GS Bot-${version}-arm64.dmg`;
const releaseGuideName = 'GS Bot Mac Install Guide.txt';
const launcherName = 'Start GS Bot.command';
const dmgPath = path.join(releaseDir, dmgName);
const dmgBlockmapPath = `${dmgPath}.blockmap`;
const releaseGuidePath = path.join(releaseDir, releaseGuideName);
const releaseLauncherPath = path.join(releaseDir, launcherName);
const tempDmgPath = path.join('/tmp', dmgName);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      COPYFILE_DISABLE: '1',
      ...(options.env || {}),
    },
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function runShell(command) {
  run('/bin/zsh', ['-lc', command]);
}

function quote(value) {
  return JSON.stringify(value);
}

function ensureExists(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} was not found: ${filePath}`);
  }
}

function getLauncherScript() {
  return `#!/bin/zsh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$HOME/Library/Logs/GS Bot"
mkdir -p "$LOG_DIR"

if [ -d "$SCRIPT_DIR/GS Bot.app" ]; then
  APP_PATH="$SCRIPT_DIR/GS Bot.app"
elif [ -d "$SCRIPT_DIR/mac-arm64/GS Bot.app" ]; then
  APP_PATH="$SCRIPT_DIR/mac-arm64/GS Bot.app"
else
  osascript -e 'display alert "GS Bot was not found" message "Keep this launcher next to GS Bot.app or inside the release folder." as critical'
  exit 1
fi

exec >> "$LOG_DIR/local-launch.log" 2>&1
echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Starting GS Bot from launcher"
"$APP_PATH/Contents/MacOS/GS Bot"
`;
}

function writeLauncher(targetPath) {
  fs.writeFileSync(targetPath, getLauncherScript(), 'utf8');
  fs.chmodSync(targetPath, 0o755);
}

function cleanMacOutput() {
  const targets = [
    path.join(releaseDir, 'mac-arm64'),
    path.join(releaseDir, 'builder-debug.yml'),
    dmgPath,
    dmgBlockmapPath,
    releaseGuidePath,
    releaseLauncherPath,
  ];

  for (const targetPath of targets) {
    fs.rmSync(targetPath, { recursive: true, force: true });
  }
}

function prepareStage(appPath) {
  runShell(`
    set -e
    rm -rf ${quote(stageDir)}
    mkdir -p ${quote(stageDir)}
    ditto --norsrc ${quote(appPath)} ${quote(path.join(stageDir, appName))}
    cp ${quote(guideSourcePath)} ${quote(path.join(stageDir, releaseGuideName))}
    cp ${quote(guideSourcePath)} ${quote(releaseGuidePath)}
    find ${quote(stageDir)} -name '._*' -delete
    xattr -dr com.apple.provenance ${quote(stageDir)} 2>/dev/null || true
    xattr -cr ${quote(stageDir)} 2>/dev/null || true
  `);
  signPackagedMacApp(path.join(stageDir, appName));
  writeLauncher(path.join(stageDir, launcherName));
  writeLauncher(releaseLauncherPath);
}

function buildMacApp() {
  run('node', ['scripts/build-frontend.js']);
  const localElectronDist = path.join(projectRoot, 'node_modules', 'electron', 'dist');
  const builderArgs = ['--mac', '--dir', '-c.mac.identity=null'];
  if (fs.existsSync(path.join(localElectronDist, 'Electron.app'))) {
    builderArgs.push(`-c.electronDist=${localElectronDist}`);
  }
  run(path.join(projectRoot, 'node_modules', '.bin', 'electron-builder'), builderArgs, {
    env: { GSBOT_SKIP_WIN_ASAR_INTEGRITY: '1' },
  });
}

function cleanPackagedMacApp(appPath) {
  runShell(`
    set -e
    find ${quote(appPath)} -name '._*' -delete
    dot_clean -m ${quote(appPath)} 2>/dev/null || true
    xattr -cr ${quote(appPath)} 2>/dev/null || true
  `);
}

// macOS writes ._* AppleDouble sidecar files on non-HFS volumes (e.g. the
// external drive this repo lives on). electron-builder copies them into the
// app and then chokes on a chmod of one that vanished mid-copy. Strip them
// from every source tree electron-builder reads BEFORE packaging.
function stripAppleDoubleFromSources() {
  const roots = [
    path.join(projectRoot, 'vendor'),
    path.join(projectRoot, 'dist'),
    path.join(projectRoot, 'models'),
    path.join(projectRoot, 'src', 'shared'),
    path.join(projectRoot, 'node_modules', '@img'),
    path.join(projectRoot, 'node_modules', 'onnxruntime-node'),
    path.join(projectRoot, 'node_modules', 'sharp'),
    path.join(projectRoot, 'node_modules', '@gutenye'),
  ].filter((p) => fs.existsSync(p));
  for (const root of roots) {
    runShell(`
      find ${quote(root)} -name '._*' -delete 2>/dev/null || true
      dot_clean -m ${quote(root)} 2>/dev/null || true
    `);
  }
}

function signPackagedMacApp(appPath) {
  run('codesign', ['--force', '--deep', '--sign', '-', appPath]);
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=4', appPath]);
}

function copyLiteOnnxModel(appPath) {
  const sourceDir = path.join(projectRoot, 'vendor', 'common', 'rmbg-2.0-lite');
  const targetDir = path.join(appPath, 'Contents', 'Resources', 'runtime', 'mac', 'rmbg-2.0-lite');
  ensureExists(path.join(sourceDir, 'model.onnx'), 'lite RMBG ONNX model');
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.cpSync(sourceDir, targetDir, { recursive: true });
}

function copyLabelDetectorModel(appPath) {
  // Primary source is the newest training output at models/label-detector/.
  // Fall back to vendor/windows/label-detector/ for backwards compatibility
  // with older repo layouts that haven't migrated yet.
  const primarySourceDir = path.join(projectRoot, 'models', 'label-detector');
  const fallbackSourceDir = path.join(projectRoot, 'vendor', 'windows', 'label-detector');
  const sourceDir = fs.existsSync(path.join(primarySourceDir, 'best.onnx'))
    ? primarySourceDir
    : fallbackSourceDir;
  const targetDir = path.join(appPath, 'Contents', 'Resources', 'runtime', 'mac', 'label-detector');
  const sourceModel = path.join(sourceDir, 'best.onnx');
  ensureExists(sourceModel, 'label detector ONNX model');
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });

  // Copy only the files we want — skip AppleDouble shadows, .bak.*,
  // .v2-backup, training outputs, etc. that may sit alongside best.onnx.
  const whitelist = ['best.onnx', 'best.pt', 'runtime-manifest.json'];
  for (const name of whitelist) {
    const src = path.join(sourceDir, name);
    if (fs.existsSync(src) && fs.statSync(src).isFile()) {
      fs.copyFileSync(src, path.join(targetDir, name));
    }
  }

  // Verify the copy actually landed.
  const targetModel = path.join(targetDir, 'best.onnx');
  if (!fs.existsSync(targetModel)) {
    throw new Error(`label detector ONNX model failed to copy into ${targetModel}`);
  }
  const srcSize = fs.statSync(sourceModel).size;
  const dstSize = fs.statSync(targetModel).size;
  if (dstSize !== srcSize) {
    throw new Error(`label detector ONNX model size mismatch (src=${srcSize} dst=${dstSize})`);
  }
  console.log(`✓ Bundled label detector ONNX (${(dstSize / 1024 / 1024).toFixed(2)} MB) at ${targetModel}`);
}

function buildDmg() {
  const tempDmgBasePath = tempDmgPath.replace(/\.dmg$/i, '');
  runShell(`
    set -e
    rm -f ${quote(dmgPath)} ${quote(dmgBlockmapPath)} ${quote(tempDmgPath)} ${quote(`${tempDmgBasePath}.dmg`)}
    sleep 2
    hdiutil create -volname "GS Bot" -srcfolder ${quote(stageDir)} -ov -format UDZO -fs HFS+ ${quote(tempDmgPath)} \\
      || hdiutil makehybrid -o ${quote(tempDmgBasePath)} ${quote(stageDir)} -hfs
    cp ${quote(tempDmgPath)} ${quote(dmgPath)}
  `);
}

function buildDmgBlockmap() {
  // The .blockmap is only used for auto-update deltas; the DMG itself is the
  // shippable artifact. electron-builder/app-builder-lib has moved the blockmap
  // helper across versions, so resolve it dynamically and SKIP (don't crash)
  // if it isn't available — a missing blockmap must never fail the build.
  const candidates = [
    './node_modules/app-builder-lib/out/util/appBuilder.js',
    './node_modules/app-builder-lib/out/util/appBuilder',
    './node_modules/electron-builder/out/util/appBuilder.js',
  ];
  let modPath = '';
  for (const c of candidates) {
    if (fs.existsSync(path.join(projectRoot, c.replace(/^\.\//, '')))) {
      modPath = c;
      break;
    }
  }
  if (!modPath) {
    console.warn('[blockmap] appBuilder helper not found in this electron-builder version — skipping .blockmap (DMG is unaffected).');
    return;
  }
  const result = spawnSync('node', [
    '-e',
    `(async () => {
  try {
    const m = require(${JSON.stringify(modPath)});
    const fn = m.executeAppBuilderAsJson;
    if (typeof fn !== 'function') { console.warn('[blockmap] executeAppBuilderAsJson missing — skipping.'); return; }
    await fn(['blockmap', '--input', ${JSON.stringify(dmgPath)}, '--output', ${JSON.stringify(dmgBlockmapPath)}]);
    console.log('dmg-blockmap-ok');
  } catch (error) {
    console.warn('[blockmap] generation skipped:', error && error.message ? error.message : error);
  }
})();`,
  ], { cwd: projectRoot, stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1' } });
  // Intentionally ignore result.status — blockmap is best-effort.
  if (result.status !== 0) {
    console.warn('[blockmap] generation step exited non-zero — ignored (DMG is fine).');
  }
}

function main() {
  ensureExists(guideSourcePath, 'mac install guide');
  cleanMacOutput();
  stripAppleDoubleFromSources();
  buildMacApp();

  const appPath = path.join(releaseDir, 'mac-arm64', appName);
  ensureExists(appPath, 'packaged mac app');
  cleanPackagedMacApp(appPath);
  copyLiteOnnxModel(appPath);
  copyLabelDetectorModel(appPath);
  cleanPackagedMacApp(appPath);

  prepareStage(appPath);
  buildDmg();
  buildDmgBlockmap();

  console.log(`Built macOS distribution: ${dmgPath}`);
}

main();

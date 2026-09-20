const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

// Ensure electron-builder is patched for Node < 20.17 (require(ESM) gap) before
// any app-builder-lib module is loaded by the dist step.
require('./patch-electron-builder.js');

const projectRoot = path.resolve(__dirname, '..');
// 默认输出到 release/。当该目录里的 app.asar 被其它进程（如编辑器/索引器）
// 持有句柄时，删除会 EBUSY 导致打包中断 —— 可用 GSBOT_RELEASE_DIR 换一个
// 干净目录输出，例如 GSBOT_RELEASE_DIR=release-build。
const releaseDirName = String(process.env.GSBOT_RELEASE_DIR || 'release').trim() || 'release';
const releaseDir = path.join(projectRoot, releaseDirName);
const guideSourcePath = path.join(projectRoot, 'docs', 'windows-install-guide.txt');
const packageJson = require(path.join(projectRoot, 'package.json'));
const version = packageJson.version || '1.0.0';
const windowsTorchFlavor = String(process.env.GSBOT_WINDOWS_PYTORCH_FLAVOR || 'cpu').trim().toLowerCase() === 'gpu'
  ? 'gpu'
  : 'cpu';
const windowsCutoutVariant = String(process.env.GSBOT_WINDOWS_CUTOUT_VARIANT || 'hybrid').trim().toLowerCase() === 'light'
  ? 'light'
  : 'hybrid';
const windowsBuildMode = String(process.env.GSBOT_WINDOWS_BUILD_MODE || 'full').trim().toLowerCase() === 'zip-only'
  ? 'zip-only'
  : 'full';
const releaseLabel = windowsCutoutVariant === 'light'
  ? 'light'
  : (windowsTorchFlavor === 'gpu' ? 'hybrid-gpu' : 'hybrid-cpu');
const releaseGuideName = 'GS Bot Windows Install Guide.txt';
const launcherName = 'Start GS Bot.bat';
const releaseGuidePath = path.join(releaseDir, releaseGuideName);
const releaseLauncherPath = path.join(releaseDir, launcherName);

function removeAppleDoubleFilesInPaths(paths) {
  for (const targetPath of paths) {
    removeAppleDoubleFiles(targetPath);
  }
}

function removeAppleDoubleFilesInTree(targetPath) {
  removeAppleDoubleFiles(targetPath);
}

function removeAppleDoubleFiles(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return;
  }

  const stats = fs.statSync(targetPath);
  if (stats.isFile()) {
    if (/^\._/.test(path.basename(targetPath))) {
      fs.rmSync(targetPath, { force: true });
    }
    return;
  }

  const entries = fs.readdirSync(targetPath, { withFileTypes: true });
  for (const entry of entries) {
    removeAppleDoubleFiles(path.join(targetPath, entry.name));
  }
}

function cleanWindowsOutput() {
  const targets = [
    path.join(releaseDir, 'win-unpacked'),
    path.join(releaseDir, 'win-unpacked.tmp'),
    path.join(releaseDir, 'builder-debug.yml'),
    path.join(releaseDir, 'latest.yml'),
    path.join(releaseDir, `GS Bot Setup ${version}.exe`),
    path.join(releaseDir, `GS Bot Setup ${version}.exe.blockmap`),
    path.join(releaseDir, `GS Bot Setup ${version} ${releaseLabel}.exe`),
    path.join(releaseDir, `GS Bot Setup ${version} ${releaseLabel}.exe.blockmap`),
    path.join(releaseDir, `GS Bot-${version}-x64.zip`),
    path.join(releaseDir, `GS Bot-${version}-win.zip`),
    path.join(releaseDir, `GS Bot-${version}-${releaseLabel}.zip`),
    releaseGuidePath,
    releaseLauncherPath,
  ];

  for (const targetPath of targets) {
    fs.rmSync(targetPath, { recursive: true, force: true });
  }
}

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

function runRequired(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: options.stdio || 'inherit',
    encoding: options.encoding,
    maxBuffer: options.maxBuffer || 64 * 1024 * 1024,
    env: {
      ...process.env,
      COPYFILE_DISABLE: '1',
      ...(options.env || {}),
    },
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with status ${result.status || 1}`);
  }

  return result;
}

function patchFile(filePath, before, after) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const current = fs.readFileSync(filePath, 'utf8');
  if (current.includes(after) || !current.includes(before)) {
    return;
  }

  fs.writeFileSync(filePath, current.replace(before, after), 'utf8');
}

function patchElectronBuilderForMacZipFallback() {
  patchFile(
    path.join(projectRoot, 'node_modules', 'app-builder-lib', 'out', 'targets', 'archive.js'),
    `    let use7z = true;
    if (process.platform === "darwin" && format === "zip" && dirToArchive.normalize("NFC") !== dirToArchive) {
        builder_util_1.log.warn({ reason: "7z doesn't support NFD-normalized filenames" }, \`using zip\`);
        use7z = false;
    }`,
    `    let use7z = true;
    if (process.platform === "darwin" && format === "zip") {
        if (dirToArchive.normalize("NFC") !== dirToArchive) {
            builder_util_1.log.warn({ reason: "7z doesn't support NFD-normalized filenames" }, \`using zip\`);
        }
        use7z = false;
    }`,
  );

  patchFile(
    path.join(projectRoot, 'node_modules', 'app-builder-lib', 'out', 'targets', 'nsis', 'NsisTarget.js'),
    `                const path7za = await (0, builder_util_1.getPath7za)();
                const archiveInfo = (await (0, builder_util_1.exec)(path7za, ["l", file])).trim();`,
    `                const archiveInfo = (process.platform === "darwin" && file.endsWith(".zip"))
                    ? (await (0, builder_util_1.exec)("zipinfo", ["-t", file])).trim()
                    : (await (0, builder_util_1.exec)(await (0, builder_util_1.getPath7za)(), ["l", file])).trim();`,
  );

  patchFile(
    path.join(projectRoot, 'node_modules', 'app-builder-lib', 'out', 'platformPackager.js'),
    `            if (!(asarOptions == null || (options === null || options === void 0 ? void 0 : options.disableAsarIntegrity))) {
                asarIntegrity = await (0, integrity_1.computeData)({ resourcesPath, resourcesRelativePath, resourcesDestinationPath: this.getResourcesDir(appOutDir), extraResourceMatchers });
            }`,
    `            if (!(asarOptions == null || (options === null || options === void 0 ? void 0 : options.disableAsarIntegrity) || process.env.GSBOT_SKIP_WIN_ASAR_INTEGRITY === "1")) {
                asarIntegrity = await (0, integrity_1.computeData)({ resourcesPath, resourcesRelativePath, resourcesDestinationPath: this.getResourcesDir(appOutDir), extraResourceMatchers });
            }`,
  );
}

function ensureExists(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`${label} was not found: ${filePath}`);
  }
}

function getLauncherScript() {
  return `@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "APP_PATH=%SCRIPT_DIR%GS Bot.exe"
if exist "%APP_PATH%" goto launch

set "APP_PATH=%SCRIPT_DIR%win-unpacked\\GS Bot.exe"
if exist "%APP_PATH%" goto launch

echo GS Bot was not found.
echo Keep this launcher next to GS Bot.exe or inside the release folder.
pause
exit /b 1

:launch
set "LOG_DIR=%LOCALAPPDATA%\\GS Bot\\logs"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>&1
echo [%DATE% %TIME%] Starting GS Bot from launcher>> "%LOG_DIR%\\local-launch.log"
start "" "%APP_PATH%"
exit /b 0
`;
}

function writeLauncher(targetPath) {
  fs.writeFileSync(targetPath, getLauncherScript(), 'utf8');
}

function prepareReleaseCompanionFiles() {
  ensureExists(guideSourcePath, 'windows install guide');
  ensureExists(path.join(releaseDir, 'win-unpacked', 'GS Bot.exe'), 'unpacked Windows app');
  fs.copyFileSync(guideSourcePath, releaseGuidePath);
  writeLauncher(releaseLauncherPath);
}

function findNsisDir() {
  const nsisRoot = path.join(os.homedir(), 'Library', 'Caches', 'electron-builder', 'nsis');
  if (!fs.existsSync(nsisRoot)) {
    return '';
  }

  const candidates = fs.readdirSync(nsisRoot)
    .map((name) => path.join(nsisRoot, name))
    .filter((dirPath) => fs.existsSync(path.join(dirPath, 'mac', 'makensis')))
    .sort();

  return candidates[0] || '';
}

function prepareMakensis(nsisDir) {
  if (!nsisDir || process.platform !== 'darwin') {
    return;
  }

  const makensisPath = path.join(nsisDir, 'mac', 'makensis');
  if (!fs.existsSync(makensisPath)) {
    return;
  }

  spawnSync('codesign', ['-f', '-s', '-', makensisPath], {
    cwd: projectRoot,
    stdio: 'ignore',
  });
}

ensureExists(guideSourcePath, 'windows install guide');
patchElectronBuilderForMacZipFallback();
removeAppleDoubleFilesInPaths([
  path.join(projectRoot, 'dist'),
  path.join(projectRoot, 'release'),
  path.join(projectRoot, 'vendor', 'windows'),
  path.join(projectRoot, 'docs'),
  path.join(projectRoot, 'label training'),
]);

const nsisDir = findNsisDir();
prepareMakensis(nsisDir);

cleanWindowsOutput();
run('node', ['scripts/prepare-windows-runtime.js']);
// Cross-compiling on macOS only installs host (darwin) sharp binaries; fetch
// the win32-x64 sharp prebuilds so the packaged app doesn't crash on launch.
run('node', ['scripts/ensure-sharp-win.js']);
run('node', ['scripts/build-frontend.js']);
run(
  'node',
  [
    path.join(projectRoot, 'node_modules', 'electron-builder', 'cli.js'),
    ...(windowsBuildMode === 'zip-only'
      ? ['--win', 'zip', '--x64']
      : ['--win', 'nsis', 'zip', '--x64']),
    // 输出目录跟随 releaseDir 配置，保证与 cleanWindowsOutput 清理的是同一处
    ...(releaseDirName !== 'release' ? [`-c.directories.output=${releaseDirName}`] : []),
  ],
  {
    env: {
      ...(nsisDir ? { NSISDIR: nsisDir } : {}),
      GSBOT_SKIP_WIN_ASAR_INTEGRITY: '1',
    },
  },
);
removeAppleDoubleFilesInTree(path.join(releaseDir, 'win-unpacked'));
prepareReleaseCompanionFiles();
removeAppleDoubleFilesInPaths([
  path.join(releaseDir, 'win-unpacked'),
  path.join(releaseDir, `GS Bot-${version}-win.zip`),
  path.join(releaseDir, `GS Bot-${version}-${releaseLabel}.zip`),
  releaseGuidePath,
  releaseLauncherPath,
]);

function renameIfExists(sourceName, targetName) {
  const sourcePath = path.join(releaseDir, sourceName);
  const targetPath = path.join(releaseDir, targetName);
  if (!fs.existsSync(sourcePath)) {
    return;
  }

  fs.rmSync(targetPath, { force: true });
  fs.renameSync(sourcePath, targetPath);
}

function removeAppleDoubleEntriesFromZip(zipPath) {
  if (!fs.existsSync(zipPath)) {
    return;
  }

  if (process.platform === 'win32') {
    console.log('[release] Skipping AppleDouble zip cleanup on Windows (afterPack already handled it).');
    return;
  }

  const listing = runRequired('zipinfo', ['-1', zipPath], {
    stdio: ['ignore', 'pipe', 'inherit'],
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  }).stdout || '';
  const entries = listing
    .split(/\r?\n/)
    .filter((entry) => entry && /^\._|\/\._/.test(entry));

  if (entries.length === 0) {
    return;
  }

  const chunkSize = 100;
  for (let index = 0; index < entries.length; index += chunkSize) {
    runRequired('zip', ['-d', zipPath, ...entries.slice(index, index + chunkSize)]);
  }
  console.log(`[release] Removed ${entries.length} AppleDouble entries from ${zipPath}`);
}

renameIfExists(`GS Bot Setup ${version}.exe`, `GS Bot Setup ${version} ${releaseLabel}.exe`);
renameIfExists(`GS Bot Setup ${version}.exe.blockmap`, `GS Bot Setup ${version} ${releaseLabel}.exe.blockmap`);
renameIfExists(`GS Bot-${version}-win.zip`, `GS Bot-${version}-${releaseLabel}.zip`);
removeAppleDoubleEntriesFromZip(path.join(releaseDir, `GS Bot-${version}-${releaseLabel}.zip`));

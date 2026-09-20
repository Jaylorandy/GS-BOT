const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

// Ensure electron-builder is patched for Node < 20.17 (require(ESM) gap) before
// any app-builder-lib module is loaded.
require('./patch-electron-builder.js');

const projectRoot = path.resolve(__dirname, '..');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_BUILDER_CACHE: process.env.ELECTRON_BUILDER_CACHE || '/tmp/gsbot-license-generator-cache',
      ...(options.env || {}),
    },
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
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

patchElectronBuilderForMacZipFallback();

const nsisDir = findNsisDir();
prepareMakensis(nsisDir);

run(
  path.join(projectRoot, 'node_modules', '.bin', 'electron-builder'),
  [
    '--win',
    'nsis',
    '--x64',
    '--config',
    path.join('scripts', 'license-generator-builder-config.js'),
    '--publish',
    'never',
  ],
  nsisDir ? { env: { NSISDIR: nsisDir } } : {},
);

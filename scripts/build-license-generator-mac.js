const path = require('path');
const { spawnSync } = require('child_process');

// Ensure electron-builder is patched for Node < 20.17 (require(ESM) gap) before
// any app-builder-lib module is loaded.
require('./patch-electron-builder.js');

const projectRoot = path.resolve(__dirname, '..');

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_BUILDER_CACHE: process.env.ELECTRON_BUILDER_CACHE || '/tmp/gsbot-license-generator-cache',
    },
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

run(path.join(projectRoot, 'node_modules', '.bin', 'electron-builder'), [
  '--mac',
  'dmg',
  'zip',
  '--arm64',
  '--config',
  path.join('scripts', 'license-generator-builder-config.js'),
  '--publish',
  'never',
]);

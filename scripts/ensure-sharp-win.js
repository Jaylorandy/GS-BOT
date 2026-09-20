'use strict';

// Ensure Windows (win32-x64) sharp prebuilt binaries exist under node_modules/@img/
// before electron-builder packages a Windows target on macOS/Linux.
//
// Why: npm only installs the @img/sharp-* optional dependency matching the HOST
// platform. Cross-compiling a Windows build on a Mac therefore ships
// sharp-darwin-arm64 and NO win32 binary, so require('sharp') throws at launch
// and the installed app crashes immediately. We fetch the correct prebuilds from
// the npm registry and extract them next to the host ones (build.files already
// bundles node_modules/@img/**), leaving the host binaries untouched.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const IMG_DIR = path.join(PROJECT_ROOT, 'node_modules', '@img');

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

const sharpPkg = readJson(path.join(PROJECT_ROOT, 'node_modules', 'sharp', 'package.json'));
if (!sharpPkg) {
  console.log('[ensure-sharp-win] sharp not installed, skipping.');
  process.exit(0);
}
const SHARP_VERSION = sharpPkg.version;

// libvips package version: mirror the host libvips package if present, else
// fall back to the known-good pairing for sharp 0.33.x.
function detectLibvipsVersion() {
  try {
    const dirs = fs.readdirSync(IMG_DIR).filter((d) => /^sharp-libvips-/.test(d));
    for (const d of dirs) {
      const v = readJson(path.join(IMG_DIR, d, 'package.json'));
      if (v && v.version) return v.version;
    }
  } catch { /* noop */ }
  return '1.0.4';
}
const LIBVIPS_VERSION = detectLibvipsVersion();

// Packages we need for win32-x64. sharp 0.33.x splits libvips into its own pkg.
const TARGETS = [
  { name: '@img/sharp-libvips-win32-x64', version: LIBVIPS_VERSION, required: true },
  { name: '@img/sharp-win32-x64', version: SHARP_VERSION, required: true },
];

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': 'gsbot-build' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`GET ${url} → HTTP ${res.statusCode}`));
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, { headers: { 'user-agent': 'gsbot-build' } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`GET ${url} → HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
    }).on('error', (e) => { try { fs.unlinkSync(dest); } catch { /* noop */ } reject(e); });
  });
}

async function ensureOne(target) {
  const destDir = path.join(IMG_DIR, target.name.replace('@img/', ''));
  // Already present and non-empty? skip.
  if (fs.existsSync(destDir) && fs.readdirSync(destDir).length > 0) {
    console.log(`[ensure-sharp-win] ${target.name} already present, skipping.`);
    return;
  }

  const registryName = target.name; // scoped name URL-encodes the slash itself
  const metaUrl = `https://registry.npmjs.org/${registryName.replace('/', '%2f')}`;
  let meta;
  try {
    meta = await fetchJson(metaUrl);
  } catch (e) {
    const msg = `[ensure-sharp-win] failed to fetch metadata for ${target.name}: ${e.message}`;
    if (target.required) throw new Error(msg);
    console.warn(msg);
    return;
  }

  const versionInfo = meta.versions && meta.versions[target.version];
  if (!versionInfo || !versionInfo.dist || !versionInfo.dist.tarball) {
    const msg = `[ensure-sharp-win] ${target.name}@${target.version} not found in registry`;
    if (target.required) throw new Error(msg);
    console.warn(msg);
    return;
  }

  fs.mkdirSync(IMG_DIR, { recursive: true });
  const tgz = path.join(IMG_DIR, `.${target.name.replace('@img/', '')}-${target.version}.tgz`);
  console.log(`[ensure-sharp-win] downloading ${target.name}@${target.version} …`);
  await download(versionInfo.dist.tarball, tgz);

  // Extract: npm tarballs have a top-level "package/" folder.
  fs.mkdirSync(destDir, { recursive: true });
  execFileSync('tar', ['-xzf', tgz, '-C', destDir, '--strip-components=1'], { stdio: 'inherit' });
  fs.rmSync(tgz, { force: true });

  // Sanity: must contain the native .node or .dll payload.
  const hasPayload = (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) { if (walk(fp)) return true; }
      else if (/\.(?:node|dll)$/i.test(e.name)) return true;
    }
    return false;
  }(destDir));
  console.log(`[ensure-sharp-win] ✓ ${target.name}@${target.version} installed${hasPayload ? '' : ' (WARNING: no .node/.dll payload found)'}`);
}

async function main() {
  console.log(`[ensure-sharp-win] sharp@${SHARP_VERSION}, libvips@${LIBVIPS_VERSION} — ensuring win32-x64 prebuilds`);
  for (const t of TARGETS) {
    // eslint-disable-next-line no-await-in-loop
    await ensureOne(t);
  }
  console.log('[ensure-sharp-win] done.');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

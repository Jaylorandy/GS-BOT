#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { execFileSync, spawnSync } = require('child_process');
const { Browser, BrowserPlatform, getDownloadUrl, resolveBuildId } = require('@puppeteer/browsers');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const VENDOR_ROOT = path.join(PROJECT_ROOT, 'vendor');
const WINDOWS_RUNTIME_ROOT = path.join(VENDOR_ROOT, 'windows');
const DOWNLOAD_ROOT = path.join(VENDOR_ROOT, 'downloads');
const PYTHON_HOME = path.join(WINDOWS_RUNTIME_ROOT, 'python');
const NODE_HOME = path.join(WINDOWS_RUNTIME_ROOT, 'node');
const CHROMIUM_HOME = path.join(WINDOWS_RUNTIME_ROOT, 'chromium');
const CRT_HOME = path.join(WINDOWS_RUNTIME_ROOT, 'crt');
const PADDLE_VL_HOME = path.join(WINDOWS_RUNTIME_ROOT, 'paddleocr-vl');
const RMBG_HOME = path.join(WINDOWS_RUNTIME_ROOT, 'rmbg-2.0');
const LABEL_DETECTOR_HOME = path.join(WINDOWS_RUNTIME_ROOT, 'label-detector');

const PYTHON_VERSION = '3.11.9';
const NODE_WINDOWS_VERSION = '24.14.1';
const PYTHON_RUNTIME_URL = `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`;
const PYTHON_RUNTIME_ARCHIVE = path.join(DOWNLOAD_ROOT, `python-${PYTHON_VERSION}-embed-amd64.zip`);
const NODE_WINDOWS_RUNTIME_URL = `https://nodejs.org/dist/latest-v24.x/node-v${NODE_WINDOWS_VERSION}-win-x64.zip`;
const NODE_WINDOWS_RUNTIME_ARCHIVE = path.join(DOWNLOAD_ROOT, `node-v${NODE_WINDOWS_VERSION}-win-x64.zip`);
const WINDOWS_PYTORCH_FLAVOR = String(process.env.GSBOT_WINDOWS_PYTORCH_FLAVOR || 'cpu').trim().toLowerCase() === 'gpu'
  ? 'gpu'
  : 'cpu';
const WINDOWS_CUTOUT_VARIANT = 'light';
const INCLUDE_FULL_RMBG_RUNTIME = false;
const EXPECTED_TORCH_FLAVOR = INCLUDE_FULL_RMBG_RUNTIME ? WINDOWS_PYTORCH_FLAVOR : 'none';
const PYTORCH_INDEX_URL = WINDOWS_PYTORCH_FLAVOR === 'gpu'
  ? 'https://download.pytorch.org/whl/cu124'
  : 'https://download.pytorch.org/whl/cpu';
const BASE_PYTHON_PACKAGES = [
  'python-pptx',
  'Pillow',
  'striprtf',
  'PyMuPDF',
];
const BASE_PYTHON_PACKAGES_WITHOUT_TORCH_DEPS = BASE_PYTHON_PACKAGES.filter((packageName) => packageName !== 'Pillow');
const FULL_RMBG_PYTHON_PACKAGES = [
  'transformers',
  'timm',
  'kornia',
  'huggingface_hub',
  'safetensors',
];
const BASE_DEPENDENCY_PACKAGES = [
  'XlsxWriter>=0.5.7',
  'lxml>=3.1.0',
];
const FULL_RMBG_DEPENDENCY_PACKAGES = [
  'packaging>=20.0',
  'pyyaml>=5.1',
  'regex>=2025.10.22',
  'tokenizers<=0.23.0,>=0.22.0',
  'typer',
  'tqdm>=4.27',
  'hf-xet<2.0.0,>=1.4.3',
  'httpx<1,>=0.23.0',
  'anyio',
  'certifi',
  'httpcore==1.*',
  'idna',
  'h11>=0.16',
  'kornia_rs>=0.1.9',
  'setuptools<82',
  'exceptiongroup>=1.0.2',
  'click>=8.2.1',
  'shellingham>=1.3.0',
  'rich>=13.8.0',
  'annotated-doc>=0.0.2',
  'markdown-it-py>=2.2.0',
  'pygments<3.0.0,>=2.13.0',
  'mdurl~=0.1',
];
const PYTORCH_PACKAGES = [
  WINDOWS_PYTORCH_FLAVOR === 'gpu' ? 'torch==2.6.0' : 'torch==2.8.0+cpu',
  WINDOWS_PYTORCH_FLAVOR === 'gpu' ? 'torchvision==0.21.0' : 'torchvision==0.23.0+cpu',
];
const LOCAL_GPU_WHEEL_DIR = process.env.GSBOT_WINDOWS_GPU_WHEEL_DIR || '/Users/jaylorandy/Desktop/test/GPU';
const LOCAL_GPU_WHEEL_NAMES = [
  'torch-2.6.0+cu124-cp311-cp311-win_amd64.whl',
  'torchvision-0.21.0+cu124-cp311-cp311-win_amd64.whl',
];
const VC_RUNTIME_PACKAGE_VERSION = '1.0.5';
const VC_RUNTIME_PACKAGE_URL = `https://api.nuget.org/v3-flatcontainer/vcruntime.cefsharp.140/${VC_RUNTIME_PACKAGE_VERSION}/vcruntime.cefsharp.140.${VC_RUNTIME_PACKAGE_VERSION}.nupkg`;
const VC_RUNTIME_ARCHIVE = path.join(DOWNLOAD_ROOT, `vcruntime.cefsharp.140.${VC_RUNTIME_PACKAGE_VERSION}.nupkg`);
const VC_RUNTIME_DLLS = [
  'msvcp140.dll',
  'msvcp140_1.dll',
  'msvcp140_2.dll',
  'msvcp140_atomic_wait.dll',
  'msvcp140_codecvt_ids.dll',
  'vcruntime140.dll',
  'vcruntime140_1.dll',
];
const PADDLE_VL_RUNTIME_SOURCE = process.env.PADDLEOCR_VL_WINDOWS_RUNTIME_DIR || process.env.PADDLEOCR_VL_WIN_RUNTIME_DIR || '';
const RMBG_MODEL_SOURCE = process.env.RMBG_WINDOWS_MODEL_DIR
  || process.env.RMBG_MODEL_DIR
  || '';
const LABEL_DETECTOR_MODEL_SOURCE = process.env.GSBOT_WINDOWS_LABEL_DETECTOR_MODEL
  || path.join(
    PROJECT_ROOT,
    'models',
    'label-detector',
    'best.pt',
  );
const LABEL_DETECTOR_ONNX_SOURCE = process.env.GSBOT_WINDOWS_LABEL_DETECTOR_ONNX
  || path.join(
    PROJECT_ROOT,
    'models',
    'label-detector',
    'best.onnx',
  );

function ensureDir(targetPath) {
  fs.mkdirSync(targetPath, { recursive: true });
}

function removeDir(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function removeAppleDoubleFiles(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return;
  }

  const entries = fs.readdirSync(targetPath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      removeAppleDoubleFiles(entryPath);
      continue;
    }
    if (/^\._/.test(entry.name)) {
      fs.rmSync(entryPath, { force: true });
    }
  }
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(filePath, payload) {
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function copyDir(sourceDir, destinationDir) {
  ensureDir(destinationDir);
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (/^\._/.test(entry.name)) {
      continue;
    }
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);
    if (entry.isDirectory()) {
      copyDir(sourcePath, destinationPath);
    } else if (entry.isSymbolicLink()) {
      const resolvedPath = fs.realpathSync(sourcePath);
      const resolvedStats = fs.statSync(resolvedPath);
      if (resolvedStats.isDirectory()) {
        copyDir(resolvedPath, destinationPath);
      } else {
        fs.copyFileSync(resolvedPath, destinationPath);
      }
    } else {
      fs.copyFileSync(sourcePath, destinationPath);
    }
  }
}

function resolveOnnxruntimeWinBin() {
  const binRoot = path.join(PROJECT_ROOT, 'node_modules', 'onnxruntime-node', 'bin');
  let entries = [];
  try {
    entries = fs.readdirSync(binRoot, { withFileTypes: true });
  } catch {
    throw new Error(`ONNX Runtime bin directory was not found: ${binRoot}`);
  }

  const candidates = entries
    .filter((entry) => entry.isDirectory() && /^napi-v\d+$/i.test(entry.name))
    .sort((left, right) => right.name.localeCompare(left.name, undefined, { numeric: true, sensitivity: 'base' }))
    .map((entry) => path.join(binRoot, entry.name, 'win32', 'x64'));

  const resolved = candidates.find((candidate) => fs.existsSync(path.join(candidate, 'onnxruntime_binding.node')));
  if (!resolved) {
    throw new Error(`Windows ONNX Runtime binaries were not found. Tried: ${candidates.join(', ')}`);
  }

  return resolved;
}

function withTempFile(destinationPath) {
  return `${destinationPath}.tmp`;
}

function downloadFile(url, destinationPath, options = {}) {
  const {
    timeoutMs = 30 * 60 * 1000,
  } = options;
  ensureDir(path.dirname(destinationPath));

  return new Promise((resolve, reject) => {
    const tempPath = withTempFile(destinationPath);
    const protocol = url.startsWith('https:') ? https : http;

    const cleanup = (error) => {
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {}
      reject(error);
    };

    const request = protocol.get(url, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        downloadFile(response.headers.location, destinationPath, options).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        response.resume();
        cleanup(new Error(`Download failed with HTTP ${response.statusCode}: ${url}`));
        return;
      }

      const file = fs.createWriteStream(tempPath);
      response.pipe(file);

      file.on('finish', () => {
        file.close(() => {
          fs.renameSync(tempPath, destinationPath);
          resolve(destinationPath);
        });
      });

      file.on('error', cleanup);
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`Download timed out after ${Math.round(timeoutMs / 1000)} seconds: ${url}`));
    });
    request.on('error', cleanup);
  });
}

async function downloadFileWithRetry(url, destinationPath, options = {}) {
  const {
    retries = 4,
    retryDelayMs = 2500,
    timeoutMs = 30 * 60 * 1000,
  } = options;

  let attempt = 0;
  while (attempt <= retries) {
    try {
      return await downloadFile(url, destinationPath, { timeoutMs });
    } catch (error) {
      const message = String(error?.message || error || '');
      const retryable = /ECONNRESET|ETIMEDOUT|timed out|socket hang up|network error|ECONNREFUSED/i.test(message);
      if (!retryable || attempt === retries) {
        throw error;
      }
      const waitMs = retryDelayMs * (attempt + 1);
      console.warn(`[runtime] Download retry ${attempt + 1}/${retries} after error: ${message}`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      attempt += 1;
    }
  }

  throw new Error(`Download failed after ${retries + 1} attempts: ${url}`);
}

function extractZip(archivePath, destinationPath) {
  ensureDir(destinationPath);

  if (process.platform === 'win32') {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destinationPath.replace(/'/g, "''")}' -Force`,
      ],
      { stdio: 'inherit' },
    );
    return;
  }

  execFileSync('unzip', ['-oq', archivePath, '-d', destinationPath], {
    stdio: 'inherit',
  });
}

function findBuildPython() {
  const candidates = process.platform === 'win32'
    ? [
        { command: 'py', args: ['-3'] },
        { command: 'python', args: [] },
        { command: 'python3', args: [] },
      ]
    : [
        { command: 'python3', args: [] },
        { command: 'python', args: [] },
      ];

  for (const candidate of candidates) {
    try {
      const result = spawnSync(candidate.command, [...candidate.args, '--version'], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      });

      if (result.status === 0) {
        return candidate;
      }
    } catch {}
  }

  return null;
}

function installWindowsPythonPackages(sitePackagesDir) {
  const buildPython = findBuildPython();
  if (!buildPython) {
    throw new Error('A build-time Python interpreter is required to prepare the bundled Windows runtime.');
  }

  removeDir(sitePackagesDir);
  ensureDir(sitePackagesDir);
  removeAppleDoubleFiles(PYTHON_HOME);

  const baseInstallArgs = [
    ...buildPython.args,
    '-m',
    'pip',
    'install',
    '--disable-pip-version-check',
    '--upgrade',
    '--no-compile',
    '--timeout',
    '120',
    '--retries',
    '12',
    '--resume-retries',
    '20',
    '--target',
    sitePackagesDir,
    '--platform',
    'win_amd64',
    '--implementation',
    'cp',
    '--python-version',
    '3.11',
    '--abi',
    'cp311',
    '--only-binary=:all:',
  ];

  const pythonPackages = INCLUDE_FULL_RMBG_RUNTIME
    ? [...BASE_PYTHON_PACKAGES_WITHOUT_TORCH_DEPS, ...FULL_RMBG_PYTHON_PACKAGES]
    : [...BASE_PYTHON_PACKAGES];
  const dependencyPackages = INCLUDE_FULL_RMBG_RUNTIME
    ? [...BASE_DEPENDENCY_PACKAGES, ...FULL_RMBG_DEPENDENCY_PACKAGES]
    : [...BASE_DEPENDENCY_PACKAGES];

  const resolvedLocalGpuWheelDir = String(LOCAL_GPU_WHEEL_DIR || '').trim();
  const localGpuWheelPaths = WINDOWS_PYTORCH_FLAVOR === 'gpu' && resolvedLocalGpuWheelDir
    ? LOCAL_GPU_WHEEL_NAMES.map((fileName) => path.join(resolvedLocalGpuWheelDir, fileName))
    : [];
  const hasLocalGpuWheels = localGpuWheelPaths.length > 0 && localGpuWheelPaths.every((targetPath) => fs.existsSync(targetPath));

  if (INCLUDE_FULL_RMBG_RUNTIME) {
    if (WINDOWS_PYTORCH_FLAVOR === 'gpu' && hasLocalGpuWheels) {
      console.log(`[runtime] Installing GPU PyTorch from local wheels in ${resolvedLocalGpuWheelDir}...`);
      execFileSync(buildPython.command, [
        ...baseInstallArgs,
        '--no-deps',
        '--no-index',
        ...localGpuWheelPaths,
      ], {
        cwd: PROJECT_ROOT,
        stdio: 'inherit',
      });
      removeAppleDoubleFiles(sitePackagesDir);
    } else {
      execFileSync(buildPython.command, [
        ...baseInstallArgs,
        '--index-url',
        PYTORCH_INDEX_URL,
        ...PYTORCH_PACKAGES,
      ], {
        cwd: PROJECT_ROOT,
        stdio: 'inherit',
      });
      removeAppleDoubleFiles(sitePackagesDir);
    }
  }

  execFileSync(buildPython.command, [
    ...baseInstallArgs,
    '--no-deps',
    ...pythonPackages,
    ...dependencyPackages,
  ], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
  });
  removeAppleDoubleFiles(sitePackagesDir);
}

function configureEmbeddedPython() {
  const pthFile = fs.readdirSync(PYTHON_HOME).find((fileName) => /^python\d+._pth$/i.test(fileName));
  if (!pthFile) {
    throw new Error('Embedded Python ._pth file was not found.');
  }

  const pthPath = path.join(PYTHON_HOME, pthFile);
  fs.writeFileSync(
    pthPath,
    ['python311.zip', '.', 'Lib', 'Lib/site-packages', 'import site', ''].join('\n'),
    'utf8',
  );
}

function getInstalledPackageNames(sitePackagesDir) {
  return fs.readdirSync(sitePackagesDir)
    .filter((entry) => entry.endsWith('.dist-info'))
    .map((entry) => entry.replace(/-[^-]+\.dist-info$/, ''))
    .sort((left, right) => left.localeCompare(right));
}

function extractZipToTemp(archivePath, prefix) {
  const tempRoot = fs.mkdtempSync(path.join(DOWNLOAD_ROOT, prefix));
  extractZip(archivePath, tempRoot);
  return tempRoot;
}

function syncFiles(fileNames, sourceDir, destinationDir) {
  ensureDir(destinationDir);

  for (const fileName of fileNames) {
    const sourcePath = path.join(sourceDir, fileName);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Missing required runtime file: ${sourcePath}`);
    }

    fs.copyFileSync(sourcePath, path.join(destinationDir, fileName));
  }
}

function hasRequiredWindowsPythonPackages(sitePackagesDir) {
  const requiredPaths = [
    path.join(sitePackagesDir, 'pptx'),
    path.join(sitePackagesDir, 'fitz'),
    path.join(sitePackagesDir, 'pymupdf'),
  ];

  if (INCLUDE_FULL_RMBG_RUNTIME) {
    requiredPaths.push(
      path.join(sitePackagesDir, 'torch'),
      path.join(sitePackagesDir, 'torchvision'),
      path.join(sitePackagesDir, 'transformers'),
      path.join(sitePackagesDir, 'timm'),
      path.join(sitePackagesDir, 'kornia'),
      path.join(sitePackagesDir, 'huggingface_hub'),
      path.join(sitePackagesDir, 'safetensors'),
    );
  }

  return requiredPaths.every((targetPath) => fs.existsSync(targetPath));
}

function detectBundledTorchFlavor(sitePackagesDir) {
  const versionPath = path.join(sitePackagesDir, 'torch', 'version.py');
  if (!fs.existsSync(versionPath)) {
    return '';
  }

  try {
    const source = fs.readFileSync(versionPath, 'utf8');
    return /\+cu\d+/i.test(source) ? 'gpu' : 'cpu';
  } catch {
    return '';
  }
}

function hasRequiredBundledNode(nodeHome) {
  const manifest = readJsonIfExists(path.join(nodeHome, 'runtime-manifest.json'));
  return Boolean(
    manifest?.version === NODE_WINDOWS_VERSION
    && fs.existsSync(path.join(nodeHome, 'node.exe')),
  );
}

async function prepareBundledPython() {
  const manifestPath = path.join(PYTHON_HOME, 'runtime-manifest.json');
  const currentManifest = readJsonIfExists(manifestPath);
  const expectedExe = path.join(PYTHON_HOME, 'python.exe');
  if (
    currentManifest?.version === PYTHON_VERSION &&
    currentManifest?.torchFlavor === EXPECTED_TORCH_FLAVOR &&
    fs.existsSync(expectedExe) &&
    hasRequiredWindowsPythonPackages(path.join(PYTHON_HOME, 'Lib', 'site-packages')) &&
    (
      !INCLUDE_FULL_RMBG_RUNTIME
      || detectBundledTorchFlavor(path.join(PYTHON_HOME, 'Lib', 'site-packages')) === WINDOWS_PYTORCH_FLAVOR
    )
  ) {
    console.log(`[runtime] Bundled Python ${PYTHON_VERSION} (${EXPECTED_TORCH_FLAVOR.toUpperCase()}) is already prepared.`);
    return;
  }

  console.log(`[runtime] Downloading embedded Python ${PYTHON_VERSION} for ${EXPECTED_TORCH_FLAVOR.toUpperCase()} runtime...`);
  if (fs.existsSync(PYTHON_RUNTIME_ARCHIVE)) {
    console.log(`[runtime] Using cached embedded Python archive: ${PYTHON_RUNTIME_ARCHIVE}`);
  } else {
    await downloadFileWithRetry(PYTHON_RUNTIME_URL, PYTHON_RUNTIME_ARCHIVE, { retries: 4, timeoutMs: 10 * 60 * 1000 });
  }

  console.log('[runtime] Extracting embedded Python...');
  removeDir(PYTHON_HOME);
  ensureDir(PYTHON_HOME);
  extractZip(PYTHON_RUNTIME_ARCHIVE, PYTHON_HOME);
  removeAppleDoubleFiles(PYTHON_HOME);

  ensureDir(path.join(PYTHON_HOME, 'Lib', 'site-packages'));
  configureEmbeddedPython();

  console.log('[runtime] Installing Windows Python packages...');
  installWindowsPythonPackages(path.join(PYTHON_HOME, 'Lib', 'site-packages'));

  writeJson(manifestPath, {
    type: 'embedded-python',
    version: PYTHON_VERSION,
    torchFlavor: EXPECTED_TORCH_FLAVOR,
    torchIndexUrl: INCLUDE_FULL_RMBG_RUNTIME ? PYTORCH_INDEX_URL : '',
    cutoutVariant: WINDOWS_CUTOUT_VARIANT,
    sourceUrl: PYTHON_RUNTIME_URL,
    packages: getInstalledPackageNames(path.join(PYTHON_HOME, 'Lib', 'site-packages')),
    generatedAt: new Date().toISOString(),
  });
}

async function prepareBundledNode() {
  if (hasRequiredBundledNode(NODE_HOME)) {
    console.log(`[runtime] Bundled Node ${NODE_WINDOWS_VERSION} is already prepared.`);
    return;
  }

  console.log(`[runtime] Downloading bundled Node ${NODE_WINDOWS_VERSION}...`);
  await downloadFileWithRetry(NODE_WINDOWS_RUNTIME_URL, NODE_WINDOWS_RUNTIME_ARCHIVE, { retries: 4, timeoutMs: 10 * 60 * 1000 });

  console.log('[runtime] Extracting bundled Node...');
  const extractRoot = extractZipToTemp(NODE_WINDOWS_RUNTIME_ARCHIVE, 'node-runtime-');
  try {
    const extractedHome = path.join(extractRoot, `node-v${NODE_WINDOWS_VERSION}-win-x64`);
    const nodeExe = path.join(extractedHome, 'node.exe');
    if (!fs.existsSync(nodeExe)) {
      throw new Error(`Bundled Node executable was not found in ${extractedHome}`);
    }

    removeDir(NODE_HOME);
    ensureDir(NODE_HOME);
    fs.copyFileSync(nodeExe, path.join(NODE_HOME, 'node.exe'));
    writeJson(path.join(NODE_HOME, 'runtime-manifest.json'), {
      type: 'node-runtime',
      version: NODE_WINDOWS_VERSION,
      executable: 'node.exe',
      sourceUrl: NODE_WINDOWS_RUNTIME_URL,
      generatedAt: new Date().toISOString(),
    });
  } finally {
    removeDir(extractRoot);
  }
}

async function prepareWindowsVisualCppRuntime() {
  const onnxruntimeWinBin = resolveOnnxruntimeWinBin();
  const manifestPath = path.join(CRT_HOME, 'runtime-manifest.json');
  const currentManifest = readJsonIfExists(manifestPath);
  const hasVendorDlls = VC_RUNTIME_DLLS.every((fileName) => fs.existsSync(path.join(CRT_HOME, fileName)));
  const hasOnnxDlls = VC_RUNTIME_DLLS.every((fileName) => fs.existsSync(path.join(onnxruntimeWinBin, fileName)));

  if (
    currentManifest?.version === VC_RUNTIME_PACKAGE_VERSION
    && hasVendorDlls
    && hasOnnxDlls
  ) {
    console.log(`[runtime] Bundled Visual C++ runtime ${VC_RUNTIME_PACKAGE_VERSION} is already prepared.`);
    return;
  }

  console.log(`[runtime] Downloading app-local Visual C++ runtime ${VC_RUNTIME_PACKAGE_VERSION}...`);
  await downloadFileWithRetry(VC_RUNTIME_PACKAGE_URL, VC_RUNTIME_ARCHIVE, { retries: 4, timeoutMs: 10 * 60 * 1000 });

  console.log('[runtime] Extracting app-local Visual C++ runtime...');
  const extractRoot = extractZipToTemp(VC_RUNTIME_ARCHIVE, 'vcruntime-');
  try {
    const x64Dir = path.join(extractRoot, 'vc_redist', 'x64');
    if (!fs.existsSync(x64Dir)) {
      throw new Error(`Visual C++ runtime payload was not found in ${extractRoot}`);
    }

    removeDir(CRT_HOME);
    ensureDir(CRT_HOME);
    syncFiles(VC_RUNTIME_DLLS, x64Dir, CRT_HOME);
    syncFiles(VC_RUNTIME_DLLS, CRT_HOME, onnxruntimeWinBin);

    writeJson(manifestPath, {
      type: 'visual-cpp-runtime',
      version: VC_RUNTIME_PACKAGE_VERSION,
      sourceUrl: VC_RUNTIME_PACKAGE_URL,
      files: VC_RUNTIME_DLLS,
      generatedAt: new Date().toISOString(),
    });
  } finally {
    removeDir(extractRoot);
  }
}

async function prepareBundledChromium() {
  const manifestPath = path.join(CHROMIUM_HOME, 'runtime-manifest.json');
  const currentManifest = readJsonIfExists(manifestPath);
  const expectedExe = path.join(CHROMIUM_HOME, 'chrome-win64', 'chrome.exe');

  if (currentManifest?.buildId && fs.existsSync(expectedExe) && process.env.GSBOT_FORCE_CHROMIUM_REFRESH !== '1') {
    console.log(`[runtime] Bundled Chromium ${currentManifest.buildId} is already prepared.`);
    return;
  }

  let buildId = '';
  let downloadUrl = '';
  try {
    buildId = await resolveBuildId(Browser.CHROME, BrowserPlatform.WIN64, 'stable');
    downloadUrl = String(getDownloadUrl(Browser.CHROME, BrowserPlatform.WIN64, buildId));
  } catch (error) {
    if (currentManifest?.buildId && fs.existsSync(expectedExe)) {
      console.warn(`[runtime] Falling back to existing bundled Chromium ${currentManifest.buildId} after version check failed: ${error.message}`);
      return;
    }
    throw error;
  }

  const archivePath = path.join(DOWNLOAD_ROOT, `chrome-${buildId}-win64.zip`);

  if (currentManifest?.buildId === buildId && fs.existsSync(expectedExe)) {
    console.log(`[runtime] Bundled Chromium ${buildId} is already prepared.`);
    return;
  }

  console.log(`[runtime] Downloading Chromium ${buildId} for Windows x64...`);
  await downloadFileWithRetry(downloadUrl, archivePath, { retries: 5, timeoutMs: 20 * 60 * 1000 });

  console.log('[runtime] Extracting Chromium...');
  removeDir(CHROMIUM_HOME);
  ensureDir(CHROMIUM_HOME);
  extractZip(archivePath, CHROMIUM_HOME);

  writeJson(manifestPath, {
    type: 'chromium',
    channel: 'stable',
    buildId,
    executable: path.join('chrome-win64', 'chrome.exe'),
    sourceUrl: downloadUrl,
    generatedAt: new Date().toISOString(),
  });
}

function prepareBundledPaddleVlRuntime() {
  removeDir(PADDLE_VL_HOME);
  ensureDir(PADDLE_VL_HOME);

  const manifestPath = path.join(PADDLE_VL_HOME, 'runtime-manifest.json');
  const resolvedSource = String(PADDLE_VL_RUNTIME_SOURCE || '').trim();

  if (!resolvedSource) {
    writeJson(manifestPath, {
      type: 'paddleocr-vl-runtime',
      bundled: false,
      ready: false,
      message: 'No bundled PaddleOCR-VL 1.5 runtime source directory was provided for this build.',
      hint: 'Set PADDLEOCR_VL_WINDOWS_RUNTIME_DIR to a prepared Windows runtime folder before packaging to embed PaddleOCR-VL 1.5.',
      generatedAt: new Date().toISOString(),
    });
    console.log('[runtime] No bundled PaddleOCR-VL runtime source was provided. Writing placeholder manifest.');
    return;
  }

  if (!fs.existsSync(resolvedSource) || !fs.statSync(resolvedSource).isDirectory()) {
    throw new Error(`PaddleOCR-VL runtime source directory was not found: ${resolvedSource}`);
  }

  copyDir(resolvedSource, PADDLE_VL_HOME);
  removeAppleDoubleFiles(PADDLE_VL_HOME);

  const runtimeEntrypoints = [
    path.join(PADDLE_VL_HOME, 'runtime-manifest.json'),
    path.join(PADDLE_VL_HOME, 'manifest.json'),
    path.join(PADDLE_VL_HOME, 'server.js'),
    path.join(PADDLE_VL_HOME, 'server.py'),
    path.join(PADDLE_VL_HOME, 'launch.bat'),
    path.join(PADDLE_VL_HOME, 'start.bat'),
  ];
  const detectedEntry = runtimeEntrypoints.find((candidate) => fs.existsSync(candidate)) || '';
  const existingManifest = readJsonIfExists(manifestPath);

  writeJson(manifestPath, {
    type: 'paddleocr-vl-runtime',
    bundled: true,
    ready: Boolean(detectedEntry || existingManifest?.ready),
    sourcePath: resolvedSource,
    entrypoint: detectedEntry ? path.relative(PADDLE_VL_HOME, detectedEntry) : (existingManifest?.entrypoint || ''),
    model: existingManifest?.model || 'paddleocr-vl-1.5',
    provider: existingManifest?.provider || '',
    baseUrl: existingManifest?.baseUrl || '',
    modelFile: existingManifest?.modelFile || '',
    mmprojFile: existingManifest?.mmprojFile || '',
    host: existingManifest?.host || '127.0.0.1',
    port: existingManifest?.port || 18080,
    chatTemplate: existingManifest?.chatTemplate || '',
    ctxSize: existingManifest?.ctxSize || 8192,
    nGpuLayers: existingManifest?.nGpuLayers ?? 0,
    serverArgs: Array.isArray(existingManifest?.serverArgs) ? existingManifest.serverArgs : [],
    notes: existingManifest?.notes || '',
    generatedAt: new Date().toISOString(),
  });

  console.log(`[runtime] Bundled PaddleOCR-VL runtime copied from ${resolvedSource}.`);
}

function prepareBundledRmbgRuntime() {
  removeDir(RMBG_HOME);
  ensureDir(RMBG_HOME);

  const manifestPath = path.join(RMBG_HOME, 'runtime-manifest.json');

  if (!INCLUDE_FULL_RMBG_RUNTIME) {
    writeJson(manifestPath, {
      type: 'rmbg-runtime',
      bundled: false,
      ready: false,
      variant: WINDOWS_CUTOUT_VARIANT,
      model: 'RMBG-2.0',
      message: 'Full RMBG 2.0 is intentionally omitted from this Windows light build.',
      hint: 'Use Lite mode in Garment Cleaner, or install the hybrid build to enable the full RMBG pipeline.',
      generatedAt: new Date().toISOString(),
    });
    console.log('[runtime] Skipping bundled RMBG runtime for the Windows light build.');
    return;
  }

  const resolvedSource = String(RMBG_MODEL_SOURCE || '').trim();

  if (!resolvedSource) {
    writeJson(manifestPath, {
      type: 'rmbg-runtime',
      bundled: false,
      ready: false,
      message: 'No bundled RMBG 2.0 model source directory was provided for this build.',
      hint: 'Set RMBG_WINDOWS_MODEL_DIR to the official RMBG 2.0 model folder before packaging.',
      generatedAt: new Date().toISOString(),
    });
    console.log('[runtime] No bundled RMBG runtime source was provided. Writing placeholder manifest.');
    return;
  }

  if (!fs.existsSync(resolvedSource) || !fs.statSync(resolvedSource).isDirectory()) {
    throw new Error(`RMBG model source directory was not found: ${resolvedSource}`);
  }

  const requiredFiles = ['config.json', 'birefnet.py', 'BiRefNet_config.py'];
  const missing = requiredFiles.filter((name) => !fs.existsSync(path.join(resolvedSource, name)));
  if (missing.length) {
    throw new Error(`Bundled RMBG model source is incomplete. Missing: ${missing.join(', ')}`);
  }

  copyDir(resolvedSource, RMBG_HOME);
  removeAppleDoubleFiles(RMBG_HOME);

  const safetensorsPath = path.join(RMBG_HOME, 'model.safetensors');
  const pytorchBinPath = path.join(RMBG_HOME, 'pytorch_model.bin');
  const ready = fs.existsSync(safetensorsPath) || fs.existsSync(pytorchBinPath);

  writeJson(manifestPath, {
    type: 'rmbg-runtime',
    bundled: true,
    ready,
    provider: 'bria',
    model: 'RMBG-2.0',
    sourcePath: resolvedSource,
    configFile: 'config.json',
    remoteCodeFile: 'birefnet.py',
    weightsFile: fs.existsSync(safetensorsPath) ? 'model.safetensors' : (fs.existsSync(pytorchBinPath) ? 'pytorch_model.bin' : ''),
    generatedAt: new Date().toISOString(),
  });

  console.log(`[runtime] Bundled RMBG runtime copied from ${resolvedSource}.`);
}

function prepareBundledLabelDetectorRuntime() {
  // Safety: refuse to run if anyone has accidentally pointed the source at
  // the same directory we're about to delete. removeDir(LABEL_DETECTOR_HOME)
  // would otherwise wipe the source model before we can read it.
  const homeAbs = path.resolve(LABEL_DETECTOR_HOME);
  for (const src of [LABEL_DETECTOR_MODEL_SOURCE, LABEL_DETECTOR_ONNX_SOURCE]) {
    if (!src) continue;
    const srcAbs = path.resolve(src);
    if (srcAbs.startsWith(`${homeAbs}${path.sep}`) || srcAbs === homeAbs) {
      throw new Error(
        `Label detector source "${srcAbs}" lives inside the runtime target `
          + `"${homeAbs}", which prepare-windows-runtime.js deletes before `
          + 'copying. Move the source to a different directory '
          + '(e.g. models/label-detector/) and retry.',
      );
    }
  }

  removeDir(LABEL_DETECTOR_HOME);
  ensureDir(LABEL_DETECTOR_HOME);

  const manifestPath = path.join(LABEL_DETECTOR_HOME, 'runtime-manifest.json');
  const resolvedSource = String(LABEL_DETECTOR_MODEL_SOURCE || '').trim();
  const resolvedOnnxSource = String(LABEL_DETECTOR_ONNX_SOURCE || '').trim();

  if (!resolvedSource && !resolvedOnnxSource) {
    writeJson(manifestPath, {
      type: 'label-detector-runtime',
      bundled: false,
      ready: false,
      modelFile: '',
      ptModelFile: '',
      yoloCommand: '',
      pythonModule: '',
      message: 'No bundled label detector model source was provided for this build.',
      hint: 'Set GSBOT_WINDOWS_LABEL_DETECTOR_ONNX or GSBOT_WINDOWS_LABEL_DETECTOR_MODEL before packaging to embed the label detector model.',
      generatedAt: new Date().toISOString(),
    });
    console.log('[runtime] No bundled label detector model source was provided. Writing placeholder manifest.');
    return;
  }

  const hasPt = resolvedSource && fs.existsSync(resolvedSource) && fs.statSync(resolvedSource).isFile();
  const hasOnnx = resolvedOnnxSource && fs.existsSync(resolvedOnnxSource) && fs.statSync(resolvedOnnxSource).isFile();

  if (!hasPt && !hasOnnx) {
    writeJson(manifestPath, {
      type: 'label-detector-runtime',
      bundled: false,
      ready: false,
      modelFile: '',
      ptModelFile: '',
      yoloCommand: '',
      pythonModule: '',
      message: `Bundled label detector model was not found: ${resolvedOnnxSource || resolvedSource}`,
      hint: 'Provide a valid best.onnx or best.pt before packaging.',
      generatedAt: new Date().toISOString(),
    });
    console.log('[runtime] Bundled label detector model source was not found. Writing placeholder manifest.');
    return;
  }

  let modelFile = '';
  let ptModelFile = '';
  if (hasOnnx) {
    modelFile = path.basename(resolvedOnnxSource);
    fs.copyFileSync(resolvedOnnxSource, path.join(LABEL_DETECTOR_HOME, modelFile));
  }
  if (hasPt) {
    ptModelFile = path.basename(resolvedSource);
    fs.copyFileSync(resolvedSource, path.join(LABEL_DETECTOR_HOME, ptModelFile));
  }
  removeAppleDoubleFiles(LABEL_DETECTOR_HOME);

  writeJson(manifestPath, {
    type: 'label-detector-runtime',
    bundled: true,
    ready: true,
    sourcePath: hasOnnx ? resolvedOnnxSource : resolvedSource,
    modelFile,
    ptModelFile,
    yoloCommand: '',
    pythonModule: '',
    message: hasOnnx
      ? 'Bundled ONNX label detector model is available for built-in runtime inference.'
      : 'Bundled PyTorch label detector model is available, but a YOLO runtime still needs to be provided separately on Windows.',
    hint: hasOnnx
      ? ''
      : 'Add a Windows YOLO runtime later, then set yoloCommand or pythonModule in runtime-manifest.json to enable detector execution.',
    generatedAt: new Date().toISOString(),
  });

  console.log(`[runtime] Bundled label detector model copied from ${hasOnnx ? resolvedOnnxSource : resolvedSource}.`);

  // Verify the copy actually landed and is non-empty. Earlier issues with
  // external-drive AppleDouble files have produced silent zero-byte copies.
  if (hasOnnx) {
    const targetOnnx = path.join(LABEL_DETECTOR_HOME, modelFile);
    const dstSize = fs.statSync(targetOnnx).size;
    const srcSize = fs.statSync(resolvedOnnxSource).size;
    if (!dstSize || dstSize !== srcSize) {
      throw new Error(`Label detector ONNX did not copy correctly (src=${srcSize} dst=${dstSize}) at ${targetOnnx}`);
    }
    console.log(`[runtime] ✓ Verified bundled label detector ONNX (${(dstSize / 1024 / 1024).toFixed(2)} MB) at ${targetOnnx}`);
  }
}

async function main() {
  ensureDir(WINDOWS_RUNTIME_ROOT);
  ensureDir(DOWNLOAD_ROOT);

  await prepareBundledPython();
  await prepareBundledNode();
  await prepareWindowsVisualCppRuntime();
  await prepareBundledChromium();
  prepareBundledPaddleVlRuntime();
  prepareBundledRmbgRuntime();
  prepareBundledLabelDetectorRuntime();

  console.log('[runtime] Windows bundled runtime is ready.');
}

main().catch((error) => {
  console.error('[runtime] Failed to prepare the Windows bundled runtime.');
  console.error(error);
  process.exit(1);
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const pythonCache = new Map();
const chromeCache = new Map();

function fileExists(targetPath) {
  if (!targetPath) {
    return false;
  }

  try {
    return fs.existsSync(targetPath);
  } catch {
    return false;
  }
}

function isPackagedApp() {
  return __dirname.includes('app.asar');
}

function readJsonIfExists(filePath) {
  if (!fileExists(filePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function getWindowsRuntimeRoot() {
  if (process.platform !== 'win32') {
    return null;
  }

  if (isPackagedApp()) {
    return path.join(process.resourcesPath, 'runtime', 'windows');
  }

  return path.join(__dirname, 'vendor', 'windows');
}

function getPackagedAppUnpackedRoot() {
  if (!isPackagedApp()) {
    return '';
  }

  return path.join(process.resourcesPath, 'app.asar.unpacked');
}

function getMacRuntimeRoot() {
  if (process.platform !== 'darwin') {
    return null;
  }

  if (isPackagedApp()) {
    return path.join(process.resourcesPath, 'runtime', 'mac');
  }

  return path.join(__dirname, 'vendor', 'mac');
}

function getBundledWindowsRuntimeManifest(runtimeFolderName) {
  const runtimeRoot = getWindowsRuntimeRoot();
  if (!runtimeRoot) {
    return null;
  }

  return readJsonIfExists(path.join(runtimeRoot, runtimeFolderName, 'runtime-manifest.json'));
}

function getBundledFabricLabelDetectorStatus() {
  const runtimeRoot = process.platform === 'win32'
    ? getWindowsRuntimeRoot()
    : getMacRuntimeRoot();
  if (!runtimeRoot) {
    return null;
  }

  const home = path.join(runtimeRoot, 'label-detector');
  const manifest = readJsonIfExists(path.join(home, 'runtime-manifest.json')) || {};
  const modelFile = String(manifest.modelFile || 'best.onnx').trim() || 'best.onnx';
  const ptModelFile = String(manifest.ptModelFile || 'best.pt').trim() || 'best.pt';
  const yoloCommand = String(manifest.yoloCommand || '').trim();
  const pythonModule = String(manifest.pythonModule || '').trim();
  const modelPath = path.join(home, modelFile);
  const ptModelPath = path.join(home, ptModelFile);
  const ready = fileExists(modelPath) || fileExists(ptModelPath);

  return {
    bundled: Boolean(manifest.bundled),
    downloaded: false,
    ready,
    home,
    modelPath: fileExists(modelPath) ? modelPath : '',
    modelFile,
    ptModelPath: fileExists(ptModelPath) ? ptModelPath : '',
    ptModelFile,
    yoloCommand,
    pythonModule,
    message: manifest.message || (ready
      ? `Bundled label detector model detected in the GS Bot ${process.platform === 'darwin' ? 'macOS' : 'Windows'} runtime directory.`
      : `Bundled label detector model is not installed in the GS Bot ${process.platform === 'darwin' ? 'macOS' : 'Windows'} runtime directory.`),
    hint: manifest.hint || '',
  };
}

function getDevFabricLabelDetectorCandidates() {
  const projectRoots = Array.from(new Set([
    __dirname,
    process.cwd(),
  ].filter(Boolean)));

  const relativeCandidates = [
    path.join('runs', 'detect', 'train-3', 'weights', 'best.onnx'),
    path.join('runs', 'detect', 'train-3', 'weights', 'best.pt'),
    path.join('label training', 'project-1-at-2026-04-29-01-26-fa2c918e', 'runs', 'detect', 'train-2', 'weights', 'best.onnx'),
    path.join('label training', 'project-1-at-2026-04-29-01-26-fa2c918e', 'runs', 'detect', 'train-2', 'weights', 'best.pt'),
    path.join('label training', 'project-1-at-2026-04-29-01-26-fa2c918e', 'runs', 'detect', 'train', 'weights', 'best.onnx'),
    path.join('label training', 'project-1-at-2026-04-29-01-26-fa2c918e', 'runs', 'detect', 'train', 'weights', 'best.pt'),
  ];

  return projectRoots.flatMap((rootDir) => relativeCandidates.map((relativePath) => path.join(rootDir, relativePath)));
}

function getFabricLabelDetectorStatus() {
  const envModelPath = String(process.env.GSBOT_FABRIC_LABEL_DETECTOR_MODEL || '').trim();
  if (envModelPath && fileExists(envModelPath)) {
    return {
      bundled: false,
      downloaded: false,
      ready: true,
      home: path.dirname(envModelPath),
      modelPath: envModelPath,
      modelFile: path.basename(envModelPath),
      yoloCommand: String(process.env.GSBOT_YOLO_COMMAND || '').trim(),
      pythonModule: '',
      message: 'Label detector model path was provided through GSBOT_FABRIC_LABEL_DETECTOR_MODEL.',
      hint: '',
    };
  }

  const bundled = getBundledFabricLabelDetectorStatus();
  if (bundled?.ready) {
    return bundled;
  }

  const devModelPath = getDevFabricLabelDetectorCandidates().find((candidate) => fileExists(candidate)) || '';
  if (devModelPath) {
    return {
      bundled: false,
      downloaded: false,
      ready: true,
      home: path.dirname(devModelPath),
      modelPath: devModelPath,
      modelFile: path.basename(devModelPath),
      ptModelPath: /\.onnx$/i.test(devModelPath)
        ? (getDevFabricLabelDetectorCandidates().find((candidate) => /\.pt$/i.test(candidate) && fileExists(candidate)) || '')
        : devModelPath,
      ptModelFile: /\.onnx$/i.test(devModelPath)
        ? path.basename(getDevFabricLabelDetectorCandidates().find((candidate) => /\.pt$/i.test(candidate) && fileExists(candidate)) || '')
        : path.basename(devModelPath),
      yoloCommand: String(process.env.GSBOT_YOLO_COMMAND || '').trim(),
      pythonModule: '',
      message: 'Development label detector model detected in the workspace.',
      hint: '',
    };
  }

  return bundled || {
    bundled: false,
    downloaded: false,
    ready: false,
    home: '',
    modelPath: '',
    modelFile: '',
    yoloCommand: '',
    pythonModule: '',
    message: 'Label detector model is not installed.',
    hint: 'Bundle a label detector model into the Windows runtime or set GSBOT_FABRIC_LABEL_DETECTOR_MODEL.',
  };
}

function getBundledRmbgRuntimeStatus() {
  const runtimeRoot = process.platform === 'win32'
    ? getWindowsRuntimeRoot()
    : getMacRuntimeRoot();
  if (!runtimeRoot) {
    return null;
  }

  const home = path.join(runtimeRoot, 'rmbg-2.0');
  const manifest = readJsonIfExists(path.join(home, 'runtime-manifest.json'));
  const configPath = manifest?.configFile ? path.join(home, manifest.configFile) : path.join(home, 'config.json');
  const remoteCodePath = manifest?.remoteCodeFile ? path.join(home, manifest.remoteCodeFile) : path.join(home, 'birefnet.py');
  const weightsPath = manifest?.weightsFile ? path.join(home, manifest.weightsFile) : '';
  const ready = Boolean(
    manifest?.bundled
    && fileExists(configPath)
    && fileExists(remoteCodePath)
    && (!weightsPath || fileExists(weightsPath)),
  );

  return {
    bundled: Boolean(manifest?.bundled),
    downloaded: false,
    ready,
    home,
    model: manifest?.model || 'RMBG-2.0',
    modelFile: manifest?.weightsFile || '',
    entrypoint: home,
    message: manifest?.message || (ready
      ? `Bundled official RMBG model detected in the GS Bot ${process.platform === 'darwin' ? 'macOS' : 'Windows'} runtime directory.`
      : `Bundled RMBG model files are incomplete in the GS Bot ${process.platform === 'darwin' ? 'macOS' : 'Windows'} runtime directory.`),
    hint: manifest?.hint || '',
  };
}

function getBundledPythonRuntime() {
  const runtimeRoot = getWindowsRuntimeRoot();
  if (!runtimeRoot) {
    return null;
  }

  const home = path.join(runtimeRoot, 'python');
  const command = path.join(home, 'python.exe');
  if (!fileExists(command)) {
    return null;
  }

  const manifest = readJsonIfExists(path.join(home, 'runtime-manifest.json'));
  const versionSuffix = manifest?.version ? ` ${manifest.version}` : '';

  return {
    source: 'bundled',
    command,
    args: [],
    home,
    label: `Bundled Python${versionSuffix}`.trim(),
    version: manifest?.version || '',
    torchFlavor: manifest?.torchFlavor || 'cpu',
  };
}

function getSystemPythonCandidates() {
  if (process.platform === 'win32') {
    return [
      { command: 'py', args: ['-3'] },
      { command: 'python', args: [] },
      { command: 'python3', args: [] },
    ];
  }

  return [
    { command: 'python3', args: [] },
    { command: 'python', args: [] },
  ];
}

function describeRuntime(runtime) {
  if (!runtime) {
    return '';
  }

  return runtime.label || [runtime.command, ...(runtime.args || [])].join(' ').trim();
}

function findPythonRuntime(options = {}) {
  const cacheKey = process.platform;
  if (!options.forceRefresh && pythonCache.has(cacheKey)) {
    return pythonCache.get(cacheKey);
  }

  let runtime = null;
  const bundledRuntime = getBundledPythonRuntime();
  if (bundledRuntime && !options.preferSystem) {
    runtime = bundledRuntime;
  } else {
    for (const candidate of getSystemPythonCandidates()) {
      try {
        const result = spawnSync(candidate.command, [...candidate.args, '--version'], {
          encoding: 'utf8',
          timeout: 5000,
          windowsHide: true,
        });

        if (result.status === 0) {
          runtime = {
            source: 'system',
            command: candidate.command,
            args: candidate.args,
            home: '',
            label: [candidate.command, ...candidate.args].join(' ').trim(),
            version: (result.stdout || result.stderr || '').trim(),
          };
          break;
        }
      } catch {}
    }

    if (!runtime && bundledRuntime && options.preferSystem) {
      runtime = bundledRuntime;
    }
  }

  pythonCache.set(cacheKey, runtime);
  return runtime;
}

function getPythonSpawnEnv(runtime) {
  const env = {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  };

  const pythonVendorDir = isPackagedApp()
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'python_vendor')
    : path.join(__dirname, 'python_vendor');

  if (runtime?.source === 'bundled' && runtime.home) {
    const libDir = path.join(runtime.home, 'Lib');
    const sitePackagesDir = path.join(libDir, 'site-packages');
    env.PYTHONHOME = runtime.home;
    env.PYTHONPATH = [pythonVendorDir, libDir, sitePackagesDir, process.env.PYTHONPATH]
      .filter(Boolean)
      .join(path.delimiter);
  } else {
    env.PYTHONPATH = [pythonVendorDir, process.env.PYTHONPATH]
      .filter(Boolean)
      .join(path.delimiter);
  }

  return env;
}

function getBundledChromeExecutable() {
  const runtimeRoot = getWindowsRuntimeRoot();
  if (!runtimeRoot) {
    return null;
  }

  const manifest = readJsonIfExists(path.join(runtimeRoot, 'chromium', 'runtime-manifest.json'));
  const relativeExecutable = manifest?.executable || path.join('chrome-win64', 'chrome.exe');
  const executablePath = path.join(runtimeRoot, 'chromium', relativeExecutable);

  return fileExists(executablePath) ? executablePath : null;
}

function getDownloadedChromeHome() {
  return path.join(os.homedir(), '.gsbot', 'browser', 'chrome');
}

function getDownloadedChromeExecutable() {
  const home = getDownloadedChromeHome();
  if (!fileExists(home)) {
    return null;
  }

  if (process.platform === 'darwin') {
    const executable = path.join(
      home,
      'chrome-mac-arm64',
      'Google Chrome for Testing.app',
      'Contents',
      'MacOS',
      'Google Chrome for Testing',
    );
    if (fileExists(executable)) {
      return executable;
    }

    const intelExecutable = path.join(
      home,
      'chrome-mac-x64',
      'Google Chrome for Testing.app',
      'Contents',
      'MacOS',
      'Google Chrome for Testing',
    );
    return fileExists(intelExecutable) ? intelExecutable : null;
  }

  if (process.platform === 'win32') {
    const executable = path.join(home, 'chrome-win64', 'chrome.exe');
    return fileExists(executable) ? executable : null;
  }

  const linuxExecutable = path.join(home, 'chrome-linux64', 'chrome');
  return fileExists(linuxExecutable) ? linuxExecutable : null;
}

function getBundledPaddleVlRuntimeStatus() {
  const runtimeRoot = getWindowsRuntimeRoot();
  if (!runtimeRoot) {
    return null;
  }

  const home = path.join(runtimeRoot, 'paddleocr-vl');
  const manifest = getBundledWindowsRuntimeManifest('paddleocr-vl');
  const entrypoint = manifest?.entrypoint ? path.join(home, manifest.entrypoint) : '';

  return {
    bundled: Boolean(manifest?.bundled),
    downloaded: false,
    ready: Boolean(manifest?.ready),
    home,
    model: manifest?.model || 'paddleocr-vl-1.5',
    provider: manifest?.provider || '',
    baseUrl: manifest?.baseUrl || '',
    modelFile: manifest?.modelFile || '',
    mmprojFile: manifest?.mmprojFile || '',
    host: manifest?.host || '127.0.0.1',
    port: manifest?.port || 18080,
    chatTemplate: manifest?.chatTemplate || '',
    ctxSize: manifest?.ctxSize || 8192,
    nGpuLayers: manifest?.nGpuLayers ?? 0,
    serverArgs: Array.isArray(manifest?.serverArgs) ? manifest.serverArgs : [],
    entrypoint: entrypoint && fileExists(entrypoint) ? entrypoint : '',
    message: manifest?.message || '',
    hint: manifest?.hint || '',
  };
}

function getDownloadedPaddleVlHome() {
  if (process.platform !== 'win32') {
    return null;
  }

  return path.join(os.homedir(), '.gsbot', 'ocr-models', 'paddleocr-vl');
}

function findPaddleVlRuntimeHomes() {
  if (process.platform !== 'win32') {
    return [];
  }

  const ocrModelsHome = path.join(os.homedir(), '.gsbot', 'ocr-models');
  if (!fileExists(ocrModelsHome)) {
    return [];
  }

  try {
    const entries = fs.readdirSync(ocrModelsHome, { withFileTypes: true });
    const homes = entries
      .filter((entry) => entry.isDirectory() && /^paddleocr-vl/i.test(entry.name))
      .map((entry) => path.join(ocrModelsHome, entry.name))
      .sort((a, b) => {
        // Prefer the most recently generated manifest (newest download first)
        const ma = readJsonIfExists(path.join(a, 'runtime-manifest.json')) || {};
        const mb = readJsonIfExists(path.join(b, 'runtime-manifest.json')) || {};
        const ta = ma.generatedAt || '';
        const tb = mb.generatedAt || '';
        if (ta < tb) return 1;
        if (ta > tb) return -1;
        return 0;
      });
    return homes;
  } catch {
    return [];
  }
}

function findFirstMatchingFile(rootDir, matcher, depth = 4) {
  if (!fileExists(rootDir) || depth < 0) {
    return '';
  }

  let entries = [];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return '';
  }

  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isFile() && matcher(entry.name, entryPath)) {
      return entryPath;
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const nested = findFirstMatchingFile(path.join(rootDir, entry.name), matcher, depth - 1);
    if (nested) {
      return nested;
    }
  }

  return '';
}

function getDownloadedPaddleVlRuntimeStatus(home) {
  const resolvedHome = home || getDownloadedPaddleVlHome();
  if (!resolvedHome || !fileExists(resolvedHome)) {
    return null;
  }

  const manifest = readJsonIfExists(path.join(resolvedHome, 'runtime-manifest.json')) || {};
  const modelFileName = manifest.modelFile || 'PaddleOCR-VL-1.5.gguf';
  const mmprojFileName = manifest.mmprojFile || 'PaddleOCR-VL-1.5-mmproj.gguf';
  const chatTemplateFileName = manifest.chatTemplate || 'chat_template.jinja';

  const modelPath = findFirstMatchingFile(
    resolvedHome,
    (name) => name.toLowerCase() === modelFileName.toLowerCase(),
  );
  const mmprojPath = findFirstMatchingFile(
    resolvedHome,
    (name) => name.toLowerCase() === mmprojFileName.toLowerCase(),
  );
  const chatTemplatePath = findFirstMatchingFile(
    resolvedHome,
    (name) => name.toLowerCase() === chatTemplateFileName.toLowerCase(),
  );
  const entrypointPath = manifest?.entrypoint
    ? path.join(resolvedHome, manifest.entrypoint)
    : findFirstMatchingFile(resolvedHome, (name) => /^llama-server\.exe$/i.test(name), 6);

  const ready = Boolean(modelPath && mmprojPath && entrypointPath);
  const entrypoint = entrypointPath && fileExists(entrypointPath) ? entrypointPath : '';

  return {
    bundled: false,
    downloaded: true,
    ready,
    home: resolvedHome,
    model: manifest?.model || 'paddleocr-vl-1.5',
    provider: manifest?.provider || 'openai',
    baseUrl: manifest?.baseUrl || '',
    modelFile: modelPath ? path.relative(resolvedHome, modelPath) : '',
    mmprojFile: mmprojPath ? path.relative(resolvedHome, mmprojPath) : '',
    host: manifest?.host || '127.0.0.1',
    port: manifest?.port || 18080,
    chatTemplate: chatTemplatePath ? path.relative(resolvedHome, chatTemplatePath) : '',
    ctxSize: manifest?.ctxSize || 8192,
    nGpuLayers: manifest?.nGpuLayers ?? 0,
    serverArgs: Array.isArray(manifest?.serverArgs) ? manifest.serverArgs : [],
    entrypoint,
    message: ready
      ? 'Downloaded PaddleOCR-VL runtime detected in the GS Bot OCR model directory.'
      : 'Downloaded PaddleOCR-VL files are incomplete. Expected the GGUF model, mmproj, and llama-server.exe in the GS Bot OCR model directory.',
    hint: ready
      ? ''
      : 'Place the extracted PaddleOCR-VL runtime in ~/.gsbot/ocr-models/paddleocr-vl to enable automatic use.',
  };
}

function getPaddleVlRuntimeStatus() {
  const homes = findPaddleVlRuntimeHomes();

  // Try ready downloaded homes first, ordered by newest manifest
  for (const home of homes) {
    const status = getDownloadedPaddleVlRuntimeStatus(home);
    if (status?.ready) {
      return status;
    }
  }

  const bundled = getBundledPaddleVlRuntimeStatus();
  if (bundled?.ready) {
    return bundled;
  }

  // If nothing is ready, return the first downloaded home status so the
  // caller can show the missing-files message / hint.
  for (const home of homes) {
    const status = getDownloadedPaddleVlRuntimeStatus(home);
    if (status) {
      return status;
    }
  }

  return bundled || null;
}

function getDownloadedRmbgHome() {
  return path.join(os.homedir(), '.gsbot', 'cutout-models', 'rmbg-2.0');
}

function getRmbgRuntimeStatus() {
  const bundled = getBundledRmbgRuntimeStatus();
  if (bundled?.ready) {
    return bundled;
  }

  const home = getDownloadedRmbgHome();
  if (!home || !fileExists(home)) {
    return bundled || {
      bundled: false,
      downloaded: false,
      ready: false,
      home: home || '',
      model: 'RMBG-2.0',
      modelFile: '',
      entrypoint: '',
      message: 'RMBG 2.0 model is not installed yet.',
      hint: 'Import the official RMBG 2.0 model folder into ~/.gsbot/cutout-models/rmbg-2.0 from GS Bot.',
    };
  }

  const manifest = readJsonIfExists(path.join(home, 'runtime-manifest.json')) || {};
  const configPath = manifest?.configFile
    ? path.join(home, manifest.configFile)
    : findFirstMatchingFile(home, (name) => /^config\.json$/i.test(name), 4);
  const remoteCodePath = manifest?.remoteCodeFile
    ? path.join(home, manifest.remoteCodeFile)
    : findFirstMatchingFile(home, (name) => /^birefnet\.py$/i.test(name), 4);
  const ready = Boolean(
    configPath && fileExists(configPath)
    && remoteCodePath && fileExists(remoteCodePath),
  );

  return {
    bundled: false,
    downloaded: ready,
    ready,
    home,
    model: manifest?.model || 'RMBG-2.0',
    modelFile: configPath ? path.relative(home, configPath) : '',
    entrypoint: home,
    message: ready
      ? 'Downloaded official RMBG model detected in the GS Bot cutout model directory.'
      : 'RMBG model files are incomplete. Expected config.json and remote model code in the GS Bot cutout model directory.',
    hint: ready
      ? ''
      : 'Import the official RMBG 2.0 model folder into ~/.gsbot/cutout-models/rmbg-2.0 from GS Bot.',
  };
}

function getSystemChromeCandidates() {
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }

  if (process.platform === 'win32') {
    return [...new Set([
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env.PROGRAMFILES || '', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google\\Chrome\\Application\\chrome.exe'),
    ])].filter(Boolean);
  }

  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
  ];
}

// ── Microsoft Edge ───────────────────────────────────────────────────────────
// Edge 与 Chrome 同为 Chromium 内核，puppeteer-core 可直接驱动，
// 且 msedge.exe 的 ProductVersion 格式与 chrome.exe 一致 ——
// 所以 main.js 的 getChromeMajorVersion() / session 目录版本化对它同样适用。
//
// ⚠️ Edge 的真实 User-Agent 带 `Edg/<ver>` 后缀。这本身不是问题（真实 Edge
// 用户也能访问目标站点），但绝不能再由 UA 池覆写 —— 「Edge 二进制 + Chrome UA」
// 自相矛盾会被 Akamai 直接拦。现有 antiDetection.applyRetailBrowsingProfile()
// 只 patch webdriver/chrome/langs/permissions、不碰 UA，所以这条约束已满足。
function getSystemEdgeCandidates() {
  if (process.platform === 'darwin') {
    return [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
  }

  if (process.platform === 'win32') {
    return [...new Set([
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(process.env.PROGRAMFILES || '', 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft\\Edge\\Application\\msedge.exe'),
    ])].filter(Boolean);
  }

  return [
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
    '/opt/microsoft/msedge/msedge',
  ];
}

/**
 * 统一浏览器可执行文件解析入口（Chrome / Edge / 内置 Chromium）。
 *
 * 优先级（前面的先赢）：
 *   1. 用户手填绝对路径（按 preference 取对应字段；手填路径不参与缓存）
 *   2. 按 preference 指定的来源：chrome → Edge 兜底 / edge → Chrome 兜底 / bundled
 *   3. auto：downloaded → bundled(win) → 系统 Chrome → 系统 Edge
 *
 * 与 findChromeExecutable() 的关系：后者保留原语义（只认 Chrome，
 * 供既有调用点在不改行为的前提下继续使用）；本函数是新增的、
 * 感知浏览器品牌与用户配置的入口。
 *
 * @param {object} options
 * @param {'auto'|'chrome'|'edge'|'bundled'} [options.preference]
 * @param {string} [options.customPath]   用户手填路径（优先于 preference 探测）
 * @param {boolean} [options.forceRefresh] 忽略缓存
 * @returns {string|null}
 */
function findBrowserExecutable(options = {}) {
  const preference = options.preference || 'auto';

  // 1) 用户手填路径最优先 —— 支持绿色版/便携版/非标准安装位置。
  //    不写入缓存：用户改配置后应立即生效。
  const customPath = String(options.customPath || '').trim();
  if (customPath && fileExists(customPath)) {
    return customPath;
  }

  const cacheKey = process.platform + '|' + preference;
  if (!options.forceRefresh && chromeCache.has(cacheKey)) {
    return chromeCache.get(cacheKey);
  }

  const chromeInstalled = () => {
    for (const candidate of getSystemChromeCandidates()) {
      if (fileExists(candidate)) return candidate;
    }
    return null;
  };

  const edgeInstalled = () => {
    for (const candidate of getSystemEdgeCandidates()) {
      if (fileExists(candidate)) return candidate;
    }
    return null;
  };

  const bundled = () => {
    const downloaded = getDownloadedChromeExecutable();
    if (downloaded) return downloaded;
    if (process.platform === 'win32') return getBundledChromeExecutable();
    return null;
  };

  let executablePath = null;
  // Track WHICH branch produced the winner. Brand alone cannot answer "is this
  // the browser we ship?" — the bundled Chromium is literally named chrome.exe,
  // so name-matching would misreport the app's own browser as a real Chrome.
  // "bundled" must be known by provenance, not by filename.
  let source = 'none';

  if (preference === 'chrome') {
    // 用户明确要 Chrome：先找 Chrome，找不到再退到内置包，最后才考虑 Edge
    // （退到 Edge 而不是直接失败 —— 否则只装 Edge 的机器会彻底不可用）。
    executablePath = chromeInstalled();
    if (executablePath) source = 'system-chrome';
    else {
      executablePath = bundled();
      if (executablePath) source = 'bundled';
      else {
        executablePath = edgeInstalled();
        if (executablePath) source = 'system-edge';
      }
    }
  } else if (preference === 'edge') {
    executablePath = edgeInstalled();
    if (executablePath) source = 'system-edge';
    else {
      executablePath = chromeInstalled();
      if (executablePath) source = 'system-chrome';
      else {
        executablePath = bundled();
        if (executablePath) source = 'bundled';
      }
    }
  } else if (preference === 'bundled') {
    executablePath = bundled();
    if (executablePath) source = 'bundled';
    else {
      executablePath = chromeInstalled();
      if (executablePath) source = 'system-chrome';
      else {
        executablePath = edgeInstalled();
        if (executablePath) source = 'system-edge';
      }
    }
  } else {
    // auto：内置包优先（版本可控、行为最可预期），其次系统 Chrome，最后 Edge
    executablePath = bundled();
    if (executablePath) source = 'bundled';
    else {
      executablePath = chromeInstalled();
      if (executablePath) source = 'system-chrome';
      else {
        executablePath = edgeInstalled();
        if (executablePath) source = 'system-edge';
      }
    }
  }

  chromeCache.set(cacheKey, executablePath || null);
  chromeCache.set(cacheKey + '|source', executablePath ? source : 'none');
  return executablePath || null;
}

/**
 * 报告当前解析到的浏览器信息，供设置页展示。
 */
function describeResolvedBrowser(options = {}) {
  const preference = options.preference || 'auto';
  const customPath = String(options.customPath || '').trim();
  const executablePath = findBrowserExecutable(options);

  let brand = 'unknown';
  if (executablePath) {
    const lower = executablePath.toLowerCase();
    if (/msedge/.test(lower)) brand = 'edge';
    else if (/chrome/.test(lower)) brand = 'chrome';
    else brand = 'chromium';
  }

  // Provenance, not filename. `source` is 'bundled' only when the winner came
  // out of the app's own runtime tree; a user-supplied path counts as custom.
  const cacheKey = process.platform + '|' + preference;
  let source = options.customPath && fileExists(customPath)
    ? 'custom'
    : (chromeCache.get(cacheKey + '|source') || 'none');

  return {
    preference,
    customPathUsed: !!(customPath && fileExists(customPath)),
    executablePath: executablePath || '',
    brand,
    source,
    // The browser H&M actually rejects. Derived from provenance so the app's
    // own Chromium (which ships as chrome.exe) is never mistaken for Chrome.
    isBundled: source === 'bundled',
    available: !!executablePath,
    chromeCandidates: getSystemChromeCandidates().filter(fileExists),
    edgeCandidates: getSystemEdgeCandidates().filter(fileExists),
  };
}

function findChromeExecutable(options = {}) {
  const cacheKey = process.platform;
  if (!options.forceRefresh && chromeCache.has(cacheKey)) {
    return chromeCache.get(cacheKey);
  }

  let executablePath = null;

  executablePath = getDownloadedChromeExecutable();

  if (!executablePath && process.platform === 'win32' && !options.preferSystem) {
    executablePath = getBundledChromeExecutable();
  }

  if (!executablePath) {
    for (const candidate of getSystemChromeCandidates()) {
      if (fileExists(candidate)) {
        executablePath = candidate;
        break;
      }
    }
  }

  if (!executablePath && process.platform === 'win32' && options.preferSystem) {
    executablePath = getBundledChromeExecutable();
  }

  chromeCache.set(cacheKey, executablePath || null);
  return executablePath || null;
}

module.exports = {
  getBundledFabricLabelDetectorStatus,
  getBundledRmbgRuntimeStatus,
  getBundledPaddleVlRuntimeStatus,
  getFabricLabelDetectorStatus,
  getDownloadedChromeHome,
  getDownloadedPaddleVlHome,
  findPaddleVlRuntimeHomes,
  getDownloadedRmbgHome,
  getPaddleVlRuntimeStatus,
  getRmbgRuntimeStatus,
  describeRuntime,
  findChromeExecutable,
  getSystemChromeCandidates,
  getSystemEdgeCandidates,
  findBrowserExecutable,
  describeResolvedBrowser,
  findPythonRuntime,
  getPythonSpawnEnv,
};

const path = require('path');
const fs = require('fs');
const os = require('os');

// ── Catalog ───────────────────────────────────────────────────────────
// Each entry describes a downloadable OCR model.
// `hfRepo` is the HuggingFace repo; files are resolved from hf.co.
// `runtimeRequired` indicates the runtime needed (llama-server for GGUF).
// Platforms: [] = all platforms.

const CATALOG = [
  {
    id: 'paddleocr-vl-1.6',
    name: 'PaddleOCR-VL 1.6',
    displayName: { en: 'PaddleOCR-VL 1.6', zh: 'PaddleOCR-VL 1.6' },
    type: 'gguf',
    engine: 'paddlevl-local',
    description: {
      en: 'Latest vision-language OCR for complex labels and documents. Uses llama.cpp server locally.',
      zh: '最新视觉语言 OCR，适合复杂标签和文档。本地运行 llama.cpp 服务器。',
    },
    platforms: ['win32', 'darwin', 'linux'],
    provider: 'paddleocr',
    hfRepo: 'PaddlePaddle/PaddleOCR-VL-1.6-GGUF',
    msRepo: 'PaddlePaddle/PaddleOCR-VL-1.6-GGUF',
    size: '~5.5 GB',
    files: [
      { name: 'PaddleOCR-VL-1.6-GGUF.gguf', localName: 'PaddleOCR-VL-1.6-GGUF.gguf', size: '~5 GB', required: true },
      { name: 'PaddleOCR-VL-1.6-GGUF-mmproj.gguf', localName: 'PaddleOCR-VL-1.6-GGUF-mmproj.gguf', size: '~500 MB', required: true },
      { name: 'chat_template.jinja', localName: 'chat_template.jinja', size: '<1 KB', required: true },
    ],
    runtimeRequired: 'llama-server',
    runtimeUrl: 'https://github.com/ggml-org/llama.cpp/releases/download/b8826/llama-b8826-bin-win-cpu-x64.zip',
    runtimeZipEntry: 'llama-server.exe',
    manifestTemplate: {
      type: 'paddleocr-vl-runtime',
      bundled: false,
      ready: true,
      provider: 'openai',
      model: 'paddleocr-vl-1.6',
      entrypoint: 'llama-server.exe',
      modelFile: 'PaddleOCR-VL-1.6-GGUF.gguf',
      mmprojFile: 'PaddleOCR-VL-1.6-GGUF-mmproj.gguf',
      chatTemplate: 'chat_template.jinja',
      host: '127.0.0.1',
      port: 18080,
      ctxSize: 8192,
      nGpuLayers: 0,
    },
  },
  {
    id: 'paddleocr-vl-1.5',
    name: 'PaddleOCR-VL 1.5',
    displayName: { en: 'PaddleOCR-VL 1.5', zh: 'PaddleOCR-VL 1.5' },
    type: 'gguf',
    engine: 'paddlevl-local',
    description: {
      en: 'Vision-language OCR for complex labels. Uses llama.cpp server locally.',
      zh: '视觉语言 OCR，适合复杂标签。本地运行 llama.cpp 服务器。',
    },
    platforms: ['win32', 'darwin', 'linux'],
    provider: 'paddleocr',
    hfRepo: 'PaddlePaddle/PaddleOCR-VL-1.5-GGUF',
    msRepo: 'PaddlePaddle/PaddleOCR-VL-1.5-GGUF',
    size: '~5.5 GB',
    files: [
      { name: 'PaddleOCR-VL-1.5.gguf', localName: 'PaddleOCR-VL-1.5.gguf', size: '~5 GB', required: true },
      { name: 'PaddleOCR-VL-1.5-mmproj.gguf', localName: 'PaddleOCR-VL-1.5-mmproj.gguf', size: '~500 MB', required: true },
      { name: 'chat_template.jinja', localName: 'chat_template.jinja', size: '<1 KB', required: true },
    ],
    runtimeRequired: 'llama-server',
    runtimeUrl: 'https://github.com/ggml-org/llama.cpp/releases/download/b8826/llama-b8826-bin-win-cpu-x64.zip',
    runtimeZipEntry: 'llama-server.exe',
    manifestTemplate: {
      type: 'paddleocr-vl-runtime',
      bundled: false,
      ready: true,
      provider: 'openai',
      model: 'paddleocr-vl-1.5',
      entrypoint: 'llama-server.exe',
      modelFile: 'PaddleOCR-VL-1.5.gguf',
      mmprojFile: 'PaddleOCR-VL-1.5-mmproj.gguf',
      chatTemplate: 'chat_template.jinja',
      host: '127.0.0.1',
      port: 18080,
      ctxSize: 8192,
      nGpuLayers: 0,
    },
  },
  {
    id: 'deepseek-ocr-gguf',
    name: 'DeepSeek OCR GGUF',
    displayName: { en: 'DeepSeek OCR GGUF', zh: 'DeepSeek OCR GGUF' },
    type: 'gguf',
    engine: 'deepseek-local-gguf',
    description: {
      en: 'DeepSeek OCR running locally via GGUF (Q8_0, ~3.1 GB). Requires a compatible llama.cpp runtime with deepseek2-ocr architecture support. On macOS use DeepSeek OCR via Ollama for easier setup.',
      zh: '本地运行 DeepSeek OCR (GGUF, Q8_0, ~3.1 GB)。需要支持 deepseek2-ocr 架构的 llama.cpp 运行时。macOS 建议通过 Ollama 安装以获得更简单的配置。',
    },
    platforms: ['win32', 'darwin'],
    provider: 'deepseek',
    hfRepo: 'ggml-org/DeepSeek-OCR-GGUF',
    msRepo: null,
    size: '~3.1 GB',
    files: [
      { name: 'DeepSeek-OCR-Q8_0.gguf', localName: 'DeepSeek-OCR-Q8_0.gguf', size: '~3.1 GB', required: true },
    ],
    runtimeRequired: null,
    runtimeUrl: null,
    runtimeZipEntry: null,
    manifestTemplate: {
      type: 'deepseek-ocr-runtime',
      bundled: false,
      ready: true,
      provider: 'deepseek',
      model: 'deepseek-ocr-gguf',
      entrypoint: '',
      modelFile: 'DeepSeek-OCR-Q8_0.gguf',
      host: '127.0.0.1',
      port: 18081,
      ctxSize: 4096,
      nGpuLayers: 0,
    },
  },
];

// ── Paths ─────────────────────────────────────────────────────────────

function getOcrModelsHome() {
  return path.join(os.homedir(), '.gsbot', 'ocr-models');
}

function getModelHome(modelId) {
  return path.join(getOcrModelsHome(), modelId);
}

// ── Catalog helpers ───────────────────────────────────────────────────

function getCatalog() {
  return CATALOG;
}

function getCatalogEntry(modelId) {
  return CATALOG.find((entry) => entry.id === modelId) || null;
}

function getDownloadUrl(entry, fileName) {
  if (!entry || !entry.hfRepo || !fileName) return '';
  return `https://huggingface.co/${entry.hfRepo}/resolve/main/${encodeURIComponent(fileName)}?download=true`;
}

function isPlatformSupported(entry, platform = process.platform) {
  if (!entry) return false;
  if (!entry.platforms || entry.platforms.length === 0) return true;
  return entry.platforms.includes(platform);
}

// ── Local status ──────────────────────────────────────────────────────

function readManifest(modelHome) {
  try {
    const manifestPath = path.join(modelHome, 'runtime-manifest.json');
    if (!fs.existsSync(manifestPath)) return null;
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

function writeManifest(modelHome, payload) {
  const manifestPath = path.join(modelHome, 'runtime-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ ...payload, generatedAt: new Date().toISOString() }, null, 2));
}

function getLocalStatus(entry) {
  if (!entry) return { installed: false, ready: false, home: '', files: [], manifest: null };
  const home = getModelHome(entry.id);

  if (!fs.existsSync(home)) {
    return { installed: false, ready: false, home, files: [], manifest: null };
  }

  const manifest = readManifest(home);
  const files = [];

  for (const f of (entry.files || [])) {
    const localName = f.localName || f.name;
    const filePath = path.join(home, localName);
    const exists = fs.existsSync(filePath);
    files.push({ name: localName, path: filePath, exists, required: f.required, size: f.size });
  }

  const allRequiredPresent = files.filter((f) => f.required).every((f) => f.exists);

  return {
    installed: files.length > 0 && files.some((f) => f.exists),
    ready: allRequiredPresent && Boolean(manifest?.ready),
    home,
    files,
    manifest,
  };
}

function deleteModel(modelId) {
  const home = getModelHome(modelId);
  if (!fs.existsSync(home)) {
    return { success: false, error: 'Model not found.' };
  }
  try {
    fs.rmSync(home, { recursive: true, force: true });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── Catalog sync ──────────────────────────────────────────────────────

async function fetchHfRepoInfo(hfRepo) {
  try {
    const url = `https://huggingface.co/api/models/${encodeURIComponent(hfRepo)}`;
    const response = await fetchWithTimeout(url, { timeoutMs: 15000 });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function fetchWithTimeout(url, options = {}) {
  const { timeoutMs = 30000, headers: extraHeaders = {} } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  return fetch(url, {
    signal: controller.signal,
    headers: {
      'User-Agent': 'GS-Bot/1.0',
      Accept: 'application/json',
      ...extraHeaders,
    },
  }).finally(() => clearTimeout(timeout));
}

async function syncCatalog(options = {}) {
  const { online = true, platform = process.platform } = options;
  const models = [];

  for (const entry of CATALOG) {
    const localStatus = getLocalStatus(entry);
    let latestVersion = null;
    let syncError = null;

    if (online && entry.hfRepo) {
      try {
        const repoInfo = await fetchHfRepoInfo(entry.hfRepo);
        if (repoInfo) {
          latestVersion = {
            sha: repoInfo.sha || null,
            lastModified: repoInfo.lastModified || null,
            siblings: (repoInfo.siblings || []).map((s) => ({ name: s.rfilename, size: s.size })),
          };
        }
      } catch (err) {
        syncError = err.message;
      }
    }

    models.push({
      ...entry,
      supported: isPlatformSupported(entry, platform),
      installed: localStatus.installed,
      ready: localStatus.ready,
      home: localStatus.home,
      localFiles: localStatus.files,
      latestVersion,
      syncError,
    });
  }

  return {
    syncedAt: new Date().toISOString(),
    online,
    platform,
    models,
  };
}

function getCatalogForPlatform(platform = process.platform) {
  return CATALOG.filter((entry) => isPlatformSupported(entry, platform)).map((entry) => {
    const localStatus = getLocalStatus(entry);
    return {
      ...entry,
      supported: true,
      installed: localStatus.installed,
      ready: localStatus.ready,
      home: localStatus.home,
      localFiles: localStatus.files,
    };
  });
}

// ── Exports ───────────────────────────────────────────────────────────

module.exports = {
  getCatalog,
  getCatalogEntry,
  getCatalogForPlatform,
  getOcrModelsHome,
  getModelHome,
  getLocalStatus,
  getDownloadUrl,
  deleteModel,
  syncCatalog,
  fetchHfRepoInfo,
  readManifest,
  writeManifest,
  isPlatformSupported,
  CATALOG,
};

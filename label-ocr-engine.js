const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');
const sharp = require('sharp');
const { normalizeLabelOcrProfile } = require('./label-ocr-profile');
const LLMClient = require('./llm-client');
const llmConfigManager = require('./llm-config');
const runtimeResolver = require('./runtime-resolver');
const {
  buildDefaultOcrConfig,
  getDefaultOcrEngine,
  normalizeOcrEngineName,
  OCR_ENGINE_DEEPSEEK_LOCAL,
  OCR_ENGINE_PADDLE_VL_LOCAL,
  OCR_ENGINE_GUTEN,
  OCR_ENGINE_PADDLE_CLOUD,
} = require('./ocr-engine-config');

let gutenOcrPromise = null;
let enhancedOcrUnavailableReason = '';
let resolvedWorkerRuntime = null;
let persistentWorkerState = null;
let bundledPaddleVlServerState = null;
let ort = null;

try {
  ort = require('onnxruntime-node');
} catch {
  ort = null;
}

const DEFAULT_OCR_ENGINE = getDefaultOcrEngine();
const DEFAULT_FABRIC_LABEL_DETECTOR_CONFIDENCE = 0.1;
const DEFAULT_FABRIC_LABEL_DETECTOR_IMGSZ = 1280;
const DEFAULT_FABRIC_LABEL_DETECTOR_PADDING = 24;
const DEFAULT_FABRIC_LABEL_DETECTOR_MIN_WIDTH = 1400;
const DEFAULT_FABRIC_LABEL_DETECTOR_MIN_HEIGHT = 500;
const DEFAULT_FABRIC_LABEL_DETECTOR_MAX_CANDIDATES = 3;
const DEFAULT_FABRIC_LABEL_DETECTOR_MODEL_CANDIDATES = [];
const DEFAULT_FABRIC_LABEL_DETECTOR_ONNX_INPUT = 1024;

let fabricLabelDetectorSessionCache = {
  modelPath: '',
  session: null,
  inputName: 'images',
  outputName: 'output0',
};

function emitOcrDebugLog(message = '') {
  try {
    console.log(`[PaddleOCR-VL] ${String(message || '').trim()}`);
  } catch {
    // ignore logging failure
  }
}

function resolveOcrRuntimeConfig(options = {}) {
  const sharedConfig = llmConfigManager.mergeWithDefaults(llmConfigManager.loadConfig());
  const sharedOcr = buildDefaultOcrConfig();
  const mergedSharedOcr = {
    ...sharedOcr,
    ...((sharedConfig && sharedConfig.ocr) || {}),
    deepseekLocal: {
      ...sharedOcr.deepseekLocal,
      ...(((sharedConfig && sharedConfig.ocr) && sharedConfig.ocr.deepseekLocal) || {}),
    },
    paddleVlLocal: {
      ...sharedOcr.paddleVlLocal,
      ...(((sharedConfig && sharedConfig.ocr) && sharedConfig.ocr.paddleVlLocal) || {}),
    },
  };
  const primaryEngine = normalizeOcrEngineName(
    options.engine ?? options.ocrEngine ?? mergedSharedOcr.engine ?? DEFAULT_OCR_ENGINE,
  );
  const fallbackEngine = normalizeOcrEngineName(
    options.fallbackEngine ?? options.ocrFallbackEngine ?? mergedSharedOcr.fallbackEngine ?? '',
    { allowEmpty: true },
  );

  return {
    engine: primaryEngine,
    fallbackEngine: fallbackEngine && fallbackEngine !== primaryEngine ? fallbackEngine : '',
    deepseekLocal: {
      ...(mergedSharedOcr.deepseekLocal || {}),
      ...((options.deepseekLocal || options.ocrDeepseekLocal) || {}),
    },
    paddleVlLocal: {
      ...(mergedSharedOcr.paddleVlLocal || {}),
      ...((options.paddleVlLocal || options.ocrPaddleVlLocal) || {}),
    },
  };
}

function createImagePayloadFromPath(imagePath) {
  const buffer = fs.readFileSync(imagePath);
  const ext = path.extname(imagePath).toLowerCase();
  const mime = ext === '.png'
    ? 'image/png'
    : ext === '.webp'
      ? 'image/webp'
      : 'image/jpeg';

  return {
    mime,
    data: buffer.toString('base64'),
  };
}

async function runDeepseekLocalOcr(imagePath, options = {}, mode = 'label') {
  const runtimeConfig = resolveOcrRuntimeConfig(options);
  const engineConfig = runtimeConfig.deepseekLocal || {};
  const baseUrl = String(engineConfig.baseUrl || '').trim();
  const model = String(engineConfig.model || '').trim();
  const provider = String(engineConfig.provider || 'ollama').trim().toLowerCase() || 'ollama';
  const apiKey = String(engineConfig.apiKey || '').trim();

  console.log(`[OCR] DeepSeek config: enabled=${engineConfig.enabled}, baseUrl=${baseUrl}, model=${model}, provider=${provider}, apiKey=${apiKey ? `set(${apiKey.length}chars)` : 'NOT SET'}`);

  if (!engineConfig.enabled && !baseUrl && !model) {
    throw new Error('DeepSeek OCR local endpoint is not configured. Enable it in Settings or provide baseUrl and model.');
  }

  if (!baseUrl) {
    throw new Error('DeepSeek OCR local endpoint requires a base URL (e.g. http://localhost:11434).');
  }

  if (!model) {
    throw new Error('DeepSeek OCR local endpoint requires a model name (e.g. deepseek-ocr:3b).');
  }

  const payload = createImagePayloadFromPath(imagePath);
  const profile = normalizeLabelOcrProfile(options.profile);
  console.log(`[OCR] DeepSeek: connecting to ${baseUrl} with model=${model} provider=${provider}`);
  const client = new LLMClient({
    baseUrl,
    model,
    apiKey,
    provider,
    timeout: options.timeoutMs || 120000,
  });

  const prompt = mode === 'label'
    ? `You are DeepSeek OCR V2 running locally for apparel label transcription.

Transcribe every visible character from this label image as faithfully as possible.

Rules:
- Output plain text only.
- Preserve line breaks where helpful.
- Keep decimals, slashes, quotes, hyphens, fractions, and units exactly when visible.
- Do not summarize, translate, or explain.
- If some characters are uncertain, return your best literal reading instead of omitting the whole line.

Preferred characters on this label:
${profile.whitelist || 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_/.:;%(),\'" '}
`
    : `You are DeepSeek OCR V2 running locally for document and garment text extraction.

Transcribe all visible text from the image.

Rules:
- Output plain text only.
- Preserve useful line breaks.
- Keep punctuation, decimals, and units exactly when visible.
- Do not summarize or explain.`;

  const rawText = await client.generateWithImages(
    prompt,
    [payload],
    {
      temperature: 0.05,
      maxTokens: mode === 'label' ? 900 : 1400,
      model,
    },
  );

  return {
    engine: OCR_ENGINE_DEEPSEEK_LOCAL,
    rawText: mode === 'label'
      ? sanitizeByWhitelist(String(rawText || ''), profile.whitelist)
      : String(rawText || '').trim(),
    lines: [],
  };
}

async function runPaddleVlLocalOcr(imagePath, options = {}, mode = 'label') {
  const runtimeConfig = resolveOcrRuntimeConfig(options);
  const engineConfig = await resolvePaddleVlRuntimeConfig(runtimeConfig.paddleVlLocal || {});
  const baseUrl = String(engineConfig.baseUrl || '').trim();
  const model = String(engineConfig.model || '').trim();
  const provider = String(engineConfig.provider || 'openai').trim().toLowerCase() || 'openai';

  const payload = createImagePayloadFromPath(imagePath);
  const profile = normalizeLabelOcrProfile(options.profile);
  const client = new LLMClient({
    baseUrl,
    model,
    apiKey: String(engineConfig.apiKey || '').trim(),
    provider,
    timeout: options.timeoutMs || 120000,
  });

  const prompt = mode === 'label'
    ? `You are PaddleOCR-VL 1.5 running locally for apparel label transcription.

Transcribe every visible character from this label image as faithfully as possible.

Rules:
- Output plain text only.
- Preserve useful line breaks.
- Keep decimals, slashes, quotes, hyphens, fractions, percentages, and units exactly when visible.
- Do not summarize, translate, normalize, or explain.
- If some characters are uncertain, return your best literal reading instead of omitting the whole line.

Preferred characters on this label:
${profile.whitelist || 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_/.:;%(),\'" '}
`
    : `You are PaddleOCR-VL 1.5 running locally for document and garment text extraction.

Transcribe all visible text from the image.

Rules:
- Output plain text only.
- Preserve useful line breaks.
- Keep punctuation, decimals, and units exactly when visible.
- Do not summarize, translate, or explain.`;

  const rawText = await client.generateWithImages(
    prompt,
    [payload],
    {
      temperature: 0.05,
      maxTokens: mode === 'label' ? 900 : 1400,
      model,
    },
  );

  return {
    engine: OCR_ENGINE_PADDLE_VL_LOCAL,
    rawText: mode === 'label'
      ? sanitizeByWhitelist(String(rawText || ''), profile.whitelist)
      : String(rawText || '').trim(),
    lines: [],
  };
}

function getPaddleVlRuntimeStatus() {
  try {
    return runtimeResolver.getPaddleVlRuntimeStatus?.()
      || runtimeResolver.getBundledPaddleVlRuntimeStatus?.()
      || null;
  } catch {
    return null;
  }
}

function buildBundledPaddleVlBaseUrl(status) {
  const host = String(status?.host || '127.0.0.1').trim() || '127.0.0.1';
  const port = Number(status?.port) || 18080;
  return `http://${host}:${port}`;
}

function resolvePreferredPaddleVlGpuLayers(status = {}, engineConfig = {}) {
  const explicit = Number(
    engineConfig.nGpuLayers
      ?? engineConfig.ngl
      ?? status.nGpuLayers,
  );
  if (Number.isFinite(explicit) && explicit >= 0) {
    return explicit;
  }

  if (process.platform === 'darwin' && process.arch === 'arm64') {
    return 999;
  }

  if (process.platform === 'win32') {
    return 20;
  }

  return 0;
}

function waitForBundledPaddleVlServer(baseUrl, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;

  return new Promise((resolve, reject) => {
    const attempt = () => {
      const client = new LLMClient({
        baseUrl,
        model: 'paddleocr-vl-1.5',
        provider: 'openai',
        timeout: 5000,
      });

      client.testConnection()
        .then((result) => {
          if (result?.success) {
            resolve();
            return;
          }

          if (Date.now() >= deadline) {
            reject(new Error(result?.error || 'Timed out waiting for bundled PaddleOCR-VL server.'));
            return;
          }

          setTimeout(attempt, 1500);
        })
        .catch((error) => {
          if (Date.now() >= deadline) {
            reject(error);
            return;
          }

          setTimeout(attempt, 1500);
        });
    };

    attempt();
  });
}

async function ensureBundledPaddleVlServer(engineConfig = {}) {
  const status = getPaddleVlRuntimeStatus();
  if (!status?.ready || !status?.entrypoint) {
    throw new Error(status?.message || status?.hint || 'Bundled PaddleOCR-VL runtime is not ready.');
  }

  const baseUrl = buildBundledPaddleVlBaseUrl(status);
  const preferredGpuLayers = resolvePreferredPaddleVlGpuLayers(status, engineConfig);
  emitOcrDebugLog(`Preparing runtime (preferred GPU layers: ${preferredGpuLayers}).`);

  if (
    bundledPaddleVlServerState?.baseUrl === baseUrl
    && bundledPaddleVlServerState?.child
    && !bundledPaddleVlServerState.child.killed
    && Number(bundledPaddleVlServerState.nGpuLayers) === Number(preferredGpuLayers)
  ) {
    await waitForBundledPaddleVlServer(baseUrl, 5000).catch(() => {});
    return {
      baseUrl,
      model: status.model || 'paddleocr-vl-1.5',
      provider: status.provider || 'openai',
    };
  }

  const modelPath = status.modelFile ? path.join(status.home, status.modelFile) : '';
  const mmprojPath = status.mmprojFile ? path.join(status.home, status.mmprojFile) : '';
  const chatTemplatePath = status.chatTemplate ? path.join(status.home, status.chatTemplate) : '';

  if (!modelPath || !fs.existsSync(modelPath)) {
    throw new Error('Bundled PaddleOCR-VL runtime is missing the main GGUF model file.');
  }

  const buildSpawnArgs = (nGpuLayers) => {
    const spawnArgs = [
      '-m', modelPath,
      '--host', String(status.host || '127.0.0.1'),
      '--port', String(Number(status.port) || 18080),
      '--ctx-size', String(Number(status.ctxSize) || 8192),
      '--jinja',
    ];

    if (mmprojPath && fs.existsSync(mmprojPath)) {
      spawnArgs.push('--mmproj', mmprojPath);
    }

    if (chatTemplatePath && fs.existsSync(chatTemplatePath)) {
      spawnArgs.push('--chat-template-file', chatTemplatePath);
    }

    if (Number.isFinite(nGpuLayers)) {
      spawnArgs.push('-ngl', String(nGpuLayers));
    }

    if (Array.isArray(status.serverArgs) && status.serverArgs.length > 0) {
      spawnArgs.push(...status.serverArgs.map((value) => String(value)));
    }

    return spawnArgs;
  };

  const startServer = async (nGpuLayers, timeoutMs) => {
    emitOcrDebugLog(`Starting bundled server with nGpuLayers=${nGpuLayers}.`);
    const child = spawn(status.entrypoint, buildSpawnArgs(nGpuLayers), {
      cwd: status.home,
      windowsHide: true,
      stdio: 'ignore',
    });

    bundledPaddleVlServerState = {
      child,
      baseUrl,
      nGpuLayers,
    };

    child.once('exit', () => {
      if (bundledPaddleVlServerState?.child === child) {
        bundledPaddleVlServerState = null;
      }
    });

    await waitForBundledPaddleVlServer(baseUrl, timeoutMs);
    emitOcrDebugLog(`Server is ready with nGpuLayers=${nGpuLayers}.`);
    return child;
  };

  try {
    await startServer(preferredGpuLayers, preferredGpuLayers > 0 ? 20000 : 120000);
  } catch (gpuError) {
    try {
      bundledPaddleVlServerState?.child?.kill?.();
    } catch {
      // ignore cleanup failure
    }
    bundledPaddleVlServerState = null;

    if (preferredGpuLayers > 0) {
      emitOcrDebugLog(`GPU startup failed (${gpuError.message}). Falling back to CPU mode.`);
      await startServer(0, 120000);
    } else {
      throw gpuError;
    }
  }

  return {
    baseUrl,
    model: status.model || 'paddleocr-vl-1.5',
    provider: status.provider || 'openai',
  };
}

async function resolvePaddleVlRuntimeConfig(engineConfig = {}) {
  const baseUrl = String(engineConfig.baseUrl || '').trim();
  const model = String(engineConfig.model || '').trim();

  if (baseUrl && model) {
    return {
      ...engineConfig,
      baseUrl,
      model,
      provider: String(engineConfig.provider || 'openai').trim().toLowerCase() || 'openai',
    };
  }

  const bundled = await ensureBundledPaddleVlServer(engineConfig);
  return {
    ...engineConfig,
    enabled: true,
    provider: bundled.provider,
    baseUrl: bundled.baseUrl,
    model: bundled.model,
  };
}

function resolveModelPaths() {
  const nodeEntry = require.resolve('@gutenye/ocr-models/node');
  const packageDir = path.dirname(nodeEntry);
  const resourcesPath = process.resourcesPath || '';
  const unpackedPackageDir = packageDir.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  const assetDirCandidates = [
    resourcesPath ? path.join(resourcesPath, 'app.asar.unpacked', 'node_modules', '@gutenye', 'ocr-models', 'assets') : '',
    resourcesPath ? path.join(resourcesPath, 'node_modules', '@gutenye', 'ocr-models', 'assets') : '',
    path.join(unpackedPackageDir, 'assets'),
    path.join(packageDir, 'assets'),
  ].filter(Boolean);

  const assetDir = assetDirCandidates.find((candidate) => {
    try {
      return fs.existsSync(path.join(candidate, 'ch_PP-OCRv4_det_infer.onnx'))
        && fs.existsSync(path.join(candidate, 'ch_PP-OCRv4_rec_infer.onnx'))
        && fs.existsSync(path.join(candidate, 'ppocr_keys_v1.txt'));
    } catch {
      return false;
    }
  });
  if (!assetDir) {
    throw new Error(`OCR model assets not found. Tried: ${assetDirCandidates.join(', ')}`);
  }

  return {
    detectionPath: path.join(assetDir, 'ch_PP-OCRv4_det_infer.onnx'),
    recognitionPath: path.join(assetDir, 'ch_PP-OCRv4_rec_infer.onnx'),
    dictionaryPath: path.join(assetDir, 'ppocr_keys_v1.txt'),
  };
}

function sanitizeByWhitelist(text = '', whitelist = '') {
  const allowed = new Set(String(whitelist || '').split(''));
  if (allowed.size === 0) {
    return String(text || '');
  }

  return String(text || '')
    .split('')
    .map((char) => {
      if (char === '\n' || char === '\r' || char === '\t' || char === ' ') {
        return char;
      }
      return allowed.has(char) ? char : ' ';
    })
    .join('')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}


function isBadExtractAreaError(error) {
  return /extract_area:\s*bad extract area/i.test(String(error?.message || error || ''));
}

async function createNormalizedOcrRetryImage(imagePath) {
  const tempPath = path.join(
    os.tmpdir(),
    `gsbot-ocr-retry-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}.png`,
  );

  await sharp(imagePath)
    .rotate()
    .flatten({ background: '#ffffff' })
    .png()
    .toFile(tempPath);

  return tempPath;
}

async function detectLinesWithRetry(ocr, imagePath) {
  try {
    return await ocr.detect(imagePath);
  } catch (error) {
    if (!isBadExtractAreaError(error)) {
      throw error;
    }

    const retryImagePath = await createNormalizedOcrRetryImage(imagePath);
    try {
      return await ocr.detect(retryImagePath);
    } finally {
      try {
        fs.unlinkSync(retryImagePath);
      } catch {
        // Best effort cleanup only.
      }
    }
  }
}

function buildRawTextFromLines(lines = []) {
  return (Array.isArray(lines) ? lines : [])
    .map((line) => String(line?.text || '').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function resolveEnhancedOcrCreateOptions() {
  const baseOptions = {
    models: resolveModelPaths(),
  };

  if (process.platform === 'win32') {
    return {
      ...baseOptions,
      onnxOptions: {
        executionProviders: ['cpu'],
      },
    };
  }

  return baseOptions;
}

async function getGutenOcr() {
  if (!gutenOcrPromise) {
    gutenOcrPromise = (async () => {
      const mod = await import('@gutenye/ocr-node');
      const Ocr = mod.default;
      return Ocr.create(resolveEnhancedOcrCreateOptions());
    })();
  }

  return gutenOcrPromise;
}

function normalizeWorkerFailureReason(reason = '', code = null, signal = null) {
  const fallback = `exit code ${code}${signal ? `, signal ${signal}` : ''}`;
  return String(reason || '').trim() || fallback;
}

function isFatalEnhancedOcrFailure(reason = '', code = null, signal = null) {
  const normalized = normalizeWorkerFailureReason(reason, code, signal);
  return Boolean(
    signal
    || code === 133
    || /sigtrap|abort trap|illegal instruction|segmentation fault/i.test(normalized)
    || /cannot find module/i.test(normalized)
    || /unable to resolve label-ocr-engine/i.test(normalized)
    || /ocr model assets not found/i.test(normalized)
    || /dll initialization routine failed/i.test(normalized)
    || /dynamic link library.*failed/i.test(normalized)
    || /onnxruntime_binding\.node/i.test(normalized)
  );
}

function markEnhancedOcrUnavailable(reason = '') {
  if (!enhancedOcrUnavailableReason) {
    enhancedOcrUnavailableReason = String(reason || 'unknown error').trim();
  }
}

async function runEnhancedLabelOcrDirect(imagePath, options = {}) {
  const profile = normalizeLabelOcrProfile(options.profile);
  const ocr = await getGutenOcr();
  const lines = await detectLinesWithRetry(ocr, imagePath);
  const filteredLines = Array.isArray(lines)
    ? lines.filter((line) => Number(line?.mean || 0) >= 0.35)
    : [];

  const rawText = sanitizeByWhitelist(buildRawTextFromLines(filteredLines), profile.whitelist);

  return {
    engine: 'guten-ocr',
    rawText,
    lines: filteredLines,
  };
}

async function runEnhancedTextOcrDirect(imagePath, options = {}) {
  const minConfidence = Number.isFinite(options.minConfidence) ? Number(options.minConfidence) : 0.2;
  const ocr = await getGutenOcr();
  const lines = await detectLinesWithRetry(ocr, imagePath);
  const filteredLines = Array.isArray(lines)
    ? lines.filter((line) => Number(line?.mean || 0) >= minConfidence)
    : [];

  return {
    engine: 'guten-ocr',
    rawText: buildRawTextFromLines(filteredLines),
    lines: filteredLines,
  };
}

function resolveWorkerScriptPath() {
  const resourcesPath = process.resourcesPath || '';
  const dirname = __dirname || process.cwd();
  const candidates = [
    resourcesPath ? path.join(resourcesPath, 'app.asar.unpacked', 'label-ocr-worker.js') : '',
    resourcesPath ? path.join(resourcesPath, 'label-ocr-worker.js') : '',
    path.join(dirname.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`), 'label-ocr-worker.js'),
    path.join(dirname, 'label-ocr-worker.js'),
  ].filter(Boolean);

  const found = candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });

  if (!found) {
    throw new Error(`Enhanced OCR worker script not found. Tried: ${candidates.join(', ')}`);
  }

  return found;
}

function createWorkerEnv() {
  const nextEnv = { ...process.env };
  if (process.versions?.electron) {
    nextEnv.ELECTRON_RUN_AS_NODE = '1';
  }
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
  const existingPath = nextEnv[pathKey] || nextEnv.PATH || nextEnv.Path || '';
  const runtimeSearchPaths = resolveWorkerLibraryPaths();
  if (runtimeSearchPaths.length > 0) {
    nextEnv[pathKey] = [...runtimeSearchPaths, existingPath]
      .filter(Boolean)
      .join(path.delimiter);
  }
  return nextEnv;
}

function uniqueExistingDirs(candidates = []) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    if (!candidate || seen.has(candidate)) {
      return false;
    }
    try {
      const exists = fs.existsSync(candidate) && fs.statSync(candidate).isDirectory();
      if (exists) {
        seen.add(candidate);
      }
      return exists;
    } catch {
      return false;
    }
  });
}

function resolveOnnxruntimeBinDirs(baseCandidates = [], platform = process.platform, arch = process.arch) {
  const discovered = [];

  for (const candidate of baseCandidates.filter(Boolean)) {
    const normalizedCandidate = path.normalize(candidate);
    if (/onnxruntime-node[\\/]+bin[\\/]+napi-v\d+[\\/]+/i.test(normalizedCandidate)) {
      discovered.push(normalizedCandidate);
      continue;
    }

    const binRoot = path.join(candidate, 'node_modules', 'onnxruntime-node', 'bin');
    let entries = [];
    try {
      entries = fs.readdirSync(binRoot, { withFileTypes: true });
    } catch {
      continue;
    }

    entries
      .filter((entry) => entry.isDirectory() && /^napi-v\d+$/i.test(entry.name))
      .sort((left, right) => right.name.localeCompare(left.name, undefined, { numeric: true, sensitivity: 'base' }))
      .forEach((entry) => {
        discovered.push(path.join(binRoot, entry.name, platform, arch));
      });
  }

  return uniqueExistingDirs(discovered);
}

function resolveWorkerLibraryPaths() {
  const resourcesPath = process.resourcesPath || '';
  const dirname = __dirname || process.cwd();
  const unpackedDir = dirname.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  const onnxRuntimeBinDirs = resolveOnnxruntimeBinDirs([
    unpackedDir,
    resourcesPath ? path.join(resourcesPath, 'app.asar.unpacked') : '',
    resourcesPath || '',
    process.cwd(),
  ]);

  if (process.platform === 'win32') {
    return uniqueExistingDirs([
      ...onnxRuntimeBinDirs,
      resourcesPath ? path.join(resourcesPath, 'runtime', 'windows', 'node') : '',
      resourcesPath ? path.join(resourcesPath, 'runtime', 'windows', 'crt') : '',
      resourcesPath ? path.join(resourcesPath, 'runtime', 'windows', 'python') : '',
      path.join(dirname, 'vendor', 'windows', 'node'),
      path.join(process.cwd(), 'vendor', 'windows', 'node'),
      path.join(dirname, 'vendor', 'windows', 'crt'),
      path.join(process.cwd(), 'vendor', 'windows', 'crt'),
      path.join(dirname, 'vendor', 'windows', 'python'),
      path.join(process.cwd(), 'vendor', 'windows', 'python'),
      process.cwd(),
    ]);
  }

  return uniqueExistingDirs([
    ...onnxRuntimeBinDirs,
    process.cwd(),
  ]);
}

function commandExists(command) {
  if (!command) {
    return false;
  }

  if (command.includes(path.sep)) {
    try {
      return fs.existsSync(command);
    } catch {
      return false;
    }
  }

  try {
    const result = spawnSync(command, ['-v'], {
      encoding: 'utf8',
      timeout: 4000,
      windowsHide: true,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function resolvePythonRuntimeCommand() {
  const runtime = runtimeResolver.findPythonRuntime();
  if (!runtime?.command) {
    return null;
  }

  return {
    command: runtime.command,
    args: Array.isArray(runtime.args) ? [...runtime.args] : [],
    env: runtimeResolver.getPythonSpawnEnv(runtime),
    label: runtimeResolver.describeRuntime(runtime),
  };
}

function resolveFabricLabelDetectorOnnxPath(options = {}) {
  const runtimeStatus = runtimeResolver.getFabricLabelDetectorStatus?.() || null;
  const candidates = [
    options.fabricLabelDetectorOnnxPath,
    runtimeStatus?.modelPath,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  return candidates.find((candidate) => {
    try {
      return /\.onnx$/i.test(candidate) && fs.existsSync(candidate);
    } catch {
      return false;
    }
  }) || '';
}

function parseShellCommand(command = '') {
  const trimmed = String(command || '').trim();
  if (!trimmed) {
    return null;
  }

  const parts = trimmed.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  if (!parts.length) {
    return null;
  }

  return {
    command: parts[0].replace(/^"(.*)"$/, '$1'),
    args: parts.slice(1).map((part) => part.replace(/^"(.*)"$/, '$1')),
  };
}

function resolveBundledNodeCandidates() {
  const resourcesPath = process.resourcesPath || '';
  const dirname = __dirname || process.cwd();
  const candidates = [];

  if (process.platform === 'darwin') {
    candidates.push(
      resourcesPath ? path.join(resourcesPath, 'runtime', 'mac', 'node', 'node') : '',
      path.join(dirname, 'vendor', 'mac', 'node', 'node'),
      path.join(process.cwd(), 'vendor', 'mac', 'node', 'node'),
    );
  } else if (process.platform === 'win32') {
    candidates.push(
      resourcesPath ? path.join(resourcesPath, 'runtime', 'windows', 'node', 'node.exe') : '',
      path.join(dirname, 'vendor', 'windows', 'node', 'node.exe'),
      path.join(process.cwd(), 'vendor', 'windows', 'node', 'node.exe'),
    );
  }

  return candidates.filter(Boolean);
}

function resolveSystemNodeCandidates() {
  if (process.platform === 'win32') {
    return ['node.exe', 'node'];
  }

  return [
    '/usr/local/bin/node',
    '/opt/homebrew/bin/node',
    'node',
  ];
}

function resolveFabricLabelDetectorModelPath(options = {}) {
  const runtimeStatus = runtimeResolver.getFabricLabelDetectorStatus?.() || null;
  const candidates = [
    options.fabricLabelDetectorModelPath,
    options.labelDetectorModelPath,
    process.env.GSBOT_FABRIC_LABEL_DETECTOR_MODEL,
    runtimeStatus?.ptModelPath,
    runtimeStatus?.modelPath,
    ...DEFAULT_FABRIC_LABEL_DETECTOR_MODEL_CANDIDATES,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  return candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  }) || '';
}

function resolveYoloCommand(options = {}) {
  const homeDir = os.homedir();
  const runtimeStatus = runtimeResolver.getFabricLabelDetectorStatus?.() || null;
  const pythonRuntime = resolvePythonRuntimeCommand();
  const envCommand = parseShellCommand(process.env.GSBOT_YOLO_COMMAND);
  if (envCommand && commandExists(envCommand.command)) {
    return {
      command: envCommand.command,
      args: envCommand.args,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
      },
      source: 'env',
    };
  }

  const explicitCommand = parseShellCommand(options.yoloCommand || runtimeStatus?.yoloCommand || '');
  if (explicitCommand && commandExists(explicitCommand.command)) {
    return {
      command: explicitCommand.command,
      args: explicitCommand.args,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
      },
      source: 'explicit',
    };
  }

  const pythonModule = String(options.fabricLabelDetectorPythonModule || runtimeStatus?.pythonModule || '').trim();
  if (pythonModule && pythonRuntime) {
    return {
      command: pythonRuntime.command,
      args: [...pythonRuntime.args, '-m', pythonModule],
      env: {
        ...pythonRuntime.env,
        PYTHONUNBUFFERED: '1',
      },
      source: 'python-module',
    };
  }

  const candidates = [
    path.join(homeDir, 'Library', 'Python', '3.9', 'bin', 'yolo'),
    path.join(homeDir, 'Library', 'Python', '3.10', 'bin', 'yolo'),
    path.join(homeDir, 'Library', 'Python', '3.11', 'bin', 'yolo'),
    path.join(homeDir, 'Library', 'Python', '3.12', 'bin', 'yolo'),
    'yolo',
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  const resolved = candidates.find((candidate) => commandExists(candidate)) || '';
  if (!resolved) {
    return null;
  }

  return {
    command: resolved,
    args: [],
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
    },
    source: 'system',
  };
}

function resolveFabricLabelDetectorStatus(options = {}) {
  if (options.useFabricLabelDetector === false || options.disableFabricLabelDetection === true) {
    return { available: false, reason: 'detector disabled' };
  }

  if (!sharp) {
    return { available: false, reason: 'image processor unavailable' };
  }

  const onnxModelPath = resolveFabricLabelDetectorOnnxPath(options);
  if (onnxModelPath && ort?.InferenceSession) {
    return {
      available: true,
      reason: '',
      mode: 'onnx',
      modelPath: onnxModelPath,
    };
  }

  const modelPath = resolveFabricLabelDetectorModelPath(options);
  const yoloRuntime = resolveYoloCommand(options);
  if (!modelPath && !yoloRuntime) {
    return { available: false, reason: 'detector model and YOLO command unavailable' };
  }
  if (!modelPath) {
    return { available: false, reason: 'detector model unavailable' };
  }
  if (!yoloRuntime) {
    return { available: false, reason: 'YOLO command unavailable' };
  }

  return {
    available: true,
    reason: '',
    mode: 'yolo',
    modelPath,
    yoloRuntime,
  };
}

async function resolveFabricLabelDetectorSession(modelPath) {
  if (
    fabricLabelDetectorSessionCache.session
    && fabricLabelDetectorSessionCache.modelPath === modelPath
  ) {
    return fabricLabelDetectorSessionCache;
  }

  if (!ort?.InferenceSession) {
    throw new Error('onnxruntime-node is not available.');
  }

  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: process.platform === 'win32'
      ? ['dml', 'cpu']
      : ['cpu'],
    executionMode: 'sequential',
    graphOptimizationLevel: 'all',
    enableCpuMemArena: false,
    enableMemPattern: false,
    interOpNumThreads: 1,
    intraOpNumThreads: Math.max(2, Math.min(8, os.cpus?.().length || 4)),
  });

  const inputName = session.inputNames?.[0] || 'images';
  const outputName = session.outputNames?.[0] || 'output0';

  let inputSize = 0;
  const inputMetadata = session.inputMetadata?.[inputName] || null;
  const inputDims = Array.isArray(inputMetadata?.dimensions)
    ? inputMetadata.dimensions.map((value) => Number(value))
    : [];
  if (inputDims.length === 4 && Number.isFinite(inputDims[2]) && inputDims[2] > 0) {
    inputSize = Math.round(inputDims[2]);
  }

  if (!inputSize) {
    const probeSizes = [DEFAULT_FABRIC_LABEL_DETECTOR_ONNX_INPUT, 1280, 1024, 640];
    for (const candidate of probeSizes) {
      try {
        const probeTensor = new ort.Tensor(
          'float32',
          new Float32Array(3 * candidate * candidate),
          [1, 3, candidate, candidate],
        );
        const probeOutput = await session.run({ [inputName]: probeTensor });
        if (probeOutput?.[outputName]?.data) {
          inputSize = candidate;
          break;
        }
      } catch {
        // Try the next candidate.
      }
    }
  }

  fabricLabelDetectorSessionCache = {
    modelPath,
    session,
    inputName,
    outputName,
    inputSize: inputSize || DEFAULT_FABRIC_LABEL_DETECTOR_ONNX_INPUT,
  };
  return fabricLabelDetectorSessionCache;
}

function computeIntersectionOverUnion(left, right) {
  const x1 = Math.max(left.left, right.left);
  const y1 = Math.max(left.top, right.top);
  const x2 = Math.min(left.left + left.width, right.left + right.width);
  const y2 = Math.min(left.top + left.height, right.top + right.height);
  const intersectionWidth = Math.max(0, x2 - x1);
  const intersectionHeight = Math.max(0, y2 - y1);
  const intersection = intersectionWidth * intersectionHeight;
  if (!intersection) {
    return 0;
  }

  const leftArea = Math.max(0, left.width) * Math.max(0, left.height);
  const rightArea = Math.max(0, right.width) * Math.max(0, right.height);
  const union = leftArea + rightArea - intersection;
  return union > 0 ? (intersection / union) : 0;
}

function nonMaxSuppression(detections, iouThreshold = 0.45) {
  const sorted = [...detections].sort((left, right) => right.confidence - left.confidence);
  const kept = [];

  while (sorted.length) {
    const current = sorted.shift();
    kept.push(current);
    for (let index = sorted.length - 1; index >= 0; index -= 1) {
      if (computeIntersectionOverUnion(current.box, sorted[index].box) > iouThreshold) {
        sorted.splice(index, 1);
      }
    }
  }

  return kept;
}

function getDetectorMaxCandidates(options = {}) {
  return Math.max(1, Math.min(8, Number(options.fabricLabelDetectorMaxCandidates) || DEFAULT_FABRIC_LABEL_DETECTOR_MAX_CANDIDATES));
}

async function cropDetectedLabelCandidates({
  imagePath,
  detections = [],
  imageSize = {},
  options = {},
  tempRoot = '',
  imageStem = '',
  modelPath = '',
  yoloCommand = '',
  detectionToCropBox = null,
}) {
  const detectorMinWidth = Number.isFinite(options.fabricLabelDetectorMinWidth)
    ? Number(options.fabricLabelDetectorMinWidth)
    : DEFAULT_FABRIC_LABEL_DETECTOR_MIN_WIDTH;
  const detectorMinHeight = Number.isFinite(options.fabricLabelDetectorMinHeight)
    ? Number(options.fabricLabelDetectorMinHeight)
    : DEFAULT_FABRIC_LABEL_DETECTOR_MIN_HEIGHT;
  const maxCandidates = getDetectorMaxCandidates(options);
  const selectedDetections = detections.slice(0, maxCandidates);
  const candidates = [];

  for (let index = 0; index < selectedDetections.length; index += 1) {
    const detection = selectedDetections[index];
    const cropBox = typeof detectionToCropBox === 'function'
      ? detectionToCropBox(detection)
      : detection.cropBox;
    if (!cropBox?.width || !cropBox?.height) {
      continue;
    }

    const upscaleFactor = Math.max(
      detectorMinWidth / Math.max(1, cropBox.width),
      detectorMinHeight / Math.max(1, cropBox.height),
      1,
    );
    const cropPath = path.join(
      tempRoot,
      `${imageStem || path.basename(imagePath, path.extname(imagePath))}-crop-${index + 1}-${crypto.randomBytes(4).toString('hex')}.png`,
    );

    let cropPipeline = sharp(imagePath)
      .extract(cropBox)
      .flatten({ background: '#ffffff' });

    if (upscaleFactor > 1) {
      cropPipeline = cropPipeline.resize({
        width: Math.max(1, Math.round(cropBox.width * upscaleFactor)),
        height: Math.max(1, Math.round(cropBox.height * upscaleFactor)),
        fit: 'fill',
        kernel: 'lanczos3',
      });
    }

    await cropPipeline.png().toFile(cropPath);
    candidates.push({
      imagePath: cropPath,
      detection,
      cropBox,
      debug: {
        modelPath,
        yoloCommand,
        confidence: detection.confidence,
        imageSize,
        candidateIndex: index,
        candidateCount: selectedDetections.length,
      },
    });
  }

  return candidates;
}

async function runFabricLabelDetectorOnnx(imagePath, options = {}) {
  if (!sharp) {
    throw new Error('sharp is not available.');
  }

  const modelPath = resolveFabricLabelDetectorOnnxPath(options);
  if (!modelPath) {
    return null;
  }

  const sessionInfo = await resolveFabricLabelDetectorSession(modelPath);
  const inputSize = Number(sessionInfo.inputSize) > 0
    ? Number(sessionInfo.inputSize)
    : DEFAULT_FABRIC_LABEL_DETECTOR_ONNX_INPUT;
  const image = sharp(imagePath, { failOn: 'none' }).rotate().removeAlpha();
  const metadata = await image.metadata();
  const imageSize = {
    width: Number(metadata.width) || 0,
    height: Number(metadata.height) || 0,
  };
  if (!imageSize.width || !imageSize.height) {
    return null;
  }

  const scale = Math.min(inputSize / imageSize.width, inputSize / imageSize.height);
  const resizedWidth = Math.max(1, Math.round(imageSize.width * scale));
  const resizedHeight = Math.max(1, Math.round(imageSize.height * scale));
  const padLeft = Math.floor((inputSize - resizedWidth) / 2);
  const padTop = Math.floor((inputSize - resizedHeight) / 2);

  const { data } = await image
    .resize(resizedWidth, resizedHeight, { fit: 'fill' })
    .extend({
      top: padTop,
      bottom: inputSize - resizedHeight - padTop,
      left: padLeft,
      right: inputSize - resizedWidth - padLeft,
      background: { r: 114, g: 114, b: 114 },
    })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixelCount = inputSize * inputSize;
  const tensorData = new Float32Array(pixelCount * 3);
  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * 3;
    tensorData[index] = data[offset] / 255;
    tensorData[pixelCount + index] = data[offset + 1] / 255;
    tensorData[(pixelCount * 2) + index] = data[offset + 2] / 255;
  }

  const outputMap = await sessionInfo.session.run({
    [sessionInfo.inputName]: new ort.Tensor('float32', tensorData, [1, 3, inputSize, inputSize]),
  });
  const outputTensor = outputMap?.[sessionInfo.outputName];
  if (!outputTensor?.data) {
    return null;
  }

  const detectorConfidence = Number.isFinite(options.fabricLabelDetectorConfidence)
    ? Number(options.fabricLabelDetectorConfidence)
    : DEFAULT_FABRIC_LABEL_DETECTOR_CONFIDENCE;
  const detectorPadding = Number.isFinite(options.fabricLabelDetectorPadding)
    ? Number(options.fabricLabelDetectorPadding)
    : DEFAULT_FABRIC_LABEL_DETECTOR_PADDING;
  const values = outputTensor.data;
  // YOLOv8 ONNX output shape is [1, 4 + numClasses, numAnchors].
  // Single-class export → 5 rows; multi-class → 4 + numClasses rows.
  // `stride` here is the number of anchors per row.
  const outputDims = Array.isArray(outputTensor.dims) ? outputTensor.dims.map((value) => Number(value)) : [];
  let rows = 0;
  let stride = 0;
  if (outputDims.length === 3 && Number.isFinite(outputDims[1]) && Number.isFinite(outputDims[2])) {
    rows = outputDims[1];
    stride = outputDims[2];
  } else {
    // Fallback for unexpected shapes: assume single-class layout.
    rows = 5;
    stride = Math.floor(values.length / 5);
  }
  const numClasses = Math.max(1, rows - 4);
  // Which class id to keep. Default 0 (fabric_label). Style mode passes 1
  // so the detector returns the style_label box instead of being a no-op.
  const targetClass = Number.isFinite(options.fabricLabelDetectorTargetClass)
    ? Number(options.fabricLabelDetectorTargetClass)
    : 0;
  const detections = [];
  for (let index = 0; index < stride; index += 1) {
    // Class scores live at rows [4 .. 4 + numClasses). Take the max — and
    // since we only consume one class downstream, also require that the
    // requested class wins this anchor.
    let bestScore = 0;
    let bestClass = -1;
    for (let c = 0; c < numClasses; c += 1) {
      const score = Number(values[(stride * (4 + c)) + index]) || 0;
      if (score > bestScore) {
        bestScore = score;
        bestClass = c;
      }
    }
    if (bestScore < detectorConfidence) {
      continue;
    }
    if (bestClass !== targetClass) {
      // A different class won this anchor — skip.
      continue;
    }
    const confidence = bestScore;

    const centerX = Number(values[index]) || 0;
    const centerY = Number(values[stride + index]) || 0;
    const width = Number(values[(stride * 2) + index]) || 0;
    const height = Number(values[(stride * 3) + index]) || 0;
    const left = ((centerX - (width / 2)) - padLeft) / scale;
    const top = ((centerY - (height / 2)) - padTop) / scale;
    const right = ((centerX + (width / 2)) - padLeft) / scale;
    const bottom = ((centerY + (height / 2)) - padTop) / scale;

    const box = {
      left: Math.max(0, Math.floor(left)),
      top: Math.max(0, Math.floor(top)),
      width: Math.max(1, Math.ceil(Math.min(imageSize.width, right)) - Math.floor(Math.max(0, left))),
      height: Math.max(1, Math.ceil(Math.min(imageSize.height, bottom)) - Math.floor(Math.max(0, top))),
    };
    detections.push({ confidence, box });
  }

  const keptDetections = nonMaxSuppression(detections);
  if (!keptDetections.length) {
    return null;
  }
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsbot-label-detect-onnx-'));
  const cleanup = async () => {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {}
  };
  const candidates = await cropDetectedLabelCandidates({
    imagePath,
    detections: keptDetections,
    imageSize,
    options,
    tempRoot,
    imageStem: path.basename(imagePath, path.extname(imagePath)),
    modelPath,
    yoloCommand: 'onnxruntime-node',
    detectionToCropBox: (detection) => convertNormalizedBoxToPixels({
      xCenter: (detection.box.left + (detection.box.width / 2)) / imageSize.width,
      yCenter: (detection.box.top + (detection.box.height / 2)) / imageSize.height,
      width: detection.box.width / imageSize.width,
      height: detection.box.height / imageSize.height,
    }, imageSize, detectorPadding),
  });
  if (!candidates.length) {
    await cleanup();
    return null;
  }
  const bestCandidate = candidates[0];

  return {
    imagePath: bestCandidate.imagePath,
    detection: {
      classId: targetClass,
      confidence: bestCandidate.detection.confidence,
    },
    cropBox: bestCandidate.cropBox,
    candidates,
    cleanup,
    debug: {
      modelPath,
      yoloCommand: 'onnxruntime-node',
      confidence: bestCandidate.detection.confidence,
      imageSize,
    },
  };
}

function parseYoloDetectionLine(line = '') {
  const parts = String(line || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 5) {
    return null;
  }

  const [classId, xCenter, yCenter, width, height, confidence] = parts.map((value) => Number(value));
  if (![classId, xCenter, yCenter, width, height].every((value) => Number.isFinite(value))) {
    return null;
  }

  return {
    classId,
    xCenter,
    yCenter,
    width,
    height,
    confidence: Number.isFinite(confidence) ? confidence : null,
  };
}

function convertNormalizedBoxToPixels(box, imageSize, padding = 0) {
  const xCenter = box.xCenter * imageSize.width;
  const yCenter = box.yCenter * imageSize.height;
  const boxWidth = box.width * imageSize.width;
  const boxHeight = box.height * imageSize.height;

  const pad = Math.max(0, Math.round(Number(padding) || 0));
  const left = Math.max(0, Math.floor(xCenter - (boxWidth / 2) - pad));
  const top = Math.max(0, Math.floor(yCenter - (boxHeight / 2) - pad));
  const right = Math.min(imageSize.width, Math.ceil(xCenter + (boxWidth / 2) + pad));
  const bottom = Math.min(imageSize.height, Math.ceil(yCenter + (boxHeight / 2) + pad));

  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

function runChildProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(stderr.trim() || stdout.trim() || `Command failed with exit code ${code}`));
    });
  });
}

async function detectAndCropFabricLabel(imagePath, options = {}) {
  const detectorStatus = resolveFabricLabelDetectorStatus(options);
  if (!detectorStatus.available) {
    return null;
  }
  if (detectorStatus.mode === 'onnx') {
    try {
      return await runFabricLabelDetectorOnnx(imagePath, options);
    } catch (error) {
      if (options.emitLog) {
        options.emitLog(`Label OCR: detector ONNX inference failed (${error?.message || error}).`, 'warning');
      } else {
        // Surface to stderr so packaged-app logs capture the underlying error.
        console.error('Label OCR detector ONNX failure:', error?.message || error);
      }
      return null;
    }
  }
  const { modelPath, yoloRuntime } = detectorStatus;

  const detectorConfidence = Number.isFinite(options.fabricLabelDetectorConfidence)
    ? Number(options.fabricLabelDetectorConfidence)
    : DEFAULT_FABRIC_LABEL_DETECTOR_CONFIDENCE;
  const detectorPadding = Number.isFinite(options.fabricLabelDetectorPadding)
    ? Number(options.fabricLabelDetectorPadding)
    : DEFAULT_FABRIC_LABEL_DETECTOR_PADDING;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsbot-label-detect-'));
  const predictName = 'predict';
  const imageStem = path.basename(imagePath, path.extname(imagePath));
  const predictedLabelPath = path.join(tempRoot, predictName, 'labels', `${imageStem}.txt`);

  const cleanup = async () => {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // Ignore temporary cleanup failures.
    }
  };

  try {
    await runChildProcess(yoloRuntime.command, [
      ...(Array.isArray(yoloRuntime.args) ? yoloRuntime.args : []),
      'detect',
      'predict',
      `model=${modelPath}`,
      `source=${imagePath}`,
      `project=${tempRoot}`,
      `name=${predictName}`,
      'exist_ok=True',
      `conf=${detectorConfidence}`,
      'imgsz=1280',
      'save=False',
      'save_txt=True',
      'save_conf=True',
      'verbose=False',
    ], {
      env: yoloRuntime.env || {
        ...process.env,
        PYTHONUNBUFFERED: '1',
      },
    });

    if (!fs.existsSync(predictedLabelPath)) {
      await cleanup();
      return null;
    }

    const targetClass = Number.isFinite(options.fabricLabelDetectorTargetClass)
      ? Number(options.fabricLabelDetectorTargetClass)
      : 0;
    const detections = fs.readFileSync(predictedLabelPath, 'utf8')
      .split('\n')
      .map((line) => parseYoloDetectionLine(line))
      .filter(Boolean)
      .filter((entry) => entry.classId === targetClass);

    if (detections.length === 0) {
      await cleanup();
      return null;
    }

    const keptDetections = nonMaxSuppression(
      detections
        .map((detection) => ({
          ...detection,
          confidence: Number(detection.confidence) || 0,
          box: {
            left: Math.max(0, (detection.xCenter || 0) - ((detection.width || 0) / 2)),
            top: Math.max(0, (detection.yCenter || 0) - ((detection.height || 0) / 2)),
            width: Math.max(0.0001, detection.width || 0),
            height: Math.max(0.0001, detection.height || 0),
          },
        })),
    );
    const metadata = await sharp(imagePath).metadata();
    const imageSize = {
      width: Number(metadata.width) || 0,
      height: Number(metadata.height) || 0,
    };

    if (!imageSize.width || !imageSize.height) {
      await cleanup();
      return null;
    }

    const yoloCommand = [yoloRuntime.command, ...(Array.isArray(yoloRuntime.args) ? yoloRuntime.args : [])].join(' ');
    const candidates = await cropDetectedLabelCandidates({
      imagePath,
      detections: keptDetections,
      imageSize,
      options,
      tempRoot,
      imageStem,
      modelPath,
      yoloCommand,
      detectionToCropBox: (detection) => convertNormalizedBoxToPixels(detection, imageSize, detectorPadding),
    });
    if (!candidates.length) {
      await cleanup();
      return null;
    }
    const bestCandidate = candidates[0];

    return {
      imagePath: bestCandidate.imagePath,
      detection: bestCandidate.detection,
      cropBox: bestCandidate.cropBox,
      candidates,
      cleanup,
      debug: {
        modelPath,
        yoloCommand,
        confidence: bestCandidate.detection.confidence,
        imageSize,
      },
    };
  } catch {
    await cleanup();
    return null;
  }
}

function resolveWorkerRuntime() {
  if (resolvedWorkerRuntime) {
    return resolvedWorkerRuntime;
  }

  const bundled = resolveBundledNodeCandidates().find((candidate) => commandExists(candidate));
  if (bundled) {
    resolvedWorkerRuntime = {
      command: bundled,
      env: createWorkerEnv(),
      kind: 'node',
    };
    return resolvedWorkerRuntime;
  }

  const systemNode = resolveSystemNodeCandidates().find((candidate) => commandExists(candidate));
  if (systemNode) {
    resolvedWorkerRuntime = {
      command: systemNode,
      env: createWorkerEnv(),
      kind: 'node',
    };
    return resolvedWorkerRuntime;
  }

  resolvedWorkerRuntime = {
    command: process.execPath,
    env: createWorkerEnv(),
    kind: 'electron',
  };
  return resolvedWorkerRuntime;
}

function rejectPendingWorkerRequests(requestMap, reason = '') {
  if (!requestMap?.size) {
    return;
  }

  const error = new Error(`Enhanced OCR worker failed: ${reason}`);
  for (const pending of requestMap.values()) {
    pending.reject(error);
  }
  requestMap.clear();
}

function resetPersistentWorker(reason = '', options = {}) {
  const state = persistentWorkerState;
  persistentWorkerState = null;

  if (!state) {
    return;
  }

  try {
    state.stdoutReader?.close?.();
  } catch {
    // Ignore reader cleanup failures.
  }

  if (options.rejectPending !== false && state.requests?.size) {
    rejectPendingWorkerRequests(state.requests, reason || 'worker reset');
  }

  if (options.kill !== false) {
    try {
      state.child?.kill();
    } catch {
      // Ignore child cleanup failures.
    }
  }
}

function ensurePersistentWorker() {
  if (persistentWorkerState?.child && !persistentWorkerState.child.killed) {
    return persistentWorkerState;
  }

  const workerScript = resolveWorkerScriptPath();
  const runtime = resolveWorkerRuntime();
  const child = spawn(runtime.command, [workerScript], {
    env: runtime.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const state = {
    child,
    stderr: '',
    nextRequestId: 1,
    requests: new Map(),
    stdoutReader: readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    }),
  };

  state.stdoutReader.on('line', (line) => {
    const rawLine = String(line || '').trim();
    if (!rawLine) {
      return;
    }

    // Skip lines that are not JSON responses. Native OCR modules (e.g., ONNX
    // Runtime) may print warnings to stdout, which would corrupt the JSON
    // protocol between worker and parent. Only treat JSON-looking lines that
    // fail to parse as actual errors.
    if (!rawLine.startsWith('{')) {
      return;
    }

    let payload = null;
    let parseError = null;
    try {
      payload = JSON.parse(rawLine);
    } catch (error) {
      parseError = error;

      // Regex fallback: ONNX Runtime or other native modules may concatenate
      // warnings with JSON on the same line, causing the initial parse to fail.
      // Try extracting the JSON object from anywhere in the line.
      const greedyMatch = rawLine.match(/\{[\s\S]*\}/);
      if (greedyMatch) {
        try {
          payload = JSON.parse(greedyMatch[0]);
        } catch (_) {
          // Try lazy match as a last resort
          const lazyMatch = rawLine.match(/\{[\s\S]*?\}/);
          if (lazyMatch && lazyMatch[0] !== greedyMatch[0]) {
            try {
              payload = JSON.parse(lazyMatch[0]);
            } catch (_) {
              // Both matches failed; fall through to error handling
            }
          }
        }
      }
    }

    if (!payload) {
      const reason = `Enhanced OCR worker returned invalid JSON: ${parseError?.message || 'unknown error'}`;
      markEnhancedOcrUnavailable(reason);
      resetPersistentWorker(reason);
      return;
    }

    const requestId = payload?.id || null;
    const pending = requestId ? state.requests.get(requestId) : null;
    if (!pending) {
      return;
    }
    state.requests.delete(requestId);

    if (payload.success) {
      pending.resolve(payload.result || {});
      return;
    }

    const reason = normalizeWorkerFailureReason(payload.error || state.stderr.trim(), null, null);
    if (isFatalEnhancedOcrFailure(reason, null, null)) {
      markEnhancedOcrUnavailable(reason);
      pending.reject(new Error(`Enhanced OCR worker failed: ${reason}`));
      resetPersistentWorker(reason, { rejectPending: false });
      return;
    }

    pending.reject(new Error(`Enhanced OCR worker failed: ${reason}`));
  });

  child.stderr.on('data', (chunk) => {
    state.stderr += chunk.toString();
    if (state.stderr.length > 12000) {
      state.stderr = state.stderr.slice(-12000);
    }
  });

  child.on('error', (error) => {
    const reason = error?.message || String(error);
    if (isFatalEnhancedOcrFailure(reason, null, null)) {
      markEnhancedOcrUnavailable(reason);
    }
    resetPersistentWorker(reason);
  });

  child.on('close', (code, signal) => {
    const reason = normalizeWorkerFailureReason(state.stderr.trim(), code, signal);
    if (isFatalEnhancedOcrFailure(reason, code, signal)) {
      markEnhancedOcrUnavailable(reason);
    }
    resetPersistentWorker(reason, {
      kill: false,
    });
  });

  persistentWorkerState = state;
  return state;
}

async function runEnhancedOcrInWorker(imagePath, options = {}, mode = 'label') {
  if (enhancedOcrUnavailableReason) {
    throw new Error(`Enhanced OCR unavailable in this session: ${enhancedOcrUnavailableReason}`);
  }

  return new Promise((resolve, reject) => {
    const state = ensurePersistentWorker();
    const requestId = `ocr-${process.pid}-${Date.now()}-${state.nextRequestId++}`;
    state.requests.set(requestId, { resolve, reject });

    try {
      state.child.stdin.write(`${JSON.stringify({
        id: requestId,
        imagePath,
        options,
        mode,
      })}\n`);
    } catch (error) {
      state.requests.delete(requestId);
      const reason = error?.message || String(error);
      if (isFatalEnhancedOcrFailure(reason, null, null)) {
        markEnhancedOcrUnavailable(reason);
      }
      resetPersistentWorker(reason);
      reject(new Error(`Enhanced OCR worker failed: ${reason}`));
    }
  });
}

async function runPaddleCloudOcr(imagePath, options = {}, mode = 'label') {
  const runtimeConfig = resolveOcrRuntimeConfig(options);
  const cloudCfg = runtimeConfig.paddleCloud || {};
  const token = String(cloudCfg.token || '').trim();
  if (!token) {
    throw new Error('Paddle cloud OCR token not configured');
  }

  const https = require('https');
  const FormData = require('form-data');
  const profile = normalizeLabelOcrProfile(options.profile);

  // Upload image to Paddle cloud OCR
  return new Promise((resolve, reject) => {
    try {
      const form = new FormData();
      form.append('file', fs.createReadStream(imagePath));
      form.append('model', cloudCfg.model || 'PaddleOCR-VL-1.6');

      const reqOptions = {
        hostname: 'paddleocr.aistudio-app.com',
        path: '/api/v2/ocr/recognize',
        method: 'POST',
        headers: {
          ...form.getHeaders(),
          'Authorization': `Bearer ${token}`,
        },
        timeout: 60000,
      };

      const req = https.request(reqOptions, (res) => {
        let data = '';
        res.on('data', (c) => data += c);
        res.on('end', () => {
          try {
            const body = JSON.parse(data);
            if (body.code === 0 && body.data) {
              const text = typeof body.data === 'string'
                ? body.data
                : (body.data.text || body.data.result || JSON.stringify(body.data));
              resolve({
                engine: OCR_ENGINE_PADDLE_CLOUD,
                rawText: mode === 'label'
                  ? sanitizeByWhitelist(String(text || ''), profile.whitelist)
                  : String(text || '').trim(),
                lines: [],
              });
            } else {
              reject(new Error(body.msg || `Paddle cloud OCR failed: code ${body.code}`));
            }
          } catch (e) {
            reject(new Error(`Paddle cloud OCR parse error: ${e.message}`));
          }
        });
      });

      req.on('error', (e) => reject(e));
      req.on('timeout', () => { req.destroy(); reject(new Error('Paddle cloud OCR timeout')); });
      form.pipe(req);
    } catch (e) {
      reject(e);
    }
  });
}

async function runOcrByEngine(engine, imagePath, options = {}, mode = 'label') {
  const normalized = normalizeOcrEngineName(engine);
  if (normalized === OCR_ENGINE_DEEPSEEK_LOCAL) {
    return runDeepseekLocalOcr(imagePath, options, mode);
  }

  if (normalized === OCR_ENGINE_PADDLE_VL_LOCAL) {
    return runPaddleVlLocalOcr(imagePath, options, mode);
  }

  if (normalized === OCR_ENGINE_PADDLE_CLOUD) {
    return runPaddleCloudOcr(imagePath, options, mode);
  }

  // Guten OCR (default)
  return runEnhancedOcrInWorker(imagePath, options, mode);
}

async function runWithConfiguredFallback(imagePath, options = {}, mode = 'label') {
  const runtimeConfig = resolveOcrRuntimeConfig(options);
  const attempted = [];

  try {
    const primaryResult = await runOcrByEngine(runtimeConfig.engine, imagePath, options, mode);
    const primaryText = String(primaryResult?.rawText || '').trim();
    if (primaryText || !runtimeConfig.fallbackEngine) {
      return primaryResult;
    }
    attempted.push(`${runtimeConfig.engine}: empty result`);
  } catch (error) {
    attempted.push(`${runtimeConfig.engine}: ${error.message}`);
    if (!runtimeConfig.fallbackEngine) {
      throw error;
    }
  }

  try {
    return await runOcrByEngine(runtimeConfig.fallbackEngine, imagePath, {
      ...options,
      engine: runtimeConfig.fallbackEngine,
      ocrEngine: runtimeConfig.fallbackEngine,
      fallbackEngine: '',
      ocrFallbackEngine: '',
    }, mode);
  } catch (error) {
    attempted.push(`${runtimeConfig.fallbackEngine}: ${error.message}`);
    throw new Error(attempted.join(' | '));
  }
}

function normalizeScoreText(value = '') {
  return String(value || '').toUpperCase().replace(/\s+/g, ' ').trim();
}

function countProfileAliasHits(rawText = '', profile = {}) {
  const text = normalizeScoreText(rawText);
  const aliases = Object.values(normalizeLabelOcrProfile(profile).fields || {})
    .flat()
    .map((alias) => normalizeScoreText(alias))
    .filter(Boolean);
  return [...new Set(aliases)].filter((alias) => text.includes(alias)).length;
}

function scoreDetectedLabelOcrResult(result = {}, candidate = {}, options = {}) {
  const rawText = String(result?.rawText || '').trim();
  if (!rawText) {
    return -Infinity;
  }

  const text = normalizeScoreText(rawText);
  let score = 0;
  score += Math.min(8, countProfileAliasHits(rawText, options.profile) * 2);
  score += Math.min(6, Math.floor(rawText.length / 35));
  if (/[A-Z]{1,6}[A-Z0-9]*(?:[-_/][A-Z0-9]+){1,5}/i.test(rawText)) score += 8;
  if (/\b[A-Z]{1,4}\d[A-Z0-9.\-]{5,}\b/i.test(rawText)) score += 6;
  if (/\d{1,3}\s*%\s*[A-Z]+/i.test(rawText)) score += 5;
  if (/\b(WIDTH|WID|CUTTABLE|CW)\b/i.test(text) || /\d{2,3}\s*(?:"|''|”)/.test(rawText)) score += 3;
  if (/\b(WEIGHT|GSM|G\/M2|GM2|OZ\/YD2|OZ)\b/i.test(text)) score += 3;
  if (/\b(DESC|DESCRIPTION|CONTENT|COMPOSITION|CODE|STYLE|ITEM|REF)\b/i.test(text)) score += 3;

  const lineConfidences = Array.isArray(result?.lines)
    ? result.lines.map((line) => Number(line?.mean)).filter((value) => Number.isFinite(value) && value > 0)
    : [];
  if (lineConfidences.length > 0) {
    const avgConfidence = lineConfidences.reduce((sum, value) => sum + value, 0) / lineConfidences.length;
    score += Math.max(0, Math.min(5, avgConfidence * 5));
  }

  const detectorConfidence = Number(candidate?.detection?.confidence);
  if (Number.isFinite(detectorConfidence)) {
    score += Math.min(4, Math.max(0, detectorConfidence * 4));
  }

  return score;
}

async function runEnhancedLabelOcr(imagePath, options = {}) {
  const detectorStatus = resolveFabricLabelDetectorStatus(options);
  const detectedCrop = await detectAndCropFabricLabel(imagePath, options);

  try {
    if (!detectedCrop) {
      const result = await runWithConfiguredFallback(imagePath, options, 'label');
      return {
        ...result,
        detectorUsed: false,
        detectorFallbackReason: detectorStatus.available
          ? 'detector found no label box'
          : detectorStatus.reason,
      };
    }

    const candidates = Array.isArray(detectedCrop.candidates) && detectedCrop.candidates.length > 0
      ? detectedCrop.candidates
      : [detectedCrop];
    const attempts = [];

    for (const candidate of candidates) {
      try {
        const result = await runWithConfiguredFallback(candidate.imagePath, options, 'label');
        const score = scoreDetectedLabelOcrResult(result, candidate, options);
        if (Number.isFinite(score)) {
          attempts.push({ result, candidate, score });
        }
      } catch (error) {
        if (isBadExtractAreaError(error)) {
          continue;
        }
        throw error;
      }
    }

    attempts.sort((left, right) => right.score - left.score);
    const bestAttempt = attempts[0] || null;
    if (!bestAttempt) {
      const fallbackResult = await runWithConfiguredFallback(imagePath, {
        ...options,
        useFabricLabelDetector: false,
        disableFabricLabelDetection: true,
      }, 'label');

      return {
        ...fallbackResult,
        detectorUsed: false,
        detectorFallbackReason: 'empty detector ocr result',
      };
    }

    const { result, candidate } = bestAttempt;
    return {
      ...result,
      detectorUsed: true,
      detectorConfidence: candidate?.detection?.confidence ?? null,
      detectorCropBox: candidate?.cropBox || null,
      detectorSourceImagePath: imagePath,
      detectorSourceImageSize: candidate?.debug?.imageSize || detectedCrop?.debug?.imageSize || null,
      detectorCandidateCount: candidates.length,
      detectorSelectedCandidateIndex: candidate?.debug?.candidateIndex ?? 0,
    };
  } catch (error) {
    if (detectedCrop && isBadExtractAreaError(error)) {
      const fallbackResult = await runWithConfiguredFallback(imagePath, {
        ...options,
        useFabricLabelDetector: false,
        disableFabricLabelDetection: true,
      }, 'label');

      return {
        ...fallbackResult,
        detectorUsed: false,
        detectorFallbackReason: 'bad extract area',
        detectorSourceImagePath: imagePath,
        detectorSourceImageSize: detectedCrop?.debug?.imageSize || null,
      };
    }

    throw error;
  } finally {
    if (detectedCrop?.cleanup) {
      await detectedCrop.cleanup();
    }
  }
}

async function runEnhancedTextOcr(imagePath, options = {}) {
  return runWithConfiguredFallback(imagePath, options, 'text');
}

module.exports = {
  closeEnhancedOcrWorker: () => resetPersistentWorker('manual shutdown'),
  normalizeOcrEngineName,
  runEnhancedLabelOcrDirect,
  runEnhancedLabelOcr,
  runEnhancedTextOcrDirect,
  runEnhancedTextOcr,
  runOcrByEngine,
};

const fs = require('fs');
const os = require('os');
const path = require('path');

let ort = null;
let sharp = null;

try {
  ort = require('onnxruntime-node');
} catch {
  ort = null;
}

try {
  sharp = require('sharp');
} catch {
  sharp = null;
}

const DEFAULT_INPUT_SIZE = 1024;
const MODEL_MEAN = [0.485, 0.456, 0.406];
const MODEL_STD = [0.229, 0.224, 0.225];

let sessionCache = {
  modelPath: '',
  providerKey: 'cpu',
  resolvedProvider: 'cpu',
  session: null,
  inputName: 'pixel_values',
  outputName: 'alphas',
  width: DEFAULT_INPUT_SIZE,
  height: DEFAULT_INPUT_SIZE,
};

function normalizeInferenceDevice(value) {
  const device = String(value || 'cpu').trim().toLowerCase();
  if (device === 'auto') {
    return 'auto';
  }
  return device === 'gpu' ? 'gpu' : 'cpu';
}

function getPreferredLiteProviders(devicePreference) {
  const device = normalizeInferenceDevice(devicePreference);
  if (process.platform === 'win32' && (device === 'gpu' || device === 'auto')) {
    return ['dml', 'cpu'];
  }
  return ['cpu'];
}

function ensureDependencies() {
  if (!ort?.InferenceSession) {
    throw new Error('onnxruntime-node is not available.');
  }
  if (!sharp) {
    throw new Error('sharp is not available.');
  }
}

function listInputImages(sourcePath) {
  const target = String(sourcePath || '').trim();
  if (!target || !fs.existsSync(target)) {
    return [];
  }

  const stats = fs.statSync(target);
  const allowed = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.tif', '.tiff', '.heic']);
  if (stats.isFile()) {
    return allowed.has(path.extname(target).toLowerCase()) ? [target] : [];
  }

  return fs.readdirSync(target)
    .map((name) => path.join(target, name))
    .filter((entry) => {
      try {
        if (!fs.statSync(entry).isFile()) {
          return false;
        }
        const ext = path.extname(entry).toLowerCase();
        if (!allowed.has(ext)) {
          return false;
        }
        const baseName = path.basename(entry).toLowerCase();
        if (/_clean\.(jpg|jpeg|png|webp|bmp|tif|tiff)$/i.test(baseName) || /_cutout\.png$/i.test(baseName)) {
          return false;
        }
        return true;
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

function sanitizeAlpha(buffer) {
  const output = Buffer.allocUnsafe(buffer.length);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < buffer.length; i += 1) {
    const value = Number.isFinite(buffer[i]) ? Number(buffer[i]) : 0;
    if (value < min) min = value;
    if (value > max) max = value;
  }

  const looksLikeProbability = min >= -0.01 && max <= 1.01;
  const looksLikeByteMask = min >= 0 && max <= 255;

  for (let i = 0; i < buffer.length; i += 1) {
    const rawValue = Number.isFinite(buffer[i]) ? Number(buffer[i]) : 0;
    let normalized;

    if (looksLikeProbability) {
      normalized = Math.max(0, Math.min(1, rawValue));
    } else if (looksLikeByteMask) {
      normalized = Math.max(0, Math.min(1, rawValue / 255));
    } else {
      normalized = 1 / (1 + Math.exp(-rawValue));
    }

    output[i] = Math.max(0, Math.min(255, Math.round(normalized * 255)));
  }

  return output;
}

function normalizeBackgroundMode(value) {
  const mode = String(value || 'transparent').trim().toLowerCase();
  return mode === 'white' ? 'white' : 'transparent';
}

function normalizeOutputRatio(value) {
  const ratio = String(value || 'original').trim();
  return ['original', '3:4', '9:16', '16:9', '1:1'].includes(ratio) ? ratio : 'original';
}

function getRuntimeLiteModelCandidates() {
  const runtimePlatform = process.platform === 'win32' ? 'windows' : 'mac';
  const candidates = [];

  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'runtime', runtimePlatform, 'rmbg-2.0-lite', 'model.onnx'));
    candidates.push(path.join(process.resourcesPath, 'runtime', 'common', 'rmbg-2.0-lite', 'model.onnx'));
  }

  candidates.push(path.join(path.dirname(__dirname), 'runtime', runtimePlatform, 'rmbg-2.0-lite', 'model.onnx'));
  candidates.push(path.join(path.dirname(__dirname), 'runtime', 'common', 'rmbg-2.0-lite', 'model.onnx'));
  candidates.push(path.join(__dirname, 'vendor', 'common', 'rmbg-2.0-lite', 'model.onnx'));
  candidates.push(path.join(process.cwd(), 'vendor', 'common', 'rmbg-2.0-lite', 'model.onnx'));

  return [...new Set(candidates)];
}

function resolveLiteModelPath(modelPath = '') {
  const candidates = [
    String(modelPath || '').trim(),
    ...getRuntimeLiteModelCandidates(),
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function computeCropBox(sourceSize, ratioKey) {
  if (ratioKey === 'original') {
    return {
      left: 0,
      top: 0,
      width: sourceSize.width,
      height: sourceSize.height,
    };
  }

  const ratioMap = {
    '3:4': [3, 4],
    '9:16': [9, 16],
    '16:9': [16, 9],
    '1:1': [1, 1],
  };
  const [ratioWidth, ratioHeight] = ratioMap[ratioKey] || [sourceSize.width, sourceSize.height];
  const sourceRatio = sourceSize.width / sourceSize.height;
  const targetRatio = ratioWidth / ratioHeight;

  let cropWidth = sourceSize.width;
  let cropHeight = sourceSize.height;

  if (sourceRatio > targetRatio) {
    cropWidth = Math.round(cropHeight * targetRatio);
  } else {
    cropHeight = Math.round(cropWidth / targetRatio);
  }

  cropWidth = Math.min(cropWidth, sourceSize.width);
  cropHeight = Math.min(cropHeight, sourceSize.height);

  return {
    left: Math.max(0, Math.floor((sourceSize.width - cropWidth) / 2)),
    top: Math.max(0, Math.floor((sourceSize.height - cropHeight) / 2)),
    width: cropWidth,
    height: cropHeight,
  };
}

function getOutputExtension(backgroundMode) {
  return backgroundMode === 'white' ? '.jpg' : '.png';
}

function buildOutputPath(outputFolder, imagePath, backgroundMode) {
  const extension = getOutputExtension(backgroundMode);
  const candidate = path.join(outputFolder, `${path.basename(imagePath, path.extname(imagePath))}${extension}`);

  if (path.resolve(candidate) !== path.resolve(imagePath) && !fs.existsSync(candidate)) {
    return candidate;
  }

  let index = 1;
  while (true) {
    const fallback = path.join(outputFolder, `${path.basename(imagePath, path.extname(imagePath))}_${index}${extension}`);
    if (path.resolve(fallback) !== path.resolve(imagePath) && !fs.existsSync(fallback)) {
      return fallback;
    }
    index += 1;
  }
}

async function resolveModelSession(modelPath, devicePreference = 'cpu') {
  ensureDependencies();
  const providerCandidates = getPreferredLiteProviders(devicePreference);
  const providerKey = providerCandidates.join('+');
  if (
    sessionCache.session
    && sessionCache.modelPath === modelPath
    && sessionCache.providerKey === providerKey
  ) {
    return sessionCache;
  }

  const cpuCount = Math.max(1, os.cpus?.().length || 1);
  const intraOpNumThreads = Math.max(2, Math.min(12, cpuCount));
  let session = null;
  let resolvedProvider = 'cpu';
  let lastError = null;

  for (const provider of providerCandidates) {
    try {
      session = await ort.InferenceSession.create(modelPath, {
        executionProviders: [provider],
        executionMode: 'sequential',
        graphOptimizationLevel: 'all',
        enableCpuMemArena: false,
        enableMemPattern: false,
        interOpNumThreads: 1,
        intraOpNumThreads,
      });
      resolvedProvider = provider;
      break;
    } catch (error) {
      lastError = error;
      if (provider === providerCandidates[providerCandidates.length - 1]) {
        throw error;
      }
    }
  }

  if (!session) {
    throw lastError || new Error('Failed to create ONNX Runtime session.');
  }

  const inputName = session.inputNames?.[0] || 'pixel_values';
  const outputName = session.outputNames?.includes('alphas')
    ? 'alphas'
    : (session.outputNames?.[0] || 'alphas');
  const inputMeta = session.inputMetadata?.[inputName];
  const dims = Array.isArray(inputMeta?.dimensions) ? inputMeta.dimensions : [];
  const height = Number.isFinite(dims?.[2]) ? Number(dims[2]) : DEFAULT_INPUT_SIZE;
  const width = Number.isFinite(dims?.[3]) ? Number(dims[3]) : DEFAULT_INPUT_SIZE;

  sessionCache = {
    modelPath,
    providerKey,
    resolvedProvider,
    session,
    inputName,
    outputName,
    width,
    height,
    intraOpNumThreads,
  };

  return sessionCache;
}

async function runLiteMask(imagePath, modelPath, devicePreference = 'cpu', sourceImage = null) {
  const sessionInfo = await resolveModelSession(modelPath, devicePreference);
  const source = sourceImage || await loadSourceImage(imagePath);
  const { width, height, channels, data } = source;

  if (!width || !height || channels < 3) {
    throw new Error('Failed to read source image pixels.');
  }

  const resized = await sharp(data, {
    raw: {
      width,
      height,
      channels,
    },
  })
    .resize(sessionInfo.width, sessionInfo.height, { fit: 'fill' })
    .raw()
    .toBuffer();

  const pixelCount = sessionInfo.width * sessionInfo.height;
  const tensorData = new Float32Array(pixelCount * 3);

  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * 3;
    const r = resized[offset] / 255;
    const g = resized[offset + 1] / 255;
    const b = resized[offset + 2] / 255;
    tensorData[index] = (r - MODEL_MEAN[0]) / MODEL_STD[0];
    tensorData[pixelCount + index] = (g - MODEL_MEAN[1]) / MODEL_STD[1];
    tensorData[(pixelCount * 2) + index] = (b - MODEL_MEAN[2]) / MODEL_STD[2];
  }

  const inputTensor = new ort.Tensor('float32', tensorData, [1, 3, sessionInfo.height, sessionInfo.width]);
  const outputMap = await sessionInfo.session.run({ [sessionInfo.inputName]: inputTensor });
  const outputTensor = outputMap?.[sessionInfo.outputName];
  if (!outputTensor?.data) {
    throw new Error('Lite RMBG output mask is empty.');
  }

  const alphaRaw = sanitizeAlpha(outputTensor.data);
  const alphaBuffer = await sharp(alphaRaw, {
    raw: {
      width: sessionInfo.width,
      height: sessionInfo.height,
      channels: 1,
    },
  })
    .resize(width, height, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer();

  return {
    width,
    height,
    alphaBuffer,
    executionProvider: sessionInfo.resolvedProvider || 'cpu',
    intraOpNumThreads: sessionInfo.intraOpNumThreads || 1,
  };
}

async function loadSourceImage(imagePath) {
  const source = await sharp(imagePath, { failOn: 'none' })
    .rotate()
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    width: source.info.width,
    height: source.info.height,
    channels: source.info.channels,
    data: source.data,
  };
}

async function renderOutput(sourceImage, alphaBuffer, backgroundMode, outputRatio) {
  const width = sourceImage?.width;
  const height = sourceImage?.height;
  const channels = sourceImage?.channels;
  const rgbBuffer = sourceImage?.data;

  if (!width || !height || channels < 3) {
    throw new Error('Failed to read source image pixels.');
  }
  if (!Buffer.isBuffer(alphaBuffer) || alphaBuffer.length !== width * height) {
    throw new Error('Lite RMBG alpha mask size does not match the source image.');
  }

  const rgbaBuffer = Buffer.allocUnsafe(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const rgbOffset = pixel * channels;
    const rgbaOffset = pixel * 4;
    rgbaBuffer[rgbaOffset] = rgbBuffer[rgbOffset];
    rgbaBuffer[rgbaOffset + 1] = rgbBuffer[rgbOffset + 1];
    rgbaBuffer[rgbaOffset + 2] = rgbBuffer[rgbOffset + 2];
    rgbaBuffer[rgbaOffset + 3] = alphaBuffer[pixel];
  }

  const cropBox = computeCropBox({ width, height }, outputRatio);
  const cutout = sharp(rgbaBuffer, {
    raw: {
      width,
      height,
      channels: 4,
    },
  }).extract(cropBox);

  if (backgroundMode === 'white') {
    const whiteBuffer = await cutout
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: 95 })
      .toBuffer();
    return {
      buffer: whiteBuffer,
      outputSize: {
        width: cropBox.width,
        height: cropBox.height,
      },
    };
  }

  const transparentBuffer = await cutout.png().toBuffer();
  return {
    buffer: transparentBuffer,
    outputSize: {
      width: cropBox.width,
      height: cropBox.height,
    },
  };
}

async function processGarmentImagesWithLiteOnnx(payload, hooks = {}) {
  ensureDependencies();

  const sourcePath = String(payload?.sourcePath || '').trim();
  const outputFolder = String(payload?.outputFolder || '').trim();
  const modelPath = resolveLiteModelPath(payload?.liteModelPath);
  const options = payload?.options || {};
  const backgroundMode = normalizeBackgroundMode(options.backgroundMode);
  const outputRatio = normalizeOutputRatio(options.outputRatio);
  const inferenceDevice = normalizeInferenceDevice(
    options.inferenceDevice || (process.platform === 'win32' ? 'auto' : 'cpu'),
  );

  if (!sourcePath) {
    throw new Error('No source path was provided.');
  }
  if (!outputFolder) {
    throw new Error('No output folder was provided.');
  }
  if (!modelPath) {
    throw new Error('Lite RMBG ONNX model file was not found.');
  }

  const imagePaths = listInputImages(sourcePath);
  if (!imagePaths.length) {
    throw new Error('No supported images were found.');
  }

  fs.mkdirSync(outputFolder, { recursive: true });
  hooks.emitLog?.(`Found ${imagePaths.length} image(s) to cut out.`);
  hooks.emitLog?.(
    process.platform === 'win32' && (inferenceDevice === 'gpu' || inferenceDevice === 'auto')
      ? 'Lite mode will try DirectML on Windows first, then fall back to CPU if needed.'
      : 'Lite mode is using local RMBG ONNX inference.',
    'info',
  );
  hooks.emitProgress?.(5);

  const items = [];
  const failures = [];
  const total = imagePaths.length;
  let loggedExecutionProvider = false;
  let nextSourcePromise = imagePaths[0] ? loadSourceImage(imagePaths[0]) : Promise.resolve(null);

  for (let index = 0; index < total; index += 1) {
    const imagePath = imagePaths[index];
    const name = path.basename(imagePath);
    hooks.throwIfCancelled?.();
    hooks.emitLog?.(`Cutting out ${name} (${index + 1}/${total})...`, 'info');

    try {
      const sourceImage = await nextSourcePromise;
      nextSourcePromise = imagePaths[index + 1] ? loadSourceImage(imagePaths[index + 1]) : Promise.resolve(null);
      const startedAt = Date.now();
      const maskResult = await runLiteMask(imagePath, modelPath, inferenceDevice, sourceImage);
      if (!loggedExecutionProvider) {
        loggedExecutionProvider = true;
        hooks.emitLog?.(
          maskResult.executionProvider === 'dml'
            ? 'Lite ONNX is running with DirectML GPU acceleration.'
            : `Lite ONNX is running on CPU (${maskResult.intraOpNumThreads || 1} threads).`,
          maskResult.executionProvider === 'dml' ? 'success' : 'warning',
        );
      }
      const rendered = await renderOutput(sourceImage, maskResult.alphaBuffer, backgroundMode, outputRatio);
      const outputPath = buildOutputPath(outputFolder, imagePath, backgroundMode);
      await fs.promises.writeFile(outputPath, rendered.buffer);
      const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);

      items.push({
        sourcePath: imagePath,
        outputs: [outputPath],
        cleanerMode: 'lite',
        processingEngine: 'rmbg-onnx',
        backgroundMode,
        outputRatio,
        inferenceDevice: maskResult.executionProvider === 'dml' ? 'gpu' : 'cpu',
        outputSize: rendered.outputSize,
      });
      hooks.emitLog?.(`Finished ${name} -> ${path.basename(outputPath)} (${elapsedSeconds}s)`, 'success');
    } catch (error) {
      failures.push({
        sourcePath: imagePath,
        reason: error?.message || String(error),
      });
      hooks.emitLog?.(`Failed ${name}: ${error?.message || String(error)}`, 'error');
    }

    hooks.emitProgress?.(5 + (((index + 1) / Math.max(1, total)) * 92));
  }

  hooks.emitProgress?.(100);
  return {
    success: items.length > 0,
    outputPath: outputFolder,
    processedCount: items.length,
    failedCount: failures.length,
    items,
    failures,
    processingEngine: 'rmbg-onnx',
  };
}

module.exports = {
  processGarmentImagesWithLiteOnnx,
};

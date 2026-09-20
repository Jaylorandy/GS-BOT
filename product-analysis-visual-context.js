const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const JSZip = require('jszip');

const { recognizeImageBuffer } = require('./rag-service');
const { buildFileSignature } = require('./processing-cache');
const runtimeResolver = require('./runtime-resolver');

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tif', '.tiff']);

// Safe JSON extraction from Python subprocess stdout.
// Python libraries may print warnings to stdout, corrupting the JSON protocol.
function safeParsePythonJson(stdout, contextLabel) {
  const trimmed = (stdout || '').trim();
  if (!trimmed) return {};

  try {
    return JSON.parse(trimmed);
  } catch (_) {
    // Fall through to line-by-line extraction
  }

  const lines = trimmed.split(/\r?\n/);
  const jsonLines = lines.filter(l => l.trim().startsWith('{'));

  let lastError = null;
  for (const line of jsonLines) {
    try {
      return JSON.parse(line.trim());
    } catch (e) {
      lastError = e;
    }
  }

  if (jsonLines.length > 0) {
    try {
      return JSON.parse(jsonLines.join('\n'));
    } catch (e) {
      lastError = e;
    }
  }

  // Regex fallback: extract JSON object from anywhere in the output
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (e) {
      lastError = e;
    }
    const lazyMatch = trimmed.match(/\{[\s\S]*?\}/);
    if (lazyMatch && lazyMatch[0] !== jsonMatch[0]) {
      try {
        return JSON.parse(lazyMatch[0]);
      } catch (e) {
        lastError = e;
      }
    }
  }

  const warnings = lines.filter(l => l.trim() && !l.trim().startsWith('{')).slice(0, 3);
  throw new Error(
    `Invalid JSON from ${contextLabel}: ${lastError?.message || 'no JSON found in output'}` +
    (warnings.length ? ` (non-JSON lines: ${warnings.map(w => w.trim().substring(0, 80)).join(' | ')})` : '')
  );
}
const VISUAL_CACHE_ROOT = path.join(os.tmpdir(), 'gsbot-product-analysis');
const PDF_FITZ_CACHE_ROOT = path.join(VISUAL_CACHE_ROOT, 'fitz');
const LABEL_FILE_HINTS = [
  'label',
  'hangtag',
  'hang-tag',
  'hang_tag',
  'tag',
  'ticket',
  'spec',
  'composition',
  'content',
  'fabric-info',
  'fabric_info',
  'fabricinfo',
  '标签',
  '吊牌',
  '面料',
];

function getPythonRuntime() {
  return runtimeResolver.findPythonRuntime();
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function hashContent(value) {
  return crypto.createHash('sha1').update(value).digest('hex');
}

function sanitizeFileSegment(value, fallback = 'image') {
  return String(value || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || fallback;
}

function inferImageExtension(name = '') {
  const ext = path.extname(String(name || '')).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext) ? ext : '.png';
}

function looksLikeExplicitLabelRecord(record = {}) {
  const haystack = [
    record.name,
    record.path,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return LABEL_FILE_HINTS.some((keyword) => haystack.includes(keyword));
}

function resolvePdfVisualExtractorScriptPath() {
  const resourcesPath = process.resourcesPath || '';
  const dirname = __dirname || process.cwd();
  const candidates = [
    resourcesPath ? path.join(resourcesPath, 'app.asar.unpacked', 'pdf_visual_extract.py') : '',
    path.join(dirname.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`), 'pdf_visual_extract.py'),
    path.join(dirname, 'pdf_visual_extract.py'),
  ].filter(Boolean);

  return candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  }) || '';
}

function buildPdfVisualOutputRoot(filePath, options = {}) {
  const persistKey = String(options.persistKey || filePath || '').trim();
  const renderKey = Array.isArray(options.renderPageNumbers)
    ? options.renderPageNumbers.join('-')
    : '';
  const imagePageKey = Array.isArray(options.pageNumbers)
    ? [...new Set(options.pageNumbers.map((value) => Number(value) || 0).filter((value) => value > 0))].join('-')
    : '';
  const cacheKey = hashContent([
    persistKey,
    renderKey,
    imagePageKey,
    options.includeImages ? 'images' : 'no-images',
    `scale:${Number(options.renderScale) || 2}`,
    `max:${Number(options.maxImages) || 0}`,
    `max-per-page:${Number(options.maxImagesPerPage) || 0}`,
    'v2',
  ].join('::'));
  const outputRoot = path.join(PDF_FITZ_CACHE_ROOT, sanitizeFileSegment(path.basename(filePath, path.extname(filePath))), cacheKey);
  ensureDir(outputRoot);
  return outputRoot;
}

async function runPdfVisualExtractor(filePath, options = {}) {
  const pythonRuntime = getPythonRuntime();
  if (!pythonRuntime) {
    throw new Error('Python 3 runtime not found for fitz PDF extraction.');
  }

  const scriptPath = resolvePdfVisualExtractorScriptPath();
  if (!scriptPath) {
    throw new Error('pdf_visual_extract.py was not found.');
  }

  const payload = {
    filePath,
    options: {
      ...options,
      outputRoot: options.outputRoot || buildPdfVisualOutputRoot(filePath, options),
    },
  };
  const outputRoot = String(payload.options.outputRoot || '').trim();
  const resultCachePath = outputRoot ? path.join(outputRoot, 'result.json') : '';
  const sourceSignature = buildFileSignature(filePath);

  if (resultCachePath && fs.existsSync(resultCachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(resultCachePath, 'utf8'));
      if (
        cached?.success !== false
        && cached?.cacheMeta
        && JSON.stringify(cached.cacheMeta.sourceSignature || {}) === JSON.stringify(sourceSignature)
      ) {
        options.emitLog?.(`Reusing cached PDF visual scan for ${path.basename(filePath)}.`, 'info');
        return cached;
      }
    } catch {
      // Ignore cache read failures and regenerate below.
    }
  }

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(
      pythonRuntime.command,
      [...pythonRuntime.args, scriptPath],
      {
        env: runtimeResolver.getPythonSpawnEnv(pythonRuntime),
        windowsHide: true,
      },
    );

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `fitz extractor exited with code ${code}`));
        return;
      }

      try {
        const parsed = safeParsePythonJson(stdout, 'fitz extractor');
        if (parsed?.success === false) {
          reject(new Error(parsed.error || 'fitz PDF extraction failed.'));
          return;
        }
        const nextResult = {
          ...parsed,
          cacheMeta: {
            sourceSignature,
          },
        };
        if (resultCachePath) {
          ensureDir(path.dirname(resultCachePath));
          fs.writeFileSync(resultCachePath, JSON.stringify(nextResult, null, 2), 'utf8');
        }
        resolve(nextResult);
      } catch (error) {
        reject(new Error(`fitz extractor returned invalid JSON: ${error.message}`));
      }
    });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

async function collectZipImagesFromFile(filePath, prefixes) {
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const imageEntries = Object.keys(zip.files)
    .filter((entry) => !zip.files[entry].dir)
    .filter((entry) => prefixes.some((prefix) => entry.startsWith(prefix)))
    .filter((entry) => IMAGE_EXTENSIONS.has(path.extname(entry).toLowerCase()))
    .sort((left, right) => left.localeCompare(right));

  const images = [];
  for (const entry of imageEntries) {
    const file = zip.file(entry);
    if (!file) {
      continue;
    }
    images.push({
      name: path.basename(entry),
      buffer: await file.async('nodebuffer'),
    });
  }
  return images;
}

function persistVisualRecord(namespace, groupKey, index, record) {
  if (record?.path && fs.existsSync(record.path)) {
    return record.path;
  }

  const outputDir = path.join(VISUAL_CACHE_ROOT, sanitizeFileSegment(namespace), sanitizeFileSegment(groupKey));
  ensureDir(outputDir);

  const ext = inferImageExtension(record.name);
  const baseName = sanitizeFileSegment(path.basename(record.name || `image-${index + 1}`, ext), `image-${index + 1}`);
  const filePath = path.join(outputDir, `${String(index + 1).padStart(3, '0')}_${baseName}${ext}`);

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, record.buffer);
  }

  return filePath;
}

async function ocrImageRecords(records, options = {}) {
  const ensureActive = options.ensureActive || (() => {});
  const emitLog = options.emitLog || (() => {});
  const maxImages = Number.isFinite(options.maxImages) ? options.maxImages : records.length;
  const limitedRecords = records.slice(0, Math.max(0, maxImages));
  const sections = [];
  const imagePaths = [];
  const imageRecords = [];
  const ocrMode = String(options.ocrMode || 'all').toLowerCase();

  for (let index = 0; index < limitedRecords.length; index += 1) {
    ensureActive();
    const record = limitedRecords[index];
    const buffer = record.buffer || (record.path ? fs.readFileSync(record.path) : null);
    if (!buffer) {
      continue;
    }
    const persistedPath = persistVisualRecord(
      options.persistNamespace || 'visual',
      options.persistKey || hashContent(Buffer.from(String(record.name || index))),
      index,
      { ...record, buffer },
    );
    imagePaths.push(persistedPath);
    imageRecords.push({
      name: String(record.name || path.basename(persistedPath)).trim(),
      path: persistedPath,
      pageNumber: Number(record.pageNumber) || 0,
      explicitLabel: looksLikeExplicitLabelRecord(record),
      bboxes: Array.isArray(record?.bboxes)
        ? record.bboxes.map((bbox) => ({
            x0: Number(bbox?.x0) || 0,
            y0: Number(bbox?.y0) || 0,
            x1: Number(bbox?.x1) || 0,
            y1: Number(bbox?.y1) || 0,
            width: Number(bbox?.width) || 0,
            height: Number(bbox?.height) || 0,
          }))
        : [],
    });

    const shouldRunOcr =
      ocrMode === 'all'
      || (ocrMode === 'explicit-labels' && looksLikeExplicitLabelRecord(record));

    if (!shouldRunOcr) {
      continue;
    }

    const shouldLogProgress =
      index === 0
      || index === limitedRecords.length - 1
      || ((index + 1) % 10 === 0);
    if (shouldLogProgress) {
      emitLog(
        `${options.logPrefix || 'Reviewing image'} ${index + 1}/${limitedRecords.length}: ${path.basename(record.name || persistedPath)}`,
        'info',
      );
    }

    try {
      const text = await recognizeImageBuffer(buffer, {
        languages: ['eng'],
        cacheNamespace: options.cacheNamespace || 'product-analysis-images',
        ocrEngine: options.ocrEngine,
        ocrFallbackEngine: options.ocrFallbackEngine,
      });
      if (String(text || '').trim()) {
        sections.push(`${record.name || path.basename(persistedPath)}\n${String(text).trim()}`);
      }
    } catch (error) {
      emitLog(`Skipping OCR for ${record.name || path.basename(persistedPath)}: ${error.message}`, 'warning');
    }
  }

  return {
    imagePaths,
    imageRecords,
    ocrSections: sections,
    ocrText: sections.join('\n\n'),
    imageCount: limitedRecords.length,
  };
}

async function buildPdfEmbeddedImageContext(filePath, options = {}) {
  const extracted = await runPdfVisualExtractor(filePath, {
    includeImages: true,
    maxImages: Number.isFinite(options.maxImages) ? options.maxImages : 120,
    maxImagesPerPage: Number.isFinite(options.maxImagesPerPage) ? options.maxImagesPerPage : 4,
    pageNumbers: Array.isArray(options.pageNumbers) ? options.pageNumbers : [],
    persistKey: options.persistKey || filePath,
    emitLog: options.emitLog,
  });
  const records = Array.isArray(extracted?.images) ? extracted.images : [];
  if (records.length === 0) {
    return { imagePaths: [], ocrSections: [], ocrText: '', imageCount: 0 };
  }

  return ocrImageRecords(records, {
    ...options,
    cacheNamespace: options.cacheNamespace || 'product-analysis-pdf-images',
    ocrMode: options.ocrMode || 'none',
    persistNamespace: options.persistNamespace || 'pdf',
    persistKey: options.persistKey || hashContent(filePath),
    logPrefix: options.logPrefix || 'OCR PDF image',
  });
}

async function extractPdfDocumentContext(filePath, options = {}) {
  const extracted = await runPdfVisualExtractor(filePath, {
    includeImages: false,
    renderPageNumbers: [],
    persistKey: options.persistKey || filePath,
    emitLog: options.emitLog,
  });

  const pages = Array.isArray(extracted?.pages)
    ? extracted.pages.map((page) => ({
        number: Number(page?.number) || 0,
        text: String(page?.text || '').trim(),
        lines: Array.isArray(page?.lines)
          ? page.lines.map((line) => String(line || '').trim()).filter(Boolean)
          : [],
        imageCount: Number(page?.imageCount) || 0,
        textBlocks: Array.isArray(page?.textBlocks)
          ? page.textBlocks.map((block) => ({
              index: Number(block?.index) || 0,
              text: String(block?.text || '').trim(),
              lines: Array.isArray(block?.lines)
                ? block.lines.map((line) => String(line || '').trim()).filter(Boolean)
                : [],
              bbox: block?.bbox && typeof block.bbox === 'object'
                ? {
                    x0: Number(block.bbox.x0) || 0,
                    y0: Number(block.bbox.y0) || 0,
                    x1: Number(block.bbox.x1) || 0,
                    y1: Number(block.bbox.y1) || 0,
                    width: Number(block.bbox.width) || 0,
                    height: Number(block.bbox.height) || 0,
                  }
                : null,
            }))
          : [],
      }))
    : [];

  return {
    text: pages.map((page) => page.text).filter(Boolean).join('\n\n'),
    pageCount: Number(extracted?.pageCount) || pages.length,
    pages,
  };
}

async function renderPdfPagesWithFitz(filePath, pageNumbers = [], options = {}) {
  const uniquePageNumbers = [...new Set(
    (Array.isArray(pageNumbers) ? pageNumbers : [])
      .map((value) => Number(value) || 0)
      .filter((value) => value > 0),
  )];

  if (uniquePageNumbers.length === 0) {
    return [];
  }

  const extracted = await runPdfVisualExtractor(filePath, {
    includeImages: false,
    renderPageNumbers: uniquePageNumbers,
    renderScale: Number(options.renderScale) || 2,
    persistKey: options.persistKey || `${filePath}::render`,
    emitLog: options.emitLog,
  });

  return (Array.isArray(extracted?.renderedPages) ? extracted.renderedPages : [])
    .map((page) => ({
      pageNumber: Number(page?.number) || 0,
      name: String(page?.name || path.basename(String(page?.path || ''))).trim(),
      path: String(page?.path || '').trim(),
      buffer: page?.path ? fs.readFileSync(page.path) : null,
    }))
    .filter((page) => page.pageNumber > 0 && page.buffer);
}

async function buildPptxImageContext(filePath, options = {}) {
  const records = await collectZipImagesFromFile(filePath, ['ppt/media/']);
  if (records.length === 0) {
    return { imagePaths: [], ocrSections: [], ocrText: '', imageCount: 0 };
  }

  return ocrImageRecords(records, {
    ...options,
    cacheNamespace: options.cacheNamespace || 'product-analysis-pptx-images',
    ocrMode: options.ocrMode || 'none',
    persistNamespace: options.persistNamespace || 'pptx',
    persistKey: options.persistKey || hashContent(filePath),
    logPrefix: options.logPrefix || 'OCR PPTX image',
  });
}

async function buildFolderImageContext(filePaths, options = {}) {
  const records = [];
  for (const filePath of filePaths) {
    try {
      const ext = path.extname(filePath).toLowerCase();
      if (!IMAGE_EXTENSIONS.has(ext)) {
        continue;
      }
      records.push({
        name: path.basename(filePath),
        buffer: fs.readFileSync(filePath),
      });
    } catch (error) {
      options.emitLog?.(`Skipping folder image ${filePath}: ${error.message}`, 'warning');
    }
  }

  if (records.length === 0) {
    return { imagePaths: [], ocrSections: [], ocrText: '', imageCount: 0 };
  }

  return ocrImageRecords(records, {
    ...options,
    cacheNamespace: options.cacheNamespace || 'product-analysis-folder-images',
    ocrMode: options.ocrMode || 'explicit-labels',
    persistNamespace: options.persistNamespace || 'folder',
    persistKey: options.persistKey || hashContent(filePaths.join('|')),
    logPrefix: options.logPrefix || 'OCR folder image',
  });
}

module.exports = {
  extractPdfDocumentContext,
  buildPdfEmbeddedImageContext,
  buildPptxImageContext,
  buildFolderImageContext,
  renderPdfPagesWithFitz,
  looksLikeExplicitLabelRecord,
};

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pdfParse = require('pdf-parse');
const XLSX = require('xlsx');
const JSZip = require('jszip');

const LLMClient = require('./llm-client');
const llmConfigManager = require('./llm-config');
const { normalizeOcrEngineName, runEnhancedTextOcr } = require('./label-ocr-engine');
const {
  getDefaultOcrEngine,
  getOcrEngineDisplayName,
} = require('./ocr-engine-config');

let nativeImage = null;
try {
  ({ nativeImage } = require('electron'));
} catch {
  nativeImage = null;
}

const RAG_ROOT = path.join(os.homedir(), '.gsbot', 'rag');
const COLLECTIONS_ROOT = path.join(RAG_ROOT, 'collections');
const MANIFEST_FILE = path.join(RAG_ROOT, 'collections.json');
const OCR_CACHE_ROOT = path.join(RAG_ROOT, 'ocr-cache');
const OCR_CACHE_FALLBACK_ROOT = path.join(os.tmpdir(), 'gsbot-ocr-cache');

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tif', '.tiff']);
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.csv', '.json', '.js', '.ts', '.jsx', '.tsx', '.css', '.html', '.xml', '.yml', '.yaml',
]);
const DOCUMENT_EXTENSIONS = new Set([
  '.pdf', '.docx', '.pptx', '.xlsx', '.xls',
]);
const SUPPORTED_EXTENSIONS = new Set([...IMAGE_EXTENSIONS, ...TEXT_EXTENSIONS, ...DOCUMENT_EXTENSIONS]);
const SKIPPED_DIRECTORY_NAMES = new Set(['.git', 'node_modules', '.next', '.nuxt', 'dist', 'build']);

const DEFAULT_COLLECTION_SETTINGS = {
  retrievalMode: 'fast',
  embeddingMode: 'local-hash',
  embeddingModel: 'nomic-embed-text',
  answerRoute: 'local',
  answerModel: '',
  ocrLanguages: ['eng', 'chi_sim'],
};

const RAG_RETRIEVAL_PRESETS = {
  fast: {
    chunkChars: 1100,
    chunkOverlap: 140,
    topK: 6,
  },
  deep: {
    chunkChars: 2200,
    chunkOverlap: 360,
    topK: 14,
  },
};

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function resolveWritableDir(preferredDir, fallbackDir) {
  const candidates = [preferredDir, fallbackDir].filter(Boolean);
  for (const candidate of candidates) {
    try {
      ensureDir(candidate);
      const probeFile = path.join(candidate, `.write-test-${process.pid}-${Date.now()}`);
      fs.writeFileSync(probeFile, 'ok', 'utf8');
      fs.unlinkSync(probeFile);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error(`No writable directory available. Tried: ${candidates.join(', ')}`);
}

function ensureRagRoot() {
  ensureDir(RAG_ROOT);
  ensureDir(COLLECTIONS_ROOT);
  ensureDir(OCR_CACHE_ROOT);
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function writeJsonl(filePath, items) {
  ensureDir(path.dirname(filePath));
  const payload = items.map((item) => JSON.stringify(item)).join('\n');
  fs.writeFileSync(filePath, payload ? `${payload}\n` : '', 'utf8');
}

function sanitizeText(text) {
  return String(text || '')
    .replace(/\u0000/g, '')
    .replace(/\uFFFD+/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/[^\S\n]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeXmlEntities(text) {
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(parseInt(code, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function xmlToPlainText(xml) {
  const withBreaks = String(xml || '')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/a:p>/g, '\n')
    .replace(/<\/text:p>/g, '\n')
    .replace(/<w:tab\/>/g, '\t')
    .replace(/<a:tab\/>/g, '\t');

  return sanitizeText(
    decodeXmlEntities(
      withBreaks
        .replace(/<[^>]+>/g, ' ')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/[ \t]{2,}/g, ' '),
    ),
  );
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'knowledge-base';
}

function uniq(items = []) {
  return [...new Set(items.filter(Boolean))];
}

function resolveRetrievalPreset(settings = {}) {
  const mode = settings.retrievalMode === 'deep' ? 'deep' : 'fast';
  return {
    mode,
    ...RAG_RETRIEVAL_PRESETS[mode],
  };
}

function resolveOcrLanguages(settings = {}) {
  const explicit = Array.isArray(settings.ocrLanguages)
    ? uniq(settings.ocrLanguages.map((item) => String(item || '').trim()).filter(Boolean))
    : [];
  const defaultLanguages = uniq(DEFAULT_COLLECTION_SETTINGS.ocrLanguages);
  const usesDefaultLanguageSet = explicit.length === defaultLanguages.length
    && explicit.every((language, index) => language === defaultLanguages[index]);

  if (explicit.length > 0 && !usesDefaultLanguageSet) {
    return explicit;
  }

  return settings.retrievalMode === 'deep'
    ? ['eng', 'chi_sim']
    : ['eng'];
}

function isDeepRetrievalMode(options = {}) {
  return options.retrievalMode === 'deep';
}

function hashContent(value) {
  return crypto.createHash('sha1').update(value).digest('hex');
}

function createId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function getCollectionDir(collectionId) {
  return path.join(COLLECTIONS_ROOT, collectionId);
}

function getCollectionMetaPath(collectionId) {
  return path.join(getCollectionDir(collectionId), 'collection.json');
}

function getCollectionFilesPath(collectionId) {
  return path.join(getCollectionDir(collectionId), 'files.jsonl');
}

function getCollectionChunksPath(collectionId) {
  return path.join(getCollectionDir(collectionId), 'chunks.jsonl');
}

function getCollectionTextsDir(collectionId) {
  return path.join(getCollectionDir(collectionId), 'texts');
}

function getCollectionImportsDir(collectionId) {
  return path.join(getCollectionDir(collectionId), 'imports');
}

function buildDefaultCollection(name = 'Knowledge Base') {
  return {
    id: createId('kb'),
    name: String(name || 'Knowledge Base').trim() || 'Knowledge Base',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sources: [],
    stats: {
      fileCount: 0,
      chunkCount: 0,
      totalChars: 0,
      ocrFiles: 0,
      indexedAt: null,
      lastDurationMs: 0,
    },
    settings: { ...DEFAULT_COLLECTION_SETTINGS },
  };
}

function loadManifest() {
  ensureRagRoot();
  return readJson(MANIFEST_FILE, { collections: [] });
}

function saveManifest(manifest) {
  writeJson(MANIFEST_FILE, manifest);
}

function listCollections() {
  const manifest = loadManifest();
  return [...(manifest.collections || [])]
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
}

function loadCollection(collectionId) {
  return readJson(getCollectionMetaPath(collectionId), null);
}

function saveCollection(collection) {
  const normalized = {
    ...collection,
    updatedAt: new Date().toISOString(),
    settings: {
      ...DEFAULT_COLLECTION_SETTINGS,
      ...(collection.settings || {}),
    },
  };

  writeJson(getCollectionMetaPath(normalized.id), normalized);

  const manifest = loadManifest();
  const summary = {
    id: normalized.id,
    name: normalized.name,
    updatedAt: normalized.updatedAt,
    createdAt: normalized.createdAt,
    stats: normalized.stats,
    sourceCount: Array.isArray(normalized.sources) ? normalized.sources.length : 0,
  };

  const existingIndex = manifest.collections.findIndex((item) => item.id === normalized.id);
  if (existingIndex >= 0) {
    manifest.collections[existingIndex] = summary;
  } else {
    manifest.collections.unshift(summary);
  }
  saveManifest(manifest);
  return normalized;
}

function createCollection(name) {
  ensureRagRoot();
  const collection = buildDefaultCollection(name);
  ensureDir(getCollectionDir(collection.id));
  ensureDir(getCollectionTextsDir(collection.id));
  ensureDir(getCollectionImportsDir(collection.id));
  saveCollection(collection);
  writeJsonl(getCollectionFilesPath(collection.id), []);
  writeJsonl(getCollectionChunksPath(collection.id), []);
  return collection;
}

function deleteCollection(collectionId) {
  const collectionDir = getCollectionDir(collectionId);
  if (fs.existsSync(collectionDir)) {
    fs.rmSync(collectionDir, { recursive: true, force: true });
  }

  const manifest = loadManifest();
  manifest.collections = (manifest.collections || []).filter((item) => item.id !== collectionId);
  saveManifest(manifest);
}

function updateCollection(collectionId, updater) {
  const current = loadCollection(collectionId);
  if (!current) {
    throw new Error('Knowledge base not found.');
  }

  const next = updater({ ...current });
  return saveCollection(next);
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.bmp') return 'image/bmp';
  if (ext === '.tif' || ext === '.tiff') return 'image/tiff';
  return 'image/jpeg';
}

function prepareImageForOcr(buffer, emitLog = null, options = {}) {
  if (!nativeImage) {
    return buffer;
  }

  const image = nativeImage.createFromBuffer(buffer);
  if (image.isEmpty()) {
    throw new Error('Embedded image buffer could not be decoded locally.');
  }

  try {
    const size = image.getSize();
    const maxEdge = Math.max(size.width || 0, size.height || 0);
    const targetMaxEdge = isDeepRetrievalMode(options) ? 1600 : 960;
    if (!maxEdge) {
      throw new Error('Embedded image has no readable dimensions.');
    }

    if (maxEdge <= targetMaxEdge) {
      emitLog?.(`Normalizing image for OCR (${size.width}x${size.height})`);
      return image.toPNG();
    }

    const scale = targetMaxEdge / maxEdge;
    const width = Math.max(1, Math.round(size.width * scale));
    const height = Math.max(1, Math.round(size.height * scale));
    emitLog?.(`Resizing image for OCR (${size.width}x${size.height} -> ${width}x${height})`);
    return image.resize({ width, height, quality: 'better' }).toPNG();
  } catch (error) {
    throw new Error(error.message || 'Could not normalize image for OCR.');
  }
}

async function recognizeImageBuffer(buffer, options = {}) {
  const {
    emitLog = null,
    cacheNamespace = 'ocr',
    onProgress = null,
  } = options;
  const ocrEngine = normalizeOcrEngineName(options.ocrEngine ?? options.engine ?? getDefaultOcrEngine());
  const fallbackEngine = normalizeOcrEngineName(options.ocrFallbackEngine ?? options.fallbackEngine ?? '', {
    allowEmpty: true,
  });

  const digest = hashContent(buffer);
  const cacheDir = resolveWritableDir(
    path.join(OCR_CACHE_ROOT, cacheNamespace, ocrEngine),
    path.join(OCR_CACHE_FALLBACK_ROOT, cacheNamespace, ocrEngine),
  );
  const cacheFile = path.join(cacheDir, `${digest}.txt`);
  ensureDir(cacheDir);

  if (fs.existsSync(cacheFile)) {
    onProgress?.({
      status: 'using cached OCR text',
      progress: 1,
    });
    return sanitizeText(fs.readFileSync(cacheFile, 'utf8'));
  }

  emitLog?.(`Using ${getOcrEngineDisplayName(ocrEngine)} engine.`);
  onProgress?.({
    status: 'OCR engine ready',
    progress: 0.02,
  });
  const preparedBuffer = prepareImageForOcr(buffer, emitLog, options);
  const preparedDigest = hashContent(preparedBuffer);
  const imageFile = path.join(cacheDir, `${preparedDigest}.png`);
  if (!fs.existsSync(imageFile)) {
    fs.writeFileSync(imageFile, preparedBuffer);
  }
  onProgress?.({
    status: 'starting text recognition',
    progress: 0.05,
  });

  let heartbeatProgress = 0.08;
  const heartbeat = setInterval(() => {
    heartbeatProgress = Math.min(0.92, heartbeatProgress + 0.03);
    onProgress?.({
      status: 'recognizing text',
      progress: heartbeatProgress,
    });
  }, 4000);

  let result;
  try {
    result = await runEnhancedTextOcr(imageFile, {
      minConfidence: 0.18,
      engine: ocrEngine,
      fallbackEngine,
    });
  } catch (error) {
    throw new Error(`Enhanced OCR failed: ${error.message}`);
  } finally {
    clearInterval(heartbeat);
  }
  const text = sanitizeText(result?.rawText || '');
  fs.writeFileSync(cacheFile, text, 'utf8');
  return text;
}

function findBufferSequence(buffer, sequence, startIndex) {
  for (let index = startIndex; index <= buffer.length - sequence.length; index += 1) {
    let matched = true;
    for (let offset = 0; offset < sequence.length; offset += 1) {
      if (buffer[index + offset] !== sequence[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return index;
    }
  }
  return -1;
}

function extractImagesFromPdf(buffer) {
  const images = [];
  const dedupe = new Set();

  const jpegStart = Buffer.from([0xff, 0xd8, 0xff]);
  const jpegEnd = Buffer.from([0xff, 0xd9]);
  const pngStart = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const pngEnd = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

  let cursor = 0;
  while (cursor < buffer.length) {
    const start = findBufferSequence(buffer, jpegStart, cursor);
    if (start === -1) {
      break;
    }
    const end = findBufferSequence(buffer, jpegEnd, start + jpegStart.length);
    if (end === -1) {
      break;
    }
    const content = buffer.slice(start, end + jpegEnd.length);
    const digest = hashContent(content);
    if (!dedupe.has(digest)) {
      dedupe.add(digest);
      images.push({ name: `pdf-image-${images.length + 1}.jpg`, mimeType: 'image/jpeg', buffer: content });
    }
    cursor = end + jpegEnd.length;
  }

  cursor = 0;
  while (cursor < buffer.length) {
    const start = findBufferSequence(buffer, pngStart, cursor);
    if (start === -1) {
      break;
    }
    const end = findBufferSequence(buffer, pngEnd, start + pngStart.length);
    if (end === -1) {
      break;
    }
    const content = buffer.slice(start, end + pngEnd.length);
    const digest = hashContent(content);
    if (!dedupe.has(digest)) {
      dedupe.add(digest);
      images.push({ name: `pdf-image-${images.length + 1}.png`, mimeType: 'image/png', buffer: content });
    }
    cursor = end + pngEnd.length;
  }

  return images;
}

async function collectZipImages(zip, prefixes) {
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
      mimeType: getMimeType(entry),
      buffer: await file.async('nodebuffer'),
    });
  }
  return images;
}

function parseSpreadsheet(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const sections = [];

  for (const sheetName of workbook.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
      header: 1,
      blankrows: false,
      raw: false,
    });

    const body = rows
      .map((row) => row.map((cell) => String(cell ?? '')).join('\t'))
      .join('\n')
      .trim();

    if (body) {
      sections.push(`Sheet: ${sheetName}\n${body}`);
    }
  }

  return sanitizeText(sections.join('\n\n'));
}

async function parseDocx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const documentEntries = Object.keys(zip.files)
    .filter((entry) => !zip.files[entry].dir)
    .filter((entry) => /^word\/(document|header\d+|footer\d+|footnotes|endnotes|comments\d*)\.xml$/i.test(entry))
    .sort((left, right) => left.localeCompare(right));

  const parts = [];
  for (const entry of documentEntries) {
    const file = zip.file(entry);
    if (!file) {
      continue;
    }
    const xml = await file.async('string');
    const label = path.basename(entry, '.xml').replace(/\d+/g, '').replace(/^./, (char) => char.toUpperCase());
    const text = xmlToPlainText(xml);
    if (text) {
      parts.push(`${label}\n${text}`);
    }
  }

  const images = await collectZipImages(zip, ['word/media/']);
  return {
    text: sanitizeText(parts.join('\n\n')),
    images,
  };
}

async function parsePptx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const slideEntries = Object.keys(zip.files)
    .filter((entry) => !zip.files[entry].dir)
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/i.test(entry) || /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(entry))
    .sort((left, right) => left.localeCompare(right));

  const parts = [];
  for (const entry of slideEntries) {
    const file = zip.file(entry);
    if (!file) {
      continue;
    }
    const xml = await file.async('string');
    const slideIndex = entry.match(/(\d+)\.xml$/)?.[1] || '?';
    const label = entry.includes('/notesSlides/')
      ? `Slide Notes ${slideIndex}`
      : `Slide ${slideIndex}`;
    const text = xmlToPlainText(xml);
    if (text) {
      parts.push(`${label}\n${text}`);
    }
  }

  const images = await collectZipImages(zip, ['ppt/media/']);
  return {
    text: sanitizeText(parts.join('\n\n')),
    images,
  };
}

function isProbablyTextBuffer(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 2048));
  let zeroBytes = 0;
  for (const value of sample) {
    if (value === 0) {
      zeroBytes += 1;
    }
  }
  return zeroBytes <= sample.length * 0.05;
}

function parsePlainText(buffer, extension) {
  const text = buffer.toString('utf8');
  if (extension === '.json') {
    try {
      return sanitizeText(JSON.stringify(JSON.parse(text), null, 2));
    } catch {
      return sanitizeText(text);
    }
  }
  return sanitizeText(text);
}

async function ocrImageList(images, options = {}) {
  const sections = [];

  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    if (!image?.buffer || image.buffer.length === 0) {
      continue;
    }

    options.onStage?.('ocr-image', {
      imageIndex: index + 1,
      imageTotal: images.length,
      imageName: image.name,
    });

    try {
      const text = await recognizeImageBuffer(image.buffer, {
        ...options,
        onProgress: (progress) => {
          options.onStage?.('ocr', {
            imageIndex: index + 1,
            imageTotal: images.length,
            imageName: image.name,
            ...progress,
          });
        },
      });
      if (text) {
        sections.push(`${image.name}\n${text}`);
      }
    } catch (error) {
      options.emitLog?.(`Skipping OCR for ${image.name}: ${error.message}`);
    }
  }

  return sections;
}

async function parseFile(filePath, options = {}) {
  const stats = fs.statSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const buffer = fs.readFileSync(filePath);
  const textSections = [];
  let ocrImageCount = 0;

  if (IMAGE_EXTENSIONS.has(ext)) {
    if (!isDeepRetrievalMode(options)) {
      options.emitLog?.('Fast mode uses quick OCR for images.');
    }
    options.onStage?.('ocr-image', {
      imageIndex: 1,
      imageTotal: 1,
      imageName: path.basename(filePath),
    });
    const text = await recognizeImageBuffer(buffer, {
      ...options,
      cacheNamespace: 'image-files',
      onProgress: (progress) => {
        options.onStage?.('ocr', {
          imageIndex: 1,
          imageTotal: 1,
          imageName: path.basename(filePath),
          ...progress,
        });
      },
    });
    if (text) {
      textSections.push(`OCR\n${text}`);
      ocrImageCount += 1;
    }
  } else if (ext === '.pdf') {
    try {
      const parsed = await pdfParse(buffer);
      if (parsed?.text) {
        textSections.push(`PDF text\n${sanitizeText(parsed.text)}`);
      }
    } catch (error) {
      textSections.push(`PDF text extraction warning\n${error.message}`);
    }

    if (!isDeepRetrievalMode(options)) {
      options.emitLog?.('Fast mode uses quick OCR for embedded PDF images.');
    }
    const ocrSections = await ocrImageList(extractImagesFromPdf(buffer), { ...options, cacheNamespace: 'pdf-images' });
    ocrImageCount += ocrSections.length;
    if (ocrSections.length > 0) {
      textSections.push(`OCR from embedded PDF images\n${ocrSections.join('\n\n')}`);
    }
  } else if (ext === '.docx') {
    const result = await parseDocx(buffer);
    if (result.text) {
      textSections.push(`DOCX text\n${result.text}`);
    }
    if (!isDeepRetrievalMode(options)) {
      options.emitLog?.('Fast mode uses quick OCR for embedded DOCX images.');
    }
    const ocrSections = await ocrImageList(result.images, { ...options, cacheNamespace: 'docx-images' });
    ocrImageCount += ocrSections.length;
    if (ocrSections.length > 0) {
      textSections.push(`OCR from embedded DOCX images\n${ocrSections.join('\n\n')}`);
    }
  } else if (ext === '.pptx') {
    const result = await parsePptx(buffer);
    if (result.text) {
      textSections.push(`PPTX text\n${result.text}`);
    }
    if (!isDeepRetrievalMode(options)) {
      options.emitLog?.('Fast mode uses quick OCR for embedded PPTX images.');
    }
    const ocrSections = await ocrImageList(result.images, { ...options, cacheNamespace: 'pptx-images' });
    ocrImageCount += ocrSections.length;
    if (ocrSections.length > 0) {
      textSections.push(`OCR from embedded PPTX images\n${ocrSections.join('\n\n')}`);
    }
  } else if (ext === '.xlsx' || ext === '.xls') {
    const spreadsheetText = parseSpreadsheet(buffer);
    if (spreadsheetText) {
      textSections.push(`Spreadsheet\n${spreadsheetText}`);
    }
  } else if (TEXT_EXTENSIONS.has(ext) || isProbablyTextBuffer(buffer)) {
    const text = parsePlainText(buffer, ext);
    if (text) {
      textSections.push(text);
    }
  }

  const fullText = sanitizeText(textSections.join('\n\n'));

  return {
    id: createId('file'),
    filePath,
    name: path.basename(filePath),
    extension: ext,
    sizeBytes: stats.size,
    modifiedAt: stats.mtime.toISOString(),
    hash: hashContent(buffer),
    fullText,
    totalChars: fullText.length,
    ocrImageCount,
  };
}

function splitTextIntoChunks(text, options = {}) {
  const normalized = sanitizeText(text);
  if (!normalized) {
    return [];
  }

  const preset = resolveRetrievalPreset(options);
  const chunkChars = Math.max(400, preset.chunkChars);
  const chunkOverlap = Math.max(0, Math.min(chunkChars - 50, preset.chunkOverlap));
  const chunks = [];
  let cursor = 0;

  while (cursor < normalized.length) {
    let end = Math.min(normalized.length, cursor + chunkChars);
    if (end < normalized.length) {
      const minimumBoundary = cursor + Math.floor(chunkChars * 0.6);
      const candidates = [
        normalized.lastIndexOf('\n\n', end),
        normalized.lastIndexOf('\n', end),
        normalized.lastIndexOf('。', end),
        normalized.lastIndexOf('. ', end),
      ].filter((position) => position >= minimumBoundary);

      if (candidates.length > 0) {
        end = Math.max(...candidates);
      }
    }

    const chunkText = sanitizeText(normalized.slice(cursor, end));
    if (chunkText) {
      chunks.push(chunkText);
    }

    if (end >= normalized.length) {
      break;
    }

    const nextCursor = Math.max(end - chunkOverlap, cursor + 1);
    cursor = nextCursor;
  }

  return chunks;
}

function extractChunkAnchorLabel(chunkText, chunkIndex) {
  const lines = String(chunkText || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const firstLine = lines.find((line) => line.length >= 4) || lines[0] || '';
  if (!firstLine) {
    return `Chunk ${chunkIndex + 1}`;
  }

  const compact = firstLine.replace(/\s+/g, ' ').trim();
  if (compact.length <= 72) {
    return compact;
  }

  return `${compact.slice(0, 69).trim()}...`;
}

function splitTextIntoChunkRecords(text, options = {}) {
  const normalized = sanitizeText(text);
  if (!normalized) {
    return [];
  }

  const preset = resolveRetrievalPreset(options);
  const chunkChars = Math.max(400, preset.chunkChars);
  const chunkOverlap = Math.max(0, Math.min(chunkChars - 50, preset.chunkOverlap));
  const chunks = [];
  let cursor = 0;

  while (cursor < normalized.length) {
    let end = Math.min(normalized.length, cursor + chunkChars);
    if (end < normalized.length) {
      const minimumBoundary = cursor + Math.floor(chunkChars * 0.6);
      const candidates = [
        normalized.lastIndexOf('\n\n', end),
        normalized.lastIndexOf('\n', end),
        normalized.lastIndexOf('。', end),
        normalized.lastIndexOf('. ', end),
      ].filter((position) => position >= minimumBoundary);

      if (candidates.length > 0) {
        end = Math.max(...candidates);
      }
    }

    const chunkText = sanitizeText(normalized.slice(cursor, end));
    if (chunkText) {
      const chunkIndex = chunks.length;
      chunks.push({
        text: chunkText,
        chunkIndex,
        startOffset: cursor,
        endOffset: Math.max(cursor, end),
        anchorLabel: extractChunkAnchorLabel(chunkText, chunkIndex),
      });
    }

    if (end >= normalized.length) {
      break;
    }

    const nextCursor = Math.max(end - chunkOverlap, cursor + 1);
    cursor = nextCursor;
  }

  return chunks;
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .match(/[\p{L}\p{N}][\p{L}\p{N}_-]*/gu) || [];
}

function hashTokenToVector(token, dimensions) {
  const digest = crypto.createHash('sha1').update(token).digest();
  const positionA = digest.readUInt16BE(0) % dimensions;
  const positionB = digest.readUInt16BE(2) % dimensions;
  const signA = digest[4] % 2 === 0 ? 1 : -1;
  const signB = digest[5] % 2 === 0 ? 1 : -1;
  return [
    [positionA, signA],
    [positionB, signB],
  ];
}

function normalizeVector(vector) {
  let sumSquares = 0;
  for (const value of vector) {
    sumSquares += value * value;
  }
  const length = Math.sqrt(sumSquares) || 1;
  return vector.map((value) => Number((value / length).toFixed(6)));
}

function buildHashedEmbedding(text, dimensions = 192) {
  const vector = new Array(dimensions).fill(0);
  const frequencies = new Map();

  for (const token of tokenize(text)) {
    frequencies.set(token, (frequencies.get(token) || 0) + 1);
  }

  for (const [token, frequency] of frequencies.entries()) {
    const weighted = 1 + Math.log1p(frequency);
    for (const [position, sign] of hashTokenToVector(token, dimensions)) {
      vector[position] += sign * weighted;
    }
  }

  return normalizeVector(vector);
}

async function embedTexts(texts, settings, emitLog = null) {
  const list = texts.map((text) => sanitizeText(text));
  if (settings.embeddingMode !== 'ollama') {
    emitLog?.(`Building local hash vectors for ${list.length} chunk${list.length > 1 ? 's' : ''}.`);
    return list.map((text) => buildHashedEmbedding(text));
  }

  const config = llmConfigManager.loadConfig();
  if (!config.local?.baseUrl || !settings.embeddingModel) {
    emitLog?.('Ollama embeddings are not configured. Falling back to local hashed vectors.');
    return list.map((text) => buildHashedEmbedding(text));
  }

  try {
    const client = new LLMClient({
      baseUrl: config.local.baseUrl,
      model: settings.embeddingModel,
      timeout: 300000,
    });
    const data = await client._requestJson('POST', '/api/embed', {
      model: settings.embeddingModel,
      input: list,
    });
    const embeddings = Array.isArray(data?.embeddings) ? data.embeddings : [];
    if (embeddings.length === list.length) {
      return embeddings.map((vector) => normalizeVector(vector.map((value) => Number(value) || 0)));
    }
  } catch (error) {
    emitLog?.(`Ollama embeddings unavailable (${error.message}). Falling back to local hashed vectors.`);
  }

  return list.map((text) => buildHashedEmbedding(text));
}

function cosineSimilarity(left, right) {
  const length = Math.min(left.length, right.length);
  let sum = 0;
  for (let index = 0; index < length; index += 1) {
    sum += (Number(left[index]) || 0) * (Number(right[index]) || 0);
  }
  return sum;
}

function keywordScore(queryTokens, chunkText) {
  if (queryTokens.length === 0) {
    return 0;
  }

  const haystack = chunkText.toLowerCase();
  let matches = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) {
      matches += token.length >= 6 ? 2 : 1;
    }
  }
  return matches / (queryTokens.length * 2);
}

function buildPromptContext(results, options = {}) {
  if (options.retrievalMode === 'deep') {
    const documentMap = new Map((options.documents || []).map((item) => [item.id, item]));
    const sections = [];
    const usedDocuments = new Set();

    for (const item of results) {
      if (usedDocuments.has(item.documentId)) {
        continue;
      }

      usedDocuments.add(item.documentId);
      const source = item.relativePath || item.name;
      const document = documentMap.get(item.documentId);
      let fullText = item.text;

      if (document?.textFilePath && fs.existsSync(document.textFilePath)) {
        fullText = sanitizeText(fs.readFileSync(document.textFilePath, 'utf8')) || item.text;
      }

      sections.push([
        `Full source ${sections.length + 1}: ${source}`,
        `Score: ${item.score.toFixed(4)}`,
        fullText,
      ].join('\n'));

      if (sections.length >= 3) {
        break;
      }
    }

    if (sections.length > 0) {
      return sections.join('\n\n---\n\n');
    }
  }

  return results.map((item, index) => {
    const source = item.relativePath || item.name;
    return [
      `Source ${index + 1}: ${source}`,
      `Score: ${item.score.toFixed(4)}`,
      item.text,
    ].join('\n');
  }).join('\n\n---\n\n');
}

function extractContextSlice(fullText, startOffset = 0, endOffset = 0) {
  const source = sanitizeText(fullText);
  if (!source) {
    return '';
  }

  const safeStart = Math.max(0, Math.min(source.length, Number(startOffset) || 0));
  const safeEnd = Math.max(safeStart, Math.min(source.length, Number(endOffset) || safeStart));
  let contextStart = Math.max(0, safeStart - 320);
  let contextEnd = Math.min(source.length, safeEnd + 320);

  const prevBreak = source.lastIndexOf('\n\n', safeStart);
  if (prevBreak >= 0 && prevBreak >= safeStart - 800) {
    contextStart = prevBreak;
  }

  const nextBreak = source.indexOf('\n\n', safeEnd);
  if (nextBreak >= 0 && nextBreak <= safeEnd + 800) {
    contextEnd = nextBreak;
  }

  return sanitizeText(source.slice(contextStart, contextEnd));
}

function buildReferenceEntries(results, documents = []) {
  const documentMap = new Map((documents || []).map((item) => [item.id, item]));
  const references = [];
  const seen = new Set();

  for (const item of results || []) {
    const key = `${item.documentId || item.relativePath || item.name}:${item.chunkIndex ?? 0}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    const document = documentMap.get(item.documentId);
    let fullText = '';
    if (document?.textFilePath && fs.existsSync(document.textFilePath)) {
      try {
        fullText = fs.readFileSync(document.textFilePath, 'utf8');
      } catch {
        fullText = '';
      }
    }

    const quote = sanitizeText(item.text || '');
    const hasOffsets = Number.isFinite(item.startOffset) && Number.isFinite(item.endOffset);
    const context = hasOffsets
      ? (extractContextSlice(fullText, item.startOffset, item.endOffset) || quote)
      : quote;
    references.push({
      id: key,
      relativePath: item.relativePath || item.name || document?.relativePath || document?.name || 'Source',
      path: document?.path || item.path || '',
      extension: document?.extension || item.extension || '',
      anchorLabel: item.anchorLabel || `Chunk ${(item.chunkIndex || 0) + 1}`,
      chunkIndex: item.chunkIndex || 0,
      quote,
      context,
      score: Number(item.score || 0),
    });

    if (references.length >= 8) {
      break;
    }
  }

  return references;
}

function splitRelativePath(relativePath = '') {
  return String(relativePath || '')
    .split(/[\\/]+/)
    .map((segment) => String(segment || '').trim())
    .filter(Boolean);
}

const GENERIC_STYLE_FOLDERS = new Set([
  'images',
  'image',
  'img',
  'photos',
  'photo',
  'uploads',
  'upload',
  'files',
  'file',
  'assets',
  'asset',
  'raw',
  'processed',
]);

function normalizeKey(value = '') {
  return String(value || '').trim().toLowerCase();
}

function stripExtension(fileName = '') {
  return String(fileName || '').replace(/\.[^.]+$/, '');
}

function extractFilenameStyleToken(fileName = '') {
  const stem = stripExtension(path.basename(fileName || ''));
  if (!stem) {
    return '';
  }

  const withoutInfo = stem.replace(/([_-]info)$/i, '');
  if (withoutInfo.includes('_')) {
    const candidate = withoutInfo.split('_')[0].trim();
    return candidate || withoutInfo;
  }

  return withoutInfo.trim();
}

function resolveStyleFolder(relativePath = '') {
  const segments = splitRelativePath(relativePath);
  if (segments.length < 3) {
    return { brand: '', style: '' };
  }

  const style = String(segments[segments.length - 2] || '').trim();
  const brand = String(segments[segments.length - 3] || '').trim();
  if (!style || GENERIC_STYLE_FOLDERS.has(style.toLowerCase())) {
    return { brand, style: '' };
  }

  return { brand, style };
}

function computeImageFingerprint(buffer) {
  if (!nativeImage || !buffer || buffer.length === 0) {
    return '';
  }

  try {
    const image = nativeImage.createFromBuffer(buffer);
    if (image.isEmpty()) {
      return '';
    }

    const bitmap = image.resize({ width: 8, height: 8, quality: 'better' }).toBitmap();
    if (!bitmap || bitmap.length < 8 * 8 * 4) {
      return '';
    }

    const grayscale = [];
    for (let index = 0; index < bitmap.length; index += 4) {
      const blue = bitmap[index];
      const green = bitmap[index + 1];
      const red = bitmap[index + 2];
      const alpha = bitmap[index + 3];
      const gray = alpha === 0 ? 255 : Math.round((red * 299 + green * 587 + blue * 114) / 1000);
      grayscale.push(gray);
    }

    const average = grayscale.reduce((sum, value) => sum + value, 0) / grayscale.length;
    const bits = grayscale.map((value) => (value >= average ? '1' : '0')).join('');
    let hex = '';
    for (let index = 0; index < bits.length; index += 4) {
      hex += parseInt(bits.slice(index, index + 4), 2).toString(16);
    }
    return hex;
  } catch {
    return '';
  }
}

function fingerprintSimilarity(left = '', right = '') {
  if (!left || !right || left.length !== right.length) {
    return 0;
  }

  let same = 0;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] === right[index]) {
      same += 1;
    }
  }
  return same / left.length;
}

function resolveDocumentStyleMetadata(document = {}) {
  const relativePath = document.relativePath || document.name || '';
  const fileName = path.basename(relativePath || document.name || '');
  const { brand, style: folderStyle } = resolveStyleFolder(relativePath);
  const filenameStyle = extractFilenameStyleToken(fileName);
  return {
    brand,
    folderStyle,
    filenameStyle,
    normalizedBrand: normalizeKey(brand),
  };
}

function ensureDocumentVisualFingerprint(document = {}) {
  if (document.visualFingerprint) {
    return document.visualFingerprint;
  }

  const ext = String(document.extension || path.extname(document.path || document.relativePath || document.name || '') || '').toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext)) {
    return '';
  }

  const targetPath = document.path;
  if (!targetPath || !fs.existsSync(targetPath)) {
    return '';
  }

  try {
    const fingerprint = computeImageFingerprint(fs.readFileSync(targetPath));
    if (fingerprint) {
      document.visualFingerprint = fingerprint;
    }
    return fingerprint;
  } catch {
    return '';
  }
}

function buildStyleInventory(documents = []) {
  const groups = [];
  const styleMap = new Map();

  for (const document of documents) {
    const relativePath = document.relativePath || document.name || '';
    const fileName = path.basename(relativePath || document.name || '');
    const {
      brand,
      folderStyle,
      filenameStyle,
      normalizedBrand,
    } = resolveDocumentStyleMetadata(document);
    const ext = String(document.extension || path.extname(fileName) || '').toLowerCase();
    const folderKey = folderStyle ? `${normalizedBrand}__folder__${normalizeKey(folderStyle)}` : '';
    const filenameKey = filenameStyle ? `${normalizedBrand}__file__${normalizeKey(filenameStyle)}` : '';
    const visualFingerprint = ensureDocumentVisualFingerprint(document);

    let entry = null;
    if (folderKey && styleMap.has(folderKey)) {
      entry = styleMap.get(folderKey);
    } else if (filenameKey && styleMap.has(filenameKey)) {
      entry = styleMap.get(filenameKey);
    } else if (visualFingerprint) {
      entry = groups.find((group) => normalizeKey(group.brand) === normalizedBrand
        && group.fingerprints.some((fingerprint) => fingerprintSimilarity(fingerprint, visualFingerprint) >= 0.92));
    }

    if (!entry) {
      entry = {
        brand,
        style: folderStyle || filenameStyle || fileName,
        imageCount: 0,
        fileCount: 0,
        textCount: 0,
        paths: [],
        fingerprints: [],
        groupingSource: folderStyle ? 'folder' : (filenameStyle ? 'filename' : 'visual'),
      };
      groups.push(entry);
    }

    if (folderKey) {
      styleMap.set(folderKey, entry);
      if (!entry.style || entry.groupingSource !== 'folder') {
        entry.style = folderStyle;
        entry.groupingSource = 'folder';
      }
    }

    if (filenameKey) {
      styleMap.set(filenameKey, entry);
      if (!entry.style) {
        entry.style = filenameStyle;
      }
    }

    entry.fileCount += 1;
    entry.paths.push(relativePath);
    if (visualFingerprint && !entry.fingerprints.includes(visualFingerprint)) {
      entry.fingerprints.push(visualFingerprint);
    }

    if (IMAGE_EXTENSIONS.has(ext)) {
      entry.imageCount += 1;
    } else {
      entry.textCount += 1;
    }
  }

  return groups.sort((left, right) => {
    if (left.brand !== right.brand) {
      return left.brand.localeCompare(right.brand);
    }
    return left.style.localeCompare(right.style);
  });
}

function detectInventoryQuestion(question = '') {
  const normalized = String(question || '').toLowerCase();
  const asksCount = /(\bhow many\b|\bcount\b|多少|几个|几款|几個)/i.test(question);
  const asksStyle = /(\bstyle\b|\bstyles\b|\bsku\b|\bmodel\b|款式|款号|款號|款)/i.test(question);
  const asksImage = /(\bimage\b|\bimages\b|\bphoto\b|\bphotos\b|图片|照片|带图|帶圖)/i.test(question);

  return {
    asksCount,
    asksStyle,
    asksImage,
    normalized,
  };
}

function resolveBrandFilter(question = '', inventory = []) {
  const normalized = String(question || '').toLowerCase();
  const brands = uniq(inventory.map((item) => item.brand).filter(Boolean));
  return brands.find((brand) => normalized.includes(String(brand).toLowerCase())) || '';
}

function tryAnswerInventoryQuestion(question, documents = []) {
  const inventory = buildStyleInventory(documents);
  const intent = detectInventoryQuestion(question);
  if (!intent.asksCount || !intent.asksStyle) {
    return null;
  }

  const brandFilter = resolveBrandFilter(question, inventory);
  const scoped = inventory.filter((item) => {
    if (brandFilter && item.brand !== brandFilter) {
      return false;
    }
    if (intent.asksImage) {
      return item.imageCount > 0;
    }
    return true;
  });

  const count = scoped.length;
  const label = brandFilter || 'the knowledge base';
  const qualifier = intent.asksImage ? 'with images' : '';
  const styleLines = scoped.slice(0, 12).map((item) => {
    const parts = [`${item.style}`];
    if (item.imageCount > 0) {
      parts.push(`${item.imageCount} image${item.imageCount > 1 ? 's' : ''}`);
    }
    if (item.textCount > 0) {
      parts.push(`${item.textCount} text file${item.textCount > 1 ? 's' : ''}`);
    }
    return `- ${parts.join(' · ')}`;
  });

  const intro = brandFilter
    ? `${brandFilter} has ${count} style${count === 1 ? '' : 's'} ${qualifier}`.trim()
    : `The knowledge base has ${count} style${count === 1 ? '' : 's'} ${qualifier}`.trim();

  const explanation = brandFilter
    ? `This count groups files in three passes: style folder first, then matching style numbers in file names, then image similarity inside the same ${brandFilter} brand when folder and file naming are not enough.`
    : 'This count groups files in three passes: style folder first, then matching style numbers in file names, then image similarity inside the same brand when folder and file naming are not enough.';

  const documentMap = new Map(documents.map((document) => [document.relativePath || document.name, document]));
  const references = scoped.slice(0, 8).map((item, index) => {
    const relativePath = item.paths[0] || `${item.brand}/${item.style}`;
    const document = documentMap.get(relativePath) || {};
    let quote = '';

    if (document.textFilePath && fs.existsSync(document.textFilePath)) {
      try {
        quote = sanitizeText(fs.readFileSync(document.textFilePath, 'utf8')).slice(0, 320);
      } catch {
        quote = '';
      }
    }

    return {
      id: `inventory:${normalizeKey(item.brand)}:${normalizeKey(item.style)}:${index + 1}`,
      relativePath,
      path: document.path || '',
      extension: document.extension || path.extname(relativePath) || '',
      anchorLabel: item.groupingSource === 'folder'
        ? `Style folder ${item.style}`
        : (item.groupingSource === 'filename' ? `Style token ${item.style}` : `Visual match ${item.style}`),
      chunkIndex: 0,
      quote: quote || `${item.brand}/${item.style} · ${item.imageCount} images · ${item.textCount} text files`,
      context: quote || `${item.brand}/${item.style} · ${item.imageCount} images · ${item.textCount} text files`,
      score: 1,
    };
  });

  return {
    answer: [
      `${intro}.`,
      explanation,
      styleLines.length > 0 ? `Detected style folders:\n${styleLines.join('\n')}` : '',
    ].filter(Boolean).join('\n\n'),
    citations: scoped.flatMap((item) => item.paths.slice(0, 2)).slice(0, 12),
    references,
    retrieval: scoped.slice(0, 12).map((item) => ({
      name: item.style,
      relativePath: `${item.brand}/${item.style}`,
      score: 1,
      snippet: `${item.brand}/${item.style} · ${item.imageCount} images · ${item.textCount} text files`,
    })),
    provider: 'Inventory',
  };
}

function getDirectCollectionAnswer(collectionId, question) {
  const collection = loadCollection(collectionId);
  if (!collection) {
    throw new Error('Knowledge base not found.');
  }

  const documents = readJsonl(getCollectionFilesPath(collectionId));
  const directInventoryAnswer = tryAnswerInventoryQuestion(question, documents);
  if (!directInventoryAnswer) {
    return null;
  }

  return {
    ...directInventoryAnswer,
    collection,
  };
}

function getAppAnswerConfig() {
  const config = llmConfigManager.mergeWithDefaults(llmConfigManager.loadConfig());
  if (config.mode === 'cloud') {
    return {
      baseUrl: config.cloud.baseUrl,
      model: config.cloud.model,
      apiKey: config.cloud.apiKey,
      label: 'Cloud',
    };
  }

  if (config.mode === 'hybrid') {
    const route = config.hybrid.analysisEndpoint === 'cloud' ? 'cloud' : 'local';
    return route === 'cloud'
      ? {
        baseUrl: config.cloud.baseUrl,
        model: config.cloud.model,
        apiKey: config.cloud.apiKey,
        label: 'Hybrid cloud',
      }
      : {
        baseUrl: config.local.baseUrl,
        model: config.local.model,
        apiKey: '',
        label: 'Hybrid local',
      };
  }

  return {
    baseUrl: config.local.baseUrl,
    model: config.local.model,
    apiKey: '',
    label: 'Local',
  };
}

async function createAnswerClient(settings) {
  const config = llmConfigManager.mergeWithDefaults(llmConfigManager.loadConfig());
  const route = settings.answerRoute === 'cloud' ? 'cloud' : 'local';
  const sourceConfig = route === 'cloud' ? config.cloud : config.local;
  const fallbackConfig = getAppAnswerConfig();

  const baseUrl = sourceConfig?.baseUrl || fallbackConfig.baseUrl;
  const model = settings.answerModel || sourceConfig?.model || fallbackConfig.model;
  const apiKey = route === 'cloud'
    ? (sourceConfig?.apiKey || fallbackConfig.apiKey || '')
    : '';

  return {
    client: new LLMClient({
      baseUrl,
      model,
      apiKey,
      timeout: 300000,
    }),
    label: route === 'cloud' ? 'Cloud' : 'Local',
  };
}

function gatherSourceFiles(source) {
  if (source.type === 'upload') {
    if (fs.existsSync(source.path)) {
      return [source.path];
    }
    return [];
  }

  const stack = [source.path];
  const files = [];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || !fs.existsSync(current)) {
      continue;
    }

    const stat = fs.statSync(current);
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) {
          continue;
        }

        if (entry.isDirectory()) {
          if (SKIPPED_DIRECTORY_NAMES.has(entry.name)) {
            continue;
          }
          stack.push(path.join(current, entry.name));
        } else {
          const fullPath = path.join(current, entry.name);
          if (SUPPORTED_EXTENSIONS.has(path.extname(fullPath).toLowerCase())) {
            files.push(fullPath);
          }
        }
      }
    } else if (SUPPORTED_EXTENSIONS.has(path.extname(current).toLowerCase())) {
      files.push(current);
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

function upsertSource(list, nextSource) {
  const existingIndex = list.findIndex((source) => source.id === nextSource.id || source.path === nextSource.path);
  if (existingIndex >= 0) {
    const copy = [...list];
    copy[existingIndex] = nextSource;
    return copy;
  }
  return [...list, nextSource];
}

function bindFolder(collectionId, folderPath) {
  const normalizedPath = path.resolve(folderPath);
  if (!fs.existsSync(normalizedPath) || !fs.statSync(normalizedPath).isDirectory()) {
    throw new Error('Folder does not exist.');
  }

  return updateCollection(collectionId, (collection) => {
    const source = {
      id: createId('src'),
      type: 'folder',
      label: path.basename(normalizedPath),
      path: normalizedPath,
      addedAt: new Date().toISOString(),
    };
    collection.sources = upsertSource(collection.sources || [], source);
    return collection;
  });
}

function importFiles(collectionId, filePaths) {
  const collection = loadCollection(collectionId);
  if (!collection) {
    throw new Error('Knowledge base not found.');
  }

  const importsDir = getCollectionImportsDir(collectionId);
  ensureDir(importsDir);

  const importedSources = [];
  for (const filePath of filePaths) {
    const normalizedPath = path.resolve(filePath);
    if (!fs.existsSync(normalizedPath) || !fs.statSync(normalizedPath).isFile()) {
      continue;
    }

    const originalName = path.basename(normalizedPath);
    const safeBase = slugify(path.basename(originalName, path.extname(originalName)));
    const ext = path.extname(originalName).toLowerCase();
    let destPath = path.join(importsDir, `${safeBase}${ext}`);
    let counter = 1;
    while (fs.existsSync(destPath)) {
      destPath = path.join(importsDir, `${safeBase}-${counter}${ext}`);
      counter += 1;
    }

    fs.copyFileSync(normalizedPath, destPath);
    importedSources.push({
      id: createId('src'),
      type: 'upload',
      label: originalName,
      path: destPath,
      originalPath: normalizedPath,
      addedAt: new Date().toISOString(),
    });
  }

  return updateCollection(collectionId, (nextCollection) => {
    let sources = nextCollection.sources || [];
    for (const source of importedSources) {
      sources = upsertSource(sources, source);
    }
    nextCollection.sources = sources;
    return nextCollection;
  });
}

function removeSource(collectionId, sourceId) {
  return updateCollection(collectionId, (collection) => {
    const target = (collection.sources || []).find((source) => source.id === sourceId);
    if (target?.type === 'upload' && target.path && fs.existsSync(target.path)) {
      fs.rmSync(target.path, { force: true });
    }
    collection.sources = (collection.sources || []).filter((source) => source.id !== sourceId);
    return collection;
  });
}

function saveCollectionSettings(collectionId, settings = {}) {
  return updateCollection(collectionId, (collection) => {
    collection.settings = {
      ...DEFAULT_COLLECTION_SETTINGS,
      ...(collection.settings || {}),
      ...settings,
    };
    return collection;
  });
}

async function syncCollection(collectionId, options = {}) {
  const emitLog = options.emitLog || (() => {});
  const emitProgress = options.emitProgress || (() => {});
  const collection = loadCollection(collectionId);
  if (!collection) {
    throw new Error('Knowledge base not found.');
  }

  ensureDir(getCollectionTextsDir(collectionId));
  emitLog(`Indexing knowledge base: ${collection.name}`);
  emitProgress(2);

  const startTime = Date.now();
  const sources = collection.sources || [];
  const allFiles = uniq(sources.flatMap((source) => gatherSourceFiles(source)));
  emitLog(`Found ${allFiles.length} supported files across ${sources.length} sources.`);

  if (allFiles.length === 0) {
    emitProgress(100);
    const emptyCollection = saveCollection({
      ...collection,
      stats: {
        fileCount: 0,
        chunkCount: 0,
        totalChars: 0,
        ocrFiles: 0,
        indexedAt: new Date().toISOString(),
        lastDurationMs: Date.now() - startTime,
      },
    });
    emitLog('No supported files were found in the selected sources.');
    return emptyCollection;
  }

  const documents = [];
  const chunks = [];
  const totalFiles = allFiles.length;
  let skippedFiles = 0;

  const emitStructuredProgress = ({
    percent,
    stage = 'indexing',
    currentIndex = 0,
    total = totalFiles,
    currentFile = '',
    detail = '',
    imageIndex = null,
    imageTotal = null,
    imageName = '',
  }) => {
    const safePercent = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
    const elapsedMs = Date.now() - startTime;
    const etaMs = safePercent >= 10 && elapsedMs >= 5000 && safePercent < 100
      ? Math.round((elapsedMs * (100 - safePercent)) / safePercent)
      : null;

    emitProgress({
      percent: safePercent,
      stage,
      currentIndex,
      totalFiles: total,
      currentFile,
      detail,
      etaMs,
      elapsedMs,
      imageIndex,
      imageTotal,
      imageName,
    });
  };

  for (let index = 0; index < allFiles.length; index += 1) {
    const filePath = allFiles[index];
    const currentIndex = index + 1;
    const fileName = path.basename(filePath);
    const fileShareStart = 6 + (index / totalFiles) * 72;
    const fileShareEnd = 6 + (currentIndex / totalFiles) * 72;
    const fileShareRange = Math.max(1, fileShareEnd - fileShareStart);
    const emitFileProgress = (phase, phaseProgress = 0, detail = '', extra = {}) => {
      let fileFraction = 0;

      if (phase === 'reading') {
        fileFraction = 0.04;
      } else if (phase === 'parsing') {
        fileFraction = 0.12;
      } else if (phase === 'ocr') {
        fileFraction = 0.18 + Math.max(0, Math.min(1, phaseProgress)) * 0.54;
      } else if (phase === 'embedding') {
        fileFraction = 0.78 + Math.max(0, Math.min(1, phaseProgress)) * 0.18;
      } else if (phase === 'done') {
        fileFraction = 1;
      }

      emitStructuredProgress({
        percent: fileShareStart + fileShareRange * fileFraction,
        stage: phase,
        currentIndex,
        currentFile: fileName,
        detail,
        ...extra,
      });
    };

    try {
      emitFileProgress('reading', 0, `Reading ${fileName}`);
      emitLog(`Reading ${fileName} (${currentIndex}/${totalFiles})`);

      const fileRecord = await parseFile(filePath, {
        languages: resolveOcrLanguages(collection.settings || {}),
        retrievalMode: collection.settings?.retrievalMode === 'deep' ? 'deep' : 'fast',
        emitLog,
        onStage: (stage, stageMeta = {}) => {
          if (stage === 'ocr-image') {
            const imageLabel = stageMeta.imageTotal > 1
              ? `OCR image ${stageMeta.imageIndex}/${stageMeta.imageTotal}: ${stageMeta.imageName}`
              : `OCR image: ${stageMeta.imageName}`;
            emitFileProgress('ocr', 0, imageLabel, {
              imageIndex: stageMeta.imageIndex,
              imageTotal: stageMeta.imageTotal,
              imageName: stageMeta.imageName,
            });
          } else if (stage === 'ocr') {
            const imagePart = stageMeta.imageTotal > 1
              ? `Image ${stageMeta.imageIndex}/${stageMeta.imageTotal}`
              : 'Image OCR';
            const statusPart = stageMeta.status ? `${imagePart} · ${stageMeta.status}` : imagePart;
            emitFileProgress('ocr', stageMeta.progress || 0, statusPart, {
              imageIndex: stageMeta.imageIndex,
              imageTotal: stageMeta.imageTotal,
              imageName: stageMeta.imageName,
            });
          }
        },
      });

      if (!fileRecord.fullText) {
        emitLog(`Skipped ${fileRecord.name}: no readable content extracted.`);
        skippedFiles += 1;
        continue;
      }

      emitFileProgress('parsing', 1, `Parsed ${fileName}`);

      const fileId = createId('doc');
      const relativePath = sources
        .map((source) => {
          if (!filePath.startsWith(source.path)) {
            return null;
          }
          const suffix = path.relative(source.path, filePath);
          return suffix ? path.join(source.label, suffix) : source.label;
        })
        .find(Boolean) || fileRecord.name;

      const textFilePath = path.join(getCollectionTextsDir(collectionId), `${fileId}.txt`);
      fs.writeFileSync(textFilePath, fileRecord.fullText, 'utf8');

      const chunkRecords = splitTextIntoChunkRecords(fileRecord.fullText, collection.settings);
      const chunkTexts = chunkRecords.map((item) => item.text);
      emitFileProgress('embedding', 0.1, `Vectorizing ${chunkTexts.length} chunk${chunkTexts.length > 1 ? 's' : ''}`);
      const vectors = await embedTexts(chunkTexts, collection.settings, emitLog);
      emitFileProgress('embedding', 1, `Indexed ${chunkTexts.length} chunk${chunkTexts.length > 1 ? 's' : ''}`);

      const {
        brand,
        folderStyle,
        filenameStyle,
      } = resolveDocumentStyleMetadata({
        relativePath,
        name: fileRecord.name,
      });
      const visualFingerprint = IMAGE_EXTENSIONS.has(String(fileRecord.extension || '').toLowerCase())
        ? computeImageFingerprint(fs.readFileSync(filePath))
        : '';

      const documentRecord = {
        id: fileId,
        name: fileRecord.name,
        path: filePath,
        relativePath,
        extension: fileRecord.extension,
        sizeBytes: fileRecord.sizeBytes,
        modifiedAt: fileRecord.modifiedAt,
        hash: fileRecord.hash,
        textFilePath,
        totalChars: fileRecord.totalChars,
        ocrImageCount: fileRecord.ocrImageCount,
        chunkCount: chunkRecords.length,
        brand,
        styleFolder: folderStyle,
        filenameStyle,
        visualFingerprint,
      };
      documents.push(documentRecord);

      chunkRecords.forEach((chunkRecord, chunkIndex) => {
        chunks.push({
          id: `${fileId}_${chunkIndex + 1}`,
          documentId: fileId,
          name: fileRecord.name,
          path: filePath,
          relativePath,
          chunkIndex,
          text: chunkRecord.text,
          startOffset: chunkRecord.startOffset,
          endOffset: chunkRecord.endOffset,
          anchorLabel: chunkRecord.anchorLabel,
          vector: vectors[chunkIndex] || buildHashedEmbedding(chunkRecord.text),
        });
      });

      emitFileProgress('done', 1, `Finished ${fileName}`);
    } catch (error) {
      skippedFiles += 1;
      emitLog(`Skipped ${fileName}: ${error.message || 'Unknown indexing error.'}`);
      emitFileProgress('done', 1, `Skipped ${fileName}`);
    }
  }

  emitStructuredProgress({
    percent: 86,
    stage: 'saving',
    currentIndex: totalFiles,
    currentFile: '',
    detail: 'Saving local vector index',
  });
  writeJsonl(getCollectionFilesPath(collectionId), documents);
  writeJsonl(getCollectionChunksPath(collectionId), chunks);

  const updatedCollection = saveCollection({
    ...collection,
    stats: {
      fileCount: documents.length,
      chunkCount: chunks.length,
      totalChars: documents.reduce((sum, item) => sum + (item.totalChars || 0), 0),
      ocrFiles: documents.reduce((sum, item) => sum + (item.ocrImageCount > 0 ? 1 : 0), 0),
      indexedAt: new Date().toISOString(),
      lastDurationMs: Date.now() - startTime,
    },
  });

  emitStructuredProgress({
    percent: 100,
    stage: 'completed',
    currentIndex: totalFiles,
    currentFile: '',
    detail: 'Index complete',
  });
  emitLog(`Index complete: ${updatedCollection.stats.fileCount} files, ${updatedCollection.stats.chunkCount} chunks${skippedFiles > 0 ? `, ${skippedFiles} skipped` : ''}.`);
  return updatedCollection;
}

async function searchCollection(collectionId, query, options = {}) {
  const collection = loadCollection(collectionId);
  if (!collection) {
    throw new Error('Knowledge base not found.');
  }

  const chunks = readJsonl(getCollectionChunksPath(collectionId));
  const queryText = sanitizeText(query);
  if (!queryText) {
    return {
      collection,
      results: [],
      promptContext: '',
    };
  }

  const effectiveSettings = {
    ...DEFAULT_COLLECTION_SETTINGS,
    ...(collection.settings || {}),
  };
  const preset = resolveRetrievalPreset(effectiveSettings);
  const [queryVector] = await embedTexts([queryText], effectiveSettings, options.emitLog);
  const queryTokens = tokenize(queryText);
  const topK = Math.max(1, Math.min(20, Number(options.topK) || preset.topK));

  const ranked = chunks
    .map((chunk) => {
      const cosine = cosineSimilarity(queryVector, chunk.vector || []);
      const lexical = keywordScore(queryTokens, chunk.text || '');
      const score = cosine * 0.8 + lexical * 0.2;
      return {
        ...chunk,
        cosine,
        lexical,
        score,
      };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, topK);

  const documents = readJsonl(getCollectionFilesPath(collectionId));
  const references = buildReferenceEntries(ranked, documents);

  return {
    collection,
    results: ranked,
    references,
    promptContext: buildPromptContext(ranked, {
      retrievalMode: preset.mode,
      documents,
    }),
  };
}

async function answerCollectionQuestion(collectionId, question, options = {}) {
  const collection = loadCollection(collectionId);
  if (!collection) {
    throw new Error('Knowledge base not found.');
  }

  const documents = readJsonl(getCollectionFilesPath(collectionId));
  const directInventoryAnswer = tryAnswerInventoryQuestion(question, documents);
  if (directInventoryAnswer) {
    return directInventoryAnswer;
  }

  const { results, promptContext } = await searchCollection(collectionId, question, options);
  const { client, label } = await createAnswerClient(collection.settings || {});

  const history = Array.isArray(options.history) ? options.history : [];
  const historyText = history
    .filter((item) => item && (item.role === 'user' || item.role === 'assistant'))
    .slice(-8)
    .map((item) => `${item.role === 'assistant' ? 'Assistant' : 'User'}: ${String(item.content || '').trim()}`)
    .join('\n');

  const systemPrompt = [
    `You are GS Bot Knowledge Base mode for the collection "${collection.name}".`,
    'Answer using the retrieved knowledge base context first.',
    'If the context is incomplete, say what is missing instead of inventing facts.',
    'Cite relevant files inline using square brackets, for example [manual.pdf] or [reports/brief.docx].',
    'If multiple image files live inside the same style or SKU folder, treat them as one product style instead of counting each image as a separate style.',
    'When the user asks for a summary, keep it structured and practical.',
  ].join('\n');

  const userPrompt = [
    historyText ? `Recent chat context:\n${historyText}` : '',
    promptContext ? `Knowledge base context:\n${promptContext}` : 'Knowledge base context:\nNo indexed context was retrieved.',
    `User question:\n${question}`,
  ].filter(Boolean).join('\n\n');

  const answer = await client.chat([
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ], {
    temperature: 0.2,
    maxTokens: collection.settings?.retrievalMode === 'deep' ? 2400 : 1600,
  });

  return {
    answer,
    provider: label,
    citations: results.map((item) => item.relativePath || item.name),
    retrieval: results.map((item) => ({
      name: item.name,
      relativePath: item.relativePath,
      score: item.score,
      snippet: item.text.slice(0, 420),
    })),
  };
}

module.exports = {
  DEFAULT_COLLECTION_SETTINGS,
  listCollections,
  createCollection,
  loadCollection,
  deleteCollection,
  bindFolder,
  importFiles,
  removeSource,
  saveCollectionSettings,
  syncCollection,
  searchCollection,
  answerCollectionQuestion,
  getDirectCollectionAnswer,
  recognizeImageBuffer,
};

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { LABEL_OCR_DEFAULTS, normalizeLabelOcrProfile } = require('./label-ocr-profile');
const { runEnhancedLabelOcr } = require('./label-ocr-engine');
const {
  getDefaultOcrEngine,
  getOcrEngineDisplayName,
  normalizeOcrEngineName,
  OCR_ENGINE_DEEPSEEK_LOCAL,
} = require('./ocr-engine-config');
const {
  hashValue,
  readFileOperationCache,
  readJsonCache,
  stableSerialize,
  writeFileOperationCache,
  writeJsonCache,
} = require('./processing-cache');
const {
  addSlideIssuesForEntry,
  buildOrganizerStyleKey,
  collectSlidesSourceEntries,
  collectUnusedSourceImages,
  createIssueSummary,
  finalizeIssueSummary,
  findImageByCode,
  findLabelImage,
  listImages,
  listLabelModeStyleEntries,
  pickFabricImage,
  pushIssueValue,
  readJsonFile,
  resolveOrganizerSummaryPath,
} = require('./slides-source-utils');
let sharp = null;
try {
  // In packaged Electron builds, sharp's native .node and DLL dependencies live in
  // app.asar.unpacked. Add the @img/sharp-win32-x64/lib dir to PATH so the OS
  // loader can find libvips-42.dll / libvips-cpp.dll before we require('sharp').
  if (process.platform === 'win32' && process.resourcesPath) {
    try {
      const sharpNativeDir = path.join(
        process.resourcesPath,
        'app.asar.unpacked',
        'node_modules',
        '@img',
        'sharp-win32-x64',
        'lib'
      );
      if (fs.existsSync(sharpNativeDir)) {
        const curPath = process.env.PATH || '';
        if (!curPath.split(';').includes(sharpNativeDir)) {
          process.env.PATH = sharpNativeDir + ';' + curPath;
        }
      }
    } catch (_) { /* ignore PATH setup errors */ }
  }
  // Keep label OCR image preprocessing local and deterministic across modules.
  sharp = require('sharp');
} catch {
  sharp = null;
}

let productParserHelpers = null;
try {
  productParserHelpers = require('./product-parser');
} catch {
  productParserHelpers = null;
}

function stripRtfInline(rtfText) {
  let text = String(rtfText || '');
  if (!text) return '';

  // Remove header groups that contain font/color/style tables and metadata.
  // These groups can contain nested braces, so do a brace-aware strip.
  const headerGroups = ['fonttbl', 'colortbl', 'stylesheet', 'info', 'listtable', 'listoverridetable', 'expandedcolortbl', 'rsidtbl', 'pict', 'object', 'nonshppict', 'shppict', 'header', 'footer', 'generator'];
  for (const tag of headerGroups) {
    // Match either {\fonttbl or {\*\fonttbl
    const re = new RegExp(`\\{(?:\\\\\\*)?\\\\${tag}\\b`, 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
      const start = m.index;
      let depth = 1;
      let i = m.index + m[0].length;
      while (i < text.length && depth > 0) {
        const ch = text[i];
        if (ch === '\\' && i + 1 < text.length) {
          i += 2;
          continue;
        }
        if (ch === '{') depth += 1;
        else if (ch === '}') depth -= 1;
        i += 1;
      }
      text = text.slice(0, start) + ' ' + text.slice(i);
      re.lastIndex = start + 1;
    }
  }

  // Convert paragraph and line breaks into newlines.
  text = text
    .replace(/\\par[d]?\b/g, '\n')
    .replace(/\\line\b/g, '\n')
    .replace(/\\tab\b/g, '\t')
    // Hex-encoded chars (e.g. \'a0)
    .replace(/\\'([0-9a-fA-F]{2})/g, (_m, hex) => {
      try {
        const code = parseInt(hex, 16);
        if (code === 0xa0) return ' ';
        return String.fromCharCode(code);
      } catch {
        return ' ';
      }
    })
    // Unicode escapes ሴ?
    .replace(/\\u(-?\d+)\??/g, (_m, num) => {
      const v = Number(num);
      if (!Number.isFinite(v)) return ' ';
      const cp = v < 0 ? v + 65536 : v;
      try { return String.fromCodePoint(cp); } catch { return ' '; }
    })
    // Escaped literal characters
    .replace(/\\([\\{}])/g, '$1')
    // Any remaining control word, with optional numeric arg and trailing space
    .replace(/\\\*?[a-zA-Z]+-?\d* ?/g, ' ')
    // Stray braces
    .replace(/[{}]/g, ' ')
    // Bullet placeholders
    .replace(/•/g, '•')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ');

  return text.trim();
}

function loadStyleTextDocument(folderPath, styleKey = '') {
  try {
    if (!folderPath || !fs.existsSync(folderPath)) return '';
    const entries = fs.readdirSync(folderPath);
    const styleLower = String(styleKey || '').toLowerCase();
    const candidates = entries
      .filter((name) => /\.(rtf|txt)$/i.test(name))
      .filter((name) => !name.startsWith('.'))
      .map((name) => ({ name, lower: name.toLowerCase() }))
      .map(({ name, lower }) => {
        let score = 1;
        if (styleLower) {
          if (lower === `${styleLower}_info.rtf` || lower === `${styleLower}_info.txt`) score = 100;
          else if (lower === `${styleLower}.rtf` || lower === `${styleLower}.txt`) score = 90;
          else if (lower.startsWith(styleLower)) score = 60;
        }
        if (lower === 'info.rtf' || lower === 'info.txt') score = Math.max(score, 50);
        return { name, score };
      })
      .sort((a, b) => b.score - a.score);

    if (!candidates.length) return '';
    const filePath = path.join(folderPath, candidates[0].name);
    const buffer = fs.readFileSync(filePath);
    let text = buffer.toString('utf8');
    if (filePath.toLowerCase().endsWith('.rtf')) {
      text = stripRtfInline(text);
    }
    return String(text || '').trim();
  } catch {
    return '';
  }
}

function parseStyleTextDocument(text) {
  const result = { name: '', price: '', colorRef: '', description: '', composition: '' };
  if (!text) return result;
  const cleanLine = (line) => String(line || '')
    .replace(/\\+$/g, '')
    .replace(/^[•·\-\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const stripLabelPrefix = (line) => String(line || '')
    .replace(/^(?:product\s*name|name|nom|nombre|名称|品名|产品名称|商品名)\s*[:：]\s*/i, '')
    .trim();
  const lines = text.split(/\r?\n/).map(cleanLine).filter(Boolean);
  if (!lines.length) return result;

  const priceRegex = /^[^\d]*\d+(?:[.,]\d+)?\s*(?:GBP|EUR|USD|PLN|CZK|RON|HUF|CHF|SEK|DKK|NOK|£|€|\$|zł|Kč|Lei|Ft|kr)\b/i;
  const colorRegex = /^(beige|black|white|grey|gray|navy|blue|red|green|brown|pink|yellow|purple|orange|cream|ivory|olive|khaki|burgundy|mint|coral|peach|mustard|teal|turquoise|denim|ecru|nude|camel|charcoal|tan|sand|stone|rust|maroon|fuchsia|magenta|silver|gold|multi(?:color|colour)|print(?:ed)?)\b.*$/i;
  const descHeaderRegex = /^(description|details)\s*:?\s*$/i;
  const matHeaderRegex = /^(material(?:\s+and\s+care)?|composition|fabric|materials)\s*:?\s*$/i;
  const fibrePctRegex = /\d+\s*%\s*(?:cotton|polyester|elastane|viscose|linen|wool|silk|nylon|polyamide|acrylic|cashmere|leather|lyocell|modal|rayon|spandex|tencel|hemp|cupro|acetate|alpaca|mohair|ramie|jute|recycled|organic|metallic|metallised|metallized)/i;

  let priceIdx = -1;
  let colorIdx = -1;
  let descIdx = -1;
  let matIdx = -1;
  let firstFibreIdx = -1;

  lines.forEach((line, idx) => {
    if (priceIdx < 0 && priceRegex.test(line)) priceIdx = idx;
    if (colorIdx < 0 && colorRegex.test(line)) colorIdx = idx;
    if (descIdx < 0 && descHeaderRegex.test(line)) descIdx = idx;
    if (matIdx < 0 && matHeaderRegex.test(line)) matIdx = idx;
    if (firstFibreIdx < 0 && fibrePctRegex.test(line)) firstFibreIdx = idx;
  });

  // Name: first line that is not the price/color/heading
  for (const line of lines) {
    if (priceRegex.test(line)) continue;
    if (colorRegex.test(line)) continue;
    if (descHeaderRegex.test(line) || matHeaderRegex.test(line)) continue;
    if (line.length > 80) continue;
    result.name = stripLabelPrefix(line);
    break;
  }

  if (priceIdx >= 0) result.price = lines[priceIdx];
  if (colorIdx >= 0) result.colorRef = lines[colorIdx];

  // Description: from descIdx+1 (or after price) until material header / first fibre line
  const descStart = descIdx >= 0 ? descIdx + 1 : (priceIdx >= 0 ? priceIdx + 1 : 0);
  const descEnd = matIdx >= 0
    ? matIdx
    : (firstFibreIdx >= 0 ? firstFibreIdx : lines.length);
  const descLines = [];
  for (let i = descStart; i < descEnd; i += 1) {
    const line = lines[i];
    if (!line) continue;
    if (priceRegex.test(line) || colorRegex.test(line)) continue;
    if (descHeaderRegex.test(line) || matHeaderRegex.test(line)) continue;
    descLines.push(line);
  }
  result.description = descLines.join(' ').replace(/\s+/g, ' ').trim();

  // Composition: collect fibre% lines after material header
  const compStart = matIdx >= 0 ? matIdx + 1 : (firstFibreIdx >= 0 ? firstFibreIdx : -1);
  if (compStart >= 0) {
    const compLines = [];
    for (let i = compStart; i < lines.length; i += 1) {
      const line = lines[i];
      if (fibrePctRegex.test(line)) {
        compLines.push(line.replace(/\s+/g, ' ').trim());
      }
    }
    result.composition = compLines.join(' / ');
  }

  return result;
}

function normalizeWhitespace(value = '') {
  return String(value || '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function normalizeSavedInfoText(value = '') {
  return normalizeWhitespace(String(value || ''));
}

function loadSavedStyleInfo(folderPath, styleKey = '') {
  if (!folderPath || !fs.existsSync(folderPath)) {
    return {};
  }

  const candidatePaths = [
    path.join(folderPath, `${styleKey}_info.json`),
    path.join(folderPath, `${styleKey}.json`),
    path.join(folderPath, 'info.json'),
  ];
  const wildcardCandidates = fs.readdirSync(folderPath)
    .filter((name) => /_info\.json$/i.test(name))
    .map((name) => path.join(folderPath, name));
  const existingCandidates = candidatePaths.filter((filePath) => fs.existsSync(filePath));
  const finalCandidates = existingCandidates.length > 0
    ? existingCandidates
    : (wildcardCandidates.length === 1 ? wildcardCandidates : []);

  for (const filePath of finalCandidates) {
    const info = readJsonFile(filePath);
    if (!info || typeof info !== 'object') {
      continue;
    }
    return {
      styleNumber: normalizeSavedInfoText(info.styleNumber || info.style_number || ''),
      name: normalizeSavedInfoText(info.name || info.productName || info.product_name || ''),
      price: normalizeSavedInfoText(info.price || ''),
      colorRef: normalizeSavedInfoText(info.colorRef || info.color || ''),
      description: normalizeSavedInfoText(info.description || info.desc || ''),
      composition: info.composition || '',
      fabricCode: normalizeSavedInfoText(info.fabricCode || info.fabric_code || ''),
      width: normalizeSavedInfoText(info.width || ''),
      cuttable: normalizeSavedInfoText(info.cuttable || ''),
      weight: normalizeSavedInfoText(info.weight || ''),
    };
  }

  return {};
}

function buildPrecomputedInfoFromOrganizerSummary(sourceFolder, sourceMode, emitLog = null) {
  const summaryPath = resolveOrganizerSummaryPath(sourceFolder);
  const summary = readJsonFile(summaryPath);
  const styles = Array.isArray(summary?.styles) ? summary.styles : [];

  if (!summaryPath || styles.length === 0) {
    return null;
  }

  const result = {};
  const styleEntries = [];
  const issues = createIssueSummary();

  styles.forEach((item) => {
    const styleKey = buildOrganizerStyleKey(item, sourceFolder);
    if (!styleKey) {
      return;
    }
    const folderPath = item?.folder || sourceFolder;
    const savedInfo = loadSavedStyleInfo(folderPath, styleKey);

    const labelInfo = item?.labelInfo || {};
    const rawText = normalizeWhitespace(labelInfo.rawText || '');
    const rawLines = rawText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const files = item?.files || {};
    const labelImagePath = files.label && fs.existsSync(files.label) ? files.label : '';
    const configuredGallery = Array.isArray(item?.galleryImagePaths) ? item.galleryImagePaths : [];
    const fallbackGallery = Object.entries(files)
      .filter(([key, filePath]) => /^image\d+$/i.test(key) && filePath && fs.existsSync(filePath))
      .sort((left, right) => left[0].localeCompare(right[0], undefined, { numeric: true, sensitivity: 'base' }))
      .map(([, filePath]) => filePath);
    const galleryImagePaths = [...new Set([...configuredGallery, ...fallbackGallery].filter(Boolean))];
    const frontImagePath = files.front && fs.existsSync(files.front) ? files.front : (galleryImagePaths[0] || '');
    const backImagePath = files.back && fs.existsSync(files.back) ? files.back : (galleryImagePaths[1] || '');
    const fabricImagePath = sourceMode === 'fabric-images' ? (labelImagePath || '') : '';
    const storedWidth = normalizeFieldText(labelInfo.width || '');
    const storedCuttable = normalizeFieldText(labelInfo.cuttable || '');
    const storedWeight = normalizeFieldText(labelInfo.weight || '');
    const storedComposition = normalizeFieldText(labelInfo.composition || '');
    const compositionSource = storedComposition || findFallbackCompositionLine(rawLines);
    const widthSource = (!/^\d\s*\/\s*\d$/.test(storedWidth) ? storedWidth : '') || findFallbackWidthLine(rawLines) || storedWidth;
    const cuttableSource = normalizeCuttableText(storedCuttable) ? storedCuttable : (findFallbackCuttableValue(rawLines) || storedCuttable);
    const weightSource = storedWeight || findFallbackWeightLine(rawLines);

    const hasUsableSource = sourceMode === 'fabric-images'
      ? Boolean(fabricImagePath)
      : sourceMode === 'style-images-only'
        ? Boolean(galleryImagePaths.length > 0)
        : Boolean(frontImagePath || backImagePath || labelImagePath);
    if (!hasUsableSource) {
      return;
    }

    const entryInfo = {
      styleNumber: savedInfo.styleNumber || labelInfo.styleNumber || item.styleNumber || styleKey,
      name: savedInfo.name || labelInfo.name || '',
      fabricCode: labelInfo.fabricCode || '',
      price: savedInfo.price || '',
      colorRef: savedInfo.colorRef || '',
      description: savedInfo.description || '',
      composition: savedInfo.composition || normalizeCompositionText(compositionSource),
      width: savedInfo.width || normalizeWidthText(widthSource),
      cuttable: savedInfo.cuttable || normalizeCuttableText(cuttableSource),
      weight: savedInfo.weight || normalizeWeightText(weightSource, rawText),
      labelOcrText: rawText,
      labelImagePath,
      fabricImagePath,
      galleryImagePaths,
      frontImagePath,
      backImagePath,
      visionImagePath: fabricImagePath || galleryImagePaths[0] || frontImagePath || backImagePath || labelImagePath || '',
    };
    result[styleKey] = entryInfo;

    const styleLabel = sourceMode === 'fabric-images'
      ? (entryInfo.fabricCode || entryInfo.styleNumber || styleKey)
      : (entryInfo.styleNumber || styleKey);
    addSlideIssuesForEntry(issues, sourceMode, styleLabel, entryInfo);

    styleEntries.push({
      styleKey,
      folderPath,
    });
  });

  if (styleEntries.length === 0) {
    return null;
  }

  (summary?.failedStyles || []).forEach((item) => {
    pushIssueValue(issues, 'emptyLabels', path.basename(String(item?.source || '')));
  });
  (summary?.unmatchedImages || []).forEach((item) => {
    pushIssueValue(issues, 'skippedFiles', path.basename(String(item || '')));
  });

  result.__styleEntries = styleEntries;
  result.__issues = finalizeIssueSummary(issues);
  emitLog?.(
    `Using organizer metadata from ${summaryPath}. Skipping ${sourceMode === 'fabric-images' ? 'fabric OCR' : sourceMode === 'style-images-only' ? 'extra style analysis' : 'label OCR'} for ${styleEntries.length} ${sourceMode === 'fabric-images' ? 'fabric items' : 'styles'}.`,
    'info',
  );
  return result;
}

const SLIDES_PRECOMPUTE_CACHE_NAMESPACE = 'slides-precompute';
const SLIDES_PRECOMPUTE_CACHE_VERSION = 5;
const PRECOMPUTE_RELEVANT_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.json',
  '.rtf',
  '.txt',
]);

function parseSuffixList(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || '').trim()).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    return value.split(/[,，;；\s]+/).map((entry) => entry.trim()).filter(Boolean);
  }
  return [];
}

function normalizeSlidesPrecomputeSettings(settings = {}) {
  const configuredSuffixes = parseSuffixList(settings.imageSuffixes);
  return {
    sourceMode: settings.sourceMode || 'document-images',
    sourceOrganization: settings.sourceOrganization || 'auto',
    imageSuffixes: configuredSuffixes.length > 0
      ? configuredSuffixes
      : (settings.sourceMode === 'style-images-only' ? ['F', 'B'] : []),
    ocrEngine: normalizeOcrEngineName(settings.ocrEngine || getDefaultOcrEngine()),
    ocrFallbackEngine: normalizeOcrEngineName(settings.ocrFallbackEngine || ''),
    labelOcrProfile: normalizeLabelOcrProfile(settings.labelOcrProfile || LABEL_OCR_DEFAULTS),
  };
}

function shouldTrackPrecomputeFile(filePath = '') {
  return PRECOMPUTE_RELEVANT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function collectPrecomputeSourceSignature(sourceFolder) {
  const resolvedRoot = path.resolve(sourceFolder);
  const entries = [];

  function walk(currentFolder) {
    const dirEntries = fs.readdirSync(currentFolder, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith('.'))
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' }));

    dirEntries.forEach((entry) => {
      const fullPath = path.join(currentFolder, entry.name);
      const relativePath = path.relative(resolvedRoot, fullPath) || '.';

      if (entry.isDirectory()) {
        entries.push({ type: 'dir', path: relativePath });
        walk(fullPath);
        return;
      }

      if (!entry.isFile() || !shouldTrackPrecomputeFile(fullPath)) {
        return;
      }

      const stats = fs.statSync(fullPath);
      entries.push({
        type: 'file',
        path: relativePath,
        size: Number(stats.size) || 0,
        mtimeMs: Math.round(Number(stats.mtimeMs) || 0),
      });
    });
  }

  walk(resolvedRoot);
  return entries;
}

function buildSlidesPrecomputeCacheKey(sourceFolder, settings = {}) {
  return hashValue(stableSerialize({
    version: SLIDES_PRECOMPUTE_CACHE_VERSION,
    sourceFolder: path.resolve(sourceFolder),
    settings: normalizeSlidesPrecomputeSettings(settings),
    sourceSignature: collectPrecomputeSourceSignature(sourceFolder),
  }));
}

function readSlidesPrecomputeCache(sourceFolder, settings = {}) {
  try {
    const cacheKey = buildSlidesPrecomputeCacheKey(sourceFolder, settings);
    return { cacheKey, value: readJsonCache(SLIDES_PRECOMPUTE_CACHE_NAMESPACE, cacheKey) };
  } catch {
    return { cacheKey: '', value: null };
  }
}

function writeSlidesPrecomputeCache(cacheKey, result) {
  if (!cacheKey) {
    return '';
  }
  return writeJsonCache(SLIDES_PRECOMPUTE_CACHE_NAMESPACE, cacheKey, {
    version: SLIDES_PRECOMPUTE_CACHE_VERSION,
    cachedAt: new Date().toISOString(),
    result,
  });
}

function normalizeKeyToken(value = '') {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function normalizeOcrAliasToken(value = '') {
  return normalizeKeyToken(value)
    .replace(/0/g, 'O')
    .replace(/1/g, 'I')
    .replace(/5/g, 'S');
}

function isNoisyCompositionAlias(value = '') {
  const token = normalizeOcrAliasToken(value);
  if (!token) {
    return false;
  }
  return /^(COMPOSITION|COMPOSITIO|COMPOSITI|COMPOS|CONTENT|CONT|COMP)C?$/i.test(token)
    || token.startsWith('COMPOSITION')
    || token.startsWith('CONTENT');
}

function isCompositionAliasOnly(value = '') {
  return isNoisyCompositionAlias(value);
}

function isCompositionLikeValue(value = '') {
  const text = normalizeFieldText(value);
  const compact = text.replace(/\s+/g, '').toUpperCase();
  const hasMaterialWord = /(COTTON|CTN|POLYESTER|POLY|SPANDEX|SPAN|ELASTANE|VISCOSE|RAYON|NYLON|LINEN|WOOL|ACRYLIC|MODAL|TENCEL|LYOCELL|SILK)/i.test(text);
  const hasPercentBlend = /\d{1,3}\s*%/.test(text) || (compact.includes('%') && /\d{1,3}%?[A-Z]{1,8}\d{1,3}%?[A-Z]{1,8}/i.test(compact));
  const hasSlashBlend = /\b\d{1,3}\s*\/\s*\d{1,3}(?:\s*\/\s*\d{1,3}){0,5}\s*[A-Z][A-Z/\s]{0,24}/i.test(text)
    && !/["”″]/.test(text);
  return hasPercentBlend || hasMaterialWord || hasSlashBlend;
}

function escapeRegex(value = '') {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildOcrTolerantAliasPattern(alias = '') {
  const charMap = {
    A: '[A4]',
    B: '[B8]',
    C: '[C]',
    D: '[D]',
    E: '[E3]',
    F: '[F]',
    G: '[G6]',
    H: '[H]',
    I: '[I1L]',
    L: '[LI1]',
    M: '[M]',
    N: '[N]',
    O: '[O0]',
    P: '[P]',
    Q: '[Q0O]',
    R: '[R]',
    S: '[S5]',
    T: '[T7]',
    U: '[U]',
    V: '[V]',
    W: '[W]',
    X: '[X]',
    Y: '[Y]',
    Z: '[Z2]',
  };

  return String(alias || '')
    .trim()
    .split('')
    .map((char) => {
      if (/\s/.test(char)) {
        return '\\s*';
      }
      const upper = char.toUpperCase();
      return charMap[upper] || escapeRegex(char);
    })
    .join('\\s*');
}

function matchesAliasToken(line, alias) {
  if (/[\u4e00-\u9fff]/.test(String(alias || ''))) {
    return String(line || '').trim().startsWith(String(alias || '').trim());
  }

  const normalizedAlias = normalizeOcrAliasToken(alias);
  if (!normalizedAlias) {
    return false;
  }

  return normalizeOcrAliasToken(line).startsWith(normalizedAlias);
}

function stripAliasPrefix(line, aliases = []) {
  let stripped = String(line || '');

  const aliasesByLength = [...aliases].sort((left, right) => String(right || '').length - String(left || '').length);
  for (const alias of aliasesByLength) {
    const pattern = buildOcrTolerantAliasPattern(alias);
    stripped = stripped.replace(new RegExp(`^[^A-Za-z0-9]{0,3}${pattern}\\s*[:：-]?\\s*`, 'i'), '');
  }

  return stripped.trim();
}

function findLastAliasMatch(line = '', aliases = []) {
  const text = String(line || '');
  if (!text) {
    return null;
  }

  let best = null;
  for (const alias of aliases) {
    const value = String(alias || '').trim();
    if (!value) {
      continue;
    }
    if (/[\u4e00-\u9fff]/.test(value)) {
      let index = text.indexOf(value);
      while (index >= 0) {
        if (!best || index > best.start) {
          best = { start: index, end: index + value.length };
        }
        index = text.indexOf(value, index + 1);
      }
      continue;
    }
    const pattern = buildOcrTolerantAliasPattern(value);
    const regex = new RegExp(pattern, 'gi');
    let match = regex.exec(text);
    while (match !== null) {
      if (match[0].length === 0) {
        regex.lastIndex += 1;
      } else {
        if (!best || match.index > best.start) {
          best = { start: match.index, end: match.index + match[0].length };
        }
      }
      match = regex.exec(text);
    }
  }

  return best;
}

function stripLeadingAliasTokens(value = '', aliases = []) {
  const leadingJunk = /^[^A-Za-z0-9\u4e00-\u9fff]{1,4}/;
  let current = String(value || '').replace(leadingJunk, '').trim();
  const normalizedAliases = aliases.filter(Boolean);

  for (let guard = 0; guard < 6; guard += 1) {
    const match = findLastAliasMatch(current, normalizedAliases);
    if (!match || match.start !== 0) {
      break;
    }
    const remainder = current.slice(match.end).replace(leadingJunk, '').trim();
    if (remainder === current) {
      break;
    }
    current = remainder;
  }

  return current;
}

// Relaxed pass: the alias may sit anywhere in the line, not only at the start.
// This keeps values like "Season:FA27 Dick' s Style #: DAM80" usable (-> DAM80)
// and strips bilingual label pairs ("编号 Article No. LT19024-9" -> LT19024-9).
// Guards: plain text without digits is ignored for code fields, and a candidate
// that still starts with another field alias is skipped, so supplier/brand text
// can never be captured as a code.
function parseRelaxedAliasValue(lines = [], aliases = [], allAliases = [], options = {}) {
  const requireDigit = options.requireDigit !== false;
  const normalizedAliases = aliases.filter(Boolean);
  if (!Array.isArray(lines) || lines.length === 0 || normalizedAliases.length === 0) {
    return '';
  }

  const allAliasTokens = allAliases.map((alias) => normalizeKeyToken(alias)).filter(Boolean);
  const stripTargets = [...normalizedAliases, ...allAliases];

  for (let index = 0; index < lines.length; index += 1) {
    const line = String(lines[index] || '');
    const match = findLastAliasMatch(line, normalizedAliases);
    if (!match) {
      continue;
    }

    let candidate = stripLeadingAliasTokens(line.slice(match.end), stripTargets);
    if (!candidate) {
      for (let pointer = index + 1; pointer < Math.min(lines.length, index + 3); pointer += 1) {
        const nextLine = String(lines[pointer] || '').trim();
        if (!nextLine) {
          continue;
        }
        const nextToken = normalizeKeyToken(nextLine);
        if (nextToken && allAliasTokens.some((aliasToken) => nextToken.startsWith(aliasToken))) {
          break;
        }
        candidate = stripLeadingAliasTokens(nextLine, stripTargets);
        break;
      }
    }

    if (!candidate) {
      continue;
    }
    if (requireDigit && !/\d/.test(candidate)) {
      continue;
    }
    return candidate;
  }

  return '';
}

function parseFieldFromLines(lines, aliases = [], allAliases = []) {
  const normalizedAliases = aliases.filter(Boolean);
  if (normalizedAliases.length === 0) {
    return '';
  }

  let index = lines.findIndex((line) => normalizedAliases.some((alias) => matchesAliasToken(line, alias)));
  if (index === -1) {
    return '';
  }

  const current = stripAliasPrefix(lines[index], normalizedAliases);
  if (current) {
    return current;
  }

  const allAliasTokens = allAliases.map((alias) => normalizeKeyToken(alias)).filter(Boolean);

  for (let pointer = index + 1; pointer < Math.min(lines.length, index + 3); pointer += 1) {
    const candidate = lines[pointer].trim();
    if (!candidate) {
      continue;
    }
    const candidateToken = normalizeKeyToken(candidate);
    if (allAliasTokens.some((aliasToken) => candidateToken.startsWith(aliasToken))) {
      break;
    }
    return candidate;
  }

  return '';
}

function parseAdjacentAliasValuePairs(lines, aliases = [], allAliases = []) {
  const normalizedAliases = aliases.filter(Boolean);
  if (normalizedAliases.length === 0 || !Array.isArray(lines) || lines.length === 0) {
    return '';
  }

  const allAliasTokens = allAliases.map((alias) => normalizeKeyToken(alias)).filter(Boolean);
  const targetAliasTokens = new Set(normalizedAliases.map((alias) => normalizeKeyToken(alias)).filter(Boolean));

  for (let index = 0; index < lines.length - 1; index += 1) {
    const currentToken = normalizeKeyToken(lines[index]);
    if (!currentToken || !targetAliasTokens.has(currentToken)) {
      continue;
    }

    const nextLine = String(lines[index + 1] || '').trim();
    if (!nextLine) {
      continue;
    }

    const nextToken = normalizeKeyToken(nextLine);
    if (nextToken && allAliasTokens.some((aliasToken) => nextToken.startsWith(aliasToken))) {
      continue;
    }

    return nextLine;
  }

  return '';
}

function normalizeOcrLineBox(line = {}) {
  const directBox = line?.box || line?.bbox || line?.rect || null;
  if (directBox && Number.isFinite(Number(directBox.left)) && Number.isFinite(Number(directBox.top))) {
    const left = Number(directBox.left) || 0;
    const top = Number(directBox.top) || 0;
    const width = Math.max(1, Number(directBox.width) || 0);
    const height = Math.max(1, Number(directBox.height) || 0);
    return {
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      centerX: left + (width / 2),
      centerY: top + (height / 2),
    };
  }

  const points = Array.isArray(line?.points)
    ? line.points
    : Array.isArray(line?.polygon)
      ? line.polygon
      : Array.isArray(line?.quad)
        ? line.quad
        : null;
  if (!points || points.length < 2) {
    return null;
  }

  const xs = points.map((point) => Number(point?.x ?? point?.[0])).filter(Number.isFinite);
  const ys = points.map((point) => Number(point?.y ?? point?.[1])).filter(Number.isFinite);
  if (xs.length < 2 || ys.length < 2) {
    return null;
  }

  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const right = Math.max(...xs);
  const bottom = Math.max(...ys);
  const width = Math.max(1, right - left);
  const height = Math.max(1, bottom - top);
  return {
    left,
    top,
    width,
    height,
    right,
    bottom,
    centerX: left + (width / 2),
    centerY: top + (height / 2),
  };
}

function buildPositionedOcrLines(ocrLines = []) {
  if (!Array.isArray(ocrLines) || ocrLines.length === 0) {
    return [];
  }

  return ocrLines
    .map((line, index) => ({
      index,
      text: extractLineTextCandidate(line),
      box: normalizeOcrLineBox(line),
    }))
    .filter((line) => line.text && line.box)
    .sort((left, right) => {
      const rowDelta = left.box.centerY - right.box.centerY;
      if (Math.abs(rowDelta) > Math.max(left.box.height, right.box.height, 8)) {
        return rowDelta;
      }
      return left.box.left - right.box.left;
    });
}

function isAliasLikeLine(line = '', allAliases = []) {
  const candidateToken = normalizeKeyToken(line);
  if (!candidateToken) {
    return false;
  }
  return allAliases
    .map((alias) => normalizeKeyToken(alias))
    .filter(Boolean)
    .some((aliasToken) => candidateToken.startsWith(aliasToken));
}

function horizontalOverlapRatio(leftBox, rightBox) {
  const overlap = Math.max(0, Math.min(leftBox.right, rightBox.right) - Math.max(leftBox.left, rightBox.left));
  return overlap / Math.max(1, Math.min(leftBox.width, rightBox.width));
}

function parseSpatialFieldFromLines(positionedLines = [], aliases = [], allAliases = []) {
  const normalizedAliases = aliases.filter(Boolean);
  if (!Array.isArray(positionedLines) || positionedLines.length === 0 || normalizedAliases.length === 0) {
    return '';
  }

  for (const aliasLine of positionedLines) {
    if (!normalizedAliases.some((alias) => matchesAliasToken(aliasLine.text, alias))) {
      continue;
    }

    const inlineValue = stripAliasPrefix(aliasLine.text, normalizedAliases);
    if (inlineValue) {
      return inlineValue;
    }

    const candidates = positionedLines
      .filter((candidate) => candidate.index !== aliasLine.index)
      .filter((candidate) => !isAliasLikeLine(candidate.text, allAliases))
      .map((candidate) => {
        const rowTolerance = Math.max(aliasLine.box.height, candidate.box.height, 16) * 1.35;
        const sameRow = Math.abs(candidate.box.centerY - aliasLine.box.centerY) <= rowTolerance
          && candidate.box.left >= aliasLine.box.left + (aliasLine.box.width * 0.35);
        const below = candidate.box.top >= aliasLine.box.top
          && candidate.box.top <= aliasLine.box.bottom + (aliasLine.box.height * 4.5)
          && (
            horizontalOverlapRatio(aliasLine.box, candidate.box) >= 0.35
            || Math.abs(candidate.box.left - aliasLine.box.left) <= Math.max(aliasLine.box.width, 48)
          );

        if (!sameRow && !below) {
          return null;
        }

        const xDistance = sameRow
          ? Math.max(0, candidate.box.left - aliasLine.box.right)
          : Math.abs(candidate.box.left - aliasLine.box.left);
        const yDistance = Math.abs(candidate.box.centerY - aliasLine.box.centerY);
        return {
          candidate,
          score: (sameRow ? 0 : 1000) + xDistance + (yDistance * 2),
        };
      })
      .filter(Boolean)
      .sort((left, right) => left.score - right.score);

    if (candidates[0]?.candidate?.text) {
      return candidates[0].candidate.text;
    }
  }

  return '';
}

function collectCompositionBlock(lines = [], aliases = [], allAliases = []) {
  const normalizedAliases = aliases.filter(Boolean);
  if (!Array.isArray(lines) || lines.length === 0 || normalizedAliases.length === 0) {
    return '';
  }

  const startIndex = lines.findIndex((line) => normalizedAliases.some((alias) => matchesAliasToken(line, alias)));
  if (startIndex < 0) {
    return '';
  }

  const collected = [];
  const inlineValue = stripAliasPrefix(lines[startIndex], normalizedAliases);
  if (inlineValue && isCompositionLikeValue(inlineValue)) {
    collected.push(inlineValue);
  }

  for (let index = startIndex + 1; index < Math.min(lines.length, startIndex + 6); index += 1) {
    const candidate = String(lines[index] || '').trim();
    if (!candidate) {
      continue;
    }
    if (isAliasLikeLine(candidate, allAliases)) {
      break;
    }
    if (!isCompositionLikeValue(candidate)) {
      if (collected.length > 0) {
        break;
      }
      continue;
    }
    collected.push(candidate);
  }

  return collected.join(' / ');
}

function normalizeCompositionText(value = '') {
  const normalized = normalizeFieldText(String(value || ''))
    .replace(/^(?:C[O0]MPOSITI[O0]N|C[O0]MPOSITI[O0]|C[O0]MPOSIT|C[O0]NTENT|C[O0]NT|C[O0]MP|[O0]NTENT|NTENT|TENT|ENT|SPEC)C?\s*[:：-]?\s*/i, '')
    .replace(/(\d)\s*%\s*([A-Za-z]+)/g, '$1%$2')
    .replace(/([A-Za-z])\s*[:：]\s*(\d)/g, '$1: $2')
    .replace(/%\s*([A-Za-z])/g, '% $1')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!normalized || isCompositionAliasOnly(normalized) || !isCompositionLikeValue(normalized)) {
    return '';
  }
  return normalized;
}

function normalizeFieldText(value = '') {
  return String(value || '')
    .replace(/[\[\]]/g, ' ')
    .replace(/^[^A-Za-z0-9"]+|[^A-Za-z0-9"%/.\- ]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function normalizeFabricCodeText(value = '') {
  const normalized = normalizeFieldText(value)
    .replace(/\s+[A-Za-z](?:\s+[A-Za-z]){0,3}$/g, '')
    .trim()
    .toUpperCase();
  if (!normalized || isCompositionAliasOnly(normalized) || /\b(COMPOSITION|CONTENT|CONT|COMP)\b/i.test(normalized)) {
    return '';
  }
  const embeddedMatch = normalized.match(/\b[A-Z]{1,6}[A-Z0-9.\-]*\d[A-Z0-9.\-]*(?:\/[A-Z0-9.\-]+)?\b/);
  if (embeddedMatch) {
    return embeddedMatch[0];
  }
  if (!/\d/.test(normalized) || !/[A-Z]/.test(normalized)) {
    return '';
  }
  return normalized;
}

function looksLikeStyleNumber(value = '') {
  const normalized = String(value || '').trim().toUpperCase();
  if (!normalized) {
    return false;
  }

  if (!/[A-Z]/.test(normalized) || !/\d/.test(normalized)) {
    return false;
  }

  // Compact styles without a separator (DAM80, FA27, MD622X) are valid style
  // numbers too; the old rule required a separator or 8+ characters and threw
  // them away.
  if (/^[A-Z]{1,6}\d{1,8}[A-Z]{0,4}$/.test(normalized)) {
    return true;
  }

  return /[-_/]/.test(normalized) || normalized.length >= 8;
}

function normalizeStyleNumberText(value = '') {
  const upper = String(value || '').toUpperCase();
  const match = upper.match(/[A-Z0-9]+(?:[-_/][A-Z0-9]+)+/);
  if (match && /[A-Z]/.test(match[0]) && /\d/.test(match[0])) {
    return match[0].replace(/\//g, '-');
  }
  // Without a separator, only trust the first token: trailing OCR noise such as
  // "DAM80 printing" must not leak into the file name.
  const firstToken = normalizeFieldText(upper.trim().split(/\s+/)[0] || '');
  if (!firstToken || !looksLikeStyleNumber(firstToken)) {
    return '';
  }
  return firstToken;
}

function findFallbackFabricCodeLine(lines = []) {
  for (const line of lines) {
    const normalized = normalizeFieldText(line).toUpperCase();
    if (!normalized) {
      continue;
    }
    if (/\b(WEIGHT|WIDTH|CUTTABLE|CONTENT|COMPOSITION|DESC|ART|STYLE|ITEM|BW|CW|OZ|GM2|G\/M2)\b/.test(normalized)) {
      continue;
    }
    if (isCompositionLikeValue(normalized)) {
      continue;
    }
    const embeddedMatch = normalized.match(/\b[A-Z]{1,4}\d[A-Z0-9.\-]{5,}\b/);
    if (embeddedMatch) {
      return embeddedMatch[0];
    }
    if (/^[A-Z]{1,6}[A-Z0-9.\-]{5,}$/.test(normalized) && /\d/.test(normalized)) {
      return normalized;
    }
  }

  return '';
}

function findFallbackStyleNumberLine(lines = [], rawText = '') {
  const joined = [String(rawText || ''), ...lines]
    .filter(Boolean)
    .join('\n')
    .toUpperCase();
  const strongMatches = joined.match(/[A-Z]{1,6}[A-Z0-9]*(?:[-_/][A-Z0-9]+){1,5}/g) || [];
  const preferred = strongMatches.find((candidate) => looksLikeStyleNumber(candidate));
  if (preferred) {
    return preferred;
  }

  return '';
}

function normalizeWidthFractionText(numerator = '', denominator = '') {
  const left = String(numerator || '').trim();
  const right = String(denominator || '').trim();
  if (!left || !right) {
    return '';
  }
  if (right === '1' && /^[234568]$/.test(left)) {
    return `1/${left}`;
  }
  return `${left}/${right}`;
}

function formatWidthDisplay(prefix = '', widthValue = '') {
  return `${prefix ? `${prefix} ` : ''}${widthValue}`.trim();
}

function isWeightLikeText(value = '') {
  const compact = normalizeFieldText(value)
    .replace(/\s+/g, '')
    .toUpperCase();
  return /(G\/M2|GM2|GSM|G\/SQM|GSQM|G\/SQ\.?M|OZ\/YD2|OZYD2|OZ\/YD|OZYD|OZ|BW)/.test(compact);
}

function findFallbackWidthLine(lines) {
  const widthAliasRegex = /\b(?:WIDTH|WID)(?:\/CUTTABLE)?\b|门幅|幅宽/i;

  for (let index = 0; index < lines.length; index += 1) {
    const current = String(lines[index] || '').trim();
    if (!widthAliasRegex.test(current)) {
      continue;
    }

    const inlineWidth = current.replace(widthAliasRegex, '').trim();
    const inlineWidthOnly = inlineWidth.replace(/\bCUTTABLE\b.*$/i, '').trim();
    if (inlineWidthOnly && !isWeightLikeText(inlineWidthOnly) && /\d{2,3}/.test(inlineWidthOnly)) {
      return inlineWidthOnly;
    }
    if (/\bCUTTABLE\b/i.test(inlineWidth)) {
      continue;
    }

    const previous = String(lines[index - 1] || '').trim();
    if (previous && !isWeightLikeText(previous) && /\d{2,3}/.test(previous)) {
      return previous;
    }
  }

  return lines.find((line) => {
    const upper = String(line || '').toUpperCase();
    if (/WEIGHT|CODE|DESC|CONT|SPEC/.test(upper) || isWeightLikeText(upper)) {
      return false;
    }
    return /\d+(?:\.\d+)?\s*(?:\/\s*\d+(?:\.\d+)?)?\s*["”]/.test(line);
  }) || '';
}

function findFallbackWeightLine(lines) {
  return lines.find((line) => /\d+(?:\.\d+)?\s*(?:G\/M2|GM2|GSM|G\/SQM|GSQM|G\/SQ\.?M|OZ\/YD2|OZYD2|OZ\/YD|OZYD|OZ)/i.test(line)) || '';
}

function normalizeDimensionBody(body = '') {
  const normalizedBody = String(body || '')
    .replace(/[”″“]/g, '"')
    .replace(/''/g, '"')
    .trim();
  const centimeterMatch = normalizedBody.match(/\b(\d{2,3}(?:\.\d+)?)\s*C\s*M\b/i)
    || normalizedBody.match(/\b(\d{2,3}(?:\.\d+)?)\s*CM\b/i);
  if (centimeterMatch) {
    return `${centimeterMatch[1]}CM`;
  }

  const quotedFractionMatch = normalizedBody.match(/(\d{2,3})\s*"\s*(\d)\s*\/\s*(\d)/i);
  if (quotedFractionMatch) {
    const fraction = normalizeWidthFractionText(quotedFractionMatch[2], quotedFractionMatch[3]);
    return `${quotedFractionMatch[1]}'' ${fraction}`.trim();
  }

  const compactFractionMatch = normalizedBody.match(/\b(\d{2})(\d)\s*\/\s*1\b/i);
  if (compactFractionMatch) {
    return `${compactFractionMatch[1]}'' 1/${compactFractionMatch[2]}`;
  }

  const rangeMatch = normalizedBody.match(/\b(\d{2,3})\s*\/\s*(\d{2,3})\s*(?:"|''|”)?/i);
  if (rangeMatch) {
    return `${rangeMatch[1]}/${rangeMatch[2]}''`;
  }

  const singleQuotedMatch = normalizedBody.match(/\b(\d{2,3})\s*(?:"|''|”)/i);
  if (singleQuotedMatch) {
    return `${singleQuotedMatch[1]}''`;
  }

  const singleMatch = normalizedBody.match(/\b(\d{2,3})(?:\.\d+)?\b/);
  if (singleMatch && !/[A-Za-z]/.test(normalizedBody.replace(/CUTTABLE/gi, '').replace(/CW/gi, '').trim())) {
    return `${singleMatch[1]}''`;
  }

  return '';
}

function findFallbackCuttableValue(lines = []) {
  for (let index = 0; index < lines.length; index += 1) {
    const current = String(lines[index] || '').trim();
    if (!/\bCUTT?ABLE/i.test(current)) {
      continue;
    }

    const inlineCandidate = normalizeCuttableText(current);
    if (inlineCandidate) {
      return inlineCandidate;
    }

    const previousCandidate = normalizeCuttableText(lines[index - 1] || '');
    if (previousCandidate) {
      return previousCandidate;
    }

    const nextCandidate = normalizeCuttableText(lines[index + 1] || '');
    if (nextCandidate) {
      return nextCandidate;
    }
  }

  return '';
}

function normalizeWidthText(value = '') {
  const text = normalizeFieldText(value)
    .replace(/[”″“]/g, '"')
    .replace(/''/g, '"')
    .trim();
  if (!text || isWeightLikeText(text)) {
    return '';
  }
  if (/\bC\s*M\b/i.test(text) || /\bCM\b/i.test(text)) {
    return '';
  }

  const hasCW = /^CW\b/i.test(text) || /^CW/i.test(text) || /\bCW\b/i.test(text);
  const prefix = hasCW ? 'CW' : '';
  const body = text
    .replace(/^CW\s*[:：-]?\s*/i, '')
    .replace(/\bCUTTABLE\b.*$/i, '')
    .trim();
  const normalizedBody = normalizeDimensionBody(body);
  if (normalizedBody) {
    return formatWidthDisplay(prefix, normalizedBody);
  }
  return prefix ? prefix : '';
}

function normalizeCuttableText(value = '') {
  const text = normalizeFieldText(value)
    .replace(/[”″“]/g, '"')
    .replace(/''/g, '"')
    .trim();
  if (!text || isWeightLikeText(text) || /^CUTTABLE$/i.test(text)) {
    return '';
  }

  const inlineAfterAlias = text.match(/\bCUTT?ABLE[^0-9]{0,6}(\d{2,3}(?:\.\d+)?(?:\s*\/\s*\d+)?\s*(?:C\s*M|CM|"|''|”)?)/i);
  if (inlineAfterAlias) {
    return normalizeDimensionBody(inlineAfterAlias[1]);
  }

  if (/\bCUTT?ABLE/i.test(text)) {
    return '';
  }

  const stripped = text
    .replace(/^CUTT?ABLE\s*[:：-]?\s*/i, '')
    .trim();
  if (!stripped || /^CUTTABLE$/i.test(stripped)) {
    return '';
  }

  return normalizeDimensionBody(stripped);
}

function normalizeWeightUnit(unit = '') {
  const normalized = String(unit || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
  if (normalized === 'GM2') {
    return 'G/M2';
  }
  if (/^G\/?SQ\.?M$/i.test(normalized) || normalized === 'GSQM') {
    return 'G/SQM';
  }
  if (normalized === 'OZYD2') {
    return 'OZ/YD2';
  }
  if (normalized === 'OZYD') {
    return 'OZ/YD';
  }
  return normalized;
}

function normalizeWeightAmount(amount = '', unit = '') {
  const text = String(amount || '').trim();
  const numeric = Number(text);
  if (/^OZ(?:\/YD2|\/YD)?$/i.test(normalizeWeightUnit(unit)) && text && !text.includes('.') && Number.isFinite(numeric) && numeric >= 30) {
    return `${text.slice(0, -1)}.${text.slice(-1)}`;
  }
  if (/^(G\/M2|GSM)$/i.test(normalizeWeightUnit(unit)) && text && !text.includes('.') && Number.isFinite(numeric) && numeric >= 1000) {
    return `${text.slice(0, -1)}.${text.slice(-1)}`;
  }
  return text;
}

function normalizeWeightText(value = '', rawText = '') {
  const text = normalizeFieldText(value).replace(/M²/gi, 'M2');
  const raw = normalizeFieldText(rawText).replace(/M²/gi, 'M2');
  const hasBW = /\bBW\b/i.test(`${text} ${raw}`) || /^BW/i.test(text);
  const source = text || raw;
  const compact = source
    .replace(/^BW\s*[:：-]?\s*/i, '')
    .replace(/\s*BW$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const match = compact.match(/(\d+(?:\.\d+)?)\s*(G\/M2|GM2|GSM|G\/SQM|GSQM|G\/SQ\.?M|OZ\/YD2|OZYD2|OZ\/YD|OZYD|OZ)(?:\s*BW)?/i);
  if (match) {
    const amount = normalizeWeightAmount(match[1], match[2]);
    const unit = normalizeWeightUnit(match[2]);
    return `${hasBW ? 'BW ' : ''}${amount}${unit}`.trim();
  }
  if (!hasBW || !/\d/.test(compact)) {
    return '';
  }
  return `${hasBW ? 'BW ' : ''}${compact}`.trim();
}

function scaleMaybeNormalizedBox(box = null, imageSize = null) {
  if (!box) {
    return null;
  }

  const normalizedBox = {
    left: Number(box.left) || 0,
    top: Number(box.top) || 0,
    width: Math.max(0, Number(box.width) || 0),
    height: Math.max(0, Number(box.height) || 0),
  };

  const looksNormalized = imageSize?.width
    && imageSize?.height
    && normalizedBox.left >= -0.01
    && normalizedBox.top >= -0.01
    && normalizedBox.left <= 1.25
    && normalizedBox.top <= 1.25
    && normalizedBox.width <= 1.25
    && normalizedBox.height <= 1.25;

  if (!looksNormalized) {
    return {
      ...normalizedBox,
      width: Math.max(1, normalizedBox.width),
      height: Math.max(1, normalizedBox.height),
    };
  }

  return {
    left: normalizedBox.left * imageSize.width,
    top: normalizedBox.top * imageSize.height,
    width: Math.max(1, normalizedBox.width * imageSize.width),
    height: Math.max(1, normalizedBox.height * imageSize.height),
  };
}

function deriveFallbackDetectorCropBox(lines = [], imageSize = null) {
  const normalizedLines = Array.isArray(lines) ? lines.filter(Boolean) : [];
  if (normalizedLines.length === 0) {
    return null;
  }

  const boxes = normalizedLines
    .map((line) => {
      const directBox = line?.box || line?.bbox || line?.rect || null;
      if (directBox && Number.isFinite(Number(directBox.left)) && Number.isFinite(Number(directBox.top))) {
        return scaleMaybeNormalizedBox({
          left: Number(directBox.left),
          top: Number(directBox.top),
          width: Math.max(1, Number(directBox.width) || 0),
          height: Math.max(1, Number(directBox.height) || 0),
        }, imageSize);
      }

      const points = Array.isArray(line?.points)
        ? line.points
        : Array.isArray(line?.polygon)
          ? line.polygon
          : Array.isArray(line?.quad)
            ? line.quad
            : null;
      if (points && points.length > 1) {
        const xs = points.map((point) => Number(point?.x ?? point?.[0])).filter(Number.isFinite);
        const ys = points.map((point) => Number(point?.y ?? point?.[1])).filter(Number.isFinite);
        if (xs.length > 1 && ys.length > 1) {
          const left = Math.min(...xs);
          const top = Math.min(...ys);
          const right = Math.max(...xs);
          const bottom = Math.max(...ys);
          return scaleMaybeNormalizedBox({
            left,
            top,
            width: Math.max(1, right - left),
            height: Math.max(1, bottom - top),
          }, imageSize);
        }
      }

      return null;
    })
    .filter(Boolean);

  if (boxes.length === 0) {
    return null;
  }

  const left = Math.min(...boxes.map((box) => box.left));
  const top = Math.min(...boxes.map((box) => box.top));
  const right = Math.max(...boxes.map((box) => box.left + box.width));
  const bottom = Math.max(...boxes.map((box) => box.top + box.height));

  return {
    left,
    top,
    width: Math.max(1, right - left),
    height: Math.max(1, bottom - top),
  };
}

function isLikelyLabelFieldLine(text = '') {
  const normalized = normalizeWhitespace(text).toUpperCase();
  if (!normalized) {
    return false;
  }

  return /\b(CODE|FABRIC|ITEM|REF|DESC|DESCRIPTION|CONT|CONTENT|COMP|COMPOSITION|WIDTH|CUTTABLE|SPEC|WEIGHT|BW|G\/M2|GM2|OZ\/YD2|OZ)\b/.test(normalized)
    || isCompositionLikeValue(normalized)
    || looksLikeStyleNumber(normalized)
    || /^([A-Z]{1,4}\d[A-Z0-9.\-]{5,}|[A-Z]{1,3}-\d{4,}[A-Z0-9.\-]*)$/i.test(normalized);
}

function extractLineTextCandidate(line = {}) {
  return normalizeFieldText(
    line?.text
    || line?.value
    || line?.label
    || line?.content
    || line?.rawText
    || '',
  );
}

function expandCropBox(box = null, imageSize = null, options = {}) {
  if (!box) {
    return null;
  }

  const padX = Number(options.padX ?? 18) || 18;
  const padY = Number(options.padY ?? 14) || 14;
  const maxWidth = Number(imageSize?.width) || 0;
  const maxHeight = Number(imageSize?.height) || 0;

  const left = Math.max(0, Math.floor((Number(box.left) || 0) - padX));
  const top = Math.max(0, Math.floor((Number(box.top) || 0) - padY));
  const right = Math.ceil((Number(box.left) || 0) + (Number(box.width) || 0) + padX);
  const bottom = Math.ceil((Number(box.top) || 0) + (Number(box.height) || 0) + padY);

  return {
    left,
    top,
    width: Math.max(1, Math.min(maxWidth || right, right) - left),
    height: Math.max(1, Math.min(maxHeight || bottom, bottom) - top),
  };
}

function deriveFocusedOcrFieldCropBox(lines = [], imageSize = null) {
  const normalizedLines = Array.isArray(lines) ? lines.filter(Boolean) : [];
  if (normalizedLines.length === 0) {
    return null;
  }

  const fieldLines = normalizedLines.filter((line) => isLikelyLabelFieldLine(extractLineTextCandidate(line)));
  if (fieldLines.length === 0) {
    return null;
  }

  const focusedBox = deriveFallbackDetectorCropBox(fieldLines, imageSize);
  if (!focusedBox) {
    return null;
  }

  return expandCropBox(focusedBox, imageSize, { padX: 20, padY: 16 });
}

function deriveVariantCropBox(variant = {}, imageSize = null) {
  if (!imageSize?.width || !imageSize?.height) {
    return null;
  }

  if (
    Number.isFinite(variant?.leftPx)
    && Number.isFinite(variant?.topPx)
    && Number.isFinite(variant?.widthPx)
    && Number.isFinite(variant?.heightPx)
  ) {
    return {
      left: Math.max(0, Number(variant.leftPx) || 0),
      top: Math.max(0, Number(variant.topPx) || 0),
      width: Math.max(1, Number(variant.widthPx) || 0),
      height: Math.max(1, Number(variant.heightPx) || 0),
    };
  }

  if (variant?.crop === 'full') {
    return {
      left: 0,
      top: 0,
      width: imageSize.width,
      height: imageSize.height,
    };
  }

  const leftRatio = Math.max(0, Math.min(1, Number(variant?.left) || 0));
  const topRatio = Math.max(0, Math.min(1, Number(variant?.top) || 0));
  const widthRatio = Math.max(0.01, Math.min(1, Number(variant?.widthRatio) || 0));
  const heightRatio = Math.max(0.01, Math.min(1, Number(variant?.heightRatio) || 0));

  if (!Number.isFinite(widthRatio) || !Number.isFinite(heightRatio)) {
    return null;
  }

  const left = Math.max(0, Math.min(imageSize.width - 1, Math.floor(imageSize.width * leftRatio)));
  const top = Math.max(0, Math.min(imageSize.height - 1, Math.floor(imageSize.height * topRatio)));
  const width = Math.max(1, Math.min(imageSize.width - left, Math.ceil(imageSize.width * widthRatio)));
  const height = Math.max(1, Math.min(imageSize.height - top, Math.ceil(imageSize.height * heightRatio)));

  return { left, top, width, height };
}

function resolveDetectorBoxSource({
  detectorUsed = false,
  focusedFieldCropBox = null,
  fallbackDetectorCropBox = null,
  variantDetectorCropBox = null,
} = {}) {
  // When OCR has actually located the label-field text (focusedFieldCropBox is
  // present), trust it over the detector. The YOLO detector occasionally hugs
  // a large fabric region instead of the inset label, but OCR-field matches
  // only happen when key alias text (FAB / DESC / STYLE …) was decoded, so
  // their position is much more reliable on those cases.
  if (focusedFieldCropBox) {
    return 'ocr-fields';
  }
  if (detectorUsed) {
    return 'detector';
  }
  if (fallbackDetectorCropBox) {
    return 'ocr-lines';
  }
  if (variantDetectorCropBox) {
    return 'crop-region';
  }
  return '';
}

function parseLabelOcrText(rawText, profile = LABEL_OCR_DEFAULTS, ocrLines = []) {
  const normalizedProfile = normalizeLabelOcrProfile(profile);
  const normalized = normalizeWhitespace(rawText);
  const lines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const allAliases = Object.values(normalizedProfile.fields || {}).flat();
  const positionedLines = buildPositionedOcrLines(ocrLines);

  const explicitFabricCode = parseAdjacentAliasValuePairs(lines, normalizedProfile.fields.fabricCode, allAliases)
    || parseFieldFromLines(lines, normalizedProfile.fields.fabricCode, allAliases)
    || parseSpatialFieldFromLines(positionedLines, normalizedProfile.fields.fabricCode, allAliases)
    || parseRelaxedAliasValue(lines, normalizedProfile.fields.fabricCode, allAliases, { requireDigit: true });
  const styleNumberAliases = (normalizedProfile.fields.styleNumber || [])
    .filter((alias) => !/^DESC(?:RIPTION)?$/i.test(String(alias || '').trim()));
  const descriptionAliases = [
    ...(normalizedProfile.fields.description || []),
    'DESC',
    'DESCRIPTION',
  ];
  const explicitStyleCandidate = parseAdjacentAliasValuePairs(lines, styleNumberAliases, allAliases)
    || parseFieldFromLines(lines, styleNumberAliases, allAliases)
    || parseSpatialFieldFromLines(positionedLines, styleNumberAliases, allAliases)
    || parseRelaxedAliasValue(lines, styleNumberAliases, allAliases, { requireDigit: true });
  const explicitDescription = parseFieldFromLines(lines, descriptionAliases, allAliases)
    || parseSpatialFieldFromLines(positionedLines, descriptionAliases, allAliases);
  const explicitStyleText = normalizeFieldText(explicitStyleCandidate);
  const explicitStyleNumber = explicitStyleText
    ? normalizeStyleNumberText(explicitStyleText)
    : '';
  let description = normalizeFieldText(explicitDescription);
  const descriptionLineIndex = lines.findIndex((line) => descriptionAliases.some((alias) => matchesAliasToken(line, alias)));
  if (description && descriptionLineIndex >= 0) {
    const nextLine = String(lines[descriptionLineIndex + 1] || '').trim();
    const nextNextLine = String(lines[descriptionLineIndex + 2] || '').trim();
    const nextLineLooksLikeComposition = isCompositionLikeValue(description);
    const nextAliasLooksLikeComposition = /^(CONT|COMPOSITION|COMP|CONTENT)\b/i.test(nextNextLine);
    if (
      !stripAliasPrefix(lines[descriptionLineIndex], descriptionAliases)
      && nextLine === description
      && nextLineLooksLikeComposition
      && nextAliasLooksLikeComposition
    ) {
      description = '';
    }
  }
  const fallbackStyleNumber = normalizeStyleNumberText(findFallbackStyleNumberLine(lines, normalized));
  const fallbackFabricCode = findFallbackFabricCodeLine(lines);
  const candidateFabricCode = normalizeFabricCodeText(explicitFabricCode || fallbackFabricCode);
  let styleNumber = explicitStyleNumber || fallbackStyleNumber;
  const normalizedCodeToken = normalizeKeyToken(candidateFabricCode);
  const normalizedStyleToken = normalizeKeyToken(styleNumber);
  if (
    !explicitStyleText
    && normalizedCodeToken
    && normalizedStyleToken
    && normalizedCodeToken === normalizedStyleToken
  ) {
    styleNumber = '';
  }
  if (!explicitStyleText && styleNumber && normalizedCodeToken && normalizeKeyToken(styleNumber) === normalizedCodeToken) {
    styleNumber = '';
  }
  const styleNumberLooksLikeFabricCode = styleNumber && /^([A-Z]{1,4}\d[A-Z0-9.\-]{5,}|[A-Z]{1,3}-\d{4,}[A-Z0-9.\-]*)$/i.test(styleNumber);
  // A label can legitimately carry both a style number and a fabric code
  // ("Fabric ID #:F26030082" next to "Style #: DAM80"). Keep the scanned fabric
  // code whenever it differs from the style token we already resolved.
  const fabricCode = explicitFabricCode
    ? candidateFabricCode
    : (candidateFabricCode && normalizedCodeToken && normalizedCodeToken !== normalizedStyleToken
      ? candidateFabricCode
      : (!explicitStyleText && styleNumberLooksLikeFabricCode ? styleNumber : ''));
  const explicitComposition = collectCompositionBlock(lines, normalizedProfile.fields.composition, allAliases)
    || parseAdjacentAliasValuePairs(lines, normalizedProfile.fields.composition, allAliases)
    || parseFieldFromLines(lines, normalizedProfile.fields.composition, allAliases)
    || parseSpatialFieldFromLines(positionedLines, normalizedProfile.fields.composition, allAliases);
  const composition = normalizeCompositionText(explicitComposition)
    || normalizeCompositionText(findFallbackCompositionLine(lines));
  const explicitWidthSource = parseFieldFromLines(lines, normalizedProfile.fields.width, allAliases)
    || parseSpatialFieldFromLines(positionedLines, normalizedProfile.fields.width, allAliases);
  const widthSource = normalizeWidthText(explicitWidthSource)
    ? explicitWidthSource
    : (findFallbackWidthLine(lines) || explicitWidthSource);
  const widthRaw = normalizeFieldText(widthSource);
  const explicitCuttableSource = parseFieldFromLines(lines, normalizedProfile.fields.cuttable, allAliases)
    || parseSpatialFieldFromLines(positionedLines, normalizedProfile.fields.cuttable, allAliases);
  const cuttableRaw = normalizeFieldText(explicitCuttableSource);
  const explicitWeightSource = parseFieldFromLines(lines, normalizedProfile.fields.weight, allAliases)
    || parseSpatialFieldFromLines(positionedLines, normalizedProfile.fields.weight, allAliases);
  const weightSource = normalizeWeightText(explicitWeightSource, normalized)
    ? explicitWeightSource
    : (findFallbackWeightLine(lines) || explicitWeightSource);
  const weight = normalizeWeightText(weightSource, normalized);
  const width = normalizeWidthText(widthRaw).trim();
  const cuttable = normalizeCuttableText(cuttableRaw)
    || findFallbackCuttableValue(lines);

  return {
    rawText: normalized,
    fabricCode,
    styleNumber,
    description,
    composition,
    width,
    cuttable,
    weight,
  };
}

function findFallbackCompositionLine(lines = []) {
  const list = Array.isArray(lines) ? lines : [];

  for (let index = 0; index < list.length; index += 1) {
    const current = String(list[index] || '').trim();
    if (!current) {
      continue;
    }

    if (/^(CONT|COMPOSITION|COMP|CONTENT)\b/i.test(current)) {
      const nearby = [
        stripAliasPrefix(current, ['COMPOSITION', 'CONTENT', 'CONT', 'COMP']),
        String(list[index + 1] || '').trim(),
        String(list[index - 1] || '').trim(),
      ].filter(Boolean);
      const candidate = nearby.find((value) => isCompositionLikeValue(value));
      if (candidate) {
        return candidate;
      }
    }

    if (isCompositionLikeValue(current)) {
      return current;
    }
  }

  return '';
}

function countLabelAliasHits(rawText = '', profile = LABEL_OCR_DEFAULTS) {
  const normalized = normalizeWhitespace(rawText).toUpperCase();
  const aliases = Object.values(normalizeLabelOcrProfile(profile).fields || {})
    .flat()
    .map((alias) => String(alias || '').toUpperCase())
    .filter(Boolean);

  return [...new Set(aliases)].filter((alias) => normalized.includes(alias)).length;
}

function scoreLabelOcrAttempt(parsedInfo = {}, profile = LABEL_OCR_DEFAULTS) {
  let score = 0;
  if (parsedInfo.fabricCode) score += 10;
  if (parsedInfo.styleNumber) score += 10;
  if (parsedInfo.description) score += 6;
  if (parsedInfo.composition) score += 4;
  if (parsedInfo.width) score += 3;
  if (parsedInfo.weight) score += 3;
  if (parsedInfo.cuttable) score += 1;
  score += Math.min(4, countLabelAliasHits(parsedInfo.rawText, profile));
  score += Math.min(3, Math.floor(String(parsedInfo.rawText || '').length / 40));
  return score;
}

function buildIntegralGrid(width, height, values) {
  const integral = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y += 1) {
    let rowSum = 0;
    for (let x = 0; x < width; x += 1) {
      rowSum += values[(y * width) + x];
      integral[((y + 1) * (width + 1)) + (x + 1)] = integral[(y * (width + 1)) + (x + 1)] + rowSum;
    }
  }
  return integral;
}

function readIntegral(integral, stride, left, top, width, height) {
  const right = left + width;
  const bottom = top + height;
  return integral[(bottom * stride) + right]
    - integral[(top * stride) + right]
    - integral[(bottom * stride) + left]
    + integral[(top * stride) + left];
}

function clampInteger(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function computeLabelWindowMetrics(brightnessIntegral, darkIntegral, stride, rect) {
  const area = Math.max(1, rect.width * rect.height);
  const brightnessSum = readIntegral(brightnessIntegral, stride, rect.left, rect.top, rect.width, rect.height);
  const darkSum = readIntegral(darkIntegral, stride, rect.left, rect.top, rect.width, rect.height);
  return {
    avgBrightness: brightnessSum / area,
    darkRatio: darkSum / area,
  };
}

function scoreEdgeBand(metrics, edgeDistance, dimension) {
  const edgeBonus = 1 - Math.min(1, edgeDistance / Math.max(1, dimension * 0.38));
  return (metrics.avgBrightness * 0.55) + (metrics.darkRatio * 180) + (edgeBonus * 26);
}

function scoreDenseSubwindow(metrics, distanceToEdge, dimension) {
  const edgeBonus = 1 - Math.min(1, distanceToEdge / Math.max(1, dimension * 0.5));
  return (metrics.avgBrightness * 0.45) + (metrics.darkRatio * 220) + (edgeBonus * 12);
}

function getCropSpecPriority(cropSpec = {}) {
  if (Number.isFinite(cropSpec.priority)) {
    return Number(cropSpec.priority);
  }
  const key = String(cropSpec.key || '');
  if (key === 'full') return 0;
  if (key.startsWith('adaptive-')) return 140;
  if (/right-(card|tall-card|table)/i.test(key)) return 120;
  if (/left-card/i.test(key)) return 108;
  if (/top-(right|left)-(card|table)/i.test(key)) return 102;
  if (key === 'right-band') return 96;
  if (key === 'top-band') return 82;
  if (key === 'left-band') return 74;
  return 60;
}

async function detectAdaptiveLabelCropSpecs(imagePath) {
  if (!sharp) {
    return [];
  }

  const preview = sharp(imagePath).rotate();
  const metadata = await preview.metadata();
  const fullWidth = metadata.width || 0;
  const fullHeight = metadata.height || 0;
  if (!fullWidth || !fullHeight) {
    return [];
  }

  const maxPreview = 280;
  const scale = maxPreview / Math.max(fullWidth, fullHeight);
  const previewWidth = Math.max(64, Math.round(fullWidth * scale));
  const previewHeight = Math.max(64, Math.round(fullHeight * scale));
  const { data, info } = await preview
    .resize(previewWidth, previewHeight, { fit: 'fill' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixelCount = info.width * info.height;
  const brightness = new Float64Array(pixelCount);
  const darkMask = new Float64Array(pixelCount);
  for (let index = 0; index < pixelCount; index += 1) {
    const offset = index * info.channels;
    const r = data[offset] || 0;
    const g = data[offset + 1] || 0;
    const b = data[offset + 2] || 0;
    const a = (info.channels >= 4 ? data[offset + 3] : 255) / 255;
    const luma = ((0.299 * r) + (0.587 * g) + (0.114 * b)) * a + (255 * (1 - a));
    brightness[index] = luma;
    darkMask[index] = luma < 188 ? 1 : 0;
  }

  const stride = info.width + 1;
  const brightnessIntegral = buildIntegralGrid(info.width, info.height, brightness);
  const darkIntegral = buildIntegralGrid(info.width, info.height, darkMask);

  let bestVerticalBand = null;
  const verticalWidths = [0.14, 0.18, 0.22, 0.26];
  for (const ratio of verticalWidths) {
    const bandWidth = clampInteger(info.width * ratio, 12, info.width - 1);
    const step = Math.max(2, Math.round(bandWidth / 8));
    for (let left = 0; left <= info.width - bandWidth; left += step) {
      const rect = { left, top: 0, width: bandWidth, height: info.height };
      const metrics = computeLabelWindowMetrics(brightnessIntegral, darkIntegral, stride, rect);
      const distanceToEdge = Math.min(left, Math.max(0, info.width - (left + bandWidth)));
      const score = scoreEdgeBand(metrics, distanceToEdge, info.width);
      if (!bestVerticalBand || score > bestVerticalBand.score) {
        bestVerticalBand = { ...rect, metrics, score };
      }
    }
  }

  let bestHorizontalBand = null;
  const horizontalHeights = [0.12, 0.16, 0.22, 0.28];
  for (const ratio of horizontalHeights) {
    const bandHeight = clampInteger(info.height * ratio, 12, info.height - 1);
    const step = Math.max(2, Math.round(bandHeight / 8));
    for (let top = 0; top <= info.height - bandHeight; top += step) {
      const rect = { left: 0, top, width: info.width, height: bandHeight };
      const metrics = computeLabelWindowMetrics(brightnessIntegral, darkIntegral, stride, rect);
      const distanceToEdge = Math.min(top, Math.max(0, info.height - (top + bandHeight)));
      const score = scoreEdgeBand(metrics, distanceToEdge, info.height);
      if (!bestHorizontalBand || score > bestHorizontalBand.score) {
        bestHorizontalBand = { ...rect, metrics, score };
      }
    }
  }

  const adaptiveSpecs = [];

  if (bestVerticalBand) {
    let bestVerticalFocus = null;
    const focusHeights = [0.24, 0.30, 0.36, 0.42];
    for (const ratio of focusHeights) {
      const focusHeight = clampInteger(info.height * ratio, 12, info.height);
      const step = Math.max(2, Math.round(focusHeight / 7));
      for (let top = 0; top <= info.height - focusHeight; top += step) {
        const rect = {
          left: bestVerticalBand.left,
          top,
          width: bestVerticalBand.width,
          height: focusHeight,
        };
        const metrics = computeLabelWindowMetrics(brightnessIntegral, darkIntegral, stride, rect);
        const distanceToEdge = Math.min(top, Math.max(0, info.height - (top + focusHeight)));
        const score = scoreDenseSubwindow(metrics, distanceToEdge, info.height);
        if (!bestVerticalFocus || score > bestVerticalFocus.score) {
          bestVerticalFocus = { ...rect, metrics, score };
        }
      }
    }

    const leftPx = Math.max(0, Math.floor((bestVerticalBand.left / info.width) * fullWidth));
    const widthPx = Math.max(1, Math.ceil((bestVerticalBand.width / info.width) * fullWidth));
    if (bestVerticalFocus) {
      const topPx = Math.max(0, Math.floor((bestVerticalFocus.top / info.height) * fullHeight));
      const heightPx = Math.max(1, Math.ceil((bestVerticalFocus.height / info.height) * fullHeight));
      adaptiveSpecs.push({
        key: 'adaptive-vertical-focus',
        leftPx,
        topPx,
        widthPx,
        heightPx,
        preferredAngles: [90, 270, 0],
        priority: Math.round(bestVerticalFocus.score || 0),
      });
    }
  }

  if (bestHorizontalBand) {
    let bestHorizontalFocus = null;
    const focusWidths = [0.22, 0.30, 0.38, 0.46];
    for (const ratio of focusWidths) {
      const focusWidth = clampInteger(info.width * ratio, 12, info.width);
      const step = Math.max(2, Math.round(focusWidth / 7));
      for (let left = 0; left <= info.width - focusWidth; left += step) {
        const rect = {
          left,
          top: bestHorizontalBand.top,
          width: focusWidth,
          height: bestHorizontalBand.height,
        };
        const metrics = computeLabelWindowMetrics(brightnessIntegral, darkIntegral, stride, rect);
        const distanceToEdge = Math.min(left, Math.max(0, info.width - (left + focusWidth)));
        const score = scoreDenseSubwindow(metrics, distanceToEdge, info.width);
        if (!bestHorizontalFocus || score > bestHorizontalFocus.score) {
          bestHorizontalFocus = { ...rect, metrics, score };
        }
      }
    }

    if (bestHorizontalFocus) {
      adaptiveSpecs.push({
        key: 'adaptive-horizontal-focus',
        leftPx: Math.max(0, Math.floor((bestHorizontalFocus.left / info.width) * fullWidth)),
        topPx: Math.max(0, Math.floor((bestHorizontalFocus.top / info.height) * fullHeight)),
        widthPx: Math.max(1, Math.ceil((bestHorizontalFocus.width / info.width) * fullWidth)),
        heightPx: Math.max(1, Math.ceil((bestHorizontalFocus.height / info.height) * fullHeight)),
        preferredAngles: [0, 180, 90, 270],
        priority: Math.round(bestHorizontalFocus.score || 0),
      });
    }
  }

  return adaptiveSpecs;
}

async function renderLabelOcrVariantBuffer(pipeline, cropSpec = {}, angle = 0) {
  const preprocessMode = cropSpec.preprocessMode || 'label-boost';
  const upscaleWidth = Number(cropSpec.upscaleWidth) || 0;
  const stagedTransform = cropSpec.stagedTransform === true;

  let workingBuffer;
  if (stagedTransform) {
    const extractedBuffer = await pipeline.png().toBuffer();
    let staged = sharp(extractedBuffer).rotate(angle);
    if (upscaleWidth > 0) {
      staged = staged.resize({
        width: upscaleWidth,
        withoutEnlargement: false,
        kernel: 'lanczos3',
      });
    }
    workingBuffer = await staged
      .flatten({ background: '#ffffff' })
      .png()
      .toBuffer();
  } else {
    let staged = pipeline.rotate(angle);
    if (upscaleWidth > 0) {
      staged = staged.resize({
        width: upscaleWidth,
        withoutEnlargement: false,
        kernel: 'lanczos3',
      });
    }
    workingBuffer = await staged
      .flatten({ background: '#ffffff' })
      .png()
      .toBuffer();
  }

  if (!sharp || preprocessMode === 'none') {
    return workingBuffer;
  }

  let enhanced = sharp(workingBuffer).grayscale().normalize().sharpen();
  if (preprocessMode === 'label-binary') {
    enhanced = enhanced
      .median(1)
      .linear(1.12, -8)
      .threshold(176);
  } else if (preprocessMode === 'label-boost-strong') {
    enhanced = enhanced
      .median(1)
      .linear(1.2, -10)
      .sharpen({ sigma: 1.1, m1: 1.2, m2: 2.2, x1: 2, y2: 10, y3: 20 });
  } else {
    enhanced = enhanced
      .linear(1.08, -4)
      .sharpen({ sigma: 0.9, m1: 1, m2: 2, x1: 2, y2: 10, y3: 18 });
  }

  return enhanced.png().toBuffer();
}

async function buildRotatedLabelVariants(imagePath, options = {}) {
  const fastOnly = options.fastOnly === true;
  const scanStage = options.scanStage === 'fallback' ? 'fallback' : 'initial';
  if (!sharp) {
    return [{
      angle: 0,
      crop: 'full',
      imagePath,
      buffer: fs.readFileSync(imagePath),
      cleanup: () => {},
    }];
  }

  const tempDir = path.join(os.tmpdir(), 'gsbot-label-ocr');
  fs.mkdirSync(tempDir, { recursive: true });
  const variants = [];
  const baseImage = sharp(imagePath).rotate();
  const metadata = await baseImage.metadata();
  const width = metadata.width || 0;
  const height = metadata.height || 0;
  const adaptiveCropSpecs = await detectAdaptiveLabelCropSpecs(imagePath);
  const orientationCropSpecs = [];

  if (width > height) {
    const landscapeCardPresets = [
      { key: 'landscape-left-card', left: 0.17, top: 0, widthRatio: 0.22, heightRatio: 0.40, upscaleWidth: 2200 },
      { key: 'landscape-left-card-tight', left: 0.20, top: 0.02, widthRatio: 0.18, heightRatio: 0.32, upscaleWidth: 2200 },
      { key: 'landscape-right-card', left: 0.61, top: 0, widthRatio: 0.22, heightRatio: 0.40, upscaleWidth: 2200 },
      { key: 'landscape-right-card-tight', left: 0.64, top: 0.02, widthRatio: 0.18, heightRatio: 0.32, upscaleWidth: 2200 },
      { key: 'landscape-right-tall-card', left: 0.72, top: 0, widthRatio: 0.25, heightRatio: 0.98, upscaleWidth: 2400 },
      { key: 'landscape-right-tall-card-tight', left: 0.77, top: 0.02, widthRatio: 0.20, heightRatio: 0.96, upscaleWidth: 2600 },
      { key: 'landscape-left-band-wide', left: 0.08, top: 0, widthRatio: 0.34, heightRatio: 0.56, upscaleWidth: 2600, preprocessMode: 'label-boost-strong' },
      { key: 'landscape-right-band-wide', left: 0.58, top: 0, widthRatio: 0.34, heightRatio: 0.56, upscaleWidth: 2600, preprocessMode: 'label-boost-strong' },
      { key: 'landscape-top-table-wide', left: 0.10, top: 0.00, widthRatio: 0.78, heightRatio: 0.48, upscaleWidth: 2800, preprocessMode: 'label-binary' },
    ];
    landscapeCardPresets.forEach((preset) => {
      orientationCropSpecs.push({
        ...preset,
        preferredAngles: [90, 270],
        stagedTransform: true,
      });
    });
  } else {
    const portraitCardPresets = [
      { key: 'portrait-top-left-card', left: 0.02, top: 0.02, widthRatio: 0.52, heightRatio: 0.24 },
      { key: 'portrait-top-right-card', left: 0.46, top: 0.02, widthRatio: 0.52, heightRatio: 0.24 },
      { key: 'portrait-top-left-card-tight', left: 0.06, top: 0.04, widthRatio: 0.42, heightRatio: 0.20 },
      { key: 'portrait-top-right-table', left: 0.74, top: 0.01, widthRatio: 0.24, heightRatio: 0.32, upscaleWidth: 3200, preferredAngles: [0, 180] },
      { key: 'portrait-top-right-table-tight', left: 0.78, top: 0.03, widthRatio: 0.20, heightRatio: 0.28, upscaleWidth: 3600, preferredAngles: [0, 180] },
      { key: 'portrait-top-table-wide', left: 0.10, top: 0.00, widthRatio: 0.80, heightRatio: 0.34, upscaleWidth: 3000, preferredAngles: [0, 180], preprocessMode: 'label-binary' },
      { key: 'portrait-upper-half', left: 0.00, top: 0.00, widthRatio: 1.00, heightRatio: 0.52, upscaleWidth: 2600, preferredAngles: [0, 180], preprocessMode: 'label-boost-strong' },
    ];
    portraitCardPresets.forEach((preset) => {
      orientationCropSpecs.push({
        ...preset,
        preferredAngles: preset.preferredAngles || [0, 180],
        stagedTransform: true,
      });
    });
  }

  const cropSpecs = [
    { key: 'full', left: 0, top: 0, widthRatio: 1, heightRatio: 1, priority: 0, preprocessMode: 'label-boost' },
    { key: 'full-upscaled', left: 0, top: 0, widthRatio: 1, heightRatio: 1, priority: 12, upscaleWidth: 2800, preprocessMode: 'label-binary' },
    { key: 'top-band', left: 0, top: 0, widthRatio: 1, heightRatio: 0.38, priority: 82, preprocessMode: 'label-boost' },
    { key: 'top-band-tall', left: 0, top: 0, widthRatio: 1, heightRatio: 0.52, priority: 88, preprocessMode: 'label-binary' },
    { key: 'left-band', left: 0, top: 0, widthRatio: 0.38, heightRatio: 1, priority: 74, preprocessMode: 'label-boost' },
    { key: 'left-band-wide', left: 0, top: 0, widthRatio: 0.48, heightRatio: 1, priority: 79, preprocessMode: 'label-boost-strong' },
    { key: 'right-band', left: 0.62, top: 0, widthRatio: 0.38, heightRatio: 1, priority: 96, preprocessMode: 'label-boost' },
    { key: 'right-band-wide', left: 0.52, top: 0, widthRatio: 0.48, heightRatio: 1, priority: 101, preprocessMode: 'label-boost-strong' },
    { key: 'top-right-block', left: 0.56, top: 0, widthRatio: 0.44, heightRatio: 0.34, priority: 100, preprocessMode: 'label-binary' },
    { key: 'top-left-block', left: 0, top: 0, widthRatio: 0.44, heightRatio: 0.34, priority: 94, preprocessMode: 'label-binary' },
    { key: 'top-center-block', left: 0.22, top: 0, widthRatio: 0.56, heightRatio: 0.34, priority: 98, preprocessMode: 'label-binary' },
    { key: 'upper-half', left: 0, top: 0, widthRatio: 1, heightRatio: 0.58, priority: 86, preprocessMode: 'label-boost-strong' },
    ...orientationCropSpecs,
    ...adaptiveCropSpecs,
  ].sort((left, right) => getCropSpecPriority(right) - getCropSpecPriority(left));

  const initialPriorityKeys = new Set([
    'full',
    'adaptive-vertical-focus',
    'adaptive-horizontal-focus',
  ]);

  const initialVariantsSeen = new Set();
  const selectedCropSpecs = scanStage === 'fallback'
    ? cropSpecs
    : cropSpecs.filter((cropSpec) => {
      if (initialPriorityKeys.has(cropSpec.key)) {
        initialVariantsSeen.add(cropSpec.key);
        return true;
      }
      if (/^(portrait|landscape)-/i.test(cropSpec.key) && initialVariantsSeen.size < 5) {
        initialVariantsSeen.add(cropSpec.key);
        return true;
      }
      if (/^(top-right-block|top-left-block|right-band)$/i.test(cropSpec.key) && initialVariantsSeen.size < 7) {
        initialVariantsSeen.add(cropSpec.key);
        return true;
      }
      if (/^(top-center-block|top-band-tall|upper-half|full-upscaled|right-band-wide)$/i.test(cropSpec.key) && initialVariantsSeen.size < 10) {
        initialVariantsSeen.add(cropSpec.key);
        return true;
      }
      return false;
    }).sort((left, right) => getCropSpecPriority(right) - getCropSpecPriority(left));

  for (const cropSpec of selectedCropSpecs) {
    const angleCandidates = cropSpec.preferredAngles || [0, 90, 180, 270];
    let angleSet;
    if (fastOnly) {
      angleSet = [angleCandidates[0] ?? 0];
    } else if (scanStage === 'initial') {
      if (cropSpec.key === 'full') {
        // Full-image pass: also try 90° in the initial sweep so labels photographed
        // sideways (very common with handheld phone shots) get a real chance before
        // we move on to narrower crops.
        const wanted = [0, 90];
        const ordered = wanted
          .map((angle) => angleCandidates.find((candidate) => candidate === angle))
          .filter((angle) => angle !== undefined);
        angleSet = ordered.length > 0 ? ordered : [angleCandidates[0] ?? 0];
      } else {
        angleSet = angleCandidates.slice(0, Math.min(2, angleCandidates.length));
      }
    } else {
      angleSet = angleCandidates;
    }
    for (const angle of angleSet) {
      try {
        let pipeline = sharp(imagePath).rotate();
        let extractedBuffer = null;

        if (cropSpec.leftPx != null && cropSpec.topPx != null && cropSpec.widthPx != null && cropSpec.heightPx != null) {
          const left = Math.min(Math.max(0, cropSpec.leftPx), Math.max(0, width - 1));
          const top = Math.min(Math.max(0, cropSpec.topPx), Math.max(0, height - 1));
          const availableWidth = Math.max(1, width - left);
          const availableHeight = Math.max(1, height - top);
          pipeline = pipeline.extract({
            left,
            top,
            width: Math.max(1, Math.min(availableWidth, cropSpec.widthPx)),
            height: Math.max(1, Math.min(availableHeight, cropSpec.heightPx)),
          });
        } else if (cropSpec.key !== 'full' && width && height) {
          const left = Math.min(Math.max(0, Math.floor(width * cropSpec.left)), Math.max(0, width - 1));
          const top = Math.min(Math.max(0, Math.floor(height * cropSpec.top)), Math.max(0, height - 1));
          const availableWidth = Math.max(1, width - left);
          const availableHeight = Math.max(1, height - top);
          const requestedWidth = Math.max(1, Math.floor(width * cropSpec.widthRatio));
          const requestedHeight = Math.max(1, Math.floor(height * cropSpec.heightRatio));
          pipeline = pipeline.extract({
            left,
            top,
            width: Math.max(1, Math.min(availableWidth, requestedWidth)),
            height: Math.max(1, Math.min(availableHeight, requestedHeight)),
          });
        }

        const transformedBuffer = await renderLabelOcrVariantBuffer(pipeline, cropSpec, angle);

        const tempPath = path.join(
          tempDir,
          `label-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}-${cropSpec.key}-${angle}.png`,
        );
        fs.writeFileSync(tempPath, transformedBuffer);
        variants.push({
          angle,
          crop: cropSpec.key,
          left: cropSpec.left,
          top: cropSpec.top,
          widthRatio: cropSpec.widthRatio,
          heightRatio: cropSpec.heightRatio,
          leftPx: cropSpec.leftPx,
          topPx: cropSpec.topPx,
          widthPx: cropSpec.widthPx,
          heightPx: cropSpec.heightPx,
          imagePath: tempPath,
          buffer: transformedBuffer,
          cleanup: () => {
            try {
              fs.unlinkSync(tempPath);
            } catch {
              // Best effort cleanup only.
            }
          },
        });
      } catch (error) {
        if (!/extract_area:\s*bad extract area/i.test(String(error?.message || error || ''))) {
          throw error;
        }
      }
    }
  }

  return variants;
}

async function createDisplayImageVariant(imagePath, angle = 0) {
  if (!sharp || !angle) {
    return '';
  }

  const tempDir = path.join(os.tmpdir(), 'gsbot-label-display');
  fs.mkdirSync(tempDir, { recursive: true });
  const sourceExt = path.extname(imagePath).toLowerCase();
  const outputExt = ['.jpg', '.jpeg', '.png', '.webp'].includes(sourceExt) ? sourceExt : '.png';
  const format = outputExt === '.jpg' ? 'jpeg' : outputExt.slice(1);
  const tempPath = path.join(
    tempDir,
    `display-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}-${angle}${outputExt}`,
  );

  const normalizedBuffer = await sharp(imagePath)
    .rotate()
    .toBuffer();
  let pipeline = sharp(normalizedBuffer).rotate(angle);
  if (format === 'jpeg') {
    pipeline = pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: 92 });
  } else if (format === 'png') {
    pipeline = pipeline.png();
  } else if (format === 'webp') {
    pipeline = pipeline.webp({ quality: 92 });
  }

  await pipeline.toFile(tempPath);
  return tempPath;
}

async function hydrateCachedLabelResult(imagePath, cachedResult = {}) {
  const nextResult = {
    rawText: '',
    fabricCode: '',
    styleNumber: '',
    description: '',
    composition: '',
    width: '',
    cuttable: '',
    weight: '',
    ocrEngine: 'guten-ocr',
    angle: 0,
    crop: 'full',
    score: 0,
    detectorUsed: false,
    detectorFallbackReason: '',
    detectorCropBox: null,
    detectorConfidence: null,
    detectorSourceImagePath: imagePath,
    detectorSourceImageSize: null,
    ...cachedResult,
    displayImagePath: '',
  };

  if (Number(nextResult.angle || 0)) {
    try {
      nextResult.displayImagePath = await createDisplayImageVariant(imagePath, nextResult.angle);
    } catch {
      nextResult.displayImagePath = '';
    }
  }

  return nextResult;
}

async function readImageSizeForPreview(imagePath) {
  if (!sharp || !imagePath || !fs.existsSync(imagePath)) {
    return null;
  }

  try {
    const metadata = await sharp(imagePath).metadata();
    const width = Number(metadata.width) || 0;
    const height = Number(metadata.height) || 0;
    return width && height ? { width, height } : null;
  } catch {
    return null;
  }
}

function isUsableLabelOcrResult(result = {}) {
  const candidate = result || {};
  return [
    candidate.rawText,
    candidate.fabricCode,
    candidate.styleNumber,
    candidate.description,
    candidate.composition,
    candidate.width,
    candidate.cuttable,
    candidate.weight,
  ].some((value) => String(value || '').trim());
}

function selectBestOcrAttempt(attempts = []) {
  return attempts
    .filter(Boolean)
    .sort((left, right) => {
      if ((right.score || 0) !== (left.score || 0)) {
        return (right.score || 0) - (left.score || 0);
      }
      if ((left.crop || 'full') !== (right.crop || 'full')) {
        return (left.crop || 'full') === 'full' ? 1 : -1;
      }
      return (left.angle || 0) - (right.angle || 0);
    })[0] || null;
}

function mergeOcrAttempts(attempts = []) {
  const bestAttempt = selectBestOcrAttempt(attempts);
  if (!bestAttempt) {
    return null;
  }

  const sortedAttempts = attempts
    .filter(Boolean)
    .sort((left, right) => (right.score || 0) - (left.score || 0));
  const merged = { ...bestAttempt };

  ['fabricCode', 'styleNumber', 'description', 'composition', 'width', 'cuttable', 'weight'].forEach((field) => {
    if (String(merged[field] || '').trim()) {
      return;
    }
    const candidate = sortedAttempts.find((attempt) => String(attempt?.[field] || '').trim());
    if (candidate) {
      merged[field] = candidate[field];
    }
  });

  if (!merged.detectorCropBox) {
    const detectorAttempt = sortedAttempts.find((attempt) => attempt?.detectorCropBox);
    if (detectorAttempt) {
      merged.detectorUsed = Boolean(detectorAttempt.detectorUsed);
      merged.detectorFallbackReason = detectorAttempt.detectorFallbackReason || '';
      merged.detectorCropBox = detectorAttempt.detectorCropBox || null;
      merged.detectorConfidence = detectorAttempt.detectorConfidence ?? null;
      merged.detectorSourceImagePath = detectorAttempt.detectorSourceImagePath || merged.detectorSourceImagePath || '';
      merged.detectorSourceImageSize = detectorAttempt.detectorSourceImageSize || merged.detectorSourceImageSize || null;
      merged.detectorBoxSource = detectorAttempt.detectorBoxSource || merged.detectorBoxSource || '';
    }
  }

  return merged;
}

function shouldStopLabelScan(result = {}) {
  if (!result) {
    return false;
  }

  const hasStyleNumber = Boolean(String(result.styleNumber || '').trim());
  const hasFabricCode = Boolean(String(result.fabricCode || '').trim());
  const hasComposition = Boolean(String(result.composition || '').trim());
  const hasWidth = Boolean(String(result.width || '').trim());
  const hasWeight = Boolean(String(result.weight || '').trim());
  const hasCuttable = Boolean(String(result.cuttable || '').trim());
  const score = Number(result.score || 0);
  const structureCount = [hasComposition, hasWidth, hasWeight, hasCuttable].filter(Boolean).length;

  // Refuse to early-stop when individual OCR lines have low confidence — a low-confidence
  // line usually signals the image is rotated or otherwise misaligned and the recognized
  // text is garbled (e.g. a sideways "Clean Colour" misread as "EEEC"). In those cases we
  // want to keep trying other crops/angles instead of locking in a bad result.
  const lines = Array.isArray(result?.lines) ? result.lines : [];
  if (lines.length > 0) {
    const confidences = lines
      .map((line) => Number(line?.mean))
      .filter((value) => Number.isFinite(value) && value > 0);
    if (confidences.length > 0) {
      const minConfidence = Math.min(...confidences);
      const avgConfidence = confidences.reduce((sum, value) => sum + value, 0) / confidences.length;
      if (minConfidence < 0.62 || avgConfidence < 0.84) {
        return false;
      }
    }
  }

  if ((hasStyleNumber || hasFabricCode) && structureCount >= 2 && score >= 20) {
    return true;
  }

  if (hasStyleNumber && hasFabricCode && structureCount >= 1 && score >= 18) {
    return true;
  }

  return score >= 24;
}

function shouldContinueScanForDetectorBox(result = {}) {
  if (!result) {
    return false;
  }

  if (result.detectorCropBox) {
    return false;
  }

  const hasPrimaryValue = Boolean(String(result.styleNumber || '').trim() || String(result.fabricCode || '').trim());
  const hasStructure = [
    result.description,
    result.composition,
    result.width,
    result.cuttable,
    result.weight,
  ].some((value) => String(value || '').trim());
  const rawTextLength = String(result.rawText || '').trim().length;

  return hasPrimaryValue && (hasStructure || rawTextLength >= 36);
}

function prioritizeFullVariantFirst(variants = []) {
  const list = Array.isArray(variants) ? [...variants] : [];
  return list.sort((left, right) => {
    const leftIsFull = (left?.crop || '') === 'full' ? 1 : 0;
    const rightIsFull = (right?.crop || '') === 'full' ? 1 : 0;
    if (leftIsFull !== rightIsFull) {
      return rightIsFull - leftIsFull;
    }
    return 0;
  });
}

function isFatalEnhancedOcrError(error) {
  const message = String(error?.message || error || '');
  return /enhanced ocr unavailable in this session/i.test(message)
    || /signal\s+sigtrap/i.test(message)
    || /exit code 133/i.test(message)
    || /cannot find module/i.test(message)
    || /unable to resolve label-ocr-engine/i.test(message)
    || /ocr model assets not found/i.test(message);
}


function isIgnorableEnhancedOcrCropError(error) {
  return /extract_area:\s*bad extract area/i.test(String(error?.message || error || ''));
}

async function runLocalLabelOcr(imagePath, emitLog, emitProgress, options = {}) {
  const normalizedProfile = normalizeLabelOcrProfile(options.profile);
  const debugLabelOcr = options.debugLabelOcr === true || process.env.GSBOT_DEBUG_LABEL_OCR === '1';
  const forceRefresh = options.forceRefresh === true;
  const ocrEngine = normalizeOcrEngineName(options.ocrEngine ?? options.engine ?? getDefaultOcrEngine());
  const ocrFallbackEngine = normalizeOcrEngineName(options.ocrFallbackEngine ?? options.fallbackEngine ?? '', {
    allowEmpty: true,
  });
  // Detector class id: 0 = fabric_label (default), 1 = style_label.
  // Plumbed through so fabric vs style modes pick the right YOLO class.
  const detectorTargetClass = Number.isFinite(options.fabricLabelDetectorTargetClass)
    ? Number(options.fabricLabelDetectorTargetClass)
    : 0;
  const fastMode = options.fastMode !== false && process.env.GSBOT_LABEL_OCR_FAST_MODE !== '0';
  const cacheOptions = {
    mode: 'label-analysis',
    profile: normalizedProfile,
    ocrEngine,
    ocrFallbackEngine,
    fastMode,
    detectorTargetClass,
  };
  const cacheVersion = 15;
  const cachedResult = forceRefresh
    ? null
    : readFileOperationCache(
      'label-ocr-results',
      imagePath,
      cacheOptions,
      { version: cacheVersion },
    );

  if (!forceRefresh && cachedResult && isUsableLabelOcrResult(cachedResult)) {
    emitLog?.('Label OCR: Using cached label analysis.', 'info');
    const hydratedResult = await hydrateCachedLabelResult(imagePath, cachedResult);
    if (hydratedResult?.detectorSourceImagePath && typeof emitProgress === 'function') {
      const detectorPreview = {
        stage: 'label-ocr',
        imagePath,
        detectorSourceImagePath: imagePath,
        crop: hydratedResult.crop || 'full',
        angle: hydratedResult.angle || 0,
        detectorUsed: Boolean(hydratedResult.detectorUsed),
        detectorFallbackReason: hydratedResult.detectorFallbackReason || '',
        detectorCropBox: hydratedResult.detectorCropBox || null,
        detectorConfidence: hydratedResult.detectorConfidence ?? null,
        detectorSourceImageSize: hydratedResult.detectorSourceImageSize || null,
      };
      emitProgress({
        preview: detectorPreview,
      });
      if (detectorPreview.detectorCropBox) {
        emitProgress({
          preview: {
            ...detectorPreview,
            stage: 'label-ocr-latched',
          },
        });
      }
    }
    return hydratedResult;
  }

  const allVariants = [];
  let lastIgnorableEnhancedCropFailure = '';
  const evaluateVariants = async (variants, hasLoggedFailureState) => {
    const enhancedAttempts = [];
    let enhancedFailed = hasLoggedFailureState;
    let bestMerged = null;

    for (const variant of prioritizeFullVariantFirst(variants)) {
      try {
        const enhancedResult = await runEnhancedLabelOcr(variant.imagePath, {
          profile: normalizedProfile,
          engine: ocrEngine,
          fallbackEngine: ocrFallbackEngine,
          useFabricLabelDetector: variant.crop === 'full',
          fabricLabelDetectorTargetClass: detectorTargetClass,
        });
        const canUseOcrLineFallbackBox = variant.crop === 'full' && Number(variant.angle || 0) === 0;
        const fallbackImageSize = await readImageSizeForPreview(imagePath);
        const focusedFieldCropBox = canUseOcrLineFallbackBox
          ? deriveFocusedOcrFieldCropBox(enhancedResult?.lines || [], fallbackImageSize)
          : null;
        const fallbackDetectorCropBox = canUseOcrLineFallbackBox
          ? deriveFallbackDetectorCropBox(enhancedResult?.lines || [], fallbackImageSize)
          : null;
        const variantDetectorCropBox = !focusedFieldCropBox && !fallbackDetectorCropBox && fallbackImageSize
          ? deriveVariantCropBox(variant, fallbackImageSize)
          : null;
        const detectorBoxSource = resolveDetectorBoxSource({
          detectorUsed: Boolean(enhancedResult?.detectorUsed),
          focusedFieldCropBox,
          fallbackDetectorCropBox,
          variantDetectorCropBox,
        });
        const fallbackDetectorSourceImageSize = fallbackDetectorCropBox ? fallbackImageSize : null;
        if ((enhancedResult?.detectorSourceImagePath || focusedFieldCropBox || fallbackDetectorCropBox || variantDetectorCropBox) && typeof emitProgress === 'function') {
          // Mirror resolveDetectorBoxSource preference order so the displayed
          // crop matches the box source we report: OCR-fields > detector >
          // OCR-lines > variant crop region. This keeps the green preview
          // rectangle on the actual label text when the model puts its box on
          // the wrong region (common on full-image fabric shots).
          const previewDetectorCropBox = focusedFieldCropBox
            || enhancedResult?.detectorCropBox
            || fallbackDetectorCropBox
            || variantDetectorCropBox;
          const detectorPreview = {
            stage: 'label-ocr',
            imagePath,
            detectorSourceImagePath: imagePath,
            crop: variant.crop || 'full',
            angle: variant.angle || 0,
            detectorUsed: Boolean(enhancedResult?.detectorUsed),
            detectorFallbackReason: (focusedFieldCropBox ? 'OCR field text override' : (enhancedResult?.detectorFallbackReason || (fallbackDetectorCropBox ? 'ocr lines fallback' : (variantDetectorCropBox ? 'crop region fallback' : '')))),
            detectorCropBox: previewDetectorCropBox || null,
            detectorConfidence: enhancedResult?.detectorConfidence ?? null,
            detectorBoxSource,
            detectorSourceImageSize: enhancedResult?.detectorSourceImageSize || fallbackDetectorSourceImageSize || null,
          };
          emitProgress({
            preview: detectorPreview,
          });
          if (detectorPreview.detectorCropBox) {
            emitProgress({
              preview: {
                ...detectorPreview,
                stage: 'label-ocr-latched',
              },
            });
          }
        }
        if (variant.crop === 'full' && enhancedResult?.detectorFallbackReason) {
          emitLog?.(`Label OCR: Detector crop fell back to the original image (${enhancedResult.detectorFallbackReason}).`, 'info');
        }
        const parsed = parseLabelOcrText(enhancedResult.rawText, normalizedProfile, enhancedResult.lines || []);
        if (debugLabelOcr) {
          emitLog?.(
            `Label OCR Debug: variant=${variant.crop || 'full'} angle=${variant.angle || 0} detectorUsed=${enhancedResult?.detectorUsed ? 'yes' : 'no'} fallback=${enhancedResult?.detectorFallbackReason || 'none'} rawTextLength=${String(enhancedResult?.rawText || '').trim().length}`,
            'info',
          );
        }
        enhancedAttempts.push({
          ...parsed,
          rawText: enhancedResult.rawText,
          lines: Array.isArray(enhancedResult.lines) ? enhancedResult.lines : [],
          ocrEngine: enhancedResult.engine,
          angle: variant.angle,
          crop: variant.crop,
          score: scoreLabelOcrAttempt({ ...parsed, rawText: enhancedResult.rawText }, normalizedProfile),
          detectorUsed: Boolean(enhancedResult?.detectorUsed),
          detectorFallbackReason: (focusedFieldCropBox ? 'OCR field text override' : (enhancedResult?.detectorFallbackReason || (fallbackDetectorCropBox ? 'ocr lines fallback' : (variantDetectorCropBox ? 'crop region fallback' : '')))),
          // Same priority as resolveDetectorBoxSource: OCR field crop wins
          // when present, otherwise the detector box, otherwise OCR-line
          // fallback, otherwise the variant crop region.
          detectorCropBox: focusedFieldCropBox
            || enhancedResult?.detectorCropBox
            || fallbackDetectorCropBox
            || variantDetectorCropBox,
          detectorConfidence: enhancedResult?.detectorConfidence ?? null,
          detectorBoxSource,
          detectorSourceImagePath: enhancedResult?.detectorSourceImagePath || imagePath,
          detectorSourceImageSize: enhancedResult?.detectorSourceImageSize || fallbackDetectorSourceImageSize || fallbackImageSize || null,
        });
        bestMerged = mergeOcrAttempts(enhancedAttempts);
        if (shouldStopLabelScan(bestMerged)) {
          if (variant.crop === 'full' && shouldContinueScanForDetectorBox(bestMerged)) {
            emitLog?.('Label OCR: Key fields were found, but no label box was produced yet, so the scan is continuing to look for a tighter label region.', 'info');
            continue;
          }
          if (variant.crop === 'full') {
            if (bestMerged?.detectorCropBox && bestMerged?.detectorUsed) {
              emitLog?.('Label OCR: Full-image pass completed with detector-assisted OCR.', 'info');
            } else if (bestMerged?.detectorCropBox) {
              emitLog?.('Label OCR: Full-image OCR completed with an OCR-derived label box preview.', 'info');
            } else {
              emitLog?.(`Label OCR: Full-image OCR completed without a label box (${bestMerged?.detectorFallbackReason || 'detector box unavailable'}).`, 'info');
            }
          }
          return {
            best: bestMerged,
            failed: enhancedFailed,
            stoppedEarly: true,
          };
        }
      } catch (error) {
        if (debugLabelOcr) {
          emitLog?.(
            `Label OCR Debug: variant=${variant.crop || 'full'} angle=${variant.angle || 0} error=${String(error?.message || error || '').slice(0, 240)}`,
            'warning',
          );
        }
        if (!enhancedFailed) {
          if (isIgnorableEnhancedOcrCropError(error)) {
            lastIgnorableEnhancedCropFailure = `${variant.crop || 'full'} @ ${variant.angle || 0}°`;
            emitLog?.(`Label OCR: Enhanced OCR skipped an incompatible crop path (${variant.crop || 'full'} @ ${variant.angle || 0}°) and is falling back automatically.`, 'info');
          } else {
            emitLog?.(`Label OCR: Enhanced OCR failed (${error.message}).`, 'warning');
          }
          enhancedFailed = true;
        }
        if (isFatalEnhancedOcrError(error)) {
          break;
        }
      }
    }

    return {
      best: bestMerged || mergeOcrAttempts(enhancedAttempts),
      failed: enhancedFailed,
      stoppedEarly: false,
    };
  };
  try {
    try {
      emitLog?.(
        `Label OCR: Using ${getOcrEngineDisplayName(ocrEngine)}.`,
        'info',
      );

      let enhancedFailed = false;
      const initialVariants = await buildRotatedLabelVariants(imagePath, {
        fastOnly: fastMode || ocrEngine === OCR_ENGINE_DEEPSEEK_LOCAL,
        scanStage: 'initial',
      });
      allVariants.push(...initialVariants);
      let { best: bestEnhanced, failed, stoppedEarly } = await evaluateVariants(initialVariants, enhancedFailed);
      enhancedFailed = failed;

      if (stoppedEarly) {
        emitLog?.('Label OCR: Stopped after the fast pass because the key label fields were already found.', 'info');
      }

      if (!bestEnhanced && ocrEngine === OCR_ENGINE_DEEPSEEK_LOCAL) {
        emitLog?.('Label OCR: DeepSeek fast scan needs extra rotation fallback.', 'info');
        const fallbackVariants = await buildRotatedLabelVariants(imagePath, {
          scanStage: 'fallback',
        });
        const seenVariantKeys = new Set(allVariants.map((variant) => `${variant.crop}:${variant.angle}`));
        const dedupedFallbackVariants = fallbackVariants.filter((candidate) => {
          const key = `${candidate.crop}:${candidate.angle}`;
          if (seenVariantKeys.has(key)) {
            return false;
          }
          seenVariantKeys.add(key);
          return true;
        });
        allVariants.push(...dedupedFallbackVariants);
        const secondPass = await evaluateVariants(dedupedFallbackVariants, enhancedFailed);
        bestEnhanced = secondPass.best;
        enhancedFailed = secondPass.failed;
      } else if (!bestEnhanced) {
        const fallbackVariants = await buildRotatedLabelVariants(imagePath, {
          scanStage: 'fallback',
        });
        const seenVariantKeys = new Set(allVariants.map((variant) => `${variant.crop}:${variant.angle}`));
        const dedupedFallbackVariants = fallbackVariants.filter((candidate) => {
          const key = `${candidate.crop}:${candidate.angle}`;
          if (seenVariantKeys.has(key)) {
            return false;
          }
          seenVariantKeys.add(key);
          return true;
        });
        if (dedupedFallbackVariants.length > 0) {
          emitLog?.('Label OCR: Fast pass was incomplete, running the extended scan.', 'info');
          allVariants.push(...dedupedFallbackVariants);
          const secondPass = await evaluateVariants(dedupedFallbackVariants, enhancedFailed);
          bestEnhanced = secondPass.best;
          enhancedFailed = secondPass.failed;
        }
      }

      if (bestEnhanced) {
        if (bestEnhanced.angle) {
          emitLog?.(`Label OCR: Best result came from a ${bestEnhanced.angle}° rotated scan.`, 'info');
          bestEnhanced.displayImagePath = await createDisplayImageVariant(imagePath, bestEnhanced.angle);
        }
        if (bestEnhanced.crop && bestEnhanced.crop !== 'full') {
          emitLog?.(`Label OCR: Focused on the ${bestEnhanced.crop.replace('-', ' ')} for the best label match.`, 'info');
        }
        writeFileOperationCache(
          'label-ocr-results',
          imagePath,
          cacheOptions,
          {
            rawText: bestEnhanced.rawText || '',
            fabricCode: bestEnhanced.fabricCode || '',
            styleNumber: bestEnhanced.styleNumber || '',
            description: bestEnhanced.description || '',
            composition: bestEnhanced.composition || '',
            width: bestEnhanced.width || '',
            cuttable: bestEnhanced.cuttable || '',
            weight: bestEnhanced.weight || '',
            ocrEngine: bestEnhanced.ocrEngine || 'guten-ocr',
            angle: Number(bestEnhanced.angle || 0),
            crop: bestEnhanced.crop || 'full',
            score: Number(bestEnhanced.score || 0),
            detectorUsed: Boolean(bestEnhanced.detectorUsed),
            detectorFallbackReason: bestEnhanced.detectorFallbackReason || (bestEnhanced.detectorCropBox ? 'ocr lines fallback' : ''),
            detectorCropBox: bestEnhanced.detectorCropBox || null,
            detectorConfidence: bestEnhanced.detectorConfidence ?? null,
            detectorBoxSource: bestEnhanced.detectorBoxSource || '',
            detectorSourceImagePath: imagePath,
            detectorSourceImageSize: bestEnhanced.detectorSourceImageSize || null,
          },
          { version: cacheVersion },
        );
        return bestEnhanced;
      }
      emitLog?.('Label OCR: Enhanced OCR did not produce a usable label result.', 'warning');
    } catch (error) {
      if (isIgnorableEnhancedOcrCropError(error)) {
        const detail = lastIgnorableEnhancedCropFailure
          ? ` (${lastIgnorableEnhancedCropFailure})`
          : '';
        emitLog?.(`Label OCR: Enhanced OCR skipped an incompatible crop path${detail} and fell back to the safer label pass.`, 'info');
      } else {
        emitLog?.(`Label OCR: Enhanced OCR failed (${error.message}).`, 'warning');
      }
    }

    const emptyResult = {
      rawText: '',
      fabricCode: '',
      styleNumber: '',
      description: '',
      composition: '',
      width: '',
      cuttable: '',
      weight: '',
      ocrEngine: 'guten-ocr',
      displayImagePath: '',
      angle: 0,
      crop: 'full',
      score: 0,
    };
    return emptyResult;
  } finally {
    allVariants.forEach((variant) => variant.cleanup?.());
  }
}

async function buildSlidesPrecomputedInfo(sourceFolder, settings = {}, emitLog = null, emitProgress = null) {
  const sourceMode = settings.sourceMode || 'document-images';
  const forceRefresh = settings.forceRefresh === true;
  if (!['label-images', 'fabric-images', 'style-images-only'].includes(sourceMode)) {
    return {};
  }

  const organizerInfo = buildPrecomputedInfoFromOrganizerSummary(sourceFolder, sourceMode, emitLog);
  if (organizerInfo) {
    organizerInfo.__meta = {
      ...(organizerInfo.__meta || {}),
      cacheHit: false,
      source: 'organizer-summary',
    };
    return organizerInfo;
  }

  const { cacheKey, value: cachedPayload } = forceRefresh
    ? { cacheKey: '', value: null }
    : readSlidesPrecomputeCache(sourceFolder, settings);
  if (!forceRefresh && cachedPayload?.version === SLIDES_PRECOMPUTE_CACHE_VERSION && cachedPayload?.result && typeof cachedPayload.result === 'object') {
    const cachedResult = {
      ...cachedPayload.result,
      __meta: {
        ...(cachedPayload.result.__meta || {}),
        cacheHit: true,
        source: 'precompute-cache',
      },
    };
    const preparedCount = Object.keys(cachedResult).filter((key) => !key.startsWith('__')).length;
    emitLog?.(
      `Using cached slide preparation data for ${preparedCount} ${sourceMode === 'fabric-images' ? 'fabric items' : 'styles'}.`,
      'info',
    );
    emitProgress?.({ progress: 1 });
    return cachedResult;
  }

  const result = {};
  const styleFolders = listLabelModeStyleEntries(sourceFolder, sourceMode, settings);
  const styleEntries = [];
  const issues = createIssueSummary();

  for (let index = 0; index < styleFolders.length; index += 1) {
    const entry = styleFolders[index];
    const { styleKey, folderPath } = entry;
    const savedInfo = loadSavedStyleInfo(folderPath, styleKey);
    emitLog?.(
      `${sourceMode === 'fabric-images' ? 'Preparing fabric mode data' : sourceMode === 'style-images-only' ? 'Preparing style-only mode data' : 'Preparing label mode data'} for ${styleKey} (${index + 1}/${styleFolders.length})`,
      'info',
    );

    const suffixList = parseSuffixList(settings.imageSuffixes);
    const configuredSuffixes = suffixList.length > 0
      ? suffixList
      : (sourceMode === 'style-images-only' ? ['F', 'B'] : []);
    const orderedStyleImages = sourceMode === 'style-images-only'
      ? configuredSuffixes
        .map((suffix) => findImageByCode(folderPath, styleKey, [suffix], { strictStyle: true }))
        .filter(Boolean)
      : [];
    const frontImagePath = sourceMode === 'label-images'
      ? findImageByCode(folderPath, styleKey, ['F', 'front'])
      : sourceMode === 'style-images-only'
        ? (orderedStyleImages[0] || '')
        : '';
    const backImagePath = sourceMode === 'label-images'
      ? findImageByCode(folderPath, styleKey, ['B', 'back'])
      : sourceMode === 'style-images-only'
        ? (orderedStyleImages[1] || '')
        : '';
    const labelImagePath = sourceMode === 'label-images'
      ? findLabelImage(folderPath, styleKey)
      : sourceMode === 'fabric-images'
        ? pickFabricImage(entry)
        : '';

    let labelInfo = {
      rawText: '',
      fabricCode: '',
      styleNumber: '',
      description: '',
      composition: '',
      width: '',
      cuttable: '',
      weight: '',
    };

    if (sourceMode === 'style-images-only') {
      const styleDocText = loadStyleTextDocument(folderPath, styleKey);
      const parsedDoc = parseStyleTextDocument(styleDocText);
      labelInfo = {
        rawText: styleDocText,
        fabricCode: '',
        styleNumber: styleKey,
        name: parsedDoc.name || '',
        price: parsedDoc.price || '',
        colorRef: parsedDoc.colorRef || '',
        description: parsedDoc.description || '',
        composition: parsedDoc.composition || '',
        width: '',
        cuttable: '',
        weight: '',
      };
    } else if (labelImagePath && fs.existsSync(labelImagePath)) {
      labelInfo = await runLocalLabelOcr(labelImagePath, emitLog, emitProgress, {
        forceRefresh,
        profile: settings.labelOcrProfile,
        ocrEngine: settings.ocrEngine,
        ocrFallbackEngine: settings.ocrFallbackEngine,
        // sourceMode 'fabric-images' → fabric_label (class 0); everything else
        // (label-images, style-images-only) is the legacy "label OCR" pass that
        // also targets the fabric-content label, so default to 0.
        fabricLabelDetectorTargetClass: 0,
      });
    } else if (sourceMode !== 'style-images-only') {
      emitLog?.(
        `${sourceMode === 'fabric-images' ? 'No fabric image detected' : 'No label image detected'} for ${styleKey}.`,
        'warning',
      );
    }

    const displayReadyLabelPath = sourceMode === 'style-images-only'
      ? ''
      : (labelInfo.displayImagePath || labelImagePath || '');
    const fabricImagePath = sourceMode === 'fabric-images' ? displayReadyLabelPath : '';

    // Prefer the flat-lay product image (F suffix) for AI vision analysis,
    // then fall back to the back flat-lay (B), then any model/front shot.
    const flatLayFrontPath = sourceMode === 'style-images-only'
      ? (findImageByCode(folderPath, styleKey, ['F', 'front'], { strictStyle: true }) || '')
      : '';
    const flatLayBackPath = sourceMode === 'style-images-only'
      ? (findImageByCode(folderPath, styleKey, ['B', 'back'], { strictStyle: true }) || '')
      : '';
    const visionPreferredPath = sourceMode === 'style-images-only'
      ? (flatLayFrontPath || flatLayBackPath || orderedStyleImages[0] || frontImagePath || backImagePath || labelImagePath || '')
      : (fabricImagePath || orderedStyleImages[0] || frontImagePath || backImagePath || labelImagePath || '');

    const entryInfo = {
      styleNumber: savedInfo.styleNumber || labelInfo.styleNumber || styleKey,
      name: savedInfo.name || labelInfo.name || '',
      fabricCode: savedInfo.fabricCode || labelInfo.fabricCode || '',
      price: savedInfo.price || labelInfo.price || '',
      colorRef: savedInfo.colorRef || labelInfo.colorRef || '',
      description: savedInfo.description || labelInfo.description || '',
      composition: savedInfo.composition || labelInfo.composition || '',
      width: savedInfo.width || labelInfo.width || '',
      cuttable: savedInfo.cuttable || labelInfo.cuttable || '',
      weight: savedInfo.weight || labelInfo.weight || '',
      labelOcrText: labelInfo.rawText || '',
      labelImagePath: displayReadyLabelPath,
      fabricImagePath,
      galleryImagePaths: orderedStyleImages,
      frontImagePath: frontImagePath || '',
      backImagePath: backImagePath || '',
      visionImagePath: visionPreferredPath,
      resolvedDisplayImages: {
        model: orderedStyleImages[0] || frontImagePath || backImagePath || '',
        front: frontImagePath || orderedStyleImages[0] || '',
        back: backImagePath || orderedStyleImages[1] || '',
        ordered: [...orderedStyleImages],
        grid: [...new Set([orderedStyleImages[0], frontImagePath, backImagePath, ...orderedStyleImages].filter(Boolean))],
        vision: visionPreferredPath,
      },
    };
    result[styleKey] = entryInfo;

    const styleLabel = sourceMode === 'fabric-images'
      ? (entryInfo.fabricCode || entryInfo.styleNumber || styleKey)
      : (entryInfo.styleNumber || styleKey);
    addSlideIssuesForEntry(issues, sourceMode, styleLabel, entryInfo);

    styleEntries.push({
      styleKey,
      folderPath,
      imagePaths: Array.isArray(entry?.imagePaths) ? [...entry.imagePaths] : [],
    });
  }

  result.__styleEntries = styleEntries;
  collectUnusedSourceImages(sourceFolder, styleEntries, result)
    .forEach((fileName) => pushIssueValue(issues, 'skippedFiles', fileName));
  result.__issues = finalizeIssueSummary(issues);
  result.__meta = {
    cacheHit: false,
    source: 'fresh-build',
  };
  writeSlidesPrecomputeCache(cacheKey, result);

  return result;
}

module.exports = {
  buildSlidesPrecomputedInfo,
  collectSlidesSourceEntries,
  parseLabelOcrText,
  runLocalLabelOcr,
};

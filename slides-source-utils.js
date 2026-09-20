const fs = require('fs');
const path = require('path');

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const ORGANIZE_METADATA_DIR = '_organize_meta';

function isImageFile(filePath = '') {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function sortNaturally(left = '', right = '') {
  return String(left).localeCompare(String(right), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function readJsonFile(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function listImages(folderPath) {
  return fs.readdirSync(folderPath)
    .filter((name) => !name.startsWith('.'))
    .map((name) => path.join(folderPath, name))
    .filter((filePath) => fs.statSync(filePath).isFile() && isImageFile(filePath))
    .sort((left, right) => sortNaturally(path.basename(left), path.basename(right)));
}

function listStyleFolders(sourceFolder) {
  return fs.readdirSync(sourceFolder, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== ORGANIZE_METADATA_DIR)
    .map((entry) => ({
      styleKey: entry.name,
      folderPath: path.join(sourceFolder, entry.name),
    }))
    .sort((left, right) => sortNaturally(left.styleKey, right.styleKey));
}

function normalizeSuffixToken(value = '') {
  return String(value || '').trim().replace(/^_+/, '').toLowerCase();
}

function normalizeStyleMatchKey(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

function buildSuffixPattern(suffixes = []) {
  const normalized = [...new Set((Array.isArray(suffixes) ? suffixes : []).map(normalizeSuffixToken).filter(Boolean))];
  if (normalized.length === 0) {
    return /(f|b|front|back)/i;
  }

  return new RegExp(`(${normalized.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'i');
}

function stripStyleSuffix(baseName = '', suffixes = []) {
  const pattern = buildSuffixPattern(suffixes);
  return String(baseName || '')
    .replace(new RegExp(`[-_]${pattern.source}$`, 'i'), '')
    .trim();
}

function getStyleImageTag(baseName = '', suffixes = []) {
  const pattern = buildSuffixPattern(suffixes);
  const match = String(baseName || '').match(new RegExp(`[-_]${pattern.source}$`, 'i'));
  if (!match) {
    return null;
  }

  return {
    styleKey: stripStyleSuffix(baseName, suffixes),
    tag: String(match[1] || '').toLowerCase(),
  };
}

function createIssueSummary() {
  return {
    missingFront: [],
    missingBack: [],
    emptyLabels: [],
    skippedFiles: [],
  };
}

function pushIssueValue(issues, key, value = '') {
  if (!issues || !Object.prototype.hasOwnProperty.call(issues, key)) {
    return;
  }

  const normalized = String(value || '').trim();
  if (normalized) {
    issues[key].push(normalized);
  }
}

function finalizeIssueSummary(issues = {}) {
  const defaults = createIssueSummary();
  return Object.fromEntries(
    Object.keys(defaults).map((key) => [
      key,
      [...new Set((issues?.[key] || []).map((value) => String(value || '').trim()).filter(Boolean))]
        .sort(sortNaturally),
    ]),
  );
}

function hasUsableLabelData(labelInfo = {}) {
  return Boolean(
    String(labelInfo?.rawText || labelInfo?.labelOcrText || '').trim()
    || labelInfo?.fabricCode
    || labelInfo?.styleNumber
    || labelInfo?.composition
    || labelInfo?.width
    || labelInfo?.cuttable
    || labelInfo?.weight
  );
}

function addSlideIssuesForEntry(issues, sourceMode, styleLabel, entryInfo = {}) {
  const normalizedStyle = String(styleLabel || '').trim();
  if (!normalizedStyle) {
    return;
  }

  if (sourceMode === 'label-images' || sourceMode === 'style-images-only') {
    if (!entryInfo.frontImagePath) {
      pushIssueValue(issues, 'missingFront', normalizedStyle);
    }
    if (!entryInfo.backImagePath) {
      pushIssueValue(issues, 'missingBack', normalizedStyle);
    }
  }

  if ((sourceMode === 'label-images' || sourceMode === 'fabric-images') && !hasUsableLabelData(entryInfo)) {
    pushIssueValue(issues, 'emptyLabels', normalizedStyle);
  }
}

function collectUnusedSourceImages(sourceFolder, sourceEntries = [], precomputedInfo = {}) {
  const skippedFiles = new Set();
  const resolvedSource = path.resolve(sourceFolder);
  const topLevelUsed = new Set();

  sourceEntries.forEach((entry) => {
    const entryFolder = path.resolve(entry?.folderPath || sourceFolder);
    if (entryFolder === resolvedSource) {
      (entry?.imagePaths || []).forEach((filePath) => topLevelUsed.add(path.resolve(filePath)));
      return;
    }

    const info = precomputedInfo?.[entry.styleKey];
    const usedImages = new Set(
      [
        info?.frontImagePath,
        info?.backImagePath,
        info?.labelImagePath,
        info?.fabricImagePath,
        ...(Array.isArray(info?.galleryImagePaths) ? info.galleryImagePaths : []),
      ]
        .filter(Boolean)
        .map((filePath) => path.resolve(filePath)),
    );

    listImages(entryFolder).forEach((filePath) => {
      if (!usedImages.has(path.resolve(filePath))) {
        skippedFiles.add(path.basename(filePath));
      }
    });
  });

  listImages(sourceFolder).forEach((filePath) => {
    if (!topLevelUsed.has(path.resolve(filePath))) {
      skippedFiles.add(path.basename(filePath));
    }
  });

  return [...skippedFiles].sort(sortNaturally);
}

function groupTopLevelStyleImages(sourceFolder, sourceMode = 'label-images', settings = {}) {
  const imagePaths = listImages(sourceFolder);
  const groups = new Map();
  const normalizedStyleKeyMap = new Map();
  const pendingLabelCandidates = [];
  const styleSuffixes = sourceMode === 'style-images-only'
    ? (Array.isArray(settings.imageSuffixes) ? settings.imageSuffixes : [])
    : ['f', 'b', 'front', 'back'];

  for (const filePath of imagePaths) {
    const baseName = path.basename(filePath, path.extname(filePath));
    if (sourceMode === 'fabric-images') {
      const styleKey = stripStyleSuffix(baseName, styleSuffixes) || baseName;
      if (!styleKey) {
        continue;
      }

      if (!groups.has(styleKey)) {
        groups.set(styleKey, {
          styleKey,
          folderPath: sourceFolder,
          imagePaths: [],
        });
      }
      groups.get(styleKey).imagePaths.push(filePath);
      continue;
    }

    const tagInfo = getStyleImageTag(baseName, styleSuffixes);
    if (tagInfo?.styleKey) {
      const normalizedKey = normalizeStyleMatchKey(tagInfo.styleKey);
      const canonicalStyleKey = normalizedStyleKeyMap.get(normalizedKey) || tagInfo.styleKey;
      normalizedStyleKeyMap.set(normalizedKey, canonicalStyleKey);
      if (!groups.has(canonicalStyleKey)) {
        groups.set(canonicalStyleKey, {
          styleKey: canonicalStyleKey,
          folderPath: sourceFolder,
          imagePaths: [],
        });
      }
      groups.get(canonicalStyleKey).imagePaths.push(filePath);
      continue;
    }

    if (sourceMode === 'label-images' && baseName) {
      pendingLabelCandidates.push({ styleKey: baseName, filePath });
    }
  }

  if (sourceMode === 'label-images') {
    pendingLabelCandidates.forEach(({ styleKey, filePath }) => {
      if (groups.has(styleKey)) {
        groups.get(styleKey).imagePaths.push(filePath);
      }
    });
  }

  return [...groups.values()].sort((left, right) => sortNaturally(left.styleKey, right.styleKey));
}

function listLabelModeStyleEntries(sourceFolder, sourceMode = 'label-images', settings = {}) {
  const folderEntries = listStyleFolders(sourceFolder);
  const topLevelEntries = groupTopLevelStyleImages(sourceFolder, sourceMode, settings);
  const sourceOrganization = String(settings.sourceOrganization || 'auto');

  if (sourceOrganization === 'style-folders') {
    return folderEntries.length > 0 ? folderEntries : topLevelEntries;
  }

  if (sourceOrganization === 'single-folder') {
    return topLevelEntries;
  }

  const merged = new Map();

  for (const entry of [...folderEntries, ...topLevelEntries]) {
    if (!merged.has(entry.styleKey)) {
      merged.set(entry.styleKey, entry);
    }
  }

  return [...merged.values()].sort((left, right) => sortNaturally(left.styleKey, right.styleKey));
}

function collectSlidesSourceEntries(sourceFolder, sourceMode = 'label-images', settings = {}) {
  if (sourceMode === 'label-images' || sourceMode === 'fabric-images' || sourceMode === 'style-images-only') {
    return listLabelModeStyleEntries(sourceFolder, sourceMode, settings);
  }

  return listStyleFolders(sourceFolder);
}

function resolveOrganizerSummaryPath(sourceFolder) {
  const candidates = [
    path.join(sourceFolder, ORGANIZE_METADATA_DIR, 'organize_summary.json'),
    path.join(sourceFolder, 'organize_summary.json'),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
}

function buildOrganizerStyleKey(item = {}, sourceFolder = '') {
  const labelFile = item?.files?.label || '';
  if (labelFile) {
    return path.basename(labelFile, path.extname(labelFile));
  }

  const folderPath = item?.folder || '';
  if (folderPath && path.resolve(folderPath) !== path.resolve(sourceFolder)) {
    return path.basename(folderPath);
  }

  const base = String(item?.styleNumber || item?.labelInfo?.fabricCode || item?.labelInfo?.styleNumber || 'item').trim();
  const duplicateIndex = Number(item?.duplicateIndex || 0);
  return duplicateIndex > 0 ? `${base}__${duplicateIndex + 1}` : base;
}

function pickFabricImage(entry) {
  const styleKey = entry?.styleKey || '';
  const folderPath = entry?.folderPath || '';
  const directImages = Array.isArray(entry?.imagePaths) && entry.imagePaths.length > 0
    ? [...entry.imagePaths]
    : listImages(folderPath);

  if (!directImages.length) {
    return null;
  }

  const exactMatch = directImages.find((filePath) => {
    const baseName = path.basename(filePath, path.extname(filePath));
    return baseName.toLowerCase() === String(styleKey || '').toLowerCase();
  });
  if (exactMatch) {
    return exactMatch;
  }

  const styleNamed = directImages.find((filePath) => {
    const baseName = path.basename(filePath, path.extname(filePath));
    return baseName.toLowerCase().includes(String(styleKey || '').toLowerCase());
  });
  if (styleNamed) {
    return styleNamed;
  }

  return directImages[0];
}

function hasTagSuffix(baseName = '') {
  return /(?:^|[-_])(f|b|front|back|\d{1,2}|x\d{2})(?:$)/i.test(baseName);
}

function findImageByCode(folderPath, styleKey, codes = [], options = {}) {
  const imagePaths = listImages(folderPath);
  const normalizedStyle = String(styleKey || '').toLowerCase();
  const normalizedStyleKey = normalizeStyleMatchKey(styleKey);
  const strictStyle = Boolean(options.strictStyle);

  for (const code of codes) {
    const matcher = new RegExp(`(?:^|[-_])${code}(?:\\.[^.]+)?$`, 'i');
    const found = imagePaths.find((filePath) => {
      const baseName = path.basename(filePath, path.extname(filePath));
      return matcher.test(baseName)
        && (
          baseName.toLowerCase().includes(normalizedStyle)
          || normalizeStyleMatchKey(baseName).includes(normalizedStyleKey)
        );
    });
    if (found) {
      return found;
    }
  }

  if (strictStyle) {
    return null;
  }

  for (const code of codes) {
    const matcher = new RegExp(`(?:^|[-_])${code}(?:\\.[^.]+)?$`, 'i');
    const found = imagePaths.find((filePath) => matcher.test(path.basename(filePath, path.extname(filePath))));
    if (found) {
      return found;
    }
  }

  return null;
}

function findLabelImage(folderPath, styleKey) {
  const imagePaths = listImages(folderPath);
  const normalizedStyle = String(styleKey || '').toLowerCase();

  const preferred = imagePaths.find((filePath) => {
    const baseName = path.basename(filePath, path.extname(filePath));
    return (
      baseName.toLowerCase().includes(normalizedStyle)
      && !hasTagSuffix(baseName)
      && !/(model|look|detail|flat)/i.test(baseName)
    );
  });
  if (preferred) {
    return preferred;
  }

  const fallback = imagePaths.find((filePath) => {
    const baseName = path.basename(filePath, path.extname(filePath));
    return !hasTagSuffix(baseName);
  });
  return fallback || null;
}

module.exports = {
  ORGANIZE_METADATA_DIR,
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
  sortNaturally,
};

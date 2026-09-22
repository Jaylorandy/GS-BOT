const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const JSZip = require('jszip');
const { runLocalLabelOcr } = require('./slides-preprocessor');
const { normalizeLabelOcrProfile } = require('./label-ocr-profile');
const { getDefaultOcrEngine, getDefaultOcrFallbackEngine } = require('./ocr-engine-config');

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function removeIfExists(targetPath) {
  if (!targetPath || !fs.existsSync(targetPath)) {
    return;
  }
  fs.rmSync(targetPath, { force: true });
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function escapeXml(value = '') {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function ensureRelationshipXml(xml = '') {
  if (xml && /<Relationships\b/.test(xml)) {
    return xml;
  }
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
}

function getNextRelationshipId(xml = '') {
  const ids = [...String(xml || '').matchAll(/\bId="rId(\d+)"/g)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value));
  return `rId${(ids.length ? Math.max(...ids) : 0) + 1}`;
}

function addRelationship(xml = '', relationship = {}) {
  const safeXml = ensureRelationshipXml(xml);
  const nextRelationship = `<Relationship Id="${escapeXml(relationship.id)}" Type="${escapeXml(relationship.type)}" Target="${escapeXml(relationship.target)}"/>`;
  return safeXml.replace('</Relationships>', `${nextRelationship}</Relationships>`);
}

function ensureWorksheetDrawing(sheetXml = '', relationshipId = '') {
  if (!sheetXml || sheetXml.includes('<drawing ')) {
    return sheetXml;
  }

  const drawingNode = `<drawing r:id="${escapeXml(relationshipId)}"/>`;
  const xmlWithRelationshipNamespace = sheetXml.includes('xmlns:r=')
    ? sheetXml
    : sheetXml.replace(
      '<worksheet ',
      '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ',
    );
  return xmlWithRelationshipNamespace.replace('</worksheet>', `${drawingNode}</worksheet>`);
}

function ensureContentType(contentTypesXml = '', extension = '', contentType = '') {
  if (!contentTypesXml || !extension || !contentType) {
    return contentTypesXml;
  }
  const pattern = new RegExp(`<Default\\s+Extension="${extension}"\\s+ContentType="[^"]+"\\s*/>`);
  if (pattern.test(contentTypesXml)) {
    return contentTypesXml;
  }
  return contentTypesXml.replace(
    '</Types>',
    `<Default Extension="${escapeXml(extension)}" ContentType="${escapeXml(contentType)}"/></Types>`,
  );
}

function ensureContentOverride(contentTypesXml = '', partName = '', contentType = '') {
  if (!contentTypesXml || !partName || !contentType || contentTypesXml.includes(`PartName="${partName}"`)) {
    return contentTypesXml;
  }
  return contentTypesXml.replace(
    '</Types>',
    `<Override PartName="${escapeXml(partName)}" ContentType="${escapeXml(contentType)}"/></Types>`,
  );
}

function sortNaturally(left = '', right = '') {
  return String(left).localeCompare(String(right), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function isImageFile(filePath = '') {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function listTopLevelImageFiles(rootPath, ignoredPaths = new Set()) {
  return fs.readdirSync(rootPath, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.'))
    .map((entry) => path.join(rootPath, entry.name))
    .filter((fullPath) => {
      const resolved = path.resolve(fullPath);
      if (ignoredPaths.has(resolved)) {
        return false;
      }
      return fs.statSync(fullPath).isFile() && isImageFile(fullPath);
    });
}

function getCaptureTime(filePath) {
  const stats = fs.statSync(filePath);
  const candidates = [stats.birthtimeMs, stats.ctimeMs, stats.mtimeMs]
    .filter((value) => Number.isFinite(value) && value > 0);
  return candidates[0] || Date.now();
}

function normalizePathSafeText(value = '') {
  return String(value || '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSuffix(value = '') {
  return String(value || '')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/^_+/g, '')
    .replace(/\s+/g, '');
}

function looksLikeFabricIdentifier(value = '') {
  const normalized = normalizePathSafeText(value).toUpperCase();
  if (!normalized || isNoisyCompositionAlias(normalized) || !/\d/.test(normalized)) {
    return false;
  }
  return /^([A-Z]{1,4}\d[A-Z0-9.\-]{5,}|[A-Z]{1,3}-\d{4,}[A-Z0-9.\-]*)$/i.test(normalized);
}

function normalizeOcrAliasToken(value = '') {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
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

function cleanOrganizerComposition(value = '') {
  const normalized = String(value || '')
    .trim()
    .replace(/^(?:C[O0]MPOSITI[O0]N|C[O0]MPOSITI[O0]|C[O0]MPOSIT|C[O0]NTENT|C[O0]NT|C[O0]MP|[O0]NTENT|NTENT|TENT|ENT|SPEC)C?\s*[:：-]?\s*/i, '')
    .replace(/(\d)\s*%\s*([A-Za-z]+)/g, '$1%$2')
    .replace(/([A-Za-z])\s*[:：]\s*(\d)/g, '$1: $2')
    .replace(/%\s*([A-Za-z])/g, '% $1')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!normalized || isNoisyCompositionAlias(normalized)) {
    return '';
  }
  return normalized;
}

function cleanOrganizerFabricCode(value = '') {
  const normalized = normalizePathSafeText(value).toUpperCase();
  if (!normalized || isNoisyCompositionAlias(normalized) || /\b(COMPOSITION|CONTENT)\b/i.test(normalized)) {
    return '';
  }
  return normalized;
}

function normalizeOrganizerLabelInfo(labelInfo = {}, config = {}) {
  const nextLabelInfo = {
    ...labelInfo,
    fabricCode: cleanOrganizerFabricCode(labelInfo.fabricCode || ''),
    styleNumber: normalizePathSafeText(labelInfo.styleNumber || ''),
    composition: cleanOrganizerComposition(labelInfo.composition || ''),
  };

  if (normalizeLabelNamingTarget(config) === 'fabric' && !nextLabelInfo.fabricCode && looksLikeFabricIdentifier(nextLabelInfo.styleNumber)) {
    nextLabelInfo.fabricCode = nextLabelInfo.styleNumber;
  }

  return nextLabelInfo;
}

function buildFileName(baseName = '', suffix = '', ext = '') {
  const safeBase = normalizePathSafeText(baseName) || 'Unnamed';
  const safeSuffix = normalizeSuffix(suffix);
  return safeSuffix ? `${safeBase}_${safeSuffix}${ext}` : `${safeBase}${ext}`;
}

function resolveOutputBaseName(group = {}, outputMode = 'style-folders') {
  if (outputMode === 'single-folder' && group?.folderName) {
    return group.folderName;
  }
  return group?.baseName || group?.folderName || 'Unnamed';
}

function makeNonOverwritingTargetPath(sourcePath = '', targetPath = '') {
  if (!targetPath) {
    return targetPath;
  }

  const resolvedSource = sourcePath ? path.resolve(sourcePath) : '';
  if (!fs.existsSync(targetPath) || (resolvedSource && path.resolve(targetPath) === resolvedSource)) {
    return targetPath;
  }

  const parsed = path.parse(targetPath);
  for (let counter = 2; counter < 10000; counter += 1) {
    const candidate = path.join(parsed.dir, `${parsed.name}__${counter}${parsed.ext}`);
    if (!fs.existsSync(candidate) || (resolvedSource && path.resolve(candidate) === resolvedSource)) {
      return candidate;
    }
  }

  throw new Error(`Could not create a unique output filename for ${targetPath}`);
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

function countLabelKeywords(rawText = '', profile = {}) {
  const normalized = String(rawText || '').toUpperCase();
  const aliases = Object.values(normalizeLabelOcrProfile(profile).fields || {})
    .flat()
    .map((keyword) => String(keyword || '').toUpperCase())
    .filter(Boolean);

  return [...new Set(aliases)]
    .filter((keyword) => normalized.includes(keyword))
    .length;
}

function looksLikeLabelImage(labelInfo = {}, profile = {}) {
  const keywordCount = countLabelKeywords(labelInfo.rawText, profile);
  const hasPrimaryValue = Boolean(labelInfo.styleNumber || labelInfo.fabricCode);
  return Boolean(
    (hasPrimaryValue && (keywordCount > 0 || labelInfo.fabricCode || labelInfo.composition || labelInfo.width || labelInfo.weight))
    || keywordCount >= 2,
  );
}

function createBaseItem(filePath, index = -1) {
  return {
    filePath,
    fileName: path.basename(filePath),
    ext: path.extname(filePath),
    captureTime: getCaptureTime(filePath),
    sequenceIndex: index,
    labelInfo: {
      rawText: '',
      fabricCode: '',
      styleNumber: '',
      composition: '',
      width: '',
      cuttable: '',
      weight: '',
    },
    kind: 'image',
  };
}

function normalizeNamingMode(config = {}) {
  return config.namingMode === 'number' ? 'number' : 'label';
}

function normalizeLabelNamingTarget(config = {}) {
  if (config.labelNamingTarget === 'fabric' || config.organizeNameField === 'fabricCode') {
    return 'fabric';
  }
  return 'style';
}

function normalizeStyleNameField(config = {}) {
  const value = String(config.styleNameField || config.organizeStyleNameField || 'styleNumber').trim();
  return [
    'fabricCode',
    'styleNumber',
    'description',
    'composition',
    'width',
    'cuttable',
    'weight',
  ].includes(value) ? value : 'styleNumber';
}

function formatFallbackStyleName(index = 1) {
  return `style number_${String(Math.max(1, Number(index) || 1)).padStart(2, '0')}`;
}

function formatPendingReviewName(index = 1) {
  return `review pending_${String(Math.max(1, Number(index) || 1)).padStart(2, '0')}`;
}

function getGroupSize(config = {}) {
  return Math.max(1, Number(config.groupSize ?? config.organizeGroupSize) || 1);
}

function getLabelIndex(config = {}) {
  const groupSize = getGroupSize(config);
  return Math.min(groupSize, Math.max(1, Number(config.labelIndex ?? config.organizeLabelIndex) || groupSize));
}

function getNumberStart(config = {}) {
  return Math.max(1, Number(config.numberStart) || 1);
}

function getExpectedSuffixCount(config = {}) {
  const namingMode = normalizeNamingMode(config);
  if (namingMode === 'number') {
    return getGroupSize(config);
  }
  if (normalizeLabelNamingTarget(config) === 'style') {
    return Math.max(0, getGroupSize(config) - 1);
  }
  return 0;
}

const DEFAULT_IMAGE_SUFFIXES = ['F', 'B', 'S', 'D'];

function parseSuffixList(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || '').trim()).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    return value.split(/[,，;；\s]+/).map((entry) => entry.trim()).filter(Boolean);
  }
  return [];
}

function getImageSuffixes(config = {}) {
  const count = getExpectedSuffixCount(config);
  if (count <= 0) {
    return [];
  }
  const list = parseSuffixList(config.imageSuffixes);
  // The label image itself keeps no suffix; the remaining images default to
  // F, B, S (D) when the user left the suffix field empty, and a partially
  // filled list is topped up from the same defaults so two files in a group
  // can never collapse onto the same name.
  return Array.from({ length: count }, (_unused, index) => (
    normalizeSuffix(list[index] || DEFAULT_IMAGE_SUFFIXES[index] || '')
  ));
}

function getLabelSuffix(config = {}) {
  return normalizeSuffix(config.labelSuffix || '');
}

function resolvePrimaryName(labelInfo = {}, config = {}, options = {}) {
  const labelNamingTarget = normalizeLabelNamingTarget(config);
  const styleNameField = normalizeStyleNameField(config);
  const rawValue = labelNamingTarget === 'fabric'
    ? (labelInfo.fabricCode || labelInfo.styleNumber || '')
    : (labelInfo[styleNameField] || (styleNameField === 'styleNumber' ? labelInfo.fabricCode : ''));
  const normalizedValue = normalizePathSafeText(rawValue);
  if (labelNamingTarget === 'style' && styleNameField === 'description' && !normalizedValue) {
    return {
      keyField: 'description',
      value: formatFallbackStyleName(options.fallbackIndex),
      usedFallback: true,
      fallbackFrom: 'description',
    };
  }

  // Style naming requested but the style number could not be read — the name
  // comes from the fabric code instead. Never silent: the caller flags the
  // group for review so a fabric-code name is never mistaken for a style name.
  const fellBackToFabricCode = labelNamingTarget === 'style'
    && styleNameField === 'styleNumber'
    && !normalizePathSafeText(labelInfo.styleNumber || '')
    && Boolean(normalizedValue);

  return {
    keyField: labelNamingTarget === 'fabric' ? 'fabricCode' : styleNameField,
    value: normalizedValue,
    usedFallback: fellBackToFabricCode,
    fallbackFrom: fellBackToFabricCode ? 'fabricCode' : '',
  };
}

async function analyzeLabelItem(item, emitLog, emitProgress, progressResolver, profile = {}, ocrOptions = {}) {
  let labelInfo = item.labelInfo;
  const sourcePreview = {
    preview: {
      stage: 'label-source',
      imagePath: item.filePath,
      crop: 'full',
      angle: 0,
      detectorUsed: false,
      detectorFallbackReason: '',
      detectorCropBox: null,
      detectorConfidence: null,
      detectorSourceImageSize: null,
    },
  };
  if (typeof progressResolver === 'function') {
    progressResolver(sourcePreview);
  } else if (typeof emitProgress === 'function') {
    emitProgress(sourcePreview);
  }
  try {
    labelInfo = await runLocalLabelOcr(
      item.filePath,
      (message, type = 'info') => emitLog(message, type),
      (stageMeta) => {
        if (typeof progressResolver === 'function') {
          progressResolver(stageMeta);
        } else {
          if (stageMeta && typeof stageMeta === 'object') {
            emitProgress(stageMeta);
          } else {
            emitProgress(typeof stageMeta?.progress === 'number' ? stageMeta.progress : 0);
          }
        }
      },
      {
        profile,
        ocrEngine: ocrOptions.ocrEngine,
        ocrFallbackEngine: ocrOptions.ocrFallbackEngine,
        forceRefresh: ocrOptions.forceRefresh === true,
        useFabricLabelDetector: true,
        fabricLabelDetectorTargetClass: Number.isFinite(ocrOptions.fabricLabelDetectorTargetClass)
          ? Number(ocrOptions.fabricLabelDetectorTargetClass)
          : 0,
      },
    );
  } catch (error) {
    emitLog(`OCR skipped for ${item.fileName}: ${error.message}`, 'warning');
  }

  labelInfo = normalizeOrganizerLabelInfo(labelInfo, ocrOptions?.organizerConfig || {});

  return {
    ...item,
    labelInfo,
    kind: looksLikeLabelImage(labelInfo, profile) ? 'label' : 'image',
  };
}

function copyOrMoveFile(sourcePath, targetPath, action = 'copy') {
  ensureDir(path.dirname(targetPath));
  const safeTargetPath = makeNonOverwritingTargetPath(sourcePath, targetPath);
  if (path.resolve(sourcePath) === path.resolve(safeTargetPath)) {
    return safeTargetPath;
  }
  if (action === 'move') {
    fs.renameSync(sourcePath, safeTargetPath);
    return safeTargetPath;
  }
  fs.copyFileSync(sourcePath, safeTargetPath);
  return safeTargetPath;
}

function copyOrMovePreparedFile(sourcePath, preparedPath, targetPath, action = 'copy') {
  const resolvedPrepared = preparedPath && fs.existsSync(preparedPath) ? path.resolve(preparedPath) : '';
  if (!resolvedPrepared || resolvedPrepared === path.resolve(sourcePath)) {
    return copyOrMoveFile(sourcePath, targetPath, action);
  }

  ensureDir(path.dirname(targetPath));
  const safeTargetPath = makeNonOverwritingTargetPath(sourcePath, targetPath);
  fs.copyFileSync(resolvedPrepared, safeTargetPath);
  if (action === 'move' && fs.existsSync(sourcePath) && path.resolve(sourcePath) !== path.resolve(targetPath)) {
    fs.unlinkSync(sourcePath);
  }
  return safeTargetPath;
}

function preserveUnmatchedImages(unmatchedImages = [], outputFolder = '', outputMode = 'single-folder', operation = 'copy', emitLog = () => {}) {
  const targetDir = outputMode === 'single-folder'
    ? outputFolder
    : path.join(outputFolder, '_unmatched');
  const preservedFiles = [];
  const seen = new Set();

  unmatchedImages.forEach((sourcePath) => {
    const resolvedSource = path.resolve(String(sourcePath || ''));
    if (!resolvedSource || seen.has(resolvedSource) || !fs.existsSync(resolvedSource) || !isImageFile(resolvedSource)) {
      return;
    }
    seen.add(resolvedSource);

    try {
      const targetPath = path.join(targetDir, path.basename(resolvedSource));
      const writtenPath = copyOrMoveFile(resolvedSource, targetPath, operation);
      preservedFiles.push(writtenPath);
    } catch (error) {
      emitLog(`Could not preserve unmatched image ${path.basename(resolvedSource)}: ${error.message}`, 'warning');
    }
  });

  return preservedFiles;
}

function makeUniqueFolderName(baseName = '', seen = new Map()) {
  const safeBase = normalizePathSafeText(baseName) || 'Unnamed';
  const current = seen.get(safeBase) || 0;
  seen.set(safeBase, current + 1);

  return {
    folderName: current === 0 ? safeBase : `${safeBase}__${current + 1}`,
    duplicateIndex: current === 0 ? 0 : current + 1,
  };
}

function buildInfoFiles(entries = [], outputs = []) {
  return outputs.reduce((acc, filePath, index) => {
    const entry = entries[index];
    acc[entry.isLabel ? 'label' : `image${index + 1}`] = filePath;
    return acc;
  }, {});
}

function buildGalleryImagePaths(entries = [], outputs = []) {
  return outputs.reduce((acc, filePath, index) => {
    const entry = entries[index];
    if (!entry?.isLabel && filePath) {
      acc.push(filePath);
    }
    return acc;
  }, []);
}

function buildInfoSourceFiles(entries = []) {
  return entries.reduce((acc, entry, index) => {
    acc[entry.isLabel ? 'label' : `image${index + 1}`] = entry.item.filePath;
    return acc;
  }, {});
}

function buildOrganizerIssues(groups = [], failedGroups = [], unmatchedImages = [], config = {}) {
  const issues = createIssueSummary();
  const namingMode = normalizeNamingMode(config);

  groups.forEach((group) => {
    if (namingMode === 'label' && !String(group.labelInfo?.rawText || '').trim()) {
      pushIssueValue(issues, 'emptyLabels', group.baseName);
    }
  });

  failedGroups.forEach((item) => {
    pushIssueValue(issues, 'emptyLabels', item.groupName || path.basename(String(item.source || '')));
  });
  unmatchedImages.forEach((filePath) => {
    pushIssueValue(issues, 'skippedFiles', path.basename(filePath));
  });

  return finalizeIssueSummary(issues);
}

function buildNumberGroups(items = [], config = {}, emitLog = () => {}) {
  const groupSize = getGroupSize(config);
  const suffixes = getImageSuffixes(config);
  const numberStart = getNumberStart(config);
  const groups = [];
  const unmatchedImages = [];

  for (let start = 0; start < items.length; start += groupSize) {
    const groupItems = items.slice(start, start + groupSize);
    if (groupItems.length < groupSize) {
      unmatchedImages.push(...groupItems.map((item) => item.filePath));
      continue;
    }

    const baseName = String(numberStart + groups.length);
    groups.push({
      baseName,
      folderName: baseName,
      duplicateIndex: 0,
      namingField: 'number',
      labelInfo: {},
      entries: groupItems.map((item, index) => ({
        item,
        suffix: suffixes[index] || '',
        isLabel: false,
      })),
    });
  }

  emitLog(`Grouped ${groups.length} numeric sets.`, 'info');
  return { groups, failedGroups: [], unmatchedImages };
}

function buildStyleLabelGroups(items = [], config = {}, emitLog = () => {}) {
  const groupSize = getGroupSize(config);
  const labelIndex = getLabelIndex(config);
  const imageSuffixes = getImageSuffixes(config);
  const labelSuffix = getLabelSuffix(config);
  const groups = [];
  const failedGroups = [];
  const unmatchedImages = [];
  const seen = new Map();

  for (let start = 0; start < items.length; start += groupSize) {
    const groupItems = items.slice(start, start + groupSize);
    if (groupItems.length < groupSize) {
      unmatchedImages.push(...groupItems.map((item) => item.filePath));
      continue;
    }

    const labelItem = groupItems[labelIndex - 1];
    const primaryName = resolvePrimaryName(labelItem.labelInfo, config, {
      fallbackIndex: groups.length + failedGroups.length + 1,
    });
    let resolvedName = primaryName.value;
    let needsReview = false;
    let reviewFailureReason = '';
    if (primaryName.usedFallback && primaryName.fallbackFrom === 'fabricCode') {
      needsReview = true;
      reviewFailureReason = 'Style number could not be read; named by fabric code instead.';
      emitLog(`⚠️ Group ${Math.floor(start / groupSize) + 1}: style number not found, named by fabric code ${resolvedName}.`, 'warning');
    }
    if (!resolvedName) {
      needsReview = true;
      reviewFailureReason = `Group ${Math.floor(start / groupSize) + 1} did not produce a usable ${primaryName.keyField}.`;
      failedGroups.push({
        source: labelItem.filePath,
        groupName: '',
        reason: reviewFailureReason,
        labelInfo: labelItem.labelInfo,
      });
      resolvedName = formatPendingReviewName(groups.length + failedGroups.length);
    }

    const folderMeta = makeUniqueFolderName(resolvedName, seen);
    let runningImageIndex = 0;
    const entries = groupItems.map((item, index) => {
      if (index === (labelIndex - 1)) {
        return { item, suffix: labelSuffix, isLabel: true };
      }
      const entry = { item, suffix: imageSuffixes[runningImageIndex] || '', isLabel: false };
      runningImageIndex += 1;
      return entry;
    });

    groups.push({
      baseName: resolvedName,
      folderName: folderMeta.folderName,
      duplicateIndex: folderMeta.duplicateIndex,
      namingField: primaryName.keyField,
      labelInfo: labelItem.labelInfo,
      needsReview,
      reviewFailureReason,
      entries,
    });
  }

  emitLog(`Grouped ${groups.length} style sets.`, 'info');
  return { groups, failedGroups, unmatchedImages };
}

function buildStyleLabelGroupsByDetectedLabels(items = [], config = {}, emitLog = () => {}) {
  const imageSuffixes = getImageSuffixes(config);
  const labelSuffix = getLabelSuffix(config);
  const groups = [];
  const failedGroups = [];
  const unmatchedImages = [];
  const seen = new Map();
  const labelIndexes = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item?.kind === 'label');

  if (labelIndexes.length === 0) {
    emitLog('No label images were detected for style grouping.', 'warning');
    return {
      groups: [],
      failedGroups: [],
      unmatchedImages: items.map((item) => item.filePath),
    };
  }

  const usedIndexes = new Set();
  labelIndexes.forEach(({ item: labelItem, index: labelItemIndex }, labelCursor) => {
    const primaryName = resolvePrimaryName(labelItem.labelInfo, config, {
      fallbackIndex: groups.length + failedGroups.length + 1,
    });
    if (!primaryName.value) {
      failedGroups.push({
        source: labelItem.filePath,
        groupName: '',
        reason: 'Detected label image did not produce a usable style number.',
      });
      return;
    }
    if (primaryName.usedFallback && primaryName.fallbackFrom === 'fabricCode') {
      emitLog(`⚠️ Detected label ${labelItem.fileName}: style number not found, named by fabric code ${primaryName.value}.`, 'warning');
    }

    const nextLabelIndex = labelIndexes[labelCursor + 1]?.index ?? items.length;
    const candidateImageIndexes = [];
    for (let pointer = labelItemIndex - 1; pointer >= 0 && candidateImageIndexes.length < imageSuffixes.length; pointer -= 1) {
      if (usedIndexes.has(pointer)) {
        continue;
      }
      const candidate = items[pointer];
      if (candidate?.kind === 'label') {
        break;
      }
      candidateImageIndexes.unshift(pointer);
    }
    for (let pointer = labelItemIndex + 1; pointer < nextLabelIndex && candidateImageIndexes.length < imageSuffixes.length; pointer += 1) {
      if (usedIndexes.has(pointer)) {
        continue;
      }
      const candidate = items[pointer];
      if (candidate?.kind === 'label') {
        break;
      }
      candidateImageIndexes.push(pointer);
    }

    const folderMeta = makeUniqueFolderName(primaryName.value, seen);
    const entries = candidateImageIndexes.slice(0, imageSuffixes.length).map((itemIndex, suffixIndex) => {
      usedIndexes.add(itemIndex);
      return {
        item: items[itemIndex],
        suffix: imageSuffixes[suffixIndex] || '',
        isLabel: false,
      };
    });
    usedIndexes.add(labelItemIndex);
    entries.push({ item: labelItem, suffix: labelSuffix, isLabel: true });

    groups.push({
      baseName: primaryName.value,
      folderName: folderMeta.folderName,
      duplicateIndex: folderMeta.duplicateIndex,
      namingField: primaryName.keyField,
      labelInfo: labelItem.labelInfo,
      entries,
    });
  });

  items.forEach((item, index) => {
    if (!usedIndexes.has(index)) {
      unmatchedImages.push(item.filePath);
    }
  });

  emitLog(`Grouped ${groups.length} style sets from detected labels.`, 'info');
  return { groups, failedGroups, unmatchedImages };
}

async function analyzeStyleLabelItems(items = [], config = {}, profile = {}, ocrOptions = {}, emitLog = () => {}, emitProgress = () => {}, ensureActive = () => {}) {
  const groupSize = getGroupSize(config);
  const labelIndex = getLabelIndex(config);
  const analyzedItems = items.map((item) => ({ ...item }));
  const labelJobs = [];

  for (let start = 0; start < analyzedItems.length; start += groupSize) {
    const labelPosition = start + labelIndex - 1;
    if (labelPosition >= analyzedItems.length) {
      break;
    }
    labelJobs.push({
      groupNumber: Math.floor(start / groupSize) + 1,
      index: labelPosition,
      item: analyzedItems[labelPosition],
    });
  }

  if (labelJobs.length === 0) {
    return analyzedItems;
  }

  const concurrency = Math.max(1, Math.min(2, Number(config.labelOcrConcurrency || config.ocrConcurrency || 2) || 2));
  let nextJobIndex = 0;
  let completedCount = 0;

  const runWorker = async (workerIndex) => {
    const previewSlot = Math.min(workerIndex, concurrency - 1);
    while (nextJobIndex < labelJobs.length) {
      ensureActive();
      const jobCursor = nextJobIndex;
      nextJobIndex += 1;
      const job = labelJobs[jobCursor];
      emitProgress(Math.max(5, Math.round((completedCount / labelJobs.length) * 45)));
      emitLog(`Analyzing label ${job.item.fileName} for group ${job.groupNumber}`, 'info');
      analyzedItems[job.index] = await analyzeLabelItem(
        job.item,
        emitLog,
        emitProgress,
        (stageMeta) => {
          const nested = typeof stageMeta?.progress === 'number' ? stageMeta.progress : 0;
          const enrichedStageMeta = stageMeta && typeof stageMeta === 'object'
            ? {
                ...stageMeta,
                preview: stageMeta.preview
                  ? { ...stageMeta.preview, previewSlot }
                  : stageMeta.preview,
              }
            : stageMeta;
          emitProgress({
            ...(enrichedStageMeta && typeof enrichedStageMeta === 'object' ? enrichedStageMeta : {}),
            progress: Math.max(5, Math.round(((completedCount + Math.min(1, Math.max(0, nested / 100))) / labelJobs.length) * 45)),
          });
        },
        profile,
        // Style mode → class 1 (style_label) for the YOLO detector.
        { ...(ocrOptions || {}), fabricLabelDetectorTargetClass: 1 },
      );
      completedCount += 1;
      emitProgress(Math.max(5, Math.round((completedCount / labelJobs.length) * 45)));
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, labelJobs.length) }, (_unused, workerIndex) => runWorker(workerIndex)));
  return analyzedItems;
}

async function buildFabricLabelGroups(items = [], config = {}, profile = {}, ocrOptions = {}, emitLog = () => {}, emitProgress = () => {}, ensureActive = () => {}) {
  const analyzedItems = new Array(items.length);
  const groups = [];
  const failedGroups = [];
  const seen = new Map();
  const concurrency = Math.max(1, Math.min(2, Number(config.labelOcrConcurrency || config.ocrConcurrency || 2) || 2));
  let nextIndex = 0;
  let completedCount = 0;

  const runWorker = async (workerIndex) => {
    const previewSlot = Math.min(workerIndex, concurrency - 1);
    while (nextIndex < items.length) {
      ensureActive();
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      emitProgress(Math.max(5, Math.round(((completedCount + 1) / items.length) * 45)));
      emitLog(`Analyzing ${item.fileName} (${index + 1}/${items.length})`, 'info');
      analyzedItems[index] = await analyzeLabelItem(
        item,
        emitLog,
        emitProgress,
        (stageMeta) => {
          const nested = typeof stageMeta?.progress === 'number' ? stageMeta.progress : 0;
          const enrichedStageMeta = stageMeta && typeof stageMeta === 'object'
            ? {
                ...stageMeta,
                preview: stageMeta.preview
                  ? { ...stageMeta.preview, previewSlot }
                  : stageMeta.preview,
              }
            : stageMeta;
          emitProgress({
            ...(enrichedStageMeta && typeof enrichedStageMeta === 'object' ? enrichedStageMeta : {}),
            progress: Math.max(5, Math.round(((completedCount + Math.min(1, Math.max(0, nested / 100))) / items.length) * 45)),
          });
        },
        profile,
        // Fabric mode → class 0 (fabric_label) for the YOLO detector.
        { ...(ocrOptions || {}), fabricLabelDetectorTargetClass: 0 },
      );
      completedCount += 1;
      emitProgress(Math.max(5, Math.round((completedCount / items.length) * 45)));
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, (_unused, workerIndex) => runWorker(workerIndex)));

  analyzedItems.forEach((item) => {
    if (item.kind !== 'label') {
      return;
    }
    const normalizedLabelInfo = normalizeOrganizerLabelInfo(item.labelInfo, { ...config, labelNamingTarget: 'fabric' });
    const primaryName = resolvePrimaryName(normalizedLabelInfo, { ...config, labelNamingTarget: 'fabric' });
    if (!primaryName.value) {
      failedGroups.push({
        source: item.filePath,
        groupName: '',
        reason: 'Label image did not produce a usable fabric code.',
      });
      return;
    }
    const folderMeta = makeUniqueFolderName(primaryName.value, seen);
    groups.push({
      baseName: primaryName.value,
      folderName: folderMeta.folderName,
      duplicateIndex: folderMeta.duplicateIndex,
      namingField: primaryName.keyField,
      labelInfo: normalizedLabelInfo,
      entries: [{ item: { ...item, labelInfo: normalizedLabelInfo }, suffix: '', isLabel: true }],
    });
  });

  const usedPaths = new Set(groups.flatMap((group) => group.entries.map((entry) => entry.item.filePath)));
  const unmatchedImages = analyzedItems
    .filter((item) => !usedPaths.has(item.filePath))
    .map((item) => item.filePath);

  return { groups, failedGroups, unmatchedImages };
}

async function organizeStyleImages(payload, emitLog = () => {}, emitProgress = () => {}, options = {}) {
  const sourceFolder = payload?.sourceFolder;
  const config = payload?.config || {};
  const ensureActive = options.ensureActive || (() => {});

  if (!sourceFolder || !fs.existsSync(sourceFolder)) {
    throw new Error('Source folder was not found.');
  }

  const namingMode = normalizeNamingMode(config);
  const labelNamingTarget = normalizeLabelNamingTarget(config);
  const outputFolder = payload?.outputFolder || sourceFolder;
  const outputMode = namingMode === 'label' && labelNamingTarget === 'fabric'
    ? 'single-folder'
    : (config.organizeOutputMode === 'single-folder' ? 'single-folder' : 'style-folders');
  const operation = config.organizeAction === 'move' ? 'move' : 'copy';
  const labelOcrProfile = normalizeLabelOcrProfile(config.labelOcrProfile);
  const ocrOptions = {
    ocrEngine: config.ocrEngine || getDefaultOcrEngine(),
    ocrFallbackEngine: config.ocrFallbackEngine ?? getDefaultOcrFallbackEngine(),
    forceRefresh: config.forceRefresh === true,
    organizerConfig: config,
  };
  const metadataDir = path.join(outputFolder, '_organize_meta');
  const resolvedSource = path.resolve(sourceFolder);
  const resolvedOutput = path.resolve(outputFolder);
  const ignoredPaths = resolvedOutput !== resolvedSource ? new Set([resolvedOutput]) : new Set();
  ignoredPaths.add(path.resolve(metadataDir));
  const imageFiles = listTopLevelImageFiles(sourceFolder, ignoredPaths)
    .sort((left, right) => sortNaturally(path.basename(left), path.basename(right)));

  if (imageFiles.length === 0) {
    throw new Error('No supported images were found in the source folder.');
  }

  ensureDir(outputFolder);
  ensureDir(metadataDir);
  fs.readdirSync(metadataDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .forEach((entry) => {
      if (
        /_organize_info\.json$/i.test(entry.name)
        || /^(failed_styles|unmatched_images)\.json$/i.test(entry.name)
      ) {
        removeIfExists(path.join(metadataDir, entry.name));
      }
    });
  emitLog(`Found ${imageFiles.length} raw images.`, 'info');

  // Auto-import scraped metadata from *_info.json in the source folder.
  // The scraper writes one {styleNumber}_info.json per style folder; when the
  // user points the organizer at a single-style scraper output folder this
  // provides pre-filled description / composition so OCR doesn't have to guess.
  let scrapedInfo = null;
  try {
    const infoFile = fs.readdirSync(sourceFolder)
      .find((name) => /[^.]+_info\.json$/i.test(name) && !/organize_info/i.test(name));
    if (infoFile) {
      const parsed = JSON.parse(fs.readFileSync(path.join(sourceFolder, infoFile), 'utf8') || '{}');
      if (parsed && typeof parsed === 'object') {
        scrapedInfo = {
          description: String(parsed.description || '').trim(),
          composition: (() => {
            const comp = parsed.composition;
            if (!comp) return '';
            if (typeof comp === 'string') return comp.trim();
            // Composition may be {outerShell, lining, other} object
            return [comp.outerShell, comp.lining, comp.other]
              .filter(Boolean).join('\n').trim();
          })(),
          name: String(parsed.name || '').trim(),
          price: String(parsed.price || '').trim(),
        };
        if (scrapedInfo.description || scrapedInfo.composition) {
          emitLog(`📎 Auto-imported metadata from ${infoFile}`, 'info');
        } else {
          scrapedInfo = null;
        }
      }
    }
  } catch { /* non-fatal */ }

  const items = imageFiles.map((filePath, index) => createBaseItem(filePath, index));
  let groups = [];
  let failedGroups = [];
  let unmatchedImages = [];

  if (namingMode === 'number') {
    ({ groups, failedGroups, unmatchedImages } = buildNumberGroups(items, config, emitLog));
  } else if (labelNamingTarget === 'fabric') {
    ({ groups, failedGroups, unmatchedImages } = await buildFabricLabelGroups(
      items,
      config,
      labelOcrProfile,
      ocrOptions,
      emitLog,
      emitProgress,
      ensureActive,
    ));
  } else {
    const analyzedItems = await analyzeStyleLabelItems(
      items,
      config,
      labelOcrProfile,
      ocrOptions,
      emitLog,
      emitProgress,
      ensureActive,
    );

    ({ groups, failedGroups, unmatchedImages } = buildStyleLabelGroups(analyzedItems, config, emitLog));
  }

  emitLog(`Matched ${groups.length} groups. Writing files into the target folder...`, 'info');
  if (namingMode === 'label' && labelNamingTarget === 'fabric' && config.organizeOutputMode !== 'single-folder') {
    emitLog('Fabric naming now writes renamed files directly into the selected output folder for easier review.', 'info');
  }

  const manifest = [];
  for (let index = 0; index < groups.length; index += 1) {
    ensureActive();
    const group = groups[index];
    const targetFolder = outputMode === 'single-folder' ? outputFolder : path.join(outputFolder, group.folderName);
    ensureDir(targetFolder);

    const writtenFiles = [];
    group.entries.forEach((entry) => {
      const fileName = buildFileName(resolveOutputBaseName(group, outputMode), entry.suffix, entry.item.ext || '.jpg');
      const targetPath = path.join(targetFolder, fileName);
      let writtenPath = targetPath;
      if (entry.isLabel) {
        writtenPath = copyOrMovePreparedFile(entry.item.filePath, entry.item.labelInfo?.displayImagePath, targetPath, operation);
      } else {
        writtenPath = copyOrMoveFile(entry.item.filePath, targetPath, operation);
      }
      writtenFiles.push(writtenPath);
    });

    const info = {
      styleNumber: group.baseName,
      folderName: group.folderName,
      folder: targetFolder,
      duplicateIndex: group.duplicateIndex,
      files: buildInfoFiles(group.entries, writtenFiles),
      galleryImagePaths: buildGalleryImagePaths(group.entries, writtenFiles),
      namingField: group.namingField,
      labelInfo: (() => {
        const li = { ...(group.labelInfo || {}) };
        // Fill description / composition from _info.json when OCR left them empty.
        if (scrapedInfo) {
          if (!li.description && scrapedInfo.description) li.description = scrapedInfo.description;
          if (!li.composition && scrapedInfo.composition) li.composition = scrapedInfo.composition;
        }
        return li;
      })(),
      needsReview: group.needsReview === true,
      reviewFailureReason: group.reviewFailureReason || '',
      sourceFiles: buildInfoSourceFiles(group.entries),
    };

    const infoPath = path.join(metadataDir, `${group.folderName}_organize_info.json`);
    writeJson(infoPath, info);
    manifest.push({
      ...info,
      infoPath,
    });
    emitProgress(50 + Math.round(((index + 1) / Math.max(groups.length, 1)) * 50));
  }

  const preservedUnmatchedFiles = preserveUnmatchedImages(unmatchedImages, outputFolder, outputMode, operation, emitLog);
  if (preservedUnmatchedFiles.length > 0) {
    emitLog(`Preserved ${preservedUnmatchedFiles.length} unmatched images in the output folder.`, 'warning');
  }

  const issues = buildOrganizerIssues(groups, failedGroups, unmatchedImages, config);
  const summary = {
    success: true,
    sourceFolder,
    outputFolder,
    operation,
	    outputMode,
	    namingMode,
	    labelNamingTarget,
	    styleNameField: normalizeStyleNameField(config),
	    groupSize: getGroupSize(config),
    labelIndex: normalizeNamingMode(config) === 'label' && normalizeLabelNamingTarget(config) === 'style'
      ? getLabelIndex(config)
      : null,
    imageSuffixes: getImageSuffixes(config),
    labelSuffix: getLabelSuffix(config),
    totalImages: imageFiles.length,
    organizedStyles: groups.length,
	    failedStyles: failedGroups,
	    unmatchedImages,
	    preservedUnmatchedFiles,
	    generatedAt: new Date().toISOString(),
    styles: manifest,
    issues,
  };

  const summaryPath = path.join(metadataDir, 'organize_summary.json');
  writeJson(summaryPath, summary);
  if (failedGroups.length > 0) {
    writeJson(path.join(metadataDir, 'failed_styles.json'), failedGroups);
  }
  if (unmatchedImages.length > 0) {
    writeJson(path.join(metadataDir, 'unmatched_images.json'), unmatchedImages);
  }

  emitProgress(100);
  emitLog(`Organized ${groups.length} groups into target folder ${outputFolder}.`, 'success');
  emitLog(`Saved organize metadata into ${metadataDir}.`, 'info');

  return {
    success: true,
    outputPath: outputFolder,
    styleCount: groups.length,
    failedCount: failedGroups.length,
    unmatchedCount: unmatchedImages.length,
    metadataPath: metadataDir,
    summaryPath,
    issues,
  };
}

function buildExcelRowsFromOrganizeSummary(summary = {}) {
  const styles = Array.isArray(summary.styles) ? summary.styles : [];
  return styles.map((style, index) => {
    const labelInfo = style.labelInfo || {};

    return {
      '序号': index + 1,
      '面料图': '',
      '款号': labelInfo.styleNumber || style.styleNumber || labelInfo.fabricCode || '',
      '成分': cleanOrganizerComposition(labelInfo.composition || ''),
      '门幅': labelInfo.width || '',
      '可裁门幅': labelInfo.cuttable || '',
      '克重': labelInfo.weight || '',
    };
  });
}

function toPathList(value) {
  if (!value) {
    return [];
  }
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => toPathList(item));
  }
  if (typeof value === 'object') {
    const direct = value.targetPath || value.path || value.filePath || value.sourcePath || value.displayImagePath;
    return [
      direct,
      ...Object.values(value).flatMap((item) => (
        item && typeof item === 'object' ? toPathList(item) : [item]
      )),
    ].filter(Boolean);
  }
  return [];
}

function isLikelyOrganizerLabelPath(filePath = '') {
  const leaf = path.basename(String(filePath || '')).toLowerCase();
  return /(^|[_\-\s])(label|tag|ocr|info)([_\-\s.]|$)/i.test(leaf);
}

function getPrimaryOrganizerImagePath(style = {}) {
  const candidates = [
    ...toPathList(style.galleryImagePaths),
    ...toPathList(style.files).filter((candidate) => !isLikelyOrganizerLabelPath(candidate)),
    ...toPathList(style.sourceFiles).filter((candidate) => !isLikelyOrganizerLabelPath(candidate)),
  ]
    .map((candidate) => String(candidate || '').trim())
    .filter((candidate, index, list) => candidate && list.indexOf(candidate) === index)
    .filter((candidate) => fs.existsSync(candidate) && isImageFile(candidate));
  return candidates[0]
    || '';
}

function getImageContentType(filePath = '') {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') {
    return 'image/png';
  }
  if (ext === '.webp') {
    return 'image/webp';
  }
  return 'image/jpeg';
}

function buildDrawingXml(images = []) {
  const anchors = images.map((image, index) => {
    const rowIndex = Math.max(1, Number(image.rowIndex) || 1);
    return [
      '<xdr:twoCellAnchor editAs="twoCell">',
      '<xdr:from>',
      '<xdr:col>1</xdr:col>',
      '<xdr:colOff>57150</xdr:colOff>',
      `<xdr:row>${rowIndex}</xdr:row>`,
      '<xdr:rowOff>57150</xdr:rowOff>',
      '</xdr:from>',
      '<xdr:to>',
      '<xdr:col>2</xdr:col>',
      '<xdr:colOff>-57150</xdr:colOff>',
      `<xdr:row>${rowIndex + 1}</xdr:row>`,
      '<xdr:rowOff>-57150</xdr:rowOff>',
      '</xdr:to>',
      `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${index + 2}" name="面料图 ${index + 1}"/><xdr:cNvPicPr/></xdr:nvPicPr>`,
      '<xdr:blipFill>',
      `<a:blip r:embed="${escapeXml(image.relationshipId)}"/>`,
      '<a:stretch><a:fillRect/></a:stretch>',
      '</xdr:blipFill>',
      '<xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>',
      '<xdr:clientData fLocksWithSheet="1"/>',
      '</xdr:twoCellAnchor>',
    ].join('');
  }).join('');

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" '
    + 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + anchors
    + '</xdr:wsDr>';
}

async function embedOrganizerImagesInWorkbook(workbookPath, summary = {}) {
  const styles = Array.isArray(summary.styles) ? summary.styles : [];
  const images = styles
    .map((style, index) => ({
      rowIndex: index + 1,
      path: getPrimaryOrganizerImagePath(style),
    }))
    .filter((image) => image.path);

  if (images.length === 0) {
    return 0;
  }

  const zip = await JSZip.loadAsync(fs.readFileSync(workbookPath));
  const workbookRelsPath = 'xl/_rels/workbook.xml.rels';
  const workbookRelsXml = await zip.file(workbookRelsPath)?.async('string');
  const sheetRelationshipMatch = String(workbookRelsXml || '').match(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="worksheets\/sheet1\.xml"[^>]*>/);
  if (!sheetRelationshipMatch) {
    return 0;
  }

  const sheetRelsPath = 'xl/worksheets/_rels/sheet1.xml.rels';
  let sheetRelsXml = await zip.file(sheetRelsPath)?.async('string');
  sheetRelsXml = ensureRelationshipXml(sheetRelsXml || '');
  const drawingRelationshipId = getNextRelationshipId(sheetRelsXml);
  sheetRelsXml = addRelationship(sheetRelsXml, {
    id: drawingRelationshipId,
    type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing',
    target: '../drawings/drawing1.xml',
  });

  const drawingRelationships = [];
  images.forEach((image, index) => {
    const ext = path.extname(image.path).toLowerCase() || '.jpg';
    const safeExt = ext === '.jpeg' ? '.jpg' : ext;
    const mediaName = `image${index + 1}${safeExt}`;
    const relationshipId = `rId${index + 1}`;
    zip.file(`xl/media/${mediaName}`, fs.readFileSync(image.path));
    drawingRelationships.push({
      ...image,
      relationshipId,
      target: `../media/${mediaName}`,
      ext: safeExt.replace(/^\./, ''),
      contentType: getImageContentType(image.path),
    });
  });

  const drawingRelsXml = ensureRelationshipXml();
  const nextDrawingRelsXml = drawingRelationships.reduce((xml, image) => addRelationship(xml, {
    id: image.relationshipId,
    type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
    target: image.target,
  }), drawingRelsXml);

  const sheetXmlPath = 'xl/worksheets/sheet1.xml';
  const sheetXml = await zip.file(sheetXmlPath)?.async('string');
  zip.file(sheetXmlPath, ensureWorksheetDrawing(sheetXml || '', drawingRelationshipId));
  zip.file(sheetRelsPath, sheetRelsXml);
  zip.file('xl/drawings/drawing1.xml', buildDrawingXml(drawingRelationships));
  zip.file('xl/drawings/_rels/drawing1.xml.rels', nextDrawingRelsXml);

  const contentTypesPath = '[Content_Types].xml';
  let contentTypesXml = await zip.file(contentTypesPath)?.async('string');
  contentTypesXml = ensureContentOverride(
    contentTypesXml || '',
    '/xl/drawings/drawing1.xml',
    'application/vnd.openxmlformats-officedocument.drawing+xml',
  );
  drawingRelationships.forEach((image) => {
    contentTypesXml = ensureContentType(contentTypesXml, image.ext, image.contentType);
  });
  zip.file(contentTypesPath, contentTypesXml);

  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  fs.writeFileSync(workbookPath, buffer);
  return images.length;
}

async function exportOrganizeSummaryToExcel(payload = {}) {
  const summaryPath = String(payload.summaryPath || '').trim();
  if (!summaryPath || !fs.existsSync(summaryPath)) {
    throw new Error('Organizer summary file was not found.');
  }

  const summary = readJson(summaryPath);
  const rows = buildExcelRowsFromOrganizeSummary(summary);
  if (rows.length === 0) {
    throw new Error('No recognized organizer rows were found for Excel export.');
  }

  const outputPath = String(payload.outputPath || '').trim()
    || path.join(
      summary.outputFolder || path.dirname(summaryPath),
      `图片整理识别信息_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.xlsx`,
    );

  ensureDir(path.dirname(outputPath));
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(rows);
  worksheet['!cols'] = [
    { wch: 8 },
    { wch: 22 },
    { wch: 20 },
    { wch: 32 },
    { wch: 14 },
    { wch: 14 },
    { wch: 14 },
  ];
  worksheet['!rows'] = [
    { hpt: 24 },
    ...rows.map(() => ({ hpt: 104 })),
  ];
  XLSX.utils.book_append_sheet(workbook, worksheet, '识别信息');
  XLSX.writeFile(workbook, outputPath);
  const imageCount = await embedOrganizerImagesInWorkbook(outputPath, summary);

  return {
    success: true,
    outputPath,
    rowCount: rows.length,
    imageCount,
  };
}

module.exports = {
  organizeStyleImages,
  exportOrganizeSummaryToExcel,
};

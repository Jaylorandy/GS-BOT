const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CACHE_ROOT = path.join(os.homedir(), '.gsbot', 'processing-cache');
const CACHE_FALLBACK_ROOT = path.join(os.tmpdir(), 'gsbot-processing-cache');
const EXTRA_CACHE_ROOTS = [
  path.join(os.homedir(), '.gsbot', 'ppt-scan-cache'),
  path.join(os.tmpdir(), 'gsbot-ppt-scan-cache'),
];

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sanitizeSegment(value = '', fallback = 'cache') {
  return String(value || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || fallback;
}

function resolveWritableDir(preferredDir, fallbackDir) {
  const candidates = [preferredDir, fallbackDir].filter(Boolean);
  for (const candidate of candidates) {
    try {
      ensureDir(candidate);
      const probePath = path.join(candidate, `.probe-${process.pid}-${Date.now()}`);
      fs.writeFileSync(probePath, 'ok', 'utf8');
      fs.unlinkSync(probePath);
      return candidate;
    } catch {
      // Try the next writable location.
    }
  }

  throw new Error(`No writable cache directory available. Tried: ${candidates.join(', ')}`);
}

function getNamespaceDir(namespace = 'default') {
  const safeNamespace = sanitizeSegment(namespace, 'default');
  return resolveWritableDir(
    path.join(CACHE_ROOT, safeNamespace),
    path.join(CACHE_FALLBACK_ROOT, safeNamespace),
  );
}

function stableSerialize(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }

  return JSON.stringify(value);
}

function hashValue(value) {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex');
}

function buildCacheFilePath(namespace, cacheKey) {
  return path.join(getNamespaceDir(namespace), `${cacheKey}.json`);
}

function readJsonCache(namespace, cacheKey) {
  const cachePath = buildCacheFilePath(namespace, cacheKey);
  if (!fs.existsSync(cachePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonCache(namespace, cacheKey, value) {
  const cachePath = buildCacheFilePath(namespace, cacheKey);
  ensureDir(path.dirname(cachePath));
  fs.writeFileSync(cachePath, JSON.stringify(value, null, 2), 'utf8');
  return cachePath;
}

function buildFileSignature(filePath, options = {}) {
  const resolvedPath = path.resolve(String(filePath || ''));
  const stats = fs.statSync(resolvedPath);
  const signature = {
    path: resolvedPath,
    size: Number(stats.size) || 0,
    mtimeMs: Math.round(Number(stats.mtimeMs) || 0),
  };

  if (options.strategy === 'content') {
    signature.digest = crypto.createHash('sha1').update(fs.readFileSync(resolvedPath)).digest('hex');
  }

  return signature;
}

function buildFileOperationCacheKey(namespace, filePath, operationOptions = {}, cacheOptions = {}) {
  const cacheVersion = Number(cacheOptions.version) || 1;
  const signature = buildFileSignature(filePath, cacheOptions);
  return hashValue(stableSerialize({
    namespace,
    cacheVersion,
    signature,
    operationOptions,
  }));
}

function readFileOperationCache(namespace, filePath, operationOptions = {}, cacheOptions = {}) {
  try {
    const cacheKey = buildFileOperationCacheKey(namespace, filePath, operationOptions, cacheOptions);
    return readJsonCache(namespace, cacheKey);
  } catch {
    return null;
  }
}

function writeFileOperationCache(namespace, filePath, operationOptions = {}, value = null, cacheOptions = {}) {
  try {
    const cacheKey = buildFileOperationCacheKey(namespace, filePath, operationOptions, cacheOptions);
    return writeJsonCache(namespace, cacheKey, value);
  } catch {
    return '';
  }
}

function getCacheRoots() {
  return {
    primary: CACHE_ROOT,
    fallback: CACHE_FALLBACK_ROOT,
    extra: EXTRA_CACHE_ROOTS,
  };
}

function summarizeDirectory(dirPath) {
  const exists = fs.existsSync(dirPath);
  if (!exists) {
    return {
      fileCount: 0,
      totalBytes: 0,
      lastModifiedMs: 0,
    };
  }

  let fileCount = 0;
  let totalBytes = 0;
  let lastModifiedMs = 0;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  entries.forEach((entry) => {
    const filePath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const child = summarizeDirectory(filePath);
      fileCount += child.fileCount;
      totalBytes += child.totalBytes;
      lastModifiedMs = Math.max(lastModifiedMs, child.lastModifiedMs);
      return;
    }

    if (!entry.isFile()) {
      return;
    }

    const stats = fs.statSync(filePath);
    fileCount += 1;
    totalBytes += Number(stats.size) || 0;
    lastModifiedMs = Math.max(lastModifiedMs, Number(stats.mtimeMs) || 0);
  });

  return {
    fileCount,
    totalBytes,
    lastModifiedMs,
  };
}

function getNamespaceCandidateDirs(namespace = 'default') {
  const safeNamespace = sanitizeSegment(namespace, 'default');
  return [
    path.join(CACHE_ROOT, safeNamespace),
    path.join(CACHE_FALLBACK_ROOT, safeNamespace),
  ];
}

function readNamespaceSummary(namespace = 'default', options = {}) {
  try {
    const dirPaths = options.dirPath
      ? [options.dirPath]
      : getNamespaceCandidateDirs(namespace);
    const summaries = dirPaths.map((dirPath) => ({
      dirPath,
      ...summarizeDirectory(dirPath),
    }));
    const existingSummaries = summaries.filter((summary) => fs.existsSync(summary.dirPath));
    const displaySummaries = existingSummaries.length ? existingSummaries : summaries.slice(0, 1);
    const fileCount = displaySummaries.reduce((total, summary) => total + summary.fileCount, 0);
    const totalBytes = displaySummaries.reduce((total, summary) => total + summary.totalBytes, 0);
    const lastModifiedMs = displaySummaries.reduce((maxValue, summary) => Math.max(maxValue, summary.lastModifiedMs), 0);

    return {
      namespace,
      dirPath: displaySummaries.map((summary) => summary.dirPath).join('\n'),
      fileCount,
      totalBytes,
      lastModifiedAt: lastModifiedMs ? new Date(lastModifiedMs).toISOString() : '',
    };
  } catch {
    return {
      namespace,
      dirPath: '',
      fileCount: 0,
      totalBytes: 0,
      lastModifiedAt: '',
    };
  }
}

function clearNamespaceCache(namespace = 'default') {
  const summary = readNamespaceSummary(namespace);
  if (!summary.dirPath) {
    return {
      namespace,
      cleared: false,
      removedFiles: 0,
      removedBytes: 0,
      dirPath: '',
    };
  }

  const dirPaths = getNamespaceCandidateDirs(namespace);
  dirPaths.forEach((dirPath) => {
    fs.rmSync(dirPath, { recursive: true, force: true });
  });
  return {
    namespace,
    cleared: true,
    removedFiles: summary.fileCount,
    removedBytes: summary.totalBytes,
    dirPath: dirPaths.join('\n'),
  };
}

function clearDirectoryCache(namespace, dirPath) {
  const summary = readNamespaceSummary(namespace, { dirPath });
  if (!summary.dirPath || !fs.existsSync(summary.dirPath)) {
    return {
      namespace,
      cleared: false,
      removedFiles: 0,
      removedBytes: 0,
      dirPath: summary.dirPath || dirPath || '',
    };
  }

  fs.rmSync(summary.dirPath, { recursive: true, force: true });
  return {
    namespace,
    cleared: true,
    removedFiles: summary.fileCount,
    removedBytes: summary.totalBytes,
    dirPath: summary.dirPath,
  };
}

function readExtraCacheSummaries() {
  return EXTRA_CACHE_ROOTS.map((dirPath, index) => readNamespaceSummary(
    index === 0 ? 'ppt-scan-cache' : 'ppt-scan-cache-temp',
    { dirPath },
  ));
}

function clearAllCaches(namespaces = []) {
  const normalizedNamespaces = [...new Set((Array.isArray(namespaces) ? namespaces : [])
    .map((namespace) => sanitizeSegment(namespace, ''))
    .filter(Boolean))];
  const results = [];

  normalizedNamespaces.forEach((namespace) => {
    results.push(clearNamespaceCache(namespace));
  });

  EXTRA_CACHE_ROOTS.forEach((dirPath, index) => {
    results.push(clearDirectoryCache(
      index === 0 ? 'ppt-scan-cache' : 'ppt-scan-cache-temp',
      dirPath,
    ));
  });

  return {
    cleared: true,
    removedFiles: results.reduce((total, result) => total + (Number(result.removedFiles) || 0), 0),
    removedBytes: results.reduce((total, result) => total + (Number(result.removedBytes) || 0), 0),
    results,
  };
}

module.exports = {
  buildFileOperationCacheKey,
  buildFileSignature,
  clearAllCaches,
  clearNamespaceCache,
  ensureDir,
  getCacheRoots,
  getNamespaceDir,
  hashValue,
  readExtraCacheSummaries,
  readNamespaceSummary,
  readFileOperationCache,
  readJsonCache,
  resolveWritableDir,
  sanitizeSegment,
  stableSerialize,
  writeFileOperationCache,
  writeJsonCache,
};

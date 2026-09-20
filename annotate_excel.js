const XLSX = require('xlsx');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

function normalizeLookupKey(value = '') {
  return String(value || '').trim().toLowerCase();
}

function normalizeScraperBrand(value = '') {
  const raw = String(value || '').replace(/\u00a0/g, ' ').trim().toLowerCase();
  if (!raw) {
    return '';
  }

  if (raw === 'mixed' || raw === 'mix' || raw === 'mixed brands') return 'mixed';
  if (raw === 'zara') return 'zara';
  if (raw === 'bershka') return 'bershka';
  if (raw === 'stradivarius') return 'stradivarius';
  if (raw === 'pullandbear' || raw === 'pull&bear' || raw === 'pull and bear' || raw === 'pull-and-bear') return 'pullandbear';
  if (raw === 'lefties') return 'lefties';
  if (raw === 'mango' || raw === 'mng') return 'mango';
  if (raw === 'urban outfitters' || raw === 'urbanoutfitters' || raw === 'urban-outfitters') return 'urbanoutfitters';
  if (raw === 'uniqlo' || raw === 'un iqlo') return 'uniqlo';
  return '';
}

function getScraperOutputFolderName(brand = '') {
  const normalizedBrand = normalizeScraperBrand(brand);
  if (normalizedBrand === 'bershka') return 'Bershka';
  if (normalizedBrand === 'stradivarius') return 'Stradivarius';
  if (normalizedBrand === 'pullandbear') return 'Pull&Bear';
  if (normalizedBrand === 'lefties') return 'Lefties';
  if (normalizedBrand === 'mango') return 'Mango';
  if (normalizedBrand === 'urbanoutfitters') return 'Urban Outfitters';
  if (normalizedBrand === 'uniqlo') return 'UNIQLO';
  if (normalizedBrand === 'mixed') return 'Mixed Brands';
  return 'Zara';
}

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function extractZaraStyleId(styleNumber) {
  const parts = String(styleNumber || '').match(/\d+/g);
  if (parts && parts.length >= 3) {
    return parts[0].substring(0, 4) + parts[1].substring(0, 3) + parts[2].substring(0, 3);
  }
  if (parts && parts.length >= 2) {
    return parts[0].substring(0, 6) + parts[1].substring(0, 2);
  }
  if (parts && parts.length >= 1) {
    const num = parts[0];
    if (num.length >= 10) {
      return num.substring(0, 10);
    }
    return num.padStart(10, '0');
  }
  return null;
}

function buildLookupKeys(styleNumber, brand = 'zara') {
  const raw = String(styleNumber || '').trim();
  const compact = raw.replace(/\s+/g, '');
  const dashed = compact.replace(/[\\/]+/g, '-');
  const slashless = compact.replace(/[\\/]/g, '');
  const digitOnly = compact.replace(/[^\d]/g, '');
  const zaraId = brand === 'zara' ? extractZaraStyleId(compact) : null;

  return unique([
    raw,
    compact,
    dashed,
    slashless,
    digitOnly,
    zaraId,
  ]).map(normalizeLookupKey);
}

function getImageExtensions() {
  return new Set(['.jpg', '.jpeg', '.png', '.webp']);
}

function countImagesInDir(dirPath) {
  try {
    const imageExts = getImageExtensions();
    const files = fs.readdirSync(dirPath);
    return files.filter((file) => imageExts.has(path.extname(file).toLowerCase())).length;
  } catch {
    return 0;
  }
}

function resolveStyleDirectories(outputDir, styleNumber, brand) {
  const keys = buildLookupKeys(styleNumber, brand);
  return unique(keys.map((key) => {
    if (!key) return null;
    return path.join(outputDir, key.replace(/[\\/]/g, '-'));
  })).filter((dirPath) => fs.existsSync(dirPath));
}

function buildResultLookup(entries = [], brand = 'zara') {
  const map = new Map();
  entries.forEach((entry) => {
    const styleNumber = String(entry?.styleNumber || entry?.productId || '').trim();
    buildLookupKeys(styleNumber, brand).forEach((key) => {
      map.set(key, entry);
    });
  });
  return map;
}

function loadJsonIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function loadBrandArtifacts(outputDir, brand = 'zara') {
  const summaryEntries = loadJsonIfExists(path.join(outputDir, 'summary.json')) || [];
  const failedEntries = loadJsonIfExists(path.join(outputDir, 'failed_styles.json')) || [];

  return {
    summaryMap: buildResultLookup(summaryEntries, brand),
    failedMap: buildResultLookup(failedEntries, brand),
  };
}

function checkStyleExists(styleId) {
  return new Promise((resolve) => {
    const url = `https://www.zara.com/us/en/-p${String(styleId).substring(0, 8)}.html`;
    const protocol = url.startsWith('https') ? https : http;

    try {
      const req = protocol.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10000 }, (response) => {
        let data = '';

        response.on('data', (chunk) => {
          data += chunk;
        });

        response.on('end', () => {
          if (response.statusCode === 200) {
            if (data.includes('product-detail') || data.includes('add-to-cart') || data.includes('size-selector')) {
              resolve(true);
            } else if (data.includes('<h1') && data.toLowerCase().includes('zara')) {
              resolve(true);
            } else if (data.includes('content="5') && data.includes('URL=')) {
              resolve('javascript');
            } else {
              resolve(false);
            }
          } else {
            resolve(false);
          }
        });
      });

      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    } catch {
      resolve(false);
    }
  });
}

async function resolveRowStatus(styleNumber, outputDir, brand, artifacts) {
  const keys = buildLookupKeys(styleNumber, brand);
  const dirs = resolveStyleDirectories(outputDir, styleNumber, brand);
  const imageCount = dirs.reduce((max, dirPath) => Math.max(max, countImagesInDir(dirPath)), 0);

  if (imageCount > 0) {
    return {
      status: 'success',
      statusText: '✅ Success',
      imageCount,
      error: '',
    };
  }

  const summaryEntry = keys.map((key) => artifacts.summaryMap.get(key)).find(Boolean);
  if (summaryEntry) {
    const summaryImageCount = Number(summaryEntry.images || 0);
    return {
      status: summaryImageCount > 0 ? 'success' : 'failed',
      statusText: summaryImageCount > 0 ? '✅ Success' : '❌ Failed',
      imageCount: summaryImageCount,
      error: summaryEntry.error || '',
    };
  }

  const failedEntry = keys.map((key) => artifacts.failedMap.get(key)).find(Boolean);
  if (failedEntry) {
    return {
      status: 'failed',
      statusText: '❌ Failed',
      imageCount: 0,
      error: failedEntry.error || 'No product images found',
    };
  }

  if (brand === 'zara') {
    const zaraId = extractZaraStyleId(styleNumber);
    if (zaraId) {
      const exists = await checkStyleExists(zaraId);
      if (exists === true) {
        return {
          status: 'exists',
          statusText: '⚠️ Exists but not downloaded',
          imageCount: 0,
          error: '',
        };
      }
      if (exists === 'javascript') {
        return {
          status: 'exists',
          statusText: '⏳ JS render required',
          imageCount: 0,
          error: '',
        };
      }
      return {
        status: 'notFound',
        statusText: '❌ Not found',
        imageCount: 0,
        error: '',
      };
    }
  }

  return {
    status: dirs.length > 0 ? 'failed' : 'notProcessed',
    statusText: dirs.length > 0 ? '❌ Failed' : '— Not processed',
    imageCount: 0,
    error: dirs.length > 0 ? 'Folder exists but no downloaded images were found' : '',
  };
}

async function annotateExcel(inputPath, outputDir, logCallback, options = {}) {
  const ensureActive = options.ensureActive || (() => {});
  const brand = normalizeScraperBrand(options.brand || 'zara') || 'zara';

  try {
    logCallback(`📂 Reading Excel: ${inputPath}`);
    logCallback(`🏷️ Brand mode: ${brand}`);
    logCallback(`📁 Results directory: ${outputDir}`);

    const workbook = XLSX.readFile(inputPath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
    const outputPath = path.join(path.parse(inputPath).dir, `${path.parse(inputPath).name}_${brand}_results${path.parse(inputPath).ext}`);

    const artifacts = brand === 'mixed' ? new Map() : loadBrandArtifacts(outputDir, brand);
    const stats = {
      success: 0,
      exists: 0,
      failed: 0,
      notFound: 0,
      notProcessed: 0,
      empty: 0,
    };

    if (!rows[0]) {
      rows[0] = [];
    }
    rows[0][2] = 'Status';
    rows[0][3] = 'Image Count';
    rows[0][4] = 'Error';

    for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
      ensureActive();
      const row = rows[rowIndex] || [];
      const styleNumber = String(row[1] || '').replace(/\u00a0/g, ' ').trim();
      const rowBrand = brand === 'mixed' ? normalizeScraperBrand(row[0] || '') : brand;

      if (!styleNumber || styleNumber === 'undefined' || styleNumber === 'nan') {
        stats.empty += 1;
        continue;
      }

      if (!rowBrand) {
        row[2] = '⚠️ Unsupported brand';
        row[3] = 0;
        row[4] = 'Unsupported or missing brand in column A';
        rows[rowIndex] = row;
        stats.notProcessed += 1;
        continue;
      }

      const brandOutputDir = brand === 'mixed'
        ? path.join(outputDir, getScraperOutputFolderName(rowBrand))
        : outputDir;
      const brandArtifacts = brand === 'mixed'
        ? (artifacts.get(rowBrand) || (() => {
            const loaded = loadBrandArtifacts(brandOutputDir, rowBrand);
            artifacts.set(rowBrand, loaded);
            return loaded;
          })())
        : artifacts;

      logCallback(`  [${rowIndex + 1}] Checking ${styleNumber}${brand === 'mixed' ? ` (${rowBrand})` : ''}`, 'info');
      const result = await resolveRowStatus(styleNumber, brandOutputDir, rowBrand, brandArtifacts);
      ensureActive();

      row[2] = result.statusText;
      row[3] = result.imageCount || 0;
      row[4] = result.error || '';
      rows[rowIndex] = row;

      if (stats[result.status] !== undefined) {
        stats[result.status] += 1;
      }
    }

    workbook.Sheets[sheetName] = XLSX.utils.aoa_to_sheet(rows);
    XLSX.writeFile(workbook, outputPath);

    logCallback(`💾 Saved annotated workbook: ${outputPath}`, 'success');
    logCallback('');
    logCallback('📊 Annotation summary:');
    logCallback(`  ✅ Success: ${stats.success}`);
    logCallback(`  ⚠️ Exists but not downloaded: ${stats.exists}`);
    logCallback(`  ❌ Failed: ${stats.failed}`);
    logCallback(`  ❌ Not found: ${stats.notFound}`);
    logCallback(`  — Not processed: ${stats.notProcessed}`);
    logCallback(`  ⬜ Empty / invalid: ${stats.empty}`);

    return outputPath;
  } catch (error) {
    throw new Error(`Annotation failed: ${error.message}`);
  }
}

module.exports = {
  annotateExcel,
};

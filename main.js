const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } = require('electron');
const path = require('path');
const puppeteer = require('puppeteer-core');
const fs = require('fs');

// ── Ensure sharp native DLLs are discoverable in packaged builds ──
// On Windows, sharp's .node file needs libvips-42.dll / libvips-cpp.dll from
// @img/sharp-win32-x64/lib, which lives in app.asar.unpacked. Add it to PATH
// early so any module that require('sharp') works correctly.
if (process.platform === 'win32') {
  try {
    const _resourcesPath = process.resourcesPath || (app.isPackaged ? path.join(path.dirname(process.execPath), 'resources') : null);
    if (_resourcesPath) {
      const _sharpDllDir = path.join(_resourcesPath, 'app.asar.unpacked', 'node_modules', '@img', 'sharp-win32-x64', 'lib');
      if (fs.existsSync(_sharpDllDir)) {
        const _curPath = process.env.PATH || '';
        if (!_curPath.split(';').includes(_sharpDllDir)) {
          process.env.PATH = _sharpDllDir + ';' + _curPath;
        }
      }
    }
  } catch (_) { /* ignore */ }
}
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const os = require('os');
const XLSX = require('xlsx');
const { execFile, exec: execCmd, execSync, spawnSync } = require('child_process');
const antiDetection = require('./anti-detection');
const imageUrlGenerator = require('./image-url-generator');
const runtimeResolver = require('./runtime-resolver');
const ocrModelRegistry = require('./ocr-model-registry');
const licenseService = require('./license-service');
const skillPackManager = require('./skill-pack-manager');
const {
  TaskCancelledError,
  clearTaskHistoryForSender,
  getTaskKey,
  listManagedTasksForSender,
  runManagedTask,
  updateTaskSnapshot,
} = require('./task-manager');
const { registerPdfSqueezerHandlers } = require('./pdf-squeezer-handlers');
const { registerSlidesAnalysisHandlers } = require('./slides-analysis-handlers');
const firecrawlService = require('./firecrawl-service');
const firecrawlFallback = require('./firecrawl-fallback');
const paddleOcrService = require('./paddleocr-service');
const {
  clearAllCaches,
  clearNamespaceCache,
  getCacheRoots,
  readExtraCacheSummaries,
  readNamespaceSummary,
} = require('./processing-cache');
const activeTaskControllers = new Map();
let mainWindow = null;

const startupLogFile = path.join(os.tmpdir(), 'gsbot-startup.log');
const APP_USER_MODEL_ID = 'com.gsrd.gsbot';

function isCancellationError(error) {
  const message = String(error?.message || '');
  return error instanceof TaskCancelledError
    || error?.code === 'TASK_CANCELLED'
    || /Task cancelled by user/i.test(message);
}

class ScraperSiteBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScraperSiteBlockedError';
    this.code = 'SCRAPER_SITE_BLOCKED';
  }
}

function isScraperSiteBlockedError(error) {
  return error instanceof ScraperSiteBlockedError || error?.code === 'SCRAPER_SITE_BLOCKED';
}

function writeStartupLog(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.appendFileSync(startupLogFile, line, 'utf8');
  } catch (error) {
    console.error('Failed to write startup log:', error);
  }
  console.log(line.trim());
}

// 全局错误处理
process.on('uncaughtException', (error) => {
  const errorLog = `[ERROR] ${new Date().toISOString()}\n${error.stack}\n\n`;
  console.error(errorLog);
  writeStartupLog(`uncaughtException: ${error.stack || error.message}`);
  writeErrorLog(errorLog);
});

process.on('unhandledRejection', (reason, promise) => {
  const errorLog = `[UNHANDLED REJECTION] ${new Date().toISOString()}\n${reason}\n\n`;
  console.error(errorLog);
  writeStartupLog(`unhandledRejection: ${String(reason)}`);
  writeErrorLog(errorLog);
});

function writeErrorLog(log) {
  try {
    const logDir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, 'error.log');
    fs.appendFileSync(logFile, log, 'utf-8');
  } catch (e) {
    console.error('Failed to write error log:', e);
  }
}

const delay = ms => new Promise(r => setTimeout(r, ms));
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECT_DEPTH = 4;

function fixLLMBaseUrl(baseUrl = '') {
  let url = String(baseUrl || '').trim();
  if (!url) return url;
  try {
    const u = new URL(url);
    if (u.hostname === 'api.ollama.com') u.hostname = 'ollama.com';
    if (u.hostname === 'api.openai.com' && !url.includes('/v1')) {
      u.pathname = '/v1' + (u.pathname === '/' ? '' : u.pathname);
    }
    return u.toString();
  } catch (e) {
    return url;
  }
}

/**
 * 按 LLM 模式 + baseUrl/model 推断真实 provider（对齐 llm-config.getActiveConfig 约定）
 * - local    → 'ollama'（Ollama REST API /api/chat）
 * - apiCloud → 'openai'（GLM/DeepSeek/Qwen 等 OpenAI 兼容端点）
 * - cloud    → ollama.com / localhost / 11434 → 'ollama'（Ollama Cloud 仍是 Ollama REST API）
 *              其余云端点（bigmodel.cn 等 OpenAI 兼容）→ 'openai'
 * - 其他     → 'auto'（LLMClient 会按 baseUrl 自行判断）
 */
function inferLLMProvider(mode = '', baseUrl = '', model = '') {
  const m = String(mode || '').trim().toLowerCase();
  if (m === 'local') return 'ollama';
  if (m === 'apicloud') return 'openai';
  if (m === 'cloud') {
    const url = String(baseUrl || '').toLowerCase();
    if (
      url.includes('ollama.com')
      || url.includes('localhost')
      || url.includes('127.0.0.1')
      || url.includes('0.0.0.0')
      || url.includes('::1')
      || url.includes(':11434')
    ) {
      return 'ollama';
    }
    return 'openai';
  }
  return 'auto';
}

/**
 * 按指定 AI 来源（local/cloud/apiCloud）构建 effectiveLLM 配置。
 * B2 模型分工：模板分析 / 内容提取可分别用不同来源，统一走此 helper。
 */
function buildEffectiveLLM(mode, config, sharedLLMConfig, emitLog) {
  const base = { baseUrl: 'http://localhost:11434', model: '', provider: 'ollama', apiKey: '' };
  if (!sharedLLMConfig) return { ...base };
  const m = String(mode || '').trim().toLowerCase() || 'local';

  if (m === 'apicloud') {
    const apiCloudCfg = sharedLLMConfig.apiCloud || {};
    const activePreset = (apiCloudCfg.presets || []).find(p => p.id === apiCloudCfg.activePresetId) || {};
    if (typeof emitLog === 'function') {
      emitLog(`  [DEBUG] apiCloud: activePresetId=${apiCloudCfg.activePresetId}, presetName=${activePreset.name}, baseUrl=${activePreset.baseUrl}, model=${activePreset.model}, apiKey.length=${activePreset.apiKey ? activePreset.apiKey.length : 0}`, 'debug');
    }
    return {
      baseUrl: activePreset.baseUrl || base.baseUrl,
      model: config.llmModel || activePreset.model || '',
      provider: 'openai',
      apiKey: activePreset.apiKey || '',
    };
  }

  const modeCfg = sharedLLMConfig[m] || {};
  return {
    baseUrl: modeCfg.baseUrl || base.baseUrl,
    model: config.llmModel || modeCfg.model || '',
    provider: inferLLMProvider(m, modeCfg.baseUrl || base.baseUrl, config.llmModel || modeCfg.model || ''),
    apiKey: modeCfg.apiKey || '',
  };
}

function resolveRedirectUrl(location, baseUrl) {
  if (!location) return '';
  try {
    return new URL(location, baseUrl).toString();
  } catch {
    return '';
  }
}

function getLicenseFailurePayload(error) {
  if (error?.code !== 'LICENSE_REQUIRED') {
    return null;
  }

  return {
    success: false,
    error: error.message || 'A valid license is required.',
    licenseRequired: true,
    licenseStatus: error.licenseStatus || null,
  };
}

function assertLicensedForFeature() {
  return licenseService.assertLicensed();
}

function getPythonRuntime() {
  return runtimeResolver.findPythonRuntime();
}

// 图片分类映射：URL后缀 → 文件标签
// 同时支持连字符(-)和下划线(_)分隔符
const SUFFIX_MAP = {
  // e系列 - 产品平铺图
  '_e1': 'F',   '-e1': 'F',     // 正面
  '_e2': 'B',   '-e2': 'B',     // 背面
  '_e3': 'D1',  '-e3': 'D1',    // 细节1
  '_e4': 'D2',  '-e4': 'D2',    // 细节2
  // 2-x-p系列 - 产品平铺图（另一种URL格式）
  '_2-1-p': 'F',                 // 正面
  '_2-2-p': 'B',                 // 背面
  '_2-3-p': 'D1',                // 细节1
  '_2-4-p': 'D2',                // 细节2
  '_2-5-p': 'D3',                // 细节3
  '_2-6-p': 'D4',                // 细节4
  // 1-x-p系列
  '_1-1-p': 'F',                 // 正面（备用）
  '_1-2-p': 'B',                 // 背面（备用）
  '_1-3-p': 'D1',                // 细节1（备用）
  '_1-4-p': 'D2',                // 细节2（备用）
  // p系列 - 模特图
  '_2-0-p': '01', '_1-0-p': '01', '-p': '01',
  // a系列 - 额外图片
  '_a1': '02',  '-a1': '02',
  '_a2': '03',  '-a2': '03',
  '_a3': '04',  '-a3': '04',
  '_a4': '05',  '-a4': '05',
  '_a5': '06',  '-a5': '06',
  '_a6': '07',  '-a6': '07',
  '_a7': '08',  '-a7': '08',
  '_a8': '09',  '-a8': '09',
};

function buildUrl(styleNum) {
  // Zara URL format: take first 7 digits, pad to 8 with leading zero
  // e.g. 1934/470/807 → 01934470, 0155/325/518 → 00155325
  const cleanNum = styleNum.replace(/[^0-9]/g, '');

  let pid;
  if (cleanNum.length >= 9) {
    // 9位或更多: 取前7位，补0到8位
    pid = cleanNum.substring(0, 7).padStart(8, '0');
  } else if (cleanNum.length === 8) {
    // 8位: 直接使用
    pid = cleanNum;
  } else if (cleanNum.length === 7) {
    // 7位: 补0到8位
    pid = cleanNum.padStart(8, '0');
  } else {
    // 其他: 补0到8位
    pid = cleanNum.padStart(8, '0');
  }

  return `https://www.zara.com/us/en/-p${pid}.html`;
}

function classifyImage(url, styleNum) {
  const cleanNum = styleNum.replace(/[^0-9]/g, '');
  const basename = path.basename(url).toLowerCase();
  
  // 构建多个可能的ID用于匹配
  const possibleIds = new Set();
  possibleIds.add(cleanNum);                          // 完整数字 (如 2127887046)
  possibleIds.add(cleanNum.padStart(11, '0'));         // 补0到11位
  possibleIds.add(cleanNum.padStart(10, '0'));         // 补0到10位
  
  if (cleanNum.length >= 9) {
    possibleIds.add(cleanNum.substring(0, 7).padStart(8, '0')); // 8位ID (如 02127887)
  }
  if (cleanNum.length >= 8) {
    possibleIds.add(cleanNum.substring(0, 8));         // 前8位
  }

  // 按后缀长度从长到短排序，避免短后缀误匹配
  const sortedEntries = Object.entries(SUFFIX_MAP).sort((a, b) => b[0].length - a[0].length);
  
  for (const id of possibleIds) {
    for (const [suffix, label] of sortedEntries) {
      if (basename.includes(`${id.toLowerCase()}${suffix}`)) return label;
    }
  }
  return null;
}

function classifyZaraImageBySuffix(url = '') {
  const basename = path.basename(String(url || '').split('?')[0]).toLowerCase();
  const sortedEntries = Object.entries(SUFFIX_MAP).sort((a, b) => b[0].length - a[0].length);
  for (const [suffix, label] of sortedEntries) {
    if (basename.includes(suffix.toLowerCase())) {
      return label;
    }
  }
  if (/-f\d+(?:\.[^.]+)?$/i.test(basename) || /_f\d+(?:\.[^.]+)?$/i.test(basename)) {
    return 'X';
  }
  return null;
}

function extractZaraProductIdFromUrl(url = '') {
  const match = String(url || '').match(/-p(\d{6,12})\.html/i);
  return match ? match[1] : '';
}

// Zara's product pages client-side-redirect (bare /-pNNN.html → slug URL) and
// hydrate as an SPA. domcontentloaded fires on the pre-redirect shell, so an
// immediate page.evaluate throws "Execution context was destroyed". Wait until
// the URL stops changing AND the document is interactive before reading.
async function waitForZaraSettle(page, { settleMs = 1000, maxMs = 6000 } = {}) {
  const start = Date.now();
  let lastUrl = '';
  let stableSince = Date.now();
  while (Date.now() - start < maxMs) {
    let url = '';
    try { url = page.url(); } catch { url = ''; }
    if (url !== lastUrl) { lastUrl = url; stableSince = Date.now(); }
    // Has the URL held steady long enough and the DOM become ready?
    if (Date.now() - stableSince >= settleMs) {
      let ready = false;
      try {
        ready = await page.evaluate(() => document.readyState === 'complete' || document.readyState === 'interactive')
          .catch(() => false);
      } catch { ready = false; }
      if (ready) return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

function looksLikeZaraProductImageUrl(reqUrl = '', candidateIds = []) {
  const value = String(reqUrl || '');
  // Strip query params for extension check, but keep full URL for w= filter
  const cleanUrl = value.split('?')[0];
  const lower = cleanUrl.toLowerCase();
  
  // Check extension on path without query params
  if (!/\.(jpg|jpeg|webp|png)$/i.test(cleanUrl)) {
    return false;
  }
  if (!/static\.zara\.net/i.test(cleanUrl)) {
    return false;
  }
  if (
    lower.includes('transparent-background')
    || lower.includes('/icons/')
    || lower.includes('/logo')
    || lower.includes('favicon')
  ) {
    return false;
  }
  // Filter out thumbnail-sized images (check full URL including query params)
  if (/[?&]w=(48|50|66|80|100)(?:&|$)/i.test(value)) {
    return false;
  }

  const ids = (candidateIds || [])
    .map((item) => String(item || '').replace(/\D/g, ''))
    .filter((item) => item.length >= 6);
  if (ids.some((id) => cleanUrl.includes(id))) {
    return true;
  }

  return false;
}

function normalizeZaraImageUrl(reqUrl = '') {
  return String(reqUrl || '').split('?')[0];
}

function extractZaraImageIdsFromText(value = '') {
  const ids = new Set();
  const text = String(value || '');
  const patterns = [
    /\/(\d{7,14})(?:-\d{3})?[-_](?:p|b|a\d+|e\d+|f\d+|s\d+)\//gi,
    /\/(\d{7,14})(?:-\d{3})?[-_](?:p|b|a\d+|e\d+|f\d+|s\d+)\.(?:jpg|jpeg|webp|png)/gi,
    /C(\d{7,14})-V\d{4}/gi,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (match[1]) {
        ids.add(match[1]);
      }
    }
  }
  return [...ids];
}

function normalizeManualStyleNumbers(styleNumbers) {
  if (Array.isArray(styleNumbers)) {
    return styleNumbers
      .flatMap((item) => normalizeManualStyleNumbers(item))
      .map((item) => String(item || '').trim())
      .filter(Boolean);
  }

  return String(styleNumbers || '')
    .split(/[\n\r,，、;；\t]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Write a search query directly into a DOM input element via the native value
 * descriptor and dispatch the full input lifecycle (input / change / Enter /
 * search / form-submit). This bypasses page.keyboard.type which is prone to
 * being clipped mid-typing by React controlled-input sync, autocomplete
 * debounce, or focus-stealing modals — the root cause of "only the first
 * digit was entered" bugs across retail scrapers.
 *
 * Returns true if the DOM write succeeded; falls back to keyboard typing
 * if the evaluate call itself fails.
 */
async function writeSearchValueViaDOM(page, inputElement, query, emitLog, brand = '') {
  const searchValue = String(query ?? '').trim();
  if (!inputElement) return false;

  const wroteOk = await page.evaluate((args) => {
    const el = args.el;
    const val = String(args.val ?? '');
    if (!el) return false;
    try { el.focus?.(); } catch { /* noop */ }
    // Use the native value descriptor so React/Vue controlled inputs pick up
    // the change (direct el.value = ... is ignored by some frameworks).
    try {
      const proto = el.tagName === 'TEXTAREA'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) {
        setter.call(el, '');          // clear first
        setter.call(el, val);         // then set target value
      } else {
        el.value = val;
      }
    } catch {
      el.value = val;
    }
    const fire = (type, init = {}) => {
      try {
        const ev = new Event(type, Object.assign({ bubbles: true, cancelable: true }, init));
        el.dispatchEvent(ev);
      } catch { /* noop */ }
    };
    fire('input', { inputType: 'insertText', data: val });
    fire('change');
    fire('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13 });
    fire('keyup',   { key: 'Enter', code: 'Enter', keyCode: 13, which: 13 });
    fire('search');
    try {
      const form = el.closest('form');
      if (form && typeof form.requestSubmit === 'function') form.requestSubmit();
      else if (form) form.submit();
    } catch { /* noop */ }
    return true;
  }, { el: inputElement, val: searchValue }).catch(() => false);

  if (!wroteOk) {
    if (emitLog) emitLog(`    ⚠️ ${brand || 'Search'} DOM write failed; falling back to keyboard typing…`, 'warning');
    try {
      await page.keyboard.type(searchValue, { delay: 100 });
      await antiDetection.randomDelay(500, 900);
      await page.keyboard.press('Enter').catch(() => {});
    } catch (err) {
      if (emitLog) emitLog(`    ⚠️ ${brand || 'Search'} keyboard-type fallback also failed: ${err.message}`, 'warning');
    }
  } else {
    await antiDetection.randomDelay(1000, 1600);
  }
  return wroteOk;
}

function downloadFile(url, outputPath, options = {}) {
  const {
    silent = false,
    headers: extraHeaders = {},
    timeoutMs = 30000,
  } = options; // 静默模式，不抛出404等常见错误
  
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(outputPath);
    const headers = {
      'User-Agent': 'Mozilla/5.0',
      'Referer': 'https://www.zara.com/',
      ...extraHeaders,
    };

    // 添加超时处理
    const timeout = setTimeout(() => {
      file.close();
      if (fs.existsSync(outputPath)) {
        try {
          fs.unlinkSync(outputPath);
        } catch (e) {
          // 忽略删除失败
        }
      }
      if (silent) {
        resolve(null); // 静默模式返回null
      } else {
        reject(new Error('下载超时'));
      }
    }, timeoutMs);

    const req = protocol.get(url, { headers }, (response) => {
      clearTimeout(timeout);

      if (REDIRECT_STATUS_CODES.has(response.statusCode) && response.headers.location) {
        file.close();
        if (fs.existsSync(outputPath)) {
          try {
            fs.unlinkSync(outputPath);
          } catch (e) {
            // 忽略删除失败
          }
        }
        const redirectedUrl = resolveRedirectUrl(response.headers.location, url);
        if (!redirectedUrl) {
          return reject(new Error(`Invalid redirect location for ${url}`));
        }
        return downloadFile(redirectedUrl, outputPath, options).then(resolve).catch(reject);
      }

      if (response.statusCode !== 200) {
        file.close();
        if (fs.existsSync(outputPath)) {
          try {
            fs.unlinkSync(outputPath);
          } catch (e) {
            // 忽略删除失败
          }
        }
        
        // 静默模式下，404等错误不抛出异常
        if (silent && (response.statusCode === 404 || response.statusCode === 403)) {
          return resolve(null);
        }
        
        return reject(new Error(`HTTP ${response.statusCode} - ${response.statusMessage}`));
      }

      response.pipe(file);
      file.on('finish', () => {
        file.close();
        try {
          const size = fs.statSync(outputPath).size / 1024;
          if (size < 1) {
            fs.unlinkSync(outputPath);
            if (silent) {
              return resolve(null);
            }
            return reject(new Error('文件太小，可能是下载失败'));
          }
          resolve(size);
        } catch (e) {
          if (silent) {
            return resolve(null);
          }
          reject(new Error(`文件状态检查失败: ${e.message}`));
        }
      });

      file.on('error', (err) => {
        file.close();
        if (fs.existsSync(outputPath)) {
          try {
            fs.unlinkSync(outputPath);
          } catch (e) {
            // 忽略删除失败
          }
        }
        reject(new Error(`文件写入错误: ${err.message}`));
      });
    });

    req.on('error', (err) => {
      clearTimeout(timeout);
      file.close();
      if (fs.existsSync(outputPath)) {
        try {
          fs.unlinkSync(outputPath);
        } catch (e) {
          // 忽略删除失败
        }
      }
      reject(new Error(`网络错误: ${err.message}`));
    });
  });
}

function checkRemoteFileExists(url, options = {}, redirectDepth = 0) {
  const {
    headers: extraHeaders = {},
    timeoutMs = 8000,
  } = options;

  return new Promise((resolve) => {
    const protocol = url.startsWith('https') ? https : http;
    const headers = {
      'User-Agent': 'Mozilla/5.0',
      ...extraHeaders,
    };

    const request = protocol.request(url, { method: 'GET', headers: { ...headers, Range: 'bytes=0-0' } }, (response) => {
      if (REDIRECT_STATUS_CODES.has(response.statusCode) && response.headers.location && redirectDepth < MAX_REDIRECT_DEPTH) {
        const redirectedUrl = resolveRedirectUrl(response.headers.location, url);
        response.resume();
        if (!redirectedUrl) {
          resolve(false);
          return;
        }
        checkRemoteFileExists(redirectedUrl, options, redirectDepth + 1).then(resolve);
        return;
      }

      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 300);
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy();
      resolve(false);
    });
    request.on('error', () => resolve(false));
    request.end();
  });
}

function downloadFileWithProgress(url, outputPath, onProgress = () => {}, options = {}) {
  const {
    headers: extraHeaders = {},
    timeoutMs = 300000,
  } = options;

  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const file = fs.createWriteStream(outputPath);
    const headers = {
      'User-Agent': 'Mozilla/5.0',
      ...extraHeaders,
    };

    const timeout = setTimeout(() => {
      file.close();
      try { fs.unlinkSync(outputPath); } catch {}
      reject(new Error(`Download timed out: ${url}`));
    }, timeoutMs);

    const request = protocol.get(url, { headers }, (response) => {
      if (REDIRECT_STATUS_CODES.has(response.statusCode) && response.headers.location) {
        clearTimeout(timeout);
        file.close();
        try { fs.unlinkSync(outputPath); } catch {}
        const redirectedUrl = resolveRedirectUrl(response.headers.location, url);
        if (!redirectedUrl) {
          return reject(new Error(`Invalid redirect location for ${url}`));
        }
        return downloadFileWithProgress(redirectedUrl, outputPath, onProgress, options)
          .then(resolve)
          .catch(reject);
      }

      if (response.statusCode !== 200) {
        clearTimeout(timeout);
        file.close();
        try { fs.unlinkSync(outputPath); } catch {}
        return reject(new Error(`HTTP ${response.statusCode} - ${response.statusMessage}`));
      }

      const total = Number.parseInt(response.headers['content-length'] || '0', 10);
      let received = 0;
      let lastPercent = -1;
      response.on('data', (chunk) => {
        received += chunk.length;
        if (total > 0) {
          const percent = Math.min(100, Math.round((received / total) * 100));
          if (percent !== lastPercent) {
            lastPercent = percent;
            onProgress(percent);
          }
        }
      });

      response.pipe(file);
      file.on('finish', () => {
        clearTimeout(timeout);
        file.close(() => {
          onProgress(100);
          resolve({
            outputPath,
            bytes: received,
          });
        });
      });

      file.on('error', (error) => {
        clearTimeout(timeout);
        file.close();
        try { fs.unlinkSync(outputPath); } catch {}
        reject(error);
      });
    });

    request.on('error', (error) => {
      clearTimeout(timeout);
      file.close();
      try { fs.unlinkSync(outputPath); } catch {}
      reject(error);
    });
  });
}

async function downloadFileWithRetry(url, outputPath, onProgress = () => {}, options = {}) {
  const {
    retries = 3,
    retryDelayMs = 2500,
    timeoutMs = 300000,
    ...rest
  } = options;

  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await downloadFileWithProgress(url, outputPath, onProgress, {
        ...rest,
        timeoutMs,
      });
    } catch (error) {
      lastError = error;
      const message = String(error?.message || '');
      const retryable = /ECONNRESET|ETIMEDOUT|timed out|socket hang up|network error/i.test(message);
      if (!retryable || attempt >= retries) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
    }
  }

  throw lastError || new Error(`Download failed: ${url}`);
}

function fetchJson(url, options = {}, redirectDepth = 0) {
  const {
    headers: extraHeaders = {},
    timeoutMs = 30000,
  } = options;

  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    const headers = {
      'User-Agent': 'Mozilla/5.0',
      Accept: 'application/json',
      ...extraHeaders,
    };

    const timeout = setTimeout(() => {
      reject(new Error(`Request timed out: ${url}`));
    }, timeoutMs);

    const request = protocol.get(url, { headers }, (response) => {
      if (REDIRECT_STATUS_CODES.has(response.statusCode) && response.headers.location) {
        clearTimeout(timeout);
        if (redirectDepth >= MAX_REDIRECT_DEPTH) {
          reject(new Error(`Too many redirects while fetching ${url}`));
          return;
        }
        const redirectedUrl = resolveRedirectUrl(response.headers.location, url);
        if (!redirectedUrl) {
          reject(new Error(`Invalid redirect location for ${url}`));
          return;
        }
        fetchJson(redirectedUrl, options, redirectDepth + 1).then(resolve).catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        clearTimeout(timeout);
        reject(new Error(`HTTP ${response.statusCode} - ${response.statusMessage}`));
        return;
      }

      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        clearTimeout(timeout);
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(new Error(`Could not parse JSON from ${url}: ${error.message}`));
        }
      });
    });

    request.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function extractZipArchive(archivePath, destinationPath) {
  fs.mkdirSync(destinationPath, { recursive: true });

  if (process.platform === 'win32') {
    const command = `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${destinationPath.replace(/'/g, "''")}' -Force`;
    execSync(`powershell -NoProfile -Command "${command}"`, { stdio: 'ignore' });
    return;
  }

  execSync(`unzip -oq "${archivePath}" -d "${destinationPath}"`, { stdio: 'ignore' });
}

function getChromeForTestingDescriptor() {
  if (process.platform === 'darwin') {
    return {
      platformKey: process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64',
      archiveName: process.arch === 'arm64' ? 'chrome-mac-arm64.zip' : 'chrome-mac-x64.zip',
    };
  }

  if (process.platform === 'win32') {
    return {
      platformKey: 'win64',
      archiveName: 'chrome-win64.zip',
    };
  }

  if (process.platform === 'linux') {
    return {
      platformKey: 'linux64',
      archiveName: 'chrome-linux64.zip',
    };
  }

  return null;
}

async function resolveChromeDownloadInfo() {
  const descriptor = getChromeForTestingDescriptor();
  if (!descriptor) {
    throw new Error(`Automatic Chrome download is not supported on ${process.platform}.`);
  }

  const manifest = await fetchJson('https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json');
  const stableChannel = manifest?.channels?.Stable;
  const downloads = stableChannel?.downloads?.chrome || [];
  const selected = downloads.find((entry) => entry.platform === descriptor.platformKey);
  if (!selected?.url) {
    throw new Error(`Could not find a Chrome download for ${descriptor.platformKey}.`);
  }

  return {
    version: stableChannel?.version || '',
    platformKey: descriptor.platformKey,
    archiveName: descriptor.archiveName,
    url: selected.url,
  };
}

async function ensureChromeRuntimeAvailable(emitProgress = () => {}, options = {}) {
  const existing = findChromePath();
  if (existing && !options.forceDownload) {
    return {
      success: true,
      executablePath: existing,
      alreadyAvailable: true,
    };
  }

  const targetDir = runtimeResolver.getDownloadedChromeHome?.();
  if (!targetDir) {
    return {
      success: false,
      error: 'Could not resolve the GS Bot browser directory.',
    };
  }

  const tempDir = path.join(os.tmpdir(), `gsbot-chrome-${Date.now()}`);

  try {
    emitProgress({ phase: 'resolve', status: 'Resolving Chrome runtime download', progress: 5 });
    const downloadInfo = await resolveChromeDownloadInfo();
    ensureCleanDir(tempDir);
    ensureCleanDir(targetDir);

    const archivePath = path.join(tempDir, downloadInfo.archiveName);
    emitProgress({ phase: 'download', status: `Downloading Chrome ${downloadInfo.version || ''}`.trim(), progress: 10 });
    await downloadFileWithProgress(downloadInfo.url, archivePath, (percent) => {
      emitProgress({
        phase: 'download',
        status: `Downloading Chrome ${downloadInfo.version || ''}`.trim(),
        progress: 10 + Math.round((percent / 100) * 75),
      });
    });

    emitProgress({ phase: 'extract', status: 'Extracting Chrome runtime', progress: 88 });
    extractZipArchive(archivePath, targetDir);

    const executablePath = runtimeResolver.findChromeExecutable({ forceRefresh: true });
    if (!executablePath) {
      throw new Error('Chrome runtime was downloaded but the executable could not be found.');
    }

    emitProgress({ phase: 'complete', status: 'Chrome runtime is ready', progress: 100 });
    return {
      success: true,
      executablePath,
      version: downloadInfo.version,
      outputPath: targetDir,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function findFileRecursive(rootDir, matcher, depth = 6) {
  if (!rootDir || depth < 0 || !fs.existsSync(rootDir)) {
    return '';
  }

  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isFile() && matcher(entry.name, entryPath)) {
      return entryPath;
    }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const nested = findFileRecursive(path.join(rootDir, entry.name), matcher, depth - 1);
    if (nested) {
      return nested;
    }
  }

  return '';
}

function ensureCleanDir(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
  fs.mkdirSync(targetPath, { recursive: true });
}

function writePaddleVlRuntimeManifest(targetDir) {
  const manifestPath = path.join(targetDir, 'runtime-manifest.json');
  const payload = {
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
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(manifestPath, JSON.stringify(payload, null, 2));
}

function writeRmbgRuntimeManifest(targetDir, options = {}) {
  const manifestPath = path.join(targetDir, 'runtime-manifest.json');
  const payload = {
    type: 'rmbg-runtime',
    bundled: false,
    ready: true,
    provider: 'bria',
    model: 'RMBG-2.0',
    configFile: options.configFile || 'config.json',
    remoteCodeFile: options.remoteCodeFile || 'birefnet.py',
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(manifestPath, JSON.stringify(payload, null, 2));
}

async function importRmbgRuntime(selectedPath) {
  const targetDir = runtimeResolver.getDownloadedRmbgHome?.();
  if (!targetDir) {
    return { success: false, error: 'Could not resolve RMBG model directory.' };
  }

  const sourcePath = String(selectedPath || '').trim();
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    return { success: false, error: 'Selected RMBG model path does not exist.' };
  }

  const stats = fs.statSync(sourcePath);
  if (!stats.isDirectory()) {
    return { success: false, error: 'Please select the official RMBG 2.0 model folder.' };
  }

  const configPath = findFileRecursive(sourcePath, (name) => /^config\.json$/i.test(name), 6);
  const remoteCodePath = findFileRecursive(sourcePath, (name) => /^birefnet\.py$/i.test(name), 6);

  if (!configPath || !remoteCodePath) {
    return {
      success: false,
      error: 'Please select the official RMBG 2.0 model folder containing config.json and birefnet.py.',
    };
  }

  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.cpSync(sourcePath, targetDir, { recursive: true, dereference: true });

  const copiedConfigPath = path.join(targetDir, path.relative(sourcePath, configPath));
  const copiedRemoteCodePath = path.join(targetDir, path.relative(sourcePath, remoteCodePath));
  writeRmbgRuntimeManifest(targetDir, {
    configFile: path.relative(targetDir, copiedConfigPath),
    remoteCodeFile: path.relative(targetDir, copiedRemoteCodePath),
  });

  return {
    success: true,
    outputPath: targetDir,
    modelPath: targetDir,
  };
}

async function installPaddleOcrVlRuntime(emitProgress = () => {}) {
  if (process.platform !== 'win32') {
    return {
      success: false,
      error: 'Automatic PaddleOCR-VL runtime download is only supported on Windows.',
    };
  }

  const targetDir = runtimeResolver.getDownloadedPaddleVlHome?.();
  if (!targetDir) {
    return {
      success: false,
      error: 'Could not resolve the GS Bot OCR model directory.',
    };
  }

  const tempDir = path.join(os.tmpdir(), `gsbot-paddlevl-${Date.now()}`);
  const zipExtractDir = path.join(tempDir, 'llama');
  const modelUrl = 'https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6-GGUF/resolve/main/PaddleOCR-VL-1.6-GGUF.gguf?download=true';
  const mmprojUrl = 'https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6-GGUF/resolve/main/PaddleOCR-VL-1.6-GGUF-mmproj.gguf?download=true';
  const templateUrl = 'https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6-GGUF/resolve/main/chat_template.jinja?download=true';
  const llamaUrl = 'https://github.com/ggml-org/llama.cpp/releases/download/b8826/llama-b8826-bin-win-cpu-x64.zip';

  ensureCleanDir(tempDir);
  fs.mkdirSync(targetDir, { recursive: true });

  const steps = [
    {
      key: 'model',
      label: 'Downloading PaddleOCR-VL model',
      url: modelUrl,
      outputPath: path.join(targetDir, 'PaddleOCR-VL-1.5.gguf'),
      start: 0,
      span: 42,
    },
    {
      key: 'mmproj',
      label: 'Downloading PaddleOCR-VL mmproj',
      url: mmprojUrl,
      outputPath: path.join(targetDir, 'PaddleOCR-VL-1.5-mmproj.gguf'),
      start: 42,
      span: 40,
    },
    {
      key: 'template',
      label: 'Downloading chat template',
      url: templateUrl,
      outputPath: path.join(targetDir, 'chat_template.jinja'),
      start: 82,
      span: 3,
    },
    {
      key: 'llama',
      label: 'Downloading llama.cpp runtime',
      url: llamaUrl,
      outputPath: path.join(tempDir, 'llama-b8826-bin-win-cpu-x64.zip'),
      start: 85,
      span: 10,
    },
  ];

  try {
    for (const step of steps) {
      emitProgress({
        phase: step.key,
        status: step.label,
        progress: step.start,
      });
      await downloadFileWithRetry(step.url, step.outputPath, (percent) => {
        emitProgress({
          phase: step.key,
          status: step.label,
          progress: Math.min(100, step.start + Math.round((percent / 100) * step.span)),
        });
      }, {
        timeoutMs: step.key === 'model' || step.key === 'mmproj' ? 30 * 60 * 1000 : 10 * 60 * 1000,
        retries: step.key === 'model' || step.key === 'mmproj' ? 4 : 2,
        retryDelayMs: 4000,
      });
    }

    emitProgress({
      phase: 'extract',
      status: 'Extracting llama.cpp runtime',
      progress: 96,
    });
    extractZipArchive(path.join(tempDir, 'llama-b8826-bin-win-cpu-x64.zip'), zipExtractDir);
    const llamaServerPath = findFileRecursive(zipExtractDir, (name) => /^llama-server\.exe$/i.test(name), 8);
    if (!llamaServerPath) {
      throw new Error('llama-server.exe was not found in the downloaded llama.cpp runtime.');
    }

    fs.copyFileSync(llamaServerPath, path.join(targetDir, 'llama-server.exe'));
    writePaddleVlRuntimeManifest(targetDir);

    emitProgress({
      phase: 'complete',
      status: 'PaddleOCR-VL runtime is ready',
      progress: 100,
    });

    return {
      success: true,
      outputPath: targetDir,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
    };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function parallelLimit(tasks, limit) {
  const results = [];
  const executing = new Set();
  for (const task of tasks) {
    const p = task().then(r => { executing.delete(p); return r; });
    executing.add(p); results.push(p);
    if (executing.size >= limit) await Promise.race(executing);
  }
  return Promise.all(results);
}

function sanitizeFileSegment(value, fallback = 'item') {
  const sanitized = String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return sanitized || fallback;
}

function createScraperPreviewBridge(sendPreview = () => {}) {
  let activePage = null;
  let captureTimer = null;
  let captureInFlight = false;
  let closed = false;
  let paused = false;
  const pageListeners = new WeakMap();

  const emit = (payload = {}) => {
    if (closed) {
      return;
    }
    sendPreview({
      timestamp: Date.now(),
      ...payload,
    });
  };

  const clearCaptureTimer = () => {
    if (captureTimer) {
      clearInterval(captureTimer);
      captureTimer = null;
    }
  };

  const captureFrame = async () => {
    if (closed || paused || captureInFlight || !activePage || activePage.isClosed()) {
      return;
    }

    captureInFlight = true;
    try {
      const currentUrl = (() => {
        try {
          return String(activePage.url() || '');
        } catch {
          return '';
        }
      })();
      const [screenshotBase64, resolvedUrl, title] = await Promise.all([
        activePage.screenshot({
          type: 'jpeg',
          quality: 55,
          encoding: 'base64',
          optimizeForSpeed: true,
        }),
        Promise.resolve(currentUrl),
        activePage.title().catch(() => ''),
      ]);

      emit({
        active: true,
        imageDataUrl: screenshotBase64 ? `data:image/jpeg;base64,${screenshotBase64}` : '',
        url: String(resolvedUrl || ''),
        title: String(title || ''),
      });
    } catch {
      // Ignore transient screenshot failures while the page is navigating.
    } finally {
      captureInFlight = false;
    }
  };

  const ensureCaptureLoop = () => {
    clearCaptureTimer();
    captureTimer = setInterval(() => {
      captureFrame().catch(() => {});
    }, 1200);
    captureFrame().catch(() => {});
  };

  const detachPageListeners = (page) => {
    if (!page) {
      return;
    }
    const listeners = pageListeners.get(page);
    if (!listeners) {
      return;
    }
    page.off('close', listeners.handleClose);
    page.off('framenavigated', listeners.handleFrameNavigated);
    page.off('load', listeners.handleLoad);
    pageListeners.delete(page);
  };

  return {
    attachToBrowser(browser) {
      if (!browser || typeof browser.newPage !== 'function') {
        return;
      }

      const originalNewPage = browser.newPage.bind(browser);
      browser.newPage = async (...args) => {
        const page = await originalNewPage(...args);
        this.registerPage(page);
        return page;
      };

      browser.pages().then((pages = []) => {
        const candidate = pages.find((page) => !page.isClosed?.()) || null;
        if (candidate) {
          this.registerPage(candidate);
        }
      }).catch(() => {});
    },
    registerPage(page) {
      if (!page || closed) {
        return;
      }

      if (activePage && activePage !== page) {
        detachPageListeners(activePage);
      }

      activePage = page;

      const handleFrameNavigated = () => captureFrame().catch(() => {});
      const handleLoad = () => captureFrame().catch(() => {});
      const handleClose = () => {
        if (activePage === page) {
          activePage = null;
          emit({
            active: false,
            imageDataUrl: '',
            url: '',
            title: '',
          });
        }
      };

      pageListeners.set(page, { handleClose, handleFrameNavigated, handleLoad });
      page.on('framenavigated', handleFrameNavigated);
      page.on('load', handleLoad);
      page.on('close', handleClose);

      ensureCaptureLoop();
    },
    pause(message = '') {
      paused = true;
      clearCaptureTimer();
      emit({
        active: false,
        imageDataUrl: '',
        url: '',
        title: '',
        message,
      });
    },
    resume() {
      if (closed) {
        return;
      }
      paused = false;
      if (activePage && !activePage.isClosed()) {
        ensureCaptureLoop();
      }
    },
    sendIdle(message = '') {
      emit({
        active: false,
        imageDataUrl: '',
        url: '',
        title: '',
        message,
      });
    },
    close() {
      closed = true;
      clearCaptureTimer();
      detachPageListeners(activePage);
      activePage = null;
      sendPreview({
        timestamp: Date.now(),
        active: false,
        imageDataUrl: '',
        url: '',
        title: '',
      });
    },
  };
}

const BERSHKA_ENTRY_URLS = [
  'https://www.bershka.com/es/en/h-man.html',
  'https://www.bershka.com/es/en/h-woman.html',
];
const BERSHKA_STORE_ID = '45009578';
const BERSHKA_CATALOG_ID = '40259549';
const BERSHKA_LANGUAGE_ID = '-15';
const BERSHKA_LOCALE = 'en_GB';

const STRADIVARIUS_ENTRY_URL = 'https://www.stradivarius.com/us/';
const STRADIVARIUS_HOME_URL = 'https://www.stradivarius.com/us/';
const STRADIVARIUS_STORE_ID = '54009627';
const STRADIVARIUS_CATALOG_ID = '50331121';
const STRADIVARIUS_CATEGORY_TREE_URL = `https://www.stradivarius.com/itxrest/2/catalog/store/${STRADIVARIUS_STORE_ID}/${STRADIVARIUS_CATALOG_ID}/category?languageId=-1&appId=1`;
const STRADIVARIUS_DIRECT_QUERY_URLS = (q) => [
  `https://www.stradivarius.com/es/en/?s_layer=results&s_query=${encodeURIComponent(q)}&s_origin=m`,
  `https://www.stradivarius.com/us/?s_layer=results&s_query=${encodeURIComponent(q)}&s_origin=m`,
];
const buildStradivariusManualSearchUrl = (q) =>
  `https://www.stradivarius.com/es/en/?s_layer=results&s_query=${encodeURIComponent(String(q || '').trim())}&s_origin=m`;

const PULLANDBEAR_ENTRY_URL = 'https://www.pullandbear.com/us/';
const PULLANDBEAR_STORE_ID = '24009477';
const PULLANDBEAR_CATALOG_ID = '20309455';
const PULLANDBEAR_LANGUAGE_ID = '-15';
const PULLANDBEAR_LOCALE = 'en_US';
const PULLANDBEAR_CATEGORY_TREE_URL = `https://www.pullandbear.com/itxrest/2/catalog/store/${PULLANDBEAR_STORE_ID}/${PULLANDBEAR_CATALOG_ID}/category?languageId=${PULLANDBEAR_LANGUAGE_ID}&typeCatalog=1&appId=1`;

let cachedStradivariusLeafIds = null;
const cachedStradivariusStyleMatches = new Map();
let cachedPullAndBearLeafIds = null;
const cachedPullAndBearStyleMatches = new Map();
let cachedBershkaLeafIds = null;
const cachedBershkaStyleMatches = new Map();
const scannedBershkaLeafIds = new Set();

function getBershkaSessionDir() {
  return path.join(app.getPath('userData'), 'bershka-browser-session');
}

function getStradivariusSessionDir() {
  return path.join(app.getPath('userData'), 'stradivarius-browser-session');
}

function getPullAndBearSessionDir() {
  return path.join(app.getPath('userData'), 'pullandbear-browser-session');
}

function getUniqloSessionDir() {
  return path.join(app.getPath('userData'), 'uniqlo-browser-session');
}

function getGuSessionDir() {
  return path.join(app.getPath('userData'), 'gu-browser-session');
}

function getLeftiesSessionDir() {
  return path.join(app.getPath('userData'), 'lefties-browser-session');
}

function getMangoSessionDir() {
  return path.join(app.getPath('userData'), 'mango-browser-session');
}

function getReservedSessionDir() {
  return path.join(app.getPath('userData'), 'reserved-browser-session');
}

function getSinsaySessionDir() {
  return path.join(app.getPath('userData'), 'sinsay-browser-session');
}

function getUrbanRevivoSessionDir() {
  return path.join(app.getPath('userData'), 'urbanrevivo-browser-session');
}

function getHmSessionDir() {
  return path.join(app.getPath('userData'), 'hm-browser-session');
}

function getAbercrombieSessionDir() {
  return path.join(app.getPath('userData'), 'aberchrombie-browser-session');
}

// Locate the user's real system Chrome user-data dir (NOT the profile subfolder).
function findSystemChromeUserDataDir() {
  const home = os.homedir();
  const candidates = process.platform === 'darwin'
    ? [path.join(home, 'Library', 'Application Support', 'Google', 'Chrome')]
    : process.platform === 'win32'
      ? [path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data')]
      : [path.join(home, '.config', 'google-chrome'), path.join(home, '.config', 'chromium')];
  for (const c of candidates) {
    try { if (c && fs.existsSync(path.join(c, 'Default'))) return c; } catch { /* noop */ }
  }
  return null;
}

// Clone the essential auth/fingerprint files from the user's real Chrome
// "Default" profile into the H&M scraper session dir, so the scraper browser
// carries a trusted identity (cookies + device fingerprint) that H&M's Akamai
// guard recognises as a normal user. We copy only the small state files — not
// the whole multi-GB profile — and only once (idempotent). The user chose this
// approach knowing it copies their login state.
function prepareHmChromeProfile(emitLog = () => {}) {
  const sessionDir = getHmSessionDir();
  const marker = path.join(sessionDir, '.gsbot-chrome-cloned');
  if (fs.existsSync(marker)) return true; // already cloned once

  const srcRoot = findSystemChromeUserDataDir();
  if (!srcRoot) {
    emitLog('    ⚠️ System Chrome profile not found — using a clean session (H&M detail may be blocked).', 'warning');
    return false;
  }

  try {
    const srcDefault = path.join(srcRoot, 'Default');
    const dstDefault = path.join(sessionDir, 'Default');
    fs.mkdirSync(dstDefault, { recursive: true });

    // Root-level state (device fingerprint / decryption key lives here).
    for (const f of ['Local State']) {
      const s = path.join(srcRoot, f);
      if (fs.existsSync(s)) fs.copyFileSync(s, path.join(sessionDir, f));
    }
    // Per-profile auth + fingerprint files.
    for (const f of ['Cookies', 'Cookies-journal', 'Preferences', 'Secure Preferences', 'Network Persistent State', 'Trust Tokens']) {
      const s = path.join(srcDefault, f);
      try { if (fs.existsSync(s)) fs.copyFileSync(s, path.join(dstDefault, f)); } catch { /* skip locked file */ }
    }
    // The Network/ subfolder holds the modern Cookies store on recent Chrome.
    const srcNet = path.join(srcDefault, 'Network');
    if (fs.existsSync(srcNet)) {
      const dstNet = path.join(dstDefault, 'Network');
      fs.mkdirSync(dstNet, { recursive: true });
      for (const f of ['Cookies', 'Cookies-journal', 'Network Persistent State', 'Trust Tokens', 'TransportSecurity']) {
        const s = path.join(srcNet, f);
        try { if (fs.existsSync(s)) fs.copyFileSync(s, path.join(dstNet, f)); } catch { /* skip */ }
      }
    }
    fs.writeFileSync(marker, new Date().toISOString());
    emitLog('    🔐 Cloned system Chrome identity into the H&M scraper session.', 'info');
    return true;
  } catch (error) {
    emitLog(`    ⚠️ Could not clone Chrome profile (${error.message}); using a clean session.`, 'warning');
    return false;
  }
}

function normalizeScraperBrand(value = '') {
  const raw = String(value || '').replace(/\u00a0/g, ' ').trim().toLowerCase();
  if (!raw) {
    return '';
  }

  if (raw === 'mixed' || raw === 'mix' || raw === 'multi' || raw === 'mixed brands') return 'mixed';
  if (raw === 'zara') return 'zara';
  if (raw === 'bershka') return 'bershka';
  if (raw === 'stradivarius') return 'stradivarius';
  if (raw === 'pullandbear' || raw === 'pull&bear' || raw === 'pull & bear' || raw === 'pull and bear' || raw === 'pull bear') return 'pullandbear';
  if (raw === 'uniqlo' || raw === 'un iqlo') return 'uniqlo';
  if (raw === 'gu') return 'gu';
  if (raw === 'lefties') return 'lefties';
  if (raw === 'mango' || raw === 'mng') return 'mango';
  if (raw === 'reserved' || raw === 'rsv') return 'reserved';
  if (raw === 'sinsay' || raw === 'sin') return 'sinsay';
  if (raw === 'urbanrevivo' || raw === 'urban revivo' || raw === 'ur' || raw === 'urevivo') return 'urbanrevivo';
  if (raw === 'newyorker' || raw === 'new yorker' || raw === 'ny' || raw === 'nyk') return 'newyorker';
  if (raw === 'hm' || raw === 'h&m' || raw === 'h & m' || raw === 'h and m' || raw === 'handm') return 'hm';
  if (raw === 'abercrombie' || raw === 'a&f' || raw === 'anf' || raw === 'abercrombie & fitch' || raw === 'aberchrombie') return 'abercrombie';
  return '';
}

function getScraperOutputFolderName(brand = '') {
  const normalizedBrand = normalizeScraperBrand(brand);
  if (normalizedBrand === 'bershka') return 'Bershka';
  if (normalizedBrand === 'stradivarius') return 'Stradivarius';
  if (normalizedBrand === 'pullandbear') return 'Pull&Bear';
  if (normalizedBrand === 'uniqlo') return 'UNIQLO';
  if (normalizedBrand === 'gu') return 'GU';
  if (normalizedBrand === 'lefties') return 'Lefties';
  if (normalizedBrand === 'mango') return 'Mango';
  if (normalizedBrand === 'reserved') return 'Reserved';
  if (normalizedBrand === 'sinsay') return 'Sinsay';
  if (normalizedBrand === 'urbanrevivo') return 'Urban Revivo';
  if (normalizedBrand === 'newyorker') return 'New Yorker';
  if (normalizedBrand === 'hm') return 'H&M';
  if (normalizedBrand === 'abercrombie') return 'Abercrombie';
  if (normalizedBrand === 'mixed') return 'Mixed Brands';
  return 'Zara';
}

function loadMixedBrandExcelQueue(excelPath, emitLog = () => {}) {
  const workbook = XLSX.readFile(excelPath);
  const worksheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
  const entries = [];

  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex] || [];
    const rawBrand = String(row[0] ?? '').replace(/\u00a0/g, ' ').trim();
    const rawStyle = String(row[1] ?? '').replace(/\u00a0/g, ' ').trim();
    if (!rawBrand && !rawStyle) {
      continue;
    }

    const normalizedBrand = normalizeScraperBrand(rawBrand);
    if (!normalizedBrand) {
      emitLog(`⚠️ Unsupported brand in Excel row ${rowIndex + 1}: "${rawBrand}"`, 'warning');
      continue;
    }

    if (!rawStyle) {
      emitLog(`⚠️ Missing style number in Excel row ${rowIndex + 1} for brand "${rawBrand}"`, 'warning');
      continue;
    }

    entries.push({
      rowNumber: rowIndex + 1,
      brand: normalizedBrand,
      rawBrand,
      styleNumber: rawStyle,
    });
    emitLog(`📥 Excel row ${rowIndex + 1}: ${rawBrand} -> ${rawStyle}`, 'info');
  }

  return entries;
}

const UNIQLO_BASE_URL = 'https://www.uniqlo.com/us/en/';
const GU_BASE_URL = 'https://www.gu-global.com/us/en/';

function normalizeUniqloReference(value = '') {
  const raw = String(value || '').replace(/\u00a0/g, ' ').trim();
  if (!raw) {
    return null;
  }

  if (/^https?:\/\//i.test(raw)) {
    return {
      input: raw,
      url: raw,
      sku: raw.match(/\b\d{6}\b/)?.[0] || '',
    };
  }

  const sku = raw.match(/\b\d{6}\b/)?.[0] || raw.replace(/[^\d]/g, '');
  return {
    input: raw,
    url: '',
    sku,
  };
}

function normalizeSixDigitReference(value = '', brandLabel = 'Product') {
  const raw = String(value || '').replace(/\u00a0/g, ' ').trim();
  if (!raw) {
    return null;
  }
  if (/^https?:\/\//i.test(raw)) {
    return {
      input: raw,
      url: raw,
      sku: raw.match(/\b\d{6}\b/)?.[0] || '',
    };
  }
  const sku = raw.match(/\b\d{6}\b/)?.[0] || raw.replace(/[^\d]/g, '');
  if (!/^\d{6}$/.test(sku)) {
    throw new Error(`${brandLabel} ID could not be detected from input: ${raw}`);
  }
  return {
    input: raw,
    url: '',
    sku,
  };
}

function normalizeUniqloProductUrl(url = '') {
  const value = String(url || '').trim();
  if (!value) {
    return '';
  }
  const match = value.match(/^https?:\/\/www\.uniqlo\.com\/us\/en\/products\/E(\d{6})(?:[^?#]*)?/i);
  if (!match) {
    return '';
  }
  return value.split('#')[0].split('?')[0];
}

function buildUniqloProductCandidates(sku = '') {
  const cleanSku = String(sku || '').replace(/[^\d]/g, '');
  if (!/^\d{6}$/.test(cleanSku)) {
    return [];
  }

  return [
    `https://www.uniqlo.com/us/en/products/E${cleanSku}-000/00`,
    `https://www.uniqlo.com/us/en/products/E${cleanSku}`,
    `https://www.uniqlo.com/us/en/products/${cleanSku}`,
  ];
}

function isLikelyUniqloProductImage(url = '') {
  const value = cleanImageUrl(url).toLowerCase();
  if (!value) {
    return false;
  }

  if (/\.(m3u8|mp4|webm|mov|ts)(\?|$)/i.test(value)) {
    return false;
  }

  if (
    value.includes('logo')
    || value.includes('icon')
    || value.includes('sprite')
    || value.includes('swatch')
    || value.includes('chip')
    || value.includes('thumbnail')
    || value.includes('feature')
    || value.includes('banner')
    || value.endsWith('.svg')
  ) {
    return false;
  }

  return value.includes('uniqlo')
    && /\.(jpg|jpeg|png|webp)(\?|$)/i.test(value);
}

function extractUniqloCompositionText(text = '') {
  const value = String(text || '').replace(/\u00a0/g, ' ');
  if (!value.trim()) {
    return '';
  }

  const materialWord = '(?:cotton|polyester|spandex|elastane|viscose|rayon|nylon|linen|wool|acrylic|modal|denim|leather|polyamide|lyocell|tencel|hemp|silk|cashmere)';
  // Pattern A: "100% Cotton" or "80% Polyester, 20% Cotton" (percentage before material)
  const pctBeforePattern = new RegExp(`\\b\\d{1,3}%\\s*${materialWord}(?:\\s*[,/|&+-]\\s*\\d{1,3}%\\s*${materialWord})*`, 'ig');
  // Pattern B: "Cotton 100%" or "Polyester 80%, Cotton 20%" (material before percentage)
  const pctAfterPattern = new RegExp(`\\b${materialWord}\\s*\\d{1,3}%(?:\\s*[,/|&+-]\\s*${materialWord}\\s*\\d{1,3}%)*`, 'ig');
  // Pattern C: "Shell: 100% Cotton" — include the component label prefix
  const componentPattern = new RegExp(`(?:shell|body|lining|outer|main|back|contrast|trim|sleeve|waistband|rib|pocket)\\s*:?\\s*(\\d{1,3}%\\s*${materialWord}(?:\\s*[,/|&+-]\\s*\\d{1,3}%\\s*${materialWord})*)`, 'ig');

  const pctBeforeMatches = value.match(pctBeforePattern) || [];
  const pctAfterMatches = value.match(pctAfterPattern) || [];
  const componentMatches = [...value.matchAll(componentPattern)].map((m) => m[1]) || [];

  const allMatches = [...pctBeforeMatches, ...pctAfterMatches, ...componentMatches]
    .map((item) => item.trim())
    .filter(Boolean);

  if (allMatches.length > 0) {
    return [...new Set(allMatches)].join(' | ');
  }

  const lines = value
    .split('\n')
    .map((line) => line.replace(/\r/g, '').replace(/^\s*[-*•]+\s*/, '').trim())
    .filter(Boolean)
    .filter((line) => line.length <= 140)
    .filter((line) => !/^(fabric details?|materials?|materials?\s*(?:and|&)\s*care|care|washing|imported|country of origin|product id)$/i.test(line))
    .filter((line) => !/machine wash|do not|use detergent|wash separately|dry clean|line dry|tumble dry|iron on/i.test(line))
    .filter((line) => new RegExp(`(?:\\d{1,3}%\\s*${materialWord}|\\b${materialWord}\\b\\s*\\d{1,3}%)`, 'i').test(line));

  return [...new Set(lines)].join(' | ');
}

function stripUniqloStructuredSections(text = '') {
  return String(text || '')
    .replace(/\b(?:materials?\s*(?:and|&)\s*care|materials?|care instructions?|fabric details?|function details?|size\s*&\s*fit)\b[\s\S]*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractUniqloSection(text = '', headings = [], stopHeadings = []) {
  const value = String(text || '').replace(/\u00a0/g, ' ');
  if (!value.trim()) {
    return '';
  }

  const lines = value
    .split('\n')
    .map((line) => line.replace(/\r/g, '').trim())
    .filter(Boolean);

  // Match heading lines: the heading text must appear in the line AND the
  // line must be short (≤ 60 chars) — this distinguishes "Materials and Care"
  // (a heading) from "This product uses materials that are..." (body text).
  const headingRegexes = headings.map((heading) => {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return { re: new RegExp(escaped, 'i'), maxLen: 60 };
  });
  const stopRegexes = stopHeadings.map((heading) => {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return { re: new RegExp(escaped, 'i'), maxLen: 60 };
  });
  const startIndex = lines.findIndex((line) =>
    headingRegexes.some(({ re, maxLen }) => line.length <= maxLen && re.test(line)),
  );
  if (startIndex === -1) {
    return '';
  }

  const collected = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (stopRegexes.some(({ re, maxLen }) => line.length <= maxLen && re.test(line))) {
      break;
    }
    collected.push(line);
  }

  return collected.join('\n').trim();
}

function extractUniqloProductIdFromText(text = '') {
  const value = String(text || '');
  return value.match(/\b(?:product id|item number|item no\.?)[:#\s-]*([0-9]{6})\b/i)?.[1] || '';
}

function extractUniqloProductIdFromScripts(scripts = []) {
  for (const script of scripts || []) {
    const value = String(script || '');
    const directMatch = value.match(/"(?:productId|itemNumber|itemNo|code|productCode)"\s*:\s*"?(E?)(\d{6})"?/i);
    if (directMatch?.[2]) {
      return directMatch[2];
    }
  }
  return '';
}

function extractUniqloImageUrlCandidates(chunks = []) {
  const matches = [];
  const regex = /https?:\/\/[^"'\\\s>]+(?:\.jpg|\.jpeg|\.png|\.webp)(?:\?[^"'\\\s>]*)?/ig;
  for (const chunk of chunks || []) {
    const value = String(chunk || '');
    const found = value.match(regex) || [];
    matches.push(...found);
  }
  return [...new Set(matches.map(cleanImageUrl).filter(Boolean))];
}

/**
 * Classify Uniqlo image URLs into named buckets.
 *
 * Flat-lay images follow naming patterns in the CDN path:
 *   - Front flat:  …_main.jpg | …_item_01.jpg | …_item01.jpg | …_GOODS_1_…
 *   - Back flat:   …_back.jpg | …_item_02.jpg | …_item02.jpg | …_GOODS_2_…
 *   - Model shots: …_sub1.jpg | …_sub01.jpg | …_SUB_… (numbered from 01)
 *
 * Assignment strategy
 * 1. Scan every URL for "back" / "item02" / "GOODS_2" → assign _B slot.
 * 2. Scan every URL for "main" / "item01" / "GOODS_1" → assign _F slot.
 * 3. Any URL whose path segment contains "sub" or is already not assigned
 *    goes into numbered model slots (01, 02, …).
 * 4. If no explicit _F / _B were found, fall back to positional: first → _F,
 *    second → _B, rest → 01 02 …
 */
function buildUniqloImageMap(imageUrls = []) {
  const uniqueUrls = [...new Set((imageUrls || []).filter(Boolean))];
  if (uniqueUrls.length === 0) {
    return {};
  }

  // Helper: get the last path segment (filename without query) lowercased.
  const filename = (url) => {
    try {
      const u = new URL(url);
      return u.pathname.split('/').pop().toLowerCase().replace(/\?.*$/, '');
    } catch {
      return url.toLowerCase().replace(/\?.*$/, '').split('/').pop();
    }
  };

  const isFrontFlat = (url) => {
    const f = filename(url);
    const raw = url.toLowerCase();
    return (
      /[_-]main(\.|_)/.test(f)
      || /_item[_-]?01(\.|_)/.test(f)
      || /[_-]goods[_-]1[_-]/i.test(raw)
      || /\/item\/(?:us)?goods_\d+_\d+_3x4\.(jpg|jpeg|png|webp)$/i.test(raw)
      || /[_-]01[_-]?(main|front|f)?\.(jpg|jpeg|png|webp)$/i.test(f)
    );
  };

  const isBackFlat = (url) => {
    const f = filename(url);
    const raw = url.toLowerCase();
    return (
      /[_-]back(\.|_)/.test(f)
      || /_item[_-]?02(\.|_)/.test(f)
      || /[_-]goods[_-]2[_-]/i.test(raw)
      || /[_-]02[_-]?(back|b)?\.(jpg|jpeg|png|webp)$/i.test(f)
    );
  };

  const classified = {};
  const assigned = new Set();
  const sortModelShots = (urls) => urls.sort((left, right) => {
    const getSubIndex = (url) => Number.parseInt(filename(url).match(/_sub(\d+)/i)?.[1] || '999', 10);
    const leftSub = getSubIndex(left);
    const rightSub = getSubIndex(right);
    if (leftSub !== rightSub) {
      return leftSub - rightSub;
    }
    return uniqueUrls.indexOf(left) - uniqueUrls.indexOf(right);
  });

  // Pass 1 – explicit back flat
  for (const url of uniqueUrls) {
    if (!classified.B && isBackFlat(url)) {
      classified.B = url;
      assigned.add(url);
    }
  }

  // Pass 2 – explicit front flat
  for (const url of uniqueUrls) {
    if (!classified.F && isFrontFlat(url) && !assigned.has(url)) {
      classified.F = url;
      assigned.add(url);
    }
  }

  // Pass 3 – remaining → numbered model shots (01, 02, …)
  let nextNumber = 1;
  for (const url of sortModelShots(uniqueUrls.filter((item) => !assigned.has(item)))) {
    if (!assigned.has(url)) {
      classified[String(nextNumber).padStart(2, '0')] = url;
      assigned.add(url);
      nextNumber += 1;
    }
  }

  // Fallback: if no explicit _F was identified, promote the first numbered
  // slot to _F (and if no _B either, promote the second to _B).
  if (!classified.F) {
    const nums = Object.keys(classified).filter((k) => /^\d+$/.test(k)).sort();
    if (nums[0]) {
      classified.F = classified[nums[0]];
      delete classified[nums[0]];
    }
    if (!classified.B && nums[1]) {
      classified.B = classified[nums[1]];
      delete classified[nums[1]];
    }
  }

  return classified;
}

function extractUniqloImageProductId(url = '') {
  const value = cleanImageUrl(url);
  return value.match(/\/imagesgoods\/(\d+)\/(?:item|sub)\//i)?.[1] || '';
}

function extractUniqloColorCodesFromImages(imageUrls = [], productId = '') {
  const codes = new Set();
  const escapedProductId = String(productId || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escapedProductId) {
    return [];
  }

  (imageUrls || []).forEach((url) => {
    const value = cleanImageUrl(url);
    const match = value.match(new RegExp(`/(?:us)?goods_(\\d{2})_${escapedProductId}(?:_|\\.)`, 'i'));
    if (match?.[1]) {
      codes.add(match[1]);
    }
  });

  return [...codes];
}

function buildUniqloCdnImageCandidates(productId = '', colorCodes = []) {
  const cleanProductId = String(productId || '').replace(/[^\d]/g, '');
  if (!/^\d{6}$/.test(cleanProductId)) {
    return [];
  }

  const candidates = new Set();
  const normalizedColorCodes = [...new Set((colorCodes || []).map((code) => String(code || '').replace(/[^\d]/g, '').padStart(2, '0').slice(-2)).filter(Boolean))];

  normalizedColorCodes.forEach((colorCode) => {
    candidates.add(`https://image.uniqlo.com/UQ/ST3/us/imagesgoods/${cleanProductId}/item/usgoods_${colorCode}_${cleanProductId}_3x4.jpg`);
    candidates.add(`https://image.uniqlo.com/UQ/ST3/WesternCommon/imagesgoods/${cleanProductId}/item/goods_${colorCode}_${cleanProductId}_3x4.jpg`);
  });

  for (let index = 1; index <= 24; index += 1) {
    candidates.add(`https://image.uniqlo.com/UQ/ST3/WesternCommon/imagesgoods/${cleanProductId}/sub/goods_${cleanProductId}_sub${index}_3x4.jpg`);
    candidates.add(`https://image.uniqlo.com/UQ/ST3/us/imagesgoods/${cleanProductId}/sub/usgoods_${cleanProductId}_sub${index}_3x4.jpg`);
  }

  return [...candidates];
}

async function findExistingUniqloCdnImages(productId = '', seedImageUrls = [], emitLog = () => {}) {
  const colorCodes = extractUniqloColorCodesFromImages(seedImageUrls, productId);
  const candidates = buildUniqloCdnImageCandidates(productId, colorCodes);
  const found = [];
  const concurrency = 6;

  for (let index = 0; index < candidates.length; index += concurrency) {
    const batch = candidates.slice(index, index + concurrency);
    const results = await Promise.all(batch.map(async (url) => ({
      url,
      exists: await checkRemoteFileExists(url, {
        headers: {
          Referer: UNIQLO_BASE_URL,
        },
        timeoutMs: 6000,
      }),
    })));
    results.filter((result) => result.exists).forEach((result) => found.push(result.url));
  }

  if (found.length > 0) {
    emitLog(`    🖼️ UNIQLO CDN probe found ${found.length} existing image(s) for ${productId}.`, 'info');
  }

  return found;
}

function filterUniqloProductImages(imageUrls = [], preferredIds = []) {
  const uniqueUrls = [...new Set((imageUrls || []).filter(Boolean))];
  if (uniqueUrls.length === 0) {
    return [];
  }

  const grouped = new Map();
  uniqueUrls.forEach((url) => {
    const productId = extractUniqloImageProductId(url);
    const key = productId || '__unknown__';
    const bucket = grouped.get(key) || [];
    bucket.push(url);
    grouped.set(key, bucket);
  });

  const normalizedPreferredIds = preferredIds
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  for (const preferredId of normalizedPreferredIds) {
    if (grouped.has(preferredId)) {
      return grouped.get(preferredId) || [];
    }
  }

  const bestGroup = [...grouped.entries()]
    .filter(([key]) => key !== '__unknown__')
    .sort((left, right) => {
      if (left[1].length !== right[1].length) {
        return right[1].length - left[1].length;
      }
      return left[0].localeCompare(right[0]);
    })[0];

  if (bestGroup) {
    return bestGroup[1];
  }

  return uniqueUrls;
}

async function extractUniqloSearchResultUrls(page, sku = '') {
  const data = await page.evaluate(() => {
    const anchors = [...document.querySelectorAll('a[href]')]
      .map((anchor) => ({
        url: anchor.href,
        text: String(anchor.textContent || '').trim(),
      }))
      .filter((entry) => entry.url);

    const html = document.documentElement?.outerHTML || '';

    return {
      pageUrl: window.location.href,
      pageTitle: document.title || '',
      bodyText: String(document.body?.innerText || '').slice(0, 5000),
      anchors,
      html,
    };
  });

  const htmlUrls = [...new Set((data.html.match(/https?:\/\/www\.uniqlo\.com\/us\/en\/products\/E\d{6}[^"'\\\s<]*/ig) || []))]
    .map((url) => ({ url: normalizeUniqloProductUrl(url), text: '' }))
    .filter((entry) => entry.url);
  const urls = [...new Map([...anchorsToCandidates(data.anchors, sku), ...htmlUrls].map((entry) => [entry.url, entry])).values()];
  return {
    ...data,
    urls,
    likelyNoResults: /0 results|no results|we couldn't find|no matching/i.test(data.bodyText || ''),
  };
}

function anchorsToCandidates(anchors = [], sku = '') {
  return anchors
    .map((entry) => ({
      url: normalizeUniqloProductUrl(entry.url),
      text: entry.text,
    }))
    .filter((entry) => entry.url)
    .sort((left, right) => {
      const leftExact = sku && (left.url.includes(`E${sku}`) || left.text.includes(sku)) ? 1 : 0;
      const rightExact = sku && (right.url.includes(`E${sku}`) || right.text.includes(sku)) ? 1 : 0;
      if (leftExact !== rightExact) {
        return rightExact - leftExact;
      }
      return left.url.length - right.url.length;
    });
}

async function isUniqloProductPage(page, sku = '') {
  try {
    return await page.evaluate((expectedSku) => {
      const currentUrl = window.location.href;
      const bodyText = String(document.body?.innerText || '');
      const title = String(document.title || '');
      const productId =
        bodyText.match(/\b(?:Product ID|Item Number|Item No\.?)[:#\s-]*([0-9]{6})\b/i)?.[1]
        || currentUrl.match(/\/products\/E(\d{6})/i)?.[1]
        || '';
      return /^https?:\/\/www\.uniqlo\.com\/us\/en\/products\/E\d{6}/i.test(currentUrl)
        && /Details|Function Details|Fabric Details|Materials|Care|Product ID/i.test(bodyText + title)
        && (!expectedSku || productId === expectedSku);
    }, sku);
  } catch {
    return false;
  }
}

async function waitForUniqloProductReady(page, sku = '', ensureActive = () => {}, emitLog = () => {}, options = {}) {
  const {
    attempts = 3,
    settleMs = 1400,
    allowAlternateProductId = false,
  } = options;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    ensureActive();
    await antiDetection.randomDelay(settleMs, settleMs + 600);
    const ready = await page.evaluate((expectedSku, allowAlternate) => {
      const bodyText = String(document.body?.innerText || '');
      const currentUrl = window.location.href;
      const productId =
        bodyText.match(/\b(?:Product ID|Item Number|Item No\.?)[:#\s-]*([0-9]{6})\b/i)?.[1]
        || currentUrl.match(/\/products\/E(\d{6})/i)?.[1]
        || '';
      const imageCount = [...document.querySelectorAll('img, source')]
        .flatMap((node) => [
          node.currentSrc || '',
          node.src || '',
          node.getAttribute?.('srcset') || '',
          node.getAttribute?.('data-srcset') || '',
        ])
        .filter((value) => /image\.uniqlo\.com|uniqlo.*imagesgoods/i.test(String(value || '')))
        .length;
      const hasProductText = /Details|Function Details|Fabric Details|Materials|Care|Product ID/i.test(bodyText);
      return Boolean(
        /^https?:\/\/www\.uniqlo\.com\/us\/en\/products\/E\d{6}/i.test(currentUrl)
        && (!expectedSku || productId === expectedSku || Boolean(allowAlternate))
        && (hasProductText || imageCount >= 2),
      );
    }, sku, allowAlternateProductId).catch(() => false);

    if (ready) {
      return true;
    }

    if (attempt < attempts) {
      emitLog(`    🔄 UNIQLO page not fully displayed yet; refreshing (${attempt}/${attempts - 1})...`, 'warning');
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    }
  }

  return false;
}

async function waitForUniqloManualProductSelection(page, normalized, emitLog, ensureActive, timeoutMs = 5 * 60 * 1000) {
  const start = Date.now();
  let lastReminderAt = 0;

  while (Date.now() - start < timeoutMs) {
    ensureActive();
    if (await isUniqloProductPage(page, normalized.sku)) {
      emitLog(`✅ UNIQLO product page selected manually for ${normalized.sku}. Continuing with scraping.`, 'success');
      return {
        input: normalized.input,
        url: page.url(),
        sku: normalized.sku,
      };
    }

    if (Date.now() - lastReminderAt > 15000) {
      emitLog(`🖱️ Automatic UNIQLO lookup could not resolve ${normalized.sku}. In the opened browser window, search/select the correct product page manually. The scraper will continue once the page is open.`, 'warning');
      lastReminderAt = Date.now();
    }

    await delay(1200);
  }

  throw new Error(`Timed out waiting for a manual UNIQLO product selection for ${normalized.sku}.`);
}

async function resolveUniqloProductUrl(browser, reference, emitLog, ensureActive) {
  const normalized = normalizeUniqloReference(reference);
  if (!normalized) {
    throw new Error('Empty UNIQLO reference.');
  }

  if (normalized.url) {
    return normalized;
  }

  if (!/^\d{6}$/.test(normalized.sku || '')) {
    throw new Error(`UNIQLO Product ID could not be detected from input: ${normalized.input}`);
  }

  const page = await browser.newPage();
  await antiDetection.applyRetailBrowsingProfile(page);
  await page.setViewport(antiDetection.getRandomViewport());
  await page.bringToFront().catch(() => {});

  /**
   * Try navigating to a URL and return true when it resolves to a proper
   * product page.  We attempt two waitUntil strategies so that both classic
   * and modern (React/Next.js) Uniqlo storefronts are handled:
   *   1. networkidle2  – waits for network to quiet down (catches SPA hydration)
   *   2. domcontentloaded – fallback if networkidle2 times out
   */
  const tryNavigate = async (url, options = {}) => {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch {
      // Tolerate timeout – page content may still be usable.
    }
    return waitForUniqloProductReady(page, normalized.sku, ensureActive, emitLog, {
      attempts: 3,
      settleMs: 900,
      allowAlternateProductId: Boolean(options.allowAlternateProductId),
    });
  };

  try {
    ensureActive();
    emitLog(`🔎 Resolving UNIQLO Product ID ${normalized.sku}...`, 'info');

    // ── Step 1: try well-known direct URL patterns ─────────────────────────
    for (const candidateUrl of buildUniqloProductCandidates(normalized.sku)) {
      if (await tryNavigate(candidateUrl)) {
        emitLog(`✅ Direct URL resolved: ${page.url()}`, 'success');
        return {
          input: normalized.input,
          url: page.url(),
          sku: normalized.sku,
        };
      }
    }

    // ── Step 2: site search ────────────────────────────────────────────────
    const searchUrl = `${UNIQLO_BASE_URL}search/?q=${encodeURIComponent(normalized.sku)}`;
    emitLog(`🔍 Searching UNIQLO for "${normalized.sku}"…`, 'info');

    if (await tryNavigate(searchUrl)) {
      return {
        input: normalized.input,
        url: page.url(),
        sku: normalized.sku,
      };
    }

    const searchResults = await extractUniqloSearchResultUrls(page, normalized.sku);

    // ── Step 3: follow the best search result ─────────────────────────────
    const exactSearchResult =
      searchResults.urls.find((entry) =>
        entry.url.includes(`E${normalized.sku}`) || String(entry.text || '').includes(normalized.sku),
      )
      || searchResults.urls[0]
      || null;

    if (exactSearchResult) {
      const exactCandidate = exactSearchResult.url.includes(`E${normalized.sku}`)
        || String(exactSearchResult.text || '').includes(normalized.sku);
      if (await tryNavigate(exactSearchResult.url, { allowAlternateProductId: !exactCandidate })) {
        if (exactCandidate) {
          emitLog(`✅ Found via search: ${page.url()}`, 'success');
        } else {
          emitLog(`✅ Found replacement product via UNIQLO search for ${normalized.sku}: ${page.url()}`, 'warning');
        }
        return {
          input: normalized.input,
          url: page.url(),
          sku: normalized.sku,
        };
      }
    }

    // ── Step 4: alternative URL pattern with different color/size suffix ───
    const altCandidates = [
      `https://www.uniqlo.com/us/en/products/E${normalized.sku}-000`,
      `https://www.uniqlo.com/us/en/products/E${normalized.sku}-001`,
      `https://www.uniqlo.com/us/en/products/E${normalized.sku}-000/00?colorCode=COL00`,
    ];
    for (const altUrl of altCandidates) {
      if (await tryNavigate(altUrl)) {
        emitLog(`✅ Alt URL resolved: ${page.url()}`, 'success');
        return {
          input: normalized.input,
          url: page.url(),
          sku: normalized.sku,
        };
      }
    }

    // ── Step 5: last resort – manual selection ────────────────────────────
    if (searchResults.likelyNoResults) {
      emitLog(`⚠️ UNIQLO search reported no results for ${normalized.sku}. Waiting for manual product selection in the browser...`, 'warning');
    } else {
      emitLog(`⚠️ Automatic resolution failed for ${normalized.sku}. Waiting for manual product selection in the browser...`, 'warning');
    }
    return await waitForUniqloManualProductSelection(page, normalized, emitLog, ensureActive);
  } finally {
    await page.close().catch(() => {});
  }
}

async function scrapeUniqloProduct(browser, reference, emitLog, ensureActive, preResolved = null) {
  // preResolved lets callers (e.g. the search-results flow) pass an already
  // known { url, sku, input } and skip the per-item resolve/search step.
  const normalized = preResolved || await resolveUniqloProductUrl(browser, reference, emitLog, ensureActive);

  // ── Firecrawl mode check ────────────────────────────────────────
  const currentMode = firecrawlService.getMode();
  if (currentMode === 'manual') {
    emitLog(`🔥 UNIQLO ${reference || ''} 手动模式: 使用 Firecrawl 抓取`, 'warning');
    try {
      ensureActive();
      const fcResult = await firecrawlFallback.tryFirecrawlFallback(normalized.url, {
        imageFilter: (imgUrl) => isLikelyUniqloProductImage(imgUrl),
        urlNormalizer: (u) => u.split('?')[0],
        candidateIds: [String(reference || '').replace(/\D/g, '')],
        emitLog: (msg, type) => emitLog(`    ${msg}`, type),
      });

      // ─ Parse product text from Firecrawl HTML ────────────────────
      const html = fcResult.html || '';
      let name = '';
      let price = '';
      let description = '';
      let compositionText = null;

      // Extract product name from <h1> tag
      const h1Match = html.match(/<h1[^>]*>(.*?)<\/h1>/is);
      if (h1Match) {
        name = h1Match[1].replace(/<[^>]+>/g, '').trim();
      }

      // Extract price
      const priceMatch = html.match(/[¥$€£]([\d.,]+)/);
      if (priceMatch) {
        price = priceMatch[0];
      }

      // Extract description
      const descPatterns = [
        /["']description["']?:\s*["']([^"']+)["']/i,
        /<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i,
      ];
      for (const pattern of descPatterns) {
        const m = html.match(pattern);
        if (m) {
          description = m[1].trim();
          break;
        }
      }

      // Extract composition/materials
      const compPatterns = [
        /["']composition["']?:\s*["']([^"']+)["']/i,
        /["']materials["']?:\s*["']([^"']+)["']/i,
      ];
      for (const pattern of compPatterns) {
        const m = html.match(pattern);
        if (m) {
          compositionText = m[1].trim();
          break;
        }
      }

      return {
        styleNumber: String(reference || '').replace(/\D/g, ''),
        productId: String(reference || '').replace(/\D/g, ''),
        brand: 'UNIQLO',
        name: name || `UNIQLO ${reference}`,
        price,
        colorRef: '',
        description,
        composition: {
          outerShell: null,
          lining: null,
          other: compositionText || null,
        },
        url: normalized.url,
        imageUrls: fcResult.imageUrls,
        pageText: '',
        usedEngine: 'firecrawl',
      };
    } catch (fcError) {
      emitLog(`❌ UNIQLO ${reference || ''} Firecrawl 抓取失败: ${fcError.message}`, 'error');
      throw new Error(`Firecrawl failed: ${fcError.message}`);
    }
  }
  // ── End Firecrawl manual mode ───────────────────────────────────

  const page = await browser.newPage();
  await antiDetection.applyRetailBrowsingProfile(page);
  await page.setViewport(antiDetection.getRandomViewport());
  await page.bringToFront().catch(() => {});

  const capturedUrls = new Set();
  page.on('response', (resp) => {
    const reqUrl = cleanImageUrl(resp.url());
    if (isLikelyUniqloProductImage(reqUrl)) {
      capturedUrls.add(reqUrl);
    }
  });

  try {
    ensureActive();
    await antiDetection.randomDelay(350, 800);

    try {
      await page.goto(normalized.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch { /* ignore – continue with whatever is loaded */ }
    const pageReady = await waitForUniqloProductReady(page, normalized.sku, ensureActive, emitLog, { attempts: 3, settleMs: 900 });
    if (!pageReady) {
      emitLog(`    ⚠️ UNIQLO product page may still be partially loaded for ${normalized.sku || reference}. Continuing with available data.`, 'warning');
    }
    await antiDetection.humanScroll(page, 900);
    await antiDetection.randomDelay(500, 800);

    // ── Try to expand collapsed product-detail panels before extraction ──────
    // Uniqlo wraps Details / Function Details / Materials and Care in
    // accordion buttons or <details> elements.  Opening them ensures the
    // innerText (including fabric composition with %) is present in the DOM.
    // We click EVERY expandable element that could be relevant — using
    // keyword matching rather than exact label match, because UNIQLO's
    // actual label is often "Materials and Care" (not just "Materials").
    await page.evaluate(() => {
      // 1. Open ALL <details> elements — safe and non-destructive.
      document.querySelectorAll('details').forEach((el) => {
        el.open = true;
      });

      // 2. Click every collapsed accordion button / summary whose label
      //    contains any relevant keyword.  Use includes() for flexibility
      //    with labels like "Materials and Care", "Material & Care", etc.
      const KEYWORDS = /detail|function|fabric|material|care|composition|spec/i;
      const triggers = [
        ...document.querySelectorAll(
          'button[aria-expanded="false"], summary, [role="button"][aria-expanded="false"], [class*="accordion"] button, [data-testid*="accordion"] button, [data-testid*="tab"]',
        ),
      ];
      triggers.forEach((node) => {
        const label = String(node.textContent || '').replace(/\s+/g, ' ').trim();
        if (label.length < 80 && KEYWORDS.test(label)) {
          try { node.click(); } catch { /* ignore */ }
        }
      });

      // 3. Also click any already-rendered but hidden disclosure panels
      //    that might have CSS-based show/hide (no aria-expanded attribute).
      document.querySelectorAll('[class*="collapse"], [class*="expandable"], [class*="disclosure"]').forEach((el) => {
        const trigger = el.querySelector('button, [role="button"], summary, .header, .title');
        if (trigger && KEYWORDS.test(String(trigger.textContent || ''))) {
          try { trigger.click(); } catch { /* ignore */ }
        }
      });
    }).catch(() => {});

    // Brief pause so the DOM can settle after expansions.
    await antiDetection.randomDelay(600, 1000);

    const info = await page.evaluate(() => {
      const bodyText = String(document.body?.innerText || '');
      const title =
        document.querySelector('h1')?.textContent?.trim()
        || document.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim()
        || String(document.title || '').split('|')[0].trim();

      const price =
        document.querySelector('meta[itemprop="price"]')?.getAttribute('content')
        || [...document.querySelectorAll('[class*="price"], [data-testid*="price"]')]
          .map((node) => String(node.textContent || '').trim())
          .find((value) => /\$|€|£/.test(value))
        || '';

      const galleryRoots = [
        ...document.querySelectorAll('[data-testid*="product"], [class*="product"], [class*="gallery"], [class*="carousel"], main'),
      ];
      const galleryImageSet = new Set();
      galleryRoots.forEach((root) => {
        root.querySelectorAll('img').forEach((img) => galleryImageSet.add(img));
      });

      const pageImages = [...galleryImageSet]
        .map((img) => ({
          src: img.currentSrc || img.src || '',
          srcset: img.getAttribute('srcset') || '',
          alt: String(img.alt || '').trim(),
          width: Number(img.naturalWidth || img.width || 0),
          height: Number(img.naturalHeight || img.height || 0),
        }))
        .filter((item) => item.src || item.srcset);

      const sourceImages = [...document.querySelectorAll('picture source')]
        .flatMap((source) => [source.getAttribute('srcset') || '', source.getAttribute('data-srcset') || ''])
        .filter(Boolean);

      const ldJson = [...document.querySelectorAll('script[type="application/ld+json"]')]
        .map((node) => String(node.textContent || '').trim())
        .filter(Boolean);

      // ── Section extraction ─────────────────────────────────────────────────
      // Strategy A: find every heading/button that names a section, then grab
      // its associated content element.  We keep a priority map so the most
      // specific match wins (e.g. "fabric details" beats "details").
      const sectionMap = {};

      const SECTION_LABELS = [
        'details',
        'product details',
        'function details',
        'fabric details',
        'materials',
        'materials and care',
        'materials & care',
        'material and care',
        'material & care',
        'care instructions',
        'care',
      ];

      // Use partial match (includes) so "Materials and Care" matches
      // both "materials" and "care" sub-labels.
      const isSectionHeading = (text) => {
        const lower = text.toLowerCase().trim();
        return SECTION_LABELS.some((label) => lower === label || lower.includes(label));
      };

      // Gather candidate heading nodes (buttons, summaries, headings).
      const headingCandidates = [
        ...document.querySelectorAll(
          'button, summary, [role="button"], h2, h3, h4, dt, [class*="accordion"] > *, [class*="section"] > *:first-child',
        ),
      ];

      headingCandidates.forEach((node) => {
        const rawLabel = String(node.textContent || '').replace(/\s+/g, ' ').trim();
        if (!isSectionHeading(rawLabel)) return;
        const normalizedLabel = rawLabel.toLowerCase();

        // Try aria-controls first.
        const controlsId = node.getAttribute('aria-controls') || '';
        let contentEl = controlsId ? document.getElementById(controlsId) : null;

        // Try the sibling / parent heuristic.
        if (!contentEl) {
          contentEl =
            node.nextElementSibling
            || node.parentElement?.nextElementSibling
            || null;
        }

        // Try the parent's nextSibling (common accordion pattern).
        if (!contentEl && node.parentElement) {
          contentEl = node.parentElement.nextElementSibling;
        }

        // For accordion: also try parent's closest expandable container
        if (!contentEl) {
          const accordion = node.closest('[class*="accordion"], [class*="collapse"], [data-testid*="accordion"]');
          if (accordion) {
            contentEl = accordion.querySelector('[class*="content"], [class*="body"], [class*="panel"], div:not(button)');
          }
        }

        const text = String(contentEl?.innerText || '').replace(/\s+/g, ' ').trim();
        if (text && text.length > 2) {
          sectionMap[normalizedLabel] = text;
          // Also map combined labels to their component keys so downstream
          // extraction picks them up (e.g. "materials and care" → "materials").
          if (/materials?\s*(?:and|&)\s*care/i.test(normalizedLabel)) {
            if (!sectionMap['materials']) sectionMap['materials'] = text;
            if (!sectionMap['fabric details']) sectionMap['fabric details'] = text;
            if (!sectionMap['care']) {
              // Extract care-only portion (lines without % compositions)
              const lines = text.split(/\s{2,}|\n/).filter((l) => !/\d{1,3}%/i.test(l));
              if (lines.length) sectionMap['care'] = lines.join(' ').trim();
            }
          }
        }
      });

      // Strategy B: walk bodyText line-by-line as a safety net for sections
      // that are already visible but not captured by DOM strategy.
      // (handled downstream in Node.js via extractUniqloSection)

      const scriptJson = [...document.querySelectorAll('script')]
        .map((node) => String(node.textContent || '').trim())
        .filter((text) => text && text.length > 20 && (text.startsWith('{') || text.startsWith('[') || text.includes('productId') || text.includes('itemNo')));

      const allHtml = document.documentElement?.outerHTML || '';
      const htmlImageMatches = allHtml.match(/https?:\/\/[^"'\\\s>]+(?:\.jpg|\.jpeg|\.png|\.webp)(?:\?[^"'\\\s>]*)?/ig) || [];

      return {
        bodyText: bodyText.slice(0, 60000),
        title,
        price,
        styleNumber:
          bodyText.match(/\b(?:Product ID|Item Number|Item No\.?)[:#\s-]*([0-9]{6})\b/i)?.[1]
          || window.location.href.match(/\/products\/E(\d{6})/i)?.[1]
          || '',
        colorRef: bodyText.match(/\bColor[:\s]*([^\n]+)/i)?.[1]?.trim() || '',
        pageImages,
        sourceImages,
        metaDescription:
          document.querySelector('meta[name="description"]')?.getAttribute('content')?.trim()
          || document.querySelector('meta[property="og:description"]')?.getAttribute('content')?.trim()
          || '',
        ldJson,
        sectionMap,
        scriptJson,
        htmlImageMatches,
      };
    });

    const parseSrcsetUrls = (value = '') =>
      String(value || '')
        .split(',')
        .map((part) => part.trim().split(/\s+/)[0])
        .filter(Boolean);

    const imageMeta = new Map();
    const domImageUrls = (info.pageImages || [])
      .flatMap((item) => {
        const urls = [
          cleanImageUrl(item.src),
          ...parseSrcsetUrls(item.srcset).map(cleanImageUrl),
        ].filter(Boolean);
        urls.forEach((url) => {
          imageMeta.set(url, {
            width: Number(item.width || 0),
            height: Number(item.height || 0),
            alt: String(item.alt || ''),
          });
        });
        return urls;
      })
      .filter(isLikelyUniqloProductImage);

    const sourceImageUrls = (info.sourceImages || [])
      .flatMap((value) => parseSrcsetUrls(value).map(cleanImageUrl))
      .filter(isLikelyUniqloProductImage);

    const ldDescriptions = (info.ldJson || []).map((text) => parseLdJsonDescription(text)).filter(Boolean);
    const ldImageUrls = [];
    for (const text of (info.ldJson || [])) {
      try {
        const parsed = JSON.parse(text);
        const queue = Array.isArray(parsed) ? parsed : [parsed];
        queue.forEach((entry) => {
          const images = Array.isArray(entry?.image) ? entry.image : entry?.image ? [entry.image] : [];
          images.forEach((url) => {
            if (typeof url === 'string') {
              ldImageUrls.push(cleanImageUrl(url));
            }
          });
        });
      } catch {
        // Ignore malformed ld+json.
      }
    }

    const scriptImageUrls = extractUniqloImageUrlCandidates(info.scriptJson || [])
      .filter(isLikelyUniqloProductImage);
    const htmlImageUrls = (info.htmlImageMatches || [])
      .map(cleanImageUrl)
      .filter(isLikelyUniqloProductImage);

    const resolvedProductId = info.styleNumber
      || extractUniqloProductIdFromScripts(info.scriptJson || [])
      || extractUniqloProductIdFromText(info.bodyText)
      || normalized.sku
      || reference;

    const seedImageUrls = [...new Set([
      ...capturedUrls,
      ...domImageUrls,
      ...sourceImageUrls,
      ...scriptImageUrls,
      ...htmlImageUrls,
      ...ldImageUrls,
    ])]
      .filter(isLikelyUniqloProductImage)
      .filter((url) => {
        const meta = imageMeta.get(url) || {};
        const width = Number(meta.width || 0);
        const height = Number(meta.height || 0);
        const alt = String(meta.alt || '').toLowerCase();
        if (width > 0 && height > 0 && (width < 320 || height < 320)) {
          return false;
        }
        if (/detail|fabric|material|care|swatch|chip/i.test(alt)) {
          return false;
        }
        if (resolvedProductId && !url.includes(resolvedProductId) && /\/products\/|\/search\//i.test(url)) {
          return false;
        }
        return true;
      });

    const detailsText = String(info.sectionMap?.['details'] || info.sectionMap?.['product details'] || '').trim() || extractUniqloSection(
      info.bodyText,
      ['Details', 'Product Details'],
      ['Function Details', 'Fabric Details', 'Materials', 'Materials and Care', 'Materials & Care', 'Care Instructions', 'Care', 'Product ID', 'Reviews'],
    );
    const functionDetailsText = String(info.sectionMap?.['function details'] || '').trim() || extractUniqloSection(
      info.bodyText,
      ['Function Details'],
      ['Fabric Details', 'Materials', 'Materials and Care', 'Materials & Care', 'Care Instructions', 'Care', 'Product ID', 'Reviews'],
    );
    const fabricDetailsText = String(
      info.sectionMap?.['fabric details']
      || info.sectionMap?.['materials']
      || info.sectionMap?.['materials and care']
      || info.sectionMap?.['materials & care']
      || info.sectionMap?.['material and care']
      || info.sectionMap?.['material & care']
      || ''
    ).trim() || extractUniqloSection(
      info.bodyText,
      ['Fabric Details', 'Materials', 'Materials and Care', 'Materials & Care', 'Material and Care', 'Material & Care'],
      ['Care Instructions', 'Care', 'Product ID', 'Reviews'],
    );

    // ── Description: Details + Function Details raw text only ──────────────
    // Do NOT include ld+json descriptions or meta description — those are
    // marketing blurbs that duplicate the title and add noise.
    const descriptionParts = [detailsText, functionDetailsText].filter(Boolean);
    const description = descriptionParts.join('\n').trim();

    // ── Composition: Fabric Details is the primary source ──────────────────
    // Fall back to full body text only when Fabric Details is empty.
    const compositionText =
      extractUniqloCompositionText(fabricDetailsText)
      || extractUniqloCompositionText(info.bodyText);

    const productId = resolvedProductId;
    const canonicalProductId = normalized.url.match(/\/products\/E(\d{6})/i)?.[1] || '';
    if (productId && normalized.sku && productId !== normalized.sku) {
      emitLog(`    🔁 UNIQLO input ${normalized.sku} resolved to active product ${productId}.`, 'warning');
    }
    const probedImageUrls = await findExistingUniqloCdnImages(productId, seedImageUrls, emitLog);
    const rawImageUrls = [...new Set([
      ...seedImageUrls,
      ...probedImageUrls,
    ])].filter(isLikelyUniqloProductImage);
    const imageUrls = filterUniqloProductImages(rawImageUrls, [canonicalProductId, productId]).slice(0, 12);

    // Debug logging so we can verify extraction quality in the console.
    emitLog(`    📝 Details: ${detailsText ? detailsText.slice(0, 120).replace(/\n/g, ' ') + '…' : '(empty)'}`, 'info');
    emitLog(`    🔧 Function Details: ${functionDetailsText ? functionDetailsText.slice(0, 120).replace(/\n/g, ' ') + '…' : '(empty)'}`, 'info');
    emitLog(`    🧵 Fabric Details raw: ${fabricDetailsText ? fabricDetailsText.slice(0, 120).replace(/\n/g, ' ') + '…' : '(empty)'}`, 'info');
    emitLog(`    🧶 Composition resolved: ${compositionText || '(empty)'}`, 'info');

    emitLog(`✅ UNIQLO ${productId} captured | ${info.title || 'Untitled'} | ${imageUrls.length} images`, imageUrls.length > 0 ? 'success' : 'warning');

    return {
      styleNumber: productId,
      productId,
      brand: 'UNIQLO',
      name: info.title || `UNIQLO ${productId}`,
      price: info.price || '',
      colorRef: info.colorRef || '',
      description,
      composition: {
        outerShell: null,
        lining: null,
        other: compositionText || null,
      },
      url: normalized.url,
      imageUrls,
      pageText: info.bodyText || '',
    };
  } finally {
    await page.close().catch(() => {});
  }
}

// Open the UNIQLO homepage, type the SKU into the search box, submit, and
// collect ONLY genuine search-result product links — excluding best-seller /
// recommendation / "you may also like" rails that surround the results grid.
async function searchUniqloResults(browser, sku, emitLog, ensureActive) {
  const page = await browser.newPage();
  try {
    await antiDetection.applyRetailBrowsingProfile(page);
    await page.setViewport(antiDetection.getRandomViewport());
    await page.setUserAgent(antiDetection.getRandomUserAgent());

    emitLog(`    🏠 Opening UNIQLO homepage to search "${sku}"…`, 'info');
    await page.goto(UNIQLO_BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await antiDetection.randomDelay(1500, 2500);
    ensureActive();

    // Dismiss cookie / region popups that can cover the search box.
    await page.evaluate(() => {
      const re = /^\s*(accept|agree|allow all|got it|ok|continue|i accept|accept all)\s*$/i;
      for (const el of document.querySelectorAll('button, [role="button"], a')) {
        const t = String(el.textContent || '').trim();
        if (t && t.length < 24 && re.test(t)) { try { el.click(); } catch { /* noop */ } }
      }
    }).catch(() => {});
    await antiDetection.randomDelay(600, 1200);

    // Locate + focus the search input. UNIQLO's header has a search trigger
    // that may need clicking before the input is usable.
    const typedOk = await page.evaluate((skuVal) => {
      const isVisible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 16 || r.height < 6) return false;
        const s = window.getComputedStyle(el);
        return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
      };
      // Click a search toggle if present.
      const toggle = [...document.querySelectorAll('button, [role="button"], a')]
        .find((el) => /search/i.test(el.getAttribute('aria-label') || el.getAttribute('title') || el.className || ''));
      if (toggle) { try { toggle.click(); } catch { /* noop */ } }
      const input = [...document.querySelectorAll('input[type="search"], input[name*="search" i], input[placeholder*="search" i], input[aria-label*="search" i], input[type="text"]')]
        .find(isVisible);
      if (input) {
        input.focus();
        // Write value directly via native descriptor (React-safe) and dispatch
        // the full input lifecycle — avoids keyboard.type getting clipped.
        try {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(input, String(skuVal));
          else input.value = String(skuVal);
        } catch { input.value = String(skuVal); }
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('search', { bubbles: true }));
        return true;
      }
      return false;
    }, sku).catch(() => false);

    if (!typedOk) {
      // Fallback: direct search URL (still a real search results page, not a guessed PDP).
      emitLog('    ⚠️ Search box not found; using UNIQLO search URL directly.', 'warning');
      await page.goto(`${UNIQLO_BASE_URL}search/?q=${encodeURIComponent(sku)}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } else {
      await antiDetection.randomDelay(400, 800);
      // Value already written via DOM; just press Enter to submit.
      await page.keyboard.press('Enter').catch(() => {});
    }
    await antiDetection.randomDelay(2500, 3800);
    ensureActive();

    // Scroll to load lazy result tiles.
    for (let r = 0; r < 8; r += 1) {
      ensureActive();
      await page.evaluate(async () => {
        for (let i = 0; i < 4; i += 1) { window.scrollBy(0, window.innerHeight); await new Promise((res) => setTimeout(res, 250)); }
      }).catch(() => {});
      await antiDetection.randomDelay(500, 900);
    }

    // Collect product links, EXCLUDING best-seller / recommendation rails.
    const urls = await page.evaluate(() => {
      const railRe = /(best\s*sell|recommend|you\s*may\s*also|similar|popular|trending|complete\s*the\s*look|others?\s*(also\s*)?(bought|viewed)|featured|new\s*arrivals|styling|carousel)/i;
      const isInRail = (el) => {
        let node = el;
        for (let hops = 0; node && hops < 8; hops += 1, node = node.parentElement) {
          const hay = `${node.getAttribute?.('aria-label') || ''} ${node.getAttribute?.('data-testid') || ''} ${node.className || ''} ${node.id || ''}`;
          if (railRe.test(hay)) return true;
          const heading = node.querySelector?.(':scope > h1, :scope > h2, :scope > h3, :scope > header');
          if (heading && railRe.test(String(heading.textContent || ''))) return true;
        }
        return false;
      };
      const out = [];
      for (const a of document.querySelectorAll('a[href*="/products/E"]')) {
        const href = a.href || '';
        if (!/\/us\/en\/products\/E\d{6}/i.test(href)) continue;
        if (isInRail(a)) continue;
        out.push(href.split('#')[0]);
      }
      return out;
    }).catch(() => []);

    // Normalise + dedupe by product id (E######).
    const seen = new Set();
    const results = [];
    for (const raw of urls) {
      const norm = normalizeUniqloProductUrl(raw) || raw.split('?')[0];
      const idMatch = norm.match(/\/products\/E(\d{6})/i);
      const id = idMatch ? idMatch[1] : norm;
      if (seen.has(id)) continue;
      seen.add(id);
      results.push({ url: norm, productId: id });
    }
    emitLog(`    🔎 UNIQLO search "${sku}": ${results.length} result product(s) (rails excluded).`, results.length ? 'success' : 'warning');
    return results;
  } finally {
    await page.close().catch(() => {});
  }
}

async function runUniqloScraper(config, emitLog, emitProgress, taskController, previewBridge = null) {

  let { styleNumbers, excelPath, outputDir, tabConcurrency, downloadConcurrency } = config;
  styleNumbers = normalizeManualStyleNumbers(styleNumbers);
  const ensureActive = () => taskController?.throwIfCancelled?.();
  let browser = null;
  const effectiveTabConcurrency = 2;

  if (excelPath) {
    try {
      ensureActive();
      emitLog(`Reading Excel file: ${excelPath}`, 'info');
      const wb = XLSX.readFile(excelPath);
      const ws = wb.Sheets[wb.SheetNames[0]];
      styleNumbers = [];
      const range = XLSX.utils.decode_range(ws['!ref'] || 'A1:B1');
      for (let row = 1; row <= range.e.r; row += 1) {
        const cellAddress = XLSX.utils.encode_cell({ r: row, c: 1 });
        const cell = ws[cellAddress];
        if (cell) {
          const displayValue = String(cell.w ?? cell.v ?? '').replace(/\u00a0/g, ' ').trim();
          if (displayValue) {
            styleNumbers.push(displayValue);
            emitLog(`📥 Excel row ${row + 1} column B: "${displayValue}"`, 'info');
          }
        }
      }
      emitLog(`Loaded ${styleNumbers.length} UNIQLO Product ID values from Excel.`, 'success');
    } catch (error) {
      throw new Error(`Excel parse failed: ${error.message}`);
    }
  }

  ensureActive();
  if (!styleNumbers || styleNumbers.length === 0) {
    throw new Error('No UNIQLO Product ID values were found. Put the product IDs in column B or enter them manually.');
  }

  const targetDir = !outputDir || outputDir === '未选择' ? path.join(app.getPath('desktop'), 'UNIQLO') : outputDir;
  fs.mkdirSync(targetDir, { recursive: true });

  emitLog(`📁 Output directory: ${targetDir}`, 'info');
  emitLog('🌐 Launching the English UNIQLO scraper session...', 'info');
  emitLog('💡 UNIQLO scraping uses the US English storefront and saves English product metadata.', 'info');

  let executablePath = findChromePath();
  if (!executablePath) {
    emitLog('⬇️ No local Chrome was found. Downloading a managed Chrome runtime for GS Bot...', 'warning');
    const chromeInstall = await ensureChromeRuntimeAvailable((payload) => {
      if (payload?.status) {
        emitLog(payload.status, payload.phase === 'complete' ? 'success' : 'info');
      }
    });
    if (!chromeInstall?.success) {
      throw new Error(chromeInstall?.error || 'Chrome download failed.');
    }
    executablePath = chromeInstall.executablePath;
  }

  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: false,
      userDataDir: getUniqloSessionDir(),
      args: antiDetection.getRetailLaunchArgs(),
      ignoreDefaultArgs: ['--enable-automation'],
      defaultViewport: null,
    });
    previewBridge?.attachToBrowser(browser);

    taskController?.onCancel(() => {
      if (browser && browser.isConnected()) {
        browser.close().catch(() => {});
      }
    });

    const products = [];
    let currentProgress = 5;
    emitProgress(currentProgress);
    const totalItems = styleNumbers.length;

    // New model: each input SKU is a SEARCH TERM. We search the UNIQLO site,
    // collect every genuine result product (best-seller/recommendation rails
    // excluded), then scrape each result. Downloads nest under <inputSKU>/.
    for (let i = 0; i < totalItems; i += 1) {
      ensureActive();
      const searchSku = String(styleNumbers[i] || '').trim();
      emitLog(`🔎 UNIQLO ${i + 1}/${totalItems}: searching "${searchSku}"…`, 'warning');

      let results = [];
      try {
        results = await searchUniqloResults(browser, searchSku, emitLog, ensureActive);
      } catch (error) {
        if (isCancellationError(error) || taskController?.cancelled) throw new TaskCancelledError();
        emitLog(`    ⚠️ UNIQLO search failed for "${searchSku}": ${error.message}`, 'warning');
      }

      if (!results.length) {
        products.push({ searchSku, styleNumber: searchSku, productId: searchSku, url: '', error: 'No search results', imageUrls: [] });
      }

      for (let r = 0; r < results.length; r += 1) {
        ensureActive();
        const { url, productId } = results[r];
        emitLog(`    🎯 Result ${r + 1}/${results.length}: ${productId} (${url})`, 'info');
        try {
          const scraped = await scrapeUniqloProduct(
            browser,
            productId,
            emitLog,
            ensureActive,
            { url, sku: productId, input: searchSku },
          );
          products.push({ ...scraped, searchSku, productId: scraped.productId || productId });
        } catch (error) {
          if (isCancellationError(error) || taskController?.cancelled) throw new TaskCancelledError();
          emitLog(`    ⚠️ UNIQLO ${productId} failed: ${error.message}`, 'warning');
          products.push({ searchSku, styleNumber: productId, productId, url, error: error.message, imageUrls: [] });
        }
        await antiDetection.randomDelay(800, 1600);
      }

      currentProgress = 5 + Math.round(((i + 1) / totalItems) * 45);
      emitProgress(currentProgress);
      if (i + 1 < totalItems) await antiDetection.randomDelay(1200, 2200);
    }

    ensureActive();
    emitLog('🌐 UNIQLO page extraction complete. Preparing image downloads...', 'warning');

    const successProducts = products.filter((product) => product.imageUrls && product.imageUrls.length > 0);
    const failedProducts = products.filter((product) => !product.imageUrls || product.imageUrls.length === 0);
    const totalImages = successProducts.reduce((sum, product) => sum + product.imageUrls.length, 0);

    emitLog(`📊 UNIQLO summary: ${successProducts.length} styles succeeded, ${failedProducts.length} styles failed, ${totalImages} images collected.`, 'info');

    if (failedProducts.length > 0) {
      failedProducts.forEach((product) => {
        emitLog(`    ❌ ${product.styleNumber} - ${product.error || 'No product images found'}`, 'error');
      });
    }

    const allTasks = [];
    for (const product of successProducts) {
      ensureActive();
      const cleanStyleNumber = sanitizeFileSegment(String(product.productId || product.styleNumber || '').replace(/[\\/]/g, '-'), 'uniqlo-item');
      // Single-level folder named by the real product id — no nested parent.
      const styleDir = path.join(targetDir, cleanStyleNumber);
      fs.mkdirSync(styleDir, { recursive: true });

      const classified = buildUniqloImageMap(product.imageUrls || []);

      for (const [label, imgUrl] of Object.entries(classified)) {
        const ext = getUrlExtension(imgUrl, '.jpg');
        const filename = `${cleanStyleNumber}_${label}${ext}`;
        const filePath = path.join(styleDir, filename);
        allTasks.push(() => {
          ensureActive();
          return downloadFile(imgUrl, filePath, {
            headers: {
              Referer: product.url || UNIQLO_BASE_URL,
              'User-Agent': 'Mozilla/5.0',
            },
            timeoutMs: 45000,
          })
            .then((size) => {
              if (size) {
                emitLog(`    ⬇️ [saved] ${filename} (${size.toFixed(1)} KB)`);
              }
            })
            .catch((error) => {
              emitLog(`    ❌ [failed] ${filename}: ${error.message}`, 'error');
            });
        });
      }

      const infoData = {
        styleNumber: product.productId || product.styleNumber,
        brand: product.brand || 'UNIQLO',
        name: product.name,
        price: product.price,
        colorRef: product.colorRef,
        description: product.description,
        composition: product.composition || null,
        url: product.url,
        images: classified,
      };

      const infoPath = path.join(styleDir, `${cleanStyleNumber}_info.json`);
      fs.writeFileSync(infoPath, JSON.stringify(infoData, null, 2), 'utf-8');
      emitLog(`📄 Saved product metadata: ${cleanStyleNumber}_info.json`, 'success');
    }

    emitLog(`📦 Downloading ${allTasks.length} UNIQLO images with ${downloadConcurrency} worker(s)...`, 'info');

    let completedTasks = 0;
    const tasksWithProgress = allTasks.map((task) => async () => {
      ensureActive();
      await task();
      completedTasks += 1;
      emitProgress(50 + Math.round((completedTasks / Math.max(allTasks.length, 1)) * 50));
    });

    if (tasksWithProgress.length > 0) {
      await parallelLimit(tasksWithProgress, downloadConcurrency);
    }

    emitProgress(100);
    const summary = products.map((product) => ({
      styleNumber: product.productId || product.styleNumber,
      brand: product.brand || 'UNIQLO',
      name: product.name,
      price: product.price,
      colorRef: product.colorRef,
      composition: product.composition || null,
      images: Object.keys(buildUniqloImageMap(product.imageUrls || [])).length,
      error: product.error || null,
    }));
    fs.writeFileSync(path.join(targetDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf-8');
    emitLog('📊 Saved summary.json', 'success');

    if (failedProducts.length > 0) {
      const failedSummary = failedProducts.map((product) => ({
        styleNumber: product.productId || product.styleNumber,
        error: product.error || 'No product images found',
      }));
      fs.writeFileSync(path.join(targetDir, 'failed_styles.json'), JSON.stringify(failedSummary, null, 2), 'utf-8');
      fs.writeFileSync(
        path.join(targetDir, 'failed_styles.txt'),
        failedSummary.map((item) => `${item.styleNumber}\t${item.error}`).join('\n'),
        'utf-8',
      );
      emitLog('📄 Saved failed_styles.json', 'success');
      emitLog('📄 Saved failed_styles.txt', 'success');
    }

    if (excelPath) {
      try {
        const workbook = XLSX.readFile(excelPath);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
        const resultMap = new Map();

        products.forEach((product) => {
          const key = String(product.productId || product.styleNumber || '').trim();
          if (!key) {
            return;
          }
          resultMap.set(key, product);
          resultMap.set(key.replace(/\s+/g, ''), product);
        });

        if (!rows[0]) {
          rows[0] = [];
        }
        rows[0][2] = 'Status';
        rows[0][3] = 'Image Count';
        rows[0][4] = 'Error';

        for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
          const row = rows[rowIndex] || [];
          const rawValue = String(row[1] || '').replace(/\u00a0/g, ' ').trim();
          if (!rawValue) {
            continue;
          }

          const matched = resultMap.get(rawValue) || resultMap.get(rawValue.replace(/\s+/g, ''));
          if (!matched) {
            row[2] = 'Not processed';
            row[3] = 0;
            row[4] = '';
            rows[rowIndex] = row;
            continue;
          }

          const imageCount = matched.imageUrls ? matched.imageUrls.length : 0;
          row[2] = imageCount > 0 ? 'Success' : 'Failed';
          row[3] = imageCount;
          row[4] = matched.error || '';
          rows[rowIndex] = row;
        }

        const annotatedSheet = XLSX.utils.aoa_to_sheet(rows);
        workbook.Sheets[sheetName] = annotatedSheet;
        const parsedExcelPath = path.parse(excelPath);
        const annotatedPath = path.join(parsedExcelPath.dir, `${parsedExcelPath.name}_uniqlo_results${parsedExcelPath.ext}`);
        XLSX.writeFile(workbook, annotatedPath);
        emitLog(`📄 Saved annotated Excel: ${path.basename(annotatedPath)}`, 'success');
      } catch (error) {
        emitLog(`⚠️ Could not save annotated UNIQLO Excel: ${error.message}`, 'warning');
      }
    }

    emitLog(`🎉 UNIQLO scraping finished. Files saved to: ${targetDir}`, 'success');
  } finally {
    if (browser && browser.isConnected()) {
      await browser.close().catch(() => {});
    }
  }
}

function isLikelyGuProductImage(url = '') {
  const value = cleanImageUrl(url).toLowerCase();
  if (!value || !/\.(jpg|jpeg|png|webp)(\?|$)/i.test(value)) {
    return false;
  }
  if (value.includes('/chip/') || value.includes('chip') || value.includes('logo') || value.includes('icon') || value.endsWith('.svg')) {
    return false;
  }
  return value.includes('image.uniqlo.com/gu/');
}

function buildGuProductCandidates(sku = '') {
  const cleanSku = String(sku || '').replace(/[^\d]/g, '');
  if (!/^\d{6}$/.test(cleanSku)) {
    return [];
  }
  return [
    `${GU_BASE_URL}products/E${cleanSku}-000/00`,
    `${GU_BASE_URL}products/E${cleanSku}`,
    `${GU_BASE_URL}search?q=${encodeURIComponent(cleanSku)}`,
  ];
}

function buildGuCdnImageCandidates(productId = '', colorCodes = []) {
  const cleanProductId = String(productId || '').replace(/[^\d]/g, '');
  if (!/^\d{6}$/.test(cleanProductId)) {
    return [];
  }

  const candidates = new Set();
  const normalizedColorCodes = [...new Set((colorCodes || []).map((code) => String(code || '').replace(/[^\d]/g, '').padStart(2, '0').slice(-2)).filter(Boolean))];
  normalizedColorCodes.forEach((colorCode) => {
    candidates.add(`https://image.uniqlo.com/GU/ST3/us/imagesgoods/${cleanProductId}/item/usgoods_${colorCode}_${cleanProductId}_3x4.jpg`);
    candidates.add(`https://image.uniqlo.com/GU/ST3/WesternCommon/imagesgoods/${cleanProductId}/item/goods_${colorCode}_${cleanProductId}_3x4.jpg`);
  });

  for (let index = 1; index <= 60; index += 1) {
    candidates.add(`https://image.uniqlo.com/GU/ST3/WesternCommon/imagesgoods/${cleanProductId}/sub/goods_${cleanProductId}_sub${index}_3x4.jpg`);
    candidates.add(`https://image.uniqlo.com/GU/ST3/us/imagesgoods/${cleanProductId}/sub/usgoods_${cleanProductId}_sub${index}_3x4.jpg`);
  }

  return [...candidates];
}

async function findExistingGuCdnImages(productId = '', seedImageUrls = [], emitLog = () => {}) {
  const colorCodes = extractUniqloColorCodesFromImages(seedImageUrls, productId);
  const candidates = buildGuCdnImageCandidates(productId, colorCodes);
  const found = [];
  const concurrency = 6;

  for (let index = 0; index < candidates.length; index += concurrency) {
    const batch = candidates.slice(index, index + concurrency);
    const results = await Promise.all(batch.map(async (url) => ({
      url,
      exists: await checkRemoteFileExists(url, {
        headers: { Referer: GU_BASE_URL },
        timeoutMs: 6000,
      }),
    })));
    results.filter((result) => result.exists).forEach((result) => found.push(result.url));
  }

  if (found.length > 0) {
    emitLog(`    🖼️ GU CDN probe found ${found.length} existing image(s) for ${productId}.`, 'info');
  }
  return found;
}

async function resolveGuProductUrl(browser, reference, emitLog, ensureActive) {
  const normalized = normalizeSixDigitReference(reference, 'GU Product');
  if (!normalized) {
    throw new Error('Empty GU reference.');
  }
  if (normalized.url) {
    return normalized;
  }

  const page = await browser.newPage();
  await antiDetection.applyRetailBrowsingProfile(page);
  await page.setViewport(antiDetection.getRandomViewport());
  await page.bringToFront().catch(() => {});

  try {
    emitLog(`🔎 Resolving GU Product ID ${normalized.sku}...`, 'info');
    for (const candidateUrl of buildGuProductCandidates(normalized.sku)) {
      ensureActive();
      try {
        await page.goto(candidateUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      } catch {
        // Continue with whatever loaded.
      }
      await antiDetection.randomDelay(1000, 1600);
      let resolved;
      try {
        resolved = await page.evaluate((sku) => {
        const currentUrl = window.location.href;
        const bodyText = String(document.body?.innerText || '');
        const matchedProductId =
          currentUrl.match(/\/products\/E(\d{6})/i)?.[1]
          || bodyText.match(/\bProduct ID:\s*([0-9]{6})\b/i)?.[1]
          || '';

        if (/\/products\/E\d{6}/i.test(currentUrl) && (currentUrl.includes(`E${sku}`) || bodyText.includes(`Product ID: ${sku}`))) {
          return {
            url: currentUrl,
            productId: matchedProductId || sku,
            replacement: false,
          };
        }

        if (/\/products\/E\d{6}/i.test(currentUrl) && matchedProductId) {
          return {
            url: currentUrl,
            productId: matchedProductId,
            replacement: matchedProductId !== sku,
          };
        }

        const anchors = [...document.querySelectorAll('a[href*="/products/E"]')]
          .map((anchor) => ({
            href: anchor.href,
            text: String(anchor.textContent || '').trim(),
          }));
        const exactAnchor = anchors.find((entry) => entry.href.includes(`E${sku}`));
        if (exactAnchor?.href) {
          return {
            url: exactAnchor.href,
            productId: sku,
            replacement: false,
          };
        }
        const replacementAnchor = anchors.find((entry) => /\/products\/E\d{6}/i.test(entry.href));
        if (replacementAnchor?.href) {
          const replacementId = replacementAnchor.href.match(/\/products\/E(\d{6})/i)?.[1] || '';
          return {
            url: replacementAnchor.href,
            productId: replacementId,
            replacement: Boolean(replacementId && replacementId !== sku),
          };
        }
        return { url: '', productId: '', replacement: false };
        }, normalized.sku);
      } catch (error) {
        if (/Execution context was destroyed|Cannot find context/i.test(String(error?.message || ''))) {
          await antiDetection.randomDelay(900, 1400);
          resolved = await page.evaluate((sku) => {
            const currentUrl = window.location.href;
            const bodyText = String(document.body?.innerText || '');
            const matchedProductId =
              currentUrl.match(/\/products\/E(\d{6})/i)?.[1]
              || bodyText.match(/\bProduct ID:\s*([0-9]{6})\b/i)?.[1]
              || '';
            return {
              url: /\/products\/E\d{6}/i.test(currentUrl) ? currentUrl : '',
              productId: matchedProductId,
              replacement: Boolean(matchedProductId && matchedProductId !== sku),
            };
          }, normalized.sku).catch(() => ({ url: '', productId: '', replacement: false }));
        } else {
          throw error;
        }
      }
      if (resolved?.url) {
        if (resolved.replacement) {
          emitLog(`✅ GU replacement product resolved: ${normalized.sku} → ${resolved.productId} (${resolved.url})`, 'warning');
        } else {
          emitLog(`✅ GU URL resolved: ${resolved.url}`, 'success');
        }
        return { ...normalized, url: resolved.url, resolvedProductId: resolved.productId || normalized.sku };
      }
    }
  } finally {
    await page.close().catch(() => {});
  }

  throw new Error(`No GU product was found for ${normalized.sku}.`);
}

async function scrapeGuProduct(browser, reference, emitLog, ensureActive) {
  const normalized = await resolveGuProductUrl(browser, reference, emitLog, ensureActive);

  // ── Firecrawl mode check ────────────────────────────────────────
  const currentMode = firecrawlService.getMode();
  if (currentMode === 'manual') {
    emitLog(` GU ${reference || ''} 手动模式: 使用 Firecrawl 抓取`, 'warning');
    try {
      ensureActive();
      const fcResult = await firecrawlFallback.tryFirecrawlFallback(normalized.url, {
        imageFilter: (imgUrl) => isLikelyGuProductImage(imgUrl),
        urlNormalizer: (u) => u.split('?')[0],
        candidateIds: [String(reference || '').replace(/\D/g, '')],
        emitLog: (msg, type) => emitLog(`    ${msg}`, type),
      });

      // ─ Parse product text from Firecrawl HTML ────────────────────
      const html = fcResult.html || '';
      let name = '';
      let price = '';
      let description = '';
      let compositionText = null;

      const h1Match = html.match(/<h1[^>]*>(.*?)<\/h1>/is);
      if (h1Match) {
        name = h1Match[1].replace(/<[^>]+>/g, '').trim();
      }

      const priceMatch = html.match(/[¥$€£]([\d.,]+)/);
      if (priceMatch) {
        price = priceMatch[0];
      }

      const descPatterns = [
        /["']description["']?:\s*["']([^"']+)["']/i,
        /<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i,
      ];
      for (const pattern of descPatterns) {
        const m = html.match(pattern);
        if (m) {
          description = m[1].trim();
          break;
        }
      }

      const compPatterns = [
        /["']composition["']?:\s*["']([^"']+)["']/i,
        /["']materials["']?:\s*["']([^"']+)["']/i,
      ];
      for (const pattern of compPatterns) {
        const m = html.match(pattern);
        if (m) {
          compositionText = m[1].trim();
          break;
        }
      }

      return {
        styleNumber: String(reference || '').replace(/\D/g, ''),
        productId: String(reference || '').replace(/\D/g, ''),
        brand: 'GU',
        name: name || `GU ${reference}`,
        price,
        colorRef: '',
        description,
        composition: { outerShell: null, lining: null, other: compositionText || null },
        url: normalized.url,
        imageUrls: fcResult.imageUrls,
        pageText: '',
        usedEngine: 'firecrawl',
      };
    } catch (fcError) {
      emitLog(`❌ GU ${reference || ''} Firecrawl 抓取失败: ${fcError.message}`, 'error');
      throw new Error(`Firecrawl failed: ${fcError.message}`);
    }
  }
  // ── End Firecrawl manual mode ───────────────────────────────────

  const page = await browser.newPage();
  await antiDetection.applyRetailBrowsingProfile(page);
  await page.setViewport(antiDetection.getRandomViewport());
  await page.bringToFront().catch(() => {});

  const capturedUrls = new Set();
  page.on('response', (resp) => {
    const reqUrl = cleanImageUrl(resp.url());
    if (isLikelyGuProductImage(reqUrl)) {
      capturedUrls.add(reqUrl);
    }
  });

  try {
    try {
      await page.goto(normalized.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch {
      // Continue with loaded DOM.
    }
    await antiDetection.randomDelay(1200, 1900);
    await page.evaluate(() => {
      document.querySelectorAll('details').forEach((el) => { el.open = true; });
      [...document.querySelectorAll('button[aria-expanded="false"], summary, [role="button"][aria-expanded="false"]')]
        .forEach((node) => {
          const label = String(node.textContent || '').replace(/\s+/g, ' ').trim();
          if (/features|details|materials|care/i.test(label)) {
            try { node.click(); } catch {}
          }
        });
    }).catch(() => {});
    await antiDetection.humanScroll(page, 900);
    await antiDetection.randomDelay(500, 800);

    const info = await page.evaluate(() => {
      const bodyText = String(document.body?.innerText || '');
      const title = document.querySelector('h1')?.textContent?.trim() || String(document.title || '').split('|')[0].trim();
      const price = [...document.querySelectorAll('[class*="price"], [data-testid*="price"], main')]
        .map((node) => String(node.textContent || '').match(/\$\s?[\d,.]+/)?.[0] || '')
        .find(Boolean) || bodyText.match(/\$\s?[\d,.]+/)?.[0] || '';
      const sectionText = (headingRegex, stopRegex) => {
        const lines = bodyText.split('\n').map((line) => line.trim()).filter(Boolean);
        const start = lines.findIndex((line) => headingRegex.test(line));
        if (start < 0) return '';
        const out = [];
        for (let index = start + 1; index < lines.length; index += 1) {
          if (stopRegex.test(lines[index])) break;
          out.push(lines[index]);
        }
        return out.join('\n').trim();
      };
      const pageImages = [...document.querySelectorAll('img')]
        .map((img) => ({
          src: img.currentSrc || img.src || '',
          srcset: img.getAttribute('srcset') || '',
          alt: img.alt || '',
          width: Number(img.naturalWidth || img.width || 0),
          height: Number(img.naturalHeight || img.height || 0),
        }))
        .filter((item) => item.src || item.srcset);
      return {
        bodyText: bodyText.slice(0, 60000),
        title,
        price,
        productId: bodyText.match(/\bProduct ID:\s*([0-9]{6})\b/i)?.[1] || location.href.match(/\/products\/E(\d{6})/i)?.[1] || '',
        colorRef: bodyText.match(/\bColor:\s*([^\n]+)/i)?.[1]?.trim() || '',
        features: sectionText(/^Features$/i, /^(Details|Materials \/ Care|Delivery|Production)$/i),
        details: sectionText(/^Details$/i, /^(Materials \/ Care|Delivery|Production)$/i),
        materials: sectionText(/^Materials \/ Care$/i, /^(Delivery|Production|Official|SKIP)$/i),
        pageImages,
        html: document.documentElement?.outerHTML || '',
      };
    });

    const parseSrcsetUrls = (value = '') => String(value || '').split(',').map((part) => part.trim().split(/\s+/)[0]).filter(Boolean);
    const domImageUrls = (info.pageImages || [])
      .flatMap((item) => [cleanImageUrl(item.src), ...parseSrcsetUrls(item.srcset).map(cleanImageUrl)])
      .filter(isLikelyGuProductImage);
    const htmlImageUrls = extractUniqloImageUrlCandidates([info.html]).filter(isLikelyGuProductImage);
    const productId = info.productId || normalized.sku;
    const seedImageUrls = [...new Set([...capturedUrls, ...domImageUrls, ...htmlImageUrls])].filter(isLikelyGuProductImage);
    const probedImageUrls = await findExistingGuCdnImages(productId, seedImageUrls, emitLog);
    const imageUrls = filterUniqloProductImages([...new Set([...seedImageUrls, ...probedImageUrls])], [productId]).slice(0, 14);
    const description = [info.features, info.details].filter(Boolean).join('\n').trim();
    const compositionText = extractUniqloCompositionText(info.materials) || extractUniqloCompositionText(info.bodyText);

    emitLog(`✅ GU ${productId} captured | ${info.title || 'Untitled'} | ${imageUrls.length} images`, imageUrls.length > 0 ? 'success' : 'warning');
    return {
      styleNumber: productId,
      productId,
      brand: 'GU',
      name: info.title || `GU ${productId}`,
      price: info.price || '',
      colorRef: info.colorRef || '',
      description,
      composition: { outerShell: null, lining: null, other: compositionText || null },
      url: normalized.url,
      imageUrls,
      pageText: info.bodyText || '',
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function runSingleBrandProductScraper(config, emitLog, emitProgress, taskController, options = {}) {
  let { styleNumbers, excelPath, outputDir, downloadConcurrency } = config;
  styleNumbers = normalizeManualStyleNumbers(styleNumbers);
  const ensureActive = () => taskController?.throwIfCancelled?.();
  let browser = null;
  const {
    brandKey,
    brandLabel,
    defaultFolder,
    sessionDir,
    useSystemChromeProfile = false,
    baseUrl,
    idLabel,
    scrapeProduct,
    normalizeReference,
    imageMapBuilder,
    resultSuffix,
    concurrency = 2,
  } = options;

  if (excelPath) {
    try {
      ensureActive();
      emitLog(`Reading Excel file: ${excelPath}`, 'info');
      const workbook = XLSX.readFile(excelPath);
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      styleNumbers = [];
      const range = XLSX.utils.decode_range(worksheet['!ref'] || 'A1:B1');
      for (let row = 1; row <= range.e.r; row += 1) {
        const cellAddress = XLSX.utils.encode_cell({ r: row, c: 1 });
        const cell = worksheet[cellAddress];
        if (cell) {
          const displayValue = String(cell.w ?? cell.v ?? '').replace(/\u00a0/g, ' ').trim();
          if (displayValue) {
            styleNumbers.push(displayValue);
            emitLog(`📥 Excel row ${row + 1} column B: "${displayValue}"`, 'info');
          }
        }
      }
      emitLog(`Loaded ${styleNumbers.length} ${brandLabel} ${idLabel} values from Excel.`, 'success');
    } catch (error) {
      throw new Error(`Excel parse failed: ${error.message}`);
    }
  }

  ensureActive();
  if (!styleNumbers || styleNumbers.length === 0) {
    throw new Error(`No ${brandLabel} ${idLabel} values were found. Put the values in column B or enter them manually.`);
  }

  const targetDir = !outputDir || outputDir === '未选择' ? path.join(app.getPath('desktop'), defaultFolder) : outputDir;
  fs.mkdirSync(targetDir, { recursive: true });
  emitLog(`📁 Output directory: ${targetDir}`, 'info');
  emitLog(`🌐 Launching the English ${brandLabel} scraper session...`, 'info');

  let executablePath = findChromePath();
  if (!executablePath) {
    emitLog('⬇️ No local Chrome was found. Downloading a managed Chrome runtime for GS Bot...', 'warning');
    const chromeInstall = await ensureChromeRuntimeAvailable((payload) => {
      if (payload?.status) emitLog(payload.status, payload.phase === 'complete' ? 'success' : 'info');
    });
    if (!chromeInstall?.success) throw new Error(chromeInstall?.error || 'Chrome download failed.');
    executablePath = chromeInstall.executablePath;
  }

  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: false,
      userDataDir: sessionDir(),
      args: antiDetection.getRetailLaunchArgs(),
      ignoreDefaultArgs: ['--enable-automation'],
      defaultViewport: null,
    });
    taskController?.onCancel(() => {
      if (browser && browser.isConnected()) browser.close().catch(() => {});
    });

    const products = [];
    const totalItems = styleNumbers.length;
    emitProgress(5);
    for (let index = 0; index < totalItems; index += concurrency) {
      ensureActive();
      const batch = styleNumbers.slice(index, index + concurrency);
      emitLog(`🔄 Processing ${brandLabel} batch ${Math.floor(index / concurrency) + 1}`, 'warning');
      const batchResults = await Promise.all(batch.map(async (reference) => {
        const normalized = normalizeReference(reference);
        emitLog(`🎯 ${brandLabel} input raw: "${reference}"${normalized?.sku ? ` -> ${idLabel} ${normalized.sku}` : ''}`, 'info');
        let lastError = null;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          try {
            ensureActive();
            if (attempt > 1) {
              emitLog(`    🔄 Retrying ${brandLabel} reference (${attempt}/2): ${reference}`, 'warning');
              await antiDetection.randomDelay(1500, 2600);
            }
            return await scrapeProduct(browser, reference, emitLog, ensureActive);
          } catch (error) {
            if (isCancellationError(error) || taskController?.cancelled) throw new TaskCancelledError();
            if (isScraperSiteBlockedError(error)) {
              emitLog(`    ⛔ ${brandLabel} site blocked: ${error.message}`, 'error');
              throw error;
            }
            lastError = error;
            emitLog(`    ⚠️ ${brandLabel} reference failed (${attempt}/2): ${reference} -> ${error.message}`, 'warning');
          }
        }
        return {
          styleNumber: normalized?.sku || reference,
          productId: normalized?.sku || reference,
          brand: brandLabel,
          url: '',
          error: lastError?.message || 'Unknown error',
          imageUrls: [],
          imageMap: {},
        };
      }));
      products.push(...batchResults);
      emitProgress(5 + Math.round(((index + batch.length) / totalItems) * 45));
      if (index + concurrency < totalItems) await antiDetection.randomDelay(1400, 2400);
    }

    emitLog(`🌐 ${brandLabel} page extraction complete. Preparing image downloads...`, 'warning');
    const successProducts = products.filter((product) => product.imageUrls && product.imageUrls.length > 0);
    const failedProducts = products.filter((product) => !product.imageUrls || product.imageUrls.length === 0);
    const allTasks = [];

    for (const product of successProducts) {
      ensureActive();
      const cleanStyleNumber = sanitizeFileSegment(String(product.productId || product.styleNumber || '').replace(/[\\/]/g, '-'), `${brandKey}-item`);
      const styleDir = path.join(targetDir, cleanStyleNumber);
      fs.mkdirSync(styleDir, { recursive: true });
      const classified = product.imageMap && Object.keys(product.imageMap).length > 0 ? product.imageMap : imageMapBuilder(product.imageUrls || []);
      for (const [label, imgUrl] of Object.entries(classified)) {
        const ext = getUrlExtension(imgUrl, '.jpg');
        const filename = `${cleanStyleNumber}_${label}${ext}`;
        const filePath = path.join(styleDir, filename);
        allTasks.push(() => downloadFile(imgUrl, filePath, {
          headers: { Referer: product.url || baseUrl, 'User-Agent': 'Mozilla/5.0' },
          timeoutMs: 45000,
        }).then((size) => {
          if (size) emitLog(`    ⬇️ [saved] ${filename} (${size.toFixed(1)} KB)`);
        }).catch((error) => emitLog(`    ❌ [failed] ${filename}: ${error.message}`, 'error')));
      }
      const infoData = {
        styleNumber: product.productId || product.styleNumber,
        brand: product.brand || brandLabel,
        name: product.name,
        price: product.price,
        colorRef: product.colorRef,
        description: product.description,
        weight: product.weight || '',
        composition: product.composition || null,
        url: product.url,
        images: classified,
      };
      fs.writeFileSync(path.join(styleDir, `${cleanStyleNumber}_info.json`), JSON.stringify(infoData, null, 2), 'utf-8');
      emitLog(`📄 Saved product metadata: ${cleanStyleNumber}_info.json`, 'success');
    }

    emitLog(`📦 Downloading ${allTasks.length} ${brandLabel} images with ${downloadConcurrency} worker(s)...`, 'info');
    let completedTasks = 0;
    const tasksWithProgress = allTasks.map((task) => async () => {
      ensureActive();
      await task();
      completedTasks += 1;
      emitProgress(50 + Math.round((completedTasks / Math.max(allTasks.length, 1)) * 50));
    });
    if (tasksWithProgress.length > 0) await parallelLimit(tasksWithProgress, downloadConcurrency);
    emitProgress(100);

    fs.writeFileSync(path.join(targetDir, 'summary.json'), JSON.stringify(products.map((product) => ({
      styleNumber: product.productId || product.styleNumber,
      brand: product.brand || brandLabel,
      name: product.name,
      price: product.price,
      colorRef: product.colorRef,
      description: product.description || '',
      weight: product.weight || '',
      composition: product.composition || null,
      images: product.imageUrls ? product.imageUrls.length : 0,
      error: product.error || null,
    })), null, 2), 'utf-8');
    emitLog('📊 Saved summary.json', 'success');

    if (failedProducts.length > 0) {
      const failedSummary = failedProducts.map((product) => ({ styleNumber: product.productId || product.styleNumber, error: product.error || 'No product images found' }));
      fs.writeFileSync(path.join(targetDir, 'failed_styles.json'), JSON.stringify(failedSummary, null, 2), 'utf-8');
      fs.writeFileSync(path.join(targetDir, 'failed_styles.txt'), failedSummary.map((item) => `${item.styleNumber}\t${item.error}`).join('\n'), 'utf-8');
      emitLog('📄 Saved failed_styles.json', 'success');
      emitLog('📄 Saved failed_styles.txt', 'success');
    }

    if (excelPath) {
      try {
        const workbook = XLSX.readFile(excelPath);
        const sheetName = workbook.SheetNames[0];
        const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1 });
        const resultMap = new Map();
        products.forEach((product) => {
          const key = String(product.productId || product.styleNumber || '').trim();
          if (key) resultMap.set(key, product);
        });
        if (!rows[0]) rows[0] = [];
        rows[0][2] = 'Status';
        rows[0][3] = 'Image Count';
        rows[0][4] = 'Error';
        for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
          const row = rows[rowIndex] || [];
          const rawValue = String(row[1] || '').replace(/\u00a0/g, ' ').trim();
          if (!rawValue) continue;
          const normalized = normalizeReference(rawValue);
          const matched = resultMap.get(normalized?.sku || rawValue) || resultMap.get(rawValue);
          row[2] = matched ? ((matched.imageUrls || []).length > 0 ? 'Success' : 'Failed') : 'Not processed';
          row[3] = matched?.imageUrls ? matched.imageUrls.length : 0;
          row[4] = matched?.error || '';
          rows[rowIndex] = row;
        }
        workbook.Sheets[sheetName] = XLSX.utils.aoa_to_sheet(rows);
        const parsedExcelPath = path.parse(excelPath);
        const annotatedPath = path.join(parsedExcelPath.dir, `${parsedExcelPath.name}_${resultSuffix}_results${parsedExcelPath.ext}`);
        XLSX.writeFile(workbook, annotatedPath);
        emitLog(`📄 Saved annotated Excel: ${path.basename(annotatedPath)}`, 'success');
      } catch (error) {
        emitLog(`⚠️ Could not save annotated ${brandLabel} Excel: ${error.message}`, 'warning');
      }
    }

    emitLog(`🎉 ${brandLabel} scraping finished. Files saved to: ${targetDir}`, 'success');
  } finally {
    if (browser && browser.isConnected()) await browser.close().catch(() => {});
  }
}

async function runGuScraper(config, emitLog, emitProgress, taskController, previewBridge = null) {
  return runSingleBrandProductScraper(config, emitLog, emitProgress, taskController, {
    brandKey: 'gu',
    brandLabel: 'GU',
    defaultFolder: 'GU',
    sessionDir: getGuSessionDir,
    baseUrl: GU_BASE_URL,
    idLabel: 'Product ID',
    scrapeProduct: scrapeGuProduct,
    normalizeReference: (value) => normalizeSixDigitReference(value, 'GU Product'),
    imageMapBuilder: buildUniqloImageMap,
    resultSuffix: 'gu',
    concurrency: 2,
  });
}

async function runMixedBrandScraper(config, emitLog, emitProgress, taskController, previewBridge = null) {
  const ensureActive = () => taskController?.throwIfCancelled?.();
  const { excelPath, outputDir, tabConcurrency, downloadConcurrency, mixedBrandEntries } = config;

  ensureActive();
  let entries = [];
  if (Array.isArray(mixedBrandEntries) && mixedBrandEntries.length > 0) {
    emitLog(`Using manual mixed-brand entries (${mixedBrandEntries.length} row(s))`, 'info');
    entries = mixedBrandEntries
      .map((entry) => {
        const rawBrand = String(entry?.brand ?? '').trim();
        const rawStyle = String(entry?.styleNumber ?? '').trim();
        if (!rawBrand || !rawStyle) return null;
        const normalizedBrand = normalizeScraperBrand(rawBrand);
        if (!normalizedBrand) return null;
        return { brand: normalizedBrand, styleNumber: rawStyle };
      })
      .filter(Boolean);
    if (entries.length === 0) {
      throw new Error('Mixed brand mode: no valid manual entries were provided.');
    }
  } else {
    if (!excelPath) {
      throw new Error('Mixed brand mode requires either an Excel file or manual style numbers per brand.');
    }
    emitLog(`Reading Excel file: ${excelPath}`, 'info');
    entries = loadMixedBrandExcelQueue(excelPath, emitLog);
    if (entries.length === 0) {
      throw new Error('No supported mixed-brand rows were found. Use column A for brand and column B for style number.');
    }
  }

  const targetRoot = !outputDir || outputDir === '未选择' ? path.join(app.getPath('desktop'), 'Mixed Brands') : outputDir;
  fs.mkdirSync(targetRoot, { recursive: true });
  emitLog(`📁 Output directory: ${targetRoot}`, 'info');

  const groups = new Map();
  entries.forEach((entry) => {
    const bucket = groups.get(entry.brand) || [];
    bucket.push(entry.styleNumber);
    groups.set(entry.brand, bucket);
  });

  const brandOrder = ['zara', 'bershka', 'stradivarius', 'pullandbear', 'lefties', 'mango', 'reserved', 'sinsay', 'urbanrevivo', 'newyorker', 'hm', 'uniqlo', 'gu', 'abercrombie'];
  const groupedBrands = [...groups.keys()].sort((left, right) => {
    const leftIndex = brandOrder.indexOf(left);
    const rightIndex = brandOrder.indexOf(right);
    return (leftIndex === -1 ? 999 : leftIndex) - (rightIndex === -1 ? 999 : rightIndex);
  });

  const totalItems = entries.length;
  let processedItems = 0;
  emitProgress(2);

  const scraperMap = {
    zara: runScraper,
    bershka: runBershkaScraper,
    stradivarius: runStradivariusScraper,
    pullandbear: runPullAndBearScraper,
    lefties: runLeftiesScraper,
    mango: runMangoScraper,
    reserved: runReservedScraper,
    sinsay: runSinsayScraper,
    urbanrevivo: runUrbanRevivoScraper,
    newyorker: runNewYorkerScraper,
    hm: runHmScraper,
    uniqlo: runUniqloScraper,
    gu: runGuScraper,
    abercrombie: runAbercrombieScraper,
  };

  for (const brand of groupedBrands) {
    ensureActive();
    const brandStyles = groups.get(brand) || [];
    const folderName = getScraperOutputFolderName(brand);
    const brandOutputDir = path.join(targetRoot, folderName);
    fs.mkdirSync(brandOutputDir, { recursive: true });
    emitLog(`🚀 Mixed queue -> ${folderName}: ${brandStyles.length} style(s)`, 'warning');

    const baseProgress = Math.round((processedItems / totalItems) * 100);
    const span = Math.max(1, Math.round((brandStyles.length / totalItems) * 100));
    const mappedProgress = (value) => {
      const normalizedValue = Math.max(0, Math.min(100, Number(value) || 0));
      emitProgress(Math.min(100, baseProgress + Math.round((normalizedValue / 100) * span)));
    };

    const runner = scraperMap[brand];
    if (!runner) {
      emitLog(`⚠️ No scraper registered for brand "${brand}". Skipping.`, 'warning');
      processedItems += brandStyles.length;
      continue;
    }

    await runner({
      brand,
      styleNumbers: brandStyles,
      excelPath: null,
      outputDir: brandOutputDir,
      tabConcurrency,
      downloadConcurrency,
    }, emitLog, mappedProgress, taskController, previewBridge);

    processedItems += brandStyles.length;
    emitProgress(Math.round((processedItems / totalItems) * 100));
  }
}

function extractSectionFromText(text = '', headings = [], stops = []) {
  if (!text) {
    return '';
  }

  const lines = String(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const headingIndex = lines.findIndex((line) =>
    headings.some((heading) => line.toUpperCase() === heading.toUpperCase()),
  );

  if (headingIndex === -1) {
    return '';
  }

  const collected = [];
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (
      stops.some((stop) => line.toUpperCase() === stop.toUpperCase())
      || /^ADD TO BAG$/i.test(line)
      || /^SHOP /i.test(line)
    ) {
      break;
    }
    collected.push(line);
  }

  return collected.join(' ').trim();
}

function parseLdJsonDescription(text = '') {
  if (!text) {
    return '';
  }

  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && typeof parsed.description === 'string') {
      return parsed.description.trim();
    }
  } catch {
    return '';
  }

  return '';
}

function normalizeBershkaReference(reference = '') {
  const value = String(reference || '').trim();
  if (!value) return {};
  const firstPart = value.split('/')[0] || value;
  const styleCode = firstPart.replace(/\D/g, '');
  const compactDigits = (value.match(/\d+/g) || []).join('');
  const searchTerms = [
    value,
    compactDigits,
    styleCode,
  ].map((item) => String(item || '').trim()).filter(Boolean);
  return { searchTerms: [...new Set(searchTerms)], raw: value, styleCode, compactDigits };
}

function normalizeBershkaDescription(title = '', ...candidates) {
  const normalizedTitle = String(title || '').trim();
  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (!value) {
      continue;
    }

    if (normalizedTitle && value.toLowerCase() === normalizedTitle.toLowerCase()) {
      continue;
    }

    return value.replace(/\s+/g, ' ').trim();
  }

  return '';
}

function formatBershkaCompositionSection(section = {}) {
  const label = String(section?.description || '').trim().toUpperCase();
  const components = Array.isArray(section?.components) ? section.components : [];
  const componentText = components
    .map((component) => {
      const percentage = String(component?.percentage || '').trim();
      const material = String(component?.material || '').trim();
      if (percentage && material) {
        return `${percentage} ${material}`;
      }
      return percentage || material;
    })
    .filter(Boolean)
    .join(', ');

  if (!label) {
    return componentText;
  }

  if (!componentText) {
    return label;
  }

  return `${label}: ${componentText}`;
}

function formatStradivariusCompositionDetails(parts = [], cares = []) {
  const sections = Array.isArray(parts)
    ? parts.map((entry) => formatBershkaCompositionSection(entry)).filter(Boolean)
    : [];
  const careLines = Array.isArray(cares)
    ? cares
      .map((entry) => String(entry?.description || entry?.name || '').trim())
      .filter(Boolean)
    : [];

  let outerShell = null;
  let lining = null;
  const otherParts = [];

  sections.forEach((line) => {
    if (/^OUTER SHELL:/i.test(line)) {
      outerShell = line.replace(/^OUTER SHELL:\s*/i, '').trim() || null;
      return;
    }
    if (/^LINING:/i.test(line)) {
      lining = line.replace(/^LINING:\s*/i, '').trim() || null;
      return;
    }
    otherParts.push(line);
  });

  if (careLines.length > 0) {
    otherParts.push(`CARE: ${careLines.join(' | ')}`);
  }

  return {
    outerShell,
    lining,
    other: otherParts.length > 0 ? otherParts.join(' | ') : null,
  };
}

function normalizeStradivariusCompositionParts(detail = {}) {
  const structuredParts = Array.isArray(detail?.compositionDetail?.parts)
    ? detail.compositionDetail.parts
    : [];

  if (structuredParts.length > 0) {
    return structuredParts;
  }

  const rawComposition = Array.isArray(detail?.composition) ? detail.composition : [];
  return rawComposition.map((section, index) => ({
    description: index === 0 ? 'OUTER SHELL' : `PART ${index + 1}`,
    components: Array.isArray(section?.composition)
      ? section.composition.map((component) => ({
        material: component?.material || component?.name || '',
        percentage: (() => {
          const rawValue = String(component?.percentage || component?.description || '').trim();
          if (!rawValue) {
            return '';
          }
          return rawValue.endsWith('%') ? rawValue : `${rawValue}%`;
        })(),
      }))
      : [],
  })).filter((section) => Array.isArray(section.components) && section.components.length > 0);
}

// ── Stradivarius reference normalization ─────────────────────────────────────
function normalizeStradivariusReference(reference = '') {
  const raw = String(reference || '').trim();
  if (!raw) return null;
  const parts = raw.split('/').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) {
    return { styleReference: raw, colorCode: null, input: raw, styleNumber: raw };
  }
  const colorCode = parts[parts.length - 1];
  const styleReference = parts.slice(0, 2).join('/');
  return { styleReference, colorCode, input: raw, styleNumber: parts[0] };
}

function normalizePullAndBearReference(reference = '') {
  const raw = String(reference || '').trim();
  if (!raw) return null;
  const parts = raw.split('/').map((part) => part.replace(/[^\d]/g, '')).filter(Boolean);
  const compactDigits = (raw.match(/\d+/g) || []).join('');

  if (parts.length >= 2) {
    const styleReference = `${parts[0].padStart(4, '0')}/${parts[1].padStart(3, '0')}`;
    const colorCode = parts[2] ? normalizeBershkaColorCode(parts[2]) : '';
    return {
      input: raw,
      compactDigits: `${parts[0]}${parts[1]}${colorCode}`,
      styleDigits: `${parts[0]}${parts[1]}`,
      paddedStyleDigits: `${parts[0]}${parts[1]}`.padStart(8, '0'),
      styleReference,
      colorCode,
      styleNumber: parts[0],
    };
  }

  const styleDigits = compactDigits.length >= 7 ? compactDigits.slice(0, 7) : compactDigits;
  const colorCode = compactDigits.length >= 10 ? normalizeBershkaColorCode(compactDigits.slice(7, 10)) : '';
  const styleReference = styleDigits.length >= 7 ? `${styleDigits.slice(0, 4)}/${styleDigits.slice(4, 7)}` : styleDigits;

  return {
    input: raw,
    compactDigits,
    styleDigits,
    paddedStyleDigits: styleDigits ? styleDigits.padStart(8, '0') : '',
    styleReference,
    colorCode,
    styleNumber: styleDigits.slice(0, 4) || raw,
  };
}

function formatBershkaCompositionDetails(composition = [], origin = '', cares = []) {
  const sections = Array.isArray(composition)
    ? composition.map((entry) => formatBershkaCompositionSection(entry)).filter(Boolean)
    : [];
  const careLines = Array.isArray(cares)
    ? cares.map((entry) => String(entry?.name || '').trim()).filter(Boolean)
    : [];
  const originLine = String(origin || '').trim();

  let outerShell = null;
  let lining = null;
  const otherParts = [];

  sections.forEach((line) => {
    if (/^OUTER SHELL:/i.test(line)) {
      outerShell = line.replace(/^OUTER SHELL:\s*/i, '').trim() || null;
      return;
    }
    if (/^LINING:/i.test(line)) {
      lining = line.replace(/^LINING:\s*/i, '').trim() || null;
      return;
    }
    otherParts.push(line);
  });

  if (originLine) {
    otherParts.push(`ORIGIN: ${originLine}`);
  }
  if (careLines.length > 0) {
    otherParts.push(`CARE: ${careLines.join(' | ')}`);
  }

  return {
    outerShell,
    lining,
    other: otherParts.length > 0 ? otherParts.join(' | ') : null,
  };
}

function normalizeBershkaDisplayReference(value = '') {
  const digits = (String(value || '').match(/\d+/g) || []).join('');
  if (digits.length >= 7) {
    return `${digits.slice(0, 4)}/${digits.slice(4, 7)}`;
  }
  return String(value || '').replace(/\s+/g, '').trim();
}

function normalizeBershkaColorCode(value = '') {
  const digits = String(value || '').replace(/[^\d]/g, '');
  return digits ? digits.padStart(3, '0').slice(-3) : '';
}

function getBershkaReferenceDigits(reference = '') {
  return (String(reference || '').match(/\d+/g) || []).join('');
}

function buildBershkaProductLookupKeys(reference = '') {
  const raw = String(reference || '').trim();
  const parts = raw.split('/').map((part) => part.replace(/[^\d]/g, '')).filter(Boolean);
  const compact = getBershkaReferenceDigits(raw);
  const styleDigits = parts.length >= 2 ? `${parts[0]}${parts[1]}` : compact.slice(0, 7);
  const colorDigits = parts[2] || compact.slice(7, 10);
  const keys = new Set();

  if (styleDigits) {
    keys.add(styleDigits);
    keys.add(styleDigits.padStart(8, '0'));
  }

  if (styleDigits && colorDigits) {
    keys.add(`${styleDigits}${colorDigits}`);
    keys.add(`${styleDigits.padStart(8, '0')}${normalizeBershkaColorCode(colorDigits)}`);
  }

  if (compact) {
    keys.add(compact);
    keys.add(compact.padStart(compact.length + 1, '0'));
  }

  return [...keys].filter(Boolean);
}

function getUrlExtension(url = '', fallback = '.jpg') {
  try {
    const parsed = new URL(url);
    const ext = path.extname(parsed.pathname || '');
    return ext || fallback;
  } catch {
    return fallback;
  }
}

function cleanImageUrl(url = '') {
  return String(url || '').split('?')[0].trim();
}

// Emit a consistent "captured / incomplete / substitute" log triple for the Inditex
// scrapers (Zara, Bershka, Stradivarius, Pull&Bear, Lefties).
// - Substitute = the SKU returned by typed search differs from what the user entered.
// - Success    = at least 1 image AND at least one of (description, composition).
// - Otherwise  = incomplete failure; the UI will not count it toward the success total.
function emitInditexScrapeResult({
  emitLog,
  brand,
  requestedReference,
  actualStyleNumber,
  productName,
  imageCount,
  hasDescription,
  hasComposition,
}) {
  const normalizeDigits = (value) => String(value || '').replace(/\D/g, '');
  const requestedDigits = normalizeDigits(requestedReference);
  const actualDigits = normalizeDigits(actualStyleNumber);
  // Strip leading zeros for comparison — Zara product IDs sometimes have
  // a leading zero that varies between user input and the URL-extracted form.
  const stripLeadingZeros = (s) => s.replace(/^0+/, '') || '0';
  const req = stripLeadingZeros(requestedDigits);
  const act = stripLeadingZeros(actualDigits);
  const isSubstitute = Boolean(
    req
    && act
    && req !== act
    && !act.startsWith(req)
    && !req.startsWith(act),
  );
  if (isSubstitute) {
    emitLog(`    🔁 ${brand} substitute resolved: ${requestedDigits} → ${actualDigits}`, 'warning');
  }

  const sku = actualStyleNumber || requestedDigits || '';
  const displayName = productName || `${brand} ${sku}`;
  const hasImages = Number(imageCount) > 0;
  const hasText = Boolean(hasDescription || hasComposition);
  if (hasImages && hasText) {
    emitLog(`✅ ${brand} ${sku} captured | ${displayName} | ${imageCount} images`, 'success');
    return { status: 'success', isSubstitute };
  }
  const missing = [];
  if (!hasImages) missing.push('0 images');
  if (!hasDescription) missing.push('no description');
  if (!hasComposition) missing.push('no composition');
  emitLog(`❌ ${brand} ${sku} incomplete | ${displayName} | ${missing.join(', ')}`, 'error');
  return { status: 'incomplete', isSubstitute };
}

function canonicalizeStradivariusImageUrl(url = '') {
  const cleaned = cleanImageUrl(url);
  if (!cleaned) {
    return '';
  }

  try {
    const parsed = new URL(cleaned);
    parsed.pathname = parsed.pathname.replace(/\/{2,}/g, '/');
    return parsed.toString();
  } catch {
    return cleaned.replace(/(^https?:\/\/[^/]+)\/+/i, '$1/').replace(/([^:]\/)\/+/g, '$1');
  }
}

function isLikelyBershkaProductImage(url = '') {
  const value = cleanImageUrl(url).toLowerCase();
  if (!value) {
    return false;
  }

  if (!/\.(jpg|jpeg|png|webp)$/i.test(value)) {
    return false;
  }

  if (
    value.includes('logo')
    || value.includes('sprite')
    || value.includes('icon')
    || value.includes('placeholder')
    || value.includes('favicon')
  ) {
    return false;
  }

  return value.includes('static.bershka.net');
}

function getBershkaImageTokens(styleNumber = '') {
  const tokens = new Set();
  const compactDigits = (String(styleNumber || '').match(/\d+/g) || []).join('');
  if (!compactDigits) {
    return [];
  }

  tokens.add(compactDigits);
  tokens.add(compactDigits.padStart(compactDigits.length + 1, '0'));
  return [...tokens];
}

function isRelevantBershkaProductImage(url = '', styleNumber = '') {
  if (!isLikelyBershkaProductImage(url)) {
    return false;
  }

  const filename = path.basename(cleanImageUrl(url)).toLowerCase();
  if (!/-(?:p|b|a\d+[a-z]*)\.(jpg|jpeg|png|webp)$/i.test(filename)) {
    return false;
  }

  const tokens = getBershkaImageTokens(styleNumber).map((item) => item.toLowerCase());
  if (tokens.length === 0) {
    return true;
  }

  if (tokens.some((token) => filename.includes(token))) {
    return true;
  }

  const styleDigits = (String(styleNumber || '').match(/\d+/g) || []).join('');
  const fileDigits = (filename.match(/\d+/g) || []).join('');
  if (!styleDigits || !fileDigits) {
    return false;
  }

  const prefix = styleDigits.slice(0, 4);
  const suffix = styleDigits.slice(-3);
  return Boolean(prefix && suffix && fileDigits.includes(prefix) && fileDigits.endsWith(suffix));
}

function parseBershkaImageMeta(url = '', fallbackIndex = 0) {
  const filename = path.basename(cleanImageUrl(url)).toLowerCase();
  const altMatch = filename.match(/-a(\d+)/i);

  if (/-b\.(jpg|jpeg|png|webp)$/i.test(filename)) {
    return { kind: 'back-flat', order: 999, altIndex: null };
  }

  if (altMatch) {
    return {
      kind: 'alt',
      order: Number.parseInt(altMatch[1], 10),
      altIndex: Number.parseInt(altMatch[1], 10),
    };
  }

  if (/-p\.(jpg|jpeg|png|webp)$/i.test(filename)) {
    return { kind: 'hero', order: -10, altIndex: null };
  }

  return { kind: 'misc', order: fallbackIndex + 100, altIndex: null };
}

function getBershkaImageOrder(url = '', fallbackIndex = 0) {
  const meta = parseBershkaImageMeta(url, fallbackIndex);
  if (meta.kind === 'back-flat') {
    return 999;
  }
  if (meta.kind === 'hero') {
    return -10;
  }
  return meta.order;
}

function buildBershkaImageMap(imageUrls = []) {
  const entries = imageUrls.map((url, index) => ({
    url,
    index,
    meta: parseBershkaImageMeta(url, index),
  }));

  const heroEntries = entries.filter((entry) => entry.meta.kind === 'hero');
  const altEntries = entries
    .filter((entry) => entry.meta.kind === 'alt')
    .sort((left, right) => left.meta.order - right.meta.order);
  const backEntry = entries.find((entry) => entry.meta.kind === 'back-flat') || null;
  const miscEntries = entries
    .filter((entry) => entry.meta.kind === 'misc')
    .sort((left, right) => left.index - right.index);

  const frontFlatEntry = altEntries.length > 0
    ? altEntries[altEntries.length - 1]
    : (heroEntries[0] || null);

  const classified = {};
  const usedUrls = new Set();

  const register = (label, entry) => {
    if (!entry || usedUrls.has(entry.url) || classified[label]) {
      return;
    }
    classified[label] = entry.url;
    usedUrls.add(entry.url);
  };

  register('F', frontFlatEntry);

  const numberedEntries = [
    ...heroEntries.filter((entry) => !frontFlatEntry || entry.url !== frontFlatEntry.url),
    ...altEntries.filter((entry) => !frontFlatEntry || entry.url !== frontFlatEntry.url),
    ...miscEntries,
  ];

  let nextNumber = 1;
  numberedEntries.forEach((entry) => {
    while (classified[String(nextNumber).padStart(2, '0')]) {
      nextNumber += 1;
    }
    register(String(nextNumber).padStart(2, '0'), entry);
    nextNumber += 1;
  });

  register('B', backEntry);
  return classified;
}

// ── Bershka URL resolution ───────────────────────────────────────────────────
const BERSHKA_SEARCH_URL = 'https://www.bershka.com/es/en/search.html';
const BERSHKA_HOME_URL = 'https://www.bershka.com/es/en/h-woman.html';
// Confirmed working URL format: PATH-style /q/SKU on both Spanish English and US sites
const BERSHKA_DIRECT_QUERY_URLS = (q) => [
  `https://www.bershka.com/es/en/q/${encodeURIComponent(q)}`,
];
const buildBershkaManualSearchUrl = (q) =>
  `https://www.bershka.com/es/en/q/${encodeURIComponent(String(q || '').trim())}`;

async function extractBershkaSearchProductUrl(page, query, expectedDigits = '', isSearchPage = false) {
  return page.evaluate((q, expected, isSearch) => {
    const normalizeDigits = (value) => String(value || '').replace(/\D/g, '');
    const queryDigits = normalizeDigits(q);
    const expectedDigits = normalizeDigits(expected);
    const links = [...document.querySelectorAll('a[href*="bershka.com"], a[href^="/"]')];
    const candidates = links
      .map((link) => ({
        href: link.href,
        text: String(link.textContent || '').trim(),
      }))
      .filter((entry) => {
        const href = String(entry.href || '');
        return href
          && !href.includes('/search?')
          && !href.includes('/q?')
          && !href.endsWith('/search.html')
          && /bershka\.com\//i.test(href)
          && /-c0p\d+\.html/i.test(href);
      });

    const exact = candidates.find((entry) => {
      const combined = `${entry.href} ${entry.text}`;
      const digits = normalizeDigits(combined);
      return expectedDigits && digits.includes(expectedDigits);
    });
    if (exact?.href) {
      return exact.href;
    }

    const queryMatch = candidates.find((entry) => {
      const combined = `${entry.href} ${entry.text}`;
      return q && (combined.includes(q) || normalizeDigits(combined).includes(queryDigits));
    });
    if (queryMatch?.href) {
      return queryMatch.href;
    }

    // On a real search results page, use the first candidate ONLY if Bershka
    // is actually showing real search hits — i.e. there is NO "no results"
    // indicator on the page. When Bershka can't find the SKU it shows
    // recommendations instead; we must not grab those.
    if (isSearch && candidates.length > 0) {
      const bodyText = String(document.body?.innerText || '').toLowerCase();

      // 1. Explicit "no results" text in multiple languages Bershka uses
      const noResultsRe = /\b(?:no\s+results?\s*(?:found|for)?|sin\s+resultados|kein(?:e)?\s+ergebnisse|aucun\s+résultat|nessun\s+risultato|geen\s+resultaten|brak\s+wynik|没有结果|没找到|no\s+products?\s+found|nothing\s+matches|nothing\s+was\s+found|we\s+couldn.t\s+find|your\s+search\s+.*\s+(?:no\s+results?|did\s+not\s+return))\b/i;
      if (noResultsRe.test(bodyText)) return '';

      // 2. Bershka-specific result count showing 0 — "0 RESULTS" / "0 products"
      const zeroResultsRe = /\b0\s+(?:results?|products?|items?|artículos?|resultados?)\b/i;
      if (zeroResultsRe.test(bodyText)) return '';

      // 3. Structural "no results" element
      const noResultsEl = document.querySelector(
        '[class*="no-result" i], [class*="noResult" i], [data-testid*="no-result" i],'
        + ' [class*="empty-result" i], [class*="emptyResult" i], [class*="zero-result" i]',
      );
      if (noResultsEl) return '';

      return candidates[0].href;
    }
    return '';
  }, query, expectedDigits, isSearchPage);
}

async function focusBershkaSearchInput(page, query = '') {
  const opened = await page.evaluate(() => {
    const isVisible = (element) => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return style.visibility !== 'hidden' && style.display !== 'none' && style.pointerEvents !== 'none';
    };
    const normalize = (value) => String(value || '').trim().toLowerCase();
    const controls = [...document.querySelectorAll('button,a,[role="button"],[tabindex]')];
    const opener = controls.find((element) => {
      if (!isVisible(element)) return false;
      const text = normalize([
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
        element.getAttribute('data-testid'),
        element.getAttribute('href'),
        element.className,
        element.textContent,
      ].join(' '));
      return /\b(search|buscar)\b/.test(text) || /\/search/i.test(text);
    });
    if (opener) {
      opener.click();
      return true;
    }
    return false;
  }).catch(() => false);

  if (opened) {
    await antiDetection.randomDelay(500, 900);
  }

  return page.evaluate((searchQuery) => {
    const isInteractive = (element) => {
      if (!element) return false;
      const style = window.getComputedStyle(element);
      if (style.visibility === 'hidden' || style.display === 'none') return false;
      if (element.offsetWidth === 0 && element.offsetHeight === 0) return false;
      return true;
    };
    const normalize = (value) => String(value || '').trim().toLowerCase();

    const inputs = [...document.querySelectorAll('input[type="text"],input[type="search"],input:not([type]),textarea,[contenteditable="true"]')].filter(isInteractive);

    const getHaystack = (element) => normalize([
        element.getAttribute('type'),
        element.getAttribute('name'),
        element.getAttribute('aria-label'),
        element.getAttribute('placeholder'),
        element.getAttribute('data-testid'),
        element.getAttribute('id'),
        element.className,
        element.closest('form')?.getAttribute('action'),
        element.closest('form')?.className,
        element.closest('[role="search"]')?.className,
        element.parentElement?.className,
        element.parentElement?.parentElement?.className,
      ].join(' '));

    const searchInput = inputs.find((element) => {
      const haystack = getHaystack(element);
      return /search|buscar|query|keyword|term/i.test(haystack);
    }) || inputs.find((element) => {
      const haystack = getHaystack(element);
      return /\bsearch\b/i.test(haystack);
    }) || inputs.find((element) => {
      const type = normalize(element.getAttribute('type'));
      return !type || ['text', 'search'].includes(type);
    });

    if (!searchInput) {
      return false;
    }

    searchInput.focus();
    searchInput.click();
    searchInput.scrollIntoView({ behavior: 'smooth', block: 'center' });

    const valueToType = String(searchQuery || '');
    if ('value' in searchInput) {
      const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (valueSetter && searchInput instanceof window.HTMLInputElement) {
        valueSetter.call(searchInput, valueToType);
      } else {
        searchInput.value = valueToType;
      }
      searchInput.dispatchEvent(new Event('input', { bubbles: true }));
      searchInput.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      searchInput.textContent = valueToType;
      searchInput.dispatchEvent(new InputEvent('input', { bubbles: true, data: valueToType }));
    }
    return true;
  }, String(query || '')).catch(() => false);
}

async function openBershkaSearchOverlay(page) {
  // Step 1: Try known specific search trigger selectors first
  const directSelectors = [
    '[data-testid="searchButton"]',
    '[data-testid="search-button"]',
    '[data-testid="header-search"]',
    '[data-qa-id="searchBtn"]',
    '[data-qa-action="open-search"]',
    'button[aria-label="Search"]',
    'button[aria-label="Buscar"]',
    'button[aria-label="Cerca"]',
    'button[aria-label="Recherche"]',
    'button[aria-label="Suche"]',
    'header button[aria-label*="search" i]',
    'header button[aria-label*="buscar" i]',
    'nav button[aria-label*="search" i]',
  ];
  for (const sel of directSelectors) {
    try {
      const handle = await page.$(sel);
      if (handle) {
        const visible = await handle.isIntersectingViewport().catch(() => true);
        if (visible) {
          await handle.click({ delay: 50 }).catch(() => {});
          return true;
        }
      }
    } catch { /* ignore */ }
  }

  // Step 2: Fallback - scan all buttons in header/nav for search-like attributes
  return page.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const s = window.getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
    };
    const candidates = [...document.querySelectorAll('button, a[href], [role="button"], [tabindex]')];
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const containerOk = el.closest('header, nav, [role="banner"], [class*="header" i], [class*="Header"]');
      if (!containerOk) continue;
      const haystack = [
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
        el.getAttribute('data-testid'),
        el.getAttribute('data-qa-id'),
        el.getAttribute('data-qa-action'),
        el.className,
        el.id,
      ].join(' ').toLowerCase();
      if (/\b(search|buscar|cerca|recherche|suche|szukaj)\b/.test(haystack)) {
        el.click();
        return true;
      }
    }
    return false;
  });
}

async function findVisibleBershkaSearchInput(page) {
  return page.evaluateHandle(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 6) return false;
      const s = window.getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
    };
    const inputs = [...document.querySelectorAll(
      'input[type="search"], input[type="text"], input:not([type]), textarea, [contenteditable="true"]'
    )].filter(isVisible);

    const ranked = inputs.find((el) => {
      const haystack = [
        el.getAttribute('type'),
        el.getAttribute('name'),
        el.getAttribute('placeholder'),
        el.getAttribute('aria-label'),
        el.getAttribute('id'),
        el.getAttribute('data-testid'),
        el.getAttribute('data-qa-id'),
        el.className,
        el.closest('form')?.getAttribute('action'),
        el.closest('[role="search"]')?.className,
      ].join(' ').toLowerCase();
      return /search|buscar|query|keyword|term|cerca|recherche|suche/i.test(haystack);
    });

    return ranked || inputs[0] || null;
  });
}

async function searchBershkaByTyping(page, query, expectedDigits, emitLog, ensureActive) {
  emitLog(`    🔍 Searching Bershka by typing "${query}"…`, 'info');

  // Typed search only: navigate to the homepage, open the search overlay, and type the SKU.
  // The direct /q/{SKU} URL strategy has been removed per user request.
  await page.goto(BERSHKA_HOME_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await dismissCommonBershkaPopups(page);
  await page.waitForFunction(
    () => document.readyState === 'complete',
    { timeout: 15000 },
  ).catch(() => {});
  await antiDetection.randomDelay(1500, 2500);
  ensureActive();

  // Step 1: Click search trigger to open overlay
  emitLog('    🔎 Opening Bershka search overlay…', 'info');
  const opened = await openBershkaSearchOverlay(page);
  if (!opened) {
    emitLog('    ⚠️ Could not find/click search button on Bershka header; giving up on this reference.', 'warning');
    return '';
  }
  // Wait for overlay animation to finish — Bershka's overlay slides in over ~600ms
  await antiDetection.randomDelay(1500, 2200);
  ensureActive();

  // Step 2: Wait for a visible input to appear (post-overlay) — be patient, overlay can hydrate slowly
  let inputHandle = null;
  try {
    await page.waitForFunction(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 20 || r.height < 6) return false;
        const s = window.getComputedStyle(el);
        return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
      };
      const inputs = [...document.querySelectorAll(
        'input[type="search"], input[type="text"], input:not([type]), textarea, [contenteditable="true"]'
      )];
      return inputs.some(isVisible);
    }, { timeout: 14000, polling: 250 });
    inputHandle = await findVisibleBershkaSearchInput(page);
  } catch {
    inputHandle = null;
  }

  // If still not found, try one more click on the overlay opener and re-poll
  let inputElement = inputHandle ? inputHandle.asElement() : null;
  if (!inputElement) {
    emitLog('    🔁 Search input not visible yet; reopening overlay and waiting longer…', 'info');
    await openBershkaSearchOverlay(page).catch(() => false);
    await antiDetection.randomDelay(1500, 2500);
    try {
      await page.waitForFunction(() => {
        const inputs = [...document.querySelectorAll('input[type="search"], input[type="text"], input:not([type]), textarea')];
        return inputs.some((el) => {
          const r = el.getBoundingClientRect();
          const s = window.getComputedStyle(el);
          return r.width >= 20 && r.height >= 6 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
        });
      }, { timeout: 10000, polling: 250 });
      inputHandle = await findVisibleBershkaSearchInput(page);
      inputElement = inputHandle ? inputHandle.asElement() : null;
    } catch {
      inputElement = null;
    }
  }

  if (!inputElement) {
    emitLog('    ⚠️ Bershka search input did not appear after opening overlay; giving up on this reference.', 'warning');
    return '';
  }

  // Step 3: Click into the input and type human-like
  try {
    await inputElement.click({ delay: 80 });
  } catch {
    await page.evaluate((el) => el.focus(), inputElement).catch(() => {});
  }
  await antiDetection.randomDelay(300, 600);

  emitLog(`    ⌨️ Typing Bershka search "${query}" via DOM write…`, 'info');
  await writeSearchValueViaDOM(page, inputElement, query, emitLog, 'Bershka');
  ensureActive();

  // Wait for either navigation or search-result hydration — be patient; some SKUs are slow to resolve
  emitLog('    ⏳ Waiting for search results…', 'info');
  await Promise.race([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null),
    page.waitForFunction(
      () => [...document.querySelectorAll('a[href*="-c0p"]')].length > 0,
      { timeout: 20000, polling: 400 },
    ).catch(() => null),
  ]);
  await antiDetection.randomDelay(1500, 2400);
  ensureActive();

  // If still no product links rendered, press Enter once more (some search UIs swallow the first Enter)
  let url = await extractBershkaSearchProductUrl(page, query, expectedDigits, true);
  if (!url) {
    emitLog('    🔁 No results yet — pressing Enter again and waiting…', 'info');
    await page.keyboard.press('Enter').catch(() => {});
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null),
      page.waitForFunction(
        () => [...document.querySelectorAll('a[href*="-c0p"]')].length > 0,
        { timeout: 15000, polling: 400 },
      ).catch(() => null),
    ]);
    await antiDetection.randomDelay(1200, 2000);
    ensureActive();
    url = await extractBershkaSearchProductUrl(page, query, expectedDigits, true);
  }

  if (url) {
    emitLog(`    ✅ Found product: ${url.substring(url.lastIndexOf('/') + 1)}`, 'success');
  } else {
    emitLog('    ⚠️ No product found in search results', 'warning');
  }
  return url;
}

async function resolveBershkaProductUrl(browser, reference, emitLog, ensureActive, options = {}) {
  const norm = normalizeBershkaReference(reference);
  const queries = norm.searchTerms?.length ? norm.searchTerms : [norm.raw || reference];

  const page = await browser.newPage();
  await antiDetection.applyRetailBrowsingProfile(page);
  await page.setViewport(antiDetection.getRandomViewport());

  try {
    // Typed search only: skip the direct API/product lookup and go straight to
    // typing the style number into the on-site search box.
    for (const query of queries) {
      ensureActive();
      const typedProductUrl = await searchBershkaByTyping(
        page,
        query,
        norm.compactDigits || norm.styleCode || '',
        emitLog,
        ensureActive,
      ).catch((error) => {
        ensureActive();
        emitLog(`    ⚠️ Bershka typed search failed: ${error.message}`, 'warning');
        return '';
      });
      if (typedProductUrl) {
        return { url: typedProductUrl, input: reference };
      }
    }

    // Deep catalog lookup disabled per user request (too slow, low success rate)
    return { url: '', input: reference };
  } finally {
    await page.close().catch(() => {});
  }
}

async function fetchBershkaJson(page, url) {
  const payload = await page.evaluate(async (targetUrl) => {
    const response = await fetch(targetUrl, {
      credentials: 'include',
      headers: {
        Accept: 'application/json, text/plain, */*',
      },
    });
    const text = await response.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    return {
      ok: response.ok,
      status: response.status,
      text: text.slice(0, 1200),
      data,
    };
  }, url);

  if (!payload.ok || !payload.data) {
    throw new Error(`Bershka API request failed (${payload.status}): ${payload.text || 'No response body'}`);
  }

  return payload.data;
}

async function ensureBershkaApiContext(page, ensureActive = () => {}) {
  const currentUrl = (() => {
    try {
      return page.url();
    } catch {
      return '';
    }
  })();

  if (/^https:\/\/www\.bershka\.com\/(?:es\/en|us)\//i.test(currentUrl)) {
    return;
  }

  await page.goto('https://www.bershka.com/es/en/h-woman.html', {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  }).catch(() => {});
  await antiDetection.randomDelay(900, 1400);
  ensureActive();
}

function flattenBershkaLeafCategoryIds(nodes = [], out = []) {
  for (const node of nodes || []) {
    const children = Array.isArray(node?.subcategories) ? node.subcategories : [];
    if (children.length === 0) {
      if (node?.id) {
        out.push(node.id);
      }
    } else {
      flattenBershkaLeafCategoryIds(children, out);
    }
  }
  return out;
}

async function getBershkaLeafCategoryIds(page) {
  if (Array.isArray(cachedBershkaLeafIds) && cachedBershkaLeafIds.length > 0) {
    return cachedBershkaLeafIds;
  }

  const treeUrl = `https://www.bershka.com/itxrest/2/catalog/store/${BERSHKA_STORE_ID}/${BERSHKA_CATALOG_ID}/category?appId=1&languageId=${BERSHKA_LANGUAGE_ID}&locale=${BERSHKA_LOCALE}`;
  const tree = await fetchBershkaJson(page, treeUrl);
  cachedBershkaLeafIds = flattenBershkaLeafCategoryIds(tree.categories || []);
  return cachedBershkaLeafIds;
}

function findBershkaColorMatch(product, item, colorCode = '') {
  const detailColors = Array.isArray(item?.detail?.colors) ? item.detail.colors : [];
  const productColors = Array.isArray(product?.detail?.colors) ? product.detail.colors : [];
  const bundleColors = Array.isArray(product?.bundleColors) ? product.bundleColors : [];
  const colors = [...detailColors, ...productColors, ...bundleColors];

  if (colorCode) {
    const normalizedColor = normalizeBershkaColorCode(colorCode);
    const exact = colors.find((color) =>
      normalizeBershkaColorCode(color?.id) === normalizedColor
      || String(color?.reference || '').includes(normalizedColor),
    );
    if (exact) {
      return exact;
    }
  }

  return colors[0] || null;
}

function matchBershkaProductByReference(product, normalized) {
  if (!product || !normalized) {
    return null;
  }

  const expectedReference = normalizeBershkaDisplayReference(normalized.raw || normalized.compactDigits || normalized.styleCode);
  const expectedColor = normalizeBershkaColorCode((String(normalized.raw || '').split('/')[2] || ''));
  const candidates = [...(Array.isArray(product.bundleProductSummaries) ? product.bundleProductSummaries : []), product];

  for (const item of candidates) {
    const displayReference = normalizeBershkaDisplayReference(item?.detail?.displayReference || product?.detail?.displayReference || '');
    if (!displayReference || displayReference !== expectedReference) {
      continue;
    }

    const color = findBershkaColorMatch(product, item, expectedColor);
    if (expectedColor && !color) {
      continue;
    }

    return { product, item, color };
  }

  return null;
}

function findBershkaColorByReference(product, colorCode = '') {
  const normalizedColor = normalizeBershkaColorCode(colorCode);
  const candidates = [...(Array.isArray(product?.bundleProductSummaries) ? product.bundleProductSummaries : []), product];
  for (const item of candidates) {
    const color = findBershkaColorMatch(product, item, normalizedColor);
    if (color) {
      return { item, color };
    }
  }
  return { item: candidates[0] || product, color: null };
}

function buildBershkaProductUrl(product, color = null) {
  const slug = String(product?.productUrl || '').trim();
  const pelement = product?.productUrlParam || product?.id || '';
  if (!slug || !pelement) {
    return '';
  }

  const baseSlug = slug.replace(/-l\d+$/i, '');
  const baseUrl = `https://www.bershka.com/us/${baseSlug}-c0p${pelement}.html`;
  const colorId = color?.id || '';
  return colorId ? `${baseUrl}?colorId=${encodeURIComponent(colorId)}` : baseUrl;
}

async function fetchBershkaProductByReference(page, reference, emitLog, ensureActive) {
  await ensureBershkaApiContext(page, ensureActive);

  const keys = buildBershkaProductLookupKeys(reference);
  const colorCode = normalizeBershkaColorCode((String(reference || '').split('/')[2] || ''));
  const endpoints = [];
  let loggedFetchFailure = false;

  keys.forEach((key) => {
    endpoints.push({
      type: 'moca',
      url: `https://www.bershka.com/itxrest/2/catalog/store/${BERSHKA_STORE_ID}/${BERSHKA_CATALOG_ID}/product/moca/${key}?appId=1&languageId=${BERSHKA_LANGUAGE_ID}&locale=${BERSHKA_LOCALE}`,
    });
    endpoints.push({
      type: 'partNumber',
      url: `https://www.bershka.com/itxrest/2/catalog/store/${BERSHKA_STORE_ID}/${BERSHKA_CATALOG_ID}/product/${key}?appId=1&languageId=${BERSHKA_LANGUAGE_ID}&locale=${BERSHKA_LOCALE}`,
    });
  });

  for (const endpoint of endpoints) {
    ensureActive();
    try {
      const product = await fetchBershkaJson(page, endpoint.url);
      if (!product?.id) {
        continue;
      }

      const matched = matchBershkaProductByReference(product, normalizeBershkaReference(reference))
        || {
          product,
          ...findBershkaColorByReference(product, colorCode),
        };
      const url = buildBershkaProductUrl(product, matched.color);
      if (!url) {
        continue;
      }

      emitLog(`    ✅ Bershka direct ${endpoint.type} matched: ${url}`, 'success');
      return {
        url,
        input: reference,
        styleNumber: reference,
      };
    } catch (error) {
      if (!/404|not found|_ERR_PRODUCT_NOT_FOUND/i.test(String(error.message || ''))) {
        if (/Failed to fetch/i.test(String(error.message || '')) && loggedFetchFailure) {
          continue;
        }
        loggedFetchFailure = loggedFetchFailure || /Failed to fetch/i.test(String(error.message || ''));
        emitLog(`    ⚠️ Bershka direct ${endpoint.type} lookup failed: ${error.message}`, 'warning');
      }
    }
  }

  return null;
}

async function resolveBershkaProductFromCatalog(page, reference, emitLog, ensureActive, options = {}) {
  const normalized = normalizeBershkaReference(reference);
  if (!normalized?.styleCode) {
    return null;
  }

  if (options.skipDirectLookup !== true) {
    const directMatch = await fetchBershkaProductByReference(page, reference, emitLog, ensureActive);
    if (directMatch?.url) {
      return directMatch;
    }
  }

  const expectedReference = normalizeBershkaDisplayReference(normalized.raw || normalized.compactDigits);
  const cachedMatch = cachedBershkaStyleMatches.get(expectedReference) || null;
  if (cachedMatch) {
    const matched = matchBershkaProductByReference(cachedMatch.product, normalized);
    if (matched) {
      const url = buildBershkaProductUrl(matched.product, matched.color);
      return { url, input: reference, styleNumber: normalized.raw };
    }
  }

  emitLog(`    🔎 Bershka catalog deep lookup for "${expectedReference}"…`, 'info');
  await ensureBershkaApiContext(page, ensureActive);

  const leafIds = await getBershkaLeafCategoryIds(page);
  let scannedCount = 0;
  for (const leafId of leafIds) {
    ensureActive();
    if (scannedBershkaLeafIds.has(leafId) && !cachedBershkaStyleMatches.has(expectedReference)) {
      continue;
    }
    scannedCount += 1;
    if (scannedCount === 1 || scannedCount % 20 === 0) {
      emitLog(`    🔎 Bershka catalog deep lookup progress: ${scannedCount}/${leafIds.length} categories`, 'info');
    }

    const listUrl = `https://www.bershka.com/itxrest/3/catalog/store/${BERSHKA_STORE_ID}/${BERSHKA_CATALOG_ID}/category/${leafId}/product?showProducts=false&languageId=${BERSHKA_LANGUAGE_ID}&appId=1&locale=${BERSHKA_LOCALE}`;
    let productIds = [];
    try {
      const listPayload = await fetchBershkaJson(page, listUrl);
      productIds = Array.isArray(listPayload.productIds) ? listPayload.productIds : [];
    } catch (error) {
      if (/404|blocked|no service match/i.test(String(error.message || ''))) {
        continue;
      }
      throw error;
    } finally {
      scannedBershkaLeafIds.add(leafId);
    }

    for (let chunkIndex = 0; chunkIndex < productIds.length; chunkIndex += 20) {
      ensureActive();
      const chunk = productIds.slice(chunkIndex, chunkIndex + 20);
      if (chunk.length === 0) {
        continue;
      }

      const arrayUrl = `https://www.bershka.com/itxrest/3/catalog/store/${BERSHKA_STORE_ID}/${BERSHKA_CATALOG_ID}/productsArray?languageId=${BERSHKA_LANGUAGE_ID}&appId=1&locale=${BERSHKA_LOCALE}&productIds=${chunk.join(',')}`;
      const productsPayload = await fetchBershkaJson(page, arrayUrl);
      const products = Array.isArray(productsPayload.products) ? productsPayload.products : [];

      for (const product of products) {
        const productReference = normalizeBershkaDisplayReference(product?.detail?.displayReference || '');
        if (productReference) {
          cachedBershkaStyleMatches.set(productReference, { product });
        }

        const matched = matchBershkaProductByReference(product, normalized);
        if (!matched) {
          continue;
        }

        const url = buildBershkaProductUrl(product, matched.color);
        if (!url) {
          continue;
        }

        emitLog(`    ✅ Bershka catalog matched ${expectedReference}: ${url}`, 'success');
        return {
          url,
          input: reference,
          styleNumber: normalized.raw,
        };
      }
    }
  }

  return null;
}

async function dismissCommonBershkaPopups(page) {
  try {
    const selectors = [
      '[data-cy="cookie-consent"] button[class*="accept"]',
      'button[class*="cookie"]',
      '[aria-label*="accept cookies"]',
    ];
    for (const sel of selectors) {
      const btn = await page.$(sel);
      if (btn) { await btn.click(); await page.waitForTimeout(500); }
    }
  } catch { /* ignore */ }
}

async function isBershkaBlockedPage(page) {
  try {
    const text = await page.evaluate(() => document.body?.innerText || '');
    return /access denied|blocked|suspicious activity|verify you are human/i.test(text);
  } catch {
    return false;
  }
}

function isLikelyStradivariusProductImage(url = '') {
  const value = cleanImageUrl(url).toLowerCase();
  if (!value) {
    return false;
  }

  if (!/\.(jpg|jpeg|png|webp)$/i.test(value)) {
    return false;
  }

  if (
    value.includes('placeholder')
    || value.includes('/cares/')
    || value.includes('/etiquetas/')
    || value.includes('/footer/')
    || value.includes('logo')
    || value.includes('sprite')
    || value.includes('icon')
    || value.endsWith('.svg')
  ) {
    return false;
  }

  return value.includes('static.e-stradivarius.net');
}

function extractStradivariusImageReferenceCode(url = '') {
  const filename = path.basename(canonicalizeStradivariusImageUrl(url)).toLowerCase();
  const match = filename.match(/^(\d+)-(?:m|b\d*|c\d+|a\d+|s\d+)\.(jpg|jpeg|png|webp)$/i);
  return match ? match[1] : '';
}

function isRelevantStradivariusProductImage(url = '', styleNumber = '') {
  if (!isLikelyStradivariusProductImage(url)) {
    return false;
  }

  const filename = path.basename(canonicalizeStradivariusImageUrl(url)).toLowerCase();
  if (!/-(?:m|b\d*|c\d+|a\d+|s\d+)\.(jpg|jpeg|png|webp)$/i.test(filename)) {
    return false;
  }

  const normalized = normalizeStradivariusReference(styleNumber);
  if (!normalized) {
    return true;
  }

  const firstPart = normalized.styleReference.split('/')[0] || '';
  const colorCode = normalized.colorCode || '';
  const referenceCode = extractStradivariusImageReferenceCode(filename);

  if (!referenceCode) {
    return false;
  }
  if (firstPart && !referenceCode.includes(firstPart)) {
    return false;
  }
  if (colorCode && !referenceCode.endsWith(colorCode)) {
    return false;
  }

  return true;
}

async function fetchStradivariusJson(page, url) {
  const payload = await page.evaluate(async (targetUrl) => {
    const response = await fetch(targetUrl, {
      credentials: 'include',
      headers: {
        Accept: 'application/json, text/plain, */*',
      },
    });
    const text = await response.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    return {
      ok: response.ok,
      status: response.status,
      text: text.slice(0, 3000),
      data,
    };
  }, url);

  if (!payload.ok || !payload.data) {
    throw new Error(`Stradivarius API request failed (${payload.status}): ${payload.text || 'No response body'}`);
  }

  return payload.data;
}

async function gotoStradivariusWithRetry(page, url, label = 'Stradivarius page', attempts = 3, options = {}) {
  let lastError = null;
  const {
    waitUntil = 'domcontentloaded',
    timeout = 25000,
  } = options;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await page.goto(url, { waitUntil, timeout });
      return;
    } catch (error) {
      lastError = error;
      const message = String(error?.message || '');
      if (!/ERR_CONNECTION_CLOSED|Navigation timeout/i.test(message) || attempt === attempts) {
        break;
      }
      await delay(700 * attempt);
    }
  }

  throw new Error(`${label} failed: ${lastError?.message || 'Unknown error'}`);
}

async function dismissCommonStradivariusPopups(page) {
  try {
    const selectors = [
      '#onetrust-accept-btn-handler',
      'button[id*="accept"]',
      'button[class*="accept"]',
      'button[data-testid*="accept"]',
      '[aria-label*="accept" i]',
      '[aria-label*="Accept" i]',
      '[data-testid*="cookie"] button',
    ];

    for (const selector of selectors) {
      const button = await page.$(selector);
      if (button) {
        await button.click().catch(() => {});
        await page.waitForTimeout(400).catch(() => {});
      }
    }
  } catch {
    // Ignore popup handling failures; scraping can continue without this.
  }
}

function flattenStradivariusLeafCategoryIds(nodes = [], out = []) {
  for (const node of nodes || []) {
    const children = Array.isArray(node?.subcategories) ? node.subcategories : [];
    if (children.length === 0) {
      if (node?.id) {
        out.push(node.id);
      }
    } else {
      flattenStradivariusLeafCategoryIds(children, out);
    }
  }
  return out;
}

async function getStradivariusLeafCategoryIds(page) {
  if (Array.isArray(cachedStradivariusLeafIds) && cachedStradivariusLeafIds.length > 0) {
    return cachedStradivariusLeafIds;
  }

  const tree = await fetchStradivariusJson(page, STRADIVARIUS_CATEGORY_TREE_URL);
  cachedStradivariusLeafIds = flattenStradivariusLeafCategoryIds(tree.categories || []);
  return cachedStradivariusLeafIds;
}

function buildStradivariusProductLookupKeys(reference = '') {
  const normalized = normalizeStradivariusReference(reference);
  if (!normalized) {
    return [];
  }

  const styleDigits = normalized.styleReference.replace(/[^\d]/g, '');
  const colorDigits = String(normalized.colorCode || '').replace(/[^\d]/g, '').padStart(3, '0').slice(-3);
  const keys = new Set();

  if (styleDigits) {
    keys.add(styleDigits);
    keys.add(styleDigits.padStart(8, '0'));
  }

  if (styleDigits && colorDigits) {
    keys.add(`${styleDigits}${colorDigits}`);
    keys.add(`${styleDigits.padStart(8, '0')}${colorDigits}`);
  }

  return [...keys].filter(Boolean);
}

function findStradivariusColorMatch(product, item, colorCode = '') {
  const detailColors = Array.isArray(item?.detail?.colors) ? item.detail.colors : [];
  const bundleColors = Array.isArray(product?.bundleColors) ? product.bundleColors : [];
  const exactMatcher = (color) => String(color?.id || '').trim() === String(colorCode || '').trim()
    || String(color?.reference || '').includes(String(colorCode || '').trim());

  if (colorCode) {
    const exactDetail = detailColors.find(exactMatcher);
    if (exactDetail) {
      return exactDetail;
    }
    const exactBundle = bundleColors.find(exactMatcher);
    if (exactBundle) {
      return exactBundle;
    }
  }

  return detailColors[0] || bundleColors[0] || null;
}

function matchStradivariusProductByReference(product, styleReference, colorCode = '') {
  if (!product) {
    return null;
  }

  const candidates = [...(Array.isArray(product.bundleProductSummaries) ? product.bundleProductSummaries : []), product];
  for (const item of candidates) {
    const displayReference = String(item?.detail?.displayReference || '').trim();
    if (!displayReference || displayReference !== styleReference) {
      continue;
    }

    const color = findStradivariusColorMatch(product, item, colorCode);
    return {
      product,
      item,
      displayReference,
      color,
    };
  }

  return null;
}

async function fetchStradivariusProductByReference(page, reference, emitLog, ensureActive) {
  const normalized = normalizeStradivariusReference(reference);
  if (!normalized) {
    return null;
  }

  const keys = buildStradivariusProductLookupKeys(reference);
  const endpoints = [];

  keys.forEach((key) => {
    endpoints.push({
      type: 'moca',
      url: `https://www.stradivarius.com/itxrest/2/catalog/store/${STRADIVARIUS_STORE_ID}/${STRADIVARIUS_CATALOG_ID}/product/moca/${key}?languageId=-1&appId=1&locale=en_US`,
    });
    endpoints.push({
      type: 'partNumber',
      url: `https://www.stradivarius.com/itxrest/2/catalog/store/${STRADIVARIUS_STORE_ID}/${STRADIVARIUS_CATALOG_ID}/product/${key}?languageId=-1&appId=1&locale=en_US`,
    });
  });

  for (const endpoint of endpoints) {
    ensureActive();
    try {
      const product = await fetchStradivariusJson(page, endpoint.url);
      if (!product?.id) {
        continue;
      }

      const matched = matchStradivariusProductByReference(product, normalized.styleReference, normalized.colorCode);
      if (!matched) {
        continue;
      }

      const resolved = {
        ...matched,
        input: normalized.input,
        styleNumber: normalized.styleNumber || normalized.styleReference,
        url: buildStradivariusProductUrl(product, matched.color),
      };

      cachedStradivariusStyleMatches.set(normalized.styleReference, resolved);
      emitLog(`✅ Stradivarius direct ${endpoint.type} matched: ${resolved.url}`, 'success');
      return resolved;
    } catch (error) {
      if (!/404|not found|_ERR_PRODUCT_NOT_FOUND/i.test(String(error.message || ''))) {
        emitLog(`⚠️ Stradivarius direct ${endpoint.type} lookup failed: ${error.message}`, 'warning');
      }
    }
  }

  return null;
}

async function extractStradivariusSearchProductUrl(page, query, expectedDigits = '', isSearchPage = false) {
  return page.evaluate((q, expected, isSearch) => {
    const normalizeDigits = (value) => String(value || '').replace(/\D/g, '');
    const queryDigits = normalizeDigits(q);
    const expectedDigitsNorm = normalizeDigits(expected);

    // Build the canonical Stradivarius style-code patterns from the query.
    // Stradivarius URLs use -l0<7 digits>. Build the 7-digit and 8-digit
    // (zero-padded) variants from whichever digits we have available.
    const stylePrefixes = new Set();
    const seedDigits = [queryDigits, expectedDigitsNorm].filter((value) => value && value.length >= 7);
    for (const seed of seedDigits) {
      // The style code is the first 7 digits of the SKU.
      const styleSeven = seed.slice(0, 7);
      if (styleSeven.length === 7) {
        stylePrefixes.add(styleSeven);
        stylePrefixes.add(`0${styleSeven}`);
      }
      // If the seed is already 8 digits with a leading zero, also add it bare.
      if (seed.length === 8 && seed.startsWith('0')) {
        stylePrefixes.add(seed);
        stylePrefixes.add(seed.slice(1));
      }
    }

    // Prefer the dedicated search-results container so we ignore recommended /
    // featured carousels that appear when there are zero real matches.
    const searchContainer = document.querySelector(
      '[data-testid*="search-result" i],'
      + ' [data-qa-id*="search-result" i],'
      + ' [class*="search-result" i],'
      + ' [class*="searchResult" i],'
      + ' [class*="grid-result" i],'
      + ' [class*="product-list" i],'
      + ' [class*="productList" i],'
      + ' [class*="catalog-grid" i],'
      + ' [class*="products-grid" i],'
      + ' section[class*="search" i] [class*="product" i],'
      + ' main [class*="product-grid" i]',
    );
    const scope = searchContainer && searchContainer.querySelector('a[href]')
      ? searchContainer
      : document;
    const links = [...scope.querySelectorAll('a[href*="stradivarius.com"], a[href^="/"]')];
    const candidates = links
      .map((link) => ({
        href: link.href,
        text: String(link.textContent || '').trim(),
      }))
      .filter((entry) => {
        const href = String(entry.href || '');
        if (!href) return false;
        if (href.includes('/search?') || href.includes('/q?') || href.endsWith('/search.html')) return false;
        if (!/stradivarius\.com\//i.test(href)) return false;
        // Stradivarius product URLs look like /us/{slug}-l01363541?colorId=...&pelement=501415398
        // (no .html, slug ends in -l<digits>, query usually has pelement)
        return /[?&]pelement=\d+/i.test(href)
          || /-l\d+(?:[?#/]|$)/i.test(href)
          || /-p\d+\.html/i.test(href)
          || /-c0p\d+\.html/i.test(href);
      });

    // 1. Strongest signal: URL contains "-l<prefix>" matching the style code (first 7 digits).
    //    This is the most reliable way to tell a real search hit from a featured recommendation.
    if (stylePrefixes.size > 0) {
      const prefixPattern = new RegExp(
        `-l(?:${[...stylePrefixes].map((p) => p).join('|')})(?:[?#/&_-]|$)`,
        'i',
      );
      const styleMatch = candidates.find((entry) => prefixPattern.test(entry.href));
      if (styleMatch?.href) return styleMatch.href;

      // 1b. Same prefix match but searched across the WHOLE document (not just
      //     the scoped search-results container) — covers cases where the
      //     site's grid doesn't expose any of our known container classes.
      if (scope !== document) {
        const allLinks = [...document.querySelectorAll('a[href*="stradivarius.com"], a[href^="/"]')];
        const allCandidates = allLinks
          .map((link) => ({ href: link.href, text: String(link.textContent || '').trim() }))
          .filter((entry) => {
            const href = String(entry.href || '');
            if (!href) return false;
            if (href.includes('/search?') || href.includes('/q?') || href.endsWith('/search.html')) return false;
            if (!/stradivarius\.com\//i.test(href)) return false;
            return /[?&]pelement=\d+/i.test(href)
              || /-l\d+(?:[?#/]|$)/i.test(href)
              || /-p\d+\.html/i.test(href)
              || /-c0p\d+\.html/i.test(href);
          });
        const fallbackMatch = allCandidates.find((entry) => prefixPattern.test(entry.href));
        if (fallbackMatch?.href) return fallbackMatch.href;
      }
    }

    // 2. Exact full-SKU match: URL+text digits contain the full expected SKU.
    const exact = candidates.find((entry) => {
      const combined = `${entry.href} ${entry.text}`;
      const digits = normalizeDigits(combined);
      return expectedDigitsNorm.length >= 7 && digits.includes(expectedDigitsNorm);
    });
    if (exact?.href) return exact.href;

    // 3. Query substring match: URL/text literally contains the query string or its digits.
    const queryMatch = candidates.find((entry) => {
      const combined = `${entry.href} ${entry.text}`;
      if (!q) return false;
      if (combined.includes(q)) return true;
      if (queryDigits.length >= 7 && normalizeDigits(combined).includes(queryDigits)) return true;
      return false;
    });
    if (queryMatch?.href) return queryMatch.href;

    // No real match. Do NOT fall back to candidates[0] — on a "no results" search page
    // that would return a featured/recommended product (e.g. "smart rustic shorts")
    // and silently substitute it for the user's intended SKU. Return empty so the
    // caller can try a shorter query variant or report the SKU as missing.
    return '';
  }, query, expectedDigits, isSearchPage);
}

async function openStradivariusSearchOverlay(page) {
  const directSelectors = [
    '[data-testid="searchButton"]',
    '[data-testid="search-button"]',
    '[data-testid="header-search"]',
    '[data-qa-id="searchBtn"]',
    '[data-qa-action="open-search"]',
    'button[aria-label="Search"]',
    'button[aria-label="Buscar"]',
    'button[aria-label="Cerca"]',
    'button[aria-label="Recherche"]',
    'button[aria-label="Suche"]',
    'header button[aria-label*="search" i]',
    'header button[aria-label*="buscar" i]',
    'nav button[aria-label*="search" i]',
  ];
  for (const sel of directSelectors) {
    try {
      const handle = await page.$(sel);
      if (handle) {
        const visible = await handle.isIntersectingViewport().catch(() => true);
        if (visible) {
          await handle.click({ delay: 50 }).catch(() => {});
          return true;
        }
      }
    } catch { /* ignore */ }
  }

  return page.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const s = window.getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
    };
    const candidates = [...document.querySelectorAll('button, a[href], [role="button"], [tabindex]')];
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const containerOk = el.closest('header, nav, [role="banner"], [class*="header" i], [class*="Header"]');
      if (!containerOk) continue;
      const haystack = [
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
        el.getAttribute('data-testid'),
        el.getAttribute('data-qa-id'),
        el.getAttribute('data-qa-action'),
        el.className,
        el.id,
      ].join(' ').toLowerCase();
      if (/\b(search|buscar|cerca|recherche|suche|szukaj)\b/.test(haystack)) {
        el.click();
        return true;
      }
    }
    return false;
  });
}

async function findVisibleStradivariusSearchInput(page) {
  return page.evaluateHandle(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 6) return false;
      const s = window.getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
    };
    const inputs = [...document.querySelectorAll(
      'input[type="search"], input[type="text"], input:not([type]), textarea, [contenteditable="true"]'
    )].filter(isVisible);

    const ranked = inputs.find((el) => {
      const haystack = [
        el.getAttribute('type'),
        el.getAttribute('name'),
        el.getAttribute('placeholder'),
        el.getAttribute('aria-label'),
        el.getAttribute('id'),
        el.getAttribute('data-testid'),
        el.getAttribute('data-qa-id'),
        el.className,
        el.closest('form')?.getAttribute('action'),
        el.closest('[role="search"]')?.className,
      ].join(' ').toLowerCase();
      return /search|buscar|query|keyword|term|cerca|recherche|suche/i.test(haystack);
    });

    return ranked || inputs[0] || null;
  });
}

async function clickFirstStradivariusProductCard(page, expectedDigits, emitLog) {
  const before = page.url();
  const expectedDigitsNorm = String(expectedDigits || '').replace(/\D/g, '');
  // Build the same -l<prefix> patterns the extractor uses, to avoid clicking
  // a recommended/featured card from a different style.
  const stylePrefixes = [];
  if (expectedDigitsNorm.length >= 7) {
    const seven = expectedDigitsNorm.slice(0, 7);
    stylePrefixes.push(seven, `0${seven}`);
  } else if (expectedDigitsNorm.length === 6) {
    const six = expectedDigitsNorm.slice(0, 6);
    stylePrefixes.push(six);
  }

  // Force lazy-loaded product cards to mount: scroll through the results
  // viewport a few times before evaluating selectors. Stradivarius's
  // /q/<sku> grid is virtualised and renders zero <a> tags until the user
  // scrolls into the results section.
  try {
    await page.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const steps = [0.2, 0.45, 0.7, 0.9, 0.5, 0];
      for (const ratio of steps) {
        window.scrollTo({ top: Math.floor(document.body.scrollHeight * ratio), behavior: 'instant' });
        await sleep(280);
      }
    });
  } catch { /* noop */ }
  // Wait for product anchors to actually mount in the DOM. Stradivarius's
  // React-hydrated grid renders zero <a href*="-l0"> until hydration is
  // complete; running the click selectors before that gives candidates=0
  // every time. Up to 12s.
  try {
    await page.waitForFunction(
      () => {
        const links = [...document.querySelectorAll('a[href*="-l0"], a[href*="pelement="]')];
        return links.some((a) => {
          const r = a.getBoundingClientRect();
          return r.width > 40 && r.height > 40;
        });
      },
      { timeout: 12000, polling: 400 },
    );
  } catch {
    // No anchors appeared — the search may legitimately be empty. Continue
    // and let the selectors run anyway so we get the diagnostic snippet.
  }
  await new Promise((r) => setTimeout(r, 600));

  const result = await page.evaluate((prefixesRaw, expectedRaw) => {
    const prefixes = Array.isArray(prefixesRaw) ? prefixesRaw : [];
    const expectedDigits = String(expectedRaw || '');
    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 20) return false;
      const s = window.getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
    };
    const productLinkRegex = /stradivarius\.com\/.*(?:[?&]pelement=\d+|-l\d{6,}|-p\d{4,}\.html|-c0p\d+\.html|\/product\/|\/p\/|\/-?\d{6,})/i;
    const isRecommendation = (href) => /from[-_]?recom|fromrecommendation|cross[-_]?sell|recommended/i.test(href);
    const hrefMatchesStyle = (href) => {
      if (!prefixes.length) return false;
      return prefixes.some((p) => new RegExp(`-l${p}(?:[?#/&_-]|$)`, 'i').test(href));
    };

    // Locate the dedicated search-results container. If it exists, Stradivarius
    // has explicitly placed real search hits inside it — those are safe to
    // click even if the style prefix doesn't match exactly.
    const containerCandidates = [...document.querySelectorAll(
      '[data-testid*="search-result" i],'
      + ' [data-qa-id*="search-result" i],'
      + ' [class*="search-result" i],'
      + ' [class*="searchResult" i],'
      + ' [class*="grid-result" i],'
      + ' [class*="product-list" i],'
      + ' [class*="productList" i],'
      + ' [class*="catalog-grid" i],'
      + ' [class*="products-grid" i],'
      + ' section[class*="search" i] [class*="product" i],'
      + ' main [class*="product-grid" i]',
    )];
    // Reject "containers" that are actually the search input box, placeholder
    // hint text, or any empty/tiny element. A real results grid must contain
    // at least one <img> AND not host an <input>/<textarea>/contenteditable.
    const searchContainer = containerCandidates.find((el) => {
      if (!el) return false;
      if (el.querySelector('input, textarea, [contenteditable="true"]')) return false;
      const text = String(el.textContent || '').trim();
      // Common placeholder hints to reject
      if (/^search by|^buscar|^search\.\.\.$/i.test(text) && text.length < 80) return false;
      const hasImg = !!el.querySelector('img');
      const hasLink = !!el.querySelector('a[href]');
      if (!hasImg && !hasLink) return false;
      const r = el.getBoundingClientRect();
      // Real result grids are big; placeholder chips/hints are tiny.
      if (r.width < 200 || r.height < 200) return false;
      return true;
    }) || null;

    const collectIn = (root) => [...root.querySelectorAll('a[href]')].filter((a) => {
      if (!isVisible(a)) return false;
      const href = a.href || '';
      if (!productLinkRegex.test(href)) return false;
      if (isRecommendation(href)) return false;
      return true;
    });

    // Pass A: style-prefix match anywhere on the page (always preferred when
    // we know the SKU's style code).
    const allLinks = collectIn(document);
    if (prefixes.length) {
      // Prefer a card wrapping an <img> for stability.
      const withImg = allLinks.find((a) => hrefMatchesStyle(a.href) && a.querySelector('img'));
      if (withImg) {
        withImg.scrollIntoView({ behavior: 'instant', block: 'center' });
        withImg.click();
        return { href: withImg.href, pass: 'A', candidates: allLinks.length, hasContainer: !!searchContainer };
      }
      const noImg = allLinks.find((a) => hrefMatchesStyle(a.href));
      if (noImg) {
        noImg.scrollIntoView({ behavior: 'instant', block: 'center' });
        noImg.click();
        return { href: noImg.href, pass: 'A', candidates: allLinks.length, hasContainer: !!searchContainer };
      }
    }

    // Pass B: digits-anywhere fuzzy match (full SKU or 7-digit prefix appears
    // anywhere inside href+text).
    if (expectedDigits.length >= 6) {
      const digitMatch = allLinks.find((a) => {
        const combined = `${a.href} ${String(a.textContent || '')}`.replace(/\D/g, '');
        return combined.includes(expectedDigits) || combined.includes(expectedDigits.slice(0, 7));
      });
      if (digitMatch) {
        digitMatch.scrollIntoView({ behavior: 'instant', block: 'center' });
        digitMatch.click();
        return { href: digitMatch.href, pass: 'B', candidates: allLinks.length, hasContainer: !!searchContainer };
      }
    }

    // Pass C: scope-anchored fallback. If a dedicated search-results container
    // exists AND has product cards, Stradivarius is telling us these are real
    // search hits — click the first one. This catches the case where the
    // user's SKU resolves to a product whose URL style-code prefix differs
    // from the SKU's first 7 digits (e.g. legacy refs, family codes).
    if (searchContainer) {
      const scopedLinks = collectIn(searchContainer);
      const scopedWithImg = scopedLinks.find((a) => a.querySelector('img'));
      const first = scopedWithImg || scopedLinks[0];
      if (first) {
        first.scrollIntoView({ behavior: 'instant', block: 'center' });
        first.click();
        return { href: first.href, pass: 'C', candidates: scopedLinks.length, hasContainer: true };
      }
    }

    // Pass D: last-ditch — only when a real search-results container exists.
    // Without that anchor, "all visible product links" on Stradivarius is
    // dominated by homepage recommendation carousels and would cause us to
    // click an unrelated product. So if there's no container, give up here
    // and let the caller try the next query variant.
    if (searchContainer) {
      const anyCard = allLinks.find((a) => a.querySelector('img')) || allLinks[0];
      if (anyCard) {
        anyCard.scrollIntoView({ behavior: 'instant', block: 'center' });
        anyCard.click();
        return { href: anyCard.href, pass: 'D', candidates: allLinks.length, hasContainer: true };
      }
    }

    // Pass E (new): search container exists but querySelectorAll('a[href]')
    // turned up nothing — Stradivarius may have rendered cards as <article>
    // or <div> with click handlers, or wrapped the <a> behind a shadow root.
    // Look for any element whose own attribute, data-*, or descendant text
    // exposes a -l0<digits> code or a pelement=, then synthesise a click.
    if (searchContainer) {
      const cards = [...searchContainer.querySelectorAll('article, [data-testid*="product" i], [data-qa-id*="product" i], [class*="product-card" i], [class*="productCard" i], [class*="grid-element" i], [class*="gridElement" i], li[class*="product" i], div[role="link"]')]
        .filter((el) => isVisible(el));
      let chosenHref = '';
      let chosenEl = null;
      for (const card of cards) {
        // Look for any descendant <a> first
        const inner = card.querySelector('a[href]');
        if (inner && productLinkRegex.test(inner.href || '') && !isRecommendation(inner.href)) {
          chosenHref = inner.href;
          chosenEl = inner;
          break;
        }
        // Otherwise harvest from data-* attributes
        const attrs = card.attributes ? [...card.attributes] : [];
        for (const a of attrs) {
          const v = String(a.value || '');
          const m = v.match(/-l0?\d{6,}|pelement=\d+|\/p\d{4,}\.html/i);
          if (m) {
            // Build a plausible product URL from the matched id
            const idMatch = v.match(/l0?(\d{6,})/i);
            if (idMatch) {
              chosenHref = `https://www.stradivarius.com/us/-l0${idMatch[1]}.html`;
              chosenEl = card;
              break;
            }
          }
        }
        if (chosenHref) break;
      }
      if (chosenEl) {
        chosenEl.scrollIntoView({ behavior: 'instant', block: 'center' });
        try { chosenEl.click(); } catch { /* noop */ }
        return { href: chosenHref, pass: 'E', candidates: cards.length, hasContainer: true };
      }
    }

    // Diagnostic snippet so we can see what Stradivarius actually rendered
    // when every pass found nothing.
    let snippet = '';
    try {
      if (searchContainer) {
        snippet = (searchContainer.outerHTML || '').slice(0, 400).replace(/\s+/g, ' ');
      } else {
        snippet = (document.body.innerHTML || '').slice(0, 400).replace(/\s+/g, ' ');
      }
    } catch { /* noop */ }

    return { href: '', pass: '', candidates: allLinks.length, hasContainer: !!searchContainer, snippet };
  }, stylePrefixes, expectedDigitsNorm);

  const clickedHref = result && result.href ? result.href : '';
  if (emitLog) {
    emitLog(`    🧭 Stradivarius card click → pass=${result?.pass || '-'} candidates=${result?.candidates ?? 0} container=${result?.hasContainer ? 'yes' : 'no'}`, 'info');
    if (!clickedHref && result?.snippet) {
      emitLog(`    🔬 Stradivarius results DOM snippet: ${result.snippet}`, 'info');
    }
  }

  if (!clickedHref) return '';

  emitLog(`    🖱️ Clicked Stradivarius search result card → ${clickedHref.substring(clickedHref.lastIndexOf('/') + 1)}`, 'info');
  await Promise.race([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 18000 }).catch(() => null),
    page.waitForFunction(
      (prevUrl) => location.href !== prevUrl,
      { timeout: 18000, polling: 400 },
      before,
    ).catch(() => null),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const after = page.url();
  if (/stradivarius\.com\/.*(?:[?&]pelement=\d+|-l\d{6,}|-p\d{4,}\.html)/i.test(after)
      && !/from[-_]?recom|fromrecommendation|cross[-_]?sell/i.test(after)) {
    return after;
  }
  if (/stradivarius\.com\/.*(?:[?&]pelement=\d+|-l\d{6,}|-p\d{4,}\.html)/i.test(clickedHref)
      && !/from[-_]?recom|fromrecommendation|cross[-_]?sell/i.test(clickedHref)) {
    return clickedHref;
  }
  return '';
}

async function searchStradivariusByTyping(page, query, expectedDigits, emitLog, ensureActive) {
  emitLog(`    🔍 Searching Stradivarius by typing "${query}"…`, 'info');

  // Typed search only — open the homepage, click the search button, type the
  // SKU into the live search input, press Enter, then click the first result
  // whose href contains the SKU digits. We deliberately avoid all
  // /q/<sku> direct URLs because they're slow and behave the same as typing.
  await page.goto(STRADIVARIUS_HOME_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await dismissCommonStradivariusPopups(page);
  await page.waitForFunction(
    () => document.readyState === 'complete',
    { timeout: 15000 },
  ).catch(() => {});
  await antiDetection.randomDelay(1500, 2500);
  ensureActive();

  emitLog('    🔎 Opening Stradivarius search overlay…', 'info');
  let opened = await openStradivariusSearchOverlay(page);
  if (!opened) {
    // Header may not be hydrated yet on a cold load; wait for any plausible
    // search trigger to mount and try again a couple of times before giving up.
    for (let attempt = 1; attempt <= 3 && !opened; attempt += 1) {
      emitLog(`    ⏳ Search button not ready; waiting for header to hydrate (attempt ${attempt}/3)…`, 'info');
      try {
        await page.waitForFunction(() => {
          const sels = [
            '[data-testid="searchButton"]',
            '[data-testid="search-button"]',
            '[data-testid="header-search"]',
            '[data-qa-id="searchBtn"]',
            '[data-qa-action="open-search"]',
            'button[aria-label*="search" i]',
            'button[aria-label*="buscar" i]',
            'header button[aria-label*="search" i]',
            'nav button[aria-label*="search" i]',
          ];
          return sels.some((s) => {
            const el = document.querySelector(s);
            if (!el) return false;
            const r = el.getBoundingClientRect();
            const cs = window.getComputedStyle(el);
            return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
          });
        }, { timeout: 8000, polling: 400 });
      } catch { /* timed out — try anyway */ }
      await antiDetection.randomDelay(800, 1400);
      opened = await openStradivariusSearchOverlay(page);
    }
  }
  if (!opened) {
    emitLog('    ⚠️ Could not find/click search button on Stradivarius header; giving up on this reference.', 'warning');
    return '';
  }
  await antiDetection.randomDelay(1500, 2200);
  ensureActive();

  let inputHandle = null;
  try {
    await page.waitForFunction(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 20 || r.height < 6) return false;
        const s = window.getComputedStyle(el);
        return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
      };
      const inputs = [...document.querySelectorAll(
        'input[type="search"], input[type="text"], input:not([type]), textarea, [contenteditable="true"]'
      )];
      return inputs.some(isVisible);
    }, { timeout: 14000, polling: 250 });
    inputHandle = await findVisibleStradivariusSearchInput(page);
  } catch {
    inputHandle = null;
  }

  let inputElement = inputHandle ? inputHandle.asElement() : null;
  if (!inputElement) {
    emitLog('    🔁 Search input not visible yet; reopening overlay and waiting longer…', 'info');
    await openStradivariusSearchOverlay(page).catch(() => false);
    await antiDetection.randomDelay(1500, 2500);
    try {
      await page.waitForFunction(() => {
        const inputs = [...document.querySelectorAll('input[type="search"], input[type="text"], input:not([type]), textarea')];
        return inputs.some((el) => {
          const r = el.getBoundingClientRect();
          const s = window.getComputedStyle(el);
          return r.width >= 20 && r.height >= 6 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
        });
      }, { timeout: 10000, polling: 250 });
      inputHandle = await findVisibleStradivariusSearchInput(page);
      inputElement = inputHandle ? inputHandle.asElement() : null;
    } catch {
      inputElement = null;
    }
  }

  if (!inputElement) {
    emitLog('    ⚠️ Stradivarius search input did not appear after opening overlay; giving up on this reference.', 'warning');
    return '';
  }

  try {
    await inputElement.click({ delay: 80 });
  } catch {
    await page.evaluate((el) => el.focus(), inputElement).catch(() => {});
  }
  await antiDetection.randomDelay(300, 600);

  await page.keyboard.down('Meta').catch(() => {});
  await page.keyboard.press('A').catch(() => {});
  await page.keyboard.up('Meta').catch(() => {});
  await page.keyboard.down('Control').catch(() => {});
  await page.keyboard.press('A').catch(() => {});
  await page.keyboard.up('Control').catch(() => {});
  await page.keyboard.press('Backspace').catch(() => {});

  emitLog(`    ⌨️ Typing search query "${query}"…`, 'info');
  const queryStr = String(query || '');
  // Type via the element handle so focus is re-asserted on each keystroke
  // (Stradivarius re-mounts the search overlay as suggestions appear, which
  // can drop chars when using the page-level keyboard alone).
  try {
    await inputElement.type(queryStr, { delay: 110 });
  } catch {
    await page.keyboard.type(queryStr, { delay: 110 });
  }
  await antiDetection.randomDelay(500, 900);

  // Verify the input value matches; if not, refocus and retype the missing tail.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const currentValue = await page.evaluate((el) => {
      try { return String(el?.value ?? el?.textContent ?? ''); } catch { return ''; }
    }, inputElement).catch(() => '');
    if (currentValue === queryStr) break;
    emitLog(`    🔁 Search input has "${currentValue}" but expected "${queryStr}"; refocusing and retyping…`, 'info');
    // Refind the input — the overlay may have swapped it out
    try {
      const fresh = await findVisibleStradivariusSearchInput(page);
      const freshEl = fresh ? fresh.asElement() : null;
      if (freshEl) {
        try { await inputHandle?.dispose?.(); } catch { /* noop */ }
        inputHandle = fresh;
        inputElement = freshEl;
      }
    } catch { /* noop */ }
    try {
      await inputElement.click({ delay: 80 });
    } catch {
      await page.evaluate((el) => el.focus(), inputElement).catch(() => {});
    }
    // Hard-clear: React-controlled inputs ignore Backspace+Ctrl-A in some
    // states, so set value='' through the native setter and dispatch an
    // input event to flush React's internal state, then verify it really
    // cleared before retyping.
    await page.evaluate((el) => {
      try {
        const proto = Object.getPrototypeOf(el);
        const desc = Object.getOwnPropertyDescriptor(proto, 'value')
          || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        if (desc && desc.set) desc.set.call(el, '');
        else el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } catch { /* noop */ }
    }, inputElement).catch(() => {});
    // Belt-and-suspenders: also fire keyboard select-all + delete
    await page.keyboard.down('Meta').catch(() => {});
    await page.keyboard.press('A').catch(() => {});
    await page.keyboard.up('Meta').catch(() => {});
    await page.keyboard.down('Control').catch(() => {});
    await page.keyboard.press('A').catch(() => {});
    await page.keyboard.up('Control').catch(() => {});
    await page.keyboard.press('Delete').catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});
    await antiDetection.randomDelay(200, 400);
    try {
      await inputElement.type(queryStr, { delay: 130 });
    } catch {
      await page.keyboard.type(queryStr, { delay: 130 });
    }
    await antiDetection.randomDelay(400, 700);
  }
  ensureActive();

  // Submit: prefer the enclosing <form>, then Enter; if neither navigates,
  // fall back to a direct /q/<query> URL which is what Stradivarius itself
  // uses as the canonical search-results page.
  const urlBeforeSubmit = page.url();
  let navigated = false;
  try {
    const submitted = await page.evaluate((el) => {
      try {
        const form = el.closest && el.closest('form');
        if (form) {
          if (typeof form.requestSubmit === 'function') form.requestSubmit();
          else form.submit();
          return true;
        }
      } catch { /* noop */ }
      return false;
    }, inputElement).catch(() => false);
    if (submitted) {
      navigated = await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 })
        .then(() => true).catch(() => false);
    }
  } catch { /* noop */ }

  if (!navigated) {
    await page.keyboard.press('Enter').catch(() => {});
    navigated = await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 })
      .then(() => true).catch(() => false);
  }

  emitLog('    ⏳ Waiting for search results…', 'info');
  await Promise.race([
    page.waitForFunction(
      (prev) => location.href !== prev && /(?:\/(q|search)\/|s_layer=results|s_query=)/i.test(location.href),
      { timeout: 12000, polling: 400 },
      urlBeforeSubmit,
    ).catch(() => null),
    page.waitForFunction(
      () => [...document.querySelectorAll('a[href*="pelement="], a[href*="-l0"], a[href*="-l1"], a[href*="-c0p"]')].length > 0,
      { timeout: 12000, polling: 400 },
    ).catch(() => null),
  ]);

  // If after all that we still haven't moved to a search-results URL,
  // navigate explicitly. This is Stradivarius's own canonical search page
  // and reliably renders a real <searchResult> grid.
  if (!/(?:\/(q|search)\/|s_layer=results|s_query=)/i.test(page.url())) {
    const directUrl = `https://www.stradivarius.com/us/?s_layer=results&s_query=${encodeURIComponent(queryStr)}&s_origin=m`;
    emitLog(`    ↪️ Search box did not navigate; opening results page directly: ${directUrl}`, 'info');
    await page.goto(directUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await page.waitForFunction(
      () => [...document.querySelectorAll('a[href*="pelement="], a[href*="-l0"], a[href*="-l1"], a[href*="-c0p"]')].length > 0,
      { timeout: 15000, polling: 400 },
    ).catch(() => null);
  }
  await antiDetection.randomDelay(1500, 2400);
  ensureActive();

  // Primary: click the first matching product card on the results grid.
  // This handles the "multiple results returned, none auto-selected" case
  // that the href-only extractor below sometimes misses.
  let url = await clickFirstStradivariusProductCard(page, expectedDigits, emitLog).catch(() => '');
  if (!url) {
    // extractStradivariusSearchProductUrl already requires a style-prefix
    // match (-l0<7digits>) before returning a URL, so it won't substitute
    // an unrelated product. Same-style-different-color matches are legitimate.
    url = await extractStradivariusSearchProductUrl(page, query, expectedDigits, true);
  }
  if (!url) {
    emitLog('    🔁 No results yet — pressing Enter again and waiting…', 'info');
    await page.keyboard.press('Enter').catch(() => {});
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null),
      page.waitForFunction(
        () => [...document.querySelectorAll('a[href*="pelement="], a[href*="-l0"], a[href*="-l1"], a[href*="-c0p"]')].length > 0,
        { timeout: 15000, polling: 400 },
      ).catch(() => null),
    ]);
    await antiDetection.randomDelay(1200, 2000);
    ensureActive();
    url = await clickFirstStradivariusProductCard(page, expectedDigits, emitLog).catch(() => '');
    if (!url) {
      url = await extractStradivariusSearchProductUrl(page, query, expectedDigits, true);
    }
  }

  // Fallback: if the US storefront returned no products, try the ES/EN
  // storefront's search-results page directly. The EU catalog covers many
  // SKUs that the US storefront has dropped, so this rescues a lot of the
  // "candidates=0 container=yes" failures we see in production.
  if (!url) {
    const esUrl = `https://www.stradivarius.com/es/en/?s_layer=results&s_query=${encodeURIComponent(queryStr)}&s_origin=m`;
    emitLog(`    🌍 No US results; trying ES/EN storefront: ${esUrl}`, 'info');
    try {
      await page.goto(esUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await dismissCommonStradivariusPopups(page);
      await page.waitForFunction(
        () => [...document.querySelectorAll('a[href*="pelement="], a[href*="-l0"], a[href*="-l1"], a[href*="-c0p"]')].length > 0,
        { timeout: 15000, polling: 400 },
      ).catch(() => null);
      await antiDetection.randomDelay(1200, 2000);
      ensureActive();
      url = await clickFirstStradivariusProductCard(page, expectedDigits, emitLog).catch(() => '');
      if (!url) {
        url = await extractStradivariusSearchProductUrl(page, query, expectedDigits, true);
      }
      if (url) {
        emitLog('    ✅ ES/EN storefront fallback found a match.', 'success');
      }
    } catch (error) {
      emitLog(`    ⚠️ ES/EN storefront fallback failed: ${error.message}`, 'warning');
    }
  }

  if (url) {
    emitLog(`    ✅ Found product: ${url.substring(url.lastIndexOf('/') + 1)}`, 'success');
  } else {
    emitLog('    ⚠️ No product found in search results', 'warning');
  }
  return url;
}

async function resolveStradivariusProduct(browser, reference, emitLog, ensureActive) {
  const normalized = normalizeStradivariusReference(reference);
  if (!normalized) {
    throw new Error('Empty Stradivarius reference.');
  }

  const cacheKey = normalized.styleReference;
  const cachedMatch = cachedStradivariusStyleMatches.get(cacheKey) || null;
  if (cachedMatch) {
    const cachedColor = findStradivariusColorMatch(cachedMatch.product, cachedMatch.item, normalized.colorCode);
    if (normalized.colorCode && !cachedColor) {
      throw new Error(`Color ${normalized.colorCode} was not found for Stradivarius style ${normalized.styleReference}.`);
    }

    return {
      ...cachedMatch,
      color: cachedColor || cachedMatch.color || null,
      input: normalized.input,
      styleNumber: normalized.styleNumber || normalized.styleReference,
      url: buildStradivariusProductUrl(cachedMatch.product, cachedColor || cachedMatch.color || null),
    };
  }

  const page = await browser.newPage();
  await antiDetection.applyRetailBrowsingProfile(page);
  await page.setViewport(antiDetection.getRandomViewport());
  await page.bringToFront().catch(() => {});

  try {
    await gotoStradivariusWithRetry(page, STRADIVARIUS_ENTRY_URL, 'Stradivarius entry', 2, { timeout: 20000 });
    await antiDetection.randomDelay(400, 800);
    await dismissCommonStradivariusPopups(page);

    // Typed search only: skip the direct API/product-URL lookup entirely and go straight to
    // typing the style number into the on-site search box.
    // Query order per user requirement: full SKU first → 8-digit padded → 7-digit style code.
    const inputRaw = String(reference || '').trim();
    const compactDigits = inputRaw.replace(/\D/g, '');
    const queries = [];
    const addQuery = (q) => {
      const trimmed = String(q || '').trim();
      if (trimmed && !queries.includes(trimmed)) queries.push(trimmed);
    };
    if (compactDigits.length >= 8) {
      // 1) Full SKU as typed (e.g. 1212703004)
      addQuery(compactDigits);
      // 2) 8-digit zero-padded style code (e.g. 01212703)
      addQuery(`0${compactDigits.slice(0, 7)}`);
      // 3) 7-digit style code (e.g. 1212703) — matches the -l0<7> URL pattern
      addQuery(compactDigits.slice(0, 7));
    } else if (compactDigits.length === 7) {
      // 1) 8-digit zero-padded form
      addQuery(`0${compactDigits}`);
      // 2) 7-digit style code itself
      addQuery(compactDigits);
    } else {
      // Slash-style refs (e.g. "1234/567") or short non-numeric inputs — keep the
      // normalizer's primary query.
      const primaryQuery = normalized.styleNumber || normalized.styleReference || normalized.input;
      addQuery(primaryQuery);
      if (normalized.styleReference && normalized.styleReference !== primaryQuery) {
        addQuery(normalized.styleReference);
      }
    }
    const searchDigits = (normalized.styleReference || normalized.input || '').replace(/\D/g, '');

    let typedUrl = '';
    for (const queryCandidate of queries) {
      ensureActive();
      typedUrl = await searchStradivariusByTyping(
        page,
        queryCandidate,
        searchDigits,
        emitLog,
        ensureActive,
      ).catch((error) => {
        ensureActive();
        emitLog(`    ⚠️ Stradivarius typed search failed: ${error.message}`, 'warning');
        return '';
      });
      if (typedUrl) break;
      // Reset state for the next query variant
      emitLog(`    ↪ Stradivarius "${queryCandidate}" produced no real match; trying next variant…`, 'info');
    }

    if (typedUrl) {
      const resolved = {
        product: null,
        item: null,
        displayReference: normalized.styleReference,
        color: null,
        input: normalized.input,
        styleNumber: normalized.styleNumber || normalized.styleReference,
        url: typedUrl,
      };
      cachedStradivariusStyleMatches.set(cacheKey, resolved);
      return resolved;
    }
  } finally {
    await page.close().catch(() => {});
  }

  throw new Error(`No Stradivarius product was found for ${normalized.styleNumber || normalized.input}.`);
}

function buildStradivariusProductUrl(product, color = null) {
  const slug = String(product?.productUrl || '').trim();
  if (!slug) {
    return '';
  }

  const baseUrl = `https://www.stradivarius.com/us/${slug}`;
  const params = new URLSearchParams();
  const colorId = color?.id || null;
  const pelement = product?.productUrlParam || product?.id || null;

  if (colorId) {
    params.set('colorId', String(colorId));
  }
  if (pelement) {
    params.set('pelement', String(pelement));
  }

  return params.size > 0 ? `${baseUrl}?${params.toString()}` : baseUrl;
}

function parseStradivariusImageMeta(image = {}, fallbackIndex = 0) {
  const filename = path.basename(canonicalizeStradivariusImageUrl(image.src || image.url || '')).toLowerCase();
  const alt = String(image.alt || '').trim().toLowerCase();
  const originalName = String(image.originalName || image.extraInfo?.originalName || '').trim().toLowerCase();

  if (/-m\.(jpg|jpeg|png|webp)$/i.test(filename)) {
    return { kind: 'main-flat', order: -50 };
  }

  if (/-b\d*\.(jpg|jpeg|png|webp)$/i.test(filename) || /^b\d*$/.test(originalName)) {
    return { kind: 'back-flat', order: 999 };
  }

  const modelMatch = filename.match(/-a(\d+)/i);
  if (modelMatch) {
    return { kind: 'model', order: Number.parseInt(modelMatch[1], 10), sequence: Number.parseInt(modelMatch[1], 10) };
  }

  const detailMatch = filename.match(/-c(\d+)/i);
  if (detailMatch) {
    return { kind: 'detail', order: 400 + Number.parseInt(detailMatch[1], 10), sequence: Number.parseInt(detailMatch[1], 10) };
  }

  const studioMatch = filename.match(/-s(\d+)/i);
  if (studioMatch) {
    const studioIndex = Number.parseInt(studioMatch[1], 10);
    if (studioIndex === 1) {
      return { kind: 'front-flat', order: -100, sequence: studioIndex };
    }
    if (studioIndex === 2 || /\bback\b/.test(alt)) {
      return { kind: 'back-flat', order: 999, sequence: studioIndex };
    }
    return { kind: 'studio', order: 600 + studioIndex, sequence: studioIndex };
  }

  return { kind: 'misc', order: 900 + fallbackIndex, sequence: fallbackIndex };
}

function collectStradivariusApiImageEntries(source, out = [], visited = new WeakSet()) {
  if (!source || typeof source !== 'object') {
    return out;
  }

  if (visited.has(source)) {
    return out;
  }
  visited.add(source);

  if (Array.isArray(source)) {
    source.forEach((item) => collectStradivariusApiImageEntries(item, out, visited));
    return out;
  }

  const candidateUrl = canonicalizeStradivariusImageUrl(
    source.url
    || source.deliveryUrl
    || source.currentSrc
    || '',
  );
  if (candidateUrl && isLikelyStradivariusProductImage(candidateUrl)) {
    out.push({
      src: candidateUrl,
      alt: source.alt || '',
      originalName: source.extraInfo?.originalName || source.originalName || '',
    });
  }

  Object.values(source).forEach((value) => {
    if (value && typeof value === 'object') {
      collectStradivariusApiImageEntries(value, out, visited);
    }
  });

  return out;
}

function buildStradivariusImageMap(imageEntries = []) {
  const dedupedEntries = [];
  const seen = new Set();

  imageEntries.forEach((entry, index) => {
    const src = canonicalizeStradivariusImageUrl(entry.src || entry.url || '');
    if (!src || seen.has(src) || !isLikelyStradivariusProductImage(src)) {
      return;
    }
    seen.add(src);
    dedupedEntries.push({
      ...entry,
      src,
      index,
      meta: parseStradivariusImageMeta(entry, index),
    });
  });

  const frontFlatEntry = dedupedEntries.find((entry) => entry.meta.kind === 'front-flat')
    || dedupedEntries.find((entry) => entry.meta.kind === 'main-flat')
    || null;
  const backFlatEntry = dedupedEntries.find((entry) => entry.meta.kind === 'back-flat') || null;
  const numberedEntries = dedupedEntries
    .filter((entry) => entry !== frontFlatEntry && entry !== backFlatEntry && entry.meta.kind !== 'main-flat')
    .sort((left, right) => left.meta.order - right.meta.order);

  const classified = {};

  if (frontFlatEntry) {
    classified.F = frontFlatEntry.src;
  }

  let nextNumber = 1;
  numberedEntries.forEach((entry) => {
    const label = String(nextNumber).padStart(2, '0');
    classified[label] = entry.src;
    nextNumber += 1;
  });

  if (backFlatEntry) {
    classified.B = backFlatEntry.src;
  }

  return classified;
}

function isLikelyPullAndBearProductImage(url = '') {
  const value = cleanImageUrl(url).toLowerCase();
  if (!value || !/\.(jpg|jpeg|png|webp)$/i.test(value)) {
    return false;
  }
  if (
    value.includes('placeholder')
    || value.includes('logo')
    || value.includes('sprite')
    || value.includes('icon')
    || value.includes('/cares/')
    || value.includes('color_')
  ) {
    return false;
  }
  return value.includes('static.pullandbear.net');
}

function extractPullAndBearImageReferenceCode(url = '') {
  const filename = path.basename(canonicalizeStradivariusImageUrl(url)).toLowerCase();
  const match = filename.match(/^(\d{10,14})-[a-z0-9]+m?\.(jpg|jpeg|png|webp)$/i);
  return match ? match[1] : '';
}

function isRelevantPullAndBearProductImage(url = '', reference = '') {
  if (!isLikelyPullAndBearProductImage(url)) {
    return false;
  }

  const filename = path.basename(canonicalizeStradivariusImageUrl(url)).toLowerCase();
  if (!/-[a-z0-9]+m?\.(jpg|jpeg|png|webp)$/i.test(filename)) {
    return false;
  }

  const normalized = normalizePullAndBearReference(reference);
  const referenceCode = extractPullAndBearImageReferenceCode(filename);
  if (!normalized || !referenceCode) {
    return Boolean(referenceCode);
  }

  const expectedBase = `${normalized.paddedStyleDigits || ''}${normalized.colorCode || ''}`;
  if (expectedBase && !referenceCode.startsWith(expectedBase)) {
    return false;
  }
  if (referenceCode.length > expectedBase.length && !/^(?:00|01|001)$/.test(referenceCode.slice(expectedBase.length))) {
    return false;
  }
  return true;
}

function parsePullAndBearImageMeta(image = {}, fallbackIndex = 0) {
  const url = canonicalizeStradivariusImageUrl(image.src || image.url || '');
  const filename = path.basename(url).toLowerCase();
  const originalName = String(image.originalName || image.extraInfo?.originalName || '').trim().toLowerCase();
  const tokenMatch = filename.match(/-([a-z0-9]+m?)\.(jpg|jpeg|png|webp)$/i);
  const token = (originalName || tokenMatch?.[1] || '').toLowerCase();

  if (/^a6m$/i.test(token)) {
    return { kind: 'front-flat', order: -150, token };
  }
  if (/^a20m$/i.test(token)) {
    return { kind: 'back-flat', order: 950, token };
  }
  if (/^(?:z1?|d1?|c1?|s1|f|front)$/i.test(token)) {
    return { kind: 'duplicate-flat', order: 1200, token };
  }
  if (/^(?:d2|k2)$/i.test(token)) {
    return { kind: 'duplicate-back-flat', order: 1201, token };
  }
  if (/^(?:s1|f|front)$/i.test(token)) {
    return { kind: 'front-flat', order: -100, token };
  }
  if (/^(?:b|back)$/i.test(token)) {
    return { kind: 'back-flat', order: 999, token };
  }
  if (/^k1/i.test(token)) {
    return { kind: 'detail', order: 500, token };
  }

  const modelMatch = token.match(/^a(\d+)/i);
  if (modelMatch) {
    return { kind: 'model', order: Number.parseInt(modelMatch[1], 10), token };
  }

  const cutMatch = token.match(/^c(\d*)/i);
  if (cutMatch) {
    return { kind: 'detail', order: 300 + Number.parseInt(cutMatch[1] || '1', 10), token };
  }

  return { kind: 'misc', order: 700 + fallbackIndex, token };
}

function getPullAndBearImageDedupKey(entry = {}) {
  const src = canonicalizeStradivariusImageUrl(entry.src || entry.url || '');
  if (!src) {
    return '';
  }

  const filename = path.basename(src).toLowerCase();
  const tokenMatch = filename.match(/^(\d{10,11})-([a-z0-9]+m?)\.(jpg|jpeg|png|webp)$/i);
  if (tokenMatch) {
    return `${tokenMatch[1]}-${tokenMatch[2].toLowerCase()}`;
  }

  return src;
}

function buildPullAndBearImageMap(imageEntries = []) {
  const dedupedEntries = [];
  const seen = new Set();

  imageEntries.forEach((entry, index) => {
    const src = canonicalizeStradivariusImageUrl(entry.src || entry.url || '');
    const dedupKey = getPullAndBearImageDedupKey({ ...entry, src });
    if (!src || !dedupKey || seen.has(dedupKey) || !isLikelyPullAndBearProductImage(src)) {
      return;
    }
    seen.add(dedupKey);
    dedupedEntries.push({
      ...entry,
      src,
      index,
      meta: parsePullAndBearImageMeta(entry, index),
    });
  });

  const frontFlatEntry = dedupedEntries
    .filter((entry) => entry.meta.kind === 'front-flat')
    .sort((left, right) => left.meta.order - right.meta.order)[0] || null;
  const backFlatEntry = dedupedEntries
    .filter((entry) => entry.meta.kind === 'back-flat')
    .sort((left, right) => left.meta.order - right.meta.order)[0] || null;
  const numberedEntries = dedupedEntries
    .filter((entry) =>
      entry.meta.kind !== 'front-flat'
      && entry.meta.kind !== 'back-flat'
      && entry.meta.kind !== 'duplicate-flat'
      && entry.meta.kind !== 'duplicate-back-flat',
    )
    .sort((left, right) => left.meta.order - right.meta.order);

  const classified = {};
  if (frontFlatEntry) {
    classified.F = frontFlatEntry.src;
  }

  let nextNumber = 1;
  numberedEntries.forEach((entry) => {
    classified[String(nextNumber).padStart(2, '0')] = entry.src;
    nextNumber += 1;
  });

  if (backFlatEntry) {
    classified.B = backFlatEntry.src;
  }

  return classified;
}

function collectPullAndBearApiImageEntries(source, out = [], visited = new WeakSet()) {
  if (!source || typeof source !== 'object') {
    return out;
  }

  if (visited.has(source)) {
    return out;
  }
  visited.add(source);

  if (Array.isArray(source)) {
    source.forEach((item) => collectPullAndBearApiImageEntries(item, out, visited));
    return out;
  }

  const candidateUrl = canonicalizeStradivariusImageUrl(
    source.deliveryUrl
    || source.extraInfo?.deliveryUrl
    || source.extraInfo?.url
    || source.url
    || source.currentSrc
    || '',
  );
  if (candidateUrl && isLikelyPullAndBearProductImage(candidateUrl)) {
    out.push({
      src: candidateUrl,
      alt: source.alt || '',
      originalName: source.extraInfo?.originalName || source.originalName || '',
    });
  }

  Object.values(source).forEach((value) => {
    if (value && typeof value === 'object') {
      collectPullAndBearApiImageEntries(value, out, visited);
    }
  });

  return out;
}

async function fetchPullAndBearJson(page, url) {
  const payload = await page.evaluate(async (targetUrl) => {
    const response = await fetch(targetUrl, {
      credentials: 'include',
      headers: {
        Accept: 'application/json, text/plain, */*',
      },
    });
    const text = await response.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    return {
      ok: response.ok,
      status: response.status,
      text: text.slice(0, 3000),
      data,
    };
  }, url);

  if (!payload.ok || !payload.data) {
    throw new Error(`Pull&Bear API request failed (${payload.status}): ${payload.text || 'No response body'}`);
  }

  return payload.data;
}

async function gotoPullAndBearWithRetry(page, url, label = 'Pull&Bear page', attempts = 3, options = {}) {
  let lastError = null;
  const { waitUntil = 'domcontentloaded', timeout = 30000 } = options;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await page.goto(url, { waitUntil, timeout });
      return;
    } catch (error) {
      lastError = error;
      const message = String(error?.message || '');
      if (!/ERR_CONNECTION_CLOSED|Navigation timeout|frame was detached/i.test(message) || attempt === attempts) {
        break;
      }
      await delay(800 * attempt);
    }
  }

  throw new Error(`${label} failed: ${lastError?.message || 'Unknown error'}`);
}

async function dismissCommonPullAndBearPopups(page) {
  return dismissCommonStradivariusPopups(page);
}

function flattenPullAndBearLeafCategoryIds(nodes = [], out = []) {
  for (const node of nodes || []) {
    const children = Array.isArray(node?.subcategories) ? node.subcategories : [];
    if (children.length === 0) {
      if (node?.id) {
        out.push(node.id);
      }
    } else {
      flattenPullAndBearLeafCategoryIds(children, out);
    }
  }
  return out;
}

async function getPullAndBearLeafCategoryIds(page) {
  if (Array.isArray(cachedPullAndBearLeafIds) && cachedPullAndBearLeafIds.length > 0) {
    return cachedPullAndBearLeafIds;
  }

  const tree = await fetchPullAndBearJson(page, PULLANDBEAR_CATEGORY_TREE_URL);
  cachedPullAndBearLeafIds = flattenPullAndBearLeafCategoryIds(tree.categories || []);
  return cachedPullAndBearLeafIds;
}

function buildPullAndBearProductLookupKeys(reference = '') {
  const normalized = normalizePullAndBearReference(reference);
  if (!normalized) {
    return [];
  }

  const keys = new Set();
  if (normalized.compactDigits) {
    keys.add(normalized.compactDigits);
  }
  if (normalized.styleDigits) {
    keys.add(normalized.styleDigits);
  }
  if (normalized.paddedStyleDigits) {
    keys.add(normalized.paddedStyleDigits);
  }
  return [...keys].filter(Boolean);
}

function findPullAndBearColorMatch(product, item, colorCode = '') {
  const detailColors = Array.isArray(item?.detail?.colors) ? item.detail.colors : [];
  const bundleColors = Array.isArray(product?.bundleColors) ? product.bundleColors : [];
  const normalizedColor = normalizeBershkaColorCode(colorCode);
  const colors = [...detailColors, ...bundleColors];

  if (normalizedColor) {
    const exact = colors.find((color) =>
      normalizeBershkaColorCode(color?.id) === normalizedColor
      || String(color?.reference || '').includes(normalizedColor),
    );
    if (exact) {
      return exact;
    }
  }

  return colors[0] || null;
}

function matchPullAndBearProductByReference(product, normalized) {
  if (!product || !normalized) {
    return null;
  }

  const candidates = [...(Array.isArray(product.bundleProductSummaries) ? product.bundleProductSummaries : []), product];
  for (const item of candidates) {
    const displayReference = String(item?.detail?.displayReference || product?.detail?.displayReference || '').trim();
    if (!displayReference || displayReference !== normalized.styleReference) {
      continue;
    }

    const color = findPullAndBearColorMatch(product, item, normalized.colorCode);
    if (normalized.colorCode && !color) {
      continue;
    }

    return { product, item, displayReference, color };
  }

  return null;
}

function buildPullAndBearProductUrl(product, color = null) {
  const slug = String(product?.productUrl || '').trim();
  if (!slug) {
    return '';
  }

  const baseUrl = `https://www.pullandbear.com/us/${slug}`;
  const params = new URLSearchParams();
  const colorId = color?.id || null;
  const pelement = product?.productUrlParam || product?.id || null;

  if (colorId) {
    params.set('colorId', String(colorId));
  }
  if (pelement) {
    params.set('pelement', String(pelement));
  }

  return params.size > 0 ? `${baseUrl}?${params.toString()}` : baseUrl;
}

async function fetchPullAndBearProductByReference(page, reference, emitLog, ensureActive) {
  const normalized = normalizePullAndBearReference(reference);
  if (!normalized) {
    return null;
  }

  const keys = buildPullAndBearProductLookupKeys(reference);
  const endpoints = [];

  keys.forEach((key) => {
    endpoints.push({
      type: 'moca',
      url: `https://www.pullandbear.com/itxrest/2/catalog/store/${PULLANDBEAR_STORE_ID}/${PULLANDBEAR_CATALOG_ID}/product/moca/${key}?languageId=${PULLANDBEAR_LANGUAGE_ID}&appId=1&locale=${PULLANDBEAR_LOCALE}`,
    });
    endpoints.push({
      type: 'partNumber',
      url: `https://www.pullandbear.com/itxrest/2/catalog/store/${PULLANDBEAR_STORE_ID}/${PULLANDBEAR_CATALOG_ID}/product/${key}?languageId=${PULLANDBEAR_LANGUAGE_ID}&appId=1&locale=${PULLANDBEAR_LOCALE}`,
    });
  });

  for (const endpoint of endpoints) {
    ensureActive();
    try {
      const product = await fetchPullAndBearJson(page, endpoint.url);
      if (!product?.id) {
        continue;
      }

      const matched = matchPullAndBearProductByReference(product, normalized);
      if (!matched) {
        continue;
      }

      const resolved = {
        ...matched,
        input: normalized.input,
        styleNumber: normalized.compactDigits || normalized.input,
        url: buildPullAndBearProductUrl(product, matched.color),
      };

      cachedPullAndBearStyleMatches.set(normalized.styleReference, resolved);
      emitLog(`✅ Pull&Bear direct ${endpoint.type} matched: ${resolved.url}`, 'success');
      return resolved;
    } catch (error) {
      if (!/404|not found|_ERR_PRODUCT_NOT_FOUND/i.test(String(error.message || ''))) {
        emitLog(`⚠️ Pull&Bear direct ${endpoint.type} lookup failed: ${error.message}`, 'warning');
      }
    }
  }

  return null;
}

async function resolvePullAndBearProduct(browser, reference, emitLog, ensureActive) {
  const normalized = normalizePullAndBearReference(reference);
  if (!normalized) {
    throw new Error('Empty Pull&Bear reference.');
  }

  const cachedMatch = cachedPullAndBearStyleMatches.get(normalized.styleReference) || null;
  if (cachedMatch) {
    const cachedColor = findPullAndBearColorMatch(cachedMatch.product, cachedMatch.item, normalized.colorCode);
    if (normalized.colorCode && !cachedColor) {
      throw new Error(`Color ${normalized.colorCode} was not found for Pull&Bear style ${normalized.styleReference}.`);
    }
    return {
      ...cachedMatch,
      color: cachedColor || cachedMatch.color || null,
      input: normalized.input,
      styleNumber: normalized.compactDigits || normalized.input,
      url: buildPullAndBearProductUrl(cachedMatch.product, cachedColor || cachedMatch.color || null),
    };
  }

  const page = await browser.newPage();
  await antiDetection.applyRetailBrowsingProfile(page);
  await page.setViewport(antiDetection.getRandomViewport());
  await page.bringToFront().catch(() => {});

  try {
    await gotoPullAndBearWithRetry(page, PULLANDBEAR_ENTRY_URL, 'Pull&Bear entry', 2, { timeout: 25000 });
    await antiDetection.randomDelay(600, 1000);
    await dismissCommonPullAndBearPopups(page);

    const directMatch = await fetchPullAndBearProductByReference(page, reference, emitLog, ensureActive);
    if (directMatch?.url) {
      return directMatch;
    }

    const leafIds = await getPullAndBearLeafCategoryIds(page);
    emitLog(`🔎 Pull&Bear catalog search: ${normalized.styleReference}${normalized.colorCode ? `/${normalized.colorCode}` : ''}`, 'info');

    for (let leafIndex = 0; leafIndex < leafIds.length; leafIndex += 1) {
      ensureActive();
      const leafId = leafIds[leafIndex];
      const listUrl = `https://www.pullandbear.com/itxrest/3/catalog/store/${PULLANDBEAR_STORE_ID}/${PULLANDBEAR_CATALOG_ID}/category/${leafId}/product?showProducts=false&languageId=${PULLANDBEAR_LANGUAGE_ID}&appId=1&locale=${PULLANDBEAR_LOCALE}`;
      let listPayload;
      try {
        listPayload = await fetchPullAndBearJson(page, listUrl);
      } catch (error) {
        if (/ERR_CATEGORY_NOT_FOUND|Request failed \(404\)|API request failed \(404\)/i.test(String(error.message || ''))) {
          continue;
        }
        throw error;
      }

      const productIds = Array.isArray(listPayload.productIds) ? listPayload.productIds : [];
      if (productIds.length === 0) {
        continue;
      }

      for (let chunkIndex = 0; chunkIndex < productIds.length; chunkIndex += 20) {
        ensureActive();
        const chunk = productIds.slice(chunkIndex, chunkIndex + 20);
        const arrayUrl = `https://www.pullandbear.com/itxrest/3/catalog/store/${PULLANDBEAR_STORE_ID}/${PULLANDBEAR_CATALOG_ID}/productsArray?languageId=${PULLANDBEAR_LANGUAGE_ID}&appId=1&locale=${PULLANDBEAR_LOCALE}&productIds=${chunk.join(',')}`;
        let productsPayload;
        try {
          productsPayload = await fetchPullAndBearJson(page, arrayUrl);
        } catch (error) {
          if (/ERR_CATEGORY_NOT_FOUND|Request failed \(404\)|API request failed \(404\)/i.test(String(error.message || ''))) {
            continue;
          }
          throw error;
        }

        const products = Array.isArray(productsPayload.products) ? productsPayload.products : [];
        for (const product of products) {
          const matched = matchPullAndBearProductByReference(product, normalized);
          if (!matched) {
            continue;
          }

          const resolved = {
            ...matched,
            input: normalized.input,
            styleNumber: normalized.compactDigits || normalized.input,
            url: buildPullAndBearProductUrl(product, matched.color),
          };
          cachedPullAndBearStyleMatches.set(normalized.styleReference, resolved);
          return resolved;
        }
      }
    }
  } finally {
    await page.close().catch(() => {});
  }

  throw new Error(`No Pull&Bear product was found for ${normalized.input}.`);
}

async function waitForPullAndBearProductImages(page, reference, capturedImageUrls, ensureActive, emitLog) {
  const startedAt = Date.now();
  const maxWaitMs = 9000;
  let bestCount = 0;
  let stableTicks = 0;
  let lastSignature = '';

  while (Date.now() - startedAt < maxWaitMs) {
    ensureActive();
    const pageEntries = await page.evaluate(() => {
      const imageUrls = [...document.querySelectorAll('img')]
        .flatMap((img) => [
          img.currentSrc || '',
          img.src || '',
          img.getAttribute('data-src') || '',
          img.getAttribute('srcset') || '',
        ])
        .flatMap((value) => String(value || '').split(',').map((part) => part.trim().split(/\s+/)[0]))
        .filter(Boolean);
      const sourceUrls = [...document.querySelectorAll('source')]
        .flatMap((source) => [source.getAttribute('srcset') || '', source.getAttribute('data-srcset') || ''])
        .flatMap((value) => String(value || '').split(',').map((part) => part.trim().split(/\s+/)[0]))
        .filter(Boolean);
      const performanceUrls = (performance.getEntriesByType('resource') || [])
        .map((entry) => String(entry.name || ''))
        .filter(Boolean);
      const viewportHeight = window.innerHeight || 900;
      window.scrollTo({ top: Math.min(document.body.scrollHeight || viewportHeight, window.scrollY + Math.round(viewportHeight * 0.9)), behavior: 'smooth' });
      return [...imageUrls, ...sourceUrls, ...performanceUrls];
    }).catch(() => []);

    const relevantUrls = [...new Set([
      ...pageEntries,
      ...[...capturedImageUrls],
    ]
      .map((url) => canonicalizeStradivariusImageUrl(url))
      .filter((url) => isRelevantPullAndBearProductImage(url, reference)))]
      .sort();

    const signature = relevantUrls.join('|');
    if (relevantUrls.length > bestCount) {
      bestCount = relevantUrls.length;
      stableTicks = 0;
    } else if (signature && signature === lastSignature) {
      stableTicks += 1;
    } else {
      stableTicks = 0;
    }
    lastSignature = signature;

    if (bestCount >= 5 && stableTicks >= 2) {
      return bestCount;
    }
    await delay(650);
  }

  if (bestCount > 0) {
    emitLog(`    🖼️ Pull&Bear image wait finished with ${bestCount} loaded image(s).`, 'info');
  }
  return bestCount;
}

async function waitForStradivariusProductImages(page, styleNumber, capturedImageUrls, ensureActive, emitLog) {
  const startedAt = Date.now();
  const maxWaitMs = 10000;
  let bestCount = 0;
  let stableTicks = 0;
  let lastSignature = '';

  while (Date.now() - startedAt < maxWaitMs) {
    ensureActive();

    const pageEntries = await page.evaluate(() => {
      const imageUrls = [...document.querySelectorAll('img')]
        .flatMap((img) => [
          img.currentSrc || '',
          img.src || '',
          img.getAttribute('data-src') || '',
          img.getAttribute('data-original') || '',
          img.getAttribute('srcset') || '',
        ])
        .flatMap((value) => String(value || '').split(',').map((part) => part.trim().split(/\s+/)[0]))
        .filter(Boolean);

      const sourceUrls = [...document.querySelectorAll('source')]
        .flatMap((source) => [
          source.getAttribute('srcset') || '',
          source.getAttribute('data-srcset') || '',
        ])
        .flatMap((value) => String(value || '').split(',').map((part) => part.trim().split(/\s+/)[0]))
        .filter(Boolean);

      const performanceUrls = (performance.getEntriesByType('resource') || [])
        .map((entry) => String(entry.name || ''))
        .filter(Boolean);

      const viewportHeight = window.innerHeight || 900;
      const scrollTarget = Math.min(
        document.body.scrollHeight || viewportHeight,
        window.scrollY + Math.round(viewportHeight * 0.85),
      );
      window.scrollTo({ top: scrollTarget, behavior: 'smooth' });

      return [...imageUrls, ...sourceUrls, ...performanceUrls];
    }).catch(() => []);

    const relevantUrls = [...new Set([
      ...pageEntries,
      ...[...capturedImageUrls],
    ]
      .map((url) => canonicalizeStradivariusImageUrl(url))
      .filter((url) => isRelevantStradivariusProductImage(url, styleNumber)))]
      .sort();

    const signature = relevantUrls.join('|');
    if (relevantUrls.length > bestCount) {
      bestCount = relevantUrls.length;
      stableTicks = 0;
    } else if (signature && signature === lastSignature) {
      stableTicks += 1;
    } else {
      stableTicks = 0;
    }
    lastSignature = signature;

    if (bestCount >= 5 && stableTicks >= 2) {
      return bestCount;
    }
    if (bestCount >= 3 && stableTicks >= 3) {
      return bestCount;
    }

    await delay(700);
  }

  if (bestCount > 0) {
    emitLog(`    🖼️ Stradivarius image wait finished with ${bestCount} loaded image(s).`, 'info');
  }
  return bestCount;
}

async function scrapeStradivariusProduct(browser, reference, emitLog, ensureActive) {
  const resolved = await resolveStradivariusProduct(browser, reference, emitLog, ensureActive);
  if (!resolved.url) {
    throw new Error(`Could not build a Stradivarius product URL for ${resolved.styleNumber}.`);
  }

  // ── Firecrawl mode check ────────────────────────────────────────
  const currentMode = firecrawlService.getMode();
  if (currentMode === 'manual') {
    emitLog(` Stradivarius ${reference || ''} 手动模式: 使用 Firecrawl 抓取`, 'warning');
    try {
      ensureActive();
      const fcResult = await firecrawlFallback.tryFirecrawlFallback(resolved.url, {
        imageFilter: (imgUrl) => isLikelyStradivariusProductImage(imgUrl),
        urlNormalizer: (u) => u.split('?')[0],
        candidateIds: [String(reference || '').replace(/\D/g, '')],
        emitLog: (msg, type) => emitLog(`    ${msg}`, type),
      });

      // ─ Parse product text from Firecrawl HTML ────────────────────
      const html = fcResult.html || '';
      let name = '';
      let price = '';
      let description = '';
      let compositionText = null;

      const h1Match = html.match(/<h1[^>]*>(.*?)<\/h1>/is);
      if (h1Match) {
        name = h1Match[1].replace(/<[^>]+>/g, '').trim();
      }

      const priceMatch = html.match(/[€$£¥]([\d.,]+)/);
      if (priceMatch) {
        price = priceMatch[0];
      }

      const descPatterns = [
        /["']description["']?:\s*["']([^"']+)["']/i,
        /<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i,
      ];
      for (const pattern of descPatterns) {
        const m = html.match(pattern);
        if (m) {
          description = m[1].trim();
          break;
        }
      }

      const compPatterns = [
        /["']composition["']?:\s*["']([^"']+)["']/i,
        /["']materials["']?:\s*["']([^"']+)["']/i,
      ];
      for (const pattern of compPatterns) {
        const m = html.match(pattern);
        if (m) {
          compositionText = m[1].trim();
          break;
        }
      }

      const styleNumber = String(reference || '').replace(/\D/g, '');
      return {
        styleNumber,
        productId: styleNumber,
        brand: 'Stradivarius',
        name: name || `Stradivarius ${styleNumber}`,
        price,
        colorRef: '',
        description,
        composition: { outerShell: null, lining: null, other: compositionText || null },
        url: resolved.url,
        imageUrls: fcResult.imageUrls,
        imageMap: {},
        pageText: '',
        usedEngine: 'firecrawl',
      };
    } catch (fcError) {
      emitLog(`❌ Stradivarius ${reference || ''} Firecrawl 抓取失败: ${fcError.message}`, 'error');
      throw new Error(`Firecrawl failed: ${fcError.message}`);
    }
  }
  // ── End Firecrawl manual mode ───────────────────────────────────

  const page = await browser.newPage();
  await antiDetection.applyRetailBrowsingProfile(page);
  await page.setViewport(antiDetection.getRandomViewport());
  await page.bringToFront().catch(() => {});

  const capturedImageUrls = new Set();
  page.on('response', (resp) => {
    const reqUrl = canonicalizeStradivariusImageUrl(resp.url());
    if (isLikelyStradivariusProductImage(reqUrl)) {
      capturedImageUrls.add(reqUrl);
    }
  });

  try {
    ensureActive();
    await antiDetection.randomDelay(250, 500);
    await gotoStradivariusWithRetry(page, resolved.url, `Stradivarius product ${resolved.styleNumber}`, 2, { timeout: 22000 });
    await antiDetection.randomDelay(700, 1100);
    await dismissCommonStradivariusPopups(page);
    await antiDetection.humanScroll(page, 700);
    await waitForStradivariusProductImages(page, resolved.styleNumber || resolved.input, capturedImageUrls, ensureActive, emitLog);
    await antiDetection.randomDelay(250, 450);

    // Expand the "Composition and care" accordion so the section text is in the DOM
    await page.evaluate(() => {
      const target = [...document.querySelectorAll('button, summary, [role="button"], a, h2, h3, div, span')]
        .find((el) => /composition\s+and\s+care|composition,?\s*care(\s+and\s+source)?|materials,?\s+care\s+and\s+source/i
          .test(String(el.textContent || '').trim()));
      if (target) {
        target.scrollIntoView({ behavior: 'instant', block: 'center' });
        target.click();
      }
    }).catch(() => {});
    await antiDetection.randomDelay(400, 800);

    const pageData = await page.evaluate(() => {
      const bodyText = String(document.body?.innerText || '');
      const title = document.querySelector('h1')?.textContent?.trim() || '';
      const priceMatch = bodyText.match(/([$€£]\s?[\d,.]+)/);
      const lines = bodyText
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      const refLine = lines.find((line) => /^.*REF\.\s*[0-9/]+/i.test(line)) || '';
      const refMatch = refLine.match(/REF\.\s*([0-9/]+)/i);
      const colorRef = refLine.includes('|') ? refLine.split('|')[0].trim().split(/\s{2,}/).pop() : '';
      const galleryImages = [...document.querySelectorAll('img[data-testid^="img-item-"], img[data-testid="product-image"]')]
        .map((img) => ({
          src: img.currentSrc || img.src,
          alt: img.alt || '',
          testId: img.dataset?.testid || '',
        }))
        .filter((item) => item.src && item.src.includes('static.e-stradivarius.net'));
      const allImages = [...document.querySelectorAll('img')]
        .map((img) => ({
          src: img.currentSrc || img.src,
          alt: img.alt || '',
          testId: img.dataset?.testid || '',
        }))
        .filter((item) => item.src && item.src.includes('static.e-stradivarius.net'));

      // ── Extract product description from the DOM
      const metaDescription = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';
      const descriptionFromDom = (() => {
        const selectors = [
          '[data-qa-id="product-description"]',
          '[data-testid="product-description"]',
          '[data-qa-id="description"]',
          '[data-testid="description"]',
          'section[class*="description" i] p',
          'div[class*="description" i] p',
          'section[class*="Description"] p',
          'div[class*="Description"] p',
        ];
        for (const sel of selectors) {
          const elements = [...document.querySelectorAll(sel)];
          for (const el of elements) {
            const txt = String(el.textContent || '').trim();
            if (txt.length >= 40 && txt.length < 1200) return txt;
          }
        }
        return '';
      })();

      // ── Extract composition section from the DOM
      // Look for headings such as "Composition and care", "Composition, care and source",
      // "Materials, care and source", then grab the surrounding container's text.
      const compositionFromDom = (() => {
        const headingRegex = /^\s*(composition\s+and\s+care|composition,?\s*care(\s+and\s+source)?|materials,?\s+care\s+and\s+source)\s*$/i;
        const allElements = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6, div, span, button, summary, p')];
        const heading = allElements.find((el) => {
          const text = String(el.textContent || '').trim();
          return text.length < 80 && headingRegex.test(text);
        });
        if (!heading) return '';
        let container = heading.closest('section, [role="region"]')
          || heading.parentElement?.parentElement
          || heading.parentElement;
        if (!container) return '';
        const text = String(container.innerText || container.textContent || '').trim();
        // Trim to a reasonable window
        return text.length > 2000 ? text.slice(0, 2000) : text;
      })();

      return {
        title,
        price: priceMatch ? priceMatch[1] : '',
        styleNumber: refMatch ? refMatch[1] : '',
        colorRef,
        pageText: bodyText.slice(0, 20000),
        galleryImages,
        allImages,
        metaDescription,
        descriptionFromDom,
        compositionFromDom,
      };
    });

    const apiDescription = String(
      resolved.item?.detail?.longDescription
      || resolved.item?.detail?.description
      || resolved.product?.detail?.longDescription
      || '',
    ).trim();
    const compositionParts = normalizeStradivariusCompositionParts(resolved.item?.detail || {});
    const fallbackCompositionParts = compositionParts.length > 0
      ? compositionParts
      : normalizeStradivariusCompositionParts(resolved.product?.detail || {});
    const compositionDetails = formatStradivariusCompositionDetails(
      fallbackCompositionParts,
      [],
    );

    // DOM fallbacks when API didn't return description/composition
    const domDescription = String(pageData.descriptionFromDom || '').trim();
    const metaDescription = String(pageData.metaDescription || '').trim();
    const finalDescription = apiDescription
      || domDescription
      || (metaDescription.length >= 40 ? metaDescription : '');

    // Parse "Composition and care" block from DOM into Outer shell / Lining / other
    const parseDomComposition = (rawText) => {
      if (!rawText) return { outerShell: null, lining: null, other: null };
      const cleaned = String(rawText)
        .replace(/\r/g, '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      // Drop the heading itself
      const startIdx = cleaned.findIndex((line) =>
        /^(composition\s+and\s+care|composition,?\s*care(\s+and\s+source)?|materials,?\s+care\s+and\s+source)$/i.test(line));
      const body = startIdx >= 0 ? cleaned.slice(startIdx + 1) : cleaned;
      // Stop at unrelated next-section headings
      const stopRegex = /^(care\s+instructions|shipping|returns|how\s+to\s+wear|recommend|you\s+may|composition\s+of\s+other|see\s+detail|certifications)$/i;
      const trimmed = [];
      for (const line of body) {
        if (stopRegex.test(line)) break;
        trimmed.push(line);
      }
      let currentLabel = '';
      const sections = { outer: [], lining: [], other: [] };
      for (const line of trimmed) {
        if (/^outer\s+shell$/i.test(line)) { currentLabel = 'outer'; continue; }
        if (/^lining$/i.test(line)) { currentLabel = 'lining'; continue; }
        if (/^(filling|padding|sole|trim|fabric|main\s+material)$/i.test(line)) { currentLabel = 'other'; continue; }
        if (currentLabel === 'outer') sections.outer.push(line);
        else if (currentLabel === 'lining') sections.lining.push(line);
        else sections.other.push(line);
      }
      return {
        outerShell: sections.outer.length ? sections.outer.join(' ').trim() : null,
        lining: sections.lining.length ? sections.lining.join(' ').trim() : null,
        other: sections.other.length ? sections.other.join(' ').trim() : null,
      };
    };
    const domComposition = parseDomComposition(pageData.compositionFromDom || '');
    const finalComposition = {
      outerShell: compositionDetails.outerShell || domComposition.outerShell,
      lining: compositionDetails.lining || domComposition.lining,
      other: compositionDetails.other || domComposition.other,
    };
    const styleNumber = pageData.styleNumber || resolved.styleNumber || resolved.input;
    const apiImageEntries = collectStradivariusApiImageEntries([
      resolved.color || null,
      resolved.color?.image || null,
    ])
      .filter((entry) => isRelevantStradivariusProductImage(entry.src, styleNumber));
    const pageImageEntries = [
      ...(pageData.galleryImages || []),
      ...(pageData.allImages || []),
      ...[...capturedImageUrls].map((src) => ({ src, alt: '' })),
    ]
      .filter((entry) => isRelevantStradivariusProductImage(entry.src, styleNumber));
    const imageCandidates = apiImageEntries.length > 0
      ? [...apiImageEntries, ...pageImageEntries]
      : pageImageEntries;
    const imageMap = buildStradivariusImageMap(imageCandidates);
    const imageUrls = Object.values(imageMap);
    const colorRef = resolved.color?.name || pageData.colorRef || '';

    emitInditexScrapeResult({
      emitLog,
      brand: 'Stradivarius',
      requestedReference: reference,
      actualStyleNumber: styleNumber,
      productName: pageData.title || resolved.product?.name || `Stradivarius ${styleNumber}`,
      imageCount: imageUrls.length,
      hasDescription: Boolean(finalDescription),
      hasComposition: Boolean(finalComposition),
    });

    return {
      styleNumber,
      productId: styleNumber,
      brand: 'Stradivarius',
      name: pageData.title || resolved.product?.name || `Stradivarius ${styleNumber}`,
      price: pageData.price || '',
      colorRef,
      description: finalDescription || '',
      composition: finalComposition,
      url: resolved.url,
      imageUrls,
      imageMap,
      pageText: pageData.pageText || '',
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function scrapePullAndBearProduct(browser, reference, emitLog, ensureActive) {
  const resolved = await resolvePullAndBearProduct(browser, reference, emitLog, ensureActive);
  if (!resolved.url) {
    throw new Error(`Could not build a Pull&Bear product URL for ${resolved.styleNumber}.`);
  }

  // ── Firecrawl mode check ────────────────────────────────────────
  const currentMode = firecrawlService.getMode();
  if (currentMode === 'manual') {
    emitLog(` Pull&Bear ${reference || ''} 手动模式: 使用 Firecrawl 抓取`, 'warning');
    try {
      ensureActive();
      const fcResult = await firecrawlFallback.tryFirecrawlFallback(resolved.url, {
        imageFilter: (imgUrl) => isLikelyPullAndBearProductImage(imgUrl),
        urlNormalizer: (u) => u.split('?')[0],
        candidateIds: [String(reference || '').replace(/\D/g, '')],
        emitLog: (msg, type) => emitLog(`    ${msg}`, type),
      });

      // ─ Parse product text from Firecrawl HTML ────────────────────
      const html = fcResult.html || '';
      let name = '';
      let price = '';
      let description = '';
      let compositionText = null;

      const h1Match = html.match(/<h1[^>]*>(.*?)<\/h1>/is);
      if (h1Match) {
        name = h1Match[1].replace(/<[^>]+>/g, '').trim();
      }

      const priceMatch = html.match(/[€$£¥]([\d.,]+)/);
      if (priceMatch) {
        price = priceMatch[0];
      }

      const descPatterns = [
        /["']description["']?:\s*["']([^"']+)["']/i,
        /<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i,
      ];
      for (const pattern of descPatterns) {
        const m = html.match(pattern);
        if (m) {
          description = m[1].trim();
          break;
        }
      }

      const compPatterns = [
        /["']composition["']?:\s*["']([^"']+)["']/i,
        /["']materials["']?:\s*["']([^"']+)["']/i,
      ];
      for (const pattern of compPatterns) {
        const m = html.match(pattern);
        if (m) {
          compositionText = m[1].trim();
          break;
        }
      }

      const styleNumber = String(reference || '').replace(/\D/g, '');
      return {
        styleNumber,
        productId: styleNumber,
        inputStyleNumber: styleNumber,
        brand: 'Pull&Bear',
        name: name || `Pull&Bear ${styleNumber}`,
        price,
        colorRef: '',
        description,
        composition: { outerShell: null, lining: null, other: compositionText || null },
        url: resolved.url,
        imageUrls: fcResult.imageUrls,
        imageMap: {},
        pageText: '',
        usedEngine: 'firecrawl',
      };
    } catch (fcError) {
      emitLog(` Pull&Bear ${reference || ''} Firecrawl 抓取失败: ${fcError.message}`, 'error');
      throw new Error(`Firecrawl failed: ${fcError.message}`);
    }
  }
  // ── End Firecrawl manual mode ───────────────────────────────────

  const page = await browser.newPage();
  await antiDetection.applyRetailBrowsingProfile(page);
  await page.setViewport(antiDetection.getRandomViewport());
  await page.bringToFront().catch(() => {});

  const capturedImageUrls = new Set();
  page.on('response', (resp) => {
    const reqUrl = canonicalizeStradivariusImageUrl(resp.url());
    if (isLikelyPullAndBearProductImage(reqUrl)) {
      capturedImageUrls.add(reqUrl);
    }
  });

  try {
    ensureActive();
    await antiDetection.randomDelay(300, 600);
    await gotoPullAndBearWithRetry(page, resolved.url, `Pull&Bear product ${resolved.styleNumber}`, 2, { timeout: 26000 });
    await antiDetection.randomDelay(800, 1300);
    await dismissCommonPullAndBearPopups(page);
    await antiDetection.humanScroll(page, 800);
    await waitForPullAndBearProductImages(page, resolved.styleNumber || resolved.input, capturedImageUrls, ensureActive, emitLog);
    await antiDetection.randomDelay(250, 450);

    const pageData = await page.evaluate(() => {
      const bodyText = String(document.body?.innerText || '');
      const title = document.querySelector('h1')?.textContent?.trim() || '';
      const priceMatch = bodyText.match(/([$€£]\s?[\d,.]+)/);
      const lines = bodyText
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      const refLine = lines.find((line) => /^.*REF\.\s*[0-9/]+/i.test(line)) || '';
      const refMatch = refLine.match(/REF\.\s*([0-9/]+)/i);
      const galleryImages = [...document.querySelectorAll('img')]
        .map((img) => ({
          src: img.currentSrc || img.src,
          alt: img.alt || '',
          originalName: img.getAttribute('data-name') || '',
        }))
        .filter((item) => item.src && item.src.includes('static.pullandbear.net'));

      return {
        title,
        price: priceMatch ? priceMatch[1] : '',
        styleNumber: refMatch ? refMatch[1] : '',
        pageText: bodyText.slice(0, 22000),
        galleryImages,
      };
    });

    const apiDescription = String(
      resolved.color?.longDescription
      || resolved.item?.detail?.longDescription
      || resolved.item?.detail?.description
      || resolved.product?.detail?.longDescription
      || '',
    ).trim();
    const compositionParts = normalizeStradivariusCompositionParts(resolved.color || {});
    const fallbackCompositionParts = compositionParts.length > 0
      ? compositionParts
      : normalizeStradivariusCompositionParts(resolved.item?.detail || resolved.product?.detail || {});
    const compositionDetails = formatStradivariusCompositionDetails(
      fallbackCompositionParts,
      [],
    );

    const normalizedInputReference = normalizePullAndBearReference(reference);
    const inputStyleNumber = normalizedInputReference?.compactDigits || String(reference || '').replace(/[^\d]/g, '') || resolved.input;
    const styleNumber = inputStyleNumber || pageData.styleNumber || resolved.styleNumber || resolved.input;
    const apiImageEntries = collectPullAndBearApiImageEntries([
      resolved.product || null,
      resolved.item || null,
      resolved.color || null,
      resolved.color?.image || null,
    ])
      .map((entry) => ({ ...entry, src: canonicalizeStradivariusImageUrl(entry.src) }))
      .filter((entry) => isRelevantPullAndBearProductImage(entry.src, styleNumber));
    const pageImageEntries = [
      ...(pageData.galleryImages || []),
      ...[...capturedImageUrls].map((src) => ({ src, alt: '' })),
    ]
      .filter((entry) => isRelevantPullAndBearProductImage(entry.src, styleNumber));
    const imageCandidates = apiImageEntries.length > 0
      ? [...apiImageEntries, ...pageImageEntries]
      : pageImageEntries;
    const imageMap = buildPullAndBearImageMap(imageCandidates);
    const imageUrls = Object.values(imageMap);
    const productName = pageData.title || resolved.product?.name || `Pull&Bear ${styleNumber}`;

    emitInditexScrapeResult({
      emitLog,
      brand: 'Pull&Bear',
      requestedReference: reference,
      actualStyleNumber: styleNumber,
      productName,
      imageCount: imageUrls.length,
      hasDescription: Boolean(apiDescription),
      hasComposition: Boolean(compositionDetails),
    });

    return {
      styleNumber,
      productId: inputStyleNumber || styleNumber,
      inputStyleNumber: inputStyleNumber || styleNumber,
      brand: 'Pull&Bear',
      name: productName,
      price: pageData.price || '',
      colorRef: resolved.color?.name || '',
      description: apiDescription || '',
      composition: compositionDetails,
      url: resolved.url,
      imageUrls,
      imageMap,
      pageText: pageData.pageText || '',
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function runStradivariusScraper(config, emitLog, emitProgress, taskController, previewBridge = null) {
  let { styleNumbers, excelPath, outputDir, tabConcurrency, downloadConcurrency } = config;
  styleNumbers = normalizeManualStyleNumbers(styleNumbers);
  const ensureActive = () => taskController?.throwIfCancelled?.();
  let browser = null;

  if (excelPath) {
    try {
      ensureActive();
      emitLog(`Reading Excel file: ${excelPath}`, 'info');
      const workbook = XLSX.readFile(excelPath);
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      styleNumbers = [];
      const range = XLSX.utils.decode_range(worksheet['!ref'] || 'A1:B1');
      for (let row = 1; row <= range.e.r; row += 1) {
        const cellAddress = XLSX.utils.encode_cell({ r: row, c: 1 });
        const cell = worksheet[cellAddress];
        if (cell) {
          const displayValue = String(cell.w ?? cell.v ?? '').trim();
          if (displayValue) {
            styleNumbers.push(displayValue);
            emitLog(`📥 Excel row ${row + 1} column B: "${displayValue}"`, 'info');
          }
        }
      }
      emitLog(`Loaded ${styleNumbers.length} Stradivarius style numbers from Excel.`, 'success');
    } catch (error) {
      throw new Error(`Excel parse failed: ${error.message}`);
    }
  }

  ensureActive();
  if (!styleNumbers || styleNumbers.length === 0) {
    throw new Error('No Stradivarius style numbers were found. Put the SKU values in column B or enter them manually.');
  }

  const targetDir = !outputDir || outputDir === '未选择' ? path.join(app.getPath('desktop'), 'Stradivarius') : outputDir;
  fs.mkdirSync(targetDir, { recursive: true });

  emitLog(`📁 Output directory: ${targetDir}`, 'info');
  emitLog('🌐 Launching the English Stradivarius scraper session...', 'info');
  emitLog('💡 Stradivarius uses the US English storefront and resolves products by the provided style number.', 'info');

  let executablePath = findChromePath();
  if (!executablePath) {
    emitLog('⬇️ No local Chrome was found. Downloading a managed Chrome runtime for GS Bot...', 'warning');
    const chromeInstall = await ensureChromeRuntimeAvailable((payload) => {
      if (payload?.status) {
        emitLog(payload.status, payload.phase === 'complete' ? 'success' : 'info');
      }
    });
    if (!chromeInstall?.success) {
      throw new Error(chromeInstall?.error || 'Chrome download failed.');
    }
    executablePath = chromeInstall.executablePath;
  }

  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: false,
      userDataDir: getStradivariusSessionDir(),
      args: antiDetection.getRetailLaunchArgs(),
      ignoreDefaultArgs: ['--enable-automation'],
      defaultViewport: null,
    });
    previewBridge?.attachToBrowser(browser);

    taskController?.onCancel(() => {
      if (browser && browser.isConnected()) {
        browser.close().catch(() => {});
      }
    });

    const products = [];
    const totalItems = styleNumbers.length;
    let currentProgress = 5;
    emitProgress(currentProgress);
    const effectiveTabConcurrency = 1;

    // Helper: run a single reference through scrapeStradivariusProduct (one attempt)
    const processReference = async (reference) => {
      try {
        ensureActive();
        return await scrapeStradivariusProduct(browser, reference, emitLog, ensureActive);
      } catch (error) {
        if (isCancellationError(error) || taskController?.cancelled) {
          throw new TaskCancelledError();
        }
        const normalizedReference = normalizeStradivariusReference(reference);
        emitLog(`    ⚠️ Stradivarius ${normalizedReference?.styleNumber || reference} failed: ${error.message || error}`, 'warning');
        return {
          styleNumber: normalizedReference?.styleNumber || reference,
          productId: normalizedReference?.styleNumber || reference,
          url: '',
          error: error.message || 'Unknown error',
          imageUrls: [],
          imageMap: {},
        };
      }
    };

    // ── First pass: try each item once, don't let one stuck item block others
    emitLog(`🚀 Stradivarius 第一轮: ${totalItems} 个款号 (直接搜索框输入款号)`, 'warning');
    const firstPassResults = new Array(totalItems);
    for (let i = 0; i < totalItems; i += effectiveTabConcurrency) {
      ensureActive();
      const batch = styleNumbers.slice(i, i + effectiveTabConcurrency);
      emitLog(`🔄 [第一轮] Processing Stradivarius batch ${Math.floor(i / effectiveTabConcurrency) + 1}`, 'warning');

      const batchResults = await Promise.all(batch.map(async (reference, idxInBatch) => {
        const normalizedReference = normalizeStradivariusReference(reference);
        emitLog(`🎯 Stradivarius input raw: "${reference}"${normalizedReference?.styleNumber ? ` -> ${normalizedReference.styleNumber}` : ''}`, 'info');
        const result = await processReference(reference);
        return { index: i + idxInBatch, result };
      }));

      for (const { index, result } of batchResults) {
        firstPassResults[index] = result;
      }
      currentProgress = 5 + Math.round(((i + batch.length) / totalItems) * 25);
      emitProgress(currentProgress);
      if (i + effectiveTabConcurrency < totalItems) {
        await antiDetection.randomDelay(1500, 2500);
      }
    }

    // Collect failures
    const failedIndexes = [];
    for (let idx = 0; idx < firstPassResults.length; idx += 1) {
      const r = firstPassResults[idx];
      if (!r || !r.url || !r.imageUrls || r.imageUrls.length === 0) {
        failedIndexes.push(idx);
      }
    }

    const firstPassSuccess = totalItems - failedIndexes.length;
    emitLog(`📊 第一轮完成: ${firstPassSuccess}/${totalItems} 成功, ${failedIndexes.length} 需要第二轮重试`, 'info');

    // ── Second pass: retry only failed items (direct typed search again)
    if (failedIndexes.length > 0) {
      emitLog(`🔁 Stradivarius 第二轮重试: ${failedIndexes.length} 个款号`, 'warning');
      for (let n = 0; n < failedIndexes.length; n += 1) {
        ensureActive();
        const idx = failedIndexes[n];
        const reference = styleNumbers[idx];
        const remaining = failedIndexes.length - n;
        emitLog(`🔄 [第二轮 剩余 ${remaining}] ${reference}`, 'warning');
        await antiDetection.randomDelay(1800, 3200);
        const result = await processReference(reference);
        firstPassResults[idx] = result;
        if (result?.url && result.imageUrls?.length > 0) {
          emitLog(`    ✅ 第二轮成功: ${reference}`, 'success');
        } else {
          const manualUrl = buildStradivariusManualSearchUrl(reference);
          emitLog(`    ❌ 第二轮仍失败: ${reference}`, 'error');
          emitLog(`    👉 建议人工下载: ${manualUrl}`, 'warning');
        }
        currentProgress = 30 + Math.round(((n + 1) / failedIndexes.length) * 20);
        emitProgress(currentProgress);
        if (n < failedIndexes.length - 1) {
          await antiDetection.randomDelay(2000, 3500);
        }
      }
    }

    products.push(...firstPassResults);
    currentProgress = 50;
    emitProgress(currentProgress);

    ensureActive();
    emitLog('🌐 Stradivarius page extraction complete. Preparing image downloads...', 'warning');

    const successProducts = products.filter((product) => product.imageUrls && product.imageUrls.length > 0);
    const failedProducts = products.filter((product) => !product.imageUrls || product.imageUrls.length === 0);
    const totalImages = successProducts.reduce((sum, product) => sum + product.imageUrls.length, 0);
    emitLog(`📊 Stradivarius summary: ${successProducts.length} styles succeeded, ${failedProducts.length} styles failed, ${totalImages} images collected.`, 'info');

    if (failedProducts.length > 0) {
      failedProducts.forEach((product) => {
        emitLog(`    ❌ ${product.styleNumber} - ${product.error || 'No product images found'}`, 'error');
        emitLog(`       👉 建议人工下载: ${buildStradivariusManualSearchUrl(product.styleNumber)}`, 'warning');
      });
    }

    const allTasks = [];
    for (const product of successProducts) {
      ensureActive();
      const cleanStyleNumber = sanitizeFileSegment(String(product.productId || product.styleNumber || '').replace(/\//g, '-'), 'stradivarius-item');
      const styleDir = path.join(targetDir, cleanStyleNumber);
      fs.rmSync(styleDir, { recursive: true, force: true });
      fs.mkdirSync(styleDir, { recursive: true });

      const classified = product.imageMap && Object.keys(product.imageMap).length > 0
        ? product.imageMap
        : buildStradivariusImageMap((product.imageUrls || []).map((url) => ({ src: url })));

      for (const [label, imgUrl] of Object.entries(classified)) {
        const ext = getUrlExtension(imgUrl, '.jpg');
        const filename = `${cleanStyleNumber}_${label}${ext}`;
        const filePath = path.join(styleDir, filename);
        allTasks.push(() => {
          ensureActive();
          return downloadFile(imgUrl, filePath, {
            headers: {
              Referer: product.url || STRADIVARIUS_ENTRY_URL,
              'User-Agent': 'Mozilla/5.0',
            },
            timeoutMs: 45000,
          })
            .then((size) => {
              if (size) {
                emitLog(`    ⬇️ [saved] ${filename} (${size.toFixed(1)} KB)`);
              }
            })
            .catch((error) => {
              emitLog(`    ❌ [failed] ${filename}: ${error.message}`, 'error');
            });
        });
      }

      const infoData = {
        styleNumber: product.productId || product.styleNumber,
        brand: product.brand || 'Stradivarius',
        name: product.name,
        price: product.price,
        colorRef: product.colorRef,
        description: product.description,
        composition: product.composition || null,
        url: product.url,
        images: classified,
      };

      const infoPath = path.join(styleDir, `${cleanStyleNumber}_info.json`);
      fs.writeFileSync(infoPath, JSON.stringify(infoData, null, 2), 'utf-8');
      emitLog(`📄 Saved product metadata: ${cleanStyleNumber}_info.json`, 'success');
    }

    emitLog(`📦 Downloading ${allTasks.length} Stradivarius images with ${downloadConcurrency} worker(s)...`, 'info');

    let completedTasks = 0;
    const tasksWithProgress = allTasks.map((task) => async () => {
      ensureActive();
      await task();
      completedTasks += 1;
      emitProgress(50 + Math.round((completedTasks / Math.max(allTasks.length, 1)) * 50));
    });

    if (tasksWithProgress.length > 0) {
      await parallelLimit(tasksWithProgress, downloadConcurrency);
    }

    emitProgress(100);

    const summary = products.map((product) => ({
      styleNumber: product.productId || product.styleNumber,
      brand: product.brand || 'Stradivarius',
      name: product.name,
      price: product.price,
      colorRef: product.colorRef,
      description: product.description || '',
      composition: product.composition || null,
      images: product.imageUrls ? product.imageUrls.length : 0,
      error: product.error || null,
    }));
    const summaryPath = path.join(targetDir, 'summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf-8');
    emitLog('📊 Saved summary.json', 'success');

    if (failedProducts.length > 0) {
      const failedSummary = failedProducts.map((product) => ({
        styleNumber: product.productId || product.styleNumber,
        error: product.error || 'No product images found',
      }));
      const failedJsonPath = path.join(targetDir, 'failed_styles.json');
      const failedTxtPath = path.join(targetDir, 'failed_styles.txt');
      fs.writeFileSync(failedJsonPath, JSON.stringify(failedSummary, null, 2), 'utf-8');
      fs.writeFileSync(
        failedTxtPath,
        failedSummary.map((item) => `${item.styleNumber}\t${item.error}`).join('\n'),
        'utf-8',
      );
      emitLog('📄 Saved failed_styles.json', 'success');
      emitLog('📄 Saved failed_styles.txt', 'success');
    }

    if (excelPath) {
      try {
        const workbook = XLSX.readFile(excelPath);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
        const resultMap = new Map();

        products.forEach((product) => {
          const key = String(product.productId || product.styleNumber || '').trim();
          if (!key) {
            return;
          }
          resultMap.set(key, product);
          resultMap.set(key.replace(/\s+/g, ''), product);
        });

        if (!rows[0]) {
          rows[0] = [];
        }
        rows[0][2] = 'Status';
        rows[0][3] = 'Image Count';
        rows[0][4] = 'Error';

        for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
          const row = rows[rowIndex] || [];
          const rawValue = String(row[1] || '').trim();
          if (!rawValue) {
            continue;
          }

          const matched = resultMap.get(rawValue) || resultMap.get(rawValue.replace(/\s+/g, ''));
          if (!matched) {
            row[2] = 'Not processed';
            row[3] = 0;
            row[4] = '';
            rows[rowIndex] = row;
            continue;
          }

          const imageCount = matched.imageUrls ? matched.imageUrls.length : 0;
          row[2] = imageCount > 0 ? 'Success' : 'Failed';
          row[3] = imageCount;
          row[4] = matched.error || '';
          rows[rowIndex] = row;
        }

        const annotatedSheet = XLSX.utils.aoa_to_sheet(rows);
        workbook.Sheets[sheetName] = annotatedSheet;
        const parsedExcelPath = path.parse(excelPath);
        const annotatedPath = path.join(parsedExcelPath.dir, `${parsedExcelPath.name}_stradivarius_results${parsedExcelPath.ext}`);
        XLSX.writeFile(workbook, annotatedPath);
        emitLog(`📄 Saved annotated Excel: ${path.basename(annotatedPath)}`, 'success');
      } catch (error) {
        emitLog(`⚠️ Could not save annotated Stradivarius Excel: ${error.message}`, 'warning');
      }
    }

    emitLog(`🎉 Stradivarius scraping finished. Files saved to: ${targetDir}`, 'success');
  } finally {
    if (browser && browser.isConnected()) {
      await browser.close().catch(() => {});
    }
  }
}

async function runPullAndBearScraper(config, emitLog, emitProgress, taskController, previewBridge = null) {
  let { styleNumbers, excelPath, outputDir, downloadConcurrency } = config;
  styleNumbers = normalizeManualStyleNumbers(styleNumbers);
  const ensureActive = () => taskController?.throwIfCancelled?.();
  let browser = null;

  if (excelPath) {
    try {
      ensureActive();
      emitLog(`Reading Excel file: ${excelPath}`, 'info');
      const workbook = XLSX.readFile(excelPath);
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      styleNumbers = [];
      const range = XLSX.utils.decode_range(worksheet['!ref'] || 'A1:B1');
      for (let row = 1; row <= range.e.r; row += 1) {
        const cellAddress = XLSX.utils.encode_cell({ r: row, c: 1 });
        const cell = worksheet[cellAddress];
        if (cell) {
          const displayValue = String(cell.w ?? cell.v ?? '').trim();
          if (displayValue) {
            styleNumbers.push(displayValue);
            emitLog(`📥 Excel row ${row + 1} column B: "${displayValue}"`, 'info');
          }
        }
      }
      emitLog(`Loaded ${styleNumbers.length} Pull&Bear style numbers from Excel.`, 'success');
    } catch (error) {
      throw new Error(`Excel parse failed: ${error.message}`);
    }
  }

  ensureActive();
  if (!styleNumbers || styleNumbers.length === 0) {
    throw new Error('No Pull&Bear style numbers were found. Put the SKU values in column B or enter them manually.');
  }

  const targetDir = !outputDir || outputDir === '未选择' ? path.join(app.getPath('desktop'), 'Pull&Bear') : outputDir;
  fs.mkdirSync(targetDir, { recursive: true });

  emitLog(`📁 Output directory: ${targetDir}`, 'info');
  emitLog('🌐 Launching the English Pull&Bear scraper session...', 'info');
  emitLog('💡 Pull&Bear uses the US English storefront and resolves 10-digit style/color numbers by API first.', 'info');

  let executablePath = findChromePath();
  if (!executablePath) {
    emitLog('⬇️ No local Chrome was found. Downloading a managed Chrome runtime for GS Bot...', 'warning');
    const chromeInstall = await ensureChromeRuntimeAvailable((payload) => {
      if (payload?.status) {
        emitLog(payload.status, payload.phase === 'complete' ? 'success' : 'info');
      }
    });
    if (!chromeInstall?.success) {
      throw new Error(chromeInstall?.error || 'Chrome download failed.');
    }
    executablePath = chromeInstall.executablePath;
  }

  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: false,
      userDataDir: getPullAndBearSessionDir(),
      args: antiDetection.getRetailLaunchArgs(),
      ignoreDefaultArgs: ['--enable-automation'],
      defaultViewport: null,
    });
    previewBridge?.attachToBrowser(browser);

    taskController?.onCancel(() => {
      if (browser && browser.isConnected()) {
        browser.close().catch(() => {});
      }
    });

    const products = [];
    const totalItems = styleNumbers.length;
    let currentProgress = 5;
    emitProgress(currentProgress);
    const effectiveTabConcurrency = 2;

    for (let index = 0; index < totalItems; index += effectiveTabConcurrency) {
      ensureActive();
      const batch = styleNumbers.slice(index, index + effectiveTabConcurrency);
      emitLog(`🔄 Processing Pull&Bear batch ${Math.floor(index / effectiveTabConcurrency) + 1}`, 'warning');

      const batchResults = await Promise.all(batch.map(async (reference) => {
        const maxRetries = 2;
        let lastError = null;
        const normalizedReference = normalizePullAndBearReference(reference);
        emitLog(`🎯 Pull&Bear input raw: "${reference}"${normalizedReference?.styleReference ? ` -> ${normalizedReference.styleReference}${normalizedReference.colorCode ? `/${normalizedReference.colorCode}` : ''}` : ''}`, 'info');

        for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
          try {
            ensureActive();
            if (attempt > 1) {
              emitLog(`    🔄 Retrying Pull&Bear reference (${attempt}/${maxRetries}): ${reference}`, 'warning');
              await antiDetection.randomDelay(1300, 2200);
            }
            return await scrapePullAndBearProduct(browser, reference, emitLog, ensureActive);
          } catch (error) {
            if (isCancellationError(error) || taskController?.cancelled) {
              throw new TaskCancelledError();
            }
            lastError = error;
            emitLog(`    ⚠️ Pull&Bear reference failed (${attempt}/${maxRetries}): ${reference} -> ${error.message}`, 'warning');
          }
        }

        return {
          styleNumber: normalizedReference?.compactDigits || reference,
          productId: normalizedReference?.compactDigits || reference,
          brand: 'Pull&Bear',
          url: '',
          error: lastError?.message || 'Unknown error',
          imageUrls: [],
          imageMap: {},
        };
      }));

      products.push(...batchResults);
      currentProgress = 5 + Math.round(((index + batch.length) / totalItems) * 45);
      emitProgress(currentProgress);

      if (index + effectiveTabConcurrency < totalItems) {
        await antiDetection.randomDelay(1800, 2800);
      }
    }

    ensureActive();
    emitLog('🌐 Pull&Bear page extraction complete. Preparing image downloads...', 'warning');

    const successProducts = products.filter((product) => product.imageUrls && product.imageUrls.length > 0);
    const failedProducts = products.filter((product) => !product.imageUrls || product.imageUrls.length === 0);
    const totalImages = successProducts.reduce((sum, product) => sum + product.imageUrls.length, 0);
    emitLog(`📊 Pull&Bear summary: ${successProducts.length} styles succeeded, ${failedProducts.length} styles failed, ${totalImages} images collected.`, 'info');

    if (failedProducts.length > 0) {
      failedProducts.forEach((product) => {
        emitLog(`    ❌ ${product.styleNumber} - ${product.error || 'No product images found'}`, 'error');
      });
    }

    const allTasks = [];
    for (const product of successProducts) {
      ensureActive();
      const cleanStyleNumber = sanitizeFileSegment(String(product.inputStyleNumber || product.productId || product.styleNumber || '').replace(/\//g, '-'), 'pullandbear-item');
      const styleDir = path.join(targetDir, cleanStyleNumber);
      fs.rmSync(styleDir, { recursive: true, force: true });
      fs.mkdirSync(styleDir, { recursive: true });

      const classified = product.imageMap && Object.keys(product.imageMap).length > 0
        ? product.imageMap
        : buildPullAndBearImageMap((product.imageUrls || []).map((url) => ({ src: url })));

      for (const [label, imgUrl] of Object.entries(classified)) {
        const ext = getUrlExtension(imgUrl, '.jpg');
        const filename = `${cleanStyleNumber}_${label}${ext}`;
        const filePath = path.join(styleDir, filename);
        allTasks.push(() => {
          ensureActive();
          return downloadFile(imgUrl, filePath, {
            headers: {
              Referer: product.url || PULLANDBEAR_ENTRY_URL,
              'User-Agent': 'Mozilla/5.0',
            },
            timeoutMs: 45000,
          })
            .then((size) => {
              if (size) {
                emitLog(`    ⬇️ [saved] ${filename} (${size.toFixed(1)} KB)`);
              }
            })
            .catch((error) => {
              emitLog(`    ❌ [failed] ${filename}: ${error.message}`, 'error');
            });
        });
      }

      const infoData = {
        styleNumber: product.productId || product.styleNumber,
        brand: product.brand || 'Pull&Bear',
        name: product.name,
        price: product.price,
        colorRef: product.colorRef,
        description: product.description,
        composition: product.composition || null,
        url: product.url,
        images: classified,
      };

      const infoPath = path.join(styleDir, `${cleanStyleNumber}_info.json`);
      fs.writeFileSync(infoPath, JSON.stringify(infoData, null, 2), 'utf-8');
      emitLog(`📄 Saved product metadata: ${cleanStyleNumber}_info.json`, 'success');
    }

    emitLog(`📦 Downloading ${allTasks.length} Pull&Bear images with ${downloadConcurrency} worker(s)...`, 'info');

    let completedTasks = 0;
    const tasksWithProgress = allTasks.map((task) => async () => {
      ensureActive();
      await task();
      completedTasks += 1;
      emitProgress(50 + Math.round((completedTasks / Math.max(allTasks.length, 1)) * 50));
    });

    if (tasksWithProgress.length > 0) {
      await parallelLimit(tasksWithProgress, downloadConcurrency);
    }

    emitProgress(100);

    const summary = products.map((product) => ({
      styleNumber: product.productId || product.styleNumber,
      brand: product.brand || 'Pull&Bear',
      name: product.name,
      price: product.price,
      colorRef: product.colorRef,
      description: product.description || '',
      composition: product.composition || null,
      images: product.imageUrls ? product.imageUrls.length : 0,
      error: product.error || null,
    }));
    const summaryPath = path.join(targetDir, 'summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf-8');
    emitLog('📊 Saved summary.json', 'success');

    if (failedProducts.length > 0) {
      const failedSummary = failedProducts.map((product) => ({
        styleNumber: product.productId || product.styleNumber,
        error: product.error || 'No product images found',
      }));
      fs.writeFileSync(path.join(targetDir, 'failed_styles.json'), JSON.stringify(failedSummary, null, 2), 'utf-8');
      fs.writeFileSync(
        path.join(targetDir, 'failed_styles.txt'),
        failedSummary.map((item) => `${item.styleNumber}\t${item.error}`).join('\n'),
        'utf-8',
      );
      emitLog('📄 Saved failed_styles.json', 'success');
      emitLog('📄 Saved failed_styles.txt', 'success');
    }

    if (excelPath) {
      try {
        const workbook = XLSX.readFile(excelPath);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
        const resultMap = new Map();

        products.forEach((product) => {
          const key = String(product.productId || product.styleNumber || '').trim();
          if (!key) {
            return;
          }
          resultMap.set(key, product);
          resultMap.set(key.replace(/\s+/g, ''), product);
        });

        if (!rows[0]) {
          rows[0] = [];
        }
        rows[0][2] = 'Status';
        rows[0][3] = 'Image Count';
        rows[0][4] = 'Error';

        for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
          const row = rows[rowIndex] || [];
          const rawValue = String(row[1] || '').trim();
          if (!rawValue) {
            continue;
          }
          const normalized = normalizePullAndBearReference(rawValue);
          const keys = [
            rawValue,
            rawValue.replace(/\s+/g, ''),
            normalized?.compactDigits || '',
          ].filter(Boolean);
          const matched = keys.map((key) => resultMap.get(key)).find(Boolean);
          if (!matched) {
            row[2] = 'Not processed';
            row[3] = 0;
            row[4] = '';
            rows[rowIndex] = row;
            continue;
          }

          const imageCount = matched.imageUrls ? matched.imageUrls.length : 0;
          row[2] = imageCount > 0 ? 'Success' : 'Failed';
          row[3] = imageCount;
          row[4] = matched.error || '';
          rows[rowIndex] = row;
        }

        workbook.Sheets[sheetName] = XLSX.utils.aoa_to_sheet(rows);
        const parsedExcelPath = path.parse(excelPath);
        const annotatedPath = path.join(parsedExcelPath.dir, `${parsedExcelPath.name}_pullandbear_results${parsedExcelPath.ext}`);
        XLSX.writeFile(workbook, annotatedPath);
        emitLog(`📄 Saved annotated Excel: ${path.basename(annotatedPath)}`, 'success');
      } catch (error) {
        emitLog(`⚠️ Could not save annotated Pull&Bear Excel: ${error.message}`, 'warning');
      }
    }

    emitLog(`🎉 Pull&Bear scraping finished. Files saved to: ${targetDir}`, 'success');
  } finally {
    if (browser && browser.isConnected()) {
      await browser.close().catch(() => {});
    }
  }
}

async function scrapeBershkaProduct(browser, reference, emitLog, ensureActive, options = {}) {
  const normalized = await resolveBershkaProductUrl(browser, reference, emitLog, ensureActive, options);

  // ── Firecrawl mode check ───────────────────────────────────────
  const currentMode = firecrawlService.getMode();
  if (currentMode === 'manual') {
    emitLog(` Bershka ${reference || ''} 手动模式: 使用 Firecrawl 抓取`, 'warning');
    try {
      ensureActive();
      const fcResult = await firecrawlFallback.tryFirecrawlFallback(normalized.url, {
        imageFilter: (imgUrl) => isLikelyBershkaProductImage(imgUrl),
        urlNormalizer: (u) => u.split('?')[0],
        candidateIds: [String(reference || '').replace(/\D/g, '')],
        emitLog: (msg, type) => emitLog(`    ${msg}`, type),
      });

      // ─ Parse product text from Firecrawl HTML ────────────────────
      const html = fcResult.html || '';
      let name = '';
      let price = '';
      let description = '';
      let compositionText = null;

      const h1Match = html.match(/<h1[^>]*>(.*?)<\/h1>/is);
      if (h1Match) {
        name = h1Match[1].replace(/<[^>]+>/g, '').trim();
      }

      const priceMatch = html.match(/[€$£¥]([\d.,]+)/);
      if (priceMatch) {
        price = priceMatch[0];
      }

      const descPatterns = [
        /["']description["']?:\s*["']([^"']+)["']/i,
        /<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i,
      ];
      for (const pattern of descPatterns) {
        const m = html.match(pattern);
        if (m) {
          description = m[1].trim();
          break;
        }
      }

      const compPatterns = [
        /["']composition["']?:\s*["']([^"']+)["']/i,
        /["']materials["']?:\s*["']([^"']+)["']/i,
      ];
      for (const pattern of compPatterns) {
        const m = html.match(pattern);
        if (m) {
          compositionText = m[1].trim();
          break;
        }
      }

      const styleNumber = String(reference || '').replace(/\D/g, '');
      return {
        styleNumber,
        productId: styleNumber,
        brand: 'Bershka',
        name: name || `Bershka ${styleNumber}`,
        price,
        colorRef: '',
        description,
        composition: { outerShell: null, lining: null, other: compositionText || null },
        url: normalized.url,
        imageUrls: fcResult.imageUrls,
        pageText: '',
        usedEngine: 'firecrawl',
      };
    } catch (fcError) {
      emitLog(`❌ Bershka ${reference || ''} Firecrawl 抓取失败: ${fcError.message}`, 'error');
      throw new Error(`Firecrawl failed: ${fcError.message}`);
    }
  }
  // ── End Firecrawl manual mode ───────────────────────────────────

  const page = await browser.newPage();
  await antiDetection.applyRetailBrowsingProfile(page);
  await page.setViewport(antiDetection.getRandomViewport());
  await page.bringToFront().catch(() => {});

  if (!normalized.url) {
    await page.close().catch(() => {});
    throw new Error('Product not found on Bershka for reference: ' + reference);
  }

  const capturedUrls = new Set();
  page.on('response', (resp) => {
    const reqUrl = cleanImageUrl(resp.url());
    if (isLikelyBershkaProductImage(reqUrl)) {
      capturedUrls.add(reqUrl);
    }
  });

  try {
    ensureActive();
    await antiDetection.randomDelay(1000, 1800);
    await page.goto(normalized.url, { waitUntil: 'networkidle2', timeout: 60000 });
    // Longer wait to give all product images time to fully load before scraping
    await antiDetection.randomDelay(4000, 6000);
    await dismissCommonBershkaPopups(page);

    if (await isBershkaBlockedPage(page)) {
      throw new Error('Bershka blocked the current session while opening the product page.');
    }

    await page.evaluate(() => {
      const materialsToggle = [...document.querySelectorAll('button, summary, [role="button"]')].find((element) =>
        /materials, care and source/i.test(String(element.textContent || '').trim()),
      );
      materialsToggle?.click();
    }).catch(() => {});

    await antiDetection.randomDelay(800, 1200);
    await antiDetection.humanScroll(page, 2400);
    // Extra wait after scroll lets lazy-loaded images come in
    await antiDetection.randomDelay(2000, 3000);
    await antiDetection.humanScroll(page, 4800);
    await antiDetection.randomDelay(1500, 2500);

    const info = await page.evaluate(() => {
      const nuxtProductDetail = window.__NUXT__?.state?.productDetail || {};
      const nuxtCurrentProduct = nuxtProductDetail.currentProduct || {};
      const selectedColorId = nuxtProductDetail.selectedColorId || nuxtCurrentProduct.selectedColorId;
      const nuxtColors = Array.isArray(nuxtCurrentProduct.colors) ? nuxtCurrentProduct.colors : [];
      const selectedColor = nuxtColors.find((color) => String(color?.id) === String(selectedColorId)) || nuxtColors[0] || null;
      const metaDescription = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';
      const ldDescription = [...document.querySelectorAll('script[type="application/ld+json"]')]
        .map((node) => String(node.textContent || ''))
        .find((text) => /"description"\s*:/i.test(text)) || '';
      const bodyText = String(document.body?.innerText || '');
      const lines = bodyText
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

      const refLine = lines.find((line) => /^REF\./i.test(line)) || '';
      const refMatch = refLine.match(/REF\.\s*([0-9/]+)/i);
      const priceIndex = lines.findIndex((line) => /\d/.test(line) && /€|\$|£/.test(line) && line.length <= 24);
      const price = priceIndex >= 0 ? lines[priceIndex] : '';
      const refIndex = lines.findIndex((line) => /^REF\./i.test(line));
      const colorRef = (() => {
        const blockedColorLines = /^(NEW|DISCOUNT OF|BEFORE|SIZES|SEE MEASUREMENTS|ADD TO BASKET|FREE |PROMO ONLINE)$/i;
        if (refIndex > 0) {
          const nearbyLines = lines.slice(Math.max(0, refIndex - 4), refIndex).reverse();
          const nearbyMatch = nearbyLines.find((line) =>
            line
            && !blockedColorLines.test(line)
            && !(/\d/.test(line) && /€|\$|£/.test(line))
            && /^[A-Z][A-Z\s/-]+$/i.test(line)
          );
          if (nearbyMatch) {
            return nearbyMatch;
          }
        }

        const altColor = [...document.querySelectorAll('img[alt]')]
          .map((img) => String(img.getAttribute('alt') || '').trim())
          .find((alt) => alt.includes('-'));
        if (altColor) {
          return altColor.split('-').pop().trim().toUpperCase();
        }

        if (priceIndex >= 0 && lines[priceIndex + 1] && !/^REF\./i.test(lines[priceIndex + 1]) && !blockedColorLines.test(lines[priceIndex + 1])) {
          return lines[priceIndex + 1];
        }

        return '';
      })();
      const titleFromDocument = String(document.title || '').split(' - ')[0].trim();
      const title = titleFromDocument || (() => {
        const refIndex = lines.findIndex((line) => /^REF\./i.test(line));
        const searchWindow = refIndex > 0 ? lines.slice(Math.max(0, refIndex - 4), refIndex) : lines.slice(0, 24);
        return searchWindow.find((line) =>
          line
          && !/MEN|WOMEN|BY INFLUENCERS|SEARCH HERE|LOG IN|BASKET|REF\.|SIZES|ADD TO BASKET|FREE /i.test(line)
          && !(/\d/.test(line) && /€|\$|£/.test(line))
        ) || '';
      })();

      const domImages = [...document.querySelectorAll('img')]
        .map((img) => img.currentSrc || img.src)
        .filter(Boolean);

      return {
        title,
        price,
        colorRef,
        styleNumber: refMatch ? refMatch[1] : '',
        pageText: bodyText.slice(0, 24000),
        domImages,
        metaDescription,
        ldDescription,
        nuxtDescription: String(nuxtCurrentProduct.longDescription || nuxtCurrentProduct.description || '').trim(),
        nuxtComposition: Array.isArray(selectedColor?.composition) ? selectedColor.composition : [],
        nuxtOrigin: String(selectedColor?.origin || '').trim(),
        nuxtCares: Array.isArray(nuxtCurrentProduct.cares) ? nuxtCurrentProduct.cares : [],
      };
    });

    const materialsFromPage = extractSectionFromText(
      info.pageText,
      ['MATERIALS, CARE AND SOURCE'],
      ['IN-STORE AVAILABILITY', 'DELIVERIES AND RETURNS', 'YOU MAY ALSO LIKE', "IT'S A MATCH"],
    );
    const descriptionFromPage = extractSectionFromText(
      info.pageText,
      ['PRODUCT DETAILS', 'DETAILS'],
      ['MATERIALS, CARE AND SOURCE', 'IN-STORE AVAILABILITY', 'DELIVERIES AND RETURNS'],
    );
    const structuredComposition = formatBershkaCompositionDetails(
      info.nuxtComposition,
      info.nuxtOrigin,
      info.nuxtCares,
    );
    const description = normalizeBershkaDescription(
      info.title,
      descriptionFromPage,
      info.nuxtDescription,
      info.metaDescription,
      parseLdJsonDescription(info.ldDescription),
    );
    const styleNumber = info.styleNumber || normalized.styleNumber || normalized.input;

    const imageUrls = [...new Set([
      ...capturedUrls,
      ...(info.domImages || []).map((item) => cleanImageUrl(item)).filter((item) => isRelevantBershkaProductImage(item, styleNumber)),
    ])]
      .filter((item) => isRelevantBershkaProductImage(item, styleNumber))
      .sort((left, right) => getBershkaImageOrder(left) - getBershkaImageOrder(right));

    const productName = info.title || `Bershka ${styleNumber}`;
    emitInditexScrapeResult({
      emitLog,
      brand: 'Bershka',
      requestedReference: reference,
      actualStyleNumber: info.styleNumber || styleNumber,
      productName,
      imageCount: imageUrls.length,
      hasDescription: Boolean(description),
      hasComposition: Boolean(
        structuredComposition?.outerShell
        || structuredComposition?.lining
        || structuredComposition?.other
        || materialsFromPage,
      ),
    });

    return {
      styleNumber,
      productId: styleNumber,
      brand: 'Bershka',
      name: productName,
      price: info.price || '',
      colorRef: info.colorRef || '',
      composition: {
        outerShell: structuredComposition.outerShell,
        lining: structuredComposition.lining,
        other: structuredComposition.other || materialsFromPage || null,
      },
      url: normalized.url,
      imageUrls,
      pageText: info.pageText || '',
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function runBershkaScraper(config, emitLog, emitProgress, taskController, previewBridge = null) {
  let { styleNumbers, excelPath, outputDir, tabConcurrency, downloadConcurrency } = config;
  styleNumbers = normalizeManualStyleNumbers(styleNumbers);
  const ensureActive = () => taskController?.throwIfCancelled?.();
  let browser = null;

  if (excelPath) {
    try {
      ensureActive();
      emitLog(`Reading Excel file: ${excelPath}`, 'info');
      const wb = XLSX.readFile(excelPath);
      const ws = wb.Sheets[wb.SheetNames[0]];
      styleNumbers = [];
      const range = XLSX.utils.decode_range(ws['!ref'] || 'A1:B1');
      for (let row = 1; row <= range.e.r; row += 1) {
        const cellAddress = XLSX.utils.encode_cell({ r: row, c: 1 });
        const cell = ws[cellAddress];
        if (cell) {
          const displayValue = String(cell.w ?? cell.v ?? '').trim();
          if (displayValue) {
            styleNumbers.push(displayValue);
            emitLog(`📥 Excel row ${row + 1} column B: "${displayValue}"`, 'info');
          }
        }
      }
      emitLog(`Loaded ${styleNumbers.length} Bershka style numbers from Excel.`, 'success');
    } catch (error) {
      throw new Error(`Excel parse failed: ${error.message}`);
    }
  }

  ensureActive();
  if (!styleNumbers || styleNumbers.length === 0) {
    throw new Error('No Bershka style numbers were found. Put the SKU values in column B or enter them manually.');
  }

  const targetDir = !outputDir || outputDir === '未选择' ? path.join(app.getPath('desktop'), 'Bershka') : outputDir;
  fs.mkdirSync(targetDir, { recursive: true });

  emitLog(`📁 Output directory: ${targetDir}`, 'info');
  emitLog('🌐 Launching the English Bershka scraper session...', 'info');
  emitLog('💡 Bershka scraping uses the English men and women storefronts and searches by the provided SKU/style number.', 'info');

  let executablePath = findChromePath();
  if (!executablePath) {
    emitLog('⬇️ No local Chrome was found. Downloading a managed Chrome runtime for GS Bot...', 'warning');
    const chromeInstall = await ensureChromeRuntimeAvailable((payload) => {
      if (payload?.status) {
        emitLog(payload.status, payload.phase === 'complete' ? 'success' : 'info');
      }
    });
    if (!chromeInstall?.success) {
      throw new Error(chromeInstall?.error || 'Chrome download failed.');
    }
    executablePath = chromeInstall.executablePath;
  }

  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: false,
      userDataDir: getBershkaSessionDir(),
      args: antiDetection.getRetailLaunchArgs(),
      ignoreDefaultArgs: ['--enable-automation'],
      defaultViewport: null,
    });
    previewBridge?.attachToBrowser(browser);

    taskController?.onCancel(() => {
      if (browser && browser.isConnected()) {
        browser.close().catch(() => {});
      }
    });

    const products = [];
    let currentProgress = 5;
    emitProgress(currentProgress);
    const totalItems = styleNumbers.length;
    const effectiveTabConcurrency = 1;

    // Helper: run a single reference through scrapeBershkaProduct (one attempt)
    const processReference = async (reference) => {
      try {
        ensureActive();
        return await scrapeBershkaProduct(browser, reference, emitLog, ensureActive);
      } catch (error) {
        if (isCancellationError(error) || taskController?.cancelled) {
          throw new TaskCancelledError();
        }
        return {
          styleNumber: reference,
          productId: reference,
          url: '',
          error: error.message || 'Unknown error',
          imageUrls: [],
        };
      }
    };

    // ── First pass: try each item once, don't let one stuck item block others
    emitLog(`🚀 Bershka 单轮处理: ${totalItems} 个款号 (仅 /es/en/ 站点)`, 'warning');
    const firstPassResults = new Array(totalItems);
    for (let i = 0; i < totalItems; i += effectiveTabConcurrency) {
      ensureActive();
      const batch = styleNumbers.slice(i, i + effectiveTabConcurrency);
      emitLog(`🔄 Processing Bershka batch ${Math.floor(i / effectiveTabConcurrency) + 1}`, 'warning');

      const batchResults = await Promise.all(batch.map(async (reference, idxInBatch) => {
        const normalizedReference = normalizeBershkaReference(reference);
        emitLog(`🎯 Bershka input raw: "${reference}"${normalizedReference?.styleCode ? ` -> Search ${normalizedReference.styleCode}` : ''}`, 'info');
        const result = await processReference(reference);
        return { index: i + idxInBatch, result };
      }));

      for (const { index, result } of batchResults) {
        firstPassResults[index] = result;
      }
      currentProgress = 5 + Math.round(((i + batch.length) / totalItems) * 45);
      emitProgress(currentProgress);
      if (i + effectiveTabConcurrency < totalItems) {
        await antiDetection.randomDelay(1500, 2500);
      }
    }

    // Collect failures (for logging only — single-pass, no retry)
    const failedIndexes = [];
    for (let idx = 0; idx < firstPassResults.length; idx += 1) {
      const r = firstPassResults[idx];
      if (!r || !r.url || !r.imageUrls || r.imageUrls.length === 0) {
        failedIndexes.push(idx);
      }
    }

    const firstPassSuccess = totalItems - failedIndexes.length;
    emitLog(`📊 Bershka 处理完成: ${firstPassSuccess}/${totalItems} 成功, ${failedIndexes.length} 失败`, 'info');

    if (failedIndexes.length > 0) {
      for (const idx of failedIndexes) {
        const reference = styleNumbers[idx];
        const manualUrl = buildBershkaManualSearchUrl(reference);
        emitLog(`    ❌ ${reference} - 未能抓取`, 'error');
        emitLog(`    👉 建议人工下载: ${manualUrl}`, 'warning');
      }
    }

    products.push(...firstPassResults);
    currentProgress = 50;
    emitProgress(currentProgress);

    ensureActive();
    emitLog('🌐 Bershka page extraction complete. Preparing image downloads...', 'warning');

    const successProducts = products.filter((product) => product.imageUrls && product.imageUrls.length > 0);
    const failedProducts = products.filter((product) => !product.imageUrls || product.imageUrls.length === 0);
    const totalImages = successProducts.reduce((sum, product) => sum + product.imageUrls.length, 0);

    emitLog(`📊 Bershka summary: ${successProducts.length} styles succeeded, ${failedProducts.length} styles failed, ${totalImages} images collected.`, 'info');

    if (failedProducts.length > 0) {
      failedProducts.forEach((product) => {
        emitLog(`    ❌ ${product.styleNumber} - ${product.error || 'No product images found'}`, 'error');
        emitLog(`       👉 建议人工下载: ${buildBershkaManualSearchUrl(product.styleNumber)}`, 'warning');
      });
    }

    const allTasks = [];
    for (const product of successProducts) {
      ensureActive();
      const cleanStyleNumber = sanitizeFileSegment(String(product.productId || product.styleNumber || '').replace(/\//g, '-'), 'bershka-item');
      const styleDir = path.join(targetDir, cleanStyleNumber);
      fs.mkdirSync(styleDir, { recursive: true });

      const classified = buildBershkaImageMap(product.imageUrls);

      for (const [label, imgUrl] of Object.entries(classified)) {
        const ext = getUrlExtension(imgUrl, '.jpg');
        const filename = `${cleanStyleNumber}_${label}${ext}`;
        const filePath = path.join(styleDir, filename);
        allTasks.push(() => {
          ensureActive();
          return downloadFile(imgUrl, filePath, {
            headers: {
              Referer: product.url || 'https://www.bershka.com/',
              'User-Agent': 'Mozilla/5.0',
            },
            timeoutMs: 45000,
          })
            .then((size) => {
              if (size) {
                emitLog(`    ⬇️ [saved] ${filename} (${size.toFixed(1)} KB)`);
              }
            })
            .catch((error) => {
              emitLog(`    ❌ [failed] ${filename}: ${error.message}`, 'error');
            });
        });
      }

      const infoData = {
        styleNumber: product.productId || product.styleNumber,
        brand: product.brand || 'Bershka',
        name: product.name,
        price: product.price,
        colorRef: product.colorRef,
        composition: product.composition || null,
        url: product.url,
        images: classified,
      };

      const infoPath = path.join(styleDir, `${cleanStyleNumber}_info.json`);
      fs.writeFileSync(infoPath, JSON.stringify(infoData, null, 2), 'utf-8');
      emitLog(`📄 Saved product metadata: ${cleanStyleNumber}_info.json`, 'success');
    }

    emitLog(`📦 Downloading ${allTasks.length} Bershka images with ${downloadConcurrency} worker(s)...`, 'info');

    let completedTasks = 0;
    const tasksWithProgress = allTasks.map((task) => async () => {
      ensureActive();
      await task();
      completedTasks += 1;
      emitProgress(50 + Math.round((completedTasks / Math.max(allTasks.length, 1)) * 50));
    });

    if (tasksWithProgress.length > 0) {
      await parallelLimit(tasksWithProgress, downloadConcurrency);
    }

    emitProgress(100);
    const summary = products.map((product) => ({
      styleNumber: product.productId || product.styleNumber,
      brand: product.brand || 'Bershka',
      name: product.name,
      price: product.price,
      colorRef: product.colorRef,
      composition: product.composition || null,
      images: product.imageUrls ? product.imageUrls.length : 0,
      error: product.error || null,
    }));
    const summaryPath = path.join(targetDir, 'summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf-8');
    emitLog('📊 Saved summary.json', 'success');

    if (failedProducts.length > 0) {
      const failedSummary = failedProducts.map((product) => ({
        styleNumber: product.productId || product.styleNumber,
        error: product.error || 'No product images found',
      }));
      const failedJsonPath = path.join(targetDir, 'failed_styles.json');
      const failedTxtPath = path.join(targetDir, 'failed_styles.txt');
      fs.writeFileSync(failedJsonPath, JSON.stringify(failedSummary, null, 2), 'utf-8');
      fs.writeFileSync(
        failedTxtPath,
        failedSummary.map((item) => `${item.styleNumber}\t${item.error}`).join('\n'),
        'utf-8',
      );
      emitLog('📄 Saved failed_styles.json', 'success');
      emitLog('📄 Saved failed_styles.txt', 'success');
    }

    if (excelPath) {
      try {
        const workbook = XLSX.readFile(excelPath);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
        const resultMap = new Map();

        products.forEach((product) => {
          const key = String(product.productId || product.styleNumber || '').trim();
          if (!key) {
            return;
          }
          resultMap.set(key, product);
          resultMap.set(key.replace(/\s+/g, ''), product);
        });

        if (!rows[0]) {
          rows[0] = [];
        }
        rows[0][2] = 'Status';
        rows[0][3] = 'Image Count';
        rows[0][4] = 'Error';

        for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
          const row = rows[rowIndex] || [];
          const rawValue = String(row[1] || '').trim();
          if (!rawValue) {
            continue;
          }

          const matched = resultMap.get(rawValue) || resultMap.get(rawValue.replace(/\s+/g, ''));
          if (!matched) {
            row[2] = 'Not processed';
            row[3] = 0;
            row[4] = '';
            rows[rowIndex] = row;
            continue;
          }

          const imageCount = matched.imageUrls ? matched.imageUrls.length : 0;
          row[2] = imageCount > 0 ? 'Success' : 'Failed';
          row[3] = imageCount;
          row[4] = matched.error || '';
          rows[rowIndex] = row;
        }

        const annotatedSheet = XLSX.utils.aoa_to_sheet(rows);
        workbook.Sheets[sheetName] = annotatedSheet;
        const parsedExcelPath = path.parse(excelPath);
        const annotatedPath = path.join(parsedExcelPath.dir, `${parsedExcelPath.name}_bershka_results${parsedExcelPath.ext}`);
        XLSX.writeFile(workbook, annotatedPath);
        emitLog(`📄 Saved annotated Excel: ${path.basename(annotatedPath)}`, 'success');
      } catch (error) {
        emitLog(`⚠️ Could not save annotated Bershka Excel: ${error.message}`, 'warning');
      }
    }

    emitLog(`🎉 Bershka scraping finished. Files saved to: ${targetDir}`, 'success');
  } finally {
    if (browser && browser.isConnected()) {
      await browser.close().catch(() => {});
    }
  }
}

// ── Lefties (Inditex) scraper ────────────────────────────────────────────────
// Lefties is an Inditex sister brand of Bershka/Stradivarius/Pull&Bear.
// It uses the same /q/{SKU} path-style search and similar CDN conventions.

const LEFTIES_DIRECT_QUERY_URLS = (q) => [
  `https://www.lefties.com/es/en/q/${encodeURIComponent(q)}`,
  `https://www.lefties.com/ic/en/q/${encodeURIComponent(q)}`,
];
const LEFTIES_HOME_URL = 'https://www.lefties.com/es/en/';
const buildLeftiesManualSearchUrl = (q) =>
  `https://www.lefties.com/es/en/q/${encodeURIComponent(String(q || '').trim())}`;

function normalizeLeftiesReference(reference = '') {
  const value = String(reference || '').trim();
  if (!value) return {};
  const firstPart = value.split('/')[0] || value;
  const styleCode = firstPart.replace(/\D/g, '');
  const compactDigits = (value.match(/\d+/g) || []).join('');
  const searchTerms = [value, compactDigits, styleCode]
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  return { searchTerms: [...new Set(searchTerms)], raw: value, styleCode, compactDigits };
}

function isLikelyLeftiesProductImage(url = '') {
  const value = cleanImageUrl(url).toLowerCase();
  if (!value) return false;
  if (!/\.(jpg|jpeg|png|webp)$/i.test(value)) return false;
  if (
    value.includes('logo')
    || value.includes('sprite')
    || value.includes('icon')
    || value.includes('placeholder')
    || value.includes('favicon')
    || value.includes('/cares/')
    || value.includes('color_')
  ) {
    return false;
  }
  // Inditex serves product photos from a /photos/ path on a variety of CDN hosts
  // (static.lefties.net, static.e-lefties.net, static.zara.net, etc.). The new
  // Lefties CDN uses /assets/public/ on static.lefties.com instead. Match on
  // either path so we don't break when the CDN moves.
  if (value.includes('/photos/')) return true;
  if (value.includes('/assets/public/')) return true;
  return (
    value.includes('static.lefties.com')
    || value.includes('static.lefties.net')
    || value.includes('static.e-lefties.net')
    || value.includes('lefties.net/')
    || value.includes('lefties.com/')
    || value.includes('lftcdn.net')
  );
}

function getLeftiesImageTokens(styleNumber = '') {
  const tokens = new Set();
  const compactDigits = (String(styleNumber || '').match(/\d+/g) || []).join('');
  if (!compactDigits) return [];
  tokens.add(compactDigits);
  tokens.add(compactDigits.padStart(compactDigits.length + 1, '0'));
  return [...tokens];
}

function isRelevantLeftiesProductImage(url = '', styleNumber = '') {
  if (!isLikelyLeftiesProductImage(url)) return false;
  const filename = path.basename(cleanImageUrl(url)).toLowerCase();
  // Accept the classic Inditex flat-image suffixes (-p / -b / -aN[x] / -m / -cN)
  // OR any -<token>.<ext> filename, which the newer Lefties CDN uses (e.g.
  // -1.jpg, -2.jpg, -mainfull.jpg). Token must be 1-12 chars of [a-z0-9].
  if (!/-([a-z0-9]{1,12})\.(jpg|jpeg|png|webp)$/i.test(filename)) {
    return false;
  }
  const tokens = getLeftiesImageTokens(styleNumber).map((item) => item.toLowerCase());
  if (tokens.length === 0) return true;
  if (tokens.some((token) => filename.includes(token))) return true;

  const styleDigits = (String(styleNumber || '').match(/\d+/g) || []).join('');
  const fileDigits = (filename.match(/\d+/g) || []).join('');
  if (!styleDigits || !fileDigits) return false;
  const prefix = styleDigits.slice(0, 4);
  const suffix = styleDigits.slice(-3);
  return Boolean(prefix && suffix && fileDigits.includes(prefix) && fileDigits.endsWith(suffix));
}

// Extract only the fabric composition lines that include a percentage from
// the panel text behind the "Composition and care" accordion. Returns a clean,
// comma-joined string like "65% Cotton, 35% Polyester" or "" when nothing matches.
function extractLeftiesFabricComposition(rawText = '') {
  const text = String(rawText || '').replace(/ /g, ' ').trim();
  if (!text) return '';
  const lines = text.split(/[\n\r]+/)
    .map((line) => line.trim())
    .filter(Boolean);
  // Drop the heading itself plus anything that looks like a care instruction or label.
  const headingRegex = /^\s*(composition\s+and\s+care|composition,?\s*care(\s+and\s+source)?|materials,?\s+care\s+and\s+source|composition|care|origin|made\s+in|source)\s*:?\s*$/i;
  const fabricLines = [];
  const seen = new Set();
  for (const line of lines) {
    if (headingRegex.test(line)) continue;
    if (!/\d+(?:[.,]\d+)?\s*%/.test(line)) continue;
    // Strip leading bullet/label like "Outer shell:" if present; keep the rest.
    const cleaned = line.replace(/^[-•·*\s]+/, '').trim();
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    fabricLines.push(cleaned);
  }
  return fabricLines.join(' | ');
}

function parseLeftiesImageMeta(url = '', fallbackIndex = 0) {
  const filename = path.basename(cleanImageUrl(url)).toLowerCase();
  const altMatch = filename.match(/-a(\d+)/i);
  if (/-b\.(jpg|jpeg|png|webp)$/i.test(filename)) {
    return { kind: 'back-flat', order: 999, altIndex: null };
  }
  if (altMatch) {
    return {
      kind: 'alt',
      order: Number.parseInt(altMatch[1], 10),
      altIndex: Number.parseInt(altMatch[1], 10),
    };
  }
  if (/-p\.(jpg|jpeg|png|webp)$/i.test(filename)) {
    return { kind: 'hero', order: -10, altIndex: null };
  }
  return { kind: 'misc', order: fallbackIndex + 100, altIndex: null };
}

function getLeftiesImageOrder(url = '', fallbackIndex = 0) {
  return parseLeftiesImageMeta(url, fallbackIndex).order;
}

function buildLeftiesImageMap(imageUrls = []) {
  const entries = imageUrls.map((url, index) => ({
    url,
    index,
    meta: parseLeftiesImageMeta(url, index),
  }));

  const heroEntries = entries.filter((entry) => entry.meta.kind === 'hero');
  const altEntries = entries
    .filter((entry) => entry.meta.kind === 'alt')
    .sort((left, right) => left.meta.order - right.meta.order);
  const backEntry = entries.find((entry) => entry.meta.kind === 'back-flat') || null;
  const miscEntries = entries
    .filter((entry) => entry.meta.kind === 'misc')
    .sort((left, right) => left.index - right.index);

  // Inditex products conventionally use A6 (-a6) as the flat front-of-garment
  // shot. Pick that specific image as F when available; otherwise fall back to
  // the highest-numbered alt so we still produce an F label.
  const a6Entry = altEntries.find((entry) => entry.meta.altIndex === 6) || null;
  const frontFlatEntry = a6Entry
    || (altEntries.length > 0 ? altEntries[altEntries.length - 1] : null)
    || (heroEntries[0] || null);

  const classified = {};
  const usedUrls = new Set();
  const register = (label, entry) => {
    if (!entry || usedUrls.has(entry.url) || classified[label]) return;
    classified[label] = entry.url;
    usedUrls.add(entry.url);
  };

  register('F', frontFlatEntry);
  const numberedEntries = [
    ...heroEntries.filter((entry) => !frontFlatEntry || entry.url !== frontFlatEntry.url),
    ...altEntries.filter((entry) => !frontFlatEntry || entry.url !== frontFlatEntry.url),
    ...miscEntries,
  ];
  let nextNumber = 1;
  numberedEntries.forEach((entry) => {
    while (classified[String(nextNumber).padStart(2, '0')]) {
      nextNumber += 1;
    }
    register(String(nextNumber).padStart(2, '0'), entry);
    nextNumber += 1;
  });
  register('B', backEntry);
  return classified;
}

async function extractLeftiesSearchProductUrl(page, query, expectedDigits = '', isSearchPage = false) {
  return page.evaluate((q, expected, isSearch) => {
    const normalizeDigits = (value) => String(value || '').replace(/\D/g, '');
    const queryDigits = normalizeDigits(q);
    const expectedDigits = normalizeDigits(expected);
    // Recommendation links (#fromrecommendation, #fromrecomm, ?from=recom...) are shown
    // when search has no real match — they must be excluded.
    const isRecommendationHref = (href) => /from[-_]?recomm|from=recom|from-related|cross-sell/i.test(href);
    const links = [...document.querySelectorAll('a[href*="lefties.com"], a[href^="/"]')];
    const candidates = links
      .map((link) => ({ href: link.href, text: String(link.textContent || '').trim() }))
      .filter((entry) => {
        const href = String(entry.href || '');
        return href
          && !href.includes('/search?')
          && !href.includes('/q?')
          && !href.endsWith('/search.html')
          && !isRecommendationHref(href)
          && /lefties\.com\//i.test(href)
          && /-c\d+p\d+\.html|-p\d+\.html|-c0p\d+\.html/i.test(href);
      });

    const exact = candidates.find((entry) => {
      const combined = `${entry.href} ${entry.text}`;
      const digits = normalizeDigits(combined);
      return expectedDigits && digits.includes(expectedDigits);
    });
    if (exact?.href) return exact.href;

    const queryMatch = candidates.find((entry) => {
      const combined = `${entry.href} ${entry.text}`;
      return q && (combined.includes(q) || normalizeDigits(combined).includes(queryDigits));
    });
    if (queryMatch?.href) return queryMatch.href;

    // Do NOT fall back to candidates[0] — Lefties shows unrelated "recommendations"
    // when search has no real match, and returning them downloads the wrong product.
    return '';
  }, query, expectedDigits, isSearchPage);
}

async function dismissCommonLeftiesPopups(page) {
  try {
    const selectors = [
      '[data-cy="cookie-consent"] button[class*="accept"]',
      'button[class*="cookie"]',
      '[aria-label*="accept cookies" i]',
      '[id*="onetrust-accept" i]',
      '#onetrust-accept-btn-handler',
    ];
    for (const sel of selectors) {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click().catch(() => {});
        await page.waitForTimeout(500).catch(() => {});
      }
    }
  } catch { /* ignore */ }
}

async function isLeftiesBlockedPage(page) {
  try {
    const text = await page.evaluate(() => document.body?.innerText || '');
    return /access denied|blocked|suspicious activity|verify you are human/i.test(text);
  } catch {
    return false;
  }
}

async function openLeftiesSearchOverlay(page) {
  const directSelectors = [
    '[data-testid="searchButton"]',
    '[data-testid="search-button"]',
    '[data-testid="header-search"]',
    '[data-qa-id="searchBtn"]',
    '[data-qa-action="open-search"]',
    'button[aria-label="Search"]',
    'button[aria-label="Buscar"]',
    'button[aria-label*="search" i]',
    'header button[aria-label*="search" i]',
    'header button[aria-label*="buscar" i]',
    'nav button[aria-label*="search" i]',
    'a[href*="/search"]',
  ];
  for (const sel of directSelectors) {
    try {
      const handle = await page.$(sel);
      if (handle) {
        const visible = await handle.isIntersectingViewport().catch(() => true);
        if (visible) {
          await handle.click({ delay: 50 }).catch(() => {});
          return true;
        }
      }
    } catch { /* ignore */ }
  }

  return page.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const s = window.getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
    };
    const candidates = [...document.querySelectorAll('button, a[href], [role="button"], [tabindex]')];
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const containerOk = el.closest('header, nav, [role="banner"], [class*="header" i], [class*="Header"]');
      if (!containerOk) continue;
      const haystack = [
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
        el.getAttribute('data-testid'),
        el.getAttribute('data-qa-id'),
        el.getAttribute('data-qa-action'),
        el.className,
        el.id,
      ].join(' ').toLowerCase();
      if (/\b(search|buscar|cerca|recherche|suche)\b/.test(haystack)) {
        el.click();
        return true;
      }
    }
    return false;
  });
}

async function findVisibleLeftiesSearchInput(page) {
  return page.evaluateHandle(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 6) return false;
      const s = window.getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
    };
    const inputs = [...document.querySelectorAll(
      'input[type="search"], input[type="text"], input:not([type]), textarea, [contenteditable="true"]'
    )].filter(isVisible);

    const ranked = inputs.find((el) => {
      const haystack = [
        el.getAttribute('type'),
        el.getAttribute('name'),
        el.getAttribute('placeholder'),
        el.getAttribute('aria-label'),
        el.getAttribute('id'),
        el.getAttribute('data-testid'),
        el.getAttribute('data-qa-id'),
        el.className,
        el.closest('form')?.getAttribute('action'),
        el.closest('[role="search"]')?.className,
      ].join(' ').toLowerCase();
      return /search|buscar|query|keyword|term|cerca|recherche|suche/i.test(haystack);
    });

    return ranked || inputs[0] || null;
  });
}

async function clickFirstLeftiesProductCard(page, emitLog) {
  const before = page.url();
  const clickedHref = await page.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 20) return false;
      const s = window.getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
    };
    // Recommendation links (#fromrecommendation, ?from=recom...) show when no real match exists.
    const isRecommendationHref = (href) => /from[-_]?recomm|from=recom|from-related|cross-sell/i.test(href);
    const productLinkRegex = /lefties\.com\/.*-(?:c\d+p\d+|c0p\d+|p\d+)\.html/i;
    const links = [...document.querySelectorAll('a[href]')];

    // Prefer a visible product link that wraps an <img> (real product card on the grid)
    for (const a of links) {
      if (!isVisible(a)) continue;
      const href = a.href || '';
      if (!productLinkRegex.test(href)) continue;
      if (isRecommendationHref(href)) continue;
      if (!a.querySelector('img')) continue;
      a.scrollIntoView({ behavior: 'instant', block: 'center' });
      a.click();
      return href;
    }
    // Fallback: any visible product link (still excluding recommendation links)
    for (const a of links) {
      if (!isVisible(a)) continue;
      const href = a.href || '';
      if (!productLinkRegex.test(href)) continue;
      if (isRecommendationHref(href)) continue;
      a.scrollIntoView({ behavior: 'instant', block: 'center' });
      a.click();
      return href;
    }
    return '';
  });

  if (!clickedHref) return '';

  emitLog(`    🖱️ Clicked Lefties search result card → ${clickedHref}`, 'info');
  await Promise.race([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 18000 }).catch(() => null),
    page.waitForFunction(
      (prevUrl) => location.href !== prevUrl && /lefties\.com\/.*-(?:c\d+p\d+|c0p\d+|p\d+)\.html/i.test(location.href),
      { timeout: 18000, polling: 400 },
      before,
    ).catch(() => null),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const after = page.url();
  if (/lefties\.com\/.*-(?:c\d+p\d+|c0p\d+|p\d+)\.html/i.test(after)
      && !/from[-_]?recomm|from=recom|from-related|cross-sell/i.test(after)) {
    return after;
  }
  // Fall back to the clicked href if navigation didn't update page.url()
  if (/lefties\.com\/.*-(?:c\d+p\d+|c0p\d+|p\d+)\.html/i.test(clickedHref)
      && !/from[-_]?recomm|from=recom|from-related|cross-sell/i.test(clickedHref)) {
    return clickedHref;
  }
  return '';
}

async function searchLeftiesByTyping(page, query, expectedDigits, emitLog, ensureActive) {
  emitLog(`    🔍 Lefties typed search "${query}" (homepage search box)…`, 'info');

  await page.goto(LEFTIES_HOME_URL, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await dismissCommonLeftiesPopups(page);
  await page.waitForFunction(
    () => document.readyState === 'complete',
    { timeout: 15000 },
  ).catch(() => {});
  await antiDetection.randomDelay(1500, 2500);
  ensureActive();

  emitLog('    🔎 Opening Lefties search overlay…', 'info');
  const opened = await openLeftiesSearchOverlay(page);
  if (!opened) {
    emitLog('    ⚠️ Could not find/click search button on Lefties header.', 'warning');
    return '';
  }
  await antiDetection.randomDelay(1500, 2200);
  ensureActive();

  let inputHandle = null;
  try {
    await page.waitForFunction(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 20 || r.height < 6) return false;
        const s = window.getComputedStyle(el);
        return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
      };
      const inputs = [...document.querySelectorAll(
        'input[type="search"], input[type="text"], input:not([type]), textarea, [contenteditable="true"]'
      )];
      return inputs.some(isVisible);
    }, { timeout: 14000, polling: 250 });
    inputHandle = await findVisibleLeftiesSearchInput(page);
  } catch {
    inputHandle = null;
  }

  let inputElement = inputHandle ? inputHandle.asElement() : null;
  if (!inputElement) {
    emitLog('    🔁 Lefties search input not visible yet; reopening overlay…', 'info');
    await openLeftiesSearchOverlay(page).catch(() => false);
    await antiDetection.randomDelay(1500, 2500);
    try {
      await page.waitForFunction(() => {
        const inputs = [...document.querySelectorAll('input[type="search"], input[type="text"], input:not([type]), textarea')];
        return inputs.some((el) => {
          const r = el.getBoundingClientRect();
          const s = window.getComputedStyle(el);
          return r.width >= 20 && r.height >= 6 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
        });
      }, { timeout: 10000, polling: 250 });
      inputHandle = await findVisibleLeftiesSearchInput(page);
      inputElement = inputHandle ? inputHandle.asElement() : null;
    } catch {
      inputElement = null;
    }
  }

  if (!inputElement) {
    emitLog('    ⚠️ Lefties search input did not appear after opening overlay.', 'warning');
    return '';
  }

  try {
    await inputElement.click({ delay: 80 });
  } catch {
    await page.evaluate((el) => el.focus(), inputElement).catch(() => {});
  }
  await antiDetection.randomDelay(300, 600);

  emitLog(`    ⌨️ Typing Lefties search "${query}" via DOM write…`, 'info');
  await writeSearchValueViaDOM(page, inputElement, query, emitLog, 'Lefties');
  ensureActive();

  emitLog('    ⏳ Waiting for Lefties search results…', 'info');
  await Promise.race([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null),
    page.waitForFunction(
      () => [...document.querySelectorAll('a[href]')].some(
        (a) => /-c\d+p\d+\.html|-p\d+\.html/i.test(a.href),
      ),
      { timeout: 20000, polling: 400 },
    ).catch(() => null),
  ]);
  await antiDetection.randomDelay(1500, 2400);
  ensureActive();

  let url = '';
  // Priority 1: page auto-navigated directly to a product
  const currentUrl = page.url();
  if (/lefties\.com\/.*-(?:c\d+p\d+|c0p\d+|p\d+)\.html/i.test(currentUrl)
      && !/from[-_]?recomm|from=recom|from-related|cross-sell/i.test(currentUrl)) {
    url = currentUrl;
  }
  // Priority 2: physically click the first product card (lets Lefties navigate to the real product URL)
  if (!url) {
    url = await clickFirstLeftiesProductCard(page, emitLog).catch(() => '');
  }
  // Priority 3: scrape an href from the DOM as a last resort
  if (!url) {
    url = await extractLeftiesSearchProductUrl(page, query, expectedDigits, true);
  }
  if (!url) {
    emitLog('    🔁 Lefties: no results yet — pressing Enter again…', 'info');
    await page.keyboard.press('Enter').catch(() => {});
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null),
      page.waitForFunction(
        () => [...document.querySelectorAll('a[href]')].some(
          (a) => /-c\d+p\d+\.html|-p\d+\.html/i.test(a.href),
        ),
        { timeout: 15000, polling: 400 },
      ).catch(() => null),
    ]);
    await antiDetection.randomDelay(1200, 2000);
    ensureActive();
    const retryUrl = page.url();
    if (/lefties\.com\/.*-(?:c\d+p\d+|c0p\d+|p\d+)\.html/i.test(retryUrl)
        && !/from[-_]?recomm|from=recom|from-related|cross-sell/i.test(retryUrl)) {
      url = retryUrl;
    }
    if (!url) {
      url = await clickFirstLeftiesProductCard(page, emitLog).catch(() => '');
    }
    if (!url) {
      url = await extractLeftiesSearchProductUrl(page, query, expectedDigits, true);
    }
  }

  if (url) {
    emitLog(`    ✅ Lefties typed search found: ${url.substring(url.lastIndexOf('/') + 1)}`, 'success');
  } else {
    emitLog('    ⚠️ Lefties typed search returned no products', 'warning');
  }
  return url;
}

async function resolveLeftiesProductUrl(browser, reference, emitLog, ensureActive) {
  const norm = normalizeLeftiesReference(reference);
  const queries = norm.searchTerms?.length ? norm.searchTerms : [norm.raw || reference];

  const page = await browser.newPage();
  await antiDetection.applyRetailBrowsingProfile(page);
  await page.setViewport(antiDetection.getRandomViewport());

  try {
    // Typed search only: type the style number into the homepage search box,
    // then click the first product card to navigate into the real product page.
    for (const query of queries) {
      ensureActive();
      const typedUrl = await searchLeftiesByTyping(
        page,
        query,
        norm.compactDigits || norm.styleCode || '',
        emitLog,
        ensureActive,
      ).catch((error) => {
        ensureActive();
        emitLog(`    ⚠️ Lefties typed search failed: ${error.message}`, 'warning');
        return '';
      });
      if (typedUrl) {
        return { url: typedUrl, input: reference };
      }
    }

    return { url: '', input: reference };
  } finally {
    await page.close().catch(() => {});
  }
}

async function scrapeLeftiesProduct(browser, reference, emitLog, ensureActive) {
  const normalized = await resolveLeftiesProductUrl(browser, reference, emitLog, ensureActive);

  // ── Firecrawl mode check ───────────────────────────────────────
  const currentMode = firecrawlService.getMode();
  if (currentMode === 'manual') {
    emitLog(` Lefties ${reference || ''} 手动模式: 使用 Firecrawl 抓取`, 'warning');
    try {
      ensureActive();
      const fcResult = await firecrawlFallback.tryFirecrawlFallback(normalized.url, {
        imageFilter: (imgUrl) => isLikelyLeftiesProductImage(imgUrl),
        urlNormalizer: (u) => u.split('?')[0],
        candidateIds: [String(reference || '').replace(/\D/g, '')],
        emitLog: (msg, type) => emitLog(`    ${msg}`, type),
      });

      // ─ Parse product text from Firecrawl HTML ────────────────────
      const html = fcResult.html || '';
      let name = '';
      let price = '';
      let description = '';
      let compositionText = null;

      const h1Match = html.match(/<h1[^>]*>(.*?)<\/h1>/is);
      if (h1Match) {
        name = h1Match[1].replace(/<[^>]+>/g, '').trim();
      }

      const priceMatch = html.match(/[€$£¥]([\d.,]+)/);
      if (priceMatch) {
        price = priceMatch[0];
      }

      const descPatterns = [
        /["']description["']?:\s*["']([^"']+)["']/i,
        /<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i,
      ];
      for (const pattern of descPatterns) {
        const m = html.match(pattern);
        if (m) {
          description = m[1].trim();
          break;
        }
      }

      const compPatterns = [
        /["']composition["']?:\s*["']([^"']+)["']/i,
        /["']materials["']?:\s*["']([^"']+)["']/i,
      ];
      for (const pattern of compPatterns) {
        const m = html.match(pattern);
        if (m) {
          compositionText = m[1].trim();
          break;
        }
      }

      const styleNumber = String(reference || '').replace(/\D/g, '');
      return {
        styleNumber,
        productId: styleNumber,
        brand: 'Lefties',
        name: name || `Lefties ${styleNumber}`,
        price,
        colorRef: '',
        description,
        composition: compositionText ? { outerShell: null, lining: null, other: compositionText } : null,
        url: normalized.url,
        imageUrls: fcResult.imageUrls,
        pageText: '',
        usedEngine: 'firecrawl',
      };
    } catch (fcError) {
      emitLog(`❌ Lefties ${reference || ''} Firecrawl 抓取失败: ${fcError.message}`, 'error');
      throw new Error(`Firecrawl failed: ${fcError.message}`);
    }
  }
  // ── End Firecrawl manual mode ───────────────────────────────────

  const page = await browser.newPage();
  await antiDetection.applyRetailBrowsingProfile(page);
  await page.setViewport(antiDetection.getRandomViewport());
  await page.bringToFront().catch(() => {});

  if (!normalized.url) {
    await page.close().catch(() => {});
    throw new Error('Product not found on Lefties for reference: ' + reference);
  }

  const capturedUrls = new Set();
  page.on('response', (resp) => {
    const reqUrl = cleanImageUrl(resp.url());
    if (isLikelyLeftiesProductImage(reqUrl)) {
      capturedUrls.add(reqUrl);
    }
  });

  try {
    ensureActive();
    await antiDetection.randomDelay(1000, 1800);
    await page.goto(normalized.url, { waitUntil: 'networkidle2', timeout: 60000 });
    await antiDetection.randomDelay(2200, 3200);
    await dismissCommonLeftiesPopups(page);

    if (await isLeftiesBlockedPage(page)) {
      throw new Error('Lefties blocked the current session while opening the product page.');
    }

    await antiDetection.randomDelay(600, 1000);
    await antiDetection.humanScroll(page, 2400);
    await antiDetection.randomDelay(500, 900);

    // Expand the "Composition and care" accordion so the panel text is in the DOM.
    // Lefties is built on Next.js, so a synthetic in-page .click() is often swallowed
    // by the SPA router — use Puppeteer's real CDP mouse click via elementHandle.click().
    const compositionHandle = await page.evaluateHandle(() => {
      const headingRegex = /^\s*(composition\s+and\s+care|composition,?\s*care(\s+and\s+(source|origin|traceability))?|materials,?\s+care(\s+and\s+(source|origin))?|composition\s+and\s+origin|composition|materials)\s*$/i;
      // Prefer real interactive elements first (button, summary, role=button), then
      // accept any short-text element that matches the heading label.
      const interactive = [...document.querySelectorAll('button, summary, [role="button"]')];
      const interactiveMatch = interactive.find((el) => {
        const text = String(el.textContent || '').trim();
        return text.length < 80 && headingRegex.test(text);
      });
      if (interactiveMatch) return interactiveMatch;
      const candidates = [...document.querySelectorAll('h2, h3, h4, a, span, div')];
      const labelMatch = candidates.find((el) => {
        const text = String(el.textContent || '').trim();
        return text.length < 80 && headingRegex.test(text);
      });
      if (!labelMatch) return null;
      // Walk up to find the nearest clickable ancestor so the click actually toggles
      // the accordion rather than firing on inert text.
      let cursor = labelMatch;
      for (let depth = 0; depth < 5 && cursor; depth += 1) {
        if (cursor.matches('button, summary, [role="button"], details')) return cursor;
        cursor = cursor.parentElement;
      }
      return labelMatch;
    }).catch(() => null);

    const compositionElement = compositionHandle ? compositionHandle.asElement() : null;
    if (compositionElement) {
      await page.evaluate((el) => {
        try { el.scrollIntoView({ behavior: 'instant', block: 'center' }); } catch { /* noop */ }
      }, compositionElement).catch(() => {});
      let realClickOk = false;
      try {
        await compositionElement.click({ delay: 60 });
        realClickOk = true;
      } catch (err) {
        emitLog(`    ⚠️ Lefties composition real-click failed: ${err.message}; trying synthetic`, 'warning');
      }
      if (!realClickOk) {
        await page.evaluate((el) => el.click(), compositionElement).catch(() => {});
      }
      await compositionHandle.dispose().catch(() => {});
      emitLog(`    🧶 Clicked Lefties composition accordion`, 'info');
    } else {
      emitLog(`    ⚠️ Lefties composition button not found in DOM`, 'warning');
    }
    await antiDetection.randomDelay(700, 1100);

    const info = await page.evaluate(() => {
      const bodyText = String(document.body?.innerText || '');
      const lines = bodyText.split('\n').map((line) => line.trim()).filter(Boolean);
      const refLine = lines.find((line) => /^REF\./i.test(line)) || '';
      const refMatch = refLine.match(/REF\.\s*([0-9/]+)/i);
      const priceIndex = lines.findIndex((line) => /\d/.test(line) && /€|\$|£/.test(line) && line.length <= 24);
      const price = priceIndex >= 0 ? lines[priceIndex] : '';
      const titleFromDocument = String(document.title || '').split(' - ')[0].trim();
      const domImages = [...document.querySelectorAll('img')]
        .map((img) => img.currentSrc || img.src)
        .filter(Boolean);
      const metaDescription = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';

      // ── Extract the composition-and-care panel text from the DOM
      const compositionFromDom = (() => {
        const headingRegex = /^\s*(composition\s+and\s+care|composition,?\s*care(\s+and\s+source)?|materials,?\s+care\s+and\s+source|composition)\s*$/i;
        const allElements = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6, div, span, button, summary, p')];
        const heading = allElements.find((el) => {
          const text = String(el.textContent || '').trim();
          return text.length < 80 && headingRegex.test(text);
        });
        if (!heading) return '';
        const container = heading.closest('section, [role="region"], details')
          || heading.parentElement?.parentElement
          || heading.parentElement;
        if (!container) return '';
        const text = String(container.innerText || container.textContent || '').trim();
        return text.length > 2000 ? text.slice(0, 2000) : text;
      })();

      // ── Extract the product description from the DOM
      // Lefties shows the description as a short paragraph on the product page,
      // usually directly under the title/price. Prefer JSON-LD product schema
      // (most reliable), then explicit selectors, then a heuristic fallback.
      const descriptionFromJsonLd = (() => {
        const blocks = [...document.querySelectorAll('script[type="application/ld+json"]')];
        for (const block of blocks) {
          try {
            const raw = String(block.textContent || '').trim();
            if (!raw) continue;
            const parsed = JSON.parse(raw);
            const nodes = Array.isArray(parsed) ? parsed : [parsed];
            for (const node of nodes) {
              if (!node || typeof node !== 'object') continue;
              const type = node['@type'];
              const types = Array.isArray(type) ? type : [type];
              if (!types.some((t) => String(t || '').toLowerCase() === 'product')) continue;
              const desc = String(node.description || '').trim();
              if (desc.length >= 20) return desc;
            }
          } catch { /* invalid JSON-LD block, skip */ }
        }
        return '';
      })();

      const descriptionFromDom = (() => {
        if (descriptionFromJsonLd) return descriptionFromJsonLd;
        const selectors = [
          '[data-qa-id="product-description"]',
          '[data-testid="product-description"]',
          '[data-qa-id="description"]',
          '[data-testid="description"]',
          '[data-qa-action="product-description"]',
          '[itemprop="description"]',
          'section[class*="description" i] p',
          'div[class*="description" i] p',
          'p[class*="description" i]',
        ];
        for (const sel of selectors) {
          const elements = [...document.querySelectorAll(sel)];
          for (const el of elements) {
            const txt = String(el.textContent || '').trim();
            if (txt.length >= 20 && txt.length < 1200) return txt;
          }
        }
        // Heuristic fallback: scan paragraphs near the product title for a
        // short text block that looks like a description (no prices, no REF.,
        // no all-caps headings).
        const paragraphs = [...document.querySelectorAll('p, span, div')];
        for (const el of paragraphs) {
          const txt = String(el.textContent || '').trim();
          if (txt.length < 30 || txt.length > 600) continue;
          if (/REF\.\s*\d/i.test(txt)) continue;
          if (/[€$£]\s?\d/.test(txt)) continue;
          if (/composition|materials|care|sign\s*in|cookies/i.test(txt)) continue;
          if (/^[A-Z\s]+$/.test(txt)) continue;
          // Require sentence-ending punctuation (period/!/?) AND lowercase letters
          // so we don't latch onto navigation labels.
          if (!/[.!?]/.test(txt)) continue;
          if (!/[a-z]/.test(txt)) continue;
          // Avoid containers that include child block elements (likely wrappers).
          if (el.children && el.children.length > 2) continue;
          return txt;
        }
        return '';
      })();

      return {
        title: titleFromDocument,
        price,
        styleNumber: refMatch ? refMatch[1] : '',
        pageText: bodyText.slice(0, 24000),
        domImages,
        metaDescription,
        compositionFromDom,
        descriptionFromDom,
      };
    });

    const styleNumber = info.styleNumber || normalized.styleNumber || normalized.input || reference;

    const imageUrls = [...new Set([
      ...capturedUrls,
      ...(info.domImages || [])
        .map((item) => cleanImageUrl(item))
        .filter((item) => isRelevantLeftiesProductImage(item, styleNumber)),
    ])]
      .filter((item) => isRelevantLeftiesProductImage(item, styleNumber))
      .sort((left, right) => getLeftiesImageOrder(left) - getLeftiesImageOrder(right));

    // Keep only the lines that look like fabric composition with percentages
    // (e.g. "65% Cotton, 35% Polyester" or "Cotton 65%"). Skip care instructions,
    // labels like "Composition and care", and anything without a %.
    const compositionText = extractLeftiesFabricComposition(info.compositionFromDom || '');
    const description = String(info.descriptionFromDom || info.metaDescription || '').trim();

    const productName = info.title || `Lefties ${styleNumber}`;
    emitInditexScrapeResult({
      emitLog,
      brand: 'Lefties',
      requestedReference: reference,
      actualStyleNumber: info.styleNumber || styleNumber,
      productName,
      imageCount: imageUrls.length,
      hasDescription: Boolean(description),
      hasComposition: Boolean(compositionText),
    });

    return {
      styleNumber,
      productId: styleNumber,
      brand: 'Lefties',
      name: productName,
      price: info.price || '',
      colorRef: '',
      description,
      composition: compositionText
        ? { outerShell: null, lining: null, other: compositionText }
        : null,
      url: normalized.url,
      imageUrls,
      pageText: info.pageText || '',
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function runLeftiesScraper(config, emitLog, emitProgress, taskController, previewBridge = null) {
  let { styleNumbers, excelPath, outputDir, downloadConcurrency } = config;
  styleNumbers = normalizeManualStyleNumbers(styleNumbers);
  const ensureActive = () => taskController?.throwIfCancelled?.();
  let browser = null;

  if (excelPath) {
    try {
      ensureActive();
      emitLog(`Reading Excel file: ${excelPath}`, 'info');
      const wb = XLSX.readFile(excelPath);
      const ws = wb.Sheets[wb.SheetNames[0]];
      styleNumbers = [];
      const range = XLSX.utils.decode_range(ws['!ref'] || 'A1:B1');
      for (let row = 1; row <= range.e.r; row += 1) {
        const cellAddress = XLSX.utils.encode_cell({ r: row, c: 1 });
        const cell = ws[cellAddress];
        if (cell) {
          const displayValue = String(cell.w ?? cell.v ?? '').trim();
          if (displayValue) {
            styleNumbers.push(displayValue);
            emitLog(`📥 Excel row ${row + 1} column B: "${displayValue}"`, 'info');
          }
        }
      }
      emitLog(`Loaded ${styleNumbers.length} Lefties style numbers from Excel.`, 'success');
    } catch (error) {
      throw new Error(`Excel parse failed: ${error.message}`);
    }
  }

  ensureActive();
  if (!styleNumbers || styleNumbers.length === 0) {
    throw new Error('No Lefties style numbers were found. Put the SKU values in column B or enter them manually.');
  }

  const targetDir = !outputDir || outputDir === '未选择' ? path.join(app.getPath('desktop'), 'Lefties') : outputDir;
  fs.mkdirSync(targetDir, { recursive: true });

  emitLog(`📁 Output directory: ${targetDir}`, 'info');
  emitLog('🌐 Launching the Lefties scraper session...', 'info');

  let executablePath = findChromePath();
  if (!executablePath) {
    emitLog('⬇️ No local Chrome was found. Downloading a managed Chrome runtime for GS Bot...', 'warning');
    const chromeInstall = await ensureChromeRuntimeAvailable((payload) => {
      if (payload?.status) {
        emitLog(payload.status, payload.phase === 'complete' ? 'success' : 'info');
      }
    });
    if (!chromeInstall?.success) {
      throw new Error(chromeInstall?.error || 'Chrome download failed.');
    }
    executablePath = chromeInstall.executablePath;
  }

  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: false,
      userDataDir: getLeftiesSessionDir(),
      args: antiDetection.getRetailLaunchArgs(),
      ignoreDefaultArgs: ['--enable-automation'],
      defaultViewport: null,
    });
    previewBridge?.attachToBrowser(browser);

    taskController?.onCancel(() => {
      if (browser && browser.isConnected()) {
        browser.close().catch(() => {});
      }
    });

    const products = [];
    let currentProgress = 5;
    emitProgress(currentProgress);
    const totalItems = styleNumbers.length;
    const effectiveTabConcurrency = 1;

    const processReference = async (reference) => {
      try {
        ensureActive();
        return await scrapeLeftiesProduct(browser, reference, emitLog, ensureActive);
      } catch (error) {
        if (isCancellationError(error) || taskController?.cancelled) {
          throw new TaskCancelledError();
        }
        return {
          styleNumber: reference,
          productId: reference,
          url: '',
          error: error.message || 'Unknown error',
          imageUrls: [],
        };
      }
    };

    // ── First pass
    emitLog(`🚀 Lefties 第一轮: ${totalItems} 个款号 (查询 /es/en/ 和 /ic/en/ 站点)`, 'warning');
    const firstPassResults = new Array(totalItems);
    for (let i = 0; i < totalItems; i += effectiveTabConcurrency) {
      ensureActive();
      const batch = styleNumbers.slice(i, i + effectiveTabConcurrency);
      emitLog(`🔄 [第一轮] Processing Lefties batch ${Math.floor(i / effectiveTabConcurrency) + 1}`, 'warning');

      const batchResults = await Promise.all(batch.map(async (reference, idxInBatch) => {
        const normalizedReference = normalizeLeftiesReference(reference);
        emitLog(`🎯 Lefties input raw: "${reference}"${normalizedReference?.styleCode ? ` -> Search ${normalizedReference.styleCode}` : ''}`, 'info');
        const result = await processReference(reference);
        return { index: i + idxInBatch, result };
      }));

      for (const { index, result } of batchResults) {
        firstPassResults[index] = result;
      }
      currentProgress = 5 + Math.round(((i + batch.length) / totalItems) * 25);
      emitProgress(currentProgress);
      if (i + effectiveTabConcurrency < totalItems) {
        await antiDetection.randomDelay(1500, 2500);
      }
    }

    const failedIndexes = [];
    for (let idx = 0; idx < firstPassResults.length; idx += 1) {
      const r = firstPassResults[idx];
      if (!r || !r.url || !r.imageUrls || r.imageUrls.length === 0) {
        failedIndexes.push(idx);
      }
    }

    const firstPassSuccess = totalItems - failedIndexes.length;
    emitLog(`📊 第一轮完成: ${firstPassSuccess}/${totalItems} 成功, ${failedIndexes.length} 需要第二轮重试`, 'info');

    // ── Second pass
    if (failedIndexes.length > 0) {
      emitLog(`🔁 Lefties 第二轮重试: ${failedIndexes.length} 个款号`, 'warning');
      for (let n = 0; n < failedIndexes.length; n += 1) {
        ensureActive();
        const idx = failedIndexes[n];
        const reference = styleNumbers[idx];
        emitLog(`🔄 [第二轮 ${n + 1}/${failedIndexes.length}] ${reference}`, 'warning');
        await antiDetection.randomDelay(1800, 3200);
        const result = await processReference(reference);
        firstPassResults[idx] = result;
        if (result?.url && result.imageUrls?.length > 0) {
          emitLog(`    ✅ 第二轮成功: ${reference}`, 'success');
        } else {
          const manualUrl = buildLeftiesManualSearchUrl(reference);
          emitLog(`    ❌ 第二轮仍失败: ${reference}`, 'error');
          emitLog(`    👉 建议人工下载: ${manualUrl}`, 'warning');
        }
        currentProgress = 30 + Math.round(((n + 1) / failedIndexes.length) * 20);
        emitProgress(currentProgress);
        if (n < failedIndexes.length - 1) {
          await antiDetection.randomDelay(2000, 3500);
        }
      }
    }

    products.push(...firstPassResults);
    currentProgress = 50;
    emitProgress(currentProgress);

    ensureActive();
    emitLog('🌐 Lefties page extraction complete. Preparing image downloads...', 'warning');

    const successProducts = products.filter((product) => product.imageUrls && product.imageUrls.length > 0);
    const failedProducts = products.filter((product) => !product.imageUrls || product.imageUrls.length === 0);
    const totalImages = successProducts.reduce((sum, product) => sum + product.imageUrls.length, 0);

    emitLog(`📊 Lefties summary: ${successProducts.length} styles succeeded, ${failedProducts.length} styles failed, ${totalImages} images collected.`, 'info');

    if (failedProducts.length > 0) {
      failedProducts.forEach((product) => {
        emitLog(`    ❌ ${product.styleNumber} - ${product.error || 'No product images found'}`, 'error');
        emitLog(`       👉 建议人工下载: ${buildLeftiesManualSearchUrl(product.styleNumber)}`, 'warning');
      });
    }

    const allTasks = [];
    for (const product of successProducts) {
      ensureActive();
      const cleanStyleNumber = sanitizeFileSegment(String(product.productId || product.styleNumber || '').replace(/\//g, '-'), 'lefties-item');
      const styleDir = path.join(targetDir, cleanStyleNumber);
      fs.mkdirSync(styleDir, { recursive: true });

      const classified = buildLeftiesImageMap(product.imageUrls);

      for (const [label, imgUrl] of Object.entries(classified)) {
        const ext = getUrlExtension(imgUrl, '.jpg');
        const filename = `${cleanStyleNumber}_${label}${ext}`;
        const filePath = path.join(styleDir, filename);
        allTasks.push(() => {
          ensureActive();
          return downloadFile(imgUrl, filePath, {
            headers: {
              Referer: product.url || 'https://www.lefties.com/',
              'User-Agent': 'Mozilla/5.0',
            },
            timeoutMs: 45000,
          })
            .then((size) => {
              if (size) {
                emitLog(`    ⬇️ [saved] ${filename} (${size.toFixed(1)} KB)`);
              }
            })
            .catch((error) => {
              emitLog(`    ❌ [failed] ${filename}: ${error.message}`, 'error');
            });
        });
      }

      const infoData = {
        styleNumber: product.productId || product.styleNumber,
        brand: product.brand || 'Lefties',
        name: product.name,
        price: product.price,
        colorRef: product.colorRef,
        description: product.description || '',
        composition: product.composition || null,
        url: product.url,
        images: classified,
      };
      const infoPath = path.join(styleDir, `${cleanStyleNumber}_info.json`);
      fs.writeFileSync(infoPath, JSON.stringify(infoData, null, 2), 'utf-8');
      emitLog(`📄 Saved product metadata: ${cleanStyleNumber}_info.json`, 'success');
    }

    emitLog(`📦 Downloading ${allTasks.length} Lefties images with ${downloadConcurrency} worker(s)...`, 'info');

    let completedTasks = 0;
    const tasksWithProgress = allTasks.map((task) => async () => {
      ensureActive();
      await task();
      completedTasks += 1;
      emitProgress(50 + Math.round((completedTasks / Math.max(allTasks.length, 1)) * 50));
    });

    if (tasksWithProgress.length > 0) {
      await parallelLimit(tasksWithProgress, downloadConcurrency);
    }

    emitProgress(100);
    const summary = products.map((product) => ({
      styleNumber: product.productId || product.styleNumber,
      brand: product.brand || 'Lefties',
      name: product.name,
      price: product.price,
      colorRef: product.colorRef,
      description: product.description || '',
      composition: product.composition || null,
      images: product.imageUrls ? product.imageUrls.length : 0,
      error: product.error || null,
    }));
    const summaryPath = path.join(targetDir, 'summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf-8');
    emitLog('📊 Saved summary.json', 'success');

    if (failedProducts.length > 0) {
      const failedSummary = failedProducts.map((product) => ({
        styleNumber: product.productId || product.styleNumber,
        error: product.error || 'No product images found',
      }));
      const failedJsonPath = path.join(targetDir, 'failed_styles.json');
      const failedTxtPath = path.join(targetDir, 'failed_styles.txt');
      fs.writeFileSync(failedJsonPath, JSON.stringify(failedSummary, null, 2), 'utf-8');
      fs.writeFileSync(
        failedTxtPath,
        failedSummary.map((item) => `${item.styleNumber}\t${item.error}`).join('\n'),
        'utf-8',
      );
      emitLog('📄 Saved failed_styles.json', 'success');
      emitLog('📄 Saved failed_styles.txt', 'success');
    }

    if (excelPath) {
      try {
        const workbook = XLSX.readFile(excelPath);
        const sheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
        const resultMap = new Map();

        products.forEach((product) => {
          const key = String(product.productId || product.styleNumber || '').trim();
          if (!key) return;
          resultMap.set(key, product);
          resultMap.set(key.replace(/\s+/g, ''), product);
        });

        if (!rows[0]) rows[0] = [];
        rows[0][2] = 'Status';
        rows[0][3] = 'Image Count';
        rows[0][4] = 'Error';

        for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
          const row = rows[rowIndex] || [];
          const rawValue = String(row[1] || '').trim();
          if (!rawValue) continue;

          const matched = resultMap.get(rawValue) || resultMap.get(rawValue.replace(/\s+/g, ''));
          if (!matched) {
            row[2] = 'Not processed';
            row[3] = 0;
            row[4] = '';
            rows[rowIndex] = row;
            continue;
          }

          const imageCount = matched.imageUrls ? matched.imageUrls.length : 0;
          row[2] = imageCount > 0 ? 'Success' : 'Failed';
          row[3] = imageCount;
          row[4] = matched.error || '';
          rows[rowIndex] = row;
        }

        const annotatedSheet = XLSX.utils.aoa_to_sheet(rows);
        workbook.Sheets[sheetName] = annotatedSheet;
        const parsedExcelPath = path.parse(excelPath);
        const annotatedPath = path.join(parsedExcelPath.dir, `${parsedExcelPath.name}_lefties_results${parsedExcelPath.ext}`);
        XLSX.writeFile(workbook, annotatedPath);
        emitLog(`📄 Saved annotated Excel: ${path.basename(annotatedPath)}`, 'success');
      } catch (error) {
        emitLog(`⚠️ Could not save annotated Lefties Excel: ${error.message}`, 'warning');
      }
    }

    emitLog(`🎉 Lefties scraping finished. Files saved to: ${targetDir}`, 'success');
  } finally {
    if (browser && browser.isConnected()) {
      await browser.close().catch(() => {});
    }
  }
}

// ── Mango scraper ───────────────────────────────────────────────────────────
// Mango has native English locales (us/en/, gb/en/), so we use those for
// English metadata. However, EU references (e.g. 27005946) are usually only
// indexed in the Spanish/EU catalogue, so we try the ES locale FIRST when the
// SKU looks like an 8-digit EU reference, then fall back to English locales.
const MANGO_ENGLISH_LOCALES = ['us/en', 'gb/en'];
const MANGO_EU_LOCALES = ['es/es', 'es-ce/es', 'fr/fr', 'it/it', 'de/de'];
const MANGO_HOME_URL = 'https://shop.mango.com/us/en/';
const MANGO_DIRECT_SEARCH_URLS = (q) => {
  const encoded = encodeURIComponent(String(q || '').trim());
  // Mango supports both ?kw= and ?q= as the search parameter; emit both.
  // Order: EU locales first (most likely to have any given SKU), then English.
  return [
    ...MANGO_EU_LOCALES.flatMap((locale) => [
      `https://shop.mango.com/${locale}/search?kw=${encoded}`,
      `https://shop.mango.com/${locale}/search?q=${encoded}`,
    ]),
    ...MANGO_ENGLISH_LOCALES.flatMap((locale) => [
      `https://shop.mango.com/${locale}/search?kw=${encoded}`,
      `https://shop.mango.com/${locale}/search?q=${encoded}`,
    ]),
  ];
};
const buildMangoManualSearchUrl = (q) =>
  `https://shop.mango.com/es/es/search?kw=${encodeURIComponent(String(q || '').trim())}`;

function normalizeMangoReference(reference = '') {
  const input = String(reference || '').trim();
  const compact = input.replace(/\D/g, '');
  return {
    input,
    compactDigits: compact,
    styleCode: compact,
  };
}

function isLikelyMangoProductImage(url = '') {
  const value = String(url || '').toLowerCase();
  if (!value) return false;
  // Scene7 image-server URLs on media.mango.com have no extension; accept them
  // outright. For all other CDNs require a normal image extension.
  const isScene7Mango = /(?:^|\/\/)media\.mango\.com\/is\/image\//i.test(value);
  if (!isScene7Mango && !/\.(?:jpe?g|png|webp)(?:\?|$)/i.test(value)) return false;
  // Mango serves product imagery from several CDN hosts. Cover all known ones
  // and the generic /assets/, /rcs/, /i/ paths under any mango host.
  return isScene7Mango
    || value.includes('st.mngbcn.com')
    || value.includes('mngbcn.com/')
    || value.includes('static.e-mango.com')
    || value.includes('mango.com/rcs/')
    || value.includes('mango.com/assets/')
    || value.includes('mango.com/i/')
    || value.includes('mango.com/web/oi/')
    || value.includes('mango.net/')
    || /\/mango[^/]*\/[^/]*\d{7,}/i.test(value);
}

function isRelevantMangoProductImage(url = '', styleNumber = '') {
  if (!isLikelyMangoProductImage(url)) return false;
  const digits = String(styleNumber || '').replace(/\D/g, '');
  if (!digits) return true;
  const filename = path.basename(String(url || '').split('?')[0]).toLowerCase();
  // Mango image filenames usually contain the 8-digit article reference, e.g.
  // 27005946_TM.jpg, 27005946_99.jpg, 27005946-87099960.jpg. But some CDN
  // paths embed the SKU in the directory rather than the filename, so check
  // the full URL path too.
  const fullPath = String(url || '').split('?')[0].toLowerCase();
  return filename.includes(digits)
    || filename.includes(digits.slice(0, 7))
    || filename.includes(digits.slice(0, 6))
    || fullPath.includes(digits)
    || fullPath.includes(digits.slice(0, 7))
    || fullPath.includes(digits.slice(0, 6));
}

function parseMangoImageMeta(url = '', fallbackIndex = 0) {
  const filename = path.basename(String(url || '').split('?')[0]).toLowerCase();
  // Mango images carry shot codes like _01, _02, _99 (back), _B (back), _D (detail).
  // Scene7 URLs (media.mango.com/is/image/punto/27005945-85-002) have no
  // extension; we strip the trailing -<seq> from those.
  if (/_99(?:\.|$)/.test(filename) || /_b(?:\.|$)/.test(filename) || /_back/.test(filename) || /-99$/.test(filename)) {
    return { kind: 'back', order: 999, sequence: 99 };
  }
  if (/_d\d*(?:\.|$)/.test(filename) || /_detail/.test(filename)) {
    return { kind: 'detail', order: 400 + fallbackIndex, sequence: fallbackIndex };
  }
  // With extension: 27005946_01.jpg | 27005946-01.jpg
  const numMatchExt = filename.match(/[-_](\d{1,2})\.[a-z]+$/);
  if (numMatchExt) {
    const seq = Number.parseInt(numMatchExt[1], 10);
    return { kind: 'shot', order: seq, sequence: seq };
  }
  // Without extension (Scene7): 27005945-85-002 → trailing -002 is the shot.
  const numMatchBare = filename.match(/-(\d{1,3})$/);
  if (numMatchBare) {
    const seq = Number.parseInt(numMatchBare[1], 10);
    return { kind: 'shot', order: seq, sequence: seq };
  }
  return { kind: 'misc', order: 900 + fallbackIndex, sequence: fallbackIndex };
}

function getMangoImageOrder(url = '', fallbackIndex = 0) {
  return parseMangoImageMeta(url, fallbackIndex).order;
}

function buildMangoImageMap(imageUrls = [], flatLayFlags = null) {
  // F = first flat-lay (white background) shot, B = last flat-lay shot.
  // If we don't have reliable flat-lay flags, fall back to gallery order:
  // first image = F, last image = B.
  const list = [...imageUrls];
  const map = {};
  if (list.length === 0) return map;

  const flats = Array.isArray(flatLayFlags) && flatLayFlags.length === list.length
    ? list.filter((_, i) => flatLayFlags[i])
    : [];

  if (flats.length >= 2) {
    map.F = flats[0];
    map.B = flats[flats.length - 1];
    let extraIndex = 1;
    for (const u of list) {
      if (u === map.F || u === map.B) continue;
      map[String(extraIndex).padStart(2, '0')] = u;
      extraIndex += 1;
    }
    return map;
  }
  if (flats.length === 1) {
    map.F = flats[0];
    let extraIndex = 1;
    for (const u of list) {
      if (u === map.F) continue;
      map[String(extraIndex).padStart(2, '0')] = u;
      extraIndex += 1;
    }
    return map;
  }

  // No flat-lay signal: fall back to gallery order.
  if (list.length === 1) {
    map.F = list[0];
    return map;
  }
  map.F = list[0];
  map.B = list[list.length - 1];
  let extraIndex = 1;
  for (let i = 1; i < list.length - 1; i += 1) {
    map[String(extraIndex).padStart(2, '0')] = list[i];
    extraIndex += 1;
  }
  return map;
}

function extractMangoFabricComposition(rawText = '') {
  const text = String(rawText || '').trim();
  if (!text) return '';
  // Recognise fibre names so we don't treat "30% OFF" or "20% extra discount"
  // as a composition line. Mango uses both English and Spanish fibre vocab.
  const fibreRegex = /\d+\s*%\s*(?:cotton|polyester|elastane|viscose|linen|wool|silk|nylon|polyamide|acrylic|cashmere|leather|lyocell|modal|rayon|spandex|tencel|hemp|cupro|acetate|alpaca|mohair|ramie|jute|recycled|organic|algod[oó]n|poli[eé]ster|elastano|viscosa|lino|lana|seda|nail[oó]n|poliamida|acr[ií]lico|cuero|li[oó]cel|recicl[ao])/i;
  const segments = text
    .split(/[\r\n]+|(?<=[.])\s+|·|•|;/)
    .map((seg) => seg.trim())
    .filter(Boolean);
  const seen = new Set();
  const compositionLines = [];
  for (const seg of segments) {
    if (!fibreRegex.test(seg)) continue;
    const cleaned = seg.replace(/\s+/g, ' ').trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    compositionLines.push(cleaned);
  }
  return compositionLines.join('\n');
}

async function dismissCommonMangoPopups(page) {
  // Mango uses OneTrust cookies + occasional newsletter/promotion modals.
  const selectors = [
    '#onetrust-accept-btn-handler',
    'button[id*="accept" i][id*="cookie" i]',
    'button[aria-label*="accept" i]',
    'button[aria-label*="aceptar" i]',
    'button[aria-label*="close" i]',
    'button[aria-label*="cerrar" i]',
    'button[data-testid*="accept" i]',
    'button[data-testid*="close" i]',
  ];
  for (const sel of selectors) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click({ delay: 60 }).catch(() => {});
        await antiDetection.randomDelay(300, 600);
      }
    } catch { /* noop */ }
  }
}

async function openMangoSearchOverlay(page) {
  const directSelectors = [
    'button[aria-label*="search" i]',
    'button[aria-label*="buscar" i]',
    'a[href*="/search"]',
    '[data-testid*="search" i] button',
    '[data-testid*="search-button" i]',
    'header button[class*="search" i]',
    'header [class*="search" i] button',
  ];
  for (const sel of directSelectors) {
    try {
      const handle = await page.$(sel);
      if (handle) {
        await handle.click({ delay: 50 }).catch(() => {});
        return true;
      }
    } catch { /* noop */ }
  }
  return page.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return false;
      const s = window.getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
    };
    const candidates = [...document.querySelectorAll('button, a[href], [role="button"]')];
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const haystack = [
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
        el.getAttribute('data-testid'),
        el.className,
        el.id,
      ].join(' ').toLowerCase();
      if (/\b(search|buscar|cerca|recherche|suche)\b/.test(haystack)) {
        el.click();
        return true;
      }
    }
    return false;
  });
}

async function findVisibleMangoSearchInput(page) {
  return page.evaluateHandle(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 6) return false;
      const s = window.getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
    };
    const inputs = [...document.querySelectorAll(
      'input[type="search"], input[type="text"], input:not([type]), textarea, [contenteditable="true"]',
    )].filter(isVisible);
    const ranked = inputs.find((el) => {
      const haystack = [
        el.getAttribute('type'),
        el.getAttribute('name'),
        el.getAttribute('placeholder'),
        el.getAttribute('aria-label'),
        el.getAttribute('id'),
        el.getAttribute('data-testid'),
        el.className,
      ].join(' ').toLowerCase();
      return /search|buscar|kw|query|keyword|term/i.test(haystack);
    });
    return ranked || inputs[0] || null;
  });
}

async function extractMangoSearchProductUrl(page, query) {
  return page.evaluate((q) => {
    const normalizeDigits = (value) => String(value || '').replace(/\D/g, '');
    const queryDigits = normalizeDigits(q);

    // Prefer anchors inside the search-results grid so we ignore "you may
    // also like" / recommendation carousels.
    const scopeSelectors = [
      '[data-testid*="search-result" i]',
      '[data-testid*="product-grid" i]',
      '[class*="search-result" i]',
      '[class*="searchResult" i]',
      '[class*="ProductGrid" i]',
      '[class*="product-grid" i]',
      'main [class*="product" i]',
    ];
    let scope = null;
    for (const sel of scopeSelectors) {
      const candidate = document.querySelector(sel);
      if (candidate && candidate.querySelector('a[href]')) {
        scope = candidate;
        break;
      }
    }
    const root = scope || document;
    const links = [...root.querySelectorAll('a[href]')];
    const candidates = links
      .map((link) => ({ href: link.href, text: String(link.textContent || '').trim() }))
      .filter((entry) => {
        const href = String(entry.href || '');
        if (!href) return false;
        if (!/mango\.com\//i.test(href)) return false;
        if (/\/search(?:[?/]|$)/i.test(href)) return false;
        // Mango product URLs typically contain _<digits> or /p/ in path
        return /_\d{7,}/.test(href) || /\/p\//i.test(href) || /\/product\//i.test(href);
      });

    if (queryDigits.length >= 6) {
      const exact = candidates.find((entry) => normalizeDigits(entry.href).includes(queryDigits));
      if (exact?.href) return exact.href;
      // Try first 7 digits (Mango sometimes appends colour digits)
      const stylePrefix = queryDigits.slice(0, 7);
      const prefixMatch = candidates.find((entry) => normalizeDigits(entry.href).includes(stylePrefix));
      if (prefixMatch?.href) return prefixMatch.href;
      // Try first 6 digits as a last-resort SKU-prefix match (still requires the
      // product href to contain the user's digits — never a blind candidates[0]).
      const sixPrefix = queryDigits.slice(0, 6);
      if (sixPrefix.length === 6) {
        const sixMatch = candidates.find((entry) => normalizeDigits(entry.href).includes(sixPrefix));
        if (sixMatch?.href) return sixMatch.href;
      }
    }

    // Refuse to return a random anchor when the user's SKU digits don't match
    // anything in the grid — that would silently substitute a "you may also
    // like" / recommended item, the same false-positive bug we hit on
    // Stradivarius. Caller will try the next query variant or report failure.
    return '';
  }, query);
}

async function clickFirstMangoProductCard(page, emitLog, expectedDigits = '') {
  // Wait briefly for the grid to render
  await antiDetection.randomDelay(800, 1300);

  const result = await page.evaluate((expectedDigitsRaw) => {
    const normalizeDigits = (value) => String(value || '').replace(/\D/g, '');
    const productLinkRegex = /mango\.com\/.*(?:_\d{7,}|\/p\/|\/product\/)/i;
    const scopeSelectors = [
      '[data-testid*="search-result" i]',
      '[data-testid*="product-grid" i]',
      '[class*="search-result" i]',
      '[class*="searchResult" i]',
      '[class*="ProductGrid" i]',
      '[class*="product-grid" i]',
      'main',
    ];
    let scope = null;
    for (const sel of scopeSelectors) {
      const candidate = document.querySelector(sel);
      if (candidate && candidate.querySelector('a[href]')) { scope = candidate; break; }
    }
    const root = scope || document;
    const anchors = [...root.querySelectorAll('a[href]')].filter((a) => productLinkRegex.test(a.href));
    if (!anchors.length) return { href: '', colorId: '' };

    const expectedDigits = normalizeDigits(expectedDigitsRaw);
    const pickAnchor = () => {
      if (expectedDigits.length >= 6) {
        const exact = anchors.find((a) => normalizeDigits(a.href).includes(expectedDigits));
        if (exact) return exact;
        const sevenPrefix = expectedDigits.slice(0, 7);
        const seven = anchors.find((a) => normalizeDigits(a.href).includes(sevenPrefix));
        if (seven) return seven;
        const sixPrefix = expectedDigits.slice(0, 6);
        if (sixPrefix.length === 6) {
          const six = anchors.find((a) => normalizeDigits(a.href).includes(sixPrefix));
          if (six) return six;
        }
        return null;
      }
      return anchors[0];
    };
    const anchor = pickAnchor();
    if (!anchor) return { href: '', colorId: '' };

    // Try to glean the colour id from the card's thumbnail (Scene7 URL middle
    // segment) so the PDP opens with the right variant rather than Mango's
    // default colour.
    let colorId = '';
    const queryColor = (anchor.getAttribute('href') || '').match(/[?&](?:colorId|c|color)=([^&#]+)/i);
    if (queryColor) colorId = queryColor[1];
    if (!colorId) {
      const img = anchor.querySelector('img');
      const src = img ? (img.currentSrc || img.src || img.getAttribute('data-src') || '') : '';
      const m = String(src).match(/media\.mango\.com\/is\/image\/punto\/\d+-(\d{1,3})-/i);
      if (m) colorId = m[1];
    }
    return { href: anchor.href, colorId };
  }, expectedDigits);

  const targetHref = result?.href || '';
  if (!targetHref) {
    return '';
  }

  let navUrl = targetHref;
  if (result.colorId && !/[?&](?:colorId|c|color)=/i.test(navUrl)) {
    navUrl += (navUrl.includes('?') ? '&' : '?') + `colorId=${encodeURIComponent(result.colorId)}`;
  }

  emitLog(`    🖱️ Clicked Mango search result card → ${targetHref.split('/').slice(-1)[0]}${result.colorId ? ` [color=${result.colorId}]` : ''}`, 'info');
  await page.goto(navUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await antiDetection.randomDelay(1500, 2500);
  // Return the originally matched href (with SKU digits) rather than the
  // post-redirect URL — Mango sometimes rewrites the canonical URL on the
  // PDP and the secondary verification in the caller would then reject it.
  return navUrl;
}

async function searchMangoByTyping(page, query, emitLog, ensureActive) {
  emitLog(`    🔍 Searching Mango by typing "${query}"…`, 'info');

  // Typed search only — open the homepage, click the search button, type the
  // SKU into the live search input, press Enter, then click the first result
  // whose href contains the SKU digits. We deliberately avoid all
  // /search?kw= direct URLs because Mango's search-result router silently
  // redirects "no match" lookups to recommended products.
  try {
    await page.goto(MANGO_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await dismissCommonMangoPopups(page);
    await antiDetection.randomDelay(1500, 2200);
    ensureActive();

    emitLog('    🔎 Opening Mango search overlay…', 'info');
    const opened = await openMangoSearchOverlay(page);
    if (!opened) {
      emitLog('    ⚠️ Could not open Mango search overlay; giving up on this reference.', 'warning');
      return '';
    }
    await antiDetection.randomDelay(1200, 1800);
    ensureActive();

    let inputHandle = await findVisibleMangoSearchInput(page);
    let inputElement = inputHandle ? inputHandle.asElement() : null;
    if (!inputElement) {
      emitLog('    🔁 Mango search input not visible yet; retrying…', 'info');
      await openMangoSearchOverlay(page).catch(() => false);
      await antiDetection.randomDelay(1500, 2500);
      inputHandle = await findVisibleMangoSearchInput(page);
      inputElement = inputHandle ? inputHandle.asElement() : null;
    }
    if (!inputElement) {
      emitLog('    ⚠️ Mango search input did not appear; giving up on this reference.', 'warning');
      return '';
    }

    try {
      await inputElement.click({ delay: 80 });
    } catch {
      await page.evaluate((el) => el.focus(), inputElement).catch(() => {});
    }
    await antiDetection.randomDelay(300, 600);

    emitLog(`    ⌨️ Typing Mango search "${query}" via DOM write…`, 'info');
    await writeSearchValueViaDOM(page, inputElement, query, emitLog, 'Mango');

    emitLog('    ⏳ Waiting for Mango search results…', 'info');
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null),
      page.waitForFunction(
        () => [...document.querySelectorAll('a[href*="mango.com"]')].some((a) => /_\d{7,}|\/p\/|\/product\//i.test(a.href)),
        { timeout: 20000, polling: 400 },
      ).catch(() => null),
    ]);
    await antiDetection.randomDelay(1500, 2400);
    ensureActive();

    const queryDigits = String(query || '').replace(/\D/g, '');

    // Mango sometimes auto-navigates straight to a PDP when the SKU matches
    // exactly. In that case there's no result grid to click — just verify
    // the landed URL contains the SKU digits and return it.
    const landedNow = page.url();
    const landedDigitsNow = landedNow.replace(/\D/g, '');
    const onPdp = /_\d{7,}|\/p\/|\/product\//i.test(landedNow)
      && !/\/search/i.test(landedNow);
    if (onPdp && queryDigits.length >= 6 && (
      landedDigitsNow.includes(queryDigits)
      || landedDigitsNow.includes(queryDigits.slice(0, 7))
      || landedDigitsNow.includes(queryDigits.slice(0, 6))
    )) {
      emitLog(`    ✅ Mango auto-navigated to PDP for "${query}"`, 'info');
      return landedNow;
    }
    const clicked = await clickFirstMangoProductCard(page, emitLog, queryDigits);
    if (clicked) {
      // Verify the resulting URL actually contains the user's SKU digits.
      const landedDigits = clicked.replace(/\D/g, '');
      if (
        queryDigits.length < 6
        || landedDigits.includes(queryDigits)
        || landedDigits.includes(queryDigits.slice(0, 7))
        || landedDigits.includes(queryDigits.slice(0, 6))
      ) {
        return clicked;
      }
      emitLog(`    ⚠️ Mango landed on a non-matching product (${clicked.split('/').slice(-1)[0]}); rejecting.`, 'warning');
      return '';
    }

    const extracted = await extractMangoSearchProductUrl(page, query);
    if (extracted) {
      await page.goto(extracted, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await antiDetection.randomDelay(1500, 2500);
      return page.url();
    }
  } catch (error) {
    ensureActive();
    emitLog(`    ⚠️ Mango typed search failed: ${error.message}`, 'warning');
  }

  return '';
}

async function resolveMangoProductUrl(browser, reference, emitLog, ensureActive) {
  const normalized = normalizeMangoReference(reference);
  if (!normalized.compactDigits) {
    throw new Error(`Empty Mango reference: ${reference}`);
  }

  const page = await browser.newPage();
  await antiDetection.applyRetailBrowsingProfile(page);
  await page.setViewport(antiDetection.getRandomViewport());
  await page.bringToFront().catch(() => {});

  try {
    const queries = [];
    const addQuery = (q) => {
      const trimmed = String(q || '').trim();
      if (trimmed && !queries.includes(trimmed)) queries.push(trimmed);
    };
    addQuery(normalized.input);
    addQuery(normalized.compactDigits);
    if (normalized.compactDigits.length >= 8) {
      // Some Mango SKUs are <7-digit-style><1-digit-color>; try the style-only form
      addQuery(normalized.compactDigits.slice(0, 7));
    }

    let resolvedUrl = '';
    for (const candidate of queries) {
      ensureActive();
      resolvedUrl = await searchMangoByTyping(page, candidate, emitLog, ensureActive);
      if (resolvedUrl) break;
      emitLog(`    ↪ Mango "${candidate}" produced no real match; trying next variant…`, 'info');
    }

    return {
      url: resolvedUrl,
      styleNumber: normalized.compactDigits,
      input: normalized.input,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function scrapeMangoProduct(browser, reference, emitLog, ensureActive) {
  const normalized = await resolveMangoProductUrl(browser, reference, emitLog, ensureActive);

  if (!normalized.url) {
    throw new Error(`Product not found on Mango for reference: ${reference}`);
  }

  // ── Firecrawl mode check ───────────────────────────────────────
  const currentMode = firecrawlService.getMode();
  if (currentMode === 'manual') {
    emitLog(` Mango ${reference || ''} 手动模式: 使用 Firecrawl 抓取`, 'warning');
    try {
      ensureActive();
      const fcResult = await firecrawlFallback.tryFirecrawlFallback(normalized.url, {
        imageFilter: (imgUrl) => isLikelyMangoProductImage(imgUrl),
        urlNormalizer: (u) => u.split('?')[0],
        candidateIds: [String(reference || '').replace(/\D/g, '')],
        emitLog: (msg, type) => emitLog(`    ${msg}`, type),
      });

      // ─ Parse product text from Firecrawl HTML ────────────────────
      const html = fcResult.html || '';
      let name = '';
      let price = '';
      let description = '';
      let compositionText = null;

      const h1Match = html.match(/<h1[^>]*>(.*?)<\/h1>/is);
      if (h1Match) {
        name = h1Match[1].replace(/<[^>]+>/g, '').trim();
      }

      const priceMatch = html.match(/[€$£¥]([\d.,]+)/);
      if (priceMatch) {
        price = priceMatch[0];
      }

      const descPatterns = [
        /["']description["']?:\s*["']([^"']+)["']/i,
        /<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i,
      ];
      for (const pattern of descPatterns) {
        const m = html.match(pattern);
        if (m) {
          description = m[1].trim();
          break;
        }
      }

      const compPatterns = [
        /["']composition["']?:\s*["']([^"']+)["']/i,
        /["']materials["']?:\s*["']([^"']+)["']/i,
      ];
      for (const pattern of compPatterns) {
        const m = html.match(pattern);
        if (m) {
          compositionText = m[1].trim();
          break;
        }
      }

      const styleNumber = String(reference || '').replace(/\D/g, '');
      return {
        styleNumber,
        productId: styleNumber,
        brand: 'Mango',
        name: name || `Mango ${styleNumber}`,
        price,
        colorRef: '',
        description,
        composition: compositionText ? { outerShell: null, lining: null, other: compositionText } : null,
        url: normalized.url,
        imageUrls: fcResult.imageUrls,
        pageText: '',
        usedEngine: 'firecrawl',
      };
    } catch (fcError) {
      emitLog(`❌ Mango ${reference || ''} Firecrawl 抓取失败: ${fcError.message}`, 'error');
      throw new Error(`Firecrawl failed: ${fcError.message}`);
    }
  }
  // ── End Firecrawl manual mode ───────────────────────────────────

  const page = await browser.newPage();
  await antiDetection.applyRetailBrowsingProfile(page);
  await page.setViewport(antiDetection.getRandomViewport());
  await page.bringToFront().catch(() => {});

  const capturedUrls = new Set();
  page.on('response', (resp) => {
    const reqUrl = cleanImageUrl(resp.url());
    if (isLikelyMangoProductImage(reqUrl)) {
      capturedUrls.add(reqUrl);
    }
  });

  try {
    ensureActive();
    await antiDetection.randomDelay(1000, 1800);
    await page.goto(normalized.url, { waitUntil: 'networkidle2', timeout: 60000 });
    await antiDetection.randomDelay(2200, 3200);
    await dismissCommonMangoPopups(page);

    // Scroll to materialise lazy-loaded gallery imagery and composition panel
    await antiDetection.humanScroll(page, 2600);
    await antiDetection.randomDelay(600, 1000);

    // Try to expand the composition / care accordion on the PDP. Mango uses
    // an accordion labelled "Details, composition and care" (English) or
    // "Detalles, composición y cuidados" (Spanish). The shorter "Composition
    // and care" form also appears on some PDPs. We click the heading so the
    // panel is in the DOM.
    const compositionHandle = await page.evaluateHandle(() => {
      const headingRegex = /^\s*(?:details?,?\s+)?(?:composition\s+and\s+care|composition,?\s*care|composition|materials,?\s+care)\s*$|^\s*(?:detalles?,?\s+)?(?:composici[oó]n\s+y\s+cuidados|composici[oó]n)\s*$/i;
      const candidates = [...document.querySelectorAll('button, summary, [role="button"], h2, h3, h4, span, div')];
      const match = candidates.find((el) => {
        const text = String(el.textContent || '').trim();
        return text.length < 80 && headingRegex.test(text);
      });
      if (!match) return null;
      let cursor = match;
      for (let depth = 0; depth < 5 && cursor; depth += 1) {
        if (cursor.matches('button, summary, [role="button"], details')) return cursor;
        cursor = cursor.parentElement;
      }
      return match;
    }).catch(() => null);

    const compositionElement = compositionHandle ? compositionHandle.asElement() : null;
    if (compositionElement) {
      await page.evaluate((el) => {
        try { el.scrollIntoView({ behavior: 'instant', block: 'center' }); } catch { /* noop */ }
      }, compositionElement).catch(() => {});
      try {
        await compositionElement.click({ delay: 60 });
      } catch {
        await page.evaluate((el) => el.click(), compositionElement).catch(() => {});
      }
      // Mango's accordion animates open; wait for the panel content (any
      // visible "<digits>% <Word>" text) to materialise before extracting.
      await page.waitForFunction(
        () => /\d+\s*%\s*(?:cotton|polyester|elastane|viscose|linen|wool|silk|nylon|polyamide|acrylic|cashmere|lyocell|modal|rayon|spandex|tencel|hemp|cupro|acetate|alpaca|mohair|ramie|jute|recycled|organic|algod[oó]n|poli[eé]ster|elastano|viscosa|lino|lana|seda|nail[oó]n|poliamida|acr[ií]lico|li[oó]cel|recicl[ao])/i.test(String(document.body?.innerText || '')),
        { timeout: 6000, polling: 300 },
      ).catch(() => {});
      await compositionHandle.dispose().catch(() => {});
      emitLog('    🧶 Clicked Mango composition accordion', 'info');
    } else {
      emitLog('    ⚠️ Mango composition button not found in DOM', 'warning');
    }
    await antiDetection.randomDelay(700, 1100);

    const info = await page.evaluate(() => {
      const bodyText = String(document.body?.innerText || '');
      const titleFromDocument = String(document.title || '').split(' | ')[0].split(' - ')[0].trim();
      const domImages = [...document.querySelectorAll('img')]
        .map((img) => img.currentSrc || img.src)
        .filter(Boolean);

      // Style number — try a few selectors first, then fall back to URL
      let styleNumber = '';
      const refSelectors = [
        '[itemprop="sku"]',
        '[data-testid*="reference" i]',
        '[data-testid*="sku" i]',
        '[class*="reference" i]',
      ];
      for (const sel of refSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          const text = String(el.textContent || '').trim();
          const digits = text.match(/\d{7,}/);
          if (digits) { styleNumber = digits[0]; break; }
        }
      }
      if (!styleNumber) {
        const urlMatch = location.href.match(/_(\d{7,})/);
        if (urlMatch) styleNumber = urlMatch[1];
      }

      // Price
      const priceSelectors = [
        '[itemprop="price"]',
        '[data-testid*="price" i]',
        '[class*="price" i]',
      ];
      let price = '';
      for (const sel of priceSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          const text = String(el.textContent || '').trim();
          if (/\d/.test(text) && /[€$£¥]/.test(text)) { price = text; break; }
        }
      }

      // Description — prefer JSON-LD, then explicit selectors, then meta
      const descriptionFromJsonLd = (() => {
        const blocks = [...document.querySelectorAll('script[type="application/ld+json"]')];
        for (const block of blocks) {
          try {
            const raw = String(block.textContent || '').trim();
            if (!raw) continue;
            const parsed = JSON.parse(raw);
            const nodes = Array.isArray(parsed) ? parsed : [parsed];
            for (const node of nodes) {
              if (!node || typeof node !== 'object') continue;
              const type = node['@type'];
              const types = Array.isArray(type) ? type : [type];
              if (!types.some((t) => String(t || '').toLowerCase() === 'product')) continue;
              const desc = String(node.description || '').trim();
              if (desc.length >= 20) return desc;
            }
          } catch { /* skip */ }
        }
        return '';
      })();
      const descriptionFromDom = (() => {
        if (descriptionFromJsonLd) return descriptionFromJsonLd;
        const selectors = [
          '[data-testid*="product-description" i]',
          '[data-testid*="description" i]',
          '[itemprop="description"]',
          'section[class*="description" i] p',
          'div[class*="description" i] p',
        ];
        for (const sel of selectors) {
          const elements = [...document.querySelectorAll(sel)];
          for (const el of elements) {
            const txt = String(el.textContent || '').trim();
            if (txt.length >= 20 && txt.length < 1200) return txt;
          }
        }
        return '';
      })();
      const metaDescription = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';

      // Composition panel — capture full accordion text once expanded.
      // Mango labels the panel "Details, composition and care" (English) or
      // "Detalles, composición y cuidados" (Spanish); short variants also exist.
      const compositionFromDom = (() => {
        const headingRegex = /^\s*(?:details?,?\s+)?(?:composition\s+and\s+care|composition,?\s*care|composition|materials,?\s+care)\s*$|^\s*(?:detalles?,?\s+)?(?:composici[oó]n\s+y\s+cuidados|composici[oó]n)\s*$/i;
        // Strict: only count "<digits>% <fibre-name>" — never percentages
        // attached to "OFF", "discount", "extra", etc.
        const fibreRegex = /\d+\s*%\s*(?:cotton|polyester|elastane|viscose|linen|wool|silk|nylon|polyamide|acrylic|cashmere|leather|lyocell|modal|rayon|spandex|tencel|hemp|cupro|acetate|alpaca|mohair|ramie|jute|recycled|organic|algod[oó]n|poli[eé]ster|elastano|viscosa|lino|lana|seda|nail[oó]n|poliamida|acr[ií]lico|cuero|li[oó]cel|recicl[ao])/i;
        const allElements = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6, div, span, button, summary, p')];
        const heading = allElements.find((el) => {
          const text = String(el.textContent || '').trim();
          return text.length < 80 && headingRegex.test(text);
        });
        const tryReadFrom = (root) => {
          if (!root) return '';
          const text = String(root.innerText || root.textContent || '').trim();
          return text.length > 4000 ? text.slice(0, 4000) : text;
        };
        if (heading) {
          // Walk up and keep expanding while the wrapper still looks like a
          // single accordion panel (under ~3000 chars). We want the
          // *largest* ancestor that contains all fibre lines together, not
          // just the first sub-element that happens to contain "Lining:".
          let bestFromAncestors = '';
          let cursor = heading;
          for (let depth = 0; depth < 8 && cursor && cursor.parentElement; depth += 1) {
            const candidate = cursor.parentElement;
            const t = String(candidate.innerText || '').trim();
            if (t.length > 3000) break;
            if (fibreRegex.test(t)) {
              bestFromAncestors = tryReadFrom(candidate);
            }
            cursor = candidate;
          }
          if (bestFromAncestors) return bestFromAncestors;
          let sib = heading.nextElementSibling || heading.parentElement?.nextElementSibling;
          for (let i = 0; i < 4 && sib; i += 1) {
            const t = String(sib.innerText || '').trim();
            if (fibreRegex.test(t)) return tryReadFrom(sib);
            sib = sib.nextElementSibling;
          }
        }
        // Last-resort: combine ALL small page blocks that mention a fibre name
        // so we never lose one line because another (smaller) container won.
        const pctNodes = [...document.querySelectorAll('div, section, ul, li, p, span')]
          .filter((el) => {
            const t = String(el.innerText || el.textContent || '').trim();
            return t.length > 0 && t.length < 800 && fibreRegex.test(t);
          });
        if (pctNodes.length) {
          // Dedup by text, then join.
          const seen = new Set();
          const lines = [];
          for (const node of pctNodes) {
            const t = String(node.innerText || node.textContent || '').trim();
            if (!t || seen.has(t)) continue;
            seen.add(t);
            lines.push(t);
          }
          return lines.join('\n');
        }
        return '';
      })();

      return {
        title: titleFromDocument,
        price,
        styleNumber,
        pageText: bodyText.slice(0, 24000),
        domImages,
        metaDescription,
        compositionFromDom,
        descriptionFromDom,
      };
    });

    const styleNumber = info.styleNumber || normalized.styleNumber || normalized.input || reference;

    // Determine the landed colour id so we only keep imagery for that variant.
    // Mango colour ids appear as the middle segment of Scene7 URLs
    // (https://media.mango.com/is/image/punto/27005945-85-002 → "85")
    // and as ?colorId= / ?c= in product URLs.
    const landedUrl = page.url();
    let activeColorId = '';
    const colorIdFromQuery = landedUrl.match(/[?&](?:colorId|c|color)=([^&#]+)/i);
    if (colorIdFromQuery) activeColorId = colorIdFromQuery[1];
    if (!activeColorId) {
      // Pick the most common middle-segment colour across DOM Scene7 URLs
      const counts = new Map();
      for (const u of (info.domImages || [])) {
        const m = String(u || '').match(/media\.mango\.com\/is\/image\/punto\/\d+-(\d{1,3})-/i);
        if (m) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
      }
      let best = '';
      let bestCount = 0;
      for (const [cid, n] of counts.entries()) {
        if (n > bestCount) { best = cid; bestCount = n; }
      }
      activeColorId = best;
    }
    if (activeColorId) emitLog(`    🎨 Mango active colorId: ${activeColorId}`, 'info');

    const matchesActiveColor = (url) => {
      if (!activeColorId) return true; // no signal — keep
      const m = String(url || '').match(/(?:media\.mango\.com\/is\/image\/punto\/)\d+-(\d{1,3})-/i);
      if (m) return m[1] === activeColorId;
      // For non-Scene7 hosts, allow through (filename-based filter applies)
      return true;
    };

    const allCaptured = [...capturedUrls];
    const allDom = (info.domImages || []).map((item) => cleanImageUrl(item));
    // Preserve DOM order so buildMangoImageMap can use first=F / last=B.
    // DOM-discovered URLs are listed in the order Mango renders them in the
    // PDP gallery, which is the only reliable signal for front/back.
    const ordered = [];
    const seen = new Set();
    const pushIfNew = (u) => {
      if (!u || seen.has(u)) return;
      seen.add(u);
      ordered.push(u);
    };
    for (const u of allDom) {
      if (isRelevantMangoProductImage(u, styleNumber) && matchesActiveColor(u)) pushIfNew(u);
    }
    for (const u of allCaptured) {
      if (isRelevantMangoProductImage(u, styleNumber) && matchesActiveColor(u)) pushIfNew(u);
    }
    const imageUrls = ordered;

    // Classify each image as flat-lay (white background) vs lifestyle (model
    // shot) by sampling the four corners + edge midpoints. Flat-lay shots
    // have all sampled pixels close to white. We do this in-page so we
    // reuse the browser's image cache and benefit from CORS-friendly
    // media.mango.com responses (Scene7 sets Access-Control-Allow-Origin: *).
    const flatLayFlags = imageUrls.length
      ? await page.evaluate(async (urls) => {
          const isWhitePixel = (r, g, b) => r > 235 && g > 235 && b > 235;
          const sample = async (url) => {
            try {
              const img = new Image();
              img.crossOrigin = 'anonymous';
              await new Promise((res, rej) => {
                img.onload = res;
                img.onerror = rej;
                img.src = url;
              });
              const w = img.naturalWidth || img.width;
              const h = img.naturalHeight || img.height;
              if (!w || !h) return false;
              const canvas = document.createElement('canvas');
              canvas.width = w;
              canvas.height = h;
              const ctx = canvas.getContext('2d');
              if (!ctx) return false;
              ctx.drawImage(img, 0, 0);
              // Sample 8 points around the perimeter
              const pts = [
                [2, 2], [w - 3, 2], [2, h - 3], [w - 3, h - 3],
                [Math.floor(w / 2), 2], [Math.floor(w / 2), h - 3],
                [2, Math.floor(h / 2)], [w - 3, Math.floor(h / 2)],
              ];
              let whiteCount = 0;
              for (const [x, y] of pts) {
                try {
                  const px = ctx.getImageData(x, y, 1, 1).data;
                  if (isWhitePixel(px[0], px[1], px[2])) whiteCount += 1;
                } catch { return false; }
              }
              // Need at least 7/8 white perimeter samples to call it flat lay
              return whiteCount >= 7;
            } catch {
              return false;
            }
          };
          const flags = [];
          for (const url of urls) {
            // eslint-disable-next-line no-await-in-loop
            flags.push(await sample(url));
          }
          return flags;
        }, imageUrls).catch(() => imageUrls.map(() => false))
      : [];

    const flatLayCount = flatLayFlags.filter(Boolean).length;
    emitLog(`    🧺 Mango flat-lay detected: ${flatLayCount} / ${imageUrls.length} images`, 'info');

    if (imageUrls.length === 0) {
      const sampleCaptured = allCaptured.slice(0, 3).join(' | ') || '(none)';
      const sampleDom = allDom.slice(0, 3).join(' | ') || '(none)';
      emitLog(`    🔬 Mango image debug — captured: ${sampleCaptured}`, 'info');
      emitLog(`    🔬 Mango image debug — DOM: ${sampleDom}`, 'info');
    }

    const compositionText = extractMangoFabricComposition(info.compositionFromDom || '');
    const description = String(info.descriptionFromDom || info.metaDescription || '').trim();

    const productName = info.title || `Mango ${styleNumber}`;
    emitInditexScrapeResult({
      emitLog,
      brand: 'Mango',
      requestedReference: reference,
      actualStyleNumber: info.styleNumber || styleNumber,
      productName,
      imageCount: imageUrls.length,
      hasDescription: Boolean(description),
      hasComposition: Boolean(compositionText),
    });

    return {
      styleNumber,
      productId: styleNumber,
      brand: 'Mango',
      name: productName,
      price: info.price || '',
      colorRef: '',
      description,
      composition: compositionText
        ? { outerShell: null, lining: null, other: compositionText }
        : null,
      url: normalized.url,
      imageUrls,
      flatLayFlags,
      pageText: info.pageText || '',
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function runMangoScraper(config, emitLog, emitProgress, taskController, previewBridge = null) {
  let { styleNumbers, excelPath, outputDir, downloadConcurrency } = config;
  styleNumbers = normalizeManualStyleNumbers(styleNumbers);
  const ensureActive = () => taskController?.throwIfCancelled?.();
  let browser = null;

  if (excelPath) {
    try {
      ensureActive();
      emitLog(`Reading Excel file: ${excelPath}`, 'info');
      const wb = XLSX.readFile(excelPath);
      const ws = wb.Sheets[wb.SheetNames[0]];
      styleNumbers = [];
      const range = XLSX.utils.decode_range(ws['!ref'] || 'A1:B1');
      for (let row = 1; row <= range.e.r; row += 1) {
        const cellAddress = XLSX.utils.encode_cell({ r: row, c: 1 });
        const cell = ws[cellAddress];
        if (cell) {
          const displayValue = String(cell.w ?? cell.v ?? '').trim();
          if (displayValue) {
            styleNumbers.push(displayValue);
            emitLog(`📥 Excel row ${row + 1} column B: "${displayValue}"`, 'info');
          }
        }
      }
      emitLog(`Loaded ${styleNumbers.length} Mango style numbers from Excel.`, 'success');
    } catch (error) {
      throw new Error(`Excel parse failed: ${error.message}`);
    }
  }

  ensureActive();
  if (!styleNumbers || styleNumbers.length === 0) {
    throw new Error('No Mango style numbers were found. Put the SKU values in column B or enter them manually.');
  }

  const targetDir = !outputDir || outputDir === '未选择' ? path.join(app.getPath('desktop'), 'Mango') : outputDir;
  fs.mkdirSync(targetDir, { recursive: true });

  emitLog(`📁 Output directory: ${targetDir}`, 'info');
  emitLog('🌐 Launching the Mango scraper session...', 'info');

  let executablePath = findChromePath();
  if (!executablePath) {
    emitLog('⬇️ No local Chrome was found. Downloading a managed Chrome runtime for GS Bot...', 'warning');
    const chromeInstall = await ensureChromeRuntimeAvailable((payload) => {
      if (payload?.status) {
        emitLog(payload.status, payload.phase === 'complete' ? 'success' : 'info');
      }
    });
    if (!chromeInstall?.success) {
      throw new Error(chromeInstall?.error || 'Chrome download failed.');
    }
    executablePath = chromeInstall.executablePath;
  }

  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: false,
      userDataDir: getMangoSessionDir(),
      args: antiDetection.getRetailLaunchArgs(),
      ignoreDefaultArgs: ['--enable-automation'],
      defaultViewport: null,
    });
    previewBridge?.attachToBrowser(browser);

    taskController?.onCancel(() => {
      if (browser && browser.isConnected()) {
        browser.close().catch(() => {});
      }
    });

    const products = [];
    let currentProgress = 5;
    emitProgress(currentProgress);
    const totalItems = styleNumbers.length;

    const processReference = async (reference) => {
      try {
        ensureActive();
        return await scrapeMangoProduct(browser, reference, emitLog, ensureActive);
      } catch (error) {
        if (isCancellationError(error) || taskController?.cancelled) {
          throw new TaskCancelledError();
        }
        return {
          styleNumber: reference,
          productId: reference,
          url: '',
          error: error.message || 'Unknown error',
          imageUrls: [],
        };
      }
    };

    emitLog(`🚀 Mango: ${totalItems} 个款号 (打开 mango.com 首页，直接在搜索框输入款号)`, 'warning');
    for (let i = 0; i < totalItems; i += 1) {
      ensureActive();
      const reference = styleNumbers[i];
      emitLog(`🎯 Mango input raw: "${reference}" -> Search ${normalizeMangoReference(reference).compactDigits}`, 'info');
      emitLog(`🔄 Processing Mango ${i + 1}/${totalItems}: ${reference}`, 'warning');
      const result = await processReference(reference);
      products.push(result);
      currentProgress = 5 + Math.round(((i + 1) / totalItems) * 45);
      emitProgress(currentProgress);
      if (i < totalItems - 1) {
        await antiDetection.randomDelay(1500, 2500);
      }
    }

    currentProgress = 50;
    emitProgress(currentProgress);

    ensureActive();
    emitLog('🌐 Mango page extraction complete. Preparing image downloads...', 'warning');

    const successProducts = products.filter((product) => product.imageUrls && product.imageUrls.length > 0);
    const failedProducts = products.filter((product) => !product.imageUrls || product.imageUrls.length === 0);
    const totalImages = successProducts.reduce((sum, product) => sum + product.imageUrls.length, 0);

    emitLog(`📊 Mango summary: ${successProducts.length} styles succeeded, ${failedProducts.length} styles failed, ${totalImages} images collected.`, 'info');

    if (failedProducts.length > 0) {
      failedProducts.forEach((product) => {
        emitLog(`    ❌ ${product.styleNumber} - ${product.error || 'No product images found'}`, 'error');
        emitLog(`       👉 建议人工下载: ${buildMangoManualSearchUrl(product.styleNumber)}`, 'warning');
      });
    }

    const allTasks = [];
    for (const product of successProducts) {
      ensureActive();
      const cleanStyleNumber = sanitizeFileSegment(String(product.productId || product.styleNumber || '').replace(/\//g, '-'), 'mango-item');
      const styleDir = path.join(targetDir, cleanStyleNumber);
      fs.mkdirSync(styleDir, { recursive: true });

      const classified = buildMangoImageMap(product.imageUrls, product.flatLayFlags);

      for (const [label, imgUrl] of Object.entries(classified)) {
        const ext = getUrlExtension(imgUrl, '.jpg');
        const filename = `${cleanStyleNumber}_${label}${ext}`;
        const filePath = path.join(styleDir, filename);
        allTasks.push(() => {
          ensureActive();
          return downloadFile(imgUrl, filePath, {
            headers: {
              Referer: product.url || 'https://shop.mango.com/',
              'User-Agent': 'Mozilla/5.0',
            },
            timeoutMs: 45000,
          })
            .then((size) => {
              if (size) {
                emitLog(`    ⬇️ [saved] ${filename} (${size.toFixed(1)} KB)`);
              }
            })
            .catch((error) => {
              emitLog(`    ❌ [failed] ${filename}: ${error.message}`, 'error');
            });
        });
      }

      const infoData = {
        styleNumber: product.productId || product.styleNumber,
        brand: product.brand || 'Mango',
        name: product.name,
        price: product.price,
        colorRef: product.colorRef,
        description: product.description || '',
        composition: product.composition || null,
        url: product.url,
        images: classified,
      };
      const infoPath = path.join(styleDir, `${cleanStyleNumber}_info.json`);
      fs.writeFileSync(infoPath, JSON.stringify(infoData, null, 2), 'utf-8');
      emitLog(`📄 Saved product metadata: ${cleanStyleNumber}_info.json`, 'success');
    }

    emitLog(`📦 Downloading ${allTasks.length} Mango images with ${downloadConcurrency} worker(s)...`, 'info');

    let completedTasks = 0;
    const tasksWithProgress = allTasks.map((task) => async () => {
      ensureActive();
      await task();
      completedTasks += 1;
      emitProgress(50 + Math.round((completedTasks / Math.max(allTasks.length, 1)) * 50));
    });

    if (tasksWithProgress.length > 0) {
      await parallelLimit(tasksWithProgress, downloadConcurrency);
    }

    emitProgress(100);
    const summary = products.map((product) => ({
      styleNumber: product.productId || product.styleNumber,
      brand: product.brand || 'Mango',
      name: product.name,
      price: product.price,
      colorRef: product.colorRef,
      description: product.description || '',
      composition: product.composition || null,
      images: product.imageUrls ? product.imageUrls.length : 0,
      error: product.error || null,
    }));
    const summaryPath = path.join(targetDir, 'summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf-8');
    emitLog('📊 Saved summary.json', 'success');

    if (failedProducts.length > 0) {
      const failedSummary = failedProducts.map((product) => ({
        styleNumber: product.productId || product.styleNumber,
        error: product.error || 'No product images found',
      }));
      fs.writeFileSync(path.join(targetDir, 'failed_styles.json'), JSON.stringify(failedSummary, null, 2), 'utf-8');
      fs.writeFileSync(
        path.join(targetDir, 'failed_styles.txt'),
        failedSummary.map((item) => `${item.styleNumber}\t${item.error}`).join('\n'),
        'utf-8',
      );
      emitLog('📄 Saved failed_styles.json', 'success');
    }

    emitLog(`🎉 Mango scraping finished. Files saved to: ${targetDir}`, 'success');
  } finally {
    if (browser && browser.isConnected()) {
      await browser.close().catch(() => {});
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Reserved (reserved.com) — typed search on the GB/EN storefront, click first
// product card, scrape gallery + name + price + description + composition
// behind the collapsed "Material and care" tab.
// ════════════════════════════════════════════════════════════════════════════

const RESERVED_HOME_URL = 'https://www.reserved.com/gb/en/';
const buildReservedManualSearchUrl = (q) =>
  `https://www.reserved.com/gb/en/?search=${encodeURIComponent(String(q || '').trim())}`;

function normalizeReservedReference(reference = '') {
  const input = String(reference || '').trim();
  // SKUs look like WK490-39M, 2511N-39M, 371BD-39M — alphanumeric with a
  // dash. Slug form on the PDP URL is lower-case (".../wk490-39m").
  return {
    input,
    sku: input.toUpperCase(),
    skuLower: input.toLowerCase(),
  };
}

function isLikelyReservedProductImage(url = '') {
  const value = String(url || '').toLowerCase();
  if (!value) return false;
  if (!/\.(?:jpe?g|png|webp)(?:\?|$)/i.test(value)) return false;
  // Reserved serves PDP imagery from reserved.com / lpp.com CDNs. Cover the
  // ones we see in the wild and generic /assets/, /media/, /products/.
  return value.includes('reserved.com/')
    || value.includes('lpp.com/')
    || value.includes('lpp.pl/')
    || value.includes('reservedstatic')
    || /\/media\/.+\/products?\//i.test(value)
    || /\/assets\/products?\//i.test(value);
}

function isRelevantReservedProductImage(url = '', skuLower = '') {
  if (!isLikelyReservedProductImage(url)) return false;
  const value = String(url || '').toLowerCase();
  if (!skuLower) return true;
  // Reserved image filenames usually embed the SKU (e.g. wk490-39m_top.jpg).
  // Accept if either the full SKU OR the prefix before the first dash appears
  // in the URL — that prefix is the style code shared across colour variants.
  const stylePrefix = skuLower.split('-')[0];
  return value.includes(skuLower)
    || (stylePrefix.length >= 4 && value.includes(stylePrefix));
}

function parseReservedImageMeta(url = '', fallbackIndex = 0) {
  const filename = path.basename(String(url || '').split('?')[0]).toLowerCase();
  if (/_b(?:\.|_)|_back/.test(filename)) {
    return { kind: 'back', order: 999, sequence: 99 };
  }
  if (/_d\d*(?:\.|_)|_detail/.test(filename)) {
    return { kind: 'detail', order: 400 + fallbackIndex, sequence: fallbackIndex };
  }
  // Try numeric suffix like _01 / -02 / _3 (some Reserved imagery)
  const numMatch = filename.match(/[-_](\d{1,2})(?:[._]|$)/);
  if (numMatch) {
    const seq = Number.parseInt(numMatch[1], 10);
    return { kind: 'shot', order: seq, sequence: seq };
  }
  return { kind: 'misc', order: 900 + fallbackIndex, sequence: fallbackIndex };
}

function getReservedImageOrder(url = '', fallbackIndex = 0) {
  return parseReservedImageMeta(url, fallbackIndex).order;
}

function buildReservedImageMap(imageUrls = []) {
  const list = [...imageUrls];
  const map = {};
  if (list.length === 0) return map;
  if (list.length === 1) {
    map.F = list[0];
    return map;
  }
  map.F = list[0];
  map.B = list[list.length - 1];
  let extra = 1;
  for (let i = 1; i < list.length - 1; i += 1) {
    map[String(extra).padStart(2, '0')] = list[i];
    extra += 1;
  }
  return map;
}

function extractReservedFabricComposition(rawText = '') {
  const text = String(rawText || '').trim();
  if (!text) return '';
  const fibreRegex = /\d+\s*%\s*(?:cotton|polyester|elastane|viscose|linen|wool|silk|nylon|polyamide|acrylic|cashmere|leather|lyocell|modal|rayon|spandex|tencel|hemp|cupro|acetate|alpaca|mohair|ramie|jute|recycled|organic)/i;
  const segments = text
    .split(/[\r\n]+|(?<=[.])\s+|·|•|;/)
    .map((seg) => seg.trim())
    .filter(Boolean);
  const seen = new Set();
  const lines = [];
  for (const seg of segments) {
    if (!fibreRegex.test(seg)) continue;
    const cleaned = seg.replace(/\s+/g, ' ').trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(cleaned);
  }
  return lines.join('\n');
}

function cleanReservedDescription(rawText = '') {
  const text = String(rawText || '').trim();
  if (!text) return '';

  // Reserved descriptions interleave the product copy with model lines such as
  //   "Model is 1.78 m tall and wears size S"
  //   "The model is 176 cm tall and is wearing size M"
  // plus manufacturer / address / email boilerplate. We drop those but PRESERVE
  // the line structure so the heading, intro sentence and feature bullets stay
  // on separate lines (matching how it reads on the site).

  const manufacturerRegex = /^\s*(?:manufacturer|producer|brand\s+owner|importer|distributor)\s*[:\-]/i;
  const addressRegex = /\b(?:ul\.|ulica|str\.|street|avenue|ave\.|łąkowa|gdańsk|gdansk|sp\.\s*z\s*o\.o|s\.a\.|ltd\.|gmbh|inc\.)\b/i;
  const emailRegex = /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/i;

  const heightRegex = /\bmodel(?:'s)?\b[^.]*?\b(?:height|tall|wears?|wearing|measur|size|is\s+\d|chest|waist|hips?)\b/i;
  const measurementRegex = /\b\d+(?:[.,]\d+)?\s*(?:cm|m|mm|inch|inches|feet|ft|″|′)\b/i;
  const wearingSizeRegex = /\bwear(?:s|ing)\s+size\b/i;

  const looksLikeModelLine = (segment) => {
    const s = String(segment || '').trim();
    if (!s) return true;
    if (manufacturerRegex.test(s)) return true;
    if (addressRegex.test(s)) return true;
    if (emailRegex.test(s)) return true;
    if (heightRegex.test(s)) return true;
    if (wearingSizeRegex.test(s) && /\b(?:model|she|he|they)\b/i.test(s)) return true;
    if (measurementRegex.test(s) && /\b(?:model|tall|wear|size|height)\b/i.test(s)) return true;
    return false;
  };

  // Split on hard line breaks first (preserve them), then within each line
  // also split on sentence boundaries to catch inline model fragments.
  const rawLines = text.split(/[\n\r]+/).map((s) => s.trim()).filter(Boolean);
  const keptLines = [];
  for (const line of rawLines) {
    if (looksLikeModelLine(line)) continue;
    // Cut an inline " ... Model is 1.78 m tall ..." trailing fragment.
    const inlineMatch = line.match(/(.*?)\b(?:the\s+)?model(?:'s)?\s+is\b/i);
    if (inlineMatch && inlineMatch[1] && inlineMatch[1].trim().length >= 10) {
      keptLines.push(inlineMatch[1].trim().replace(/[\s,;:.\-]+$/, ''));
      continue;
    }
    keptLines.push(line);
  }
  return keptLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function dismissCommonReservedPopups(page) {
  // Pass 1: try well-known cookie/consent selectors.
  const selectors = [
    '#onetrust-accept-btn-handler',
    '#cookiescript_accept',
    'button[id*="accept" i][id*="cookie" i]',
    'button[id*="accept" i][id*="consent" i]',
    'button[aria-label*="accept" i]',
    'button[aria-label*="close" i]',
    'button[data-testid*="accept" i]',
    'button[data-testid*="close" i]',
    '[class*="cookie" i] button',
    '[class*="consent" i] button',
  ];
  for (const sel of selectors) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click({ delay: 60 }).catch(() => {});
        await antiDetection.randomDelay(300, 600);
      }
    } catch { /* noop */ }
  }

  // Pass 2: text-based fallback — find any visible button whose text contains
  // "Accept" / "Agree" / "Okay" / "Allow" / "Got it" inside likely cookie banners.
  try {
    await page.evaluate(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) return false;
        const s = window.getComputedStyle(el);
        return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
      };
      const textRegex = /^\s*(?:accept(?:\s+all)?|agree(?:\s+all)?|okay|ok|got\s+it|allow(?:\s+all)?|i\s+agree|continue|close)\s*$/i;
      const buttons = [...document.querySelectorAll('button, [role="button"], a')];
      for (const btn of buttons) {
        if (!isVisible(btn)) continue;
        const text = String(btn.textContent || '').trim();
        if (text.length < 30 && textRegex.test(text)) {
          try { btn.click(); } catch { /* noop */ }
        }
      }
    });
  } catch { /* noop */ }
  await antiDetection.randomDelay(400, 700);
}

async function openReservedSearchOverlay(page) {
  // Reserved exposes the search trigger as a visible text button labelled
  // "SEARCH" in the top navigation (not a magnifier icon). The label may be
  // an inner <span> rather than aria-label, so we have to walk visible text.
  const directSelectors = [
    'button[aria-label*="search" i]',
    'a[href*="search" i]',
    '[data-testid*="search" i] button',
    '[data-testid*="search-button" i]',
    'header button[class*="search" i]',
    'header [class*="search" i] button',
    'button[class*="search" i]',
    'header a[class*="search" i]',
  ];
  for (const sel of directSelectors) {
    try {
      const handle = await page.$(sel);
      if (handle) {
        await handle.click({ delay: 50 }).catch(() => {});
        return true;
      }
    } catch { /* noop */ }
  }
  return page.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return false;
      const s = window.getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
    };
    // 1. Look for any clickable element whose attributes mention "search".
    const candidates = [...document.querySelectorAll('button, a[href], [role="button"]')];
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const haystack = [
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
        el.getAttribute('data-testid'),
        el.getAttribute('data-test'),
        el.className,
        el.id,
      ].join(' ').toLowerCase();
      if (/\bsearch\b/.test(haystack)) {
        el.click();
        return true;
      }
    }
    // 2. Reserved labels its search trigger with the literal visible word
    //    "SEARCH" (sometimes lowercase) — walk visible text content.
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const text = String(el.textContent || '').trim();
      if (text.length < 30 && /^\s*search\s*$/i.test(text)) {
        el.click();
        return true;
      }
    }
    // 3. Last-resort: keyboard shortcut "/" opens a search overlay on many
    //    modern shopfronts including Reserved.
    try {
      const event = new KeyboardEvent('keydown', { key: '/', code: 'Slash', bubbles: true });
      document.dispatchEvent(event);
    } catch { /* noop */ }
    return false;
  });
}

async function findVisibleReservedSearchInput(page) {
  return page.evaluateHandle(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 6) return false;
      const s = window.getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
    };
    const inputs = [...document.querySelectorAll(
      'input[type="search"], input[type="text"], input:not([type]), textarea, [contenteditable="true"]',
    )].filter(isVisible);
    const ranked = inputs.find((el) => {
      const haystack = [
        el.getAttribute('type'),
        el.getAttribute('name'),
        el.getAttribute('placeholder'),
        el.getAttribute('aria-label'),
        el.getAttribute('id'),
        el.getAttribute('data-testid'),
        el.className,
      ].join(' ').toLowerCase();
      return /search|query|keyword|term/i.test(haystack);
    });
    return ranked || inputs[0] || null;
  });
}

async function clickFirstReservedProductCard(page, emitLog, skuLower = '') {
  await antiDetection.randomDelay(900, 1400);
  const result = await page.evaluate((skuLowerRaw) => {
    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 30 || r.height < 30) return false;
      const s = window.getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
    };
    const skuLower = String(skuLowerRaw || '').toLowerCase();
    // Normalize SKU for matching: remove spaces and hyphens to catch
    // variations like "588KF-08M" vs "588KF08M" vs "588 KF 08 M".
    const skuCompact = skuLower.replace(/[\s-]/g, '');
    // Reserved PDP URLs look like /gb/en/some-slug-WK490-39M (lowercase) or
    // /gb/en/category/sub/slug-wk490-39m. We accept hrefs ending in -SKU.
    const productLinkRegex = /reserved\.com\/.+-[a-z0-9]+-[a-z0-9]+$/i;
    const scopeSelectors = [
      '[data-testid*="search-result" i]',
      '[data-testid*="product-list" i]',
      '[data-testid*="product-grid" i]',
      '[class*="search-result" i]',
      '[class*="searchResult" i]',
      '[class*="ProductList" i]',
      '[class*="product-list" i]',
      '[class*="ProductGrid" i]',
      '[class*="product-grid" i]',
      'main',
    ];
    let scope = null;
    for (const sel of scopeSelectors) {
      const candidate = document.querySelector(sel);
      if (candidate && candidate.querySelector('a[href]')) { scope = candidate; break; }
    }
    const root = scope || document;
    const anchors = [...root.querySelectorAll('a[href]')]
      .filter((a) => isVisible(a))
      .filter((a) => productLinkRegex.test((a.href || '').split('?')[0].split('#')[0]));
    if (!anchors.length) return { href: '', candidates: 0 };

    // Enhanced matching: check URL, card text content, data attributes,
    // and image alt/src. Reserved URLs use a different product code
    // (e.g. "080gp-99x") that doesn't contain the style number "588KF",
    // so URL-only matching misses valid products. We also scan the
    // card's visible text and data attributes for the style number.
    const cardMatchesSku = (anchor) => {
      if (!skuLower) return false;
      const href = (anchor.href || '').toLowerCase();
      const hrefCompact = href.replace(/[\s-]/g, '');
      // 1. URL contains the SKU (with or without surrounding hyphen)
      if (href.includes(`-${skuLower}`) || href.includes(skuLower)) return true;
      if (skuCompact && hrefCompact.includes(skuCompact)) return true;

      // 2. Walk up to the product card container and check text/attributes
      const card = anchor.closest('[class*="product" i]') ||
                   anchor.closest('[data-testid*="product" i]') ||
                   anchor.parentElement;
      if (card) {
        const cardText = (card.textContent || '').toLowerCase();
        const cardTextCompact = cardText.replace(/[\s-]/g, '');
        if (cardText.includes(skuLower) || (skuCompact && cardTextCompact.includes(skuCompact))) {
          return true;
        }
        // Check data attributes that might hold the style number
        const dataAttrs = ['data-sku', 'data-product-id', 'data-style',
                           'data-article', 'data-product-code', 'data-item-number',
                           'data-variant', 'data-product-sku'];
        for (const attr of dataAttrs) {
          const val = (card.getAttribute(attr) || '').toLowerCase();
          if (val && (val.includes(skuLower) ||
                      (skuCompact && val.replace(/[\s-]/g, '').includes(skuCompact)))) {
            return true;
          }
        }
        // Check image alt text and src (product images often encode the SKU)
        const imgs = card.querySelectorAll('img');
        for (const img of imgs) {
          const alt = (img.alt || '').toLowerCase();
          const src = (img.src || '').toLowerCase();
          if (alt.includes(skuLower) || src.includes(skuLower)) return true;
          if (skuCompact) {
            const altC = alt.replace(/[\s-]/g, '');
            const srcC = src.replace(/[\s-]/g, '');
            if (altC.includes(skuCompact) || srcC.includes(skuCompact)) return true;
          }
        }
      }
      return false;
    };

    let chosen = null;
    if (skuLower) {
      chosen = anchors.find(cardMatchesSku);
      if (!chosen) {
        // SKU specified but no product URL/text matched — do NOT fall back to
        // anchors[0]. Clicking a non-matching card always leads to
        // rejection and wastes a navigation round-trip. Return empty so
        // the caller tries the next variant or reports "not found".
        return { href: '', candidates: anchors.length, noMatch: true };
      }
    }
    if (!chosen) chosen = anchors[0];
    chosen.scrollIntoView({ behavior: 'instant', block: 'center' });
    try { chosen.click(); } catch { /* noop */ }
    return { href: chosen.href, candidates: anchors.length };
  }, skuLower);

  if (emitLog) {
    if (result?.noMatch) {
      emitLog(`    🧭 Reserved card click → candidates=${result?.candidates ?? 0}, none matched SKU "${skuLower}"`, 'info');
    } else {
      emitLog(`    🧭 Reserved card click → candidates=${result?.candidates ?? 0}`, 'info');
    }
  }
  const clickedHref = result?.href || '';
  if (!clickedHref) return '';

  emitLog(`    🖱️ Clicked Reserved search result card → ${clickedHref.split('/').slice(-1)[0]}`, 'info');
  await Promise.race([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null),
    page.waitForFunction((before) => location.href !== before, { timeout: 20000, polling: 400 }, page.url()).catch(() => null),
  ]);
  await antiDetection.randomDelay(1400, 2200);
  return page.url();
}

async function searchReservedByTyping(page, query, emitLog, ensureActive) {
  emitLog(`    🔍 Searching Reserved by typing "${query}"…`, 'info');
  try {
    await page.goto(RESERVED_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await dismissCommonReservedPopups(page);
    await antiDetection.randomDelay(1500, 2200);
    ensureActive();

    emitLog('    🔎 Opening Reserved search overlay…', 'info');
    let opened = await openReservedSearchOverlay(page);
    if (!opened) {
      // Header may not be hydrated yet on a cold load — wait briefly and
      // retry a couple of times. Then move on; the input may still be there
      // even if our click did not register.
      for (let attempt = 1; attempt <= 3 && !opened; attempt += 1) {
        emitLog(`    ⏳ Reserved search button not ready; waiting for header to hydrate (attempt ${attempt}/3)…`, 'info');
        await antiDetection.randomDelay(1500, 2200);
        opened = await openReservedSearchOverlay(page);
      }
    }
    await antiDetection.randomDelay(1100, 1700);
    ensureActive();

    // Wait up to 12s for *any* visible text input to mount — the search
    // overlay slides in with an animation, so 1-2s isn't always enough.
    let inputHandle = null;
    let inputElement = null;
    try {
      await page.waitForFunction(() => {
        const isVisible = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          if (r.width < 20 || r.height < 6) return false;
          const s = window.getComputedStyle(el);
          return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
        };
        const inputs = [...document.querySelectorAll(
          'input[type="search"], input[type="text"], input:not([type]), textarea, [contenteditable="true"]',
        )];
        return inputs.some(isVisible);
      }, { timeout: 12000, polling: 350 });
      inputHandle = await findVisibleReservedSearchInput(page);
      inputElement = inputHandle ? inputHandle.asElement() : null;
    } catch { /* noop */ }

    if (!inputElement) {
      emitLog('    🔁 Reserved search input not visible yet; reopening overlay and waiting longer…', 'info');
      await openReservedSearchOverlay(page).catch(() => false);
      await antiDetection.randomDelay(2000, 3000);
      try {
        await page.waitForFunction(() => {
          const inputs = [...document.querySelectorAll('input[type="search"], input[type="text"], input:not([type]), textarea')];
          return inputs.some((el) => {
            const r = el.getBoundingClientRect();
            const s = window.getComputedStyle(el);
            return r.width >= 20 && r.height >= 6 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
          });
        }, { timeout: 10000, polling: 350 });
        inputHandle = await findVisibleReservedSearchInput(page);
        inputElement = inputHandle ? inputHandle.asElement() : null;
      } catch { /* noop */ }
    }
    if (!inputElement) {
      emitLog('    ⚠️ Reserved search input did not appear; giving up.', 'warning');
      return '';
    }

    try { await inputElement.click({ delay: 80 }); }
    catch { await page.evaluate((el) => el.focus(), inputElement).catch(() => {}); }
    await antiDetection.randomDelay(300, 600);

    emitLog(`    ⌨️ Typing Reserved search "${query}" via DOM write…`, 'info');
    await writeSearchValueViaDOM(page, inputElement, query, emitLog, 'Reserved');

    // Verify the input actually contains the query. Reserved's React
    // controlled input sometimes silently reverts the value after a
    // programmatic setter, leaving the search box visually empty. If we
    // detect that, fall back to character-by-character keyboard typing
    // which Reserved's React store reliably picks up.
    const inputHasValue = await page.evaluate((el, q) => {
      const v = String(el?.value || '').trim().toLowerCase();
      return v.length > 0 && v.includes(String(q || '').toLowerCase());
    }, inputElement, query).catch(() => true);

    if (!inputHasValue) {
      emitLog('    🔁 Reserved search input reverted to empty; retrying with keyboard typing…', 'info');
      // Focus again and clear any stale selection
      try { await inputElement.click({ delay: 60 }); }
      catch { await page.evaluate((el) => el.focus(), inputElement).catch(() => {}); }
      await antiDetection.randomDelay(200, 400);
      // Select-all + delete to clear, then type the query char by char
      try {
        await page.evaluate((el) => {
          try { el.select?.(); } catch { /* noop */ }
        }, inputElement).catch(() => {});
        await page.keyboard.press('Backspace').catch(() => {});
      } catch { /* noop */ }
      try {
        await page.keyboard.type(String(query || ''), { delay: 80 });
      } catch (err) {
        emitLog(`    ⚠️ Reserved keyboard typing failed: ${err.message}`, 'warning');
      }
      await antiDetection.randomDelay(500, 900);
    }

    // Submit the search by pressing Enter on the real keyboard (Puppeteer
    // synthesizes a trusted event that Reserved's keydown handler honors;
    // dispatchEvent-derived Enter events are not trusted and may be ignored).
    try {
      await page.keyboard.press('Enter').catch(() => {});
    } catch { /* noop */ }

    emitLog('    ⏳ Waiting for Reserved search results…', 'info');
    const skuLower = String(query || '').toLowerCase();
    // Reserved often shows a transient "no results" / loading state for
    // several seconds before the Algolia-backed grid actually renders. Wait
    // generously (up to 40 s) and poll for either a navigation OR for at
    // least one product anchor mentioning the SKU (or matching the slug
    // pattern). Then add a small settle delay so lazy product cards stop
    // being swapped in/out during the click.
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => null),
      page.waitForFunction(
        (sl) => {
          const anchors = [...document.querySelectorAll('a[href*="reserved.com"]')];
          const matches = anchors.filter((a) => {
            const href = (a.href || '').toLowerCase();
            return href.includes(sl)
              || /reserved\.com\/.+-[a-z0-9]+-[a-z0-9]+$/i.test(href.split('?')[0]);
          });
          // Require at least two matches so we don't pick up the "Most
          // popular" stub that Reserved renders while loading.
          return matches.length >= 2;
        },
        { timeout: 40000, polling: 600 },
        skuLower,
      ).catch(() => null),
    ]);
    await antiDetection.randomDelay(2200, 3600);
    ensureActive();

    // Reserved sometimes auto-redirects straight to the PDP when there's a
    // single match. Detect that case before scanning the grid.
    const landed = page.url();
    if (skuLower && landed.toLowerCase().includes(`-${skuLower}`)) {
      emitLog(`    ✅ Reserved auto-navigated to PDP for "${query}"`, 'info');
      return landed;
    }

    const clicked = await clickFirstReservedProductCard(page, emitLog, skuLower);
    if (clicked) {
      if (!skuLower || clicked.toLowerCase().includes(skuLower)) {
        return clicked;
      }
      emitLog(`    ⚠️ Reserved landed on a non-matching product (${clicked.split('/').slice(-1)[0]}); rejecting.`, 'warning');
      return '';
    }
  } catch (error) {
    ensureActive();
    emitLog(`    ⚠️ Reserved typed search failed: ${error.message}`, 'warning');
  }
  return '';
}

async function resolveReservedProductUrl(browser, reference, emitLog, ensureActive) {
  const normalized = normalizeReservedReference(reference);
  if (!normalized.sku) {
    throw new Error(`Empty Reserved reference: ${reference}`);
  }

  const page = await browser.newPage();
  await antiDetection.applyRetailBrowsingProfile(page);
  await page.setViewport(antiDetection.getRandomViewport());
  await page.bringToFront().catch(() => {});

  try {
    // Reserved URLs embed only the style prefix before the first dash, e.g.
    // "WK490-39M" → search "WK490", "9430N-09M" → search "9430N".
    // Searching the full SKU (including colour code) tends to return zero hits.
    const stylePart = normalized.sku.split('-')[0];
    const queries = [];
    if (stylePart && stylePart !== normalized.sku) {
      queries.push(stylePart);        // preferred: style prefix only
    }
    queries.push(normalized.input);   // original as typed (fallback)
    if (normalized.sku !== normalized.input) {
      queries.push(normalized.sku);   // upper-cased (fallback)
    }

    let resolvedUrl = '';
    for (const candidate of queries) {
      ensureActive();
      resolvedUrl = await searchReservedByTyping(page, candidate, emitLog, ensureActive);
      if (resolvedUrl) break;
      emitLog(`    ↪ Reserved "${candidate}" produced no real match; trying next variant…`, 'info');
    }
    return {
      url: resolvedUrl,
      sku: normalized.sku,
      skuLower: normalized.skuLower,
      input: normalized.input,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function scrapeReservedProduct(browser, reference, emitLog, ensureActive) {
  const normalized = await resolveReservedProductUrl(browser, reference, emitLog, ensureActive);
  if (!normalized.url) {
    throw new Error(`Product not found on Reserved for reference: ${reference}`);
  }

  // ── Firecrawl mode check ──────────────────────────────────────
  const currentMode = firecrawlService.getMode();
  if (currentMode === 'manual') {
    emitLog(` Reserved ${reference || ''} 手动模式: 使用 Firecrawl 抓取`, 'warning');
    try {
      ensureActive();
      const fcResult = await firecrawlFallback.tryFirecrawlFallback(normalized.url, {
        imageFilter: (imgUrl) => isLikelyReservedProductImage(imgUrl),
        urlNormalizer: (u) => u.split('?')[0],
        candidateIds: [String(reference || '').replace(/\D/g, '')],
        emitLog: (msg, type) => emitLog(`    ${msg}`, type),
      });

      // ─ Parse product text from Firecrawl HTML ────────────────────
      const html = fcResult.html || '';
      let name = '';
      let price = '';
      let description = '';
      let compositionText = null;

      const h1Match = html.match(/<h1[^>]*>(.*?)<\/h1>/is);
      if (h1Match) {
        name = h1Match[1].replace(/<[^>]+>/g, '').trim();
      }

      const priceMatch = html.match(/[€$£¥]([\d.,]+)/);
      if (priceMatch) {
        price = priceMatch[0];
      }

      const descPatterns = [
        /["']description["']?:\s*["']([^"']+)["']/i,
        /<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i,
      ];
      for (const pattern of descPatterns) {
        const m = html.match(pattern);
        if (m) {
          description = m[1].trim();
          break;
        }
      }

      const compPatterns = [
        /["']composition["']?:\s*["']([^"']+)["']/i,
        /["']materials["']?:\s*["']([^"']+)["']/i,
      ];
      for (const pattern of compPatterns) {
        const m = html.match(pattern);
        if (m) {
          compositionText = m[1].trim();
          break;
        }
      }

      const styleNumber = String(reference || '').replace(/\D/g, '');
      return {
        styleNumber,
        productId: styleNumber,
        brand: 'Reserved',
        name: name || `Reserved ${styleNumber}`,
        price,
        colorRef: '',
        description,
        composition: compositionText ? { outerShell: null, lining: null, other: compositionText } : null,
        url: normalized.url,
        imageUrls: fcResult.imageUrls,
        pageText: '',
        usedEngine: 'firecrawl',
      };
    } catch (fcError) {
      emitLog(`❌ Reserved ${reference || ''} Firecrawl 抓取失败: ${fcError.message}`, 'error');
      throw new Error(`Firecrawl failed: ${fcError.message}`);
    }
  }
  // ── End Firecrawl manual mode ───────────────────────────────────

  const page = await browser.newPage();
  await antiDetection.applyRetailBrowsingProfile(page);
  await page.setViewport(antiDetection.getRandomViewport());
  await page.bringToFront().catch(() => {});

  const capturedUrls = new Set();
  page.on('response', (resp) => {
    const reqUrl = cleanImageUrl(resp.url());
    if (isLikelyReservedProductImage(reqUrl)) capturedUrls.add(reqUrl);
  });

  try {
    ensureActive();
    await antiDetection.randomDelay(1000, 1800);
    await page.goto(normalized.url, { waitUntil: 'networkidle2', timeout: 60000 });
    await antiDetection.randomDelay(2200, 3200);
    await dismissCommonReservedPopups(page);

    await antiDetection.humanScroll(page, 2800);
    await antiDetection.randomDelay(700, 1100);

    // Expand the "Material and care" accordion to materialise composition text.
    const materialHandle = await page.evaluateHandle(() => {
      const headingRegex = /^\s*(?:material\s+and\s+care|materials?\s+and\s+care|materials?\s*&?\s*care|composition|composition\s+and\s+care)\s*$/i;
      const candidates = [...document.querySelectorAll('button, summary, [role="button"], h2, h3, h4, span, div')];
      const match = candidates.find((el) => {
        const text = String(el.textContent || '').trim();
        return text.length < 80 && headingRegex.test(text);
      });
      if (!match) return null;
      let cursor = match;
      for (let depth = 0; depth < 5 && cursor; depth += 1) {
        if (cursor.matches('button, summary, [role="button"], details')) return cursor;
        cursor = cursor.parentElement;
      }
      return match;
    }).catch(() => null);

    const materialElement = materialHandle ? materialHandle.asElement() : null;
    if (materialElement) {
      await page.evaluate((el) => {
        try { el.scrollIntoView({ behavior: 'instant', block: 'center' }); } catch { /* noop */ }
      }, materialElement).catch(() => {});
      try {
        await materialElement.click({ delay: 60 });
      } catch {
        await page.evaluate((el) => el.click(), materialElement).catch(() => {});
      }
      await page.waitForFunction(
        () => /\d+\s*%\s*(?:cotton|polyester|elastane|viscose|linen|wool|silk|nylon|polyamide|acrylic|cashmere|lyocell|modal|rayon|spandex|tencel)/i.test(String(document.body?.innerText || '')),
        { timeout: 6000, polling: 300 },
      ).catch(() => {});
      await materialHandle.dispose().catch(() => {});
      emitLog('    🧶 Clicked Reserved Material and care accordion', 'info');
    } else {
      emitLog('    ⚠️ Reserved Material and care button not found in DOM', 'warning');
    }
    await antiDetection.randomDelay(700, 1100);

    // Expand the "Product description" section "More" button if present.
    const moreHandle = await page.evaluateHandle(() => {
      const descHeadingRe = /^\s*(?:product\s+description|description|details|product\s+details)\s*$/i;
      const allEls = [...document.querySelectorAll('button, [role="button"], a, span')];
      const moreBtn = allEls.find((el) => {
        const text = String(el.textContent || '').trim();
        if (!/^(?:more|show\s*more|read\s*more|see\s*more|view\s*more|\+\s*more|voir\s*plus|mehr|más|展开|更多)$/i.test(text)) return false;
        // Must be clickable-ish
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return false;
        let cursor = el.parentElement;
        for (let i = 0; i < 10 && cursor; i++, cursor = cursor.parentElement) {
          const headings = [...cursor.querySelectorAll('h1,h2,h3,h4,h5,h6,button,span,div,summary')];
          if (headings.some((h) => descHeadingRe.test(String(h.textContent || '').trim()))) return true;
        }
        return false;
      });
      return moreBtn || null;
    }).catch(() => null);

    const moreElement = moreHandle ? moreHandle.asElement() : null;
    if (moreElement) {
      await page.evaluate((el) => {
        try { el.scrollIntoView({ behavior: 'instant', block: 'center' }); } catch { /* noop */ }
      }, moreElement).catch(() => {});
      try {
        await moreElement.click({ delay: 60 });
      } catch {
        await page.evaluate((el) => el.click(), moreElement).catch(() => {});
      }
      await antiDetection.randomDelay(600, 900);
      await moreHandle.dispose().catch(() => {});
      emitLog('    📄 Clicked Reserved description "More" button', 'info');
    } else {
      // Fallback: click ANY visible "More"-type toggle near a description block,
      // since Reserved sometimes labels the section differently per locale.
      const clickedAny = await page.evaluate(() => {
        const moreRe = /^(?:more|show\s*more|read\s*more|see\s*more|view\s*more|\+\s*more|voir\s*plus|mehr|más|展开|更多)$/i;
        const els = [...document.querySelectorAll('button, [role="button"], a, span')];
        let clicked = false;
        for (const el of els) {
          const text = String(el.textContent || '').trim();
          if (!moreRe.test(text)) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 4 || r.height < 4) continue;
          try { el.click(); clicked = true; } catch { /* noop */ }
        }
        return clicked;
      }).catch(() => false);
      if (clickedAny) {
        emitLog('    📄 Clicked a generic Reserved "More" toggle (fallback)', 'info');
        await antiDetection.randomDelay(600, 900);
      }
    }
    await antiDetection.randomDelay(400, 700);

    const info = await page.evaluate(() => {
      const bodyText = String(document.body?.innerText || '');
      const titleFromDocument = String(document.title || '').split(' | ')[0].split(' - ')[0].trim();
      const domImages = [...document.querySelectorAll('img')]
        .map((img) => img.currentSrc || img.src || img.getAttribute('data-src') || '')
        .filter(Boolean);

      // Style number — try selectors, fall back to URL slug tail
      let styleNumber = '';
      const refSelectors = [
        '[itemprop="sku"]',
        '[data-testid*="sku" i]',
        '[data-testid*="reference" i]',
        '[class*="reference" i]',
        '[class*="sku" i]',
      ];
      for (const sel of refSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          const text = String(el.textContent || '').trim();
          const match = text.match(/[A-Z]{1,4}\d+[A-Z]?-\d+[A-Z]?/i);
          if (match) { styleNumber = match[0]; break; }
        }
      }
      if (!styleNumber) {
        const slugMatch = location.href.match(/-([A-Z0-9]+-[A-Z0-9]+)(?:[/?#]|$)/i);
        if (slugMatch) styleNumber = slugMatch[1];
      }

      // Price
      const priceSelectors = [
        '[itemprop="price"]',
        '[data-testid*="price" i]',
        '[class*="price" i]',
      ];
      let price = '';
      for (const sel of priceSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          const text = String(el.textContent || '').trim();
          if (/\d/.test(text) && /[€$£¥]|GBP|EUR|USD|PLN|CZK/i.test(text)) { price = text; break; }
        }
      }

      // Description: prefer JSON-LD, then on-page section, then meta tag
      const descriptionFromJsonLd = (() => {
        const blocks = [...document.querySelectorAll('script[type="application/ld+json"]')];
        for (const block of blocks) {
          try {
            const parsed = JSON.parse(String(block.textContent || '').trim() || '{}');
            const nodes = Array.isArray(parsed) ? parsed : [parsed];
            for (const node of nodes) {
              if (!node || typeof node !== 'object') continue;
              const type = node['@type'];
              const types = Array.isArray(type) ? type : [type];
              if (!types.some((t) => String(t || '').toLowerCase() === 'product')) continue;
              const desc = String(node.description || '').trim();
              if (desc.length >= 20) return desc;
            }
          } catch { /* skip */ }
        }
        return '';
      })();
      const descriptionFromDom = (() => {
        // Approach 1 (primary): walk the body innerText and grab the block
        // between "Description" and "Material and care" / "Size guide". After
        // the "More" button is clicked this contains the full bullet list.
        // We do this BEFORE JSON-LD because JSON-LD usually only has the
        // one-line intro, missing the feature bullets the user wants.
        const bodyText = String(document.body?.innerText || '');
        const descHeaderRe = /(?:^|\n)\s*(?:Product\s+)?[Dd]escription\s*\n/;
        const stopHeaderRe = /\n\s*(?:Material\s+and\s+care|Composition\s+and\s+care|Material\s*&\s*care|Size\s+guide|Sizing|Size\s+&\s+fit|Delivery|Shipping|Payment|Returns|Reviews|Recommendations|Complete\s+the\s+look|You\s+might\s+also\s+like|Similar\s+products)\s*\n/i;
        const descMatch = bodyText.match(descHeaderRe);
        let windowText = '';
        if (descMatch) {
          const start = (descMatch.index || 0) + descMatch[0].length;
          const remaining = bodyText.slice(start);
          const stopMatch = remaining.match(stopHeaderRe);
          const block = (stopMatch ? remaining.slice(0, stopMatch.index) : remaining).trim();
          const lines = block.split(/\n+/).map((s) => s.trim()).filter((line) => {
            if (!line) return false;
            // Drop a standalone "Less"/"More" toggle remnant
            if (/^(?:less|more|show\s*less|show\s*more|read\s*more)$/i.test(line)) return false;
            return true;
          });
          // Stop collecting once we hit a model-measurement line (everything
          // after it on Reserved is model/size noise).
          const cleaned = [];
          for (const line of lines) {
            if (/^(?:the\s+)?model\b/i.test(line) && /\b(?:cm|tall|wear|wearing|size|height|m\b)\b/i.test(line)) break;
            cleaned.push(line);
          }
          windowText = cleaned.slice(0, 25).join('\n').trim();
        }
        if (windowText && windowText.length >= 15) return windowText;

        // Approach 2: JSON-LD product description (intro only, but better than nothing)
        if (descriptionFromJsonLd) return descriptionFromJsonLd;

        // Approach 3: standard testid / itemprop selectors
        const passASelectors = [
          '[data-testid*="product-description" i]',
          '[data-testid*="description" i]',
          '[itemprop="description"]',
        ];
        for (const sel of passASelectors) {
          const elements = [...document.querySelectorAll(sel)];
          for (const el of elements) {
            const txt = String(el.textContent || '').trim();
            if (txt.length >= 20 && txt.length < 2400) return txt;
          }
        }

        // Approach 4: class-based paragraph selectors
        const passBSelectors = [
          'section[class*="description" i] p',
          'div[class*="description" i] p',
          'p[class*="description" i]',
          '[class*="product-details" i] p',
          '[class*="productDetails" i] p',
          '[class*="product-info" i] p',
        ];
        for (const sel of passBSelectors) {
          const elements = [...document.querySelectorAll(sel)];
          for (const el of elements) {
            const txt = String(el.textContent || '').trim();
            if (txt.length >= 20 && txt.length < 2400) return txt;
          }
        }

        return '';
      })();
      const metaDescription = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';

      const compositionFromDom = (() => {
        const headingRegex = /^\s*(?:material\s+and\s+care|materials?\s+and\s+care|materials?\s*&?\s*care|composition\s+and\s+care|composition)\s*$/i;
        const fibreRegex = /\d+\s*%\s*(?:cotton|polyester|elastane|viscose|linen|wool|silk|nylon|polyamide|acrylic|cashmere|leather|lyocell|modal|rayon|spandex|tencel|hemp|cupro|acetate|alpaca|mohair|ramie|jute|recycled|organic)/i;
        const allElements = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6, div, span, button, summary, p')];
        const heading = allElements.find((el) => {
          const text = String(el.textContent || '').trim();
          return text.length < 80 && headingRegex.test(text);
        });
        const tryReadFrom = (root) => {
          if (!root) return '';
          const text = String(root.innerText || root.textContent || '').trim();
          return text.length > 4000 ? text.slice(0, 4000) : text;
        };
        if (heading) {
          let bestFromAncestors = '';
          let cursor = heading;
          for (let depth = 0; depth < 8 && cursor && cursor.parentElement; depth += 1) {
            const candidate = cursor.parentElement;
            const t = String(candidate.innerText || '').trim();
            if (t.length > 3000) break;
            if (fibreRegex.test(t)) bestFromAncestors = tryReadFrom(candidate);
            cursor = candidate;
          }
          if (bestFromAncestors) return bestFromAncestors;
          let sib = heading.nextElementSibling || heading.parentElement?.nextElementSibling;
          for (let i = 0; i < 4 && sib; i += 1) {
            const t = String(sib.innerText || '').trim();
            if (fibreRegex.test(t)) return tryReadFrom(sib);
            sib = sib.nextElementSibling;
          }
        }
        const pctNodes = [...document.querySelectorAll('div, section, ul, li, p, span')]
          .filter((el) => {
            const t = String(el.innerText || el.textContent || '').trim();
            return t.length > 0 && t.length < 800 && fibreRegex.test(t);
          });
        if (pctNodes.length) {
          const seen = new Set();
          const lines = [];
          for (const node of pctNodes) {
            const t = String(node.innerText || node.textContent || '').trim();
            if (!t || seen.has(t)) continue;
            seen.add(t);
            lines.push(t);
          }
          return lines.join('\n');
        }
        return '';
      })();

      return {
        title: titleFromDocument,
        price,
        styleNumber,
        pageText: bodyText.slice(0, 24000),
        domImages,
        metaDescription,
        compositionFromDom,
        descriptionFromDom,
      };
    });

    const sku = info.styleNumber || normalized.sku || reference;
    const skuLower = String(sku || '').toLowerCase();

    const allCaptured = [...capturedUrls];
    const allDom = (info.domImages || []).map((item) => cleanImageUrl(item));
    const ordered = [];
    const seen = new Set();
    const pushIfNew = (u) => {
      if (!u || seen.has(u)) return;
      seen.add(u);
      ordered.push(u);
    };
    for (const u of allDom) {
      if (isRelevantReservedProductImage(u, skuLower)) pushIfNew(u);
    }
    for (const u of allCaptured) {
      if (isRelevantReservedProductImage(u, skuLower)) pushIfNew(u);
    }
    const imageUrls = ordered;

    if (imageUrls.length === 0) {
      const sampleCaptured = allCaptured.slice(0, 3).join(' | ') || '(none)';
      const sampleDom = allDom.slice(0, 3).join(' | ') || '(none)';
      emitLog(`    🔬 Reserved image debug — captured: ${sampleCaptured}`, 'info');
      emitLog(`    🔬 Reserved image debug — DOM: ${sampleDom}`, 'info');
    }

    const compositionText = extractReservedFabricComposition(info.compositionFromDom || '');
    const rawDescription = String(info.descriptionFromDom || info.metaDescription || '').trim();
    const description = cleanReservedDescription(rawDescription);

    const productName = info.title || `Reserved ${sku}`;
    emitInditexScrapeResult({
      emitLog,
      brand: 'Reserved',
      requestedReference: reference,
      actualStyleNumber: info.styleNumber || sku,
      productName,
      imageCount: imageUrls.length,
      hasDescription: Boolean(description),
      hasComposition: Boolean(compositionText),
    });

    return {
      styleNumber: sku,
      productId: sku,
      brand: 'Reserved',
      name: productName,
      price: info.price || '',
      colorRef: '',
      description,
      composition: compositionText
        ? { outerShell: null, lining: null, other: compositionText }
        : null,
      url: normalized.url,
      imageUrls,
      pageText: info.pageText || '',
    };
  } finally {
    await page.close().catch(() => {});
  }
}

// ── Abercrombie & Fitch Scraper ──────────────────────────────────

const ABERCROMBIE_HOME_URL = 'https://www.abercrombie.com/shop/us';

function isLikelyAbercrombieProductImage(url = '') {
  const u = String(url || '').toLowerCase();
  if (!u.includes('abercrombie.com') && !u.includes('anf')) return false;
  // A&F uses Scene7 CDN: /is/image/anf/CODE_prod1 and /is/image/anf/CODE_model1
  if (u.includes('/is/image/') && (u.includes('_prod') || u.includes('_model'))) return true;
  // Traditional file extension check
  if (/\.(jpg|jpeg|png|webp|avif)/i.test(u)) return true;
  // Exclude thumbnails, swatches, icons
  if (u.includes('swatch') || u.includes('icon') || u.includes('logo') || u.includes('favicon')) return false;
  return false;
}

async function dismissCommonAbercrombiePopups(page) {
  const selectors = [
    '#onetrust-accept-btn-handler',
    'button[id*="accept" i][id*="cookie" i]',
    'button[id*="accept" i][id*="consent" i]',
    'button[aria-label*="accept" i]',
    'button[aria-label*="close" i]',
    'button[data-testid*="accept" i]',
    'button[data-testid*="close" i]',
    '[class*="cookie" i] button',
    '[class*="consent" i] button',
    '[class*="promo" i] button[aria-label*="close" i]',
    'button[class*="close" i]',
  ];
  for (const sel of selectors) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click({ delay: 60 }).catch(() => {});
        await antiDetection.randomDelay(300, 600);
      }
    } catch { /* noop */ }
  }
  // Text-based fallback
  try {
    await page.evaluate(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) return false;
        const s = window.getComputedStyle(el);
        return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
      };
      const textRegex = /^\s*(?:accept(?:\s+all)?|agree(?:\s+all)?|okay|ok|got\s+it|allow(?:\s+all)?|i\s+agree|continue|close|no\s*thanks|not\s*now)\s*$/i;
      const buttons = [...document.querySelectorAll('button, [role="button"], a')];
      for (const btn of buttons) {
        if (!isVisible(btn)) continue;
        const text = String(btn.textContent || '').trim();
        if (text.length < 30 && textRegex.test(text)) {
          try { btn.click(); } catch { /* noop */ }
        }
      }
    });
  } catch { /* noop */ }
  await antiDetection.randomDelay(400, 700);
}

async function findVisibleAbercrombieSearchInput(page) {
  const handle = await page.evaluateHandle(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 6) return false;
      const s = window.getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
    };
    // Exclude newsletter / email subscription inputs
    const isNewsletterInput = (el) => {
      const attrs = [
        el.type || '',
        el.name || '',
        el.id || '',
        el.placeholder || '',
        el.getAttribute('aria-label') || '',
        el.getAttribute('data-testid') || '',
      ].join(' ').toLowerCase();
      return /email|subscribe|newsletter|signup|sign.up|mailing|coupon|offer|promo/.test(attrs);
    };
    const inputs = [...document.querySelectorAll(
      'input[type="search"], input[type="text"], input:not([type]), textarea',
    )].filter((el) => isVisible(el) && !isNewsletterInput(el));

    // Priority 1: inputs inside header or search overlay containers
    const headerInput = inputs.find((el) =>
      el.closest('header, [role="search"], [class*="search" i], [data-testid*="search" i], [class*="overlay" i], [class*="modal" i]')
    );
    if (headerInput) return headerInput;

    // Priority 2: inputs in the top half of the viewport
    const topInput = inputs.find((el) => {
      const r = el.getBoundingClientRect();
      return r.top < window.innerHeight * 0.5;
    });
    if (topInput) return topInput;

    // Fallback: first visible non-newsletter input
    return inputs[0] || null;
  }).catch(() => null);
  return handle;
}

async function openAbercrombieSearchOverlay(page) {
  const directSelectors = [
    'button[aria-label*="search" i]',
    'a[aria-label*="search" i]',
    '[data-testid*="search" i] button',
    '[data-testid*="search" i] a',
    'header button[class*="search" i]',
    'header [class*="search" i] button',
    'header [class*="search" i] a',
    'button[class*="search" i]',
    'a[class*="search" i]',
    '[class*="search-toggle" i]',
    '[class*="search-icon" i]',
  ];
  for (const sel of directSelectors) {
    try {
      const handle = await page.$(sel);
      if (handle) {
        await handle.click({ delay: 50 }).catch(() => {});
        return true;
      }
    } catch { /* noop */ }
  }
  // Fallback: walk visible buttons/links for "search" text or magnifier SVG
  return page.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return false;
      const s = window.getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
    };
    const candidates = [...document.querySelectorAll('button, a, [role="button"], [class*="search" i]')];
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const text = String(el.textContent || '').trim().toLowerCase();
      const aria = String(el.getAttribute('aria-label') || '').toLowerCase();
      if (text === 'search' || aria.includes('search')) {
        try { el.click(); return true; } catch { /* noop */ }
      }
      // Check for magnifier icon SVG
      const svg = el.querySelector('svg');
      if (svg && el.classList.toString().toLowerCase().includes('search')) {
        try { el.click(); return true; } catch { /* noop */ }
      }
    }
    return false;
  }).catch(() => false);
}

async function searchAbercrombieByTyping(page, query, emitLog, ensureActive) {
  emitLog(`    🔍 Searching A&F for "${query}"…`, 'info');
  try {
    // Use direct search URL — much more reliable than overlay interaction
    const searchUrl = `https://www.abercrombie.com/shop/us/search?searchTerm=${encodeURIComponent(query)}`;
    emitLog(`    🔎 Navigating to A&F search URL…`, 'info');
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await dismissCommonAbercrombiePopups(page);
    await antiDetection.randomDelay(2000, 3500);
    ensureActive();

    emitLog('    ⏳ Waiting for A&F search results…', 'info');
    await page.waitForFunction(
      () => {
        const anchors = [...document.querySelectorAll('a[href*="/p/"]')];
        const isVisible = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          if (r.width < 10 || r.height < 10) return false;
          const s = window.getComputedStyle(el);
          return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
        };
        return anchors.some(isVisible);
      },
      { timeout: 30000, polling: 500 },
    ).catch(() => {});
    await antiDetection.randomDelay(1500, 2500);

    // Find first product card link
    const firstProductUrl = await page.evaluate(() => {
      const anchors = [...document.querySelectorAll('a[href*="/p/"]')];
      const isVisible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 10 || r.height < 10) return false;
        const s = window.getComputedStyle(el);
        return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
      };
      const visible = anchors.filter(isVisible);
      return visible.length > 0 ? visible[0].href : '';
    }).catch(() => '');

    if (!firstProductUrl) {
      emitLog('    ⚠️ No product results found on A&F search page', 'warning');
      return '';
    }

    // Normalize /shop/wd/p/ → /shop/us/p/ for US store
    const normalizedUrl = firstProductUrl.replace('/shop/wd/p/', '/shop/us/p/');
    emitLog(`    🔗 Found first result: ${normalizedUrl}`, 'info');
    return normalizedUrl;
  } catch (error) {
    emitLog(`    ⚠️ A&F search error: ${error.message || error}`, 'warning');
    return '';
  }
}

async function resolveAbercrombieProductUrl(browser, reference, emitLog, ensureActive) {
  const page = await browser.newPage();
  await antiDetection.applyRetailBrowsingProfile(page);
  await page.setViewport(antiDetection.getRandomViewport());
  await page.bringToFront().catch(() => {});

  try {
    ensureActive();
    const productUrl = await searchAbercrombieByTyping(page, reference, emitLog, ensureActive);
    if (!productUrl) {
      return { url: '', styleNumber: reference };
    }
    return { url: productUrl, styleNumber: reference };
  } finally {
    await page.close().catch(() => {});
  }
}

async function scrapeAbercrombieProduct(browser, reference, emitLog, ensureActive) {
  const resolved = await resolveAbercrombieProductUrl(browser, reference, emitLog, ensureActive);
  if (!resolved.url) {
    throw new Error(`Product not found on A&F for reference: ${reference}`);
  }

  // ── Firecrawl mode check ──────────────────────────────────────
  const currentMode = firecrawlService.getMode();
  if (currentMode === 'manual') {
    emitLog(` Abercrombie ${reference || ''} 手动模式: 使用 Firecrawl 抓取`, 'warning');
    try {
      ensureActive();
      const fcResult = await firecrawlFallback.tryFirecrawlFallback(resolved.url, {
        imageFilter: (imgUrl) => isLikelyAbercrombieProductImage(imgUrl),
        urlNormalizer: (u) => u.split('?')[0],
        candidateIds: [String(reference || '').replace(/\D/g, '')],
        emitLog: (msg, type) => emitLog(`    ${msg}`, type),
      });

      // ─ Parse product text from Firecrawl HTML ────────────────────
      const html = fcResult.html || '';
      let name = '';
      let price = '';
      let description = '';
      let compositionText = null;

      const h1Match = html.match(/<h1[^>]*>(.*?)<\/h1>/is);
      if (h1Match) {
        name = h1Match[1].replace(/<[^>]+>/g, '').trim();
      }

      const priceMatch = html.match(/[€$£¥]([\d.,]+)/);
      if (priceMatch) {
        price = priceMatch[0];
      }

      const descPatterns = [
        /["']description["']?:\s*["']([^"']+)["']/i,
        /<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i,
      ];
      for (const pattern of descPatterns) {
        const m = html.match(pattern);
        if (m) {
          description = m[1].trim();
          break;
        }
      }

      const compPatterns = [
        /["']composition["']?:\s*["']([^"']+)["']/i,
        /["']materials["']?:\s*["']([^"']+)["']/i,
      ];
      for (const pattern of compPatterns) {
        const m = html.match(pattern);
        if (m) {
          compositionText = m[1].trim();
          break;
        }
      }

      const styleNumber = String(reference || '').replace(/\D/g, '');
      return {
        styleNumber,
        productId: styleNumber,
        brand: 'Abercrombie',
        name: name || `Abercrombie ${styleNumber}`,
        price,
        colorRef: '',
        description,
        composition: compositionText ? { outerShell: null, lining: null, other: compositionText } : null,
        url: resolved.url,
        imageUrls: fcResult.imageUrls,
        pageText: '',
        usedEngine: 'firecrawl',
      };
    } catch (fcError) {
      emitLog(`❌ Abercrombie ${reference || ''} Firecrawl 抓取失败: ${fcError.message}`, 'error');
      throw new Error(`Firecrawl failed: ${fcError.message}`);
    }
  }
  // ── End Firecrawl manual mode ───────────────────────────────────

  const page = await browser.newPage();
  await antiDetection.applyRetailBrowsingProfile(page);
  await page.setViewport(antiDetection.getRandomViewport());
  await page.bringToFront().catch(() => {});

  const capturedUrls = new Set();
  const capturedApiImageUrls = new Set();
  let capturedApiPrice = ''; // Capture price from API JSON response
  page.on('response', async (resp) => {
    const reqUrl = cleanImageUrl(resp.url());
    if (isLikelyAbercrombieProductImage(reqUrl)) capturedUrls.add(reqUrl);

    // Also intercept JSON API responses that may contain product image URLs and price
    try {
      const contentType = resp.headers()['content-type'] || '';
      if (contentType.includes('json') || contentType.includes('javascript')) {
        const respUrl = resp.url();
        if (respUrl.includes('/api/') || respUrl.includes('/product') || respUrl.includes('graphql') ||
            respUrl.includes('/p/') || respUrl.includes('pdp') || respUrl.includes('experience') ||
            respUrl.includes('/shop/')) {
          const text = await resp.text().catch(() => '');
          if (text) {
            // Extract all _prod and _model image URLs from the JSON response
            const matches = text.match(/https?:\/\/[^"'\s\\]*_(?:prod|model)\d+[^"'\s\\]*/gi) || [];
            matches.forEach((m) => {
              const cleaned = m.replace(/\\u002F/g, '/').replace(/\\\//g, '/');
              capturedApiImageUrls.add(cleaned.split('?')[0]);
            });

            // Extract price from JSON — prioritize selling/current prices over list/original prices
            // A&F API JSON contains "listPrice" (e.g., $99) before "salePrice" (e.g., $40)
            // We must prefer the selling price, not the first price found in document order
            if (!capturedApiPrice) {
              // Pass 1: Selling/current/final prices (these are the ACTUAL selling price)
              const sellingPatterns = [
                /"(?:currentPrice|finalPrice|salePrice|sellingPrice|offerPrice|discountedPrice)"\s*:\s*"?(\d+(?:\.\d{2})?)"?/gi,
                /"(?:currentPrice|finalPrice|salePrice|sellingPrice|offerPrice|discountedPrice)"\s*:\s*\{[^}]*"value"\s*:\s*"?(\d+(?:\.\d{2})?)"?/gi,
              ];
              for (const pat of sellingPatterns) {
                const m = text.match(pat);
                if (m && m.length > 0) {
                  const numMatch = m[0].match(/(\d+(?:\.\d{2})?)/);
                  if (numMatch) {
                    capturedApiPrice = '$' + numMatch[1];
                    break;
                  }
                }
              }

              // Pass 2: Generic "price" field (only if no selling price found)
              // Exclude listPrice/originalPrice/regularPrice which are pre-discount prices
              if (!capturedApiPrice) {
                // Find all "price": N occurrences, then filter out listPrice/originalPrice/regularPrice
                const allPriceMatches = text.match(/"([a-zA-Z]*?price)"\s*:\s*"?(\d+(?:\.\d{2})?)"?/gi) || [];
                for (const pm of allPriceMatches) {
                  const fieldName = pm.match(/"([a-zA-Z]*?price)"/i)?.[1] || '';
                  // Skip list price, original price, regular price (these are NOT the selling price)
                  if (/^list|^original|^regular/i.test(fieldName)) continue;
                  const numMatch = pm.match(/(\d+(?:\.\d{2})?)/);
                  if (numMatch) {
                    capturedApiPrice = '$' + numMatch[1];
                    break;
                  }
                }
              }

              // Pass 3: Price inside nested objects with "value" field
              if (!capturedApiPrice) {
                const nestedPat = /"price"\s*:\s*\{[^}]*"value"\s*:\s*"?(\d+(?:\.\d{2})?)"?/gi;
                const m = text.match(nestedPat);
                if (m && m.length > 0) {
                  const numMatch = m[0].match(/(\d+(?:\.\d{2})?)/);
                  if (numMatch) {
                    capturedApiPrice = '$' + numMatch[1];
                  }
                }
              }
            }
          }
        }
      }
    } catch { /* noop */ }
  });

  try {
    ensureActive();
    await antiDetection.randomDelay(1000, 1800);
    await page.goto(resolved.url, { waitUntil: 'networkidle2', timeout: 60000 });
    await antiDetection.randomDelay(2200, 3200);
    await dismissCommonAbercrombiePopups(page);

    await antiDetection.humanScroll(page, 2800);
    await antiDetection.randomDelay(700, 1100);

    // Expand "Details & Materials" accordion
    const detailsHandle = await page.evaluateHandle(() => {
      const headingRegex = /details\s*(?:&|and)\s*materials?/i;
      const fallbackRegex = /details|materials?\s*(?:&|and)\s*care|fabric|composition/i;
      const candidates = [...document.querySelectorAll('button, summary, [role="button"], h2, h3, h4, span, div, [aria-expanded], [class*="accordion" i], [class*="collapse" i], [class*="expandable" i]')];
      // Try exact "Details & Materials" first
      let match = candidates.find((el) => {
        const text = String(el.textContent || '').trim();
        return text.length < 60 && headingRegex.test(text);
      });
      // Fallback to broader match
      if (!match) {
        match = candidates.find((el) => {
          const text = String(el.textContent || '').trim();
          return text.length < 60 && fallbackRegex.test(text) && (el.matches('button, summary, [role="button"], [aria-expanded]') || el.closest('button, summary, [role="button"]'));
        });
      }
      if (!match) return null;
      let cursor = match;
      for (let depth = 0; depth < 5 && cursor; depth += 1) {
        if (cursor.matches('button, summary, [role="button"], details, [aria-expanded]')) return cursor;
        cursor = cursor.parentElement;
      }
      return match;
    }).catch(() => null);

    const detailsElement = detailsHandle ? detailsHandle.asElement() : null;
    if (detailsElement) {
      await page.evaluate((el) => {
        try { el.scrollIntoView({ behavior: 'instant', block: 'center' }); } catch { /* noop */ }
      }, detailsElement).catch(() => {});
      const expandedBefore = await page.evaluate((el) => el.getAttribute('aria-expanded'), detailsElement).catch(() => null);
      if (expandedBefore === 'false' || expandedBefore === null) {
        try {
          await detailsElement.click({ delay: 60 });
        } catch {
          await page.evaluate((el) => el.click(), detailsElement).catch(() => {});
        }
      }
      // Wait for composition text to appear
      await page.waitForFunction(
        () => /\d+\s*%\s*(?:cotton|polyester|elastane|viscose|linen|wool|silk|nylon|polyamide|acrylic|cashmere|lyocell|modal|rayon|spandex|tencel|elastomultiester|metallic)/i.test(String(document.body?.innerText || '')),
        { timeout: 8000, polling: 300 },
      ).catch(() => {});
      await detailsHandle.dispose().catch(() => {});
      emitLog('    🧶 Clicked A&F Details & Materials accordion', 'info');
    } else {
      emitLog('    ⚠️ A&F Details & Materials button not found in DOM', 'warning');
    }
    await antiDetection.randomDelay(700, 1100);

    // Extract product data
    const WASH_CARE_REGEX = /machine\s*wash|tumble\s*dry|do\s*not\s*(iron|bleach|wash)|dry\s*clean|iron\s*(at|on|inside|low|medium|high)|low\s*iron|bleach|hang\s*dry|line\s*dry|flat\s*dry|wash\s*(at|inside|with|separately)|professional\s*dry\s*clean|maximum\s*temperature|cold\s*water|warm\s*water|hot\s*water|wash\s*similar\s*colou?rs?|wash\s*inside\s*out|do\s*not\s*tumble|only\s*non-?chlorine|remove\s*promptly|dry\s*immediately|tumble\s*(low|medium|high)|wash\s*before\s*wear|store\s*item|web\s*item/i;

    const WASH_CARE_PATTERN = 'machine\\s*wash|tumble\\s*dry|do\\s*not\\s*(iron|bleach|wash)|dry\\s*clean|iron\\s*(at|on|inside|low|medium|high)|low\\s*iron|bleach|hang\\s*dry|line\\s*dry|flat\\s*dry|wash\\s*(at|inside|with|separately)|professional\\s*dry\\s*clean|maximum\\s*temperature|cold\\s*water|warm\\s*water|hot\\s*water|wash\\s*similar\\s*colou?rs?|wash\\s*inside\\s*out|do\\s*not\\s*tumble|only\\s*non-?chlorine|remove\\s*promptly|dry\\s*immediately|tumble\\s*(low|medium|high)|wash\\s*before\\s*wear|store\\s*item|web\\s*item';

    const productData = await page.evaluate((ref, washCarePattern) => {
      const washCareRe = new RegExp(washCarePattern, 'i');
      const getText = (el) => String(el?.textContent || '').trim();
      const isVisible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return false;
        const s = window.getComputedStyle(el);
        return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
      };

      // Product name
      let name = '';
      const nameEl = document.querySelector('h1') || document.querySelector('[itemprop="name"]') || document.querySelector('[data-testid*="product-name" i]');
      if (nameEl) name = getText(nameEl);

      // Price — extract dollar amounts from the product info area only (not recommended products)
      let price = '';
      {
        // Exclude promotional/shipping/recommended text that may contain $ amounts
        const priceExcludeText = /shipping|free\s+order|orders?\s+over|qualify|rewards?|member\s+price|earn\s+\$|gift\s+card|promo|coupon|bonus/i;
        const excludeSelector = '[class*="recommend" i], [class*="related" i], [class*="similar" i], [class*="you-may" i], [class*="complete-the" i], [data-testid*="recommend" i], [class*="shipping" i], [class*="promo" i], [class*="banner" i], [class*="notification" i]';

        // Strategy 1: Try schema.org itemprop="price"
        let priceEl = document.querySelector('[itemprop="price"]');
        if (priceEl && !priceEl.closest(excludeSelector)) {
          const pt = getText(priceEl);
          if (/\$\s*\d+/.test(pt) && !priceExcludeText.test(pt)) {
            price = pt.match(/\$\s*\d+(?:\.\d{2})?/g)?.[0]?.replace(/\s/g, '') || '';
          }
          // Also check content attribute
          if (!price && priceEl.getAttribute('content')) {
            const contentPrice = priceEl.getAttribute('content');
            price = '$' + contentPrice.replace(/[^\d.]/g, '');
          }
        }

        // Strategy 2: Find the price element closest to H1 (sibling or near-sibling)
        if (!price) {
          const h1 = document.querySelector('h1');
          if (h1) {
            // Walk up from H1 to find a compact product info container
            let productInfoArea = null;
            let cursor = h1.parentElement;
            for (let depth = 0; depth < 6 && cursor; depth += 1) {
              const text = getText(cursor);
              if (/\$\s*\d+/.test(text) && text.length < 400) {
                productInfoArea = cursor;
                break;
              }
              cursor = cursor.parentElement;
            }

            if (productInfoArea) {
              // Find price elements within the product info area
              const priceEls = [...productInfoArea.querySelectorAll('[data-testid*="price" i], [class*="price" i]')]
                .filter(isVisible)
                .filter((el) => !el.closest(excludeSelector))
                .filter((el) => {
                  const t = getText(el);
                  // Price elements should be short (< 80 chars) and contain a $ amount
                  return t.length < 80 && /\$\s*\d+/.test(t) && !priceExcludeText.test(t);
                })
                .sort((a, b) => {
                  // Prefer elements closer to H1 (by DOM distance)
                  const aDist = a.compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_CONTAINED_BY ? 1 : 2;
                  const bDist = b.compareDocumentPosition(h1) & Node.DOCUMENT_POSITION_CONTAINED_BY ? 1 : 2;
                  return aDist - bDist;
                });

              if (priceEls.length > 0) {
                // Get the first (closest to H1) price element's text
                const priceText = getText(priceEls[0]);
                const allPrices = priceText.match(/\$\s*\d+(?:\.\d{2})?/g);
                if (allPrices && allPrices.length > 0) {
                  const unique = [...new Set(allPrices.map((p) => p.replace(/\s/g, '')))];
                  price = unique.join(' ');
                }
              }

              // Strategy 3: If targeted price elements failed, scan product info area text
              // but filter out promotional/shipping lines
              if (!price) {
                const areaText = getText(productInfoArea);
                const areaLines = areaText.split('\n').map((l) => l.trim()).filter(Boolean);
                const priceLines = areaLines.filter((l) =>
                  /\$\s*\d+/.test(l) &&
                  l.length < 80 &&
                  !priceExcludeText.test(l) &&
                  !/shipping|free|order|qualify|reward|member|earn|gift|promo|coupon|bonus/i.test(l)
                );
                if (priceLines.length > 0) {
                  const allPrices = priceLines.join(' ').match(/\$\s*\d+(?:\.\d{2})?/g);
                  if (allPrices && allPrices.length > 0) {
                    const unique = [...new Set(allPrices.map((p) => p.replace(/\s/g, '')))];
                    price = unique.join(' ');
                  }
                }
              }
            }
          }
        }

        // Strategy 4: Last resort — scan body text before "recommended" section
        if (!price) {
          const bodyText = document.body?.innerText || '';
          const cutoffIdx = bodyText.search(/you\s*may\s*also\s*like|recommended|complete\s*the\s*look/i);
          const searchArea = cutoffIdx > 0 ? bodyText.substring(0, cutoffIdx) : bodyText;
          const lines = searchArea.split('\n').map((l) => l.trim()).filter(Boolean);
          const priceLines = lines.filter((l) =>
            /\$\s*\d+/.test(l) &&
            l.length < 80 &&
            !priceExcludeText.test(l)
          );
          if (priceLines.length > 0) {
            const allPrices = priceLines[0].match(/\$\s*\d+(?:\.\d{2})?/g);
            if (allPrices && allPrices.length > 0) {
              price = allPrices[0].replace(/\s/g, '');
            }
          }
        }
      }

      // Style number from URL
      let styleNumber = ref;
      const urlMatch = window.location.href.match(/(\d{6,})/);
      if (urlMatch) styleNumber = urlMatch[1];

      // Extract text from expanded "Details & Materials" section
      let description = '';
      let composition = '';

      // Find the Details & Materials content area
      const allText = document.body?.innerText || '';
      const lines = allText.split('\n').map((l) => l.trim()).filter(Boolean);

      // Find the Details & Materials section boundaries
      let detailsStart = -1;
      let detailsEnd = lines.length;
      for (let i = 0; i < lines.length; i += 1) {
        if (/details\s*(?:&|and)\s*materials?/i.test(lines[i]) && lines[i].length < 60) {
          detailsStart = i + 1;
          break;
        }
      }
      if (detailsStart === -1) {
        // Fallback: look for "details" or "materials" heading
        for (let i = 0; i < lines.length; i += 1) {
          if (/^(details|materials?)\s*$/i.test(lines[i]) || /^(details|materials?)\s*$/i.test(lines[i])) {
            detailsStart = i + 1;
            break;
          }
        }
      }
      if (detailsStart >= 0) {
        // Find end of section (next heading or end of content)
        for (let i = detailsStart; i < lines.length; i += 1) {
          const line = lines[i];
          // Stop at next major section heading
          if (/^(size\s*guide|shipping|returns?|reviews?|you\s*may\s*also\s*like|related|featured|recommended|shop\s*similar)/i.test(line)) {
            detailsEnd = i;
            break;
          }
        }
        const sectionLines = lines.slice(detailsStart, detailsEnd);

        // Split into description and composition
        const descLines = [];
        const compLines = [];
        const fabricKeywords = /cotton|polyester|elastane|viscose|linen|wool|silk|nylon|polyamide|acrylic|cashmere|lyocell|modal|rayon|spandex|tencel|elastomultiester|metallic/i;
        for (const line of sectionLines) {
          const hasPercent = /\d+\s*%/.test(line);
          const hasFabric = fabricKeywords.test(line);
          if (hasPercent && hasFabric) {
            compLines.push(line);
          } else if (!hasPercent) {
            descLines.push(line);
          }
        }

        // Filter wash/care from description
        description = descLines.filter((l) => !washCareRe.test(l)).join('\n').trim();
        // Filter composition: only keep lines matching "part: percentage material" pattern
        const compPartPattern = /^(?:body|shell|lining|main|trim|fabric|pocket\s*lining|pad\s*(?:foam|lining)?|collar|cuff|sleeve\s*lining|upper|sole|insole|outsole|rib\s*knit|waistband|back|front|hood|sleeve|hem|placket|yoke|pocket|elbow|knee|seat|facing|binding|tape|thread|label|care\s*label|main\s*label)\s*:\s*\d+\s*%/i;
        composition = compLines.filter((l) => !washCareRe.test(l) && compPartPattern.test(l)).join('\n').trim();

        // Strip leading product name and "Details" heading from description
        if (description && name) {
          const descLinesClean = description.split('\n');
          while (descLinesClean.length > 0) {
            const firstLine = descLinesClean[0].trim();
            // Remove "Details" heading, product name repeats, or short label-like lines
            if (/^details\s*$/i.test(firstLine)
                || firstLine === name
                || firstLine === name.toLowerCase()
                || (firstLine.length <= name.length + 5 && name.toLowerCase().includes(firstLine.toLowerCase()))) {
              descLinesClean.shift();
            } else {
              break;
            }
          }
          description = descLinesClean.join('\n').trim();
        }
      }

      // Fallback: if no composition found, scan entire page text for "part: percentage material" lines
      if (!composition) {
        const partNames = '(?:body|shell|lining|main|trim|fabric|pocket\\s*lining|pad\\s*(?:foam|lining)?|collar|cuff|sleeve\\s*lining|upper|sole|insole|outsole|rib\\s*knit|waistband|back|front|hood|sleeve|hem|placket|yoke|pocket|elbow|knee|seat|facing|binding|tape|thread|label|main\\s*label)';
        const fabrics = '(?:cotton|polyester|elastane|viscose|linen|wool|silk|nylon|polyamide|acrylic|cashmere|lyocell|modal|rayon|spandex|tencel|elastomultiester|metallic)';
        const compRegex = new RegExp(partNames + '\\s*:\\s*\\d+\\s*%\\s*' + fabrics + '[^.\\n]*', 'gi');
        const compMatches = allText.match(compRegex);
        if (compMatches) {
          composition = compMatches.filter((l) => !washCareRe.test(l)).join('\n').trim();
        }
      }

      return {
        name,
        price,
        styleNumber,
        description,
        composition,
        url: window.location.href,
      };
    }, reference, WASH_CARE_PATTERN).catch(() => ({
      name: '',
      price: '',
      styleNumber: reference,
      description: '',
      composition: '',
      url: resolved.url,
    }));

    // Filter wash/care from description and composition in JS as well
    const filterWashCare = (text) => {
      if (!text) return text;
      return text.split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !WASH_CARE_REGEX.test(l))
        .join('\n')
        .trim();
    };
    productData.description = filterWashCare(productData.description);
    productData.composition = filterWashCare(productData.composition);

    // Collect images — CRITICAL: must identify main product's baseCode FIRST, then filter everything
    // A&F pages have "You May Also Like" sections with _prod URLs from OTHER products

    // --- Step 1: Determine the main product's baseCode ---
    let extractedBaseCode = '';

    // 1a: Try og:image meta tag (usually the main product hero image)
    extractedBaseCode = await page.evaluate(() => {
      const ogImage = document.querySelector('meta[property="og:image"]')?.content;
      if (ogImage && (ogImage.includes('_prod') || ogImage.includes('_model'))) {
        const m = ogImage.match(/\/([A-Za-z0-9_-]+)_(?:prod|model)\d*/);
        if (m) return m[1];
      }
      // Also try twitter:image
      const twImage = document.querySelector('meta[name="twitter:image"]')?.content;
      if (twImage && (twImage.includes('_prod') || twImage.includes('_model'))) {
        const m = twImage.match(/\/([A-Za-z0-9_-]+)_(?:prod|model)\d*/);
        if (m) return m[1];
      }
      return '';
    }).catch(() => '');

    // 1b: Try DOM hero image (first visible LARGE image with _prod/_model URL — this is the main gallery, not recommended products)
    if (!extractedBaseCode) {
      extractedBaseCode = await page.evaluate(() => {
        const isVisible = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          if (r.width < 200 || r.height < 200) return false; // Must be large (hero/gallery image)
          if (r.top > window.innerHeight * 1.5) return false; // Must be near top of page
          const s = window.getComputedStyle(el);
          return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
        };
        // Exclude recommended/related product sections
        const excludeSelector = '[class*="recommend" i], [class*="related" i], [class*="similar" i], [class*="you-may" i], [class*="complete-the" i], [data-testid*="recommend" i]';

        const allEls = [...document.querySelectorAll('img, source')];
        const visibleProdImgs = allEls.filter((el) => {
          if (el.closest(excludeSelector)) return false;
          const candidates = [
            el.src, el.getAttribute('data-src'), el.getAttribute('data-zoom-image'),
            el.getAttribute('data-lazy-src'), el.getAttribute('data-original'),
            el.currentSrc || '',
          ].filter(Boolean);
          return candidates.some((c) => c.includes('_prod') || c.includes('_model')) && isVisible(el);
        });

        if (visibleProdImgs.length > 0) {
          visibleProdImgs.sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
          const firstSrc = visibleProdImgs[0].src ||
            visibleProdImgs[0].getAttribute('data-src') ||
            visibleProdImgs[0].getAttribute('data-zoom-image') || '';
          const m = firstSrc.match(/\/([A-Za-z0-9_-]+)_(?:prod|model)\d*/);
          if (m) return m[1];
        }
        return '';
      }).catch(() => '');
    }

    // 1c: Try extracting from the product URL path (e.g., /shop/us/p/name/120-6178-00735-200)
    if (!extractedBaseCode && resolved.url) {
      const urlMatch = resolved.url.match(/\/(\d{3}-\d{4}-\d{5}-\d{3})(?:\?|$|\/)/);
      if (urlMatch) {
        extractedBaseCode = `KIC_${urlMatch[1]}`;
        emitLog(`    🔗 Extracted baseCode from product URL: ${extractedBaseCode}`, 'info');
      }
    }

    // 1d: Try network interception (first _prod/_model image loaded — main product images load before recommended)
    if (!extractedBaseCode) {
      const networkProdUrls = [...capturedUrls].filter((u) => u.includes('_prod') || u.includes('_model'));
      if (networkProdUrls.length > 0) {
        const m = networkProdUrls[0].match(/\/([A-Za-z0-9_-]+)_(?:prod|model)\d*/);
        if (m) extractedBaseCode = m[1];
      }
    }

    // 1e: Try API JSON interception
    if (!extractedBaseCode && capturedApiImageUrls.size > 0) {
      const m = [...capturedApiImageUrls][0].match(/\/([A-Za-z0-9_-]+)_(?:prod|model)\d*/);
      if (m) extractedBaseCode = m[1];
    }

    emitLog(`    🏷️ Main product baseCode: ${extractedBaseCode || 'NOT FOUND'}`, extractedBaseCode ? 'success' : 'warning');

    // --- Step 2: Collect _prod and _model URLs from all sources, but ONLY keep ones matching the baseCode ---
    let allImageUrls = new Set();

    // 2a: API JSON interception
    if (capturedApiImageUrls.size > 0) {
      let count = 0;
      capturedApiImageUrls.forEach((u) => {
        if (!extractedBaseCode || u.includes(extractedBaseCode + '_prod') || u.includes(extractedBaseCode + '_model')) {
          allImageUrls.add(u);
          count++;
        }
      });
      emitLog(`    🔗 API interception: ${count} matching URLs`, 'info');
    }

    // 2b: Full-page HTML source scan (filter by baseCode to exclude recommended products)
    const htmlImageUrls = await page.evaluate((baseCode) => {
      const html = document.documentElement.outerHTML;
      const regex = /https?:\/\/[^"'\s<>\\]*_(?:prod|model)\d+/gi;
      const matches = html.match(regex) || [];
      const unique = [...new Set(matches.map((u) => u.split('?')[0]))];
      if (baseCode) return unique.filter((u) => u.includes(baseCode + '_prod') || u.includes(baseCode + '_model'));
      return unique;
    }, extractedBaseCode).catch(() => []);

    if (htmlImageUrls.length > 0) {
      emitLog(`    🔍 HTML source scan: ${htmlImageUrls.length} matching URLs`, 'info');
      htmlImageUrls.forEach((u) => allImageUrls.add(u));
    }

    // 2c: Gallery thumbnail clicking + DOM extraction
    await page.evaluate(() => {
      const thumbs = [...document.querySelectorAll(
        '[class*="thumbnail" i] img, [class*="thumb" i] img, [class*="gallery" i] [class*="thumb" i], ' +
        '[data-testid*="thumb" i], [class*="carousel" i] [class*="dot" i], ' +
        '[class*="slider" i] [class*="thumb" i], button[aria-label*="product image" i], ' +
        'button[aria-label*="view" i], [class*="media" i] button, [role="tab"]'
      )];
      thumbs.forEach((t) => { try { t.click(); } catch { /* noop */ } });
    }).catch(() => {});
    await antiDetection.randomDelay(800, 1200);

    const thumbCount = await page.evaluate(() => {
      const thumbs = [...document.querySelectorAll(
        '[class*="thumbnail" i] img, [class*="thumb" i] img, [class*="gallery" i] [class*="thumb" i], ' +
        '[data-testid*="thumb" i], [class*="carousel" i] [class*="dot" i], ' +
        'button[aria-label*="product image" i], [class*="media" i] [class*="thumb" i], ' +
        'button[aria-label*="view" i], [class*="media" i] button, [role="tab"]'
      )];
      return thumbs.length;
    }).catch(() => 0);

    for (let t = 0; t < Math.min(thumbCount, 12); t += 1) {
      await page.evaluate((idx) => {
        const thumbs = [...document.querySelectorAll(
          '[class*="thumbnail" i] img, [class*="thumb" i] img, [class*="gallery" i] [class*="thumb" i], ' +
          '[data-testid*="thumb" i], [class*="carousel" i] [class*="dot" i], ' +
          'button[aria-label*="product image" i], [class*="media" i] [class*="thumb" i], ' +
          'button[aria-label*="view" i], [class*="media" i] button, [role="tab"]'
        )];
        if (thumbs[idx]) { try { thumbs[idx].click(); } catch { /* noop */ } }
      }, t).catch(() => {});
      await antiDetection.randomDelay(400, 700);
    }

    // Extract from DOM (img, source, CSS background-image) — filter by baseCode
    const domImageUrls = await page.evaluate((baseCode) => {
      const seen = new Set();
      const results = [];
      const excludeSelector = '[class*="recommend" i], [class*="related" i], [class*="similar" i], [class*="you-may" i], [class*="complete-the" i], [data-testid*="recommend" i]';

      const allEls = [...document.querySelectorAll('img, source')];
      for (const el of allEls) {
        if (el.closest(excludeSelector)) continue;
        const candidates = [
          el.src, el.getAttribute('data-src'), el.getAttribute('data-zoom-image'),
          el.getAttribute('data-lazy-src'), el.getAttribute('data-original'),
          el.getAttribute('srcset'), el.getAttribute('data-srcset'), el.currentSrc || '',
        ].filter(Boolean);
        for (const raw of candidates) {
          const urls = raw.split(',').map((s) => s.trim().split(/\s+/)[0]);
          for (const url of urls) {
            const isImage = url.includes('_prod') || url.includes('_model');
            const matchesBase = !baseCode || url.includes(baseCode + '_prod') || url.includes(baseCode + '_model');
            if (isImage && matchesBase && !seen.has(url.split('?')[0])) {
              seen.add(url.split('?')[0]);
              results.push(url.split('?')[0]);
            }
          }
        }
      }

      // CSS background-image
      const allStyled = [...document.querySelectorAll('[style*="background"], [style*="url("]')];
      for (const el of allStyled) {
        if (el.closest(excludeSelector)) continue;
        const bg = window.getComputedStyle(el).backgroundImage;
        if (bg && (bg.includes('_prod') || bg.includes('_model'))) {
          const urlMatches = bg.matchAll(/url\(["']?([^"')]+)["']?\)/gi);
          for (const m of urlMatches) {
            const url = m[1];
            const isImage = url.includes('_prod') || url.includes('_model');
            const matchesBase = !baseCode || url.includes(baseCode + '_prod') || url.includes(baseCode + '_model');
            if (isImage && matchesBase && !seen.has(url.split('?')[0])) {
              seen.add(url.split('?')[0]);
              results.push(url.split('?')[0]);
            }
          }
        }
      }
      return results;
    }, extractedBaseCode).catch(() => []);

    if (domImageUrls.length > 0) {
      emitLog(`    🖼️ DOM extraction: ${domImageUrls.length} matching URLs`, 'info');
      domImageUrls.forEach((u) => allImageUrls.add(u));
    }

    // 2d: Network image interception — filter by baseCode
    const networkImageUrls = [...capturedUrls].filter((u) =>
      (u.includes('_prod') || u.includes('_model')) && (!extractedBaseCode || u.includes(extractedBaseCode + '_prod') || u.includes(extractedBaseCode + '_model'))
    );
    if (networkImageUrls.length > 0) {
      emitLog(`    🌐 Network interception: ${networkImageUrls.length} matching URLs`, 'info');
      networkImageUrls.forEach((u) => allImageUrls.add(u));
    }

    emitLog(`    📷 Total unique image URLs matching baseCode: ${allImageUrls.size}`, 'info');

    // --- Step 3: Proactive URL construction for missing _prod and _model numbers ---
    // A&F Scene7 CDN uses two patterns: _prod{N} (flat product) and _model{N} (model/lifestyle)
    let imageUrls = [...allImageUrls];
    if (extractedBaseCode) {
      const existingProdNums = new Set(
        imageUrls.filter((u) => u.includes('_prod')).map((u) => parseInt(u.match(/_prod(\d+)/)?.[1] || '0', 10))
      );
      const existingModelNums = new Set(
        imageUrls.filter((u) => u.includes('_model')).map((u) => parseInt(u.match(/_model(\d+)/)?.[1] || '0', 10))
      );
      const cdnBase = `https://img.abercrombie.com/is/image/anf/${extractedBaseCode}`;
      // Proactively construct _prod1 through _prod3 (usually only 1-2 flat product images)
      for (let n = 1; n <= 3; n += 1) {
        if (!existingProdNums.has(n)) {
          imageUrls.push(`${cdnBase}_prod${n}`);
        }
      }
      // Proactively construct _model1 through _model8 (model/lifestyle images — can be up to 8)
      for (let n = 1; n <= 8; n += 1) {
        if (!existingModelNums.has(n)) {
          imageUrls.push(`${cdnBase}_model${n}`);
        }
      }
    }

    // Normalize all image URLs to use product-large policy and deduplicate
    imageUrls = [...new Set(
      imageUrls.map((u) => {
        const baseUrl = u.split('?')[0];
        return `${baseUrl}?policy=product-large`;
      })
    )];

    // Sort: _prod images first, then _model images, each by number
    imageUrls.sort((a, b) => {
      const aIsProd = a.includes('_prod');
      const bIsProd = b.includes('_prod');
      if (aIsProd && !bIsProd) return -1;
      if (!aIsProd && bIsProd) return 1;
      const aNum = parseInt(a.match(/_(?:prod|model)(\d+)/)?.[1] || '0', 10);
      const bNum = parseInt(b.match(/_(?:prod|model)(\d+)/)?.[1] || '0', 10);
      return aNum - bNum;
    });

    // Use API-captured price ONLY as a fallback when DOM extraction failed
    // DOM extraction is preferred because it captures the visible selling price on the page
    // API price can be the "listPrice" (pre-discount), not the actual selling price
    if (!productData.price && capturedApiPrice) {
      productData.price = capturedApiPrice;
      emitLog(`    💰 Using API price as fallback: ${capturedApiPrice}`, 'info');
    } else if (capturedApiPrice && productData.price !== capturedApiPrice) {
      emitLog(`    💰 API price: ${capturedApiPrice}, DOM price: ${productData.price} (keeping DOM)`, 'info');
    }

    emitLog(`    📦 A&F ${reference}: name="${productData.name}", price="${productData.price}", ${imageUrls.length} image URLs`, 'info');
    if (productData.composition) {
      emitLog(`    🧵 Composition: ${productData.composition.split('\n')[0]}…`, 'info');
    }
    if (productData.description) {
      emitLog(`    📝 Description: ${productData.description.substring(0, 80)}…`, 'info');
    }

    return {
      ...productData,
      imageUrls,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function runAbercrombieScraper(config, emitLog, emitProgress, taskController, previewBridge = null) {
  let { styleNumbers, excelPath, outputDir, downloadConcurrency } = config;
  styleNumbers = normalizeManualStyleNumbers(styleNumbers);
  const ensureActive = () => taskController?.throwIfCancelled?.();
  let browser = null;

  if (excelPath) {
    try {
      ensureActive();
      emitLog(`Reading Excel file: ${excelPath}`, 'info');
      const wb = XLSX.readFile(excelPath);
      const ws = wb.Sheets[wb.SheetNames[0]];
      styleNumbers = [];
      const range = XLSX.utils.decode_range(ws['!ref'] || 'A1:B1');
      for (let row = 1; row <= range.e.r; row += 1) {
        const cellAddress = XLSX.utils.encode_cell({ r: row, c: 1 });
        const cell = ws[cellAddress];
        if (cell) {
          const displayValue = String(cell.w ?? cell.v ?? '').trim();
          if (displayValue) {
            styleNumbers.push(displayValue);
            emitLog(`📥 Excel row ${row + 1} column B: "${displayValue}"`, 'info');
          }
        }
      }
      emitLog(`Loaded ${styleNumbers.length} A&F style numbers from Excel.`, 'success');
    } catch (error) {
      throw new Error(`Excel parse failed: ${error.message}`);
    }
  }

  ensureActive();
  if (!styleNumbers || styleNumbers.length === 0) {
    throw new Error('No A&F style numbers were found. Put the style numbers in column B or enter them manually.');
  }

  const targetDir = !outputDir || outputDir === '未选择' ? path.join(app.getPath('desktop'), 'Abercrombie') : outputDir;
  fs.mkdirSync(targetDir, { recursive: true });

  emitLog(`📁 Output directory: ${targetDir}`, 'info');
  emitLog('🌐 Launching the A&F scraper session...', 'info');

  let executablePath = findChromePath();
  if (!executablePath) {
    emitLog('⬇️ No local Chrome was found. Downloading a managed Chrome runtime for GS Bot...', 'warning');
    const chromeInstall = await ensureChromeRuntimeAvailable((payload) => {
      if (payload?.status) {
        emitLog(payload.status, payload.phase === 'complete' ? 'success' : 'info');
      }
    });
    if (!chromeInstall?.success) {
      throw new Error(chromeInstall?.error || 'Chrome download failed.');
    }
    executablePath = chromeInstall.executablePath;
  }

  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: false,
      userDataDir: getAbercrombieSessionDir(),
      args: antiDetection.getRetailLaunchArgs(),
      ignoreDefaultArgs: ['--enable-automation'],
      defaultViewport: null,
    });
    previewBridge?.attachToBrowser(browser);

    taskController?.onCancel(() => {
      if (browser && browser.isConnected()) {
        browser.close().catch(() => {});
      }
    });

    const products = [];
    let currentProgress = 5;
    emitProgress(currentProgress);
    const totalItems = styleNumbers.length;

    const processReference = async (reference) => {
      try {
        ensureActive();
        const result = await scrapeAbercrombieProduct(browser, reference, emitLog, ensureActive);
        return result;
      } catch (error) {
        if (isCancellationError(error) || taskController?.cancelled) {
          throw new TaskCancelledError();
        }
        emitLog(`    ⚠️ A&F ${reference} failed: ${error.message || error}`, 'warning');
        return {
          styleNumber: reference,
          url: '',
          error: error.message || 'Unknown error',
          imageUrls: [],
        };
      }
    };

    emitLog(`🚀 A&F: ${totalItems} 个款号 (打开 abercrombie.com，搜索款号后点击第一个结果)`, 'warning');
    for (let i = 0; i < totalItems; i += 1) {
      ensureActive();
      const reference = styleNumbers[i];
      emitLog(`🎯 A&F input raw: "${reference}"`, 'info');
      emitLog(`🔄 Processing A&F ${i + 1}/${totalItems}: ${reference}`, 'warning');
      const result = await processReference(reference);
      products.push(result);
      // Emit ✅ success log in the format recognized by frontend's buildScrapeStatus()
      if ((result.imageUrls && result.imageUrls.length > 0) || (result.name && result.name.length > 0)) {
        emitLog(`✅ A&F ${reference} captured | ${result.name || 'Unknown'} | ${result.imageUrls?.length || 0} images`, 'success');
      }
      currentProgress = 5 + Math.round(((i + 1) / totalItems) * 45);
      emitProgress(currentProgress);
      if (i < totalItems - 1) {
        await antiDetection.randomDelay(1500, 2500);
      }
    }

    currentProgress = 50;
    emitProgress(currentProgress);

    ensureActive();
    emitLog('🌐 A&F page extraction complete. Preparing image downloads...', 'warning');

    const successProducts = products.filter((p) => (p.imageUrls && p.imageUrls.length > 0) || (p.name && p.name.length > 0));
    const failedProducts = products.filter((p) => (!p.imageUrls || p.imageUrls.length === 0) && (!p.name || p.name.length === 0));
    const totalImages = products.reduce((sum, p) => sum + (p.imageUrls?.length || 0), 0);

    emitLog(`📊 A&F summary: ${successProducts.length} styles succeeded, ${failedProducts.length} styles failed, ${totalImages} images collected.`, 'info');

    if (failedProducts.length > 0) {
      failedProducts.forEach((p) => {
        emitLog(`    ❌ ${p.styleNumber} - ${p.error || 'No product images found'}`, 'error');
      });
    }

    const allTasks = [];
    const productsWithImages = products.filter((p) => p.imageUrls && p.imageUrls.length > 0);
    for (const product of productsWithImages) {
      ensureActive();
      const cleanStyleNumber = sanitizeFileSegment(String(product.styleNumber || '').replace(/\//g, '-'), 'abercrombie-item');
      const styleDir = path.join(targetDir, cleanStyleNumber);
      fs.mkdirSync(styleDir, { recursive: true });

      // Deduplicate image URLs
      const uniqueUrls = [...new Set(product.imageUrls)];
      uniqueUrls.forEach((imgUrl, idx) => {
        const ext = getUrlExtension(imgUrl, '.jpg');
        const label = String(idx + 1).padStart(2, '0');
        const filename = `${cleanStyleNumber}_${label}${ext}`;
        const filePath = path.join(styleDir, filename);
        allTasks.push(() => {
          ensureActive();
          return downloadFile(imgUrl, filePath, {
            headers: {
              Referer: product.url || 'https://www.abercrombie.com/',
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
              Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
            },
            timeoutMs: 45000,
          })
            .then((size) => {
              if (size) emitLog(`    ⬇️ [saved] ${filename} (${size.toFixed(1)} KB)`);
            })
            .catch((error) => {
              emitLog(`    ❌ [failed] ${filename}: ${error.message}`, 'error');
            });
        });
      });

      const infoData = {
        styleNumber: product.styleNumber,
        brand: 'Abercrombie & Fitch',
        name: product.name,
        price: product.price,
        description: product.description || '',
        composition: product.composition || null,
        url: product.url,
        images: uniqueUrls.map((url, idx) => ({ [`image_${String(idx + 1).padStart(2, '0')}`]: url })),
      };
      const infoPath = path.join(styleDir, `${cleanStyleNumber}_info.json`);
      fs.writeFileSync(infoPath, JSON.stringify(infoData, null, 2), 'utf-8');
      emitLog(`📄 Saved product metadata: ${cleanStyleNumber}_info.json`, 'success');
    }

    emitLog(`📦 Downloading ${allTasks.length} A&F images with ${downloadConcurrency || 3} worker(s)...`, 'info');

    let completedTasks = 0;
    const tasksWithProgress = allTasks.map((task) => async () => {
      await task();
      completedTasks += 1;
      emitProgress(50 + Math.round((completedTasks / Math.max(allTasks.length, 1)) * 45));
    });

    if (tasksWithProgress.length > 0) {
      await parallelLimit(tasksWithProgress, downloadConcurrency || 3);
    }

    // Write summary
    const summaryPath = path.join(targetDir, 'summary.json');
    const summaryData = {
      brand: 'Abercrombie & Fitch',
      totalStyles: totalItems,
      successCount: successProducts.length,
      failedCount: failedProducts.length,
      totalImages,
      timestamp: new Date().toISOString(),
      products: products.map((p) => ({
        styleNumber: p.styleNumber,
        name: p.name || '',
        price: p.price || '',
        url: p.url || '',
        imageCount: p.imageUrls?.length || 0,
        hasDescription: Boolean(p.description),
        hasComposition: Boolean(p.composition),
        error: p.error || null,
      })),
    };
    fs.writeFileSync(summaryPath, JSON.stringify(summaryData, null, 2), 'utf-8');
    emitLog(`📊 Summary saved to: ${summaryPath}`, 'success');

    // Write failed styles
    if (failedProducts.length > 0) {
      const failedPath = path.join(targetDir, 'failed_styles.json');
      fs.writeFileSync(failedPath, JSON.stringify(
        failedProducts.map((p) => ({ styleNumber: p.styleNumber, error: p.error || 'Unknown' })),
        null, 2,
      ), 'utf-8');
    }

    // Annotate Excel if provided
    if (excelPath) {
      try {
        ensureActive();
        emitLog('📝 Annotating source Excel with results...', 'info');
        const wb = XLSX.readFile(excelPath);
        const ws = wb.Sheets[wb.SheetNames[0]];
        const range = XLSX.utils.decode_range(ws['!ref'] || 'A1:B1');
        // Find or create header for result columns
        let resultCol = 2; // Column C
        if (!ws[XLSX.utils.encode_cell({ r: 0, c: resultCol })]) {
          ws[XLSX.utils.encode_cell({ r: 0, c: resultCol })] = { t: 's', v: 'Result' };
          ws[XLSX.utils.encode_cell({ r: 0, c: resultCol + 1 })] = { t: 's', v: 'Image Count' };
          ws[XLSX.utils.encode_cell({ r: 0, c: resultCol + 2 })] = { t: 's', v: 'URL' };
        }
        for (let row = 1; row <= range.e.r; row += 1) {
          const cellAddress = XLSX.utils.encode_cell({ r: row, c: 1 });
          const cell = ws[cellAddress];
          if (!cell) continue;
          const ref = String(cell.w ?? cell.v ?? '').trim();
          const product = products.find((p) => p.styleNumber === ref);
          if (product) {
            const success = (product.imageUrls && product.imageUrls.length > 0) || (product.name && product.name.length > 0);
            ws[XLSX.utils.encode_cell({ r: row, c: resultCol })] = { t: 's', v: success ? 'OK' : 'FAILED' };
            ws[XLSX.utils.encode_cell({ r: row, c: resultCol + 1 })] = { t: 'n', v: product.imageUrls?.length || 0 };
            ws[XLSX.utils.encode_cell({ r: row, c: resultCol + 2 })] = { t: 's', v: product.url || '' };
          }
        }
        ws['!ref'] = XLSX.utils.encode_range({
          s: { r: 0, c: 0 },
          e: { r: range.e.r, c: resultCol + 2 },
        });
        XLSX.writeFile(wb, excelPath);
        emitLog('✅ Excel annotation complete.', 'success');
      } catch (annotateError) {
        emitLog(`⚠️ Excel annotation failed: ${annotateError.message}`, 'warning');
      }
    }

    emitLog(`🎉 A&F scraping complete: ${successProducts.length}/${totalItems} succeeded`, 'success');
    emitProgress(100);
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

async function runReservedScraper(config, emitLog, emitProgress, taskController, previewBridge = null) {
  let { styleNumbers, excelPath, outputDir, downloadConcurrency } = config;
  styleNumbers = normalizeManualStyleNumbers(styleNumbers);
  const ensureActive = () => taskController?.throwIfCancelled?.();
  let browser = null;

  if (excelPath) {
    try {
      ensureActive();
      emitLog(`Reading Excel file: ${excelPath}`, 'info');
      const wb = XLSX.readFile(excelPath);
      const ws = wb.Sheets[wb.SheetNames[0]];
      styleNumbers = [];
      const range = XLSX.utils.decode_range(ws['!ref'] || 'A1:B1');
      for (let row = 1; row <= range.e.r; row += 1) {
        const cellAddress = XLSX.utils.encode_cell({ r: row, c: 1 });
        const cell = ws[cellAddress];
        if (cell) {
          const displayValue = String(cell.w ?? cell.v ?? '').trim();
          if (displayValue) {
            styleNumbers.push(displayValue);
            emitLog(`📥 Excel row ${row + 1} column B: "${displayValue}"`, 'info');
          }
        }
      }
      emitLog(`Loaded ${styleNumbers.length} Reserved style numbers from Excel.`, 'success');
    } catch (error) {
      throw new Error(`Excel parse failed: ${error.message}`);
    }
  }

  ensureActive();
  if (!styleNumbers || styleNumbers.length === 0) {
    throw new Error('No Reserved style numbers were found. Put the SKU values in column B or enter them manually.');
  }

  const targetDir = !outputDir || outputDir === '未选择' ? path.join(app.getPath('desktop'), 'Reserved') : outputDir;
  fs.mkdirSync(targetDir, { recursive: true });

  emitLog(`📁 Output directory: ${targetDir}`, 'info');
  emitLog('🌐 Launching the Reserved scraper session...', 'info');

  let executablePath = findChromePath();
  if (!executablePath) {
    emitLog('⬇️ No local Chrome was found. Downloading a managed Chrome runtime for GS Bot...', 'warning');
    const chromeInstall = await ensureChromeRuntimeAvailable((payload) => {
      if (payload?.status) {
        emitLog(payload.status, payload.phase === 'complete' ? 'success' : 'info');
      }
    });
    if (!chromeInstall?.success) {
      throw new Error(chromeInstall?.error || 'Chrome download failed.');
    }
    executablePath = chromeInstall.executablePath;
  }

  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: false,
      userDataDir: getReservedSessionDir(),
      args: antiDetection.getRetailLaunchArgs(),
      ignoreDefaultArgs: ['--enable-automation'],
      defaultViewport: null,
    });
    previewBridge?.attachToBrowser(browser);

    taskController?.onCancel(() => {
      if (browser && browser.isConnected()) {
        browser.close().catch(() => {});
      }
    });

    const products = [];
    let currentProgress = 5;
    emitProgress(currentProgress);
    const totalItems = styleNumbers.length;

    const processReference = async (reference) => {
      try {
        ensureActive();
        return await scrapeReservedProduct(browser, reference, emitLog, ensureActive);
      } catch (error) {
        if (isCancellationError(error) || taskController?.cancelled) {
          throw new TaskCancelledError();
        }
        emitLog(`    ⚠️ Reserved ${reference} failed: ${error.message || error}`, 'warning');
        return {
          styleNumber: reference,
          productId: reference,
          url: '',
          error: error.message || 'Unknown error',
          imageUrls: [],
        };
      }
    };

    emitLog(`🚀 Reserved: ${totalItems} 个款号 (打开 reserved.com 首页，直接在搜索框输入款号)`, 'warning');
    for (let i = 0; i < totalItems; i += 1) {
      ensureActive();
      const reference = styleNumbers[i];
      emitLog(`🎯 Reserved input raw: "${reference}"`, 'info');
      emitLog(`🔄 Processing Reserved ${i + 1}/${totalItems}: ${reference}`, 'warning');
      const result = await processReference(reference);
      products.push(result);
      currentProgress = 5 + Math.round(((i + 1) / totalItems) * 45);
      emitProgress(currentProgress);
      if (i < totalItems - 1) {
        await antiDetection.randomDelay(1500, 2500);
      }
    }

    currentProgress = 50;
    emitProgress(currentProgress);

    ensureActive();
    emitLog('🌐 Reserved page extraction complete. Preparing image downloads...', 'warning');

    const successProducts = products.filter((p) => p.imageUrls && p.imageUrls.length > 0);
    const failedProducts = products.filter((p) => !p.imageUrls || p.imageUrls.length === 0);
    const totalImages = successProducts.reduce((sum, p) => sum + p.imageUrls.length, 0);

    emitLog(`📊 Reserved summary: ${successProducts.length} styles succeeded, ${failedProducts.length} styles failed, ${totalImages} images collected.`, 'info');

    if (failedProducts.length > 0) {
      failedProducts.forEach((p) => {
        emitLog(`    ❌ ${p.styleNumber} - ${p.error || 'No product images found'}`, 'error');
        emitLog(`       👉 建议人工下载: ${buildReservedManualSearchUrl(p.styleNumber)}`, 'warning');
      });
    }

    const allTasks = [];
    for (const product of successProducts) {
      ensureActive();
      const cleanStyleNumber = sanitizeFileSegment(String(product.productId || product.styleNumber || '').replace(/\//g, '-'), 'reserved-item');
      const styleDir = path.join(targetDir, cleanStyleNumber);
      fs.mkdirSync(styleDir, { recursive: true });

      const classified = buildReservedImageMap(product.imageUrls);

      for (const [label, imgUrl] of Object.entries(classified)) {
        const ext = getUrlExtension(imgUrl, '.jpg');
        const filename = `${cleanStyleNumber}_${label}${ext}`;
        const filePath = path.join(styleDir, filename);
        allTasks.push(() => {
          ensureActive();
          return downloadFile(imgUrl, filePath, {
            headers: {
              Referer: product.url || 'https://www.reserved.com/',
              'User-Agent': 'Mozilla/5.0',
            },
            timeoutMs: 45000,
          })
            .then((size) => {
              if (size) emitLog(`    ⬇️ [saved] ${filename} (${size.toFixed(1)} KB)`);
            })
            .catch((error) => {
              emitLog(`    ❌ [failed] ${filename}: ${error.message}`, 'error');
            });
        });
      }

      const infoData = {
        styleNumber: product.productId || product.styleNumber,
        brand: product.brand || 'Reserved',
        name: product.name,
        price: product.price,
        colorRef: product.colorRef,
        description: product.description || '',
        composition: product.composition || null,
        url: product.url,
        images: classified,
      };
      const infoPath = path.join(styleDir, `${cleanStyleNumber}_info.json`);
      fs.writeFileSync(infoPath, JSON.stringify(infoData, null, 2), 'utf-8');
      emitLog(`📄 Saved product metadata: ${cleanStyleNumber}_info.json`, 'success');
    }

    emitLog(`📦 Downloading ${allTasks.length} Reserved images with ${downloadConcurrency} worker(s)...`, 'info');

    let completedTasks = 0;
    const tasksWithProgress = allTasks.map((task) => async () => {
      ensureActive();
      await task();
      completedTasks += 1;
      emitProgress(50 + Math.round((completedTasks / Math.max(allTasks.length, 1)) * 50));
    });

    if (tasksWithProgress.length > 0) {
      await parallelLimit(tasksWithProgress, downloadConcurrency);
    }

    emitProgress(100);
    const summary = products.map((p) => ({
      styleNumber: p.productId || p.styleNumber,
      brand: p.brand || 'Reserved',
      name: p.name,
      price: p.price,
      colorRef: p.colorRef,
      description: p.description || '',
      composition: p.composition || null,
      images: p.imageUrls ? p.imageUrls.length : 0,
      error: p.error || null,
    }));
    fs.writeFileSync(path.join(targetDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf-8');
    emitLog('📊 Saved summary.json', 'success');

    if (failedProducts.length > 0) {
      const failedSummary = failedProducts.map((p) => ({
        styleNumber: p.productId || p.styleNumber,
        error: p.error || 'No product images found',
      }));
      fs.writeFileSync(path.join(targetDir, 'failed_styles.json'), JSON.stringify(failedSummary, null, 2), 'utf-8');
      fs.writeFileSync(
        path.join(targetDir, 'failed_styles.txt'),
        failedSummary.map((item) => `${item.styleNumber}\t${item.error}`).join('\n'),
        'utf-8',
      );
      emitLog('📄 Saved failed_styles.json', 'success');
    }

    emitLog(`🎉 Reserved scraping finished. Files saved to: ${targetDir}`, 'success');
  } finally {
    if (browser && browser.isConnected()) {
      await browser.close().catch(() => {});
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Sinsay (sinsay.com/pl/pl/) — Polish storefront, typed search, composition
// behind "Composition and care" accordion. No description scraped.
// Second-pass query strips everything after the first "-" (e.g. 010HI-59X → 010HI).
// ════════════════════════════════════════════════════════════════════════════

const SINSAY_HOME_URL = 'https://www.sinsay.com/pl/pl/';

function normalizeSinsayImageUrl(url = '') {
  // Convert Sinsay thumbnail cache URL to full-size:
  // https://static.sinsay.com/media/catalog/product/cache/160/HASH/X/X/filename.jpg
  // →  https://static.sinsay.com/media/catalog/product/X/X/filename.jpg
  return String(url || '').replace(
    /^(https?:\/\/[^/]+\/media\/catalog\/product\/)cache\/\d+\/[^/]+\//i,
    '$1',
  );
}

function isLikelySinsayProductImage(url = '') {
  const v = String(url || '').toLowerCase();
  if (!/\.(?:jpe?g|png|webp)(?:\?|$)/i.test(v)) return false;
  return v.includes('sinsay.com/') || v.includes('sinsaystatic') || v.includes('lpp.com/') || v.includes('lpp.pl/');
}

function isRelevantSinsayProductImage(url = '', skuLower = '') {
  const normalized = normalizeSinsayImageUrl(url);
  if (!isLikelySinsayProductImage(normalized)) return false;
  const v = normalized.toLowerCase();
  // Exclude obvious non-product assets
  if (/promo|banner|logo|icon|overlay|splash|badge|stamp/i.test(v)) return false;
  if (!skuLower) return true;
  // Only keep images whose filename contains the SKU or its style prefix
  const stylePart = skuLower.split('-')[0];
  return v.includes(skuLower) || (stylePart.length >= 4 && v.includes(stylePart));
}

function buildSinsayImageMap(imageUrls = []) {
  const list = [...imageUrls];
  const map = {};
  if (!list.length) return map;
  map.F = list[0];
  if (list.length > 1) map.B = list[list.length - 1];
  let extra = 1;
  for (let i = 1; i < list.length - 1; i += 1) {
    map[String(extra).padStart(2, '0')] = list[i];
    extra += 1;
  }
  return map;
}

function translateSinsayProductName(text = '') {
  // Word-level Polish → English mapping for Sinsay garment names.
  // Covers the most common product types and descriptors in their catalog.
  const words = {
    // Garment types
    'szorty': 'shorts', 'szort': 'shorts', 'spodenki': 'shorts',
    'spodnie': 'trousers', 'spodnica': 'skirt', 'spódnica': 'skirt', 'spodniczka': 'mini skirt', 'spódniczka': 'mini skirt',
    'sukienka': 'dress', 'sukienki': 'dress', 'sukieneczka': 'dress',
    'bluzka': 'blouse', 'bluzki': 'blouse', 'bluza': 'sweatshirt',
    'koszula': 'shirt', 'koszulka': 't-shirt', 'koszulki': 't-shirt',
    'top': 'top', 'tops': 'tops',
    'sweter': 'sweater', 'sweterek': 'sweater',
    'marynarka': 'blazer', 'żakiet': 'jacket', 'zakiet': 'jacket',
    'kurtka': 'jacket', 'kurtki': 'jacket',
    'płaszcz': 'coat', 'plaszcz': 'coat',
    'legginsy': 'leggings',
    'kombinezon': 'jumpsuit', 'kombinezonki': 'playsuit',
    'strój': 'swimsuit', 'stroj': 'swimsuit',
    'bikini': 'bikini', 'kostium': 'swimsuit',
    'piżama': 'pyjamas', 'pizama': 'pyjamas',
    'rajstopy': 'tights',
    // Fabrics / materials
    'plażowe': 'beach', 'plazowe': 'beach',
    'dresowe': 'sweatshirt', 'dresowy': 'sweatshirt',
    'dżinsowe': 'denim', 'dzinsowe': 'denim', 'dżinsowy': 'denim',
    'bawełniane': 'cotton', 'bawelniane': 'cotton',
    'satynowe': 'satin', 'satynowy': 'satin',
    'koronkowe': 'lace', 'koronkowy': 'lace',
    'tiulowe': 'tulle', 'tiulowy': 'tulle',
    'lniane': 'linen', 'lniany': 'linen',
    // Descriptors
    'z': 'with', 'ze': 'with',
    'efektem': 'effect', 'efekt': 'effect',
    'ombre': 'ombre',
    'kwiatowym': 'floral', 'kwiatowy': 'floral', 'kwiatowe': 'floral',
    'w': 'in', 'na': 'on',
    'krótkie': 'short', 'krotkie': 'short', 'długie': 'long', 'dlugie': 'long',
    'szerokie': 'wide', 'wąskie': 'slim', 'waskie': 'slim',
    'proste': 'straight',
    'rozkloszowane': 'flared', 'rozkloszowany': 'flared',
    'marszczone': 'gathered', 'marszczony': 'gathered',
    'wiązaniem': 'tie', 'wiazaniem': 'tie', 'wiązane': 'tie', 'wiazane': 'tie',
    'zapięciem': 'fastening', 'zapiecie': 'fastening',
    'kieszeniami': 'pockets', 'kieszonkami': 'pockets',
    'paskiem': 'belt', 'pasek': 'belt',
    'falbankami': 'ruffles', 'falbanki': 'ruffles',
    'falbaną': 'ruffle', 'falbana': 'ruffle',
    'nadrukiem': 'print', 'nadruk': 'print',
    'prążkowane': 'ribbed', 'prążkowany': 'ribbed',
    'w': 'in', 'kratkę': 'check', 'kratke': 'check',
    'paski': 'stripes', 'w paski': 'striped', 'striped': 'striped',
    'Kolor': 'Color', 'kolor': 'color',
    'granatowy': 'navy', 'czarny': 'black', 'biały': 'white', 'bialy': 'white',
    'czerwony': 'red', 'różowy': 'pink', 'rozowy': 'pink',
    'zielony': 'green', 'niebieski': 'blue', 'żółty': 'yellow', 'zolty': 'yellow',
    'szary': 'grey', 'brązowy': 'brown', 'brazowy': 'brown',
    'beżowy': 'beige', 'bezowy': 'beige', 'fioletowy': 'purple',
    'pomarańczowy': 'orange', 'pomaranczowy': 'orange', 'ecru': 'ecru',
  };
  return String(text || '')
    .split(/\s+/)
    .map((word) => {
      const lower = word.toLowerCase().replace(/[.,;:!?]$/, '');
      const suffix = word.slice(lower.length + word.length - word.replace(/[.,;:!?]$/, '').length);
      return (words[lower] || word) + suffix;
    })
    .join(' ')
    .trim();
}


function extractSinsayComposition(rawText = '') {
  const text = String(rawText || '').trim();
  if (!text) return '';
  const fibreRegex = /\d+\s*%\s*(?:bawełna|cotton|poliester|polyester|elastan|elastane|wiskoza|viscose|len|linen|wełna|wool|jedwab|silk|nylon|poliamid|polyamide|akryl|acrylic|lyocell|modal|tencel|hemp|recycled)/i;
  const segments = text.split(/[\r\n]+|·|•|;/).map((s) => s.trim()).filter(Boolean);
  const seen = new Set();
  const lines = [];
  for (const seg of segments) {
    if (!fibreRegex.test(seg)) continue;
    const key = seg.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // Translate common Polish fibre names to English
    lines.push(
      seg
        .replace(/\bbawełna\b/gi, 'cotton')
        .replace(/\bpoliester\b/gi, 'polyester')
        .replace(/\belastan\b/gi, 'elastane')
        .replace(/\bwiskoza\b/gi, 'viscose')
        .replace(/\blen\b/gi, 'linen')
        .replace(/\bwełna\b/gi, 'wool')
        .replace(/\bjedwab\b/gi, 'silk')
        .replace(/\bpoliamid\b/gi, 'polyamide')
        .replace(/\bakryl\b/gi, 'acrylic'),
    );
  }
  return lines.join('\n');
}

async function dismissCommonSinsayPopups(page) {
  const selectors = [
    '#onetrust-accept-btn-handler',
    '#cookiescript_accept',
    'button[id*="accept" i][id*="cookie" i]',
    'button[data-testid*="accept" i]',
    '.cookie-consent button',
    '#cookie-law-info-bar button',
  ];
  for (const sel of selectors) {
    try {
      const btn = await page.$(sel);
      if (btn) { await btn.click({ delay: 60 }).catch(() => {}); await antiDetection.randomDelay(300, 500); }
    } catch { /* noop */ }
  }
  // text-based fallback
  await page.evaluate(() => {
    const textRe = /^\s*(?:accept|agree|ok|got\s+it|allow|akceptuj|zgadzam|zamknij|close)\s*$/i;
    [...document.querySelectorAll('button, [role="button"]')].forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return;
      const s = window.getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none') return;
      if (textRe.test(String(el.textContent || '').trim())) try { el.click(); } catch { /* noop */ }
    });
  }).catch(() => {});
  await antiDetection.randomDelay(400, 700);
}

async function openSinsaySearchOverlay(page) {
  const directSelectors = [
    'button[aria-label*="search" i]',
    'button[data-testid*="search" i]',
    'header button[class*="search" i]',
    '[class*="search-trigger" i]',
  ];
  for (const sel of directSelectors) {
    try {
      const h = await page.$(sel);
      if (h) { await h.click({ delay: 50 }).catch(() => {}); return true; }
    } catch { /* noop */ }
  }
  return page.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return false;
      const s = window.getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
    };
    const all = [...document.querySelectorAll('button, a, [role="button"]')];
    for (const el of all) {
      if (!isVisible(el)) continue;
      const haystack = [
        el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('data-testid'), el.className, el.id,
      ].join(' ').toLowerCase();
      if (/\bsearch\b/.test(haystack)) { try { el.click(); } catch { /* noop */ } return true; }
    }
    for (const el of all) {
      if (!isVisible(el)) continue;
      const text = String(el.textContent || '').trim();
      if (text.length < 30 && /^\s*(?:search|szukaj)\s*$/i.test(text)) { try { el.click(); } catch { /* noop */ } return true; }
    }
    return false;
  });
}

async function searchSinsayByTyping(page, query, emitLog, ensureActive) {
  emitLog(`    🔍 Searching Sinsay by typing "${query}"…`, 'info');
  try {
    await page.goto(SINSAY_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await dismissCommonSinsayPopups(page);
    await antiDetection.randomDelay(1500, 2200);
    ensureActive();

    emitLog('    🔎 Opening Sinsay search overlay…', 'info');
    let opened = await openSinsaySearchOverlay(page);
    if (!opened) {
      for (let attempt = 1; attempt <= 3 && !opened; attempt += 1) {
        await antiDetection.randomDelay(1200, 1800);
        opened = await openSinsaySearchOverlay(page);
      }
    }

    // Wait for search input with up to 12s
    let inputElement = null;
    try {
      await page.waitForFunction(() => {
        const isVisible = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          if (r.width < 20 || r.height < 6) return false;
          const s = window.getComputedStyle(el);
          return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
        };
        return [...document.querySelectorAll('input[type="search"], input[type="text"], input:not([type])')].some(isVisible);
      }, { timeout: 12000, polling: 350 });
      const handle = await page.evaluateHandle(() => {
        const isVisible = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          if (r.width < 20 || r.height < 6) return false;
          const s = window.getComputedStyle(el);
          return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
        };
        const inputs = [...document.querySelectorAll('input[type="search"], input[type="text"], input:not([type])')].filter(isVisible);
        return inputs.find((el) => /search|query|szukaj/i.test([el.getAttribute('placeholder'), el.getAttribute('name'), el.getAttribute('aria-label')].join(' '))) || inputs[0] || null;
      });
      inputElement = handle ? handle.asElement() : null;
    } catch { /* noop */ }

    if (!inputElement) {
      emitLog('    🔁 Sinsay search input not visible; reopening overlay…', 'info');
      await openSinsaySearchOverlay(page).catch(() => false);
      await antiDetection.randomDelay(2000, 3000);
      try {
        await page.waitForFunction(() => {
          const inputs = [...document.querySelectorAll('input[type="search"], input[type="text"], input:not([type])')];
          return inputs.some((el) => {
            const r = el.getBoundingClientRect(); const s = window.getComputedStyle(el);
            return r.width >= 20 && r.height >= 6 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
          });
        }, { timeout: 10000, polling: 350 });
        const handle = await page.evaluateHandle(() => {
          const isVisible = (el) => { const r = el.getBoundingClientRect(); const s = window.getComputedStyle(el); return r.width >= 20 && r.height >= 6 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'; };
          return [...document.querySelectorAll('input[type="search"], input[type="text"], input:not([type])')].find(isVisible) || null;
        });
        inputElement = handle ? handle.asElement() : null;
      } catch { /* noop */ }
    }

    if (!inputElement) {
      emitLog('    ⚠️ Sinsay search input did not appear; giving up.', 'warning');
      return '';
    }

    try { await inputElement.click({ delay: 80 }); } catch { await page.evaluate((el) => el.focus(), inputElement).catch(() => {}); }
    await antiDetection.randomDelay(300, 600);

    emitLog(`    ⌨️ Typing Sinsay search "${query}" via DOM write…`, 'info');
    await writeSearchValueViaDOM(page, inputElement, query, emitLog, 'Sinsay');

    // Verify the input actually contains the query. Sinsay's React
    // controlled input sometimes silently reverts the value after a
    // programmatic setter, leaving the search box visually empty. If we
    // detect that, fall back to character-by-character keyboard typing
    // which Sinsay's React store reliably picks up.
    const sinInputHasValue = await page.evaluate((el, q) => {
      const v = String(el?.value || '').trim().toLowerCase();
      return v.length > 0 && v.includes(String(q || '').toLowerCase());
    }, inputElement, query).catch(() => true);

    if (!sinInputHasValue) {
      emitLog('    🔁 Sinsay search input reverted to empty; retrying with keyboard typing…', 'info');
      try { await inputElement.click({ delay: 60 }); } catch { await page.evaluate((el) => el.focus(), inputElement).catch(() => {}); }
      await antiDetection.randomDelay(200, 400);
      try {
        await page.evaluate((el) => {
          try { el.select?.(); } catch { /* noop */ }
        }, inputElement).catch(() => {});
        await page.keyboard.press('Backspace').catch(() => {});
      } catch { /* noop */ }
      try {
        await page.keyboard.type(String(query || ''), { delay: 80 });
      } catch (err) {
        emitLog(`    ⚠️ Sinsay keyboard typing failed: ${err.message}`, 'warning');
      }
      await antiDetection.randomDelay(500, 900);
    }

    // Submit the search by pressing Enter on the real keyboard (trusted
    // event that Sinsay's keydown handler honors).
    try {
      await page.keyboard.press('Enter').catch(() => {});
    } catch { /* noop */ }

    emitLog('    ⏳ Waiting for Sinsay search results…', 'info');
    const queryLower = String(query || '').toLowerCase();
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => null),
      page.waitForFunction(
        (ql) => {
          const anchors = [...document.querySelectorAll('a[href*="sinsay.com"]')];
          return anchors.filter((a) => {
            const href = (a.href || '').toLowerCase();
            return href.includes(ql) || /sinsay\.com\/.+-[a-z0-9]+-[a-z0-9]+/i.test(href.split('?')[0]);
          }).length >= 2;
        },
        { timeout: 40000, polling: 600 },
        queryLower,
      ).catch(() => null),
    ]);
    await antiDetection.randomDelay(2200, 3600);
    ensureActive();

    // Auto-redirected straight to a single PDP?
    // Only accept if the URL looks like a product detail page (contains the
    // SKU in a slug position, not as a query-string search parameter).
    // Sinsay PDP URLs look like: /pl/pl/{category}/{slug}-{sku}
    const landed = page.url();
    const landedLower = landed.toLowerCase();
    const isSinsayPdp = (url) => {
      const cleaned = url.split('?')[0].split('#')[0];
      const productLinkRe = /sinsay\.com\/[^/]+\/[^/]+\/.+-[a-z0-9]+-[a-z0-9]+$/i;
      return productLinkRe.test(cleaned);
    };
    if (queryLower && landedLower.includes(queryLower.toLowerCase().replace(/\//g, '-')) && isSinsayPdp(landed)) {
      emitLog(`    ✅ Sinsay auto-navigated to PDP for "${query}"`, 'info');
      return landed;
    }

    // Click first matching product card
    const result = await page.evaluate((ql) => {
      const isVisible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 30 || r.height < 30) return false;
        const s = window.getComputedStyle(el);
        return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
      };
      const productLinkRe = /sinsay\.com\/.+-[a-z0-9]+-[a-z0-9]+$/i;
      const anchors = [...document.querySelectorAll('a[href]')]
        .filter((a) => isVisible(a) && productLinkRe.test((a.href || '').split('?')[0].split('#')[0]));
      if (!anchors.length) return { href: '', candidates: 0 };
      const qlCompact = String(ql || '').replace(/[\s-]/g, '');
      const cardMatchesSkuSinsay = (anchor) => {
        if (!ql) return false;
        const href = (anchor.href || '').toLowerCase();
        const hrefCompact = href.replace(/[\s-]/g, '');
        if (href.includes(ql) || (qlCompact && hrefCompact.includes(qlCompact))) return true;
        const card = anchor.closest('[class*="product" i]') ||
                     anchor.closest('[data-testid*="product" i]') ||
                     anchor.parentElement;
        if (card) {
          const cardText = (card.textContent || '').toLowerCase();
          const cardTextCompact = cardText.replace(/[\s-]/g, '');
          if (cardText.includes(ql) || (qlCompact && cardTextCompact.includes(qlCompact))) return true;
          const dataAttrs = ['data-sku', 'data-product-id', 'data-style',
                             'data-article', 'data-product-code', 'data-item-number'];
          for (const attr of dataAttrs) {
            const val = (card.getAttribute(attr) || '').toLowerCase();
            if (val && (val.includes(ql) ||
                        (qlCompact && val.replace(/[\s-]/g, '').includes(qlCompact)))) return true;
          }
          const imgs = card.querySelectorAll('img');
          for (const img of imgs) {
            const alt = (img.alt || '').toLowerCase();
            const src = (img.src || '').toLowerCase();
            if (alt.includes(ql) || src.includes(ql)) return true;
            if (qlCompact) {
              if (alt.replace(/[\s-]/g, '').includes(qlCompact) ||
                  src.replace(/[\s-]/g, '').includes(qlCompact)) return true;
            }
          }
        }
        return false;
      };
      let chosen = null;
      if (ql) {
        chosen = anchors.find(cardMatchesSkuSinsay);
        if (!chosen) {
          // SKU specified but no product URL/text matched — do NOT fall back to
          // anchors[0]. Clicking a non-matching card always leads to
          // rejection and wastes a navigation round-trip.
          return { href: '', candidates: anchors.length, noMatch: true };
        }
      } else {
        chosen = anchors[0];
      }
      chosen.scrollIntoView({ behavior: 'instant', block: 'center' });
      try { chosen.click(); } catch { /* noop */ }
      return { href: chosen.href, candidates: anchors.length };
    }, queryLower);

    if (result?.noMatch) {
      emitLog(`    🧭 Sinsay card click → candidates=${result?.candidates ?? 0}, none matched SKU "${queryLower}"`, 'info');
    } else {
      emitLog(`    🧭 Sinsay card click → candidates=${result?.candidates ?? 0}`, 'info');
    }
    if (!result?.href) {
      if (!result?.noMatch) emitLog('    ⚠️ No Sinsay product found in search results', 'warning');
      return '';
    }

    emitLog(`    🖱️ Clicked Sinsay search result card → ${result.href.split('/').slice(-1)[0]}`, 'info');
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null),
      page.waitForFunction((before) => location.href !== before, { timeout: 20000, polling: 400 }, page.url()).catch(() => null),
    ]);
    await antiDetection.randomDelay(1400, 2200);
    return page.url();
  } catch (error) {
    ensureActive();
    emitLog(`    ⚠️ Sinsay typed search failed: ${error.message}`, 'warning');
    return '';
  }
}

async function scrapeSinsayProduct(browser, reference, emitLog, ensureActive) {
  const sku = String(reference || '').trim();
  if (!sku) throw new Error(`Empty Sinsay reference: ${reference}`);

  // Build query variants: full SKU first, then prefix before first "-"
  const queries = [sku];
  const prefix = sku.split('-')[0];
  if (prefix && prefix !== sku) queries.push(prefix);

  let productUrl = '';
  const resolverPage = await browser.newPage();
  await antiDetection.applyRetailBrowsingProfile(resolverPage);
  await resolverPage.setViewport(antiDetection.getRandomViewport());
  await resolverPage.bringToFront().catch(() => {});

  try {
    for (const q of queries) {
      ensureActive();
      productUrl = await searchSinsayByTyping(resolverPage, q, emitLog, ensureActive);
      if (productUrl) break;
      emitLog(`    ↪ Sinsay "${q}" produced no real match; trying next variant…`, 'info');
    }
  } finally {
    await resolverPage.close().catch(() => {});
  }

  if (!productUrl) throw new Error(`Product not found on Sinsay for reference: ${sku}`);

  // ── Firecrawl mode check ──────────────────────────────────────
  const currentMode = firecrawlService.getMode();
  if (currentMode === 'manual') {
    emitLog(` Sinsay ${reference || ''} 手动模式: 使用 Firecrawl 抓取`, 'warning');
    try {
      ensureActive();
      const fcResult = await firecrawlFallback.tryFirecrawlFallback(productUrl, {
        imageFilter: (imgUrl) => isLikelySinsayProductImage(imgUrl),
        urlNormalizer: (u) => u.split('?')[0],
        candidateIds: [sku],
        emitLog: (msg, type) => emitLog(`    ${msg}`, type),
      });

      // ─ Parse product text from Firecrawl HTML ────────────────────
      const html = fcResult.html || '';
      let name = '';
      let price = '';
      let description = '';
      let compositionText = null;

      const h1Match = html.match(/<h1[^>]*>(.*?)<\/h1>/is);
      if (h1Match) {
        name = h1Match[1].replace(/<[^>]+>/g, '').trim();
      }

      const priceMatch = html.match(/[€$£¥]([\d.,]+)/);
      if (priceMatch) {
        price = priceMatch[0];
      }

      const descPatterns = [
        /["']description["']?:\s*["']([^"']+)["']/i,
        /<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i,
      ];
      for (const pattern of descPatterns) {
        const m = html.match(pattern);
        if (m) {
          description = m[1].trim();
          break;
        }
      }

      const compPatterns = [
        /["']composition["']?:\s*["']([^"']+)["']/i,
        /["']materials["']?:\s*["']([^"']+)["']/i,
      ];
      for (const pattern of compPatterns) {
        const m = html.match(pattern);
        if (m) {
          compositionText = m[1].trim();
          break;
        }
      }

      return {
        styleNumber: sku,
        productId: sku,
        brand: 'Sinsay',
        name: name || `Sinsay ${sku}`,
        price,
        colorRef: '',
        description,
        composition: compositionText ? { outerShell: null, lining: null, other: compositionText } : null,
        url: productUrl,
        imageUrls: fcResult.imageUrls,
        usedEngine: 'firecrawl',
      };
    } catch (fcError) {
      emitLog(`❌ Sinsay ${reference || ''} Firecrawl 抓取失败: ${fcError.message}`, 'error');
      throw new Error(`Firecrawl failed: ${fcError.message}`);
    }
  }
  // ── End Firecrawl manual mode ───────────────────────────────────

  // Scrape the PDP
  const page = await browser.newPage();
  await antiDetection.applyRetailBrowsingProfile(page);
  await page.setViewport(antiDetection.getRandomViewport());
  await page.bringToFront().catch(() => {});

  const capturedUrls = new Set();
  page.on('response', (resp) => {
    const u = cleanImageUrl(resp.url());
    if (isLikelySinsayProductImage(u)) capturedUrls.add(u);
  });

  try {
    ensureActive();
    await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await antiDetection.randomDelay(2200, 3200);
    await dismissCommonSinsayPopups(page);
    await antiDetection.humanScroll(page, 2800);
    await antiDetection.randomDelay(700, 1100);

    // Expand "Composition and care" accordion
    const compHandle = await page.evaluateHandle(() => {
      const re = /^\s*(?:sk[łl]ad\s+i\s+piel[eę]gnacja|composition\s+and\s+care|sk[łl]ad|skład|composition)\s*$/i;
      const candidates = [...document.querySelectorAll('button, summary, [role="button"], h2, h3, h4, span, div')];
      const heading = candidates.find((el) => {
        const text = String(el.textContent || '').trim();
        return text.length < 80 && re.test(text);
      });
      if (!heading) return null;
      let cursor = heading;
      for (let depth = 0; depth < 5 && cursor; depth += 1) {
        if (cursor.matches('button, summary, [role="button"], details')) return cursor;
        cursor = cursor.parentElement;
      }
      return heading;
    }).catch(() => null);

    const compElement = compHandle ? compHandle.asElement() : null;
    if (compElement) {
      await page.evaluate((el) => { try { el.scrollIntoView({ behavior: 'instant', block: 'center' }); } catch { /* noop */ } }, compElement).catch(() => {});
      try { await compElement.click({ delay: 60 }); } catch { await page.evaluate((el) => el.click(), compElement).catch(() => {}); }
      await page.waitForFunction(
        () => /\d+\s*%\s*(?:bawełna|cotton|poliester|polyester|elastan|elastane|wiskoza|viscose|len|linen)/i.test(String(document.body?.innerText || '')),
        { timeout: 6000, polling: 300 },
      ).catch(() => {});
      await compHandle.dispose().catch(() => {});
      emitLog('    🧶 Clicked Sinsay Composition and care accordion', 'info');
    } else {
      emitLog('    ⚠️ Sinsay Composition and care button not found', 'warning');
    }
    await antiDetection.randomDelay(700, 1100);

    const info = await page.evaluate(() => {
      const bodyText = String(document.body?.innerText || '');
      const titleFromDocument = String(document.title || '').split(' | ')[0].split(' - ')[0].trim();

      // Collect all image candidates: src, currentSrc, data-src, data-lazy-src, srcset.
      // Sinsay lazy-loads gallery images via data-src, so img.src alone misses most shots.
      const domImages = [];
      const seen = new Set();
      const push = (u) => {
        if (!u) return;
        const clean = String(u || '').split(' ')[0].trim(); // srcset entries: "url 2x" → take first token
        if (clean && !seen.has(clean)) { seen.add(clean); domImages.push(clean); }
      };
      for (const img of document.querySelectorAll('img')) {
        push(img.currentSrc || img.src);
        push(img.getAttribute('data-src'));
        push(img.getAttribute('data-lazy'));
        push(img.getAttribute('data-lazy-src'));
        push(img.getAttribute('data-original'));
        // srcset: "url1 1x, url2 2x" — pick the largest (last) or all
        const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset') || '';
        if (srcset) {
          for (const part of srcset.split(',')) {
            push(part.trim().split(/\s+/)[0]);
          }
        }
      }
      // Also scan <source> elements inside <picture>
      for (const source of document.querySelectorAll('source[srcset], source[data-srcset]')) {
        const ss = source.getAttribute('srcset') || source.getAttribute('data-srcset') || '';
        for (const part of ss.split(',')) push(part.trim().split(/\s+/)[0]);
      }

      // Price
      let price = '';
      for (const sel of ['[itemprop="price"]', '[data-testid*="price" i]', '[class*="price" i]']) {
        const el = document.querySelector(sel);
        if (el) {
          const t = String(el.textContent || '').trim();
          if (/\d/.test(t) && /[€$£zł]|PLN|EUR|USD/i.test(t)) { price = t; break; }
        }
      }

      // Composition from body text
      const fibreRe = /\d+\s*%\s*(?:bawełna|cotton|poliester|polyester|elastan|elastane|wiskoza|viscose|len|linen|wełna|wool|jedwab|silk|nylon|poliamid|polyamide|akryl|acrylic|lyocell|modal)/i;
      const compNodes = [...document.querySelectorAll('div, section, ul, li, p, span')]
        .filter((el) => {
          const t = String(el.innerText || el.textContent || '').trim();
          return t.length > 0 && t.length < 800 && fibreRe.test(t);
        });
      let compositionFromDom = '';
      if (compNodes.length) {
        const seen = new Set();
        const lines = [];
        for (const node of compNodes) {
          const t = String(node.innerText || node.textContent || '').trim();
          if (!t || seen.has(t)) continue;
          seen.add(t); lines.push(t);
        }
        compositionFromDom = lines.join('\n');
      }

      return { title: titleFromDocument, price, domImages, compositionFromDom, pageText: bodyText.slice(0, 24000) };
    });

    const skuLower = String(sku || '').toLowerCase().replace('-', '-');
    const allCaptured = [...capturedUrls];
    const allDom = (info.domImages || []).map((u) => cleanImageUrl(u));
    const seen = new Set();
    const ordered = [];
    const push = (u) => {
      if (!u) return;
      const normalized = normalizeSinsayImageUrl(cleanImageUrl(u));
      if (!seen.has(normalized) && isRelevantSinsayProductImage(u, skuLower)) {
        seen.add(normalized);
        ordered.push(normalized);
      }
    };
    for (const u of allDom) push(u);
    for (const u of allCaptured) push(u);
    const imageUrls = ordered;

    const composition = extractSinsayComposition(info.compositionFromDom || '');
    const productName = translateSinsayProductName(info.title || '') || `Sinsay ${sku}`;

    emitLog(`✅ Sinsay ${sku} captured | ${productName} | ${imageUrls.length} images`, 'success');

    return {
      styleNumber: sku,
      productId: sku,
      brand: 'Sinsay',
      name: productName,
      price: info.price || '',
      colorRef: '',
      description: '',
      composition: composition ? { outerShell: null, lining: null, other: composition } : null,
      url: productUrl,
      imageUrls,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function runSinsayScraper(config, emitLog, emitProgress, taskController, previewBridge = null) {
  let { styleNumbers, excelPath, outputDir, downloadConcurrency } = config;
  styleNumbers = normalizeManualStyleNumbers(styleNumbers);
  const ensureActive = () => taskController?.throwIfCancelled?.();
  let browser = null;

  if (excelPath) {
    try {
      emitLog(`Reading Excel file: ${excelPath}`, 'info');
      const wb = XLSX.readFile(excelPath);
      const ws = wb.Sheets[wb.SheetNames[0]];
      styleNumbers = [];
      const range = XLSX.utils.decode_range(ws['!ref'] || 'A1:B1');
      for (let row = 1; row <= range.e.r; row += 1) {
        const cell = ws[XLSX.utils.encode_cell({ r: row, c: 1 })];
        if (cell) {
          const v = String(cell.w ?? cell.v ?? '').trim();
          if (v) styleNumbers.push(v);
        }
      }
      emitLog(`Loaded ${styleNumbers.length} Sinsay style numbers from Excel.`, 'success');
    } catch (error) {
      throw new Error(`Excel parse failed: ${error.message}`);
    }
  }

  ensureActive();
  if (!styleNumbers || styleNumbers.length === 0) throw new Error('No Sinsay style numbers provided.');

  const targetDir = !outputDir || outputDir === '未选择' ? path.join(app.getPath('desktop'), 'Sinsay') : outputDir;
  fs.mkdirSync(targetDir, { recursive: true });
  emitLog(`📁 Output directory: ${targetDir}`, 'info');
  emitLog('🌐 Launching the Sinsay scraper session...', 'info');

  let executablePath = findChromePath();
  if (!executablePath) {
    emitLog('⬇️ No local Chrome found. Downloading Chrome runtime…', 'warning');
    const chromeInstall = await ensureChromeRuntimeAvailable((p) => { if (p?.status) emitLog(p.status, p.phase === 'complete' ? 'success' : 'info'); });
    if (!chromeInstall?.success) throw new Error(chromeInstall?.error || 'Chrome download failed.');
    executablePath = chromeInstall.executablePath;
  }

  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: false,
      userDataDir: getSinsaySessionDir(),
      args: antiDetection.getRetailLaunchArgs(),
      ignoreDefaultArgs: ['--enable-automation'],
      defaultViewport: null,
    });
    previewBridge?.attachToBrowser(browser);
    taskController?.onCancel(() => { if (browser && browser.isConnected()) browser.close().catch(() => {}); });

    const products = [];
    const total = styleNumbers.length;
    emitLog(`🚀 Sinsay: ${total} 个款号 (搜索框输入款号，第二轮去掉"-"之后的部分)`, 'warning');
    emitProgress(5);

    for (let i = 0; i < total; i += 1) {
      ensureActive();
      const ref = styleNumbers[i];
      emitLog(`🎯 Sinsay input raw: "${ref}"`, 'info');
      emitLog(`🔄 Processing Sinsay ${i + 1}/${total}: ${ref}`, 'warning');
      try {
        const result = await scrapeSinsayProduct(browser, ref, emitLog, ensureActive);
        products.push(result);
      } catch (error) {
        if (isCancellationError(error) || taskController?.cancelled) throw new TaskCancelledError();
        emitLog(`    ⚠️ Sinsay ${ref} failed: ${error.message}`, 'warning');
        products.push({ styleNumber: ref, productId: ref, url: '', error: error.message, imageUrls: [] });
      }
      emitProgress(5 + Math.round(((i + 1) / total) * 45));
      if (i < total - 1) await antiDetection.randomDelay(1500, 2500);
    }

    emitProgress(50);
    emitLog('🌐 Sinsay page extraction complete. Preparing image downloads...', 'warning');

    const success = products.filter((p) => p.imageUrls?.length > 0);
    const failed = products.filter((p) => !p.imageUrls?.length);
    emitLog(`📊 Sinsay summary: ${success.length} styles succeeded, ${failed.length} styles failed, ${success.reduce((s, p) => s + p.imageUrls.length, 0)} images collected.`, 'info');
    failed.forEach((p) => {
      emitLog(`    ❌ ${p.styleNumber} - ${p.error || 'No product images found'}`, 'error');
      emitLog(`       👉 建议人工下载: https://www.sinsay.com/pl/pl/?q=${encodeURIComponent(p.styleNumber)}`, 'warning');
    });

    const allTasks = [];
    for (const product of success) {
      ensureActive();
      const cleanSku = sanitizeFileSegment(String(product.productId || product.styleNumber || '').replace(/\//g, '-'), 'sinsay-item');
      const styleDir = path.join(targetDir, cleanSku);
      fs.mkdirSync(styleDir, { recursive: true });
      const classified = buildSinsayImageMap(product.imageUrls);
      for (const [label, imgUrl] of Object.entries(classified)) {
        const ext = getUrlExtension(imgUrl, '.jpg');
        const filename = `${cleanSku}_${label}${ext}`;
        const filePath = path.join(styleDir, filename);
        allTasks.push(() => {
          ensureActive();
          return downloadFile(imgUrl, filePath, { headers: { Referer: product.url || 'https://www.sinsay.com/', 'User-Agent': 'Mozilla/5.0' }, timeoutMs: 45000 })
            .then((size) => { if (size) emitLog(`    ⬇️ [saved] ${filename} (${size.toFixed(1)} KB)`); })
            .catch((error) => { emitLog(`    ❌ [failed] ${filename}: ${error.message}`, 'error'); });
        });
      }
      const infoData = { styleNumber: product.productId || product.styleNumber, brand: 'Sinsay', name: product.name, price: product.price, description: product.description || '', composition: product.composition || null, url: product.url, images: classified };
      fs.writeFileSync(path.join(styleDir, `${cleanSku}_info.json`), JSON.stringify(infoData, null, 2), 'utf-8');
      emitLog(`📄 Saved product metadata: ${cleanSku}_info.json`, 'success');
    }

    emitLog(`📦 Downloading ${allTasks.length} Sinsay images with ${downloadConcurrency} worker(s)...`, 'info');
    let done = 0;
    await parallelLimit(allTasks.map((t) => async () => { ensureActive(); await t(); done += 1; emitProgress(50 + Math.round((done / Math.max(allTasks.length, 1)) * 50)); }), downloadConcurrency);

    emitProgress(100);
    fs.writeFileSync(path.join(targetDir, 'summary.json'), JSON.stringify(products.map((p) => ({ styleNumber: p.productId || p.styleNumber, brand: 'Sinsay', name: p.name, price: p.price, composition: p.composition || null, images: p.imageUrls?.length || 0, error: p.error || null })), null, 2), 'utf-8');
    emitLog('📊 Saved summary.json', 'success');
    if (failed.length) {
      fs.writeFileSync(path.join(targetDir, 'failed_styles.json'), JSON.stringify(failed.map((p) => ({ styleNumber: p.productId || p.styleNumber, error: p.error || 'No product images found' })), null, 2), 'utf-8');
      emitLog('📄 Saved failed_styles.json', 'success');
    }
    emitLog(`🎉 Sinsay scraping finished. Files saved to: ${targetDir}`, 'success');
  } finally {
    if (browser && browser.isConnected()) await browser.close().catch(() => {});
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Urban Revivo (global.urbanrevivo.com) — top-right search icon opens a sidebar,
// type the SKU, click first result, scrape images + name + price + composition.
// Description from collapsible tabs, filtering OUT size / care / use cases / craft.
// Test SKU: UWJ750051
// ════════════════════════════════════════════════════════════════════════════

const URBAN_REVIVO_HOME_URL = 'https://global.urbanrevivo.com/?source_domain=United+States';

function normalizeUrbanRevivoImageUrl(url = '') {
  let u = String(url || '').trim();
  if (!u) return '';
  // Protocol-relative → https
  if (u.startsWith('//')) u = `https:${u}`;
  // Strip query string (Shopify appends ?v=timestamp)
  u = u.split('?')[0];
  // Strip Shopify CDN size suffix: "_160x", "_320x", "_1296x", "_75x" etc.
  // immediately before the file extension → collapses every resized variant
  // of the same image down to its single full-resolution master.
  u = u.replace(/_\d+x(?=\.(?:jpe?g|png|webp)$)/i, '');
  return u;
}

function isLikelyUrbanRevivoProductImage(url = '') {
  const v = String(url || '').toLowerCase();
  if (!/\.(?:jpe?g|png|webp)(?:\?|$)/i.test(v) && !/\/image\//i.test(v)) return false;
  return v.includes('urbanrevivo')
    || v.includes('uronline')
    || v.includes('ur-cdn')
    || v.includes('alicdn')
    || v.includes('aliyuncs')
    || v.includes('/cdn/shop/')
    || /\/(?:media|product|goods|spu|sku|images?|files)\//i.test(v);
}

function isRelevantUrbanRevivoProductImage(url = '', skuLower = '') {
  if (!isLikelyUrbanRevivoProductImage(url)) return false;
  const v = String(url || '').toLowerCase();
  // Exclude obvious non-product assets
  if (/sprite|placeholder|logo|icon|banner|promo|loading|blank|default|avatar|qrcode|payment|flag|swatch/i.test(v)) return false;
  // Exclude the "_pure" cutout/ghost variant (white-background packshot) and
  // tiny thumbnails — we want the on-model studio shots.
  if (/_pure(?:[._]|$)/i.test(v)) return false;
  if (!skuLower) return true;
  // Urban Revivo (Shopify) image filenames embed the SKU, e.g.
  // "UWJ750051RXA1.jpg". Match on the SKU (alphanumeric, ignore separators).
  const stylePart = skuLower.replace(/[^a-z0-9]/gi, '');
  const vCompact = v.replace(/[^a-z0-9]/gi, '');
  return v.includes(skuLower) || (stylePart.length >= 5 && vCompact.includes(stylePart));
}

function buildUrbanRevivoImageMap(imageUrls = []) {
  const list = [...imageUrls];
  const map = {};
  if (!list.length) return map;
  map.F = list[0];
  if (list.length > 1) map.B = list[list.length - 1];
  let extra = 1;
  for (let i = 1; i < list.length - 1; i += 1) {
    map[String(extra).padStart(2, '0')] = list[i];
    extra += 1;
  }
  return map;
}

function extractUrbanRevivoComposition(rawText = '') {
  const text = String(rawText || '').trim();
  if (!text) return '';
  const fibreRegex = /\d+\s*%\s*(?:cotton|polyester|elastane|spandex|viscose|rayon|linen|wool|silk|nylon|polyamide|acrylic|cashmere|lyocell|modal|tencel|hemp|cupro|acetate|ramie|polyurethane|pu\b|recycled|organic)/i;
  const segments = text.split(/[\r\n]+|·|•|;|,(?=\s*\d+\s*%)/).map((s) => s.trim()).filter(Boolean);
  const seen = new Set();
  const lines = [];
  for (const seg of segments) {
    if (!fibreRegex.test(seg)) continue;
    const key = seg.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(seg);
  }
  return lines.join('\n');
}

async function dismissCommonUrbanRevivoPopups(page) {
  const selectors = [
    '#onetrust-accept-btn-handler',
    'button[id*="accept" i][id*="cookie" i]',
    'button[data-testid*="accept" i]',
    '[class*="cookie" i] button',
    '[class*="consent" i] button',
    '[class*="privacy" i] button[class*="accept" i]',
    // Region selector ("you are visiting from…") — confirm / stay buttons
    '[class*="region" i] button',
    '[class*="country" i] button',
    '[class*="geo" i] button',
    '[class*="locale" i] button',
    // Newsletter / promo / subscribe modals
    '[class*="newsletter" i] [class*="close" i]',
    '[class*="subscribe" i] [class*="close" i]',
    '[class*="modal" i] [class*="close" i]',
    '[class*="popup" i] [class*="close" i]',
    '[class*="dialog" i] [class*="close" i]',
    '[class*="drawer" i] [class*="close" i]',
    '[aria-label*="close" i]',
    '[aria-label*="dismiss" i]',
    'button[class*="close" i]',
    'svg[class*="close" i]',
    'i[class*="close" i]',
    '[class*="mask" i]',
    '[class*="overlay" i][class*="close" i]',
  ];
  // Run two passes — a region modal often reveals a newsletter modal underneath.
  for (let pass = 0; pass < 2; pass += 1) {
    for (const sel of selectors) {
      try {
        const handles = await page.$$(sel);
        for (const btn of handles.slice(0, 3)) {
          const visible = await page.evaluate((el) => {
            if (!el) return false;
            const r = el.getBoundingClientRect();
            if (r.width < 6 || r.height < 6) return false;
            const s = window.getComputedStyle(el);
            return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
          }, btn).catch(() => false);
          if (visible) { await btn.click({ delay: 50 }).catch(() => {}); await antiDetection.randomDelay(200, 400); }
        }
      } catch { /* noop */ }
    }
    // text-based fallback for accept/close/keep-region
    await page.evaluate(() => {
      const textRe = /^\s*(?:accept(?:\s+all)?|agree|ok|okay|got\s+it|allow(?:\s+all)?|i\s+agree|continue|confirm|close|dismiss|no\s+thanks?|stay|keep|shop\s+now|×|✕|✖|x|关闭|确定|同意)\s*$/i;
      let clicked = 0;
      [...document.querySelectorAll('button, [role="button"], a, [class*="close" i]')].forEach((el) => {
        if (clicked > 6) return;
        const r = el.getBoundingClientRect();
        if (r.width < 6 || r.height < 6) return;
        const s = window.getComputedStyle(el);
        if (s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0') return;
        const t = String(el.textContent || el.getAttribute('aria-label') || '').trim();
        if (t.length <= 14 && textRe.test(t)) { try { el.click(); clicked += 1; } catch { /* noop */ } }
      });
    }).catch(() => {});
    // Press Escape — closes most modal/drawer overlays.
    await page.keyboard.press('Escape').catch(() => {});
    await antiDetection.randomDelay(300, 500);
  }
  await antiDetection.randomDelay(300, 500);
}

async function openUrbanRevivoSearchSidebar(page) {
  // 1. Try explicit search-icon selectors in the header (top-right).
  const directSelectors = [
    'header [aria-label*="search" i]',
    'header button[class*="search" i]',
    'header a[class*="search" i]',
    '[class*="header" i] [class*="search" i]',
    '[aria-label*="search" i]',
    'button[data-testid*="search" i]',
    '[class*="icon-search" i]',
    '[class*="search-icon" i]',
    'svg[class*="search" i]',
    'i[class*="search" i]',
  ];
  for (const sel of directSelectors) {
    try {
      const h = await page.$(sel);
      if (h) {
        await page.evaluate((el) => { try { el.scrollIntoView({ block: 'center' }); } catch { /* noop */ } }, h).catch(() => {});
        await h.click({ delay: 50 }).catch(async () => {
          await page.evaluate((el) => el.click(), h).catch(() => {});
        });
        return true;
      }
    } catch { /* noop */ }
  }
  // 2. DOM walk: any clickable element in the top region whose attrs mention search.
  return page.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 6 || r.height < 6) return false;
      const s = window.getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
    };
    const clickable = [...document.querySelectorAll('button, a, [role="button"], svg, i, span, div')];
    // Prefer elements in the top 140px (header zone), right half of viewport.
    const vw = window.innerWidth || 1280;
    const scored = [];
    for (const el of clickable) {
      if (!isVisible(el)) continue;
      const haystack = [
        el.getAttribute && el.getAttribute('aria-label'),
        el.getAttribute && el.getAttribute('title'),
        el.getAttribute && el.getAttribute('data-testid'),
        el.getAttribute && el.getAttribute('class'),
        el.id,
      ].filter(Boolean).join(' ').toLowerCase();
      if (!/\bsearch\b|搜索|放大镜|magnif/i.test(haystack)) continue;
      const r = el.getBoundingClientRect();
      const topScore = r.top < 160 ? 0 : 1;
      const rightScore = r.left > vw / 2 ? 0 : 1;
      scored.push({ el, score: topScore * 2 + rightScore, top: r.top });
    }
    scored.sort((a, b) => a.score - b.score || a.top - b.top);
    if (scored.length) { try { scored[0].el.click(); } catch { /* noop */ } return true; }
    return false;
  });
}

async function findVisibleUrbanRevivoSearchInput(page) {
  return page.evaluateHandle(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 6) return false;
      const s = window.getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
    };
    const inputs = [...document.querySelectorAll(
      'input[type="search"], input[type="text"], input:not([type]), textarea',
    )].filter(isVisible);
    const ranked = inputs.find((el) => {
      const h = [el.getAttribute('placeholder'), el.getAttribute('name'), el.getAttribute('aria-label'), el.getAttribute('id'), el.className].join(' ').toLowerCase();
      return /search|query|keyword|搜索/i.test(h);
    });
    return ranked || inputs[0] || null;
  });
}

async function searchUrbanRevivoByTyping(page, query, emitLog, ensureActive) {
  emitLog(`    🔍 Searching Urban Revivo for "${query}"…`, 'info');
  const queryStr = String(query || '');
  const skuLower = queryStr.toLowerCase().replace(/[^a-z0-9]/gi, '');

  // Helper: scan the current page for a /products/ link whose slug contains the
  // SKU, click it, and return the resolved PDP URL (or '' if none).
  const clickSkuResult = async () => {
    const result = await page.evaluate((sku) => {
      const isVisible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 10 || r.height < 10) return false;
        const s = window.getComputedStyle(el);
        return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
      };
      const anchors = [...document.querySelectorAll('a[href]')];
      const skuMatch = anchors.find((a) => {
        const href = (a.href || '').toLowerCase();
        return href.includes('/products/') && href.replace(/[^a-z0-9]/gi, '').includes(sku);
      });
      const productsOnPage = anchors.filter((a) => /\/products\//i.test(a.href || '')).length;
      if (!skuMatch) return { href: '', candidates: productsOnPage };
      if (isVisible(skuMatch)) skuMatch.scrollIntoView({ behavior: 'instant', block: 'center' });
      const href = skuMatch.href;
      try { skuMatch.click(); } catch { /* noop */ }
      return { href, candidates: anchors.length };
    }, skuLower);
    return result;
  };

  // ── Primary path: Shopify's canonical /search?q= URL. Urban Revivo is a
  // Shopify storefront, so this returns the product grid without needing to
  // touch the search icon, sidebar, pop-ups, or a React-controlled input.
  try {
    const searchUrl = `https://global.urbanrevivo.com/search?q=${encodeURIComponent(queryStr)}&options%5Bprefix%5D=last`;
    emitLog(`    🌐 Opening Urban Revivo search results page directly…`, 'info');
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await dismissCommonUrbanRevivoPopups(page);
    await antiDetection.randomDelay(1500, 2400);
    ensureActive();

    // If the search auto-redirected straight to the PDP, accept it.
    const landed = page.url();
    if (/\/products\//i.test(landed) && landed.toLowerCase().replace(/[^a-z0-9]/gi, '').includes(skuLower)) {
      emitLog('    ✅ Urban Revivo search resolved directly to the product page', 'info');
      return landed;
    }

    // Wait for product grid anchors to render.
    await page.waitForFunction(
      (sku) => [...document.querySelectorAll('a[href]')].some((a) => {
        const href = (a.href || '').toLowerCase();
        return href.includes('/products/') && href.replace(/[^a-z0-9]/gi, '').includes(sku);
      }),
      { timeout: 12000, polling: 500 },
      skuLower,
    ).catch(() => null);
    await antiDetection.randomDelay(1200, 2000);
    ensureActive();

    const direct = await clickSkuResult();
    emitLog(`    🧭 Urban Revivo direct search → matched=${direct?.href ? 'yes' : 'no'} products-on-page=${direct?.candidates ?? 0}`, 'info');
    if (direct?.href) {
      emitLog(`    🖱️ Opening → ${direct.href.split('/').slice(-1)[0].slice(0, 60)}`, 'info');
      await Promise.race([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null),
        page.waitForFunction((before) => location.href !== before, { timeout: 20000, polling: 400 }, page.url()).catch(() => null),
      ]);
      await antiDetection.randomDelay(1400, 2200);
      const finalUrl = page.url();
      if (/\/products\//i.test(finalUrl) && finalUrl.toLowerCase().replace(/[^a-z0-9]/gi, '').includes(skuLower)) return finalUrl;
      if (/\/products\//i.test(direct.href) && direct.href.toLowerCase().replace(/[^a-z0-9]/gi, '').includes(skuLower)) return direct.href;
    }
    emitLog('    ↪ Direct search produced no SKU match; trying the on-site search sidebar…', 'info');
  } catch (error) {
    ensureActive();
    emitLog(`    ⚠️ Urban Revivo direct search failed: ${error.message}; trying sidebar…`, 'warning');
  }

  // ── Fallback path: open the search sidebar and type (original approach).
  try {
    await page.goto(URBAN_REVIVO_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await dismissCommonUrbanRevivoPopups(page);
    await antiDetection.randomDelay(1500, 2400);
    ensureActive();

    emitLog('    🔎 Opening Urban Revivo search sidebar…', 'info');
    let opened = await openUrbanRevivoSearchSidebar(page);
    if (!opened) {
      for (let attempt = 1; attempt <= 3 && !opened; attempt += 1) {
        await antiDetection.randomDelay(1200, 1800);
        await dismissCommonUrbanRevivoPopups(page);
        opened = await openUrbanRevivoSearchSidebar(page);
      }
    }

    // Wait for the search input to slide in (sidebar animates).
    let inputElement = null;
    try {
      await page.waitForFunction(() => {
        const isVisible = (el) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          if (r.width < 20 || r.height < 6) return false;
          const s = window.getComputedStyle(el);
          return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
        };
        return [...document.querySelectorAll('input[type="search"], input[type="text"], input:not([type]), textarea')].some(isVisible);
      }, { timeout: 12000, polling: 350 });
      const handle = await findVisibleUrbanRevivoSearchInput(page);
      inputElement = handle ? handle.asElement() : null;
    } catch { /* noop */ }

    if (!inputElement) {
      emitLog('    🔁 Urban Revivo search input not visible; retrying sidebar…', 'info');
      await openUrbanRevivoSearchSidebar(page).catch(() => false);
      await antiDetection.randomDelay(2000, 3000);
      try {
        await page.waitForFunction(() => {
          const inputs = [...document.querySelectorAll('input[type="search"], input[type="text"], input:not([type]), textarea')];
          return inputs.some((el) => {
            const r = el.getBoundingClientRect();
            const s = window.getComputedStyle(el);
            return r.width >= 20 && r.height >= 6 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
          });
        }, { timeout: 10000, polling: 350 });
        const handle = await findVisibleUrbanRevivoSearchInput(page);
        inputElement = handle ? handle.asElement() : null;
      } catch { /* noop */ }
    }

    if (!inputElement) {
      emitLog('    ⚠️ Urban Revivo search input did not appear; giving up.', 'warning');
      return '';
    }

    // Dismiss any pop-up that appeared while the sidebar animated in, then
    // focus + type into the actual input element (page-level keyboard can be
    // swallowed by a modal that stole focus).
    await dismissCommonUrbanRevivoPopups(page);
    try { await inputElement.click({ delay: 80 }); } catch { await page.evaluate((el) => el.focus(), inputElement).catch(() => {}); }
    await antiDetection.randomDelay(300, 600);
    await page.keyboard.down('Meta').catch(() => {}); await page.keyboard.press('A').catch(() => {}); await page.keyboard.up('Meta').catch(() => {});
    await page.keyboard.down('Control').catch(() => {}); await page.keyboard.press('A').catch(() => {}); await page.keyboard.up('Control').catch(() => {});
    await page.keyboard.press('Backspace').catch(() => {});

    emitLog(`    ⌨️ Typing Urban Revivo search "${query}"…`, 'info');
    const queryStr = String(query || '');
    // Type via the element handle so focus is re-asserted, then verify the
    // value actually landed; retry up to 3× (modals / re-renders drop chars).
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { await inputElement.type(queryStr, { delay: 110 }); }
      catch { await page.keyboard.type(queryStr, { delay: 110 }); }
      await antiDetection.randomDelay(400, 700);
      const current = await page.evaluate((el) => {
        try { return String(el?.value ?? el?.textContent ?? ''); } catch { return ''; }
      }, inputElement).catch(() => '');
      if (current.replace(/\s+/g, '').toLowerCase() === queryStr.replace(/\s+/g, '').toLowerCase()) break;
      // Clear and retry
      emitLog(`    🔁 Search input has "${current}"; refocusing and retyping…`, 'info');
      await dismissCommonUrbanRevivoPopups(page);
      try { await inputElement.click({ delay: 60 }); } catch { /* noop */ }
      await page.evaluate((el) => {
        try {
          const proto = Object.getPrototypeOf(el);
          const desc = Object.getOwnPropertyDescriptor(proto, 'value') || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
          if (desc && desc.set) desc.set.call(el, ''); else el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } catch { /* noop */ }
      }, inputElement).catch(() => {});
      await antiDetection.randomDelay(200, 400);
    }
    await antiDetection.randomDelay(700, 1100);
    await page.keyboard.press('Enter').catch(() => {});

    emitLog('    ⏳ Waiting for Urban Revivo search results…', 'info');
    const queryLower = queryStr.toLowerCase();
    // Urban Revivo product detail URLs: /products/<slug>-<sku> (plural, SKU at end)
    const skuLower = queryLower.replace(/[^a-z0-9]/gi, '');
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => null),
      page.waitForFunction(
        (sku) => {
          const anchors = [...document.querySelectorAll('a[href]')];
          return anchors.some((a) => {
            const href = (a.href || '').toLowerCase().replace(/[^a-z0-9]/gi, '');
            return /products/.test((a.href || '').toLowerCase()) && href.includes(sku);
          });
        },
        { timeout: 30000, polling: 600 },
        skuLower,
      ).catch(() => null),
    ]);
    await antiDetection.randomDelay(2000, 3200);
    await dismissCommonUrbanRevivoPopups(page);
    ensureActive();

    // If a single search result auto-navigated us to the PDP, accept it.
    const landed = page.url();
    if (/\/products\//i.test(landed) && landed.toLowerCase().replace(/[^a-z0-9]/gi, '').includes(skuLower)) {
      emitLog(`    ✅ Urban Revivo auto-navigated to PDP for "${query}"`, 'info');
      return landed;
    }

    // Click the search result whose href contains the SKU. NEVER fall back to
    // an unrelated tile — if no SKU-matching product exists, report failure.
    const result = await page.evaluate((sku) => {
      const isVisible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 20 || r.height < 20) return false;
        const s = window.getComputedStyle(el);
        return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
      };
      const anchors = [...document.querySelectorAll('a[href]')].filter(isVisible);
      // Strong match: /products/ slug containing the SKU (alphanumeric compare).
      const skuMatch = anchors.find((a) => {
        const href = (a.href || '').toLowerCase();
        return href.includes('/products/') && href.replace(/[^a-z0-9]/gi, '').includes(sku);
      });
      const chosen = skuMatch || null;
      if (!chosen) {
        const total = anchors.filter((a) => /\/products\//i.test(a.href || '')).length;
        return { href: '', candidates: total };
      }
      chosen.scrollIntoView({ behavior: 'instant', block: 'center' });
      try { chosen.click(); } catch { /* noop */ }
      return { href: chosen.href, candidates: anchors.length };
    }, skuLower);

    emitLog(`    🧭 Urban Revivo card click → matched=${result?.href ? 'yes' : 'no'} products-on-page=${result?.candidates ?? 0}`, 'info');
    if (!result?.href) {
      emitLog(`    ⚠️ No Urban Revivo product matching SKU "${query}" in results`, 'warning');
      return '';
    }

    emitLog(`    🖱️ Clicked Urban Revivo result → ${result.href.split('/').slice(-1)[0].slice(0, 60)}`, 'info');
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null),
      page.waitForFunction((before) => location.href !== before, { timeout: 20000, polling: 400 }, page.url()).catch(() => null),
    ]);
    await antiDetection.randomDelay(1400, 2200);
    // Final guard: only return URLs that are actually a PDP for this SKU.
    const finalUrl = page.url();
    if (/\/products\//i.test(finalUrl) && finalUrl.toLowerCase().replace(/[^a-z0-9]/gi, '').includes(skuLower)) {
      return finalUrl;
    }
    if (/\/products\//i.test(result.href) && result.href.toLowerCase().replace(/[^a-z0-9]/gi, '').includes(skuLower)) {
      return result.href;
    }
    emitLog(`    ⚠️ Urban Revivo landed on a non-matching page (${finalUrl.split('/').slice(-1)[0].slice(0, 40)}); rejecting.`, 'warning');
    return '';
  } catch (error) {
    ensureActive();
    emitLog(`    ⚠️ Urban Revivo typed search failed: ${error.message}`, 'warning');
    return '';
  }
}

async function scrapeUrbanRevivoProduct(browser, reference, emitLog, ensureActive) {
  const sku = String(reference || '').trim();
  if (!sku) throw new Error(`Empty Urban Revivo reference: ${reference}`);

  const resolverPage = await browser.newPage();
  await antiDetection.applyRetailBrowsingProfile(resolverPage);
  await resolverPage.setViewport(antiDetection.getRandomViewport());
  await resolverPage.bringToFront().catch(() => {});

  let productUrl = '';
  try {
    ensureActive();
    productUrl = await searchUrbanRevivoByTyping(resolverPage, sku, emitLog, ensureActive);
  } finally {
    await resolverPage.close().catch(() => {});
  }

  if (!productUrl) throw new Error(`Product not found on Urban Revivo for reference: ${sku}`);

  // ── Firecrawl mode check ──────────────────────────────────────
  const currentMode = firecrawlService.getMode();
  if (currentMode === 'manual') {
    emitLog(` Urban Revivo ${reference || ''} 手动模式: 使用 Firecrawl 抓取`, 'warning');
    try {
      ensureActive();
      const fcResult = await firecrawlFallback.tryFirecrawlFallback(productUrl, {
        imageFilter: (imgUrl) => isLikelyUrbanRevivoProductImage(imgUrl),
        urlNormalizer: (u) => u.split('?')[0],
        candidateIds: [sku],
        emitLog: (msg, type) => emitLog(`    ${msg}`, type),
      });

      // ─ Parse product text from Firecrawl HTML ────────────────────
      const html = fcResult.html || '';
      let name = '';
      let price = '';
      let description = '';
      let compositionText = null;

      const h1Match = html.match(/<h1[^>]*>(.*?)<\/h1>/is);
      if (h1Match) {
        name = h1Match[1].replace(/<[^>]+>/g, '').trim();
      }

      const priceMatch = html.match(/[€$£¥]([\d.,]+)/);
      if (priceMatch) {
        price = priceMatch[0];
      }

      const descPatterns = [
        /["']description["']?:\s*["']([^"']+)["']/i,
        /<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i,
      ];
      for (const pattern of descPatterns) {
        const m = html.match(pattern);
        if (m) {
          description = m[1].trim();
          break;
        }
      }

      const compPatterns = [
        /["']composition["']?:\s*["']([^"']+)["']/i,
        /["']materials["']?:\s*["']([^"']+)["']/i,
      ];
      for (const pattern of compPatterns) {
        const m = html.match(pattern);
        if (m) {
          compositionText = m[1].trim();
          break;
        }
      }

      return {
        styleNumber: sku,
        productId: sku,
        brand: 'Urban Revivo',
        name: name || `Urban Revivo ${sku}`,
        price,
        colorRef: '',
        description,
        composition: compositionText ? { outerShell: null, lining: null, other: compositionText } : null,
        url: productUrl,
        imageUrls: fcResult.imageUrls,
        usedEngine: 'firecrawl',
      };
    } catch (fcError) {
      emitLog(`❌ Urban Revivo ${reference || ''} Firecrawl 抓取失败: ${fcError.message}`, 'error');
      throw new Error(`Firecrawl failed: ${fcError.message}`);
    }
  }
  // ── End Firecrawl manual mode ───────────────────────────────────

  const page = await browser.newPage();
  await antiDetection.applyRetailBrowsingProfile(page);
  await page.setViewport(antiDetection.getRandomViewport());
  await page.bringToFront().catch(() => {});

  const capturedUrls = new Set();
  page.on('response', (resp) => {
    const u = cleanImageUrl(resp.url());
    if (isLikelyUrbanRevivoProductImage(u)) capturedUrls.add(u);
  });

  try {
    ensureActive();
    await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await antiDetection.randomDelay(2200, 3200);
    await dismissCommonUrbanRevivoPopups(page);
    await antiDetection.humanScroll(page, 3000);
    await antiDetection.randomDelay(800, 1200);

    // Expand all collapsible tabs/accordions on the PDP so description +
    // composition text materialises. We click everything that looks like an
    // accordion header, then filter content afterwards.
    await page.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const headers = [...document.querySelectorAll(
        '[class*="accordion" i] [class*="header" i], [class*="accordion" i] [class*="title" i],'
        + ' [class*="collapse" i] [class*="header" i], [class*="collaps" i] [class*="title" i],'
        + ' [class*="tab" i] [class*="header" i], summary, [role="button"][aria-expanded],'
        + ' [class*="detail" i] [class*="title" i], [class*="param" i] [class*="title" i],'
        + ' [class*="foldable" i], [class*="expand" i]',
      )];
      for (const h of headers) {
        try {
          const r = h.getBoundingClientRect();
          if (r.width < 8 || r.height < 8) continue;
          h.scrollIntoView({ block: 'center' });
          h.click();
          await sleep(180);
        } catch { /* noop */ }
      }
    }).catch(() => {});
    await antiDetection.randomDelay(800, 1200);
    emitLog('    🧶 Expanded Urban Revivo description tabs', 'info');

    const info = await page.evaluate(() => {
      const bodyText = String(document.body?.innerText || '');
      const titleFromDocument = String(document.title || '').split('|')[0].split(' - ')[0].trim();

      // Image candidates: src, currentSrc, data-src, srcset, <source>.
      const domImages = [];
      const seen = new Set();
      const push = (u) => {
        if (!u) return;
        const clean = String(u || '').split(' ')[0].trim();
        if (clean && !seen.has(clean)) { seen.add(clean); domImages.push(clean); }
      };
      for (const img of document.querySelectorAll('img')) {
        push(img.currentSrc || img.src);
        push(img.getAttribute('data-src'));
        push(img.getAttribute('data-original'));
        push(img.getAttribute('data-lazy'));
        const ss = img.getAttribute('srcset') || img.getAttribute('data-srcset') || '';
        for (const part of ss.split(',')) push(part.trim().split(/\s+/)[0]);
      }
      for (const source of document.querySelectorAll('source[srcset], source[data-srcset]')) {
        const ss = source.getAttribute('srcset') || source.getAttribute('data-srcset') || '';
        for (const part of ss.split(',')) push(part.trim().split(/\s+/)[0]);
      }

      // Product name
      let name = '';
      for (const sel of ['h1', '[class*="product-name" i]', '[class*="productName" i]', '[class*="goods-name" i]', '[class*="title" i]']) {
        const el = document.querySelector(sel);
        if (el) {
          const t = String(el.textContent || '').trim();
          if (t.length >= 3 && t.length < 160) { name = t; break; }
        }
      }

      // Price
      let price = '';
      for (const sel of ['[class*="price" i]', '[itemprop="price"]', '[data-testid*="price" i]']) {
        const el = document.querySelector(sel);
        if (el) {
          const t = String(el.textContent || '').trim();
          if (/\d/.test(t) && /[€$£¥]|USD|EUR|GBP|CNY|RMB/i.test(t)) { price = t; break; }
        }
      }

      // Style number — from URL slug or page text
      let styleNumber = '';
      const skuMatch = bodyText.match(/\b([A-Z]{2,4}\d{5,})\b/);
      if (skuMatch) styleNumber = skuMatch[1];

      // Composition — fibre lines anywhere in expanded content
      const fibreRe = /\d+\s*%\s*(?:cotton|polyester|elastane|spandex|viscose|rayon|linen|wool|silk|nylon|polyamide|acrylic|cashmere|lyocell|modal|tencel|hemp|cupro|acetate|ramie|polyurethane|recycled|organic)/i;
      let compositionFromDom = '';
      const compNodes = [...document.querySelectorAll('div, section, ul, li, p, span, td')]
        .filter((el) => {
          const t = String(el.innerText || el.textContent || '').trim();
          return t.length > 0 && t.length < 600 && fibreRe.test(t);
        });
      if (compNodes.length) {
        const cseen = new Set();
        const lines = [];
        for (const node of compNodes) {
          const t = String(node.innerText || node.textContent || '').trim();
          if (!t || cseen.has(t)) continue;
          cseen.add(t); lines.push(t);
        }
        compositionFromDom = lines.join('\n');
      }

      // Description — Urban Revivo's Description tab is structured as labeled
      // lines: "Design: ..." and "Details: ...". Target those labels directly
      // (most reliable), excluding size / care / use cases / craft / shipping.
      let descriptionFromDom = '';
      (() => {
        const wantLabel = /^(?:design|details?|features?|highlights?|fabric\s+story)\s*[:：]/i;
        const banWords = /\b(?:shipping|returns?|delivery|size\s*(?:&|guide|chart|fit)|sizing|measurements?|care\b|care\s+instructions?|washing|use\s+cases?|how\s+to\s+(?:wear|use|style)|craft(?:s|smanship)?|payment|review)\b/i;
        const labeled = [];
        const seenLab = new Set();
        for (const el of document.querySelectorAll('p, li, div, span, td, dd, dt, h3, h4, h5')) {
          const t = String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
          if (!t || t.length > 400) continue;
          if (!wantLabel.test(t)) continue;
          if (banWords.test(t)) continue;
          // Skip container elements that swallowed multiple labeled sections
          if ((t.match(/[:：]/g) || []).length > 3) continue;
          const key = t.toLowerCase();
          if (seenLab.has(key)) continue;
          seenLab.add(key);
          labeled.push(t);
        }
        if (labeled.length) {
          const rank = (s) => (/^design/i.test(s) ? 0 : /^details?/i.test(s) ? 1 : 2);
          labeled.sort((a, b) => rank(a) - rank(b));
          descriptionFromDom = labeled.join('\n');
          return;
        }

        // Fallback: scope to the "Description" accordion panel and read only it.
        const descHeadingRe = /^\s*(?:product\s+)?description\s*$/i;
        const headers = [...document.querySelectorAll('button, summary, h2, h3, h4, [role="button"], [class*="title" i], [class*="header" i], [class*="tab" i]')];
        const descHeader = headers.find((el) => descHeadingRe.test(String(el.textContent || '').trim()) && String(el.textContent || '').trim().length < 40);
        if (descHeader) {
          // Find the panel: next sibling, or a nearby container holding the body
          let panel = descHeader.nextElementSibling;
          for (let i = 0; i < 4 && (!panel || String(panel.innerText || '').trim().length < 5); i += 1) {
            panel = panel ? panel.nextElementSibling : null;
          }
          if (!panel) {
            // climb to parent accordion item, take its non-header text
            let p = descHeader.parentElement;
            for (let i = 0; i < 4 && p; i += 1, p = p.parentElement) {
              const t = String(p.innerText || '').trim();
              if (t.length > 10 && t.length < 800) { panel = p; break; }
            }
          }
          if (panel) {
            const banLineRe = /\b(?:shipping|returns?|delivery|size\s*(?:&|guide|chart|fit)|sizing|measurements?|care\b|washing|use\s+cases?|how\s+to|craft|payment|review|model\s+is)\b/i;
            const lines = String(panel.innerText || '').split(/\n+/)
              .map((s) => s.replace(/\s+/g, ' ').trim())
              .filter((line) => {
                if (!line) return false;
                if (descHeadingRe.test(line)) return false;
                if (/^(?:less|more|show\s*(?:more|less)|read\s*more|expand|collapse)$/i.test(line)) return false;
                if (banLineRe.test(line)) return false;
                return true;
              });
            descriptionFromDom = lines.slice(0, 15).join('\n').trim();
          }
        }
      })();

      return { title: titleFromDocument, name, price, styleNumber, domImages, compositionFromDom, descriptionFromDom, pageText: bodyText.slice(0, 24000) };
    });

    const resolvedSku = info.styleNumber || sku;
    const skuLower = String(sku || '').toLowerCase();
    const allCaptured = [...capturedUrls];
    const allDom = (info.domImages || []).map((u) => cleanImageUrl(u));
    const ordSeen = new Set();
    const ordered = [];
    const pushImg = (u) => {
      if (!u) return;
      // Normalize first: collapses Shopify's dozens of _<N>x size variants of
      // the same master image into one URL, so dedup actually works.
      const c = normalizeUrbanRevivoImageUrl(cleanImageUrl(u));
      if (!c) return;
      if (!ordSeen.has(c) && isRelevantUrbanRevivoProductImage(c, skuLower)) { ordSeen.add(c); ordered.push(c); }
    };
    for (const u of allDom) pushImg(u);
    for (const u of allCaptured) pushImg(u);
    // Sort by the trailing image index in the filename (…RXA1, …RXA2 → 1,2,…)
    // so front/back/detail order is stable; unindexed images go last.
    const indexOf = (url) => {
      const m = String(url || '').match(/(\d+)\.(?:jpe?g|png|webp)$/i);
      return m ? Number(m[1]) : 9999;
    };
    ordered.sort((a, b) => indexOf(a) - indexOf(b) || String(a).localeCompare(String(b), undefined, { numeric: true }));
    let imageUrls = ordered;

    // If SKU-strict filtering found nothing, relax to "likely product images".
    if (imageUrls.length === 0) {
      const relaxed = [];
      const rseen = new Set();
      for (const u of [...allDom, ...allCaptured]) {
        const c = normalizeUrbanRevivoImageUrl(cleanImageUrl(u));
        if (!c) continue;
        if (!rseen.has(c)
          && isLikelyUrbanRevivoProductImage(c)
          && !/sprite|placeholder|logo|icon|banner|promo|loading|blank|default|avatar|qrcode|flag|swatch|_pure/i.test(c.toLowerCase())) {
          rseen.add(c); relaxed.push(c);
        }
      }
      relaxed.sort((a, b) => indexOf(a) - indexOf(b) || String(a).localeCompare(String(b), undefined, { numeric: true }));
      imageUrls = relaxed;
      if (relaxed.length) emitLog(`    ℹ️ Urban Revivo SKU-strict filter empty; using ${relaxed.length} likely product images.`, 'info');
    }

    const composition = extractUrbanRevivoComposition(info.compositionFromDom || '');
    const description = String(info.descriptionFromDom || '').trim();
    const productName = info.name || info.title || `Urban Revivo ${resolvedSku}`;

    emitLog(`✅ Urban Revivo ${resolvedSku} captured | ${productName} | ${imageUrls.length} images`, 'success');

    return {
      styleNumber: resolvedSku,
      productId: resolvedSku,
      brand: 'Urban Revivo',
      name: productName,
      price: info.price || '',
      colorRef: '',
      description,
      composition: composition ? { outerShell: null, lining: null, other: composition } : null,
      url: productUrl,
      imageUrls,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function runUrbanRevivoScraper(config, emitLog, emitProgress, taskController, previewBridge = null) {
  let { styleNumbers, excelPath, outputDir, downloadConcurrency } = config;
  styleNumbers = normalizeManualStyleNumbers(styleNumbers);
  const ensureActive = () => taskController?.throwIfCancelled?.();
  let browser = null;

  if (excelPath) {
    try {
      emitLog(`Reading Excel file: ${excelPath}`, 'info');
      const wb = XLSX.readFile(excelPath);
      const ws = wb.Sheets[wb.SheetNames[0]];
      styleNumbers = [];
      const range = XLSX.utils.decode_range(ws['!ref'] || 'A1:B1');
      for (let row = 1; row <= range.e.r; row += 1) {
        const cell = ws[XLSX.utils.encode_cell({ r: row, c: 1 })];
        if (cell) {
          const v = String(cell.w ?? cell.v ?? '').trim();
          if (v) styleNumbers.push(v);
        }
      }
      emitLog(`Loaded ${styleNumbers.length} Urban Revivo style numbers from Excel.`, 'success');
    } catch (error) {
      throw new Error(`Excel parse failed: ${error.message}`);
    }
  }

  ensureActive();
  if (!styleNumbers || styleNumbers.length === 0) throw new Error('No Urban Revivo style numbers provided.');

  const targetDir = !outputDir || outputDir === '未选择' ? path.join(app.getPath('desktop'), 'Urban Revivo') : outputDir;
  fs.mkdirSync(targetDir, { recursive: true });
  emitLog(`📁 Output directory: ${targetDir}`, 'info');
  emitLog('🌐 Launching the Urban Revivo scraper session...', 'info');

  let executablePath = findChromePath();
  if (!executablePath) {
    emitLog('⬇️ No local Chrome found. Downloading Chrome runtime…', 'warning');
    const chromeInstall = await ensureChromeRuntimeAvailable((p) => { if (p?.status) emitLog(p.status, p.phase === 'complete' ? 'success' : 'info'); });
    if (!chromeInstall?.success) throw new Error(chromeInstall?.error || 'Chrome download failed.');
    executablePath = chromeInstall.executablePath;
  }

  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: false,
      userDataDir: getUrbanRevivoSessionDir(),
      args: antiDetection.getRetailLaunchArgs(),
      ignoreDefaultArgs: ['--enable-automation'],
      defaultViewport: null,
    });
    previewBridge?.attachToBrowser(browser);
    taskController?.onCancel(() => { if (browser && browser.isConnected()) browser.close().catch(() => {}); });

    const products = [];
    const total = styleNumbers.length;
    emitLog(`🚀 Urban Revivo: ${total} 个款号 (右上角搜索图标 → 侧边栏输入款号)`, 'warning');
    emitProgress(5);

    for (let i = 0; i < total; i += 1) {
      ensureActive();
      const ref = styleNumbers[i];
      emitLog(`🎯 Urban Revivo input raw: "${ref}"`, 'info');
      emitLog(`🔄 Processing Urban Revivo ${i + 1}/${total}: ${ref}`, 'warning');
      try {
        const result = await scrapeUrbanRevivoProduct(browser, ref, emitLog, ensureActive);
        products.push(result);
      } catch (error) {
        if (isCancellationError(error) || taskController?.cancelled) throw new TaskCancelledError();
        emitLog(`    ⚠️ Urban Revivo ${ref} failed: ${error.message}`, 'warning');
        products.push({ styleNumber: ref, productId: ref, url: '', error: error.message, imageUrls: [] });
      }
      emitProgress(5 + Math.round(((i + 1) / total) * 45));
      if (i < total - 1) await antiDetection.randomDelay(1500, 2500);
    }

    emitProgress(50);
    emitLog('🌐 Urban Revivo page extraction complete. Preparing image downloads...', 'warning');

    const success = products.filter((p) => p.imageUrls?.length > 0);
    const failed = products.filter((p) => !p.imageUrls?.length);
    emitLog(`📊 Urban Revivo summary: ${success.length} styles succeeded, ${failed.length} styles failed, ${success.reduce((s, p) => s + p.imageUrls.length, 0)} images collected.`, 'info');
    failed.forEach((p) => {
      emitLog(`    ❌ ${p.styleNumber} - ${p.error || 'No product images found'}`, 'error');
      emitLog(`       👉 建议人工检查: ${URBAN_REVIVO_HOME_URL}`, 'warning');
    });

    const allTasks = [];
    for (const product of success) {
      ensureActive();
      const cleanSku = sanitizeFileSegment(String(product.productId || product.styleNumber || '').replace(/\//g, '-'), 'urbanrevivo-item');
      const styleDir = path.join(targetDir, cleanSku);
      fs.mkdirSync(styleDir, { recursive: true });
      const classified = buildUrbanRevivoImageMap(product.imageUrls);
      for (const [label, imgUrl] of Object.entries(classified)) {
        const ext = getUrlExtension(imgUrl, '.jpg');
        const filename = `${cleanSku}_${label}${ext}`;
        const filePath = path.join(styleDir, filename);
        allTasks.push(() => {
          ensureActive();
          return downloadFile(imgUrl, filePath, { headers: { Referer: product.url || URBAN_REVIVO_HOME_URL, 'User-Agent': 'Mozilla/5.0' }, timeoutMs: 45000 })
            .then((size) => { if (size) emitLog(`    ⬇️ [saved] ${filename} (${size.toFixed(1)} KB)`); })
            .catch((error) => { emitLog(`    ❌ [failed] ${filename}: ${error.message}`, 'error'); });
        });
      }
      const infoData = { styleNumber: product.productId || product.styleNumber, brand: 'Urban Revivo', name: product.name, price: product.price, description: product.description || '', composition: product.composition || null, url: product.url, images: classified };
      fs.writeFileSync(path.join(styleDir, `${cleanSku}_info.json`), JSON.stringify(infoData, null, 2), 'utf-8');
      emitLog(`📄 Saved product metadata: ${cleanSku}_info.json`, 'success');
    }

    emitLog(`📦 Downloading ${allTasks.length} Urban Revivo images with ${downloadConcurrency} worker(s)...`, 'info');
    let done = 0;
    await parallelLimit(allTasks.map((t) => async () => { ensureActive(); await t(); done += 1; emitProgress(50 + Math.round((done / Math.max(allTasks.length, 1)) * 50)); }), downloadConcurrency);

    emitProgress(100);
    fs.writeFileSync(path.join(targetDir, 'summary.json'), JSON.stringify(products.map((p) => ({ styleNumber: p.productId || p.styleNumber, brand: 'Urban Revivo', name: p.name, price: p.price, description: p.description || '', composition: p.composition || null, images: p.imageUrls?.length || 0, error: p.error || null })), null, 2), 'utf-8');
    emitLog('📊 Saved summary.json', 'success');
    if (failed.length) {
      fs.writeFileSync(path.join(targetDir, 'failed_styles.json'), JSON.stringify(failed.map((p) => ({ styleNumber: p.productId || p.styleNumber, error: p.error || 'No product images found' })), null, 2), 'utf-8');
      emitLog('📄 Saved failed_styles.json', 'success');
    }
    emitLog(`🎉 Urban Revivo scraping finished. Files saved to: ${targetDir}`, 'success');
  } finally {
    if (browser && browser.isConnected()) await browser.close().catch(() => {});
  }
}

// ════════════════════════════════════════════════════════════════════════════
// H&M (www2.hm.com) — direct product page, no search needed.
//   PDP: https://www2.hm.com/en_us/productpage.{article}.html
//   Article = 7-digit product id + 3-digit colour, e.g. 1342946001
// We open the PDP directly, expand the Description + Materials accordions, then
// extract: the paragraph description, the Composition lines (Shell / Embroidery
// / Lining …), and the highest-resolution product images for THIS colour only.
// ════════════════════════════════════════════════════════════════════════════

const HM_BASE_URL = 'https://www2.hm.com/en_us';

function buildHmProductUrl(article) {
  const digits = String(article || '').replace(/\D/g, '');
  return `${HM_BASE_URL}/productpage.${digits}.html`;
}

// H&M serves images two ways:
//   1. Modern static path:  https://image.hm.com/.../1342946001.jpg?imwidth=657
//   2. Legacy DAM endpoint:  https://lp2.hm.com/hmgoepprod?set=source[...]&...
// For (1) we strip the query and force a single large imwidth. For (2) we force
// the largest "imwidth" call style by appending/replacing imwidth, keeping the
// rest of the query intact (the asset is defined inside the query string).
function normalizeHmImageUrl(url = '') {
  let u = String(url || '').trim();
  if (!u) return '';
  if (u.startsWith('//')) u = `https:${u}`;
  if (u.startsWith('/')) u = `https://www2.hm.com${u}`;
  if (!/^https?:\/\//i.test(u)) return '';

  const qIndex = u.indexOf('?');
  const path = qIndex >= 0 ? u.slice(0, qIndex) : u;
  const query = qIndex >= 0 ? u.slice(qIndex + 1) : '';

  // Static product photo with a real image extension in the path.
  if (/\.(?:jpe?g|png|webp)$/i.test(path)) {
    return `${path}?imwidth=2160`;
  }

  // Legacy hmgoepprod DAM endpoint: asset lives in the query (set=source[...]).
  if (/hmgoepprod/i.test(path) && /set=/i.test(query)) {
    // Force the largest call/quality; H&M honours call=url[file:/product/...] +
    // a width via "call=url[...]" — simplest reliable lever is appending a big
    // imwidth, which their resizer respects.
    const stripped = query.replace(/(?:^|&)imwidth=\d+/gi, '').replace(/^&/, '');
    return `${path}?${stripped}${stripped ? '&' : ''}imwidth=2160`;
  }

  return '';
}

function hmImageDedupeKey(url = '') {
  const u = String(url || '');
  const low = u.toLowerCase();
  // Legacy DAM endpoint: the unique shot identity is the set=source[...] asset
  // path inside the query, not the (identical) base path. Key on that.
  if (/hmgoepprod/i.test(low)) {
    const m = low.match(/set=source\[([^\]]+)\]/i) || low.match(/source\[([^\]]+)\]/i);
    if (m) return `hmgoep:${m[1]}`;
    // Fall back to the whole query minus imwidth.
    const q = (u.split('?')[1] || '').replace(/(?:^|&)imwidth=\d+/gi, '');
    return `hmgoep:${q.toLowerCase()}`;
  }
  // Static photo: same shot at different imwidth → same key (path, no query).
  return low.split('?')[0];
}

function buildHmImageMap(imageUrls = []) {
  const list = [...imageUrls];
  const map = {};
  if (!list.length) return map;
  map.F = list[0];
  if (list.length > 1) map.B = list[list.length - 1];
  let n = 1;
  for (let i = 1; i < list.length - 1; i += 1) {
    map[String(n).padStart(2, '0')] = list[i];
    n += 1;
  }
  if (list.length === 2) delete map['01'];
  return map;
}

async function scrapeHmProduct(browser, reference, emitLog, ensureActive, reusePage = null, skipNavigation = false) {
  const article = String(reference || '').replace(/\D/g, '');
  if (!article) throw new Error(`Invalid H&M article number: ${reference}`);
  const colourCode = article.length >= 10 ? article.slice(-3) : '';
  const url = buildHmProductUrl(article);

  // ── Firecrawl mode check ────────────────────────────────────────
  const currentMode = firecrawlService.getMode();
  if (currentMode === 'manual') {
    emitLog(`🔥 H&M ${article} 手动模式: 使用 Firecrawl 抓取`, 'warning');
    try {
      ensureActive();
      const fcResult = await firecrawlFallback.tryFirecrawlFallback(url, {
        imageFilter: (imgUrl) => /image\.ltd|image\.hm\.com.*\.(jpg|jpeg|webp|png)/i.test(imgUrl),
        urlNormalizer: (u) => u.split('?')[0],
        candidateIds: [article],
        emitLog: (msg, type) => emitLog(`    ${msg}`, type),
      });

      // ── Parse product text from Firecrawl HTML ────────────────────
      const html = fcResult.html || '';
      let name = '';
      let price = '';
      let description = '';
      let composition = null;

      // Extract product name from <h1> tag
      const h1Match = html.match(/<h1[^>]*>(.*?)<\/h1>/is);
      if (h1Match) {
        name = h1Match[1].replace(/<[^>]+>/g, '').trim();
      }

      // Extract price (USD format)
      const priceMatch = html.match(/\$([\d.,]+)/);
      if (priceMatch) {
        price = `$${priceMatch[1]}`;
      }

      // Extract description - look for common patterns
      const descPatterns = [
        /["']description["']?:\s*["']([^"']+)["']/i,
        /<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i,
      ];
      for (const pattern of descPatterns) {
        const m = html.match(pattern);
        if (m) {
          description = m[1].trim();
          break;
        }
      }

      // Extract composition/materials
      const compPatterns = [
        /["']composition["']?:\s*["']([^"']+)["']/i,
        /["']materials["']?:\s*["']([^"']+)["']/i,
      ];
      for (const pattern of compPatterns) {
        const m = html.match(pattern);
        if (m) {
          composition = m[1].trim();
          break;
        }
      }

      return {
        articleNumber: article,
        productId: article,
        styleNumber: article,
        url,
        name,
        price,
        description,
        composition,
        imageUrls: fcResult.imageUrls,
        usedEngine: 'firecrawl',
      };
    } catch (fcError) {
      emitLog(`❌ H&M ${article} Firecrawl 抓取失败: ${fcError.message}`, 'error');
      throw new Error(`Firecrawl failed: ${fcError.message}`);
    }
  }
  // ── End Firecrawl manual mode ───────────────────────────────────

  // Reuse an existing page (e.g. the listing page) when provided, to avoid
  // creating many new tabs that trigger H&M bot detection. When reusePage
  // is null, we create a fresh tab (used by the regular H&M scraper).
  const page = reusePage || await browser.newPage();
  const ownsPage = !reusePage;  // only close the page if we created it
  try {
    // When reusing a page (bestseller flow), the page already has anti-detection
    // set up from the listing page. Only apply fresh profiles for new pages.
    if (ownsPage) {
      await antiDetection.applyRetailBrowsingProfile(page);
      await page.setUserAgent(antiDetection.getRandomUserAgent());
      await page.setViewport(antiDetection.getRandomViewport());
    }
    // When skipNavigation is true, the page is already on the product page
    // (e.g. we clicked through from the listing page). Skip goto().
    if (!skipNavigation) {
      emitLog(`    🌐 Opening H&M product page: ${url}`, 'info');
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      ensureActive();
      await antiDetection.randomDelay(1800, 2800);
    }

    // ── Detect blocked / Access Denied pages before doing any heavy work.
    // H&M's Akamai guard can return a plain "Access Denied" page that has
    // no product content at all; continuing to scrape it wastes time and
    // produces garbage.
    const isBlocked = await page.evaluate(() => {
      const bodyText = String(document.body?.innerText || '').trim();
      const h1 = String(document.querySelector('h1')?.textContent || '').trim();
      const title = String(document.title || '').trim();
      const blockedRe = /access\s*denied|403\s*forbidden|sorry.*blocked|request\s*blocked|bot\s*detect|security\s*check|unusual\s*activity|captcha/i;
      return blockedRe.test(bodyText) || blockedRe.test(h1) || blockedRe.test(title);
    }).catch(() => false);
    if (isBlocked) {
      emitLog(`    🚫 H&M ${article}: page is blocked (Access Denied / 403)`, 'warning');
      throw new Error('Access Denied: H&M blocked this page');
    }

    // Dismiss cookie / region pop-ups that can cover the accordions.
    // Retry up to 3 times if the frame gets detached during interaction.
    for (let dismissAttempt = 0; dismissAttempt < 3; dismissAttempt += 1) {
      try {
        await page.evaluate(() => {
          const texts = ['accept', 'agree', 'allow all', 'got it', 'continue', 'i accept', 'accept all'];
          const clickable = [...document.querySelectorAll('button, [role="button"], a')];
          for (const el of clickable) {
            const t = String(el.textContent || '').trim().toLowerCase();
            if (t && texts.some((x) => t === x || t.includes(x)) && t.length < 30) {
              try { el.click(); } catch { /* noop */ }
            }
          }
        });
        break; // success
      } catch (err) {
        if (/detached/i.test(String(err.message || ''))) {
          emitLog(`    ⚠️ H&M ${article}: frame detached during dismiss (attempt ${dismissAttempt + 1}/3), retrying…`, 'warning');
          await antiDetection.randomDelay(1500, 2500);
          // Re-navigate to the page if the frame was detached
          try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await antiDetection.randomDelay(1000, 2000);
          } catch { /* page might still be loading */ }
        } else throw err;
      }
    }
    await antiDetection.randomDelay(600, 1200);

    // Intercept XHR/API responses on the product page to capture image URLs
    // and product data that may not be in __NEXT_DATA__ (H&M sometimes serves
    // product details via separate API calls rather than embedding in page).
    const xhrImages = new Set();
    const xhrDescs = [];
    const xhrHandler = async (resp) => {
      const rUrl = resp.url();
      if (/\/api\/|hmwebservice|\/product|contentatom|graphql|pagebuilder/i.test(rUrl) && resp.status() === 200) {
        try {
          const ct = resp.headers()['content-type'] || '';
          if (!/json/i.test(ct)) return;
          const json = await resp.json();
          // Walk for H&M image CDN URLs
          const walkImg = (obj, depth) => {
            if (!obj || depth > 14) return;
            if (typeof obj === 'string') {
              if (/image\.hm\.com|hmgoepprod|lp\d?\.hm\.com/i.test(obj) && /\.(jpe?g|png|webp)/i.test(obj)) {
                xhrImages.add(obj.split('?')[0]);
              } else if (/image\.hm\.com\/.*product|hmgoepprod.*source/i.test(obj)) {
                // DAM URLs without explicit extension — keep full URL (query has set/source)
                xhrImages.add(obj);
              }
              return;
            }
            if (typeof obj !== 'object') return;
            const vals = Array.isArray(obj) ? obj : Object.values(obj);
            for (const v of vals) walkImg(v, depth + 1);
          };
          walkImg(json, 0);
          // Walk for description strings
          const walkDesc = (obj, depth) => {
            if (!obj || depth > 14) return;
            const entries = Array.isArray(obj) ? obj.map((v, i) => [i, v]) : Object.entries(obj || {});
            for (const [k, v] of entries) {
              if (typeof v === 'string' && /^(description|descriptiontext|detaildescription|productdescription)$/i.test(String(k)) && v.length > 25 && v.length < 1200) {
                xhrDescs.push(v);
              } else if (typeof v === 'object') walkDesc(v, depth + 1);
            }
          };
          walkDesc(json, 0);
        } catch { /* response body consumed or not JSON */ }
      }
    };
    page.on('response', xhrHandler);

    // Expand every accordion/disclosure (Description, Materials, etc.) so their
    // panel text is present in the DOM before we read it.
    // Retry on detached-frame errors — these happen when H&M's JS causes the
    // main frame to detach (e.g. auto-redirect or SPA re-mount).
    for (let pass = 0; pass < 2; pass += 1) {
      try {
        await page.evaluate(() => {
        const wanted = /description|details|materials?|composition|care|fit/i;
        const headers = [...document.querySelectorAll('button, summary, [role="button"], [aria-expanded]')];
        for (const el of headers) {
          const t = String(el.textContent || el.getAttribute('aria-label') || '').trim();
          if (!t || t.length > 40) continue;
          if (!wanted.test(t)) continue;
          const expanded = el.getAttribute('aria-expanded');
          if (expanded === 'false' || expanded === null) {
            try { el.click(); } catch { /* noop */ }
          }
        }
        for (const d of document.querySelectorAll('details:not([open])')) {
          try { d.setAttribute('open', ''); } catch { /* noop */ }
        }
      });
      } catch (err) {
        if (/detached/i.test(String(err.message || ''))) {
          emitLog(`    ⚠️ H&M ${article}: frame detached during expansion, re-navigating…`, 'warning');
          try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch { /* */ }
          await antiDetection.randomDelay(1500, 2500);
        } // else silently continue — .catch() was previously used anyway
      }
      await antiDetection.randomDelay(900, 1500);
    }
    ensureActive();
    emitLog('    🧶 Expanded H&M description / materials panels', 'info');

    // H&M lazy-loads gallery images; scroll through the page so real srcs swap
    // in before we read them, then give the network a moment to settle.
    await page.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const steps = 6;
      for (let i = 1; i <= steps; i += 1) {
        window.scrollTo(0, (document.body.scrollHeight * i) / steps);
        await sleep(400);
      }
      window.scrollTo(0, 0);
      await sleep(300);
    }).catch(() => {});
    await antiDetection.randomDelay(1000, 1600);
    ensureActive();

    // ── Main data extraction with retry for detached-frame errors ──
    // H&M's SPA can cause frame detachment during heavy page.evaluate() calls.
    // Retry up to 3 times, re-navigating the page on each failure.
    let data = null;
    for (let evalAttempt = 0; evalAttempt < 3; evalAttempt += 1) {
      try {
        data = await page.evaluate((colour) => {
      const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

      // ── Name ──
      let name = '';
      const h1 = document.querySelector('h1');
      if (h1) name = clean(h1.textContent);

      // ── Price ──
      let price = '';
      for (const el of document.querySelectorAll('[class*="price" i], [data-testid*="price" i]')) {
        const t = clean(el.textContent);
        if (/\d/.test(t) && /[$€£¥]|USD|EUR|GBP/i.test(t) && t.length < 30) { price = t; break; }
      }

      // ── Primary source: __NEXT_DATA__ embedded JSON. H&M is a Next.js site;
      // this blob holds the article's gallery + description. Strategy: find the
      // subtree(s) that mention THIS article and carry an image/gallery array,
      // then keep the one with the MOST images (that's the full gallery, not a
      // 1-image thumbnail reference or a recommendation card).
      let nextDesc = '';
      const nextImages = [];
      let nextDiag = 'no __NEXT_DATA__';
      try {
        const nd = document.getElementById('__NEXT_DATA__');
        if (nd && nd.textContent) {
          const root = JSON.parse(nd.textContent);
          const wantArticle = (colour && colour.article) ? String(colour.article).replace(/\D/g, '') : '';
          const isImgStr = (s) => typeof s === 'string' && /image\.hm\.com\/.+\.(?:jpe?g|png|webp)/i.test(s);
          const mentionsArticle = (obj) => {
            try { return wantArticle && JSON.stringify(obj).replace(/\D/g, '').includes(wantArticle); }
            catch { return false; }
          };

          // Recursively collect every image URL within a node.
          const collectImgs = (node, depth, sink) => {
            if (!node || depth > 16) return;
            if (typeof node === 'string') { if (isImgStr(node)) sink.add(node.split('?')[0]); return; }
            if (typeof node !== 'object') return;
            const children = Array.isArray(node) ? node : Object.values(node);
            for (const c of children) collectImgs(c, depth + 1, sink);
          };

          // Find the best article-scoped subtree: among object nodes that
          // mention the article AND contain images, pick the one yielding the
          // largest image set.
          let bestImgs = new Set();
          const scan = (node, depth) => {
            if (!node || depth > 14 || typeof node !== 'object' || Array.isArray(node)) {
              if (Array.isArray(node)) { for (const c of node) scan(c, depth + 1); }
              return;
            }
            if (mentionsArticle(node)) {
              const s = new Set();
              collectImgs(node, 0, s);
              if (s.size > bestImgs.size) bestImgs = s;
            }
            for (const v of Object.values(node)) scan(v, depth + 1);
          };
          scan(root, 0);

          // Fallback: if article-scoping found nothing, harvest the whole tree.
          if (bestImgs.size === 0) collectImgs(root, 0, bestImgs);
          for (const u of bestImgs) nextImages.push(u);

          // Description: collect description-keyed strings anywhere in the tree.
          const descCands = [];
          const collectDesc = (node, depth) => {
            if (!node || depth > 16 || typeof node !== 'object') return;
            const entries = Array.isArray(node) ? node.map((v, i) => [i, v]) : Object.entries(node);
            for (const [k, v] of entries) {
              if (typeof v === 'string') {
                const kl = String(k).toLowerCase();
                if (/^(?:description|descriptiontext|detaildescription|longdescription|productdescription)$/.test(kl) && v.length > 25 && v.length < 1200) descCands.push(v);
              } else { collectDesc(v, depth + 1); }
            }
          };
          collectDesc(root, 0);
          const banDescN = /cookie|consent|privacy|advertising|newsletter/i;
          nextDesc = descCands.map((s) => clean(s)).filter((s) => /[.!]/.test(s) && !banDescN.test(s)).sort((a, b) => a.length - b.length)[0] || '';
          nextDiag = `nextData imgs=${nextImages.length} descCands=${descCands.length}`;
        }
      } catch (e) {
        nextDiag = `nextData error: ${String(e).slice(0, 80)}`;
      }

      // ── JSON-LD Product schema: secondary source for description + images.
      let jsonLd = null;
      for (const block of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const parsed = JSON.parse(block.textContent || '{}');
          const nodes = Array.isArray(parsed) ? parsed : (parsed['@graph'] ? parsed['@graph'] : [parsed]);
          for (const node of nodes) {
            if (!node || typeof node !== 'object') continue;
            const type = node['@type'];
            const types = Array.isArray(type) ? type : [type];
            if (types.some((t) => String(t || '').toLowerCase() === 'product')) { jsonLd = node; break; }
          }
        } catch { /* skip */ }
        if (jsonLd) break;
      }

      // ── Description: prefer __NEXT_DATA__, then JSON-LD, then DOM disclosure.
      let description = '';
      const banDesc = /cookie|consent|data sharing|privacy|third part|advertising partner|accept all/i;
      if (nextDesc && !banDesc.test(nextDesc)) {
        description = nextDesc.split(/\s*\n\s*|\s{2,}/)[0].trim();
      }
      if (!description && jsonLd && jsonLd.description) {
        const raw = clean(jsonLd.description);
        if (raw && !banDesc.test(raw)) {
          description = raw.split(/\s*\n\s*|\s{2,}/)[0].trim();
        }
      }
      // DOM fallback: the paragraph under the "Description" disclosure only.
      if (!description) {
        const descRe = /^\s*description\s*$/i;
        const headers = [...document.querySelectorAll('button, summary, h2, h3, h4, [role="button"]')];
        const descHeader = headers.find((el) => descRe.test(clean(el.textContent)) && clean(el.textContent).length < 24);
        const looksLikeProse = (t) => t.length >= 25 && t.length < 600 && /[.!]/.test(t)
          && (t.match(/\s/g) || []).length >= 4
          && !banDesc.test(t)
          && !/^\s*(?:art\.\s*no|composition|shell|lining|imported|material)/i.test(t);
        const collectFrom = (root) => {
          if (!root) return '';
          const cands = [...root.querySelectorAll('p, span, div')]
            .map((el) => clean(el.textContent))
            .filter(looksLikeProse);
          return cands.sort((a, b) => a.length - b.length)[0] || '';
        };
        if (descHeader) {
          let panel = descHeader.nextElementSibling;
          for (let i = 0; i < 4 && (!panel || clean(panel.textContent).length < 20); i += 1) {
            panel = panel ? panel.nextElementSibling : null;
          }
          description = collectFrom(panel);
          if (!description) {
            let p = descHeader.parentElement;
            for (let i = 0; i < 4 && p && !description; i += 1, p = p.parentElement) {
              description = collectFrom(p);
            }
          }
        }
      }

      // ── Composition: lines like "Shell: Cotton 100%", "Embroidery: Polyester
      // 100%". Keep only well-formed "Part: Fibre NN%" rows; drop empties.
      let composition = '';
      const fibreLine = /^[A-Za-z][A-Za-z /&-]{1,30}:\s*[A-Za-z].*\d+\s*%/;
      const compLines = [];
      const seenComp = new Set();
      const pushComp = (raw) => {
        const t = clean(raw);
        if (!t || seenComp.has(t.toLowerCase())) return;
        if (fibreLine.test(t)) {
          seenComp.add(t.toLowerCase());
          compLines.push(t);
        }
      };
      for (const el of document.querySelectorAll('li, p, span, dd, div')) {
        const t = clean(el.textContent);
        if (t.length > 60) continue;
        pushComp(t);
      }
      if (compLines.length) composition = compLines.join('\n');

      // ── Images: prefer __NEXT_DATA__ (article-scoped), then JSON-LD, then DOM.
      const imgUrls = [];
      const pushImg = (u) => { const s = String(u || '').split(' ')[0].trim(); if (s) imgUrls.push(s); };
      for (const u of nextImages) pushImg(u);
      if (imgUrls.length === 0 && jsonLd && jsonLd.image) {
        const arr = Array.isArray(jsonLd.image) ? jsonLd.image : [jsonLd.image];
        for (const im of arr) {
          if (typeof im === 'string') pushImg(im);
          else if (im && im.url) pushImg(im.url);
          else if (im && im.contentUrl) pushImg(im.contentUrl);
        }
      }
      if (imgUrls.length === 0) {
        const gallery = document.querySelector('[class*="product-detail" i], [class*="ProductImages" i], [class*="gallery" i], main') || document.body;
        for (const img of gallery.querySelectorAll('img')) {
          pushImg(img.currentSrc || img.src);
          pushImg(img.getAttribute('data-src'));
          const ss = img.getAttribute('srcset') || '';
          const parts = ss.split(',').map((p) => p.trim().split(/\s+/)[0]).filter(Boolean);
          if (parts.length) pushImg(parts[parts.length - 1]);
        }
        for (const source of gallery.querySelectorAll('source[srcset]')) {
          const ss = source.getAttribute('srcset') || '';
          const parts = ss.split(',').map((p) => p.trim().split(/\s+/)[0]).filter(Boolean);
          if (parts.length) pushImg(parts[parts.length - 1]);
        }
      }

      const imgSource = nextImages.length ? 'next-data' : (jsonLd && jsonLd.image ? 'json-ld' : 'dom');
      return { name, price, description, composition, imgUrls, imgSource, nextDiag };
    }, { code: colourCode, article });
        break; // success — exit retry loop
      } catch (err) {
        if (/detached/i.test(String(err.message || '')) && evalAttempt < 2) {
          emitLog(`    ⚠️ H&M ${article}: frame detached during extraction (attempt ${evalAttempt + 1}/3), re-navigating…`, 'warning');
          try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); } catch { /* */ }
          await antiDetection.randomDelay(2000, 3000);
        } else if (/detached/i.test(String(err.message || ''))) {
          emitLog(`    ⚠️ H&M ${article}: frame detached 3 times, giving up on DOM extraction`, 'warning');
          // Fall through — we'll rely on XHR-intercepted data instead
          data = { name: '', price: '', description: '', composition: '', imgUrls: [], imgSource: 'xhr-fallback', nextDiag: 'detached-frame-retry-failed' };
        } else throw err;
      }
    }

    // ── Merge XHR-intercepted data as fallback ──
    // If the page evaluate failed or returned no images/description, supplement
    // with data captured from XHR/API responses.
    if (data) {
      const xhrImgArr = [...xhrImages];
      if (xhrImgArr.length && !(data.imgUrls?.length)) {
        data.imgUrls = xhrImgArr;
        data.imgSource = 'xhr';
      } else if (xhrImgArr.length && data.imgSource === 'dom') {
        // XHR images may have higher quality; merge them in
        const merged = [...data.imgUrls, ...xhrImgArr.filter((u) => !data.imgUrls.includes(u))];
        data.imgUrls = merged;
        data.imgSource = 'dom+xhr';
      }
      if (!data.description && xhrDescs.length) {
        const banDesc = /cookie|consent|data sharing|privacy|third part|advertising partner|accept all/i;
        const valid = xhrDescs.filter((s) => /[.!]/.test(s) && !banDesc.test(s));
        if (valid.length) data.description = valid[0].replace(/\s+/g, ' ').trim();
      }
    }

    emitLog(`    🔬 H&M source: images=${data.imgSource} (${data.nextDiag || 'n/a'}); xhr=${xhrImages.size} imgs/${xhrDescs.length} desc; dom desc=${data.description ? 'yes' : 'no'}`, 'info');

    // Normalize, keep only real H&M product photos for the current colour,
    // dedupe by shot. H&M CDN filenames do NOT contain the full article number,
    // so we filter by CDN host + product-image path rather than by article code.
    const seen = new Set();
    const imageUrls = [];
    for (const raw of data.imgUrls || []) {
      const norm = normalizeHmImageUrl(raw);
      if (!norm) continue;
      const low = norm.toLowerCase();
      // Must be an H&M product-image CDN URL.
      const isHmCdn = /(?:lp\d?\.hm\.com|image\.hm\.com|hmgoepprod|\.hm\.com\/)/i.test(low);
      if (!isHmCdn) continue;
      // Drop non-product assets (UI chrome, swatches, editorial, payment logos).
      if (/sprite|placeholder|logo|icon|banner|promo|loading|swatch|payment|flag|\/cms\/|campaign|editorial|sprites?/i.test(low)) continue;
      // Keep only real photo assets (the gallery region already scopes to the
      // current colour). Require a product-image-ish path/style param.
      if (!/(?:hmgoepprod|\/product\/|productpage|\bset=|imwidth=|\.(?:jpe?g|png|webp))/i.test(low)) continue;
      const key = hmImageDedupeKey(norm);
      if (seen.has(key)) continue;
      seen.add(key);
      imageUrls.push(norm);
    }

    emitLog(`    🖼️ H&M ${article}: ${imageUrls.length} product image(s) for colour ${colourCode || 'default'}`, 'info');

    // Remove XHR handler to avoid accumulating listeners when reusing page.
    page.off('response', xhrHandler);

    return {
      productId: article,
      styleNumber: article,
      colorRef: colourCode,
      name: data.name || '',
      price: data.price || '',
      description: data.description || '',
      composition: data.composition || '',
      url,
      imageUrls,
    };
  } catch (error) {
    throw error;
  } finally {
    if (ownsPage) await page.close().catch(() => {});
  }
}

async function runHmScraper(config, emitLog, emitProgress, taskController, previewBridge = null) {
  let { styleNumbers, excelPath, outputDir, downloadConcurrency } = config;
  styleNumbers = normalizeManualStyleNumbers(styleNumbers);
  const ensureActive = () => taskController?.throwIfCancelled?.();
  let browser = null;

  if (excelPath) {
    try {
      emitLog(`Reading Excel file: ${excelPath}`, 'info');
      const wb = XLSX.readFile(excelPath);
      const ws = wb.Sheets[wb.SheetNames[0]];
      styleNumbers = [];
      const range = XLSX.utils.decode_range(ws['!ref'] || 'A1:B1');
      for (let row = 1; row <= range.e.r; row += 1) {
        const cell = ws[XLSX.utils.encode_cell({ r: row, c: 1 })];
        if (cell) {
          const v = String(cell.w ?? cell.v ?? '').trim();
          if (v) styleNumbers.push(v);
        }
      }
      emitLog(`Loaded ${styleNumbers.length} H&M article numbers from Excel.`, 'success');
    } catch (error) {
      throw new Error(`Excel parse failed: ${error.message}`);
    }
  }

  ensureActive();
  if (!styleNumbers || styleNumbers.length === 0) throw new Error('No H&M article numbers provided.');

  const targetDir = !outputDir || outputDir === '未选择' ? path.join(app.getPath('desktop'), 'H&M') : outputDir;
  fs.mkdirSync(targetDir, { recursive: true });
  emitLog(`📁 Output directory: ${targetDir}`, 'info');
  emitLog('🌐 Launching the H&M scraper session...', 'info');

  let executablePath = findChromePath();
  if (!executablePath) {
    emitLog('⬇️ No local Chrome found. Downloading Chrome runtime…', 'warning');
    const chromeInstall = await ensureChromeRuntimeAvailable((p) => { if (p?.status) emitLog(p.status, p.phase === 'complete' ? 'success' : 'info'); });
    if (!chromeInstall?.success) throw new Error(chromeInstall?.error || 'Chrome download failed.');
    executablePath = chromeInstall.executablePath;
  }

  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: false,
      userDataDir: getHmSessionDir(),
      args: antiDetection.getRetailLaunchArgs(),
      ignoreDefaultArgs: ['--enable-automation'],
      defaultViewport: null,
    });
    previewBridge?.attachToBrowser(browser);
    taskController?.onCancel(() => { if (browser && browser.isConnected()) browser.close().catch(() => {}); });

    const products = [];
    const total = styleNumbers.length;
    emitLog(`🚀 H&M: ${total} 个款号 (直接打开产品页，取当前颜色高清图)`, 'warning');
    emitProgress(5);

    for (let i = 0; i < total; i += 1) {
      ensureActive();
      const ref = styleNumbers[i];
      emitLog(`🎯 H&M input raw: "${ref}"`, 'info');
      emitLog(`🔄 Processing H&M ${i + 1}/${total}: ${ref}`, 'warning');
      try {
        const result = await scrapeHmProduct(browser, ref, emitLog, ensureActive);
        if (!result.imageUrls?.length) throw new Error(`No product images found for H&M article ${ref}`);
        products.push(result);
        emitLog(`✅ H&M ${ref} captured | ${result.name || 'H&M'} | ${result.imageUrls.length} images`, 'success');
      } catch (error) {
        if (isCancellationError(error) || taskController?.cancelled) throw new TaskCancelledError();
        emitLog(`    ⚠️ H&M ${ref} failed: ${error.message}`, 'warning');
        products.push({ styleNumber: ref, productId: ref, url: buildHmProductUrl(ref), error: error.message, imageUrls: [] });
      }
      emitProgress(5 + Math.round(((i + 1) / total) * 45));
      if (i < total - 1) await antiDetection.randomDelay(1500, 2500);
    }

    emitProgress(50);
    emitLog('🌐 H&M page extraction complete. Preparing image downloads...', 'warning');

    const success = products.filter((p) => p.imageUrls?.length > 0);
    const failed = products.filter((p) => !p.imageUrls?.length);
    emitLog(`📊 H&M summary: ${success.length} styles succeeded, ${failed.length} styles failed, ${success.reduce((s, p) => s + p.imageUrls.length, 0)} images collected.`, 'info');
    failed.forEach((p) => {
      emitLog(`    ❌ ${p.styleNumber} - ${p.error || 'No product images found'}`, 'error');
      emitLog(`       👉 建议人工检查: ${p.url || HM_BASE_URL}`, 'warning');
    });

    const allTasks = [];
    for (const product of success) {
      ensureActive();
      const cleanSku = sanitizeFileSegment(String(product.productId || product.styleNumber || '').replace(/[./]/g, '-'), 'hm-item');
      const styleDir = path.join(targetDir, cleanSku);
      fs.mkdirSync(styleDir, { recursive: true });
      const classified = buildHmImageMap(product.imageUrls);
      for (const [label, imgUrl] of Object.entries(classified)) {
        const ext = getUrlExtension(imgUrl, '.jpg');
        const filename = `${cleanSku}_${label}${ext}`;
        const filePath = path.join(styleDir, filename);
        allTasks.push(() => {
          ensureActive();
          return downloadFile(imgUrl, filePath, { headers: { Referer: product.url || HM_BASE_URL, 'User-Agent': 'Mozilla/5.0' }, timeoutMs: 60000 })
            .then((size) => { if (size) emitLog(`    ⬇️ [saved] ${filename} (${size.toFixed(1)} KB)`); })
            .catch((error) => { emitLog(`    ❌ [failed] ${filename}: ${error.message}`, 'error'); });
        });
      }
      const infoData = { styleNumber: product.productId || product.styleNumber, brand: 'H&M', name: product.name, price: product.price, colorRef: product.colorRef || '', description: product.description || '', composition: product.composition || '', url: product.url, images: classified };
      fs.writeFileSync(path.join(styleDir, `${cleanSku}_info.json`), JSON.stringify(infoData, null, 2), 'utf-8');
      emitLog(`📄 Saved product metadata: ${cleanSku}_info.json`, 'success');
    }

    emitLog(`📦 Downloading ${allTasks.length} H&M images with ${downloadConcurrency} worker(s)...`, 'info');
    let done = 0;
    await parallelLimit(allTasks.map((t) => async () => { ensureActive(); await t(); done += 1; emitProgress(50 + Math.round((done / Math.max(allTasks.length, 1)) * 50)); }), downloadConcurrency);

    emitProgress(100);
    fs.writeFileSync(path.join(targetDir, 'summary.json'), JSON.stringify(products.map((p) => ({ styleNumber: p.productId || p.styleNumber, brand: 'H&M', name: p.name, price: p.price, colorRef: p.colorRef || '', description: p.description || '', composition: p.composition || '', images: p.imageUrls?.length || 0, error: p.error || null })), null, 2), 'utf-8');
    emitLog('📊 Saved summary.json', 'success');
    if (failed.length) {
      fs.writeFileSync(path.join(targetDir, 'failed_styles.json'), JSON.stringify(failed.map((p) => ({ styleNumber: p.productId || p.styleNumber, error: p.error || 'No product images found' })), null, 2), 'utf-8');
      emitLog('📄 Saved failed_styles.json', 'success');
    }
    emitLog(`🎉 H&M scraping finished. Files saved to: ${targetDir}`, 'success');
  } finally {
    if (browser && browser.isConnected()) await browser.close().catch(() => {});
  }
}

// ════════════════════════════════════════════════════════════════════════════
// New Yorker (newyorker.de) — JSON API, no browser needed.
//   Product:  GET /csp/products/public/product/{articleNumber}?country=DE
//   Image:    GET /csp/images/image/public/{key}?res=full-hd&frame=1
// We take ONLY the first variant (one colour), grab the highest-resolution
// images, and pull composition from the variant's components/materials.
// Article format: XX.XX.XXX.XXXX  e.g. 03.01.010.0134
// ════════════════════════════════════════════════════════════════════════════

const NEWYORKER_API_BASE = 'https://api.newyorker.de/csp/products/public';
const NEWYORKER_IMAGE_BASE = 'https://api.newyorker.de/csp/images/image/public';
const NEWYORKER_COUNTRY = 'DE';
// Highest resolution the image service exposes (reference script used "high",
// which is NOT the max — full-hd is the largest single-frame asset).
const NEWYORKER_IMAGE_RES = 'full-hd';

// Map ISO material codes / German names that show up in the API to clean English.
const NEWYORKER_MATERIAL_NAMES = {
  CO: 'Cotton', PL: 'Polyester', EA: 'Elastane', VI: 'Viscose', PA: 'Polyamide',
  WO: 'Wool', WV: 'Virgin Wool', SE: 'Silk', LI: 'Linen', AC: 'Acrylic',
  PU: 'Polyurethane', PC: 'Acrylic', WS: 'Cashmere', WM: 'Mohair', WA: 'Angora',
  RA: 'Ramie', ME: 'Metallic Fibre', LY: 'Lyocell', CV: 'Viscose', MD: 'Modal',
  CMD: 'Modal', AF: 'Other Fibres', SF: 'Other Fibres', HA: 'Hemp', JU: 'Jute',
  CUP: 'Cupro', TV: 'Triacetate', CA: 'Acetate', EL: 'Elastane', SP: 'Elastane',
};

function buildNewYorkerComposition(variant = {}) {
  // Group materials by component (e.g. "Outer fabric", "Lining") and join the
  // fibre percentages into readable lines.
  const components = Array.isArray(variant?.components) ? variant.components : [];
  const lines = [];
  for (const comp of components) {
    const materials = Array.isArray(comp?.materials) ? comp.materials : [];
    if (!materials.length) continue;
    const parts = materials
      .map((m) => {
        const code = String(m?.id || '').toUpperCase();
        const name = NEWYORKER_MATERIAL_NAMES[code] || code || 'Material';
        const pct = m?.value != null ? `${m.value}%` : '';
        const recycled = m?.recycled ? ' (recycled)' : '';
        return `${pct} ${name}${recycled}`.trim();
      })
      .filter(Boolean);
    if (!parts.length) continue;
    const compName = String(comp?.id || '').trim();
    // Prettify common component ids
    const label = /outer|shell|main|fabric|01/i.test(compName) ? 'Outer fabric'
      : /lining|02/i.test(compName) ? 'Lining'
      : compName || '';
    lines.push(label ? `${label}: ${parts.join(', ')}` : parts.join(', '));
  }
  // Dedupe
  return [...new Set(lines)].join('\n');
}

function buildNewYorkerImageUrl(key) {
  const k = String(key || '').trim();
  if (!k) return '';
  return `${NEWYORKER_IMAGE_BASE}/${encodeURIComponent(k)}?res=${NEWYORKER_IMAGE_RES}&frame=1`;
}

function buildNewYorkerImageMap(imageUrls = []) {
  const list = [...imageUrls];
  const map = {};
  if (!list.length) return map;
  map.F = list[0];
  if (list.length > 1) map.B = list[list.length - 1];
  let extra = 1;
  for (let i = 1; i < list.length - 1; i += 1) {
    map[String(extra).padStart(2, '0')] = list[i];
    extra += 1;
  }
  return map;
}

function normalizeNewYorkerArticle(reference = '') {
  // Accept "03.01.010.0134" or compact "03010100134" / with spaces.
  const raw = String(reference || '').trim();
  // If it already has dots, keep as-is. Otherwise try to format 11 digits.
  if (/\d+\.\d+\.\d+\.\d+/.test(raw)) return raw;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 11) {
    return `${digits.slice(0, 2)}.${digits.slice(2, 4)}.${digits.slice(4, 7)}.${digits.slice(7)}`;
  }
  return raw;
}

async function scrapeNewYorkerProduct(reference, emitLog, ensureActive, options = {}) {
  const article = normalizeNewYorkerArticle(reference);
  if (!article) throw new Error(`Empty New Yorker reference: ${reference}`);

  const url = `${NEWYORKER_API_BASE}/product/${encodeURIComponent(article)}?country=${NEWYORKER_COUNTRY}`;
  emitLog(`    🔍 Fetching New Yorker product ${article}…`, 'info');
  ensureActive();

  let data;
  try {
    data = await fetchJson(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        Accept: 'application/json',
      },
      timeoutMs: 30000,
    });
  } catch (error) {
    throw new Error(`New Yorker API request failed: ${error.message}`);
  }

  const variants = Array.isArray(data?.variants) ? data.variants : [];
  if (!variants.length) throw new Error(`No variants returned for New Yorker article ${article}`);

  // Querying ONE article returns a product whose variants[] holds EVERY colour.
  // Default behaviour (regular scraper): take only the first colour. When the
  // caller wants all colours (bestseller "all colours" mode), it sets
  // options.allVariants and we return one record per colour instead — each with
  // that colour's own images.
  const buildVariantRecord = (variant) => {
    const colorGroup = variant?.color_group || variant?.basic_color || '';
    const variantId = String(variant?.id || '').trim();

    const imgs = Array.isArray(variant?.images) ? [...variant.images] : [];
    imgs.sort((a, b) => (Number(a?.position) || 0) - (Number(b?.position) || 0));
    const imageUrls = imgs
      .map((img) => buildNewYorkerImageUrl(img?.key))
      .filter(Boolean);

    const composition = buildNewYorkerComposition(variant);

    const currency = variant?.currency || data?.currency || '';
    const priceVal = variant?.current_price ?? variant?.original_price ?? '';
    const price = priceVal !== '' ? `${priceVal}${currency ? ` ${currency}` : ''}` : '';

    const brand = data?.brand || 'New Yorker';
    const category = data?.maintenance_group || data?.web_category_id || '';
    const nameParts = [brand, category, colorGroup].map((s) => String(s || '').trim()).filter(Boolean);
    const productName = nameParts.join(' · ') || `New Yorker ${article}`;

    // Give each colour a distinct id so its images land in their own folder.
    const colorSuffix = variantId && variantId !== '001' ? `-${variantId}` : (colorGroup ? `-${sanitizeFileSegment(colorGroup, 'c')}` : '');
    const recordId = `${article}${colorSuffix}`;
    const productUrl = `https://www.newyorker.de/p/${encodeURIComponent(article)}`;

    return {
      styleNumber: article,
      productId: recordId,
      brand: 'New Yorker',
      name: productName,
      category,
      price,
      colorRef: colorGroup,
      description: '',
      composition: composition ? { outerShell: null, lining: null, other: composition } : null,
      url: productUrl,
      imageUrls,
    };
  };

  const wantAllVariants = options?.allVariants === true;
  if (wantAllVariants) {
    const records = variants.map(buildVariantRecord).filter((r) => r.imageUrls.length > 0);
    const totalImgs = records.reduce((s, r) => s + r.imageUrls.length, 0);
    emitLog(`✅ New Yorker ${article} captured | ${records.length} colour(s) | ${totalImgs} images`, 'success');
    return records;
  }

  const variant = variants[0];
  const colorGroup = variant?.color_group || variant?.basic_color || '';

  // Highest-res image URLs. Order by position so front shot comes first.
  const imgs = Array.isArray(variant?.images) ? [...variant.images] : [];
  imgs.sort((a, b) => (Number(a?.position) || 0) - (Number(b?.position) || 0));
  const imageUrls = imgs
    .map((img) => buildNewYorkerImageUrl(img?.key))
    .filter(Boolean);

  const composition = buildNewYorkerComposition(variant);

  // Price (current price preferred, fall back to original).
  const currency = variant?.currency || data?.currency || '';
  const priceVal = variant?.current_price ?? variant?.original_price ?? '';
  const price = priceVal !== '' ? `${priceVal}${currency ? ` ${currency}` : ''}` : '';

  // Name: New Yorker API has no free-text product name/description, so build a
  // readable name from brand + category + colour. (User confirmed: no description.)
  const brand = data?.brand || 'New Yorker';
  const category = data?.maintenance_group || data?.web_category_id || '';
  const nameParts = [brand, category, colorGroup].map((s) => String(s || '').trim()).filter(Boolean);
  const productName = nameParts.join(' · ') || `New Yorker ${article}`;

  const productUrl = `https://www.newyorker.de/p/${encodeURIComponent(article)}`;

  emitLog(`✅ New Yorker ${article} captured | ${productName} | ${imageUrls.length} images${composition ? ' | composition ✓' : ''}`, 'success');

  return {
    styleNumber: article,
    productId: article,
    brand: 'New Yorker',
    name: productName,
    category,
    price,
    colorRef: colorGroup,
    description: '',
    composition: composition ? { outerShell: null, lining: null, other: composition } : null,
    url: productUrl,
    imageUrls,
  };
}

async function runNewYorkerScraper(config, emitLog, emitProgress, taskController, previewBridge = null) {
  let { styleNumbers, excelPath, outputDir, downloadConcurrency } = config;
  styleNumbers = normalizeManualStyleNumbers(styleNumbers);
  const ensureActive = () => taskController?.throwIfCancelled?.();

  if (excelPath) {
    try {
      emitLog(`Reading Excel file: ${excelPath}`, 'info');
      const wb = XLSX.readFile(excelPath);
      const ws = wb.Sheets[wb.SheetNames[0]];
      styleNumbers = [];
      const range = XLSX.utils.decode_range(ws['!ref'] || 'A1:B1');
      for (let row = 1; row <= range.e.r; row += 1) {
        const cell = ws[XLSX.utils.encode_cell({ r: row, c: 1 })];
        if (cell) {
          const v = String(cell.w ?? cell.v ?? '').trim();
          if (v) styleNumbers.push(v);
        }
      }
      emitLog(`Loaded ${styleNumbers.length} New Yorker article numbers from Excel.`, 'success');
    } catch (error) {
      throw new Error(`Excel parse failed: ${error.message}`);
    }
  }

  ensureActive();
  if (!styleNumbers || styleNumbers.length === 0) throw new Error('No New Yorker article numbers provided.');

  const targetDir = !outputDir || outputDir === '未选择' ? path.join(app.getPath('desktop'), 'New Yorker') : outputDir;
  fs.mkdirSync(targetDir, { recursive: true });
  emitLog(`📁 Output directory: ${targetDir}`, 'info');
  emitLog('🌐 New Yorker uses the official JSON API — no browser needed.', 'info');

  const products = [];
  const total = styleNumbers.length;
  emitLog(`🚀 New Yorker: ${total} 个款号 (官方 API，取第一个颜色，full-hd 高清图)`, 'warning');
  emitProgress(5);

  for (let i = 0; i < total; i += 1) {
    ensureActive();
    const ref = styleNumbers[i];
    emitLog(`🎯 New Yorker input raw: "${ref}"`, 'info');
    emitLog(`🔄 Processing New Yorker ${i + 1}/${total}: ${ref}`, 'warning');
    try {
      const result = await scrapeNewYorkerProduct(ref, emitLog, ensureActive);
      products.push(result);
    } catch (error) {
      if (isCancellationError(error) || taskController?.cancelled) throw new TaskCancelledError();
      emitLog(`    ⚠️ New Yorker ${ref} failed: ${error.message}`, 'warning');
      products.push({ styleNumber: ref, productId: ref, url: '', error: error.message, imageUrls: [] });
    }
    emitProgress(5 + Math.round(((i + 1) / total) * 45));
    if (i < total - 1) await antiDetection.randomDelay(400, 900);
  }

  emitProgress(50);
  emitLog('🌐 New Yorker metadata fetch complete. Preparing image downloads...', 'warning');

  const success = products.filter((p) => p.imageUrls?.length > 0);
  const failed = products.filter((p) => !p.imageUrls?.length);
  emitLog(`📊 New Yorker summary: ${success.length} styles succeeded, ${failed.length} styles failed, ${success.reduce((s, p) => s + p.imageUrls.length, 0)} images collected.`, 'info');
  failed.forEach((p) => {
    emitLog(`    ❌ ${p.styleNumber} - ${p.error || 'No product images found'}`, 'error');
  });

  const allTasks = [];
  for (const product of success) {
    ensureActive();
    const cleanSku = sanitizeFileSegment(String(product.productId || product.styleNumber || '').replace(/[./]/g, '-'), 'newyorker-item');
    const styleDir = path.join(targetDir, cleanSku);
    fs.mkdirSync(styleDir, { recursive: true });
    const classified = buildNewYorkerImageMap(product.imageUrls);
    for (const [label, imgUrl] of Object.entries(classified)) {
      const ext = getUrlExtension(imgUrl, '.jpg');
      const filename = `${cleanSku}_${label}${ext}`;
      const filePath = path.join(styleDir, filename);
      allTasks.push(() => {
        ensureActive();
        return downloadFile(imgUrl, filePath, { headers: { Referer: 'https://www.newyorker.de/', 'User-Agent': 'Mozilla/5.0' }, timeoutMs: 60000 })
          .then((size) => { if (size) emitLog(`    ⬇️ [saved] ${filename} (${size.toFixed(1)} KB)`); })
          .catch((error) => { emitLog(`    ❌ [failed] ${filename}: ${error.message}`, 'error'); });
      });
    }
    const infoData = { styleNumber: product.productId || product.styleNumber, brand: 'New Yorker', name: product.name, price: product.price, colorRef: product.colorRef || '', description: product.description || '', composition: product.composition || null, url: product.url, images: classified };
    fs.writeFileSync(path.join(styleDir, `${cleanSku}_info.json`), JSON.stringify(infoData, null, 2), 'utf-8');
    emitLog(`📄 Saved product metadata: ${cleanSku}_info.json`, 'success');
  }

  emitLog(`📦 Downloading ${allTasks.length} New Yorker images with ${downloadConcurrency} worker(s)...`, 'info');
  let done = 0;
  await parallelLimit(allTasks.map((t) => async () => { ensureActive(); await t(); done += 1; emitProgress(50 + Math.round((done / Math.max(allTasks.length, 1)) * 50)); }), downloadConcurrency);

  emitProgress(100);
  fs.writeFileSync(path.join(targetDir, 'summary.json'), JSON.stringify(products.map((p) => ({ styleNumber: p.productId || p.styleNumber, brand: 'New Yorker', name: p.name, price: p.price, colorRef: p.colorRef || '', composition: p.composition || null, images: p.imageUrls?.length || 0, error: p.error || null })), null, 2), 'utf-8');
  emitLog('📊 Saved summary.json', 'success');
  if (failed.length) {
    fs.writeFileSync(path.join(targetDir, 'failed_styles.json'), JSON.stringify(failed.map((p) => ({ styleNumber: p.productId || p.styleNumber, error: p.error || 'No product images found' })), null, 2), 'utf-8');
    emitLog('📄 Saved failed_styles.json', 'success');
  }
  emitLog(`🎉 New Yorker scraping finished. Files saved to: ${targetDir}`, 'success');
}

// ════════════════════════════════════════════════════════════════════════════
// Bestseller Analysis — list-page harvest + per-style detail + LLM trend report.
//   New Yorker editorial bestseller pages, e.g.
//     https://www.newyorker.de/products/?gender=MALE&editorials=218   (men)
//     https://www.newyorker.de/products/?gender=FEMALE&editorials=217 (women)
//   Strategy: open the listing URL in a browser, intercept the New Yorker
//   listing API responses (api.newyorker.de/.../products...) to harvest every
//   article id across all pages (scroll / load-more), then reuse
//   scrapeNewYorkerProduct() per id for detail + images + composition.
// ════════════════════════════════════════════════════════════════════════════

function getBestsellerSessionDir() {
  return path.join(app.getPath('userData'), 'bestseller-browser-session');
}

// Bestseller source table (mirrors the Bestseller.xlsx the user provided).
// Keyed by `${brand}|${gender}` → listing URL.
const BESTSELLER_SOURCES = {
  'newyorker|male': 'https://www.newyorker.de/products/?gender=MALE&editorials=218',
  'newyorker|female': 'https://www.newyorker.de/products/?gender=FEMALE&editorials=217',
  // H&M removed: its Akamai bot-guard 403s all automated product-page access
  // (verified — even manual clicks in the automation browser are blocked).
};

function resolveBestsellerSource(brand, gender) {
  const b = String(brand || '').trim().toLowerCase().replace(/\s+/g, '');
  const g = String(gender || '').trim().toLowerCase();
  const gNorm = /^(m|male|men|man|男|男装)$/.test(g) ? 'male'
    : /^(f|female|women|woman|w|女|女装)$/.test(g) ? 'female' : g;
  return BESTSELLER_SOURCES[`${b}|${gNorm}`] || '';
}

// Pull every plausible New Yorker article id out of an arbitrary JSON payload.
// Article ids look like "03.01.040.0307" or the 11-digit compact "03010400307".
function harvestNewYorkerIdsFromJson(payload) {
  const ids = new Set();
  const dotted = /\b\d{2}\.\d{2}\.\d{3}\.\d{4}\b/g;
  const visit = (node, depth) => {
    if (!node || depth > 16) return;
    if (typeof node === 'string') {
      const m = node.match(dotted);
      if (m) m.forEach((x) => ids.add(x));
      return;
    }
    if (typeof node !== 'object') return;
    // Direct id-ish fields (compact 11-digit or dotted).
    if (!Array.isArray(node)) {
      for (const [k, v] of Object.entries(node)) {
        if (typeof v === 'string') {
          if (/^(?:id|productid|article|articlenumber|articleid|globalitemid)$/i.test(k)) {
            const compact = v.replace(/\D/g, '');
            if (/^\d{2}\.\d{2}\.\d{3}\.\d{4}$/.test(v)) ids.add(v);
            else if (compact.length === 11) ids.add(`${compact.slice(0, 2)}.${compact.slice(2, 4)}.${compact.slice(4, 7)}.${compact.slice(7)}`);
          } else {
            const m = v.match(dotted);
            if (m) m.forEach((x) => ids.add(x));
          }
        } else {
          visit(v, depth + 1);
        }
      }
    } else {
      for (const v of node) visit(v, depth + 1);
    }
  };
  try { visit(payload, 0); } catch { /* noop */ }
  return [...ids];
}

async function collectBestsellerArticleIds(browser, listingUrl, emitLog, ensureActive) {
  const page = await browser.newPage();
  // DOM tiles = what the user actually sees (authoritative). API ids = a
  // superset (colour-siblings + editorial cross-refs) used only as a fallback.
  const tileIds = new Set();
  const apiIds = new Set();
  let apiResponseCount = 0;

  page.on('response', async (resp) => {
    try {
      const u = resp.url();
      if (!/newyorker\.de\//i.test(u)) return;
      const ct = String(resp.headers()['content-type'] || '');
      if (!/json/i.test(ct)) return;
      if (!/product|editorial|search|catalog|list/i.test(u)) return;
      const json = await resp.json().catch(() => null);
      if (!json) return;
      apiResponseCount += 1;
      harvestNewYorkerIdsFromJson(json).forEach((id) => apiIds.add(id));
    } catch { /* noop */ }
  });

  try {
    emitLog(`    🌐 Opening bestseller listing: ${listingUrl}`, 'info');
    await page.goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await antiDetection.randomDelay(2000, 3000);
    ensureActive();

    // New Yorker shows a country/region selector on first entry that blocks the
    // page. Auto-pick a country (prefer Germany / international) to get through.
    const pickedCountry = await page.evaluate(() => {
      const isVisible = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return false;
        const s = window.getComputedStyle(el);
        return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
      };
      // 1) Direct country links/buttons inside a country/region chooser.
      const wantRe = /(germany|deutschland|international|english|\bde\b|\beu\b)/i;
      const scopeSel = '[class*="country" i], [class*="region" i], [class*="market" i], [class*="locale" i], [id*="country" i], [data-testid*="country" i]';
      const scopes = [...document.querySelectorAll(scopeSel)];
      const pools = scopes.length ? scopes : [document.body];
      for (const scope of pools) {
        const links = [...scope.querySelectorAll('a, button, [role="button"], li')];
        // Prefer Germany/Deutschland, else first visible country-looking entry.
        const preferred = links.find((el) => isVisible(el) && wantRe.test(String(el.textContent || '')) && String(el.textContent || '').trim().length < 40);
        if (preferred) { try { preferred.click(); } catch { /* noop */ } return String(preferred.textContent || '').trim().slice(0, 40); }
      }
      // 2) A generic "continue / enter / confirm" gate button.
      const gateRe = /^\s*(?:continue|enter|confirm|weiter|bestätigen|ok|los geht|shop now|jetzt einkaufen)\s*$/i;
      for (const el of document.querySelectorAll('button, [role="button"], a')) {
        if (!isVisible(el)) continue;
        const t = String(el.textContent || '').trim();
        if (t && t.length < 30 && gateRe.test(t)) { try { el.click(); } catch { /* noop */ } return `gate:${t}`; }
      }
      return '';
    }).catch(() => '');
    if (pickedCountry) {
      emitLog(`    🌍 Auto-selected region/gate: ${pickedCountry}`, 'info');
      await antiDetection.randomDelay(1500, 2500);
      // Some flows navigate; re-ensure we're on the listing URL.
      if (!/\/products\//i.test(page.url())) {
        await page.goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await antiDetection.randomDelay(1500, 2500);
      }
      ensureActive();
    }

    // Dismiss cookie / consent that can block lazy-load.
    await page.evaluate(() => {
      const re = /^\s*(?:accept|agree|akzeptieren|alle akzeptieren|zustimmen|ok|got it|allow all)\s*$/i;
      for (const el of document.querySelectorAll('button, [role="button"], a')) {
        const t = String(el.textContent || '').trim();
        if (t && t.length < 30 && re.test(t)) { try { el.click(); } catch { /* noop */ } }
      }
    }).catch(() => {});
    await antiDetection.randomDelay(800, 1400);

    // Scroll + click any "load more" repeatedly until the id set stops growing.
    let stableRounds = 0;
    let lastCount = -1;
    for (let round = 0; round < 40 && stableRounds < 3; round += 1) {
      ensureActive();
      await page.evaluate(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        for (let i = 0; i < 5; i += 1) {
          window.scrollBy(0, document.body.scrollHeight);
          await sleep(350);
        }
        // Click a "load more / show more / mehr" control if present.
        const re = /load\s*more|show\s*more|mehr\s*(?:laden|anzeigen)|weitere|more products/i;
        for (const el of document.querySelectorAll('button, a, [role="button"]')) {
          const t = String(el.textContent || '').trim();
          const r = el.getBoundingClientRect();
          if (t && t.length < 40 && re.test(t) && r.width > 0 && r.height > 0) {
            try { el.click(); } catch { /* noop */ }
          }
        }
      }).catch(() => {});
      await antiDetection.randomDelay(1400, 2200);

      // Harvest ids from the visible product TILES only — anchors that link to
      // a product detail page (/p/<id> or a dotted id in the href). These are
      // the styles the user actually sees on the grid.
      const domIds = await page.evaluate(() => {
        const out = new Set();
        const dotted = /\b\d{2}\.\d{2}\.\d{3}\.\d{4}\b/;
        for (const a of document.querySelectorAll('a[href]')) {
          const href = a.getAttribute('href') || a.href || '';
          // Only product-detail links (the grid tiles), not nav/editorial links.
          if (!/\/p\/|\/product/i.test(href) && !dotted.test(href)) continue;
          const compact = href.match(/\/p\/(\d{11})\b/);
          if (compact) {
            const c = compact[1];
            out.add(`${c.slice(0, 2)}.${c.slice(2, 4)}.${c.slice(4, 7)}.${c.slice(7)}`);
            continue;
          }
          const m = href.match(dotted);
          if (m) out.add(m[0]);
        }
        return [...out];
      }).catch(() => []);
      domIds.forEach((id) => tileIds.add(id));

      const count = tileIds.size;
      emitLog(`    📦 Bestseller listing: ${count} product tiles found so far (round ${round + 1})…`, 'info');
      if (count === lastCount) stableRounds += 1; else stableRounds = 0;
      lastCount = count;
    }

    // Prefer the DOM tile ids (exactly what's on the grid). Fall back to the
    // API-harvested ids only if tile detection found nothing.
    const tiles = tileIds.size > 0 ? [...tileIds] : [...apiIds];
    emitLog(`    ✅ Bestseller listing harvested ${tiles.length} product tiles (api siblings=${apiIds.size}, ${apiResponseCount} API payloads).`, 'success');
    return { tiles, apiIds: [...apiIds] };
  } finally {
    await page.close().catch(() => {});
  }
}

// ── Zara bestseller: collect product PDP links from the listing grid ─────────
function normalizeZaraBestsellerImageUrl(url = '') {
  let u = String(url || '').trim();
  if (!u) return '';
  if (u.startsWith('//')) u = `https:${u}`;
  u = u.split('?')[0];
  if (!/\.(?:jpe?g|png|webp)$/i.test(u)) return '';
  // Force the largest transform width Zara's CDN honours.
  return `${u}?ts=1&w=1500`;
}

async function collectZaraBestsellerLinks(browser, listingUrl, emitLog, ensureActive) {
  const page = await browser.newPage();
  try {
    await antiDetection.applyRetailBrowsingProfile(page);
    await page.setUserAgent(antiDetection.getRandomUserAgent());
    await page.setViewport(antiDetection.getRandomViewport());
    emitLog(`    🌐 Opening Zara bestseller listing: ${listingUrl}`, 'info');
    await page.goto(listingUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await antiDetection.randomDelay(2500, 3500);
    ensureActive();

    // Cookie / region consent.
    await page.evaluate(() => {
      const re = /^\s*(?:accept all|accept|agree|i agree|ok|got it|reject all)\s*$/i;
      for (const el of document.querySelectorAll('button, [role="button"], a')) {
        const t = String(el.textContent || '').trim();
        if (t && t.length < 24 && re.test(t)) { try { el.click(); } catch { /* noop */ } }
      }
    }).catch(() => {});
    await antiDetection.randomDelay(800, 1400);

    // Wait for the product grid to hydrate (the first paint is an unstyled
    // skeleton; real product links appear only after the SPA loads).
    await page.waitForFunction(
      () => [...document.querySelectorAll('a[href]')].some((a) => /-p\d{6,}\.html/i.test(a.href || '')),
      { timeout: 25000, polling: 600 },
    ).catch(() => {});
    ensureActive();

    const links = new Set();
    let stable = 0;
    let last = -1;
    for (let round = 0; round < 60 && stable < 4; round += 1) {
      ensureActive();
      await page.evaluate(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        for (let i = 0; i < 6; i += 1) { window.scrollBy(0, window.innerHeight * 1.5); await sleep(300); }
      }).catch(() => {});
      await antiDetection.randomDelay(1000, 1700);

      const found = await page.evaluate(() => {
        const out = [];
        // Zara product detail links look like /us/en/<slug>-pXXXXXXXX.html
        for (const a of document.querySelectorAll('a[href*="-p"][href*=".html"]')) {
          const href = a.href || '';
          if (/-p\d{6,}\.html/i.test(href) && /zara\.com\//i.test(href)) out.push(href.split('?')[0]);
        }
        return out;
      }).catch(() => []);
      found.forEach((h) => links.add(h));

      const count = links.size;
      emitLog(`    📦 Zara listing: ${count} product tiles found so far (round ${round + 1})…`, 'info');
      if (count === last) stable += 1; else stable = 0;
      last = count;
    }
    emitLog(`    ✅ Zara listing harvested ${links.size} product links.`, 'success');
    return [...links];
  } finally {
    await page.close().catch(() => {});
  }
}

async function collectHmBestsellerLinks(browser, listingUrl, emitLog, ensureActive) {
  const page = await browser.newPage();

  // Intercept H&M listing API responses to extract article codes AND product
  // data (images, names, prices, descriptions) directly, so we can skip
  // opening individual product pages when the API provides enough detail.
  const apiArticles = new Set();
  const apiProducts = {};  // article → { name, price, images: Set, description }
  page.on('response', async (resp) => {
    const url = resp.url();
    // Broaden interception to catch all H&M listing/product API responses.
    if (/hmwebservice|\/api\/|\/listing|contentatom|graphql|pagebuilder/i.test(url) && resp.status() === 200) {
      try {
        const ct = resp.headers()['content-type'] || '';
        if (!/json/i.test(ct)) return;
        const json = await resp.json();
        // Walk the JSON tree for article codes and product data.
        const walk = (obj, parentKey) => {
          if (!obj || typeof obj !== 'object') return;
          for (const key of Object.keys(obj)) {
            const val = obj[key];
            if (typeof val === 'string' && /^\d{7,10}$/.test(val)) {
              apiArticles.add(val);
            } else if (typeof val === 'string') {
              // Capture image URLs from API
              if (/image\.hm\.com|hmgoepprod|lp\d?\.hm\.com/i.test(val) && /\.(jpe?g|png|webp)/i.test(val)) {
                // Try to find the associated article in this subtree
                const bare = val.split('?')[0];
                // Extract article from image filename: e.g. 1342946001.jpg
                const artFromImg = bare.match(/(\d{7,10})\.(?:jpe?g|png|webp)/i);
                if (artFromImg) {
                  const art = artFromImg[1];
                  if (!apiProducts[art]) apiProducts[art] = { name: '', price: '', images: new Set(), description: '' };
                  apiProducts[art].images.add(val);
                }
              }
            } else if (typeof val === 'object') {
              walk(val, key);
            }
          }
        };
        walk(json, '');
      } catch { /* response body already consumed or not JSON */ }
    }
  });

  try {
    await antiDetection.applyRetailBrowsingProfile(page);
    await page.setUserAgent(antiDetection.getRandomUserAgent());
    await page.setViewport(antiDetection.getRandomViewport());
    emitLog(`    🌐 Opening H&M bestseller listing: ${listingUrl}`, 'info');
    await page.goto(listingUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await antiDetection.randomDelay(2500, 4000);
    ensureActive();

    // Cookie / region consent.
    await page.evaluate(() => {
      const texts = ['accept', 'agree', 'allow all', 'got it', 'continue', 'i accept', 'accept all'];
      const clickable = [...document.querySelectorAll('button, [role="button"], a')];
      for (const el of clickable) {
        const t = String(el.textContent || '').trim().toLowerCase();
        if (t && texts.some((x) => t === x || t.includes(x)) && t.length < 30) {
          try { el.click(); } catch { /* noop */ }
        }
      }
    }).catch(() => {});
    await antiDetection.randomDelay(800, 1400);
    ensureActive();

    // H&M bestseller pages use lazy-loading AND paginate. First scroll the
    // current page to the bottom (triggers lazy-load + API calls we intercept),
    // then walk explicit pages via ?page=N until no new articles appear.
    const scrollToBottom = async () => {
      let stable = 0;
      let lastApiCount = -1;
      for (let round = 0; round < 40 && stable < 4; round += 1) {
        ensureActive();
        await page.evaluate(async () => {
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          for (let i = 0; i < 6; i += 1) { window.scrollBy(0, window.innerHeight * 1.5); await sleep(350); }
          // Click a "load more" control if H&M shows one instead of infinite scroll.
          const re = /load\s*more|show\s*more|view\s*more|see\s*more|加载更多|更多/i;
          for (const el of document.querySelectorAll('button, a, [role="button"]')) {
            const t = String(el.textContent || '').trim();
            if (t && t.length < 30 && re.test(t)) { try { el.click(); } catch { /* noop */ } }
          }
        }).catch(() => {});
        await antiDetection.randomDelay(1000, 1600);
        const currentCount = apiArticles.size;
        if (currentCount === lastApiCount) stable += 1; else stable = 0;
        lastApiCount = currentCount;
      }
    };

    await scrollToBottom();
    emitLog(`    📦 H&M page 1: ${apiArticles.size} articles so far…`, 'info');

    // Paginate: append/replace ?page=N and reload until a page adds nothing new.
    const baseUrl = listingUrl.split('#')[0];
    const joiner = baseUrl.includes('?') ? '&' : '?';
    let pageStable = 0;
    for (let pageNo = 2; pageNo <= 40 && pageStable < 2; pageNo += 1) {
      ensureActive();
      const before = apiArticles.size;
      const pagedUrl = `${baseUrl}${joiner}page=${pageNo}`;
      try {
        await page.goto(pagedUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        await antiDetection.randomDelay(1500, 2500);
        await scrollToBottom();
      } catch { /* a non-existent page may error; treated as no-gain below */ }
      const gained = apiArticles.size - before;
      emitLog(`    📄 H&M page ${pageNo}: +${gained} (total ${apiArticles.size})`, 'info');
      if (gained <= 0) pageStable += 1; else pageStable = 0;
    }

    // Also scan rendered DOM links as a fallback — H&M uses /productpage.{digits}.html
    // AND extract product card data (name, price, thumbnail) from the DOM.
    const domCards = await page.evaluate(() => {
      const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const out = [];
      for (const a of document.querySelectorAll('a[href]')) {
        const href = a.href || '';
        const m = href.match(/productpage\.(\d{7,10})\.html/i) || href.match(/\/(\d{7,10})\.html/i);
        if (m && /hm\.com/i.test(href)) {
          const article = m[1];
          // Walk up from the <a> to find the product card container.
          let card = a.closest('[class*="item"], [class*="product"], [class*="card"], [class*="article"], [data-articlecode], [class*="grid"]');
          if (!card) {
            // Fallback: walk up a few levels
            card = a.parentElement?.parentElement?.parentElement;
          }
          const name = card ? clean(card.querySelector('h2, h3, [class*="name" i], [class*="heading" i]')?.textContent || '') : '';
          const price = card ? (() => {
            for (const el of card.querySelectorAll('[class*="price" i], [data-testid*="price" i]')) {
              const t = clean(el.textContent);
              if (/\d/.test(t) && /[$€£¥]|USD|EUR|GBP/i.test(t) && t.length < 30) return t;
            }
            return '';
          })() : '';
          // Thumbnail image from the card
          const img = card ? card.querySelector('img') : null;
          const thumbUrl = img ? (img.currentSrc || img.src || img.getAttribute('data-src') || '') : '';
          out.push({ url: href.split('?')[0], article, name, price, thumbUrl });
        }
      }
      return out;
    }).catch(() => []);

    // Merge API articles and DOM links, dedupe by style (first 7 digits).
    const seenStyles = new Set();
    const articleLinks = [];

    // Priority: API-intercepted articles → build productpage URLs
    for (const article of [...apiArticles]) {
      const styleKey = article.slice(0, 7);
      if (!seenStyles.has(styleKey)) {
        seenStyles.add(styleKey);
        const apiProd = apiProducts[article] || {};
        articleLinks.push({
          url: `${HM_BASE_URL}/productpage.${article}.html`,
          article,
          name: apiProd.name || '',
          price: apiProd.price || '',
          apiImages: apiProd.images ? [...apiProd.images] : [],
        });
      }
    }

    // Fallback: DOM links (only add if not already captured by API)
    for (const entry of domCards) {
      const styleKey = entry.article.slice(0, 7);
      if (!seenStyles.has(styleKey)) {
        seenStyles.add(styleKey);
        articleLinks.push({
          url: entry.url,
          article: entry.article,
          name: entry.name || '',
          price: entry.price || '',
          thumbUrl: entry.thumbUrl || '',
          apiImages: [],
        });
      } else {
        // Merge DOM card data into existing entry if it has richer info
        const existing = articleLinks.find((e) => e.article.slice(0, 7) === styleKey);
        if (existing && !existing.name && entry.name) existing.name = entry.name;
        if (existing && !existing.price && entry.price) existing.price = entry.price;
        if (existing && !existing.thumbUrl && entry.thumbUrl) existing.thumbUrl = entry.thumbUrl;
      }
    }

    emitLog(`    ✅ H&M listing harvested ${apiArticles.size} API articles + ${domCards.length} DOM links → ${articleLinks.length} unique styles.`, 'success');

    // Return both the links AND the listing page so the bestseller flow can
    // reuse it for product detail navigation (avoiding new-tab bot detection).
    return { articleLinks, listingPage: page };
  } catch (error) {
    // If something goes wrong, close the page before throwing.
    await page.close().catch(() => {});
    throw error;
  }
}

async function scrapeZaraBestsellerProduct(browser, pdpUrl, emitLog, ensureActive) {
  const page = await browser.newPage();
  const captured = new Set();
  try {
    await antiDetection.applyRetailBrowsingProfile(page);
    await page.setUserAgent(antiDetection.getRandomUserAgent());
    await page.setViewport(antiDetection.getRandomViewport());
    const productId = extractZaraProductIdFromUrl(pdpUrl) || pdpUrl.split('/').pop().replace(/\.html.*$/, '');
    page.on('response', (resp) => {
      const u = normalizeZaraBestsellerImageUrl(resp.url());
      if (u && /static\.zara\.net|zara\.net\/.+\/photos?\//i.test(resp.url())) captured.add(u);
    });

    await page.goto(pdpUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await antiDetection.randomDelay(1800, 2600);
    ensureActive();
    await page.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      for (let i = 0; i < 5; i += 1) { window.scrollBy(0, window.innerHeight); await sleep(300); }
    }).catch(() => {});
    await antiDetection.randomDelay(800, 1400);

    // Expand the materials/composition accordion.
    await page.evaluate(() => {
      const re = /material|composition|care|fabric|extra|detail/i;
      for (const el of document.querySelectorAll('button, summary, [role="button"], [aria-expanded]')) {
        const t = String(el.textContent || el.getAttribute('aria-label') || '').trim();
        if (t && t.length < 40 && re.test(t) && el.getAttribute('aria-expanded') !== 'true') {
          try { el.click(); } catch { /* noop */ }
        }
      }
    }).catch(() => {});
    await antiDetection.randomDelay(900, 1500);

    const info = await page.evaluate(() => {
      const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const name = clean(document.querySelector('h1')?.textContent || document.title.split('|')[0]);
      let price = '';
      for (const el of document.querySelectorAll('[class*="price" i], [data-qa-qualifier*="price" i]')) {
        const t = clean(el.textContent);
        if (/\d/.test(t) && /[$€£¥]|USD|EUR|GBP/i.test(t) && t.length < 30) { price = t; break; }
      }
      // Composition: lines like "100% cotton" / "Outer shell: ...".
      const fibreRe = /\d+\s*%\s*(?:cotton|polyester|elastane|spandex|viscose|wool|linen|silk|polyamide|nylon|acrylic|cashmere|lyocell|modal|recycled|organic)/i;
      const compSet = new Set();
      for (const el of document.querySelectorAll('li, p, span, div')) {
        const t = clean(el.textContent);
        if (t && t.length < 80 && fibreRe.test(t)) compSet.add(t);
      }
      const composition = [...compSet].join('\n');
      // Category breadcrumb (to detect non-apparel).
      let category = '';
      const bc = [...document.querySelectorAll('[class*="breadcrumb" i] a, nav a')].map((a) => clean(a.textContent)).filter(Boolean);
      category = bc.join(' / ');
      // DOM image fallback.
      const imgs = [];
      for (const img of document.querySelectorAll('img')) {
        const s = img.currentSrc || img.src || img.getAttribute('data-src') || '';
        if (s) imgs.push(s);
        const ss = img.getAttribute('srcset') || '';
        const parts = ss.split(',').map((p) => p.trim().split(/\s+/)[0]).filter(Boolean);
        if (parts.length) imgs.push(parts[parts.length - 1]);
      }
      return { name, price, composition, category, domImages: imgs };
    });

    const allImgs = new Set();
    for (const u of captured) allImgs.add(u);
    for (const raw of info.domImages || []) {
      const u = normalizeZaraBestsellerImageUrl(raw);
      if (u && /static\.zara\.net|zara\.net\//i.test(u)) allImgs.add(u);
    }
    const imageUrls = [...allImgs];

    emitLog(`✅ Zara ${productId} captured | ${info.name || productId} | ${imageUrls.length} images${info.composition ? ' | composition ✓' : ''}`, 'success');
    return {
      styleNumber: productId,
      productId,
      brand: 'Zara',
      name: info.name || `Zara ${productId}`,
      category: info.category || '',
      price: info.price || '',
      colorRef: '',
      description: '',
      composition: info.composition ? { outerShell: null, lining: null, other: info.composition } : null,
      url: pdpUrl,
      imageUrls,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

// ── Intersport (Shopify-based) bestseller: collect product handles from
//    filtered+sorted collection page, then fetch each product's JSON ─────────

function buildIntersportUrl(category, gender) {
  const genderFilter = /male|man|men|男/i.test(gender) && !/female|woman|women|女/i.test(gender) ? 'Herren' : 'Damen';
  return `https://www.intersport.ch/collections/${encodeURIComponent(category)}?sort_by=best-selling&filter.p.m.dpr.gender_categories=${genderFilter}`;
}

// Build an image label map (F/B/01/02…) from Shopify image src URLs.
function buildIntersportImageMap(imageUrls = []) {
  const list = [...imageUrls];
  const map = {};
  if (!list.length) return map;
  map.F = list[0];
  if (list.length > 1) map.B = list[list.length - 1];
  let extra = 1;
  for (let i = 1; i < list.length - 1; i += 1) {
    map[String(extra).padStart(2, '0')] = list[i];
    extra += 1;
  }
  return map;
}

// Strip HTML tags from body_html to get plain-text description.
function stripHtmlTags(html = '') {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// Try to extract composition info (e.g. "100% Polyester") from description text.
function extractIntersportComposition(text = '') {
  if (!text) return null;
  const m = text.match(/(\d+%\s*(?:[A-Za-zÄäÖöÜüß]+\s*,?\s*)+)/);
  if (m) return m[1].trim();
  return null;
}

async function collectIntersportProductHandles(browser, listingUrl, maxCount, emitLog, ensureActive) {
  const page = await browser.newPage();
  try {
    await antiDetection.applyRetailBrowsingProfile(page);
    await page.setUserAgent(antiDetection.getRandomUserAgent());
    await page.setViewport(antiDetection.getRandomViewport());

    emitLog(`    🌐 Opening Intersport collection: ${listingUrl}`, 'info');
    await page.goto(listingUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await antiDetection.randomDelay(2500, 3500);
    ensureActive();

    // Dismiss cookie / consent banners.
    await page.evaluate(() => {
      const re = /^\s*(?:accept all|accept|agree|akzeptieren|alle akzeptieren|zustimmen|ok|got it|allow all|einverstanden)\s*$/i;
      for (const el of document.querySelectorAll('button, [role="button"], a')) {
        const t = String(el.textContent || '').trim();
        if (t && t.length < 30 && re.test(t)) { try { el.click(); } catch { /* noop */ } }
      }
    }).catch(() => {});
    await antiDetection.randomDelay(800, 1400);

    // Scroll to load all products (Shopify infinite scroll / load more).
    const handles = [];
    const seenHandles = new Set();
    let stableRounds = 0;
    let lastCount = -1;

    for (let round = 0; round < 60 && stableRounds < 3; round += 1) {
      ensureActive();
      await page.evaluate(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        for (let i = 0; i < 5; i += 1) {
          window.scrollBy(0, document.body.scrollHeight);
          await sleep(400);
        }
        // Click "load more / mehr laden / mehr anzeigen" if present.
        const re = /load\s*more|show\s*more|mehr\s*(?:laden|anzeigen)|weitere|more products/i;
        for (const el of document.querySelectorAll('button, a, [role="button"]')) {
          const t = String(el.textContent || '').trim();
          const r = el.getBoundingClientRect();
          if (t && t.length < 40 && re.test(t) && r.width > 0 && r.height > 0) {
            try { el.click(); } catch { /* noop */ }
          }
        }
      }).catch(() => {});
      await antiDetection.randomDelay(1200, 2000);

      // Extract product handles from the DOM (product card links).
      const domHandles = await page.evaluate(() => {
        const out = new Set();
        for (const a of document.querySelectorAll('a[href]')) {
          const href = a.getAttribute('href') || a.href || '';
          const m = href.match(/\/products\/([a-zA-Z0-9_-]+)/);
          if (m && m[1]) out.add(m[1]);
        }
        return [...out];
      }).catch(() => []);

      for (const h of domHandles) {
        if (!seenHandles.has(h)) {
          seenHandles.add(h);
          handles.push(h);
          if (maxCount > 0 && handles.length >= maxCount) break;
        }
      }

      const count = handles.length;
      emitLog(`    📦 Intersport listing: ${count} products found (round ${round + 1})…`, 'info');
      if (maxCount > 0 && handles.length >= maxCount) break;
      if (count === lastCount) stableRounds += 1; else stableRounds = 0;
      lastCount = count;
    }

    emitLog(`    ✅ Intersport listing harvested ${handles.length} product handles.`, 'success');
    return handles;
  } finally {
    await page.close().catch(() => {});
  }
}

async function scrapeIntersportProduct(handle, emitLog, ensureActive) {
  const url = `https://www.intersport.ch/products/${encodeURIComponent(handle)}.json`;
  emitLog(`    🔍 Fetching Intersport product ${handle}…`, 'info');
  ensureActive();

  let data;
  try {
    data = await fetchJson(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        Accept: 'application/json',
      },
      timeoutMs: 30000,
    });
  } catch (error) {
    throw new Error(`Intersport product request failed: ${error.message}`);
  }

  const product = data?.product;
  if (!product) throw new Error(`No product data for handle ${handle}`);

  const vendor = product.vendor || 'Unknown';
  const title = product.title || handle;
  const productType = product.product_type || '';
  const bodyHtml = product.body_html || '';
  const description = stripHtmlTags(bodyHtml);
  const composition = extractIntersportComposition(description);
  const productUrl = `https://www.intersport.ch/products/${encodeURIComponent(handle)}`;

  // Images: Shopify returns an array of { src, position, … }. Sort by position.
  const images = Array.isArray(product.images) ? [...product.images] : [];
  images.sort((a, b) => (Number(a?.position) || 0) - (Number(b?.position) || 0));
  const imageUrls = images.map((img) => img?.src).filter(Boolean);

  // Variants: collect unique colors and sizes.
  const variants = Array.isArray(product.variants) ? product.variants : [];
  const colors = [];
  const colorSet = new Set();
  for (const v of variants) {
    const c = v.option1 || '';
    if (c && !colorSet.has(c)) { colorSet.add(c); colors.push(c); }
  }
  const colorRef = colors[0] || '';
  const firstVariant = variants[0] || {};
  const price = firstVariant.price ? `${firstVariant.price} CHF` : '';
  const sku = firstVariant.sku || handle;

  const productName = `${vendor} ${title}`.trim();

  return {
    styleNumber: sku,
    productId: handle,
    brand: vendor,
    name: productName,
    category: productType,
    price,
    colorRef,
    description,
    composition: composition ? { outerShell: null, lining: null, other: composition } : null,
    url: productUrl,
    imageUrls,
  };
}

async function runBestsellerScraper(config, emitLog, emitProgress, taskController, previewBridge = null) {
  const ensureActive = () => taskController?.throwIfCancelled?.();
  const brand = String(config?.brand || 'newyorker').trim();
  const gender = String(config?.gender || 'female').trim();
  let { outputDir, downloadConcurrency } = config;
  // 0 (or negative/NaN) = download ALL images; any positive number caps per style.
  const rawImagesPerStyle = Number(config?.imagesPerStyle);
  const imagesPerStyle = Number.isFinite(rawImagesPerStyle) && rawImagesPerStyle > 0 ? Math.floor(rawImagesPerStyle) : 0;
  let browser = null;

  const brandKey = String(brand || '').trim().toLowerCase().replace(/\s+/g, '');
  const genderLabel = /male|man|men|男/i.test(gender) && !/female|woman|women|女/i.test(gender) ? 'Men' : 'Women';

  let listingUrl;
  let intersportCategory = '';
  let productCount = 0;
  if (brandKey === 'intersport') {
    intersportCategory = String(config?.intersportCategory || 'funktionsjacken').trim();
    productCount = Number(config?.productCount) || 0;
    listingUrl = buildIntersportUrl(intersportCategory, gender);
  } else {
    listingUrl = resolveBestsellerSource(brand, gender);
  }
  if (!listingUrl) throw new Error(`No bestseller source URL for ${brand} / ${gender}. Supported: New Yorker (male/female), Intersport (male/female + category).`);

  const brandLabel = brandKey === 'intersport' ? 'Intersport' : (getScraperOutputFolderName(brand) || 'New Yorker');
  const targetDir = !outputDir || outputDir === '未选择'
    ? path.join(app.getPath('desktop'), `Bestseller ${brandLabel} ${genderLabel}`)
    : outputDir;
  fs.mkdirSync(targetDir, { recursive: true });
  emitLog(`📁 Output directory: ${targetDir}`, 'info');
  emitLog(`🌐 Bestseller Analysis · ${brandLabel} · ${genderLabel}`, 'info');

  let executablePath = findChromePath();
  if (!executablePath) {
    emitLog('⬇️ No local Chrome found. Downloading Chrome runtime…', 'warning');
    const chromeInstall = await ensureChromeRuntimeAvailable((p) => { if (p?.status) emitLog(p.status, p.phase === 'complete' ? 'success' : 'info'); });
    if (!chromeInstall?.success) throw new Error(chromeInstall?.error || 'Chrome download failed.');
    executablePath = chromeInstall.executablePath;
  }

  try {
    // H&M product pages are heavily bot-guarded; sharing the regular H&M
    // scraper session (with its established cookies/auth) makes bestseller
    // scraping far more reliable than a fresh bestseller-only session.
    const sessionDir = brandKey === 'hm' ? getHmSessionDir() : getBestsellerSessionDir();
    // H&M's Akamai guard flags the default automation browser (verified: direct
    // nav 403s while the user's own Chrome works). Clone the user's real Chrome
    // identity into the H&M session so product pages load.
    if (brandKey === 'hm') prepareHmChromeProfile(emitLog);
    browser = await puppeteer.launch({
      executablePath,
      headless: false,
      userDataDir: sessionDir,
      args: antiDetection.getRetailLaunchArgs(),
      ignoreDefaultArgs: ['--enable-automation'],
      defaultViewport: null,
    });
    previewBridge?.attachToBrowser(browser);
    taskController?.onCancel(() => { if (browser && browser.isConnected()) browser.close().catch(() => {}); });

    emitProgress(3);
    emitLog('🚀 Step 1/2: harvesting bestseller style list…', 'warning');

    // Apparel-only filter shared by all brands. Excludes footwear, bags,
    // fragrance/perfume, beauty, luggage/suitcases, slippers, accessories, etc.
    const excludeCategoryRe = /sandal|slide|slipper|shoe|sneaker|boot|footwear|flip[\s-]?flop|espadrille|loafer|mule|heel|trainer|accessoire|accessory|bag|handbag|backpack|belt|jewel|sock|hat|cap|beanie|scarf|sunglass|glasses|watch|wallet|purse|perfume|fragrance|cologne|eau de|beauty|cosmetic|makeup|make-up|skincare|lipstick|nail|luggage|suitcase|trolley|cabin case|umbrella|tasche|gürtel|schuh|parfüm/i;
    const excludeApparel = config?.includeAccessories === true ? null : excludeCategoryRe;

    const products = [];
    let skippedNonApparel = 0;

    if (brandKey === 'intersport') {
      // ── Intersport (Shopify): Puppeteer listing → product.json API ──
      const handles = await collectIntersportProductHandles(browser, listingUrl, productCount, emitLog, ensureActive);
      if (!handles.length) throw new Error('No bestseller styles were found on the Intersport collection page.');
      emitProgress(10);
      const total = handles.length;
      emitLog(`🚀 Step 2/2: fetching ${total} Intersport product details…`, 'warning');
      for (let i = 0; i < total; i += 1) {
        ensureActive();
        const handle = handles[i];
        try {
          const result = await scrapeIntersportProduct(handle, emitLog, ensureActive);
          const catHay = `${result.category || ''} ${result.name || ''}`;
          if (excludeApparel && excludeApparel.test(catHay)) {
            skippedNonApparel += 1;
            emitLog(`    🚫 Skipped non-apparel: ${result.name || handle}`, 'info');
          } else {
            products.push(result);
          }
        } catch (error) {
          if (isCancellationError(error) || taskController?.cancelled) throw new TaskCancelledError();
          emitLog(`    ⚠️ ${handle} failed: ${error.message}`, 'warning');
          products.push({ styleNumber: handle, productId: handle, url: '', error: error.message, imageUrls: [] });
        }
        emitProgress(10 + Math.round(((i + 1) / total) * 40));
        await antiDetection.randomDelay(200, 500);
      }
    } else if (brandKey === 'zara') {
      // ── Zara: DOM-based listing → per-PDP detail scrape ──
      const links = await collectZaraBestsellerLinks(browser, listingUrl, emitLog, ensureActive);
      if (!links.length) throw new Error('No bestseller styles were found on the Zara listing page.');
      emitProgress(10);
      emitLog(`🚀 Step 2/2: fetching ${links.length} Zara product details…`, 'warning');
      for (let i = 0; i < links.length; i += 1) {
        ensureActive();
        const pdpUrl = links[i];
        try {
          const result = await scrapeZaraBestsellerProduct(browser, pdpUrl, emitLog, ensureActive);
          const catHay = `${result.category || ''} ${result.name || ''}`;
          if (excludeApparel && excludeApparel.test(catHay)) {
            skippedNonApparel += 1;
            emitLog(`    🚫 Skipped non-apparel: ${result.name || pdpUrl}`, 'info');
          } else if (!result.imageUrls?.length) {
            emitLog(`    ⚠️ ${result.name || pdpUrl}: no images`, 'warning');
            products.push(result);
          } else {
            products.push(result);
          }
        } catch (error) {
          if (isCancellationError(error) || taskController?.cancelled) throw new TaskCancelledError();
          emitLog(`    ⚠️ ${pdpUrl} failed: ${error.message}`, 'warning');
        }
        emitProgress(10 + Math.round(((i + 1) / links.length) * 40));
        await antiDetection.randomDelay(400, 900);
      }
    } else if (brandKey === 'hm') {
      // ── H&M: harvest article codes from listing (scroll + paginate + API),
      // then open EACH product page directly — the same reliable path the
      // regular H&M scraper (runHmScraper) uses. scrapeHmProduct navigates in
      // its own tab within the shared H&M session (established cookies), which
      // works far better than the old click-through+goBack juggling that lost
      // listing state and stalled. Product detail (composition/description) is
      // captured this way. If a product page is genuinely blocked, we fall back
      // to the listing-card images for that item and move on.
      const { articleLinks, listingPage } = await collectHmBestsellerLinks(browser, listingUrl, emitLog, ensureActive);
      if (!articleLinks.length) throw new Error('No bestseller styles were found on the H&M listing page.');
      emitProgress(10);
      emitLog(`🚀 Step 2/2: opening ${articleLinks.length} H&M product pages (in-session navigation)…`, 'warning');

      // Reuse the ONE listing tab that already cleared Akamai. Navigate it
      // product→product with an explicit Referer (previous page), so each hit
      // looks like same-origin in-session browsing rather than a cold direct
      // hit (which H&M 403s). No goBack — we jump straight to the next product.
      let refererUrl = listingUrl;

      for (let i = 0; i < articleLinks.length; i += 1) {
        ensureActive();
        const entry = articleLinks[i];
        const article = entry.article;
        let result = null;

        // Build a listing-card fallback result (used if the product page blocks).
        const cardFallback = () => {
          const thumbUrl = entry.thumbUrl || '';
          const normThumb = thumbUrl ? normalizeHmImageUrl(thumbUrl.startsWith('http') ? thumbUrl : `https:${thumbUrl}`) : '';
          const apiImgs = (entry.apiImages || []).map((u) => normalizeHmImageUrl(u.startsWith('http') ? u : `https:${u}`)).filter(Boolean);
          const allImgs = [normThumb, ...apiImgs].filter(Boolean);
          const deduped = [];
          const dedupSeen = new Set();
          for (const img of allImgs) {
            const key = hmImageDedupeKey(img);
            if (!dedupSeen.has(key)) { dedupSeen.add(key); deduped.push(img); }
          }
          return {
            styleNumber: article,
            productId: article,
            colorRef: article.length >= 10 ? article.slice(-3) : '',
            name: entry.name || '',
            price: entry.price || '',
            description: '',
            composition: '',
            url: entry.url,
            imageUrls: deduped,
          };
        };

        try {
          emitLog(`    🌐 H&M ${i + 1}/${articleLinks.length}: navigating to product ${article}…`, 'info');
          // Navigate the SAME (already-trusted) listing tab to the product URL
          // with a Referer of the previous page — mimics in-session browsing so
          // Akamai doesn't 403 it like a cold direct hit.
          const productUrl = entry.url || buildHmProductUrl(article);
          await listingPage.setExtraHTTPHeaders({ Referer: refererUrl }).catch(() => {});
          await listingPage.goto(productUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
          await antiDetection.randomDelay(1800, 2800);
          ensureActive();
          // Scrape the current page in-place (reusePage + skipNavigation).
          result = await scrapeHmProduct(browser, article, emitLog, ensureActive, listingPage, true);
          refererUrl = productUrl; // next product's referer = this product
          if (!result.imageUrls?.length) {
            const fb = cardFallback();
            if (fb.imageUrls.length) {
              emitLog(`    📋 H&M ${article}: product page gave no images, using ${fb.imageUrls.length} listing-card images`, 'info');
              result = fb;
            }
          }
        } catch (err) {
          if (isCancellationError(err) || taskController?.cancelled) throw new TaskCancelledError();
          // Blocked / failed product page → fall back to listing-card data.
          const fb = cardFallback();
          emitLog(`    ⚠️ H&M ${article} detail failed (${err.message}); using ${fb.imageUrls.length} listing-card images`, 'warning');
          result = fb.imageUrls.length ? fb : null;
        }

        if (result) {
          const catHay = `${result.name || ''}`;
          if (excludeApparel && excludeApparel.test(catHay)) {
            skippedNonApparel += 1;
            emitLog(`    🚫 Skipped non-apparel: ${result.name || article}`, 'info');
          } else {
            products.push(result);
          }
        }
        emitProgress(10 + Math.round(((i + 1) / articleLinks.length) * 40));
        await antiDetection.randomDelay(1200, 2200);
      }

      // Done with the shared listing/detail tab.
      await listingPage.close().catch(() => {});
    } else {
      // ── New Yorker: JSON API path ──
      const { tiles, apiIds } = await collectBestsellerArticleIds(browser, listingUrl, emitLog, ensureActive);
      if (!tiles.length) throw new Error('No bestseller styles were found on the listing page.');

      // Colour handling:
      //   allColors=false (default) → one representative colour per style.
      //   allColors=true            → every colour of each style.
      // Querying one article returns ALL its colour variants, so for all-colours
      // we scrape the tile articles with allVariants and expand each into one
      // record per colour (NOT by collecting sibling article ids — the API
      // returns the same variant list for every colour id of a style).
      const allColors = config?.allColors === true;
      const articleIds = tiles;
      emitLog(
        allColors
          ? `    🎨 Color mode: all colourways — expanding ${articleIds.length} styles into every colour.`
          : `    🎨 Color mode: one per style — ${articleIds.length} styles.`,
        'info',
      );

      emitProgress(10);
      emitLog(`🚀 Step 2/2: fetching ${articleIds.length} style details via New Yorker API…`, 'warning');

      for (let i = 0; i < articleIds.length; i += 1) {
        ensureActive();
        const ref = articleIds[i];
        try {
          const scraped = await scrapeNewYorkerProduct(ref, emitLog, ensureActive, { allVariants: allColors });
          const results = Array.isArray(scraped) ? scraped : [scraped];
          for (const result of results) {
            const catHay = `${result.category || ''} ${result.name || ''}`;
            if (excludeApparel && excludeApparel.test(catHay)) {
              skippedNonApparel += 1;
              emitLog(`    🚫 Skipped non-apparel: ${result.name || ref}`, 'info');
            } else {
              products.push(result);
            }
          }
        } catch (error) {
          if (isCancellationError(error) || taskController?.cancelled) throw new TaskCancelledError();
          emitLog(`    ⚠️ ${ref} failed: ${error.message}`, 'warning');
          products.push({ styleNumber: ref, productId: ref, url: '', error: error.message, imageUrls: [] });
        }
        emitProgress(10 + Math.round(((i + 1) / articleIds.length) * 40));
        await antiDetection.randomDelay(250, 650);
      }
    }

    if (skippedNonApparel > 0) {
      emitLog(`    🚫 Excluded ${skippedNonApparel} non-apparel item(s) (footwear / fragrance / luggage / accessories…).`, 'info');
    }

    emitProgress(50);
    const success = products.filter((p) => p.imageUrls?.length > 0);
    const failed = products.filter((p) => !p.imageUrls?.length);
    emitLog(`📊 Bestseller summary: ${success.length} styles ok, ${failed.length} failed, ${success.reduce((s, p) => s + p.imageUrls.length, 0)} images total.`, 'info');

    // Step 3: download images (respecting imagesPerStyle cap).
    const allTasks = [];
    for (const product of success) {
      ensureActive();
      const cleanSku = sanitizeFileSegment(String(product.productId || product.styleNumber || '').replace(/[./]/g, '-'), 'bestseller-item');
      const styleDir = path.join(targetDir, cleanSku);
      fs.mkdirSync(styleDir, { recursive: true });
      const capped = imagesPerStyle > 0 ? product.imageUrls.slice(0, imagesPerStyle) : product.imageUrls;
      const classified = brandKey === 'intersport'
        ? buildIntersportImageMap(capped)
        : buildNewYorkerImageMap(capped);
      const referer = brandKey === 'intersport' ? 'https://www.intersport.ch/'
        : (product.brand === 'Zara' ? 'https://www.zara.com/' : 'https://www.newyorker.de/');
      for (const [label, imgUrl] of Object.entries(classified)) {
        const ext = getUrlExtension(imgUrl, '.jpg');
        const filename = `${cleanSku}_${label}${ext}`;
        const filePath = path.join(styleDir, filename);
        allTasks.push(() => {
          ensureActive();
          return downloadFile(imgUrl, filePath, { headers: { Referer: referer, 'User-Agent': 'Mozilla/5.0' }, timeoutMs: 60000 })
            .then((size) => { if (size) emitLog(`    ⬇️ [saved] ${filename} (${size.toFixed(1)} KB)`); })
            .catch((error) => { emitLog(`    ❌ [failed] ${filename}: ${error.message}`, 'error'); });
        });
      }
      const infoData = { styleNumber: product.productId || product.styleNumber, brand: product.brand || brandLabel, gender: genderLabel, name: product.name, price: product.price, colorRef: product.colorRef || '', description: product.description || '', composition: product.composition || null, url: product.url, images: classified };
      fs.writeFileSync(path.join(styleDir, `${cleanSku}_info.json`), JSON.stringify(infoData, null, 2), 'utf-8');
    }

    emitLog(`📦 Downloading ${allTasks.length} bestseller images with ${downloadConcurrency} worker(s)...`, 'info');
    let done = 0;
    await parallelLimit(allTasks.map((t) => async () => { ensureActive(); await t(); done += 1; emitProgress(50 + Math.round((done / Math.max(allTasks.length, 1)) * 40)); }), downloadConcurrency || 6);

    // Persist a manifest the analysis step can read.
    fs.writeFileSync(path.join(targetDir, 'bestseller_manifest.json'), JSON.stringify({
      brand: brandLabel,
      gender: genderLabel,
      listingUrl,
      generatedAt: new Date().toISOString(),
      styleCount: success.length,
      styles: products.map((p) => ({
        styleNumber: p.productId || p.styleNumber,
        name: p.name,
        price: p.price,
        colorRef: p.colorRef || '',
        composition: p.composition || null,
        images: p.imageUrls?.length || 0,
        error: p.error || null,
      })),
    }, null, 2), 'utf-8');
    emitLog('📊 Saved bestseller_manifest.json', 'success');

    emitProgress(100);
    emitLog(`🎉 Bestseller scraping finished. Files saved to: ${targetDir}`, 'success');
    return { success: true, outputPath: targetDir, styleCount: success.length, failedCount: failed.length };
  } finally {
    if (browser && browser.isConnected()) await browser.close().catch(() => {});
  }
}

// ── Zara typed-search helpers (second-pass fallback) ────────────────────────
const ZARA_HOME_URL_US = 'https://www.zara.com/us/en/';
const ZARA_HOME_URL_ES = 'https://www.zara.com/es/en/';

async function dismissCommonZaraPopups(page) {
  try {
    const selectors = [
      '#onetrust-accept-btn-handler',
      'button[data-qa-id="cookies-banner-accept"]',
      'button[aria-label*="accept" i]',
    ];
    for (const sel of selectors) {
      const btn = await page.$(sel);
      if (btn) {
        await btn.click().catch(() => {});
        await page.waitForTimeout(500).catch(() => {});
      }
    }
  } catch { /* ignore */ }
}

async function openZaraSearchOverlay(page) {
  const directSelectors = [
    'a[href*="/search"]',
    'button[aria-label="Search"]',
    'button[aria-label="Buscar"]',
    'button[aria-label*="search" i]',
    'header [data-qa-action*="search" i]',
    'header button[aria-label*="search" i]',
    '[data-qa-id*="search" i]',
  ];
  for (const sel of directSelectors) {
    try {
      const handle = await page.$(sel);
      if (handle) {
        const visible = await handle.isIntersectingViewport().catch(() => true);
        if (visible) {
          await handle.click({ delay: 50 }).catch(() => {});
          return true;
        }
      }
    } catch { /* ignore */ }
  }
  return page.evaluate(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const s = window.getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
    };
    const candidates = [...document.querySelectorAll('button, a[href], [role="button"], [tabindex]')];
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const containerOk = el.closest('header, nav, [class*="header" i], [class*="Header"]');
      if (!containerOk) continue;
      const haystack = [
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
        el.getAttribute('data-testid'),
        el.getAttribute('href'),
        el.className,
        el.id,
      ].join(' ').toLowerCase();
      if (/\b(search|buscar)\b|\/search/.test(haystack)) {
        el.click();
        return true;
      }
    }
    return false;
  });
}

async function findVisibleZaraSearchInput(page) {
  return page.evaluateHandle(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 6) return false;
      const s = window.getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
    };
    const inputs = [...document.querySelectorAll(
      'input[type="search"], input[type="text"], input:not([type]), textarea'
    )].filter(isVisible);

    const ranked = inputs.find((el) => {
      const haystack = [
        el.getAttribute('type'),
        el.getAttribute('name'),
        el.getAttribute('placeholder'),
        el.getAttribute('aria-label'),
        el.getAttribute('id'),
        el.getAttribute('data-qa-id'),
        el.className,
      ].join(' ').toLowerCase();
      return /search|buscar|query|keyword/i.test(haystack);
    });
    return ranked || inputs[0] || null;
  });
}

async function extractFirstZaraSearchResultUrl(page) {
  return page.evaluate(() => {
    // Real Zara product URLs look like /es/en/some-product-name-p01943310.html?v1=...
    // Bare canonical/redirect aliases look like /es/en/-p01943310.html and redirect to home.
    // We must prefer the slugged form — return the bare form only as a last resort.
    const productUrlRegex = /zara\.com\/[a-z]{2}\/[a-z]{2}\/.*-p\d{6,12}\.html/i;
    const slugRegex = /zara\.com\/[a-z]{2}\/[a-z]{2}\/[^/?#]+-p\d{6,12}\.html/i;
    const bareAliasRegex = /zara\.com\/[a-z]{2}\/[a-z]{2}\/-p\d{6,12}\.html/i;

    const hrefs = [...document.querySelectorAll('a[href]')]
      .map((a) => a.href || '')
      .filter((href) => productUrlRegex.test(href));

    const slugged = hrefs.filter((href) => slugRegex.test(href) && !bareAliasRegex.test(href));
    if (slugged.length > 0) return slugged[0];
    if (hrefs.length > 0) return hrefs[0];
    return '';
  });
}

// Click the first visible product card on the Zara search-results page and wait
// for navigation, so the resulting page.url() is the real slugged product page.
// Uses puppeteer's elementHandle.click (real CDP mouse event) so Next.js / React
// handlers fire — in-page `a.click()` is often swallowed by SPA routers.
// Returns the navigated URL if successful, '' otherwise.
async function clickFirstZaraProductCard(page, emitLog) {
  const before = page.url();

  // Nudge lazy-loaded cards into the DOM, then settle scroll back to the top.
  await page.evaluate(() => window.scrollBy(0, 600)).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 600));
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 400));

  // Diagnostic: count product-link candidates so we can see when the click fails because no cards rendered.
  const diag = await page.evaluate(() => {
    const productLinkRegex = /zara\.com\/.*-p\d{6,12}\.html/i;
    const all = [...document.querySelectorAll('a[href]')];
    const matches = all.filter((a) => productLinkRegex.test(a.href || ''));
    return {
      total: all.length,
      matches: matches.length,
      sample: matches.slice(0, 3).map((a) => a.href || ''),
      url: location.href,
    };
  }).catch(() => ({ total: 0, matches: 0, sample: [], url: '' }));
  emitLog(`    🔎 Zara click probe: ${diag.matches}/${diag.total} product anchors on ${diag.url}`, 'info');

  // Pick the first viable product anchor and hand back an element handle.
  const cardHandle = await page.evaluateHandle(() => {
    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 5 || r.height < 5) return false;
      const s = window.getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
    };
    const productLinkRegex = /zara\.com\/.*-p\d{6,12}\.html/i;
    const links = [...document.querySelectorAll('a[href]')];
    // Tier 1: visible product anchor that wraps an image
    for (const a of links) {
      if (!productLinkRegex.test(a.href || '')) continue;
      if (!isVisible(a)) continue;
      if (!a.querySelector('img, picture')) continue;
      return a;
    }
    // Tier 2: any visible product anchor
    for (const a of links) {
      if (!productLinkRegex.test(a.href || '')) continue;
      if (!isVisible(a)) continue;
      return a;
    }
    // Tier 3: any product anchor in DOM (may be off-screen)
    for (const a of links) {
      if (productLinkRegex.test(a.href || '')) return a;
    }
    return null;
  }).catch(() => null);

  const cardElement = cardHandle ? cardHandle.asElement() : null;
  if (!cardElement) {
    if (cardHandle) await cardHandle.dispose().catch(() => {});
    emitLog('    ⚠️ Zara: no product anchor found in search results DOM', 'warning');
    return '';
  }

  const clickedHref = await page.evaluate((el) => {
    try { el.scrollIntoView({ behavior: 'instant', block: 'center' }); } catch { /* ignore */ }
    return el.href || '';
  }, cardElement).catch(() => '');
  emitLog(`    🖱️ Clicking Zara product card → ${clickedHref}`, 'info');

  // Real CDP click — fires React/Next.js handlers properly so the router navigates.
  let realClickOk = false;
  try {
    await cardElement.click({ delay: 60 });
    realClickOk = true;
  } catch (err) {
    emitLog(`    ⚠️ Zara real-click failed: ${err.message}; falling back to synthetic click`, 'warning');
  }
  if (!realClickOk) {
    await page.evaluate((el) => el.click(), cardElement).catch(() => {});
  }
  await cardElement.dispose().catch(() => {});

  await Promise.race([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null),
    page.waitForFunction(
      (prevUrl) => location.href !== prevUrl && /zara\.com\/[a-z]{2}\/[a-z]{2}\/[^/?#]+-p\d{6,12}\.html/i.test(location.href),
      { timeout: 20000, polling: 400 },
      before,
    ).catch(() => null),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const after = page.url();
  if (/zara\.com\/[a-z]{2}\/[a-z]{2}\/[^/?#]+-p\d{6,12}\.html/i.test(after)
      && !/zara\.com\/[a-z]{2}\/[a-z]{2}\/-p\d{6,12}\.html/i.test(after)) {
    emitLog(`    ✅ Zara navigated into product: ${after}`, 'success');
    return after;
  }
  // Fall back to the slugged clicked href if navigation didn't update page.url() in time
  if (/zara\.com\/[a-z]{2}\/[a-z]{2}\/[^/?#]+-p\d{6,12}\.html/i.test(clickedHref)
      && !/zara\.com\/[a-z]{2}\/[a-z]{2}\/-p\d{6,12}\.html/i.test(clickedHref)) {
    emitLog(`    ↪️ Zara did not navigate; using slugged clicked href: ${clickedHref}`, 'info');
    return clickedHref;
  }
  emitLog(`    ⚠️ Zara click did not result in a slugged product URL (after=${after})`, 'warning');
  return '';
}

async function searchZaraByTyping(browser, query, emitLog, ensureActive) {
  emitLog(`    🔍 Zara typed search "${query}" (search page)…`, 'info');
  const page = await browser.newPage();
  let keepPageOpen = false;
  try {
    await antiDetection.applyAntiDetection(page);
    await page.setViewport(antiDetection.getRandomViewport());
    await page.setUserAgent(antiDetection.getRandomUserAgent());

    // Go straight to Zara's dedicated search page — the input is already on the
    // page, so we skip the fragile header search-overlay button entirely.
    const SEARCH_PAGE_US = 'https://www.zara.com/us/en/search/home';
    const SEARCH_PAGE_ES = 'https://www.zara.com/es/en/search/home';
    await page.goto(SEARCH_PAGE_US, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await waitForZaraSettle(page);
    await dismissCommonZaraPopups(page);
    await antiDetection.randomDelay(1200, 2000);
    ensureActive();

    // The search input should already be present; only fall back to opening an
    // overlay if no visible input is found.
    let inputHandle = null;
    try {
      await page.waitForFunction(() => {
        const inputs = [...document.querySelectorAll('input[type="search"], input[type="text"], input:not([type]), textarea')];
        return inputs.some((el) => {
          const r = el.getBoundingClientRect();
          const s = window.getComputedStyle(el);
          return r.width >= 20 && r.height >= 6 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
        });
      }, { timeout: 12000, polling: 250 });
      inputHandle = await findVisibleZaraSearchInput(page);
    } catch {
      inputHandle = null;
    }

    if (!(inputHandle && inputHandle.asElement())) {
      emitLog('    🔎 Search input not visible; trying to open the search overlay…', 'info');
      await openZaraSearchOverlay(page).catch(() => false);
      await antiDetection.randomDelay(1200, 2000);
      ensureActive();
    }

    let inputElement = inputHandle ? inputHandle.asElement() : null;
    if (!inputElement) {
      emitLog('    🔁 Zara search input not visible yet; reopening overlay…', 'info');
      await openZaraSearchOverlay(page).catch(() => false);
      await antiDetection.randomDelay(1500, 2500);
      try {
        await page.waitForFunction(() => {
          const inputs = [...document.querySelectorAll('input[type="search"], input[type="text"], input:not([type]), textarea')];
          return inputs.some((el) => {
            const r = el.getBoundingClientRect();
            const s = window.getComputedStyle(el);
            return r.width >= 20 && r.height >= 6 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
          });
        }, { timeout: 10000, polling: 250 });
        inputHandle = await findVisibleZaraSearchInput(page);
        inputElement = inputHandle ? inputHandle.asElement() : null;
      } catch {
        inputElement = null;
      }
    }

    if (!inputElement) {
      emitLog('    ⚠️ Zara search input did not appear after opening overlay.', 'warning');
      return '';
    }

    try {
      await inputElement.click({ delay: 80 });
    } catch {
      await page.evaluate((el) => el.focus(), inputElement).catch(() => {});
    }
    await antiDetection.randomDelay(300, 600);

    emitLog(`    ⌨️ Typing Zara search "${query}" via DOM write…`, 'info');
    await writeSearchValueViaDOM(page, inputElement, query, emitLog, 'Zara');
    ensureActive();

    emitLog('    ⏳ Waiting for Zara search results…', 'info');
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null),
      page.waitForFunction(
        () => [...document.querySelectorAll('a[href]')].some(
          (a) => /zara\.com\/.+-p\d{6,12}\.html/i.test(a.href),
        ),
        { timeout: 20000, polling: 400 },
      ).catch(() => null),
    ]);
    await antiDetection.randomDelay(1500, 2400);
    ensureActive();

    // If Zara auto-navigated to a real product page (slugged URL), use that directly.
    const checkUrlForRealProduct = (urlStr) => {
      if (!urlStr) return '';
      const slugRegex = /zara\.com\/[a-z]{2}\/[a-z]{2}\/[^/?#]+-p\d{6,12}\.html/i;
      const bareAliasRegex = /zara\.com\/[a-z]{2}\/[a-z]{2}\/-p\d{6,12}\.html/i;
      if (slugRegex.test(urlStr) && !bareAliasRegex.test(urlStr)) return urlStr;
      return '';
    };

    // Resolution priority:
    // 1) Zara auto-navigated straight to a slugged product page (best — full real URL)
    // 2) Click the first visible product card and use the navigated URL
    // 3) DOM-scrape a slugged href as a last resort
    let foundUrl = checkUrlForRealProduct(page.url());
    if (!foundUrl) {
      foundUrl = await clickFirstZaraProductCard(page, emitLog).catch(() => '');
    }
    if (!foundUrl) {
      foundUrl = await extractFirstZaraSearchResultUrl(page);
    }
    if (!foundUrl) {
      emitLog('    🔁 Zara: no results yet — pressing Enter again…', 'info');
      await page.keyboard.press('Enter').catch(() => {});
      await Promise.race([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null),
        page.waitForFunction(
          () => [...document.querySelectorAll('a[href]')].some(
            (a) => /zara\.com\/.+-p\d{6,12}\.html/i.test(a.href),
          ),
          { timeout: 15000, polling: 400 },
        ).catch(() => null),
      ]);
      await antiDetection.randomDelay(1200, 2000);
      ensureActive();
      foundUrl = checkUrlForRealProduct(page.url());
      if (!foundUrl) foundUrl = await clickFirstZaraProductCard(page, emitLog).catch(() => '');
      if (!foundUrl) foundUrl = await extractFirstZaraSearchResultUrl(page);
    }

    if (foundUrl) {
      emitLog(`    ✅ Zara typed search first result: ${foundUrl}`, 'success');
      // Keep the search page open so the caller can scrape directly from the navigated product page,
      // instead of closing it and reopening a fresh tab that may end up on the wrong content.
      keepPageOpen = true;
      return { url: foundUrl, page };
    } else {
      emitLog('    ⚠️ Zara typed search returned no products', 'warning');
    }
    return { url: '', page: null };
  } finally {
    if (!keepPageOpen) {
      await page.close().catch(() => {});
    }
  }
}

async function runScraper(config, emitLog, emitProgress, taskController, previewBridge = null) {
  if (config?.brand === 'mixed') {
    return runMixedBrandScraper(config, emitLog, emitProgress, taskController, previewBridge);
  }

  if (config?.brand === 'stradivarius') {
    return runStradivariusScraper(config, emitLog, emitProgress, taskController, previewBridge);
  }

  if (config?.brand === 'pullandbear') {
    return runPullAndBearScraper(config, emitLog, emitProgress, taskController, previewBridge);
  }

  if (config?.brand === 'bershka') {
    return runBershkaScraper(config, emitLog, emitProgress, taskController, previewBridge);
  }


  if (config?.brand === 'uniqlo') {
    return runUniqloScraper(config, emitLog, emitProgress, taskController, previewBridge);
  }

  if (config?.brand === 'gu') {
    return runGuScraper(config, emitLog, emitProgress, taskController, previewBridge);
  }

  if (config?.brand === 'lefties') {
    return runLeftiesScraper(config, emitLog, emitProgress, taskController, previewBridge);
  }

  if (config?.brand === 'mango') {
    return runMangoScraper(config, emitLog, emitProgress, taskController, previewBridge);
  }

  if (config?.brand === 'reserved') {
    return runReservedScraper(config, emitLog, emitProgress, taskController, previewBridge);
  }

  if (config?.brand === 'sinsay') {
    return runSinsayScraper(config, emitLog, emitProgress, taskController, previewBridge);
  }

  if (config?.brand === 'urbanrevivo') {
    return runUrbanRevivoScraper(config, emitLog, emitProgress, taskController, previewBridge);
  }

  if (config?.brand === 'newyorker') {
    return runNewYorkerScraper(config, emitLog, emitProgress, taskController, previewBridge);
  }

  if (config?.brand === 'hm') {
    return runHmScraper(config, emitLog, emitProgress, taskController, previewBridge);
  }

  if (config?.brand === 'abercrombie') {
    return runAbercrombieScraper(config, emitLog, emitProgress, taskController, previewBridge);
  }

  let { styleNumbers, excelPath, outputDir, tabConcurrency, downloadConcurrency } = config;
  styleNumbers = normalizeManualStyleNumbers(styleNumbers);
  // Zara backup mode: skip the direct-PDP first round entirely and scrape every
  // style through the search-box flow (type style number → open first result →
  // scrape). Useful when this machine's direct-PDP requests are being throttled.
  const zaraBackupMode = config?.zaraBackupMode === true || config?.backupMode === true;
  const ensureActive = () => taskController?.throwIfCancelled?.();
  let browser = null;

  // 处理 Excel 导入逻辑
  if (excelPath) {
    try {
      ensureActive();
      emitLog(`正在解析 Excel 文件: ${excelPath}`, 'info');
      const wb = XLSX.readFile(excelPath);
      const ws = wb.Sheets[wb.SheetNames[0]];
      const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
      styleNumbers = [];
      for (let i = 1; i < data.length; i++) {
        if (data[i] && data[i][1]) styleNumbers.push(String(data[i][1]).trim());
      }
      emitLog(`成功从 Excel 提取 ${styleNumbers.length} 个款号`, 'success');
    } catch (e) {
      throw new Error(`Excel 解析失败: ${e.message}`);
    }
  }

  ensureActive();
  if (!styleNumbers || styleNumbers.length === 0) throw new Error('没有找到任何款号，请检查输入或 Excel 格式 (款号需在第二列)');

  emitLog(`📋 即将处理 ${styleNumbers.length} 个款号`, 'info');

  // 输出到桌面的 Zara 文件夹
  const targetDir = !outputDir || outputDir === '未选择' ? path.join(app.getPath('desktop'), 'Zara') : outputDir;
  fs.mkdirSync(targetDir, { recursive: true });

  emitLog(`📁 输出目录已设为: ${targetDir}`, 'info');
  emitLog(`🚀 正在启动浏览器环境...`, 'info');

  // 使用统一的 Chrome 检测函数
  let executablePath = findChromePath();
  if (!executablePath) {
    emitLog('⬇️ 没有检测到本地 Chrome，正在为 GS Bot 自动下载浏览器运行时...', 'warning');
    const chromeInstall = await ensureChromeRuntimeAvailable((payload) => {
      if (payload?.status) {
        emitLog(payload.status, payload.phase === 'complete' ? 'success' : 'info');
      }
    });
    if (!chromeInstall?.success) {
      throw new Error(chromeInstall?.error || 'Chrome download failed.');
    }
    executablePath = chromeInstall.executablePath;
  }
  emitLog(`🌐 使用浏览器: ${executablePath}`, 'info');

  try {
    browser = await puppeteer.launch({
      executablePath: executablePath,
      headless: false,
      args: antiDetection.getEnhancedLaunchArgs(),
      ignoreDefaultArgs: ['--enable-automation'],
      defaultViewport: null,
    });
    previewBridge?.attachToBrowser(browser);

    taskController?.onCancel(() => {
      if (browser && browser.isConnected()) {
        browser.close().catch(() => {});
      }
    });

    const products = [];
    let currentProgress = 5;
    emitProgress(currentProgress);
    const totalStyles = styleNumbers.length;
    const effectiveTabConcurrency = 3;

    const processStyleOnce = async (styleNum, urlOverride = null, existingPage = null) => {
        ensureActive();
      // 计算图片匹配 ID
      const cleanNum = styleNum.replace(/[^0-9]/g, '');
      let fullId;
      if (cleanNum.length >= 9) {
        // 9位或更多: 取前7位，补0到8位
        fullId = cleanNum.substring(0, 7).padStart(8, '0');
      } else if (cleanNum.length === 8) {
        // 8位: 直接使用
        fullId = cleanNum;
      } else if (cleanNum.length === 7) {
        // 7位: 补0到8位
        fullId = cleanNum.padStart(8, '0');
      } else {
        // 其他: 补0到8位
        fullId = cleanNum.padStart(8, '0');
      }

      const url = urlOverride || buildUrl(styleNum);
      const capturedUrls = new Set();
      // Image filenames are <productId><colorTail>-<view>.jpg (e.g.
      // 04333476070-p.jpg). The full colour id matches ONLY the requested
      // colour; a bare product id (04333476) substring-matches every colour
      // variant (…080/…800), so we add the loose product-only ids ONLY when we
      // can't build a precise colour id.
      const candidateImageIds = new Set();
      const preciseColorId = (fullId && cleanNum.length >= 3) ? `${fullId}${cleanNum.slice(-3)}` : '';
      candidateImageIds.add(cleanNum);
      if (preciseColorId) {
        candidateImageIds.add(preciseColorId);
      } else {
        candidateImageIds.add(fullId);
        if (cleanNum.length >= 8) candidateImageIds.add(cleanNum.substring(0, 8));
        if (cleanNum.length >= 9) candidateImageIds.add(cleanNum.substring(0, 9));
        if (cleanNum.length >= 10) candidateImageIds.add(cleanNum.substring(0, 10));
        if (cleanNum.length >= 11) candidateImageIds.add(cleanNum.substring(0, 11));
      }

      emitLog(`    🔗 ${styleNum} → ${url} (匹配ID: ${fullId})`, 'info');

      // ── Firecrawl mode check ────────────────────────────────────────
      const currentMode = firecrawlService.getMode();
      if (currentMode === 'manual') {
        emitLog(`🔥 ${styleNum} 手动模式: 使用 Firecrawl 抓取`, 'warning');
        try {
          ensureActive();
          const fcResult = await firecrawlFallback.tryFirecrawlFallback(url, {
            imageFilter: (imgUrl, ids) => looksLikeZaraProductImageUrl(imgUrl, ids),
            urlNormalizer: normalizeZaraImageUrl,
            candidateIds: Array.from(candidateImageIds),
            emitLog: (msg, type) => emitLog(`    ${msg}`, type),
          });

          const hasZaraComposition = false;
          emitInditexScrapeResult({
            emitLog,
            brand: 'Zara',
            requestedReference: styleNum,
            actualStyleNumber: fullId || styleNum,
            productName: `Zara ${styleNum}`,
            imageCount: fcResult.imageUrls.length,
            hasDescription: false,
            hasComposition: hasZaraComposition,
          });

          return {
            styleNumber: styleNum,
            fullId,
            url,
            name: '',
            price: '',
            colorRef: '',
            description: '',
            composition: { outerShell: null, lining: null, other: null },
            imageUrls: fcResult.imageUrls,
            capturedCount: 0,
            usedEngine: 'firecrawl',
          };
        } catch (fcError) {
          emitLog(`❌ ${styleNum} Firecrawl 抓取失败: ${fcError.message}`, 'error');
          return { styleNumber: styleNum, fullId, url, error: fcError.message, imageUrls: [], usedEngine: 'firecrawl-failed' };
        }
      }
      // ── End Firecrawl manual mode ───────────────────────────────────

      // 智能重试机制
      // Round 1 is the direct-PDP scheme. If this machine is being throttled by
      // Zara the page stalls, so we only try ONCE here and let the round-2
      // search-box flow take over quickly instead of grinding 3 identical tries.
      const maxRetries = 1;
      let lastError = null;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          ensureActive();
          if (attempt > 1) {
            emitLog(`    🔄 ${styleNum} 第 ${attempt} 次尝试...`, 'warning');
            await antiDetection.randomDelay(2000, 4000);
            ensureActive();
          }

          let page;
          const reusedExistingPage = attempt === 1 && existingPage;
          if (reusedExistingPage) {
            // Reuse the typed-search page that already clicked into the product card.
            // Avoid re-opening a fresh tab on urlOverride which can land on wrong content.
            page = existingPage;
            emitLog(`    ♻️ ${styleNum} 复用搜索框点击进入的产品页`, 'info');
          } else {
            page = await browser.newPage();

            // 应用完整的反检测措施
            await antiDetection.applyAntiDetection(page);

            // 设置随机视口
            const viewport = antiDetection.getRandomViewport();
            await page.setViewport(viewport);

            // 设置随机User-Agent
            const userAgent = antiDetection.getRandomUserAgent();
            await page.setUserAgent(userAgent);

            emitLog(`    🎭 使用UA: ${userAgent.substring(0, 50)}...`, 'info');
            emitLog(`    📐 视口: ${viewport.width}x${viewport.height}`, 'info');
          }

          page.on('response', (resp) => {
            const reqUrl = resp.url();
            if (looksLikeZaraProductImageUrl(reqUrl, Array.from(candidateImageIds))) {
              const cleanUrl = normalizeZaraImageUrl(reqUrl);
              capturedUrls.add(cleanUrl);
              emitLog(`    📸 捕获图片: ${path.basename(cleanUrl)}`, 'info');
            }
          });

          // 随机延迟后访问页面
          await antiDetection.randomDelay(1000, 2000);
          ensureActive();
          if (reusedExistingPage) {
            // Reload so the response listener fires on all image requests for this product page.
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
          } else {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
          }
          // Zara's bare /-pXXXXXXXX.html URL does a client-side redirect to the
          // slug URL. domcontentloaded fires on the pre-redirect page, so any
          // page.evaluate that runs now hits "Execution context was destroyed".
          // Wait for the URL + DOM to stabilise before reading anything.
          await waitForZaraSettle(page);
          let navigatedProductId = extractZaraProductIdFromUrl(page.url());
          if (!navigatedProductId && /\/us\/en\//.test(url)) {
            const esUrl = url.replace('/us/en/', '/es/en/');
            emitLog(`    🌍 ${styleNum} US 站跳转到首页（该款 US 可能没货），尝试 ES 站: ${esUrl}`, 'warning');
            try {
              await page.goto(esUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
              await waitForZaraSettle(page);
              navigatedProductId = extractZaraProductIdFromUrl(page.url());
              if (navigatedProductId) {
                emitLog(`    ✅ ${styleNum} ES 站找到该款: ${navigatedProductId}`, 'success');
              } else {
                emitLog(`    ❌ ${styleNum} ES 站也未找到该款，可能已全面下架`, 'warning');
              }
            } catch (esErr) {
              emitLog(`    ⚠️ ${styleNum} ES 站访问失败: ${esErr.message}`, 'warning');
            }
          }
          const hasColorTail = navigatedProductId && cleanNum.length >= 3;
          // Only add the bare 8-digit product id when we DON'T have a precise
          // colour id. The bare id substring-matches every colour variant
          // (04333476 ⊂ 04333476080), pulling in other colours; the full
          // 11-digit colour id (04333476070) matches only the requested colour.
          if (navigatedProductId && !hasColorTail && !candidateImageIds.has(navigatedProductId)) {
            candidateImageIds.add(navigatedProductId);
            emitLog(`    🔁 ${styleNum} 页面跳转到真实商品ID: ${navigatedProductId}`, 'info');
          }
          if (hasColorTail) {
            const colorTail = cleanNum.slice(-3);
            const resolvedColorImageId = `${navigatedProductId}${colorTail}`;
            candidateImageIds.add(resolvedColorImageId);
            emitLog(`    🎯 ${styleNum} 图片匹配ID扩展: ${resolvedColorImageId}`, 'info');
          }
          const pageImageIds = await page.evaluate(() => {
            const ids = new Set();
            const addFromText = (value) => {
              const text = String(value || '');
              const patterns = [
                /\/(\d{7,14})(?:-\d{3})?[-_](?:p|b|a\d+|e\d+|f\d+|s\d+)\//gi,
                /\/(\d{7,14})(?:-\d{3})?[-_](?:p|b|a\d+|e\d+|f\d+|s\d+)\.(?:jpg|jpeg|webp|png)/gi,
                /C(\d{7,14})-V\d{4}/gi,
              ];
              for (const pattern of patterns) {
                let match;
                while ((match = pattern.exec(text)) !== null) {
                  if (match[1]) ids.add(match[1]);
                }
              }
            };
            document.querySelectorAll('script').forEach((script) => addFromText(script.textContent || ''));
            addFromText(document.documentElement.innerHTML || '');
            return [...ids];
          }).catch(() => []);
          const beforePageIdCount = candidateImageIds.size;
          // The slugged product page (reached via the search-box flow) embeds
          // EVERY colour variant + matching accessories in its JSON. Only keep
          // page-data IDs that belong to the requested product/colour, otherwise
          // we download other colours (e.g. ...080/...800) and accessory shots.
          const requestedProductId = navigatedProductId || (cleanNum.length >= 8 ? cleanNum.slice(0, 8) : '');
          const requestedColorId = (requestedProductId && cleanNum.length >= 3)
            ? `${requestedProductId}${cleanNum.slice(-3)}`
            : '';
          let acceptedPageIds = 0;
          pageImageIds.forEach((id) => {
            const sid = String(id);
            // Accept only: the exact colour id, the exact product id, or the
            // product id followed by the requested colour tail. Reject sibling
            // colours that share the product prefix but differ in the tail.
            const ok = requestedColorId
              ? (sid === requestedColorId || sid === requestedProductId || sid.startsWith(requestedColorId))
              : (requestedProductId ? sid.startsWith(requestedProductId) : true);
            if (ok) {
              candidateImageIds.add(sid);
              acceptedPageIds += 1;
            }
          });
          const addedPageIdCount = candidateImageIds.size - beforePageIdCount;
          if (addedPageIdCount > 0) {
            emitLog(`    🧬 ${styleNum} 从页面数据识别 ${addedPageIdCount} 个真实图片ID（已过滤其他颜色，保留 ${acceptedPageIds}）`, 'info');
          }
          
          // 检测是否被封禁
          const isBlocked = await antiDetection.detectBlocking(page).catch(() => false);
          if (isBlocked) {
            await page.close();
            throw new Error('检测到访问被限制，将重试');
          }

          // 随机延迟，模拟人类行为
          await antiDetection.randomDelay(3000, 5000);
          ensureActive();

          // 模拟鼠标移动
          await antiDetection.simulateMouseMovement(page).catch(() => {});

          // 关闭 cookie
          try {
            const btn = await page.$('#onetrust-accept-btn-handler');
            if (btn) {
              await btn.click();
              await antiDetection.randomDelay(500, 1000);
            }
          } catch (e) {}

          // Zara may fire a second (bot-challenge) navigation during the delays
          // above, which destroys the execution context. Re-settle right before
          // reading so the info evaluate runs against a live, stable context.
          await waitForZaraSettle(page);

          // ── Expand the "Composition & Care" accordion on Zara product pages ──
          // Zara hides fabric composition (e.g. "Outer shell: 100% Cotton")
          // inside a collapsed accordion panel labelled "Composition & Care"
          // or "Composition, Care and Source". Without expanding it, body
          // innerText will not contain any material data.
          await page.evaluate(() => {
            // 1. Open ALL <details> elements.
            document.querySelectorAll('details').forEach((el) => { el.open = true; });

            // 2. Click every collapsed accordion button / summary whose label
            //    mentions composition, material, care, or fabric.
            const RELEVANT = /composition|material|fabric|care/i;
            const triggers = [
              ...document.querySelectorAll(
                'button[aria-expanded="false"], summary, [role="button"][aria-expanded="false"], [class*="accordion"] button, [data-testid*="accordion"] button, [class*="collapse"] button, [class*="toggle"] button',
              ),
            ];
            triggers.forEach((node) => {
              const label = String(node.textContent || '').replace(/\s+/g, ' ').trim();
              if (label.length < 80 && RELEVANT.test(label)) {
                try { node.click(); } catch { /* ignore */ }
              }
            });

            // 3. Zara sometimes uses a dedicated expandable section wrapper
            //    with a clickable heading/title that is not a <button>.
            document.querySelectorAll('[class*="expandable"], [class*="collapsible"], [class*="section"], [data-testid*="section"]').forEach((el) => {
              const heading = el.querySelector('h2, h3, h4, [class*="title"], [class*="heading"], [class*="header"]');
              if (heading && RELEVANT.test(String(heading.textContent || ''))) {
                // Click the heading itself or an inner clickable element
                const btn = heading.querySelector('button, [role="button"]') || heading;
                try { btn.click(); } catch { /* ignore */ }
              }
            });
          }).catch(() => {});

          // Brief pause so the DOM can settle after accordion expansions.
          await antiDetection.randomDelay(600, 1000);
          await waitForZaraSettle(page);

          // 提取产品信息
          const info = await (async () => {
            // Retry once if a late bot-challenge navigation destroys the context.
            for (let attemptInfo = 0; attemptInfo < 2; attemptInfo += 1) {
              try {
                // eslint-disable-next-line no-await-in-loop
                return await page.evaluate(() => {
          const h1 = document.querySelector('h1');
          const name = h1 ? h1.textContent.trim() : '';

          let price = '';
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const t = walker.currentNode.textContent.trim();
            if (t.match(/^\$\s*[\d,.]+$/) && t.length < 20) { price = t; break; }
          }

          let colorRef = '';
          const bodyText = document.body.innerText;
          const m = bodyText.match(/([A-Za-z\s\/-]+)\s*\|\s*(\d{4}\/\d{3}\/\d{3})/);
          if (m) colorRef = m[0].trim();

          let description = '';
          const ps = document.querySelectorAll('p');
          for (const p of ps) {
            const t = p.textContent.trim();
            if (t.length > 30 && t.length < 500 && !t.includes('Cookie') &&
                !t.includes('Shipping') && (t.includes('.') || t.includes('closure'))) {
              description = t; break;
            }
          }

          // Extract composition/material information - Enhanced version with separation
          let outerShell = '';
          let lining = '';
          let otherComposition = '';
          
          const allText = document.body.innerText;
          const sections = allText.split(/\n{2,}/);

          // Find the composition section
          let compositionSection = '';
          const compositionKeywords = [
            'COMPOSITION', 'OUTER SHELL', 'LINING', 'SHELL', 'FILLING',
            'Outer shell', 'Lining', 'Main material', 'Fabric', 'Material',
            'CARE', 'MATERIALS', 'FABRIC', 'Composition & Care',
            'Composition and Care', 'Composition, care',
          ];
          
          for (const section of sections) {
            const sectionTrimmed = section.trim();
            if (compositionKeywords.some(kw => sectionTrimmed.toUpperCase().includes(kw.toUpperCase()))) {
              compositionSection = sectionTrimmed;
              break;
            }
          }
          
          // If found composition section, parse it
          if (compositionSection) {
            const lines = compositionSection.split('\n').map(l => l.trim()).filter(l => l.length > 0);
            
            let currentCategory = 'other';
            
            for (const line of lines) {
              const lineUpper = line.toUpperCase();
              
              // Detect category headers
              if (lineUpper.includes('OUTER SHELL') || lineUpper.includes('SHELL') && !lineUpper.includes('LINING')) {
                currentCategory = 'outer';
                // Check if material info is on the same line
                if (/\d+%|Wool|Cotton|Viscose|Polyester|Leather|Suede|Linen|Silk|Nylon|Spandex|Elastane|Acrylic|Cashmere/i.test(line)) {
                  const materialPart = line.replace(/OUTER SHELL:?/i, '').replace(/SHELL:?/i, '').trim();
                  if (materialPart) {
                    outerShell += (outerShell ? ' | ' : '') + materialPart;
                  }
                }
                continue;
              }
              
              if (lineUpper.includes('LINING')) {
                currentCategory = 'lining';
                // Check if material info is on the same line
                if (/\d+%|Wool|Cotton|Viscose|Polyester|Leather|Suede|Linen|Silk|Nylon|Spandex|Elastane|Acrylic|Cashmere/i.test(line)) {
                  const materialPart = line.replace(/LINING:?/i, '').trim();
                  if (materialPart) {
                    lining += (lining ? ' | ' : '') + materialPart;
                  }
                }
                continue;
              }
              
              if (lineUpper.includes('FILLING') || lineUpper.includes('PADDING')) {
                currentCategory = 'other';
                continue;
              }
              
              // Extract material lines
              if (/\d+%|Wool|Cotton|Viscose|Polyester|Leather|Suede|Linen|Silk|Nylon|Spandex|Elastane|Acrylic|Cashmere/i.test(line) && line.length < 150) {
                if (currentCategory === 'outer') {
                  outerShell += (outerShell ? ' | ' : '') + line;
                } else if (currentCategory === 'lining') {
                  lining += (lining ? ' | ' : '') + line;
                } else {
                  otherComposition += (otherComposition ? ' | ' : '') + line;
                }
              }
            }
          }
          
          // Method 2: If not found, search in specific elements including
          // accordion panel content areas that should now be expanded.
          if (!outerShell && !lining && !otherComposition) {
            const detailElements = document.querySelectorAll(
              '.product-detail-info, .product-detail, [class*="composition"], [class*="material"], [class*="accordion"] [class*="content"], [class*="accordion"] [class*="body"], [class*="accordion"] [class*="panel"], [class*="expandable"] [class*="content"], [class*="collapsible"] [class*="content"]',
            );
            for (const el of detailElements) {
              const text = el.textContent.trim();
              if (/\d+%|Wool|Cotton|Viscose|Polyester/i.test(text) && text.length < 300) {
                otherComposition = text.split('\n').filter(l => l.trim().length > 0).join(' | ');
                break;
              }
            }
          }

          return { 
            name, 
            price, 
            colorRef, 
            description, 
            composition: {
              outerShell: outerShell || null,
              lining: lining || null,
              other: otherComposition || null
            }
          };
                });
              } catch (infoErr) {
                if (attemptInfo === 0 && /context was destroyed|frame was detached|Cannot find context/i.test(String(infoErr.message || ''))) {
                  await waitForZaraSettle(page);
                  continue;
                }
                // Give up on metadata but let the run continue with images.
                return { name: '', price: '', colorRef: '', description: '', composition: { outerShell: null, lining: null, other: null } };
              }
            }
            return { name: '', price: '', colorRef: '', description: '', composition: { outerShell: null, lining: null, other: null } };
          })();

          // 使用人类化滚动行为加载所有图片
          await antiDetection.humanScroll(page).catch(() => {});
          await antiDetection.randomDelay(1500, 2500);
          ensureActive();
          await waitForZaraSettle(page);

          // 从 DOM 补充提取
          const domUrls = await page.evaluate((ids) => {
          const urls = [];
          const candidateIds = (ids || []).map((item) => String(item || '')).filter(Boolean);
          // 检查所有可能包含图片的元素
          const selectors = [
            'img',
            'picture source',
            '[style*="background-image"]',
            '[data-src]',
            '[data-srcset]'
          ];
          
          document.querySelectorAll(selectors.join(', ')).forEach(el => {
            const srcs = [
              el.src,
              el.getAttribute('data-src'),
              el.getAttribute('srcset'),
              el.getAttribute('data-srcset'),
              el.style?.backgroundImage?.match(/url\(['"]?([^'"]+)['"]?\)/)?.[1]
            ].filter(Boolean);
            
            for (const s of srcs) {
              // 匹配所有可能的图片URL
              const matches = s.match(/https?:\/\/[^\s,'"]+\.(jpg|jpeg|webp|png)[^\s,'"']*/gi) || [];
              for (const u of matches) {
                const cleanUrl = u.split('?')[0];
                const lower = cleanUrl.toLowerCase();
                const idMatched = candidateIds.some((id) => cleanUrl.includes(id));
                if (idMatched
                    && !lower.includes('transparent-background')
                    && !lower.includes('/icons/')
                    && !lower.includes('/logo')
                    && !/[?&]w=(48|50|66|80|100)(?:&|$)/i.test(u)) {
                  urls.push(cleanUrl);
                }
              }
            }
          });
          
            return [...new Set(urls)]; // 去重
          }, Array.from(candidateImageIds)).catch(() => []);

          domUrls.forEach(u => {
            capturedUrls.add(u);
            console.log(`    🖼️ DOM提取: ${path.basename(u)}`);
          });

          // 增强的备用策略：使用智能URL生成器
          const capturedArray = Array.from(capturedUrls);
          let realCapturedCount = capturedArray.length; // 记录真实捕获的数量
          
          if (capturedArray.length === 0) {
            if (!navigatedProductId) {
              // 商品在 US/ES 都未找到，跳过智能URL生成避免无效404下载
              emitLog(`    ⏭️ ${styleNum} 商品在 US/ES 均未找到，跳过智能URL生成`, 'warning');
              realCapturedCount = 0;
            } else {
              // 场景1: 完全没有捕获到图片，使用智能URL生成
              emitLog(`    🔄 ${styleNum} 启用智能图片URL生成策略...`, 'warning');
              const smartUrls = imageUrlGenerator.generateSmartUrls(fullId);
              smartUrls.forEach(url => capturedUrls.add(url));
              realCapturedCount = 0;
              emitLog(`    ℹ️ ${styleNum} 已生成 ${smartUrls.length} 个智能URL，将尝试下载`, 'info');
            }
          } else if (capturedArray.length < 6) {
            // 场景2: 捕获到部分图片，但数量较少，推断更多URL
            emitLog(`    🔍 ${styleNum} 图片数量较少(${capturedArray.length}张)，推断更多URL...`, 'info');
            const siblingUrls = imageUrlGenerator.inferSiblingUrls(capturedArray);
            const existingSiblingUrls = [];
            for (const candidateUrl of siblingUrls.slice(0, 60)) {
              ensureActive();
              if (await checkRemoteFileExists(candidateUrl, {
                headers: { Referer: url },
                timeoutMs: 5000,
              })) {
                existingSiblingUrls.push(candidateUrl);
              }
            }
            if (existingSiblingUrls.length > 0) {
              emitLog(`    🧩 ${styleNum} 探测到 ${existingSiblingUrls.length} 张同目录额外图片`, 'info');
            }
            const inferredUrls = existingSiblingUrls.length > 0
              ? existingSiblingUrls
              : [
                ...imageUrlGenerator.inferSiblingUrls(capturedArray).slice(0, 24),
                ...imageUrlGenerator.inferAdditionalUrls(capturedArray, fullId),
              ];
            const beforeCount = capturedUrls.size;
            inferredUrls.forEach(url => capturedUrls.add(url));
            const addedCount = capturedUrls.size - beforeCount;
            emitLog(`    ➕ ${styleNum} 推断并添加了 ${addedCount} 个额外URL`, 'info');
          } else {
            // 场景3: 已捕获足够图片，仍然尝试推断少量额外URL
            const inferredUrls = imageUrlGenerator.inferAdditionalUrls(capturedArray, fullId);
            const limitedUrls = inferredUrls.slice(0, 10); // 只添加前10个
            const beforeCount = capturedUrls.size;
            limitedUrls.forEach(url => capturedUrls.add(url));
            const addedCount = capturedUrls.size - beforeCount;
            if (addedCount > 0) {
              emitLog(`    ➕ ${styleNum} 补充了 ${addedCount} 个可能的额外图片`, 'info');
            }
          }

          await page.close();
          ensureActive();

          emitLog(`    📊 ${styleNum} 捕获统计: 网络响应=${capturedUrls.size}张`, 'info');

          const hasZaraComposition = Boolean(
            info.composition && (
              info.composition.outerShell
              || info.composition.lining
              || info.composition.other
            ),
          );
          emitInditexScrapeResult({
            emitLog,
            brand: 'Zara',
            requestedReference: styleNum,
            actualStyleNumber: navigatedProductId || styleNum,
            productName: info.name || `Zara ${styleNum}`,
            imageCount: capturedUrls.size,
            hasDescription: Boolean(info.description),
            hasComposition: hasZaraComposition,
          });
          
          // 成功则跳出重试循环
          return {
            styleNumber: styleNum,
            fullId: fullId,  // 添加fullId用于文件命名
            url,
            ...info,
            imageUrls: Array.from(capturedUrls),
            capturedCount: realCapturedCount, // 真实捕获的数量
          };

        } catch (error) {
          if (taskController?.cancelled) {
            throw new TaskCancelledError();
          }
          lastError = error;
          emitLog(`    ⚠️ ${styleNum} 第 ${attempt} 次尝试失败: ${error.message}`, 'warning');
          
          if (attempt === maxRetries) {
            emitLog(`❌ ${styleNum} 所有重试均失败: ${error.message}`, 'error');
            return { styleNumber: styleNum, fullId, url, error: error.message, imageUrls: [] };
          }
        }
      }

      // 如果所有重试都失败
      emitLog(`❌ ${styleNum} 抓取失败: ${lastError?.message || '未知错误'}`, 'error');
      return { styleNumber: styleNum, fullId, url, error: lastError?.message || '未知错误', imageUrls: [] };
    };

    if (zaraBackupMode) {
      emitLog('🧭 已启用 Zara 备用抓取（搜索框模式）：跳过直连抓取，所有款号直接走搜索框输入。', 'warning');
      // Seed empty placeholders so the search-box loop below processes every style.
      for (const styleNum of styleNumbers) {
        const cleanNum = String(styleNum || '').trim();
        const fullId = cleanNum.length >= 8 ? cleanNum.slice(0, 8) : cleanNum;
        products.push({ styleNumber: cleanNum, fullId, url: '', imageUrls: [] });
      }
    } else {
      for (let i = 0; i < totalStyles; i += effectiveTabConcurrency) {
        ensureActive();
        const batch = styleNumbers.slice(i, i + effectiveTabConcurrency);
        emitLog(`🔄 正在处理批次 ${Math.floor(i/effectiveTabConcurrency)+1}: 款号 [${batch.join(', ')}]`, 'warning');

        const batchResults = await Promise.all(batch.map((styleNum) => processStyleOnce(styleNum)));

        ensureActive();
        products.push(...batchResults);
        currentProgress = 5 + Math.round(((i + batch.length) / totalStyles) * 45);
        emitProgress(currentProgress);

        if (i + effectiveTabConcurrency < totalStyles) {
          const batchDelay = 3000 + Math.random() * 2000;
          emitLog(`⏱️ 批次间隔休息 ${Math.round(batchDelay/1000)}秒...`, 'info');
          await antiDetection.randomDelay(batchDelay, batchDelay + 1000);
        }
      }
    }

    // ============ 第二轮：搜索框输入款号 ============
    const failedIndices = products
      .map((p, idx) => (!p.imageUrls || p.imageUrls.length === 0 ? idx : -1))
      .filter((idx) => idx !== -1);

    if (failedIndices.length > 0) {
      emitLog(`${zaraBackupMode ? '🔎 备用抓取' : '🔁 第一轮失败 ' + failedIndices.length + ' 个款号，启动第二轮'}搜索框输入模式（模拟人工）...`, 'warning');
      for (const idx of failedIndices) {
        ensureActive();
        const styleNum = products[idx].styleNumber;
        try {
          emitLog(`    🔎 ${styleNum} 进入第二轮搜索框输入...`, 'info');
          const searchResult = await searchZaraByTyping(browser, styleNum, emitLog, ensureActive);
          const foundUrl = searchResult?.url || '';
          const foundPage = searchResult?.page || null;
          if (!foundUrl) {
            emitLog(`    ❌ ${styleNum} 搜索框未找到任何结果`, 'warning');
            if (foundPage) {
              await foundPage.close().catch(() => {});
            }
            continue;
          }
          emitLog(`    ✅ ${styleNum} 搜索到第一个结果: ${foundUrl}`, 'success');
          const result = await processStyleOnce(styleNum, foundUrl, foundPage);
          if (result.imageUrls && result.imageUrls.length > 0) {
            products[idx] = result;
            emitLog(`    🎉 ${styleNum} 第二轮抓取成功！`, 'success');
          } else {
            emitLog(`    ⚠️ ${styleNum} 第二轮仍未抓到图片`, 'warning');
          }
        } catch (err) {
          if (err instanceof TaskCancelledError) throw err;
          emitLog(`    ⚠️ ${styleNum} 第二轮异常: ${err.message}`, 'warning');
        }
      }
    }

    ensureActive();
    emitLog('🌐 网页数据提取完毕，准备开启并发下载...', 'warning');

  // 统计结果
  const successProducts = products.filter(p => p.imageUrls && p.imageUrls.length > 0);
  const failedProducts = products.filter(p => !p.imageUrls || p.imageUrls.length === 0);
  const totalImages = successProducts.reduce((sum, p) => sum + p.imageUrls.length, 0);

  emitLog(`📊 抓取统计: 成功 ${successProducts.length} 个款式，失败 ${failedProducts.length} 个款式，共 ${totalImages} 张图片`, 'info');

  // 显示失败的款号
  if (failedProducts.length > 0) {
    emitLog(`⚠️  以下款号抓取失败:`, 'error');
    failedProducts.forEach(p => {
      const reason = p.error || '未找到图片';
      emitLog(`    ❌ ${p.styleNumber} - ${reason}`, 'error');
    });
  }

  if (totalImages === 0) {
    emitLog('❌ 没有抓取到任何图片，请检查款号是否正确或网络连接', 'error');
    return;
  }

    let allTasks = [];
    for (const product of products) {
      ensureActive();
    if (!product.imageUrls || product.imageUrls.length === 0) {
      continue;
    }

    // 使用原始款号作为文件夹名
    const styleDir = path.join(targetDir, product.styleNumber);
    fs.mkdirSync(styleDir, { recursive: true });

    // 分类图片 (去重)
    const classified = {};
    let unknownIdx = 1;

    for (const imgUrl of product.imageUrls) {
      const label = classifyImage(imgUrl, product.styleNumber)
        || classifyImage(imgUrl, product.fullId || '')
        || classifyZaraImageBySuffix(imgUrl);
      if (label && label !== 'X' && !classified[label]) {
        classified[label] = imgUrl;
      } else {
        classified[`X${String(unknownIdx).padStart(2, '0')}`] = imgUrl;
        unknownIdx++;
      }
    }

    // 创建下载任务
    // 区分真实捕获的URL和推断的URL
    const capturedCount = product.capturedCount || product.imageUrls.length;
    
    // 使用纯数字款号作为文件名前缀（去掉斜杠）
    const cleanStyleNumber = product.styleNumber.replace(/[^0-9]/g, '');
    
    for (const [label, imgUrl] of Object.entries(classified)) {
      const ext = path.extname(imgUrl.split('?')[0]) || '.jpg';
      const filename = `${cleanStyleNumber}_${label}${ext}`;
      const filePath = path.join(styleDir, filename);
      
      // 判断是否为推断的URL（索引较大的通常是推断的）
      const urlIndex = product.imageUrls.indexOf(imgUrl);
      const isInferred = urlIndex >= capturedCount;
      
      if (isInferred) {
        // 推断的URL使用静默模式，失败不报错
        allTasks.push(() => {
          ensureActive();
          return downloadFile(imgUrl, filePath, { silent: true })
          .then(size => {
            if (size) {
              emitLog(`    ⬇️ [已保存] ${filename} (${size.toFixed(1)} KB)`);
            }
            // 静默失败，不输出日志
          })
          .catch(() => {
            // 静默失败，不输出日志
          });
        });
      } else {
        // 真实捕获的URL，失败时报错
        allTasks.push(() => {
          ensureActive();
          return downloadFile(imgUrl, filePath)
          .then(size => {
            if (size) {
              emitLog(`    ⬇️ [已保存] ${filename} (${size.toFixed(1)} KB)`);
            }
          })
          .catch(err => emitLog(`    ❌ [失败] ${filename}: ${err.message}`, 'error'));
        });
      }
    }

    // 保存产品信息 JSON (仿照 zara_fast.js)
    const infoData = {
      styleNumber: product.styleNumber,
      name: product.name,
      price: product.price,
      colorRef: product.colorRef,
      description: product.description,
      composition: product.composition || null,
      url: product.url,
      images: classified,
    };
    const infoPath = path.join(styleDir, `${cleanStyleNumber}_info.json`);
    fs.writeFileSync(infoPath, JSON.stringify(infoData, null, 2), 'utf-8');
    emitLog(`📄 产品信息已保存: ${cleanStyleNumber}_info.json`, 'success');
    }

    emitLog(`📦 分配 ${downloadConcurrency} 个线程并发下载共 ${allTasks.length} 张图片...`, 'info');

    let completedTasks = 0;
    const tasksWithProgress = allTasks.map(task => async () => {
      ensureActive();
      await task();
      completedTasks++;
      emitProgress(50 + Math.round((completedTasks / allTasks.length) * 50));
    });

    await parallelLimit(tasksWithProgress, downloadConcurrency);
    ensureActive();
    emitProgress(100);

    const summary = products.map(p => ({
      styleNumber: p.styleNumber,
      name: p.name,
      price: p.price,
      colorRef: p.colorRef,
      composition: p.composition || null,
      images: p.imageUrls ? p.imageUrls.length : 0,
      error: p.error || null,
    }));
    const summaryPath = path.join(targetDir, 'summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf-8');
    emitLog(`📊 汇总信息已保存: summary.json`, 'success');

    emitLog(`🎉 所有任务完成！文件已保存至: ${targetDir}`, 'success');
  } finally {
    if (browser && browser.isConnected()) {
      await browser.close().catch(() => {});
    }
  }
}

function createWindow() {
  writeStartupLog('createWindow invoked');
  if (mainWindow && !mainWindow.isDestroyed()) {
    writeStartupLog('reusing existing window');
    mainWindow.focus();
    return mainWindow;
  }

  const windowIconPath = process.platform === 'win32'
    ? path.join(__dirname, 'icon.ico')
    : path.join(__dirname, 'icon.png');
  const isMac = process.platform === 'darwin';
  const preloadPath = path.join(__dirname, 'preload.js');
  if (!fs.existsSync(preloadPath)) {
    const preloadErr = `PRELOAD MISSING: ${preloadPath}`;
    console.error(preloadErr);
    writeStartupLog(preloadErr);
  }

  mainWindow = new BrowserWindow({
    width: 1100, height: 800,
    minWidth: 980,
    minHeight: 720,
    // Solid (non-transparent) window background. No glass/acrylic — the CSS
    // paints its own solid gradient, giving a unified, seam-free look.
    backgroundColor: '#0f1320',
    ...(isMac
      ? {
          titleBarStyle: 'hiddenInset',
          trafficLightPosition: { x: 18, y: 18 },
        }
      : {
          // On Windows/Linux: hide the default menu bar and use a thin border
          // that blends with the app's dark background instead of the system grey.
          autoHideMenuBar: true,
          titleBarStyle: 'hidden',
          titleBarOverlay: {
            color: '#0f1320',
            symbolColor: '#ffffff',
            height: 40,
          },
        }),
    ...(fs.existsSync(windowIconPath) ? { icon: windowIconPath } : {}),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true, nodeIntegration: false
    }
  });
  writeStartupLog('BrowserWindow created');

  // Remove the default menu bar on Windows/Linux so File/Edit/View don't show.
  if (!isMac) {
    const { Menu } = require('electron');
    Menu.setApplicationMenu(null);
  }

  const useLocalDist = !app.isPackaged
    && (process.env.GSBOT_USE_DIST === '1' || process.argv.includes('--gsbot-use-dist'));
  const isDev = !app.isPackaged && !useLocalDist;

  if (isDev) {
    writeStartupLog('loading dev server: http://localhost:5173');
    mainWindow.loadURL('http://localhost:5173');
  } else {
    const htmlPath = path.join(__dirname, 'dist', 'index.html');
    console.log('Loading HTML from:', htmlPath);
    writeStartupLog(`loading file: ${htmlPath}`);
    mainWindow.loadFile(htmlPath);
  }

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    const errorLog = `[WINDOW LOAD ERROR] ${errorCode} ${errorDescription} ${validatedURL}\n`;
    console.error(errorLog);
    writeStartupLog(`did-fail-load: ${errorCode} ${errorDescription} ${validatedURL}`);
    writeErrorLog(errorLog);
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    writeStartupLog(`render-process-gone: ${JSON.stringify(details)}`);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    writeStartupLog('renderer finished load');
  });

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const logLine = `[renderer-${level}] ${sourceId}:${line} ${message}`;
    writeStartupLog(logLine);
    if (level === 'error') console.error(logLine);
    else console.log(logLine);
  });

  mainWindow.once('ready-to-show', () => {
    writeStartupLog('window ready-to-show');
  });

  mainWindow.on('closed', () => {
    writeStartupLog('main window closed');
    mainWindow = null;
  });

  // 开发模式下打开开发者工具（调试用）
  if (isDev || process.env.GSBOT_DEBUG === '1') {
    mainWindow.webContents.openDevTools();
  }

  return mainWindow;
}

if (process.platform === 'win32') {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

// 启用 GPU 进程崩溃恢复（不直接禁用 GPU，避免 CSS 效果卡顿）
app.commandLine.appendSwitch('disable-gpu-process-crash-limit');

app.on('will-finish-launching', () => {
  writeStartupLog('app will-finish-launching');
});

app.on('before-quit', () => {
  writeStartupLog('app before-quit');
});

app.on('will-quit', () => {
  writeStartupLog('app will-quit');
});

app.on('quit', (_event, exitCode) => {
  writeStartupLog(`app quit with code ${exitCode}`);
});

app.whenReady().then(async () => {
  try {
    writeStartupLog('app whenReady resolved');
    const chromePath = findChromePath();
    if (chromePath) {
      console.log('Found Chrome at:', chromePath);
      writeStartupLog(`chrome detected: ${chromePath}`);
    } else {
      console.warn('Chrome was not found at startup. The app will open and Setup Guide will surface the missing dependency.');
      writeStartupLog('chrome missing at startup');
    }
    createWindow();
    // GitHub 自动更新：启动后延迟检查，弹窗提示新版，一键下载安装。
    require('./auto-updater').initAutoUpdater();
  } catch (error) {
    writeStartupLog(`startup catch: ${error.stack || error.message}`);
    writeErrorLog(`[STARTUP ERROR] ${error.message}\n${error.stack}`);
    await dialog.showErrorBox(
      '启动失败',
      `应用启动失败: ${error.message}\n\n请查看日志文件获取详细信息。`
    );
    app.quit();
  }
});

function findChromePath() {
  return runtimeResolver.findChromeExecutable();
}

function getPythonEnvironmentStatus() {
  const runtime = getPythonRuntime();
  if (!runtime) {
    return {
      available: false,
      command: '',
      packagesReady: false,
      missingModules: ['python3'],
    };
  }

  const commandLabel = runtimeResolver.describeRuntime(runtime);

  try {
    const probe = spawnSync(
      runtime.command,
      [
        ...runtime.args,
        '-c',
        "import importlib.util, json; mods=['pptx','PIL']; missing=[m for m in mods if importlib.util.find_spec(m) is None]; print(json.dumps({'missing': missing}))",
      ],
      {
        encoding: 'utf8',
        timeout: 8000,
        windowsHide: true,
        env: runtimeResolver.getPythonSpawnEnv(runtime),
      },
    );

    let missingModules = ['pptx', 'PIL'];
    if (probe.status === 0) {
      const parsed = JSON.parse((probe.stdout || '{}').trim() || '{}');
      missingModules = Array.isArray(parsed.missing) ? parsed.missing : [];
    }

    return {
      available: true,
      command: commandLabel,
      packagesReady: missingModules.length === 0,
      missingModules,
      torchFlavor: runtime?.torchFlavor || '',
    };
  } catch {
    return {
      available: true,
      command: commandLabel,
      packagesReady: false,
      missingModules: ['pptx', 'PIL'],
      torchFlavor: runtime?.torchFlavor || '',
    };
  }
}

async function getSystemStatus() {
  const chromePath = findChromePath();
  const python = getPythonEnvironmentStatus();
  const ollamaPath = ollamaManager.findOllama();
  const ollamaInstalled = await ollamaManager.checkOllamaInstalled();
  const ollamaRunning = ollamaInstalled ? await ollamaManager.checkServerRunning() : false;
  const paddleVlRuntime = runtimeResolver.getPaddleVlRuntimeStatus?.()
    || runtimeResolver.getBundledPaddleVlRuntimeStatus?.();
  const rmbgRuntime = runtimeResolver.getRmbgRuntimeStatus?.();
  return {
    platform: process.platform,
    chrome: {
      installed: Boolean(chromePath),
      path: chromePath || '',
      requiredBy: 'Zara Scraper',
    },
    python: {
      ...python,
      torchFlavor: python?.torchFlavor || '',
      requiredBy: 'Slides Maker, PPTX analysis, and PDF Squeezer',
    },
    ollama: {
      installed: ollamaInstalled,
      running: ollamaRunning,
      path: ollamaPath || '',
      requiredBy: 'Local AI',
    },
    paddleVl: {
      bundled: Boolean(paddleVlRuntime?.bundled),
      downloaded: Boolean(paddleVlRuntime?.downloaded),
      ready: Boolean(paddleVlRuntime?.ready),
      path: paddleVlRuntime?.home || '',
      entrypoint: paddleVlRuntime?.entrypoint || '',
      model: paddleVlRuntime?.model || 'paddleocr-vl-1.5',
      baseUrl: paddleVlRuntime?.baseUrl || '',
      message: paddleVlRuntime?.message || '',
      hint: paddleVlRuntime?.hint || '',
      requiredBy: 'Windows OCR',
    },
    rmbg: {
      bundled: Boolean(rmbgRuntime?.bundled),
      downloaded: Boolean(rmbgRuntime?.downloaded),
      ready: Boolean(rmbgRuntime?.ready),
      path: rmbgRuntime?.home || '',
      entrypoint: rmbgRuntime?.entrypoint || '',
      model: rmbgRuntime?.model || 'RMBG-2.0',
      message: rmbgRuntime?.message || '',
      hint: rmbgRuntime?.hint || '',
      requiredBy: 'Garment Cutout',
    },
  };
}

// IPC Handlers
ipcMain.handle('select-dir', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({ properties: ['openDirectory'] });
  return canceled ? null : filePaths[0];
});

ipcMain.handle('select-file', async (event, opts) => {
  const filters = opts?.filters || [
    { name: 'Excel Files', extensions: ['xlsx', 'xls'] },
    { name: 'All Files', extensions: ['*'] }
  ];
  const properties = opts?.properties || ['openFile'];
  const { canceled, filePaths } = await dialog.showOpenDialog({ properties, filters });
  return canceled ? null : (filePaths.length > 1 ? filePaths : filePaths[0]);
});

ipcMain.handle('select-rmbg-model', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openDirectory'],
    filters: [
      { name: 'Model Files', extensions: ['json', 'py', 'safetensors', 'bin'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  return canceled ? null : filePaths[0];
});

ipcMain.handle('import-rmbg-model', async (_event, selectedPath) => {
  try {
    return await importRmbgRuntime(selectedPath);
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// 选择分析文件（PDF/PPTX/JSON）
ipcMain.handle('select-analysis-file', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'Supported Files', extensions: ['pdf', 'pptx', 'json'] },
      { name: 'PDF', extensions: ['pdf'] },
      { name: 'PowerPoint', extensions: ['pptx'] },
      { name: 'JSON', extensions: ['json'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  return canceled ? null : filePaths[0];
});

ipcMain.handle('select-chat-attachments', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Supported Attachments', extensions: ['pdf', 'docx', 'pptx', 'xlsx', 'xls', 'txt', 'md', 'csv', 'json', 'png', 'jpg', 'jpeg', 'webp'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  return canceled ? [] : filePaths;
});

ipcMain.handle('select-rag-folder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openDirectory'],
  });
  return canceled ? null : filePaths[0];
});

ipcMain.handle('select-rag-files', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Supported Knowledge Files', extensions: ['pdf', 'docx', 'pptx', 'xlsx', 'xls', 'txt', 'md', 'csv', 'json', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff', 'xml', 'html', 'js', 'ts', 'jsx', 'tsx', 'yml', 'yaml'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  return canceled ? [] : filePaths;
});

ipcMain.handle('select-skill-package', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    properties: ['openFile', 'openDirectory'],
    filters: [
      { name: 'Skill Packages', extensions: ['zip', 'md'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  return canceled ? null : filePaths[0];
});

ipcMain.handle('get-system-status', async () => {
  return getSystemStatus();
});

ipcMain.handle('license-get-status', async () => {
  return licenseService.getLicenseStatus();
});

ipcMain.handle('license-activate', async (_event, payload = {}) => {
  return licenseService.activateLicense(payload.licenseKey || '');
});

ipcMain.handle('license-clear', async () => {
  licenseService.clearStoredLicense();
  return licenseService.getLicenseStatus();
});

ipcMain.handle('open-external-url', async (_event, url) => {
  try {
    await shell.openExternal(url);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});


ipcMain.handle('cancel-task', async (event, taskType) => {
  const controller = activeTaskControllers.get(getTaskKey(event.sender, taskType));

  if (!controller) {
    return { success: false, error: 'No active task found.' };
  }

  controller.cancel();
  return { success: true };
});

ipcMain.handle('task-center-list', async (event) => {
  return {
    success: true,
    ...listManagedTasksForSender(event.sender),
  };
});

ipcMain.handle('task-center-clear-history', async (event) => {
  return {
    success: true,
    result: clearTaskHistoryForSender(event.sender),
    ...listManagedTasksForSender(event.sender),
  };
});

ipcMain.handle('cache-center-summary', async () => {
  const namespaces = [
    'slides-precompute',
    'label-ocr-results',
  ];

  const summaries = [
    ...namespaces.map((namespace) => readNamespaceSummary(namespace)),
    ...readExtraCacheSummaries(),
  ];
  return {
    success: true,
    roots: getCacheRoots(),
    namespaces: summaries,
  };
});

ipcMain.handle('cache-center-clear-all', async (event) => {
  try {
    const result = clearAllCaches([
      'slides-precompute',
      'label-ocr-results',
    ]);
    const historyResult = clearTaskHistoryForSender(event.sender);
    return {
      success: true,
      result,
      historyResult,
      ...listManagedTasksForSender(event.sender),
    };
  } catch (error) {
    return {
      success: false,
      error: error.message || String(error),
    };
  }
});

ipcMain.handle('cache-center-clear', async (_event, namespace) => {
  try {
    return {
      success: true,
      result: clearNamespaceCache(namespace),
    };
  } catch (error) {
    return {
      success: false,
      error: error.message || String(error),
    };
  }
});

ipcMain.handle('start-task', async (event, config) => {
  const emitLog = (msg, type = 'info') => {
    event.sender.send('log', { time: new Date().toLocaleTimeString(), message: msg, type });
  };
  const emitProgress = (val) => event.sender.send('progress', val);

  try {
    assertLicensedForFeature();
    return await runManagedTask(event, 'scrape', async (taskController) => {
      updateTaskSnapshot(event.sender, 'scrape', {
        inputPath: String(config?.excelPath || config?.inputPath || '').trim(),
        outputPath: String(config?.outputDir || '').trim(),
        summary: `Brand · ${normalizeScraperBrand(config?.brand) || 'zara'}`,
        cacheMode: 'live-run',
      });
      await runScraper(config, emitLog, emitProgress, taskController, null);
      return {
        success: true,
        outputPath: String(config?.outputDir || '').trim(),
      };
    }, activeTaskControllers);
  } catch (error) {
    const licenseFailure = getLicenseFailurePayload(error);
    if (licenseFailure) {
      emitLog(licenseFailure.error, 'error');
      return licenseFailure;
    }
    emitLog(`致命错误: ${error.message}`, 'error');
    return { success: false, error: error.message };
  }
});

// ── Bestseller Analysis IPC ──────────────────────────────────────────────────
ipcMain.handle('bestseller-scrape', async (event, config = {}) => {
  const emitLog = (msg, type = 'info') => {
    event.sender.send('bestseller-log', { time: new Date().toLocaleTimeString(), message: msg, type });
  };
  const emitProgress = (val) => event.sender.send('bestseller-progress', val);
  try {
    assertLicensedForFeature();
    return await runManagedTask(event, 'bestseller', async (taskController) => {
      updateTaskSnapshot(event.sender, 'bestseller', {
        inputPath: `${config?.brand || 'newyorker'} · ${config?.gender || ''}`,
        outputPath: String(config?.outputDir || '').trim(),
        summary: 'Bestseller scrape',
        cacheMode: 'live-run',
      });
      return await runBestsellerScraper(config, emitLog, emitProgress, taskController, null);
    }, activeTaskControllers);
  } catch (error) {
    const licenseFailure = getLicenseFailurePayload(error);
    if (licenseFailure) { emitLog(licenseFailure.error, 'error'); return licenseFailure; }
    emitLog(`致命错误: ${error.message}`, 'error');
    return { success: false, error: error.message };
  }
});

ipcMain.handle('bestseller-analyze', async (event, config = {}) => {
  const emitLog = (msg, type = 'info') => {
    event.sender.send('bestseller-log', { time: new Date().toLocaleTimeString(), message: msg, type });
  };
  const emitProgress = (val) => event.sender.send('bestseller-progress', val);
  try {
    assertLicensedForFeature();
    return await runManagedTask(event, 'bestseller', async (taskController) => {
      const { generateBestsellerReport } = require('./bestseller-report');
      const sourceDir = String(config?.sourceDir || config?.outputDir || '').trim();
      if (!sourceDir) throw new Error('No scraped folder provided for analysis.');
      const language = config?.language || 'en';
      const fileName = language === 'zh' ? '热门款式趋势分析报告.docx' : 'Bestseller_Trend_Report.docx';
      const outputPath = path.join(sourceDir, fileName);
      updateTaskSnapshot(event.sender, 'bestseller', {
        inputPath: sourceDir,
        outputPath,
        summary: 'Bestseller trend analysis',
        cacheMode: 'live-run',
      });
      return await generateBestsellerReport(sourceDir, outputPath, {
        language,
        imagesPerStyle: Number(config?.imagesPerStyle) || 3,
        brandLabel: config?.brandLabel,
        genderLabel: config?.genderLabel,
        llm: config?.llm || {},
        llmMode: config?.llmMode || 'default',
        emitLog,
        emitProgress,
        ensureActive: () => taskController.throwIfCancelled(),
      });
    }, activeTaskControllers);
  } catch (error) {
    const licenseFailure = getLicenseFailurePayload(error);
    if (licenseFailure) { emitLog(licenseFailure.error, 'error'); return licenseFailure; }
    emitLog(`分析失败: ${error.message}`, 'error');
    return { success: false, error: error.message };
  }
});


// Excel标注功能
ipcMain.handle('preview-excel', async (event, config = {}) => {
  try {
    const { excelPath, brand = 'zara' } = config || {};
    if (!excelPath) {
      return { success: false, error: 'No Excel path provided' };
    }
    const workbook = XLSX.readFile(excelPath);
    const worksheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!worksheet) {
      return { success: true, total: 0, byBrand: {} };
    }
    const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
    let total = 0;
    const byBrand = {};
    const isMixed = String(brand).toLowerCase() === 'mixed';
    for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex] || [];
      if (isMixed) {
        const rawBrand = String(row[0] ?? '').replace(/ /g, ' ').trim();
        const rawStyle = String(row[1] ?? '').replace(/ /g, ' ').trim();
        if (!rawBrand && !rawStyle) continue;
        if (!rawStyle) continue;
        const normalizedBrand = normalizeScraperBrand(rawBrand) || 'unknown';
        byBrand[normalizedBrand] = (byBrand[normalizedBrand] || 0) + 1;
        total += 1;
      } else {
        const rawStyle = String(row[1] ?? '').replace(/ /g, ' ').trim();
        if (!rawStyle) continue;
        total += 1;
      }
    }
    return { success: true, total, byBrand };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('annotate-excel', async (event, config) => {
  const emitLog = (msg, type = 'info') => {
    event.sender.send('log', { time: new Date().toLocaleTimeString(), message: msg, type });
  };

  try {
    assertLicensedForFeature();
    return await runManagedTask(event, 'annotate', async (taskController) => {
      const { excelPath, outputDir, brand = 'zara' } = config;
      const normalizedBrand = normalizeScraperBrand(brand) || 'zara';
      const defaultOutputDir = path.join(
        app.getPath('desktop'),
        getScraperOutputFolderName(normalizedBrand),
      );
      const resolvedOutputDir = outputDir || defaultOutputDir;
      updateTaskSnapshot(event.sender, 'annotate', {
        inputPath: String(excelPath || '').trim(),
        outputPath: String(resolvedOutputDir || '').trim(),
        summary: `Brand · ${normalizedBrand}`,
        cacheMode: 'live-run',
      });

      const annotateModule = require(path.join(__dirname, 'annotate_excel.js'));
      const result = await annotateModule.annotateExcel(excelPath, resolvedOutputDir, emitLog, {
        ensureActive: () => taskController.throwIfCancelled(),
        brand: normalizedBrand,
      });

      return {
        success: true,
        outputPath: result,
        message: `Workbook saved: ${result}`,
      };
    }, activeTaskControllers);
  } catch (error) {
    const licenseFailure = getLicenseFailurePayload(error);
    if (licenseFailure) {
      emitLog(licenseFailure.error, 'error');
      return licenseFailure;
    }
    emitLog(`标注错误: ${error.message}`, 'error');
    return { success: false, error: error.message };
  }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// ============= Slides Maker / Analysis IPC Handlers =============
registerSlidesAnalysisHandlers({
  ipcMain,
  dialog,
  app,
  fs,
  path,
  runtimeResolver,
  getPythonRuntime,
  runManagedTask,
  updateTaskSnapshot,
  activeTaskControllers,
  assertLicensedForFeature,
  getLicenseFailurePayload,
});

registerPdfSqueezerHandlers({
  ipcMain,
  dialog,
  app,
  fs,
  path,
  runtimeResolver,
  getPythonRuntime,
  runManagedTask,
  updateTaskSnapshot,
  activeTaskControllers,
  assertLicensedForFeature,
  getLicenseFailurePayload,
});


ipcMain.handle('rag-probe-model', async (_event, payload = {}) => {
  try {
    const LLMClient = require('./llm-client');
    const llmConfigManager = require('./llm-config');
    const config = llmConfigManager.mergeWithDefaults(llmConfigManager.loadConfig());
    const kind = payload.kind === 'embedding' ? 'embedding' : 'answer';
    const route = payload.route === 'cloud' ? 'cloud' : 'local';
    const model = String(payload.model || '').trim();

    if (!model) {
      return { success: false, supported: false, error: 'No model selected.' };
    }

    if (kind === 'embedding') {
      const baseUrl = fixLLMBaseUrl(config.local?.baseUrl || 'http://localhost:11434');
      const client = new LLMClient({
        baseUrl,
        model,
        timeout: 120000,
      });

      const data = await client._requestJson('POST', '/api/embed', {
        model,
        input: ['RAG embedding test'],
      });

      const vector = Array.isArray(data?.embeddings) ? data.embeddings[0] : null;
      if (Array.isArray(vector) && vector.length > 0) {
        return {
          success: true,
          supported: true,
          kind,
          route: 'local',
          model,
          dimensions: vector.length,
        };
      }

      return {
        success: false,
        supported: false,
        kind,
        route: 'local',
        model,
        error: 'Embedding response did not include a usable vector.',
      };
    }

    const sourceConfig = route === 'cloud' ? config.cloud : config.local;
    if (!sourceConfig?.baseUrl) {
      return {
        success: false,
        supported: false,
        kind,
        route,
        model,
        error: `${route === 'cloud' ? 'Cloud' : 'Local'} route is not configured.`,
      };
    }

    const client = new LLMClient({
      baseUrl: fixLLMBaseUrl(sourceConfig.baseUrl),
      model,
      apiKey: route === 'cloud' ? (sourceConfig.apiKey || '') : '',
      timeout: 120000,
    });

    const text = await client.chat([
      { role: 'user', content: 'Reply with exactly OK.' },
    ], {
      temperature: 0,
      maxTokens: 8,
    });

    return {
      success: true,
      supported: Boolean(String(text || '').trim()),
      kind,
      route,
      model,
      text: String(text || '').trim(),
    };
  } catch (error) {
    return {
      success: false,
      supported: false,
      error: error.message,
      kind: payload.kind || 'answer',
      route: payload.route || 'local',
      model: payload.model || '',
    };
  }
});

ipcMain.handle('test-cloud-native-web-search', async (_event, config = {}) => {
  try {
    const LLMClient = require('./llm-client');
    const client = new LLMClient({
      baseUrl: fixLLMBaseUrl(config.baseUrl || ''),
      model: config.model || '',
      apiKey: config.apiKey || '',
    });

    const result = await client.researchWithNativeWeb(
      'Check whether native provider web search is available. Reply with a tiny live research digest.',
      { maxTokens: 180, temperature: 0 },
    );

    if (result?.success) {
      return {
        success: true,
        supported: true,
        method: result.method || '',
        text: result.text || '',
      };
    }

    return {
      success: true,
      supported: false,
      reason: result?.reason || 'native-web-search-unavailable',
      error: result?.error || '',
      attempts: result?.attempts || [],
    };
  } catch (error) {
    return {
      success: false,
      supported: false,
      error: error.message,
    };
  }
});

// ============= Ollama Manager IPC Handlers =============

const ollamaManager = require('./ollama-manager');
console.log('[OLLAMA-INIT] ollama-manager loaded');
console.log('[OLLAMA-INIT] findOllama:', ollamaManager.findOllama());

// 检查 Ollama 状态
ipcMain.handle('check-ollama-status', async () => {
  console.log('[IPC] check-ollama-status called');
  try {
    const installed = await ollamaManager.checkOllamaInstalled();
    console.log('[IPC] installed:', installed);
    const running = installed ? await ollamaManager.checkServerRunning() : false;
    console.log('[IPC] running:', running);
    const models = installed ? await ollamaManager.getInstalledModels() : [];
    console.log('[IPC] models:', JSON.stringify(models));
    return { installed, running, models };
  } catch (error) {
    console.error('[IPC] check-ollama-status error:', error);
    return { installed: false, running: false, models: [] };
  }
});

// 安装 Ollama
ipcMain.handle('install-ollama', async () => {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    const platform = process.platform;
    
    if (platform === 'darwin') {
      // macOS: 用官方安装脚本
      exec('curl -fsSL https://ollama.com/install.sh | sh', { timeout: 120000 }, (error, stdout, stderr) => {
        if (error) {
          // 尝试 brew
          exec('/opt/homebrew/bin/brew install ollama || /usr/local/bin/brew install ollama', { timeout: 120000 }, (err2) => {
            resolve(err2 ? { success: false, error: `Install failed: ${err2.message}` } : { success: true });
          });
        } else {
          resolve({ success: true });
        }
      });
    } else if (platform === 'linux') {
      exec('curl -fsSL https://ollama.com/install.sh | sh', { timeout: 120000 }, (error) => {
        resolve(error ? { success: false, error: error.message } : { success: true });
      });
    } else if (platform === 'win32') {
      shell.openExternal('https://ollama.com/download/windows')
        .then(() => {
          resolve({
            success: true,
            manual: true,
            message: 'Opened the Ollama for Windows installer page. Complete the installation, then reopen GS Bot.',
          });
        })
        .catch((error) => {
          resolve({
            success: false,
            error: `Could not open the Ollama download page automatically: ${error.message}`,
          });
        });
    } else {
      resolve({ success: false, error: 'Please install Ollama manually from https://ollama.com' });
    }
  });
});

// 启动 Ollama 服务
ipcMain.handle('start-ollama-server', async () => {
  const result = await ollamaManager.startOllamaServer();
  if (!result?.success) {
    return { success: false, error: result?.error || 'Failed to start Ollama.' };
  }
  return { success: true, alreadyRunning: result.alreadyRunning };
});

// 停止 Ollama 服务
ipcMain.handle('stop-ollama-server', async () => {
  await ollamaManager.stopOllamaServer();
  return { success: true };
});

// 下载模型
ipcMain.handle('pull-ollama-model', async (event, { modelName, channel }) => {
  const mainWindow = BrowserWindow.getAllWindows()[0];
  
  ollamaManager.pullModel(
    modelName,
    (progress, status) => {
      mainWindow.webContents.send(channel, { progress, status });
    },
    () => {
      mainWindow.webContents.send(channel, { progress: 100, status: 'Complete' });
    },
    (error) => {
      mainWindow.webContents.send(channel, { progress: -1, status: error });
    }
  );
  
  return { success: true };
});

ipcMain.handle('install-paddleocr-vl-runtime', async (_event, { channel } = {}) => {
  const mainWindow = BrowserWindow.getAllWindows()[0];
  const emitProgress = (payload) => {
    if (channel && mainWindow?.webContents) {
      mainWindow.webContents.send(channel, payload);
    }
  };

  const result = await installPaddleOcrVlRuntime(emitProgress);
  return result;
});

// Detect available OCR engines
ipcMain.handle('ocr-detect-available-engines', async () => {
  try {
    const { detectAvailableOcrEngines, buildDefaultOcrConfig, mergeOcrConfig } = require('./ocr-engine-config');
    const llmConfigMgr = require('./llm-config');
    const sharedCfg = llmConfigMgr.mergeWithDefaults(llmConfigMgr.loadConfig());
    const runtimeConfig = mergeOcrConfig((sharedCfg && sharedCfg.ocr) || {});
    const engines = await detectAvailableOcrEngines({ runtimeConfig });
    return { success: true, engines };
  } catch (e) {
    return { success: false, error: e.message, engines: [{ value: 'guten-ocr', label: { en: 'Guten OCR', zh: 'Guten OCR' } }] };
  }
});

// 删除模型
ipcMain.handle('remove-ollama-model', async (event, modelName) => {
  const result = await ollamaManager.removeModel(modelName);
  return result;
});

// ── OCR Model Store ─────────────────────────────────────────────────

// Sync catalog from official sources (HF / ModelScope)
ipcMain.handle('ocr-sync-catalog', async () => {
  try {
    const result = await ocrModelRegistry.syncCatalog({ online: true });
    return { success: true, data: result };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Get local catalog (offline, instant)
ipcMain.handle('ocr-list-catalog', async () => {
  try {
    const models = ocrModelRegistry.getCatalogForPlatform(process.platform);
    return { success: true, models };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ── Firecrawl Configuration IPC ──────────────────────────────────────────────
ipcMain.handle('firecrawl-get-config', async () => {
  try {
    firecrawlService.loadConfig();
    return { 
      success: true, 
      apiKey: firecrawlService.isConfigured() ? '***configured***' : '',
      isConfigured: firecrawlService.isConfigured()
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('firecrawl-save-config', async (_event, apiKey) => {
  try {
    const result = firecrawlService.saveConfig(String(apiKey || '').trim());
    return result;
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('firecrawl-get-mode', async () => {
  try {
    firecrawlService.loadConfig();
    return { 
      success: true, 
      mode: firecrawlService.getMode()
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('firecrawl-set-mode', async (_event, mode) => {
  try {
    const result = firecrawlService.setMode(mode);
    return result;
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ═══════════════════════════════════════════════════
// PaddleOCR Configuration Handlers
// ═══════════════════════════════════════════════════
ipcMain.handle('paddleOcrGetConfig', async () => {
  try {
    paddleOcrService.loadConfig();
    const config = paddleOcrService.getConfig();
    return { 
      success: true, 
      token: config.token,
      options: config.options,
      isConfigured: paddleOcrService.isConfigured()
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('paddleOcrSaveConfig', async (_event, token, options = {}) => {
  try {
    const result = paddleOcrService.saveConfig(String(token || '').trim(), options);
    return result;
  } catch (error) {
    return { success: false, error: error.message };
  }
});

ipcMain.handle('paddleOcrTestConnection', async (_event, token) => {
  try {
    const result = await paddleOcrService.testConnection(String(token || '').trim());
    return result;
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Get status of a specific model
ipcMain.handle('ocr-get-model-status', async (_event, modelId) => {
  try {
    const entry = ocrModelRegistry.getCatalogEntry(modelId);
    if (!entry) {
      return { success: false, error: `Unknown model: ${modelId}` };
    }
    const status = ocrModelRegistry.getLocalStatus(entry);
    return { success: true, ...status, supported: ocrModelRegistry.isPlatformSupported(entry) };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Download a model with progress
ipcMain.handle('ocr-download-model', async (event, { modelId, channel }) => {
  const mainWindow = BrowserWindow.getAllWindows()[0];

  const emitProgress = (data) => {
    try { mainWindow.webContents.send(channel, data); } catch { /* window closed */ }
  };

  const entry = ocrModelRegistry.getCatalogEntry(modelId);
  if (!entry) {
    emitProgress({ phase: 'error', status: `Unknown model: ${modelId}`, progress: 0 });
    return { success: false, error: `Unknown model: ${modelId}` };
  }

  const targetDir = ocrModelRegistry.getModelHome(modelId);
  const tempDir = path.join(os.tmpdir(), `gsbot-ocr-${modelId}-${Date.now()}`);

  try {
    ensureCleanDir(tempDir);
    fs.mkdirSync(targetDir, { recursive: true });

    const totalFiles = (entry.files || []).filter((f) => Boolean(f.required));
    let completedFiles = 0;

    // Download required files
    for (const file of (entry.files || [])) {
      const localName = file.localName || file.name;
      const fileUrl = ocrModelRegistry.getDownloadUrl(entry, file.name);
      const outputPath = path.join(targetDir, localName);

      if (!fileUrl) {
        emitProgress({
          phase: 'skip',
          status: `Skipping ${file.name} (no download URL)`,
          progress: Math.round(((completedFiles / Math.max(totalFiles.length, 1)) * 100)),
        });
        continue;
      }

      const fileSpan = file.required ? Math.round(100 / Math.max(totalFiles.length, 1)) : 5;

      emitProgress({
        phase: file.name,
        status: `Downloading ${file.name}…`,
        progress: Math.round((completedFiles / Math.max(totalFiles.length, 1)) * 100),
      });

      await downloadFileWithRetry(fileUrl, outputPath, (percent) => {
        emitProgress({
          phase: file.name,
          status: `Downloading ${file.name}… ${percent}%`,
          progress: Math.min(100,
            Math.round((completedFiles / Math.max(totalFiles.length, 1)) * 100)
            + Math.round((percent / 100) * fileSpan)),
        });
      }, {
        timeoutMs: 30 * 60 * 1000,
        retries: 3,
        retryDelayMs: 4000,
      });

      completedFiles++;
    }

    // Download runtime if needed (llama-server for GGUF models)
    if (entry.runtimeRequired === 'llama-server' && entry.runtimeUrl) {
      const runtimeZip = path.join(tempDir, 'runtime.zip');
      const extractDir = path.join(tempDir, 'runtime-extract');

      emitProgress({
        phase: 'runtime',
        status: 'Downloading llama.cpp runtime…',
        progress: 90,
      });

      await downloadFileWithRetry(entry.runtimeUrl, runtimeZip, (percent) => {
        emitProgress({
          phase: 'runtime',
          status: `Downloading llama.cpp runtime… ${percent}%`,
          progress: 90 + Math.round((percent / 100) * 8),
        });
      }, {
        timeoutMs: 10 * 60 * 1000,
        retries: 2,
        retryDelayMs: 4000,
      });

      emitProgress({ phase: 'extract', status: 'Extracting runtime…', progress: 98 });
      extractZipArchive(runtimeZip, extractDir);

      const runtimeExe = entry.runtimeZipEntry || 'llama-server.exe';
      const exePath = findFileRecursive(extractDir, (name) =>
        name.toLowerCase() === runtimeExe.toLowerCase(), 8);

      if (!exePath) {
        throw new Error(`${runtimeExe} was not found in the downloaded runtime.`);
      }

      fs.copyFileSync(exePath, path.join(targetDir, runtimeExe));
    }

    // Write manifest
    if (entry.manifestTemplate) {
      ocrModelRegistry.writeManifest(targetDir, entry.manifestTemplate);
    }

    emitProgress({ phase: 'complete', status: 'Ready', progress: 100 });

    return { success: true, outputPath: targetDir };
  } catch (error) {
    emitProgress({ phase: 'error', status: error.message, progress: 0 });
    return { success: false, error: error.message };
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// Delete an installed model
ipcMain.handle('ocr-delete-model', async (_event, modelId) => {
  try {
    const result = ocrModelRegistry.deleteModel(modelId);
    return result;
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// Debug log from renderer
ipcMain.on('debug-log', (event, msg) => {
  console.log('[RENDERER-DEBUG]', msg);
});

ipcMain.handle('open-local-path', async (_event, targetPath) => {
  try {
    const localPath = String(targetPath || '').trim();
    if (!localPath) {
      return { success: false, error: 'No file path provided.' };
    }

    const shellError = await shell.openPath(localPath);
    if (shellError) {
      return { success: false, error: shellError };
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message || 'Could not open file.' };
  }
});

ipcMain.handle('reveal-local-path', async (_event, targetPath) => {
  try {
    const localPath = String(targetPath || '').trim();
    if (!localPath) {
      return { success: false, error: 'No file path provided.' };
    }

    if (!fs.existsSync(localPath)) {
      return { success: false, error: 'The target path does not exist.' };
    }

    const stats = fs.statSync(localPath);
    if (stats.isDirectory()) {
      const shellError = await shell.openPath(localPath);
      if (shellError) {
        return { success: false, error: shellError };
      }
      return { success: true };
    }

    shell.showItemInFolder(localPath);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message || 'Could not reveal file.' };
  }
});

// ═══════════════════════════════════════════════════
// LLM Configuration Manager
// ═══════════════════════════════════════════════════
const llmConfig = require('./llm-config');

// 加载 LLM 配置
ipcMain.handle('load-llm-config', async () => {
  return llmConfig.loadConfig();
});

// 保存 LLM 配置
ipcMain.handle('save-llm-config', async (event, config) => {
  const success = llmConfig.saveConfig(config);
  return { success };
});

// 获取当前激活的 LLM 配置
ipcMain.handle('get-active-llm-config', async () => {
  return llmConfig.getActiveConfig();
});

// 测试通用API云端连接
ipcMain.handle('test-api-cloud-connection', async (_event, config = {}) => {
  try {
    const LLMClient = require('./llm-client');
    const baseUrl = fixLLMBaseUrl(String(config.baseUrl || '').trim());
    const model = String(config.model || '').trim();
    const apiKey = String(config.apiKey || '').trim();

    if (!baseUrl) {
      return { success: false, error: 'Please enter the API base URL.' };
    }
    if (!apiKey) {
      return { success: false, error: 'Please enter the API key.' };
    }

    const client = new LLMClient({
      baseUrl,
      model: model || 'gpt-4',
      apiKey,
      provider: 'openai',
      timeout: 30000,
    });

    const result = await client.testConnection();
    if (result.success) {
      return {
        success: true,
        models: result.models || [],
      };
    }
    return { success: false, error: result.error || 'Connection test failed.' };
  } catch (error) {
    return { success: false, error: error.message || 'Connection test failed.' };
  }
});

// 列出指定模式下可用的模型（options.force=true 时跳过缓存强制在线刷新）
ipcMain.handle('list-llm-models', async (_event, options = {}) => {
  try {
    const LLMClient = require('./llm-client');
    const cfg = llmConfig.mergeWithDefaults(llmConfig.loadConfig());
    const mode = options.mode || cfg.mode || 'local';
    const force = options.force === true;

    let baseUrl, model, apiKey;
    if (mode === 'cloud') {
      baseUrl = cfg.cloud?.baseUrl || '';
      model = cfg.cloud?.model || '';
      apiKey = cfg.cloud?.apiKey || '';
      // Return cached models first if available
      if (!force && cfg.cloud?.availableModels?.length) {
        return { success: true, models: cfg.cloud.availableModels, cached: true, currentModel: model };
      }
    } else if (mode === 'apiCloud') {
      const preset = (cfg.apiCloud?.presets || []).find((p) => p.id === (options.presetId || cfg.apiCloud?.activePresetId)) || {};
      baseUrl = preset.baseUrl || '';
      model = preset.model || '';
      apiKey = preset.apiKey || '';
      if (!force && preset.availableModels?.length) {
        return { success: true, models: preset.availableModels, cached: true, currentModel: model };
      }
    } else {
      // local
      baseUrl = cfg.local?.baseUrl || 'http://localhost:11434';
      model = cfg.local?.model || '';
      apiKey = '';
      if (!force && cfg.local?.installedModels?.length) {
        return { success: true, models: cfg.local.installedModels, cached: true, currentModel: model };
      }
    }

    if (!baseUrl) {
      return { success: false, error: 'No base URL configured for this mode.', models: [], currentModel: model };
    }

    const client = new LLMClient({ baseUrl, model, apiKey, timeout: 15000 });
    const result = await client.testConnection();
    if (result.success) {
      return { success: true, models: result.models || [], cached: false, currentModel: model };
    }
    return { success: false, error: result.error || 'Connection failed', models: [], currentModel: model };
  } catch (error) {
    return { success: false, error: error.message, models: [] };
  }
});

ipcMain.handle('chat-list-skills', async () => {
  try {
    return { success: true, skills: skillPackManager.listSkills() };
  } catch (error) {
    return { success: false, error: error.message, skills: [] };
  }
});

ipcMain.handle('chat-install-skill', async (_event, payload = {}) => {
  try {
    assertLicensedForFeature();
    const skill = payload.sourceType === 'url'
      ? await skillPackManager.installSkillFromUrl(payload.sourceValue)
      : await skillPackManager.installSkillFromPath(payload.sourceValue);

    return {
      success: true,
      skill,
      skills: skillPackManager.listSkills(),
    };
  } catch (error) {
    const licenseFailure = getLicenseFailurePayload(error);
    if (licenseFailure) {
      return licenseFailure;
    }
    return { success: false, error: error.message };
  }
});

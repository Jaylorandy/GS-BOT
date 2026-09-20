const OCR_ENGINE_GUTEN = 'guten-ocr';
const OCR_ENGINE_PADDLE_LOCAL = 'paddle-local';
const OCR_ENGINE_PADDLE_VL_LOCAL = 'paddlevl-local';
const OCR_ENGINE_DEEPSEEK_LOCAL = 'deepseek-local';
const OCR_ENGINE_PADDLE_CLOUD = 'paddle-cloud';

const DEFAULT_DEEPSEEK_LOCAL_MODEL = 'deepseek-ocr:3b';
const DEFAULT_PADDLE_VL_LOCAL_MODEL = 'paddleocr-vl-1.5';
const DEFAULT_PADDLE_CLOUD_MODEL = 'PaddleOCR-VL-1.6';

function isOllamaOcrModel(modelName = '') {
  const normalized = String(modelName || '').trim().toLowerCase();
  if (!normalized) return false;
  const ocrFamilies = ['deepseek-ocr', 'paddleocr-vl', 'paddle-ocr', 'ocr'];
  const family = normalized.split(':')[0];
  return ocrFamilies.some(f => family === f || family.startsWith(f));
}

const OCR_ENGINE_ALIASES = {
  'guten-ocr': OCR_ENGINE_GUTEN,
  'guten': OCR_ENGINE_GUTEN,
  'paddle-ocr': OCR_ENGINE_PADDLE_LOCAL,
  'paddle-local': OCR_ENGINE_PADDLE_LOCAL,
  'umi': OCR_ENGINE_GUTEN,
  'umi-local': OCR_ENGINE_GUTEN,
  'umi-ocr': OCR_ENGINE_GUTEN,
  'deepseek': OCR_ENGINE_DEEPSEEK_LOCAL,
  'deepseek-local': OCR_ENGINE_DEEPSEEK_LOCAL,
  'deepseek-ocr': OCR_ENGINE_DEEPSEEK_LOCAL,
  'deepseek-ocr-v2': OCR_ENGINE_DEEPSEEK_LOCAL,
  'paddle-vl': OCR_ENGINE_PADDLE_VL_LOCAL,
  'paddleocr-vl': OCR_ENGINE_PADDLE_VL_LOCAL,
  'paddleocr-vl-1.5': OCR_ENGINE_PADDLE_VL_LOCAL,
  'paddlevl': OCR_ENGINE_PADDLE_VL_LOCAL,
  'paddlevl-local': OCR_ENGINE_PADDLE_VL_LOCAL,
  'paddle-cloud': OCR_ENGINE_PADDLE_CLOUD,
  'paddle-api': OCR_ENGINE_PADDLE_CLOUD,
  'paddle-online': OCR_ENGINE_PADDLE_CLOUD,
};

function normalizePlatform(platform = process.platform) {
  const normalized = String(platform || '').trim().toLowerCase();

  if (!normalized) {
    return '';
  }

  if (normalized === 'mac' || normalized === 'macos' || normalized === 'osx') {
    return 'darwin';
  }

  if (normalized === 'windows' || normalized === 'win') {
    return 'win32';
  }

  return normalized;
}

function isMacPlatform(platform = process.platform) {
  return normalizePlatform(platform) === 'darwin';
}

function getDefaultOcrEngine(platform = process.platform) {
  return OCR_ENGINE_GUTEN;
}

function getDefaultOcrFallbackEngine(platform = process.platform) {
  return '';
}

function normalizeOcrEngineName(value = '', options = {}) {
  const platform = options.platform || process.platform;
  const allowEmpty = Boolean(options.allowEmpty);
  const defaultEngine = options.defaultEngine || getDefaultOcrEngine(platform);
  const normalized = String(value || '').trim().toLowerCase();

  if (!normalized) {
    return allowEmpty ? '' : defaultEngine;
  }

  return OCR_ENGINE_ALIASES[normalized] || normalized;
}

function getOcrEngineDisplayName(engine, options = {}) {
  const normalized = normalizeOcrEngineName(engine, {
    allowEmpty: true,
    platform: options.platform || process.platform,
  });

  switch (normalized) {
    case OCR_ENGINE_GUTEN:
      return 'Guten OCR';
    case OCR_ENGINE_PADDLE_VL_LOCAL:
      return 'PaddleOCR-VL 1.5';
    case OCR_ENGINE_DEEPSEEK_LOCAL:
      return `DeepSeek OCR${options.model ? ` (${options.model})` : ''}`;
    case OCR_ENGINE_PADDLE_LOCAL:
      return 'Paddle OCR';
    case OCR_ENGINE_PADDLE_CLOUD:
      return `PaddleOCR${options.model ? ` ${options.model}` : ''}（云端）`;
    default:
      return normalized || getOcrEngineDisplayName(getDefaultOcrEngine(options.platform), options);
  }
}

function isEmbeddedPaddleOcrEngine(engine, options = {}) {
  return normalizeOcrEngineName(engine, {
    allowEmpty: true,
    platform: options.platform || process.platform,
  }) === OCR_ENGINE_PADDLE_LOCAL;
}

function getSupportedOcrEngines(platform = process.platform) {
  return [OCR_ENGINE_GUTEN, OCR_ENGINE_DEEPSEEK_LOCAL, OCR_ENGINE_PADDLE_VL_LOCAL, OCR_ENGINE_PADDLE_CLOUD];
}

function buildDefaultOcrConfig(platform = process.platform) {
  return {
    engine: getDefaultOcrEngine(platform),
    fallbackEngine: getDefaultOcrFallbackEngine(platform),
    deepseekLocal: {
      enabled: false,
      provider: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: DEFAULT_DEEPSEEK_LOCAL_MODEL,
      apiKey: '',
    },
    paddleVlLocal: {
      enabled: false,
      provider: 'openai',
      baseUrl: '',
      model: DEFAULT_PADDLE_VL_LOCAL_MODEL,
      apiKey: '',
    },
    paddleCloud: {
      enabled: false,
      token: '',
      model: DEFAULT_PADDLE_CLOUD_MODEL,
    },
  };
}

function mergeOcrConfig(rawConfig = {}, platform = process.platform) {
  const defaults = buildDefaultOcrConfig(platform);
  const source = rawConfig || {};
  const hasEngine = Object.prototype.hasOwnProperty.call(source, 'engine');
  const hasFallbackEngine = Object.prototype.hasOwnProperty.call(source, 'fallbackEngine');
  const merged = {
    ...defaults,
    ...source,
    deepseekLocal: {
      ...defaults.deepseekLocal,
      ...((source && source.deepseekLocal) || {}),
    },
    paddleVlLocal: {
      ...defaults.paddleVlLocal,
      ...((source && source.paddleVlLocal) || {}),
    },
    paddleCloud: {
      ...defaults.paddleCloud,
      ...((source && source.paddleCloud) || {}),
    },
  };

  merged.engine = normalizeOcrEngineName(
    hasEngine ? source.engine : defaults.engine,
    { platform },
  );
  merged.fallbackEngine = normalizeOcrEngineName(
    hasFallbackEngine ? source.fallbackEngine : defaults.fallbackEngine,
    { allowEmpty: true, platform },
  );
  merged.fallbackEngine = '';

  return merged;
}

// Check which OCR engines are actually available
async function detectAvailableOcrEngines(options = {}) {
  const runtimeConfig = options.runtimeConfig || {};
  const available = [{ value: OCR_ENGINE_GUTEN, label: { en: 'Guten OCR', zh: 'Guten OCR' } }];

  // Check DeepSeek OCR (Ollama model or standalone service)
  try {
    const dsCfg = runtimeConfig.deepseekLocal || {};
    const baseUrl = String(dsCfg.baseUrl || 'http://localhost:11434').trim();
    const model = String(dsCfg.model || DEFAULT_DEEPSEEK_LOCAL_MODEL).trim();
    const provider = String(dsCfg.provider || 'ollama').trim().toLowerCase() || 'ollama';
    if (baseUrl && model) {
      const http = baseUrl.startsWith('https') ? require('https') : require('http');
      let reachable = false;

      if (provider === 'ollama') {
        // Ollama format: check /api/tags and scan ALL installed OCR models
        reachable = await new Promise((resolve) => {
          try {
            const url = new URL(baseUrl);
            const req = http.request({
              hostname: url.hostname,
              port: url.port,
              path: '/api/tags',
              method: 'GET',
              timeout: 3000,
            }, (res) => {
              let data = '';
              res.on('data', (c) => data += c);
              res.on('end', () => {
                if (res.statusCode === 200) {
                  try {
                    const body = JSON.parse(data);
                    const models = body.models || [];
                    const modelNames = models.map(m => m.name);
                    // Scan all installed models and filter OCR ones
                    const ocrModels = modelNames.filter(n => isOllamaOcrModel(n));
                    // Add each OCR model as a separate option
                    ocrModels.forEach(ocrModel => {
                      available.push({
                        value: `${OCR_ENGINE_DEEPSEEK_LOCAL}:${ocrModel}`,
                        label: {
                          en: `Ollama OCR (${ocrModel})`,
                          zh: `Ollama OCR（${ocrModel}）`,
                        },
                      });
                    });
                    resolve(ocrModels.length > 0);
                  } catch { resolve(true); }
                } else {
                  resolve(false);
                }
              });
            });
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
            req.end();
          } catch { resolve(false); }
        });
      } else {
        // OpenAI-compatible format: try a simple chat request to check connectivity
        reachable = await new Promise((resolve) => {
          try {
            const url = new URL(baseUrl);
            const pathSuffix = baseUrl.endsWith('/v1') || baseUrl.endsWith('/v1/') ? '/models' : '/v1/models';
            const reqPath = (url.pathname && url.pathname !== '/')
              ? (url.pathname.endsWith('/') ? url.pathname + 'models' : url.pathname + '/models')
              : pathSuffix;
            const req = http.request({
              hostname: url.hostname,
              port: url.port,
              path: reqPath,
              method: 'GET',
              timeout: 3000,
              headers: dsCfg.apiKey ? { Authorization: `Bearer ${dsCfg.apiKey}` } : {},
            }, (res) => {
              resolve(res.statusCode === 200 || res.statusCode === 401);
            });
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
            req.end();
          } catch { resolve(false); }
        });
      }

      if (reachable && provider !== 'ollama') {
        const displayModel = model || DEFAULT_DEEPSEEK_LOCAL_MODEL;
        available.push({
          value: OCR_ENGINE_DEEPSEEK_LOCAL,
          label: {
            en: `Ollama OCR (${displayModel})`,
            zh: `Ollama OCR（${displayModel}）`,
          },
        });
      }
    }
  } catch (e) { /* skip */ }

  // Check Paddle VL local
  try {
    const pvCfg = runtimeConfig.paddleVlLocal || {};
    if (pvCfg.enabled && pvCfg.baseUrl) {
      available.push({
        value: OCR_ENGINE_PADDLE_VL_LOCAL,
        label: {
          en: 'PaddleOCR-VL 1.5',
          zh: 'PaddleOCR-VL 1.5',
        },
      });
    }
  } catch (e) { /* skip */ }

  // Check Paddle cloud API
  try {
    let pcCfg = runtimeConfig.paddleCloud || {};
    let token = String(pcCfg.token || '').trim();
    // Fallback: also check the standalone paddleocr-service config
    if (!token) {
      try {
        const paddleService = require('./paddleocr-service');
        const standaloneCfg = paddleService.getConfig();
        if (standaloneCfg?.token) {
          token = String(standaloneCfg.token).trim();
          pcCfg = { ...pcCfg, token };
        }
      } catch(e) { /* skip */ }
    }
    if (token) {
      const paddleService = require('./paddleocr-service');
      const result = await paddleService.testConnection(token);
      if (result?.success) {
        const modelName = pcCfg.model || DEFAULT_PADDLE_CLOUD_MODEL;
        available.push({
          value: OCR_ENGINE_PADDLE_CLOUD,
          label: {
            en: `PaddleOCR ${modelName} (Cloud)`,
            zh: `PaddleOCR ${modelName}（云端）`,
          },
        });
      }
    }
  } catch (e) { /* skip */ }

  // Also include engines that are selected in settings but not yet detected/installed
  // (so users can see what they have selected and know if they need to install a model)
  const selectedEngine = String(runtimeConfig.engine || '').trim();
  const availableValues = available.map(a => String(a.value).split(':')[0]);

  if (selectedEngine === OCR_ENGINE_DEEPSEEK_LOCAL && !availableValues.includes(OCR_ENGINE_DEEPSEEK_LOCAL)) {
    const displayModel = String(runtimeConfig.deepseekLocal?.model || DEFAULT_DEEPSEEK_LOCAL_MODEL).trim();
    available.push({
      value: OCR_ENGINE_DEEPSEEK_LOCAL,
      label: {
        en: `DeepSeek OCR (${displayModel}) - model not installed`,
        zh: `DeepSeek OCR（${displayModel}）- 模型未安装`,
      },
      needsModel: true,
    });
  }

  if (selectedEngine === OCR_ENGINE_PADDLE_VL_LOCAL && !availableValues.includes(OCR_ENGINE_PADDLE_VL_LOCAL)) {
    available.push({
      value: OCR_ENGINE_PADDLE_VL_LOCAL,
      label: {
        en: 'PaddleOCR-VL - not configured',
        zh: 'PaddleOCR-VL - 未配置',
      },
      needsModel: true,
    });
  }

  if (selectedEngine === OCR_ENGINE_PADDLE_CLOUD && !availableValues.includes(OCR_ENGINE_PADDLE_CLOUD)) {
    available.push({
      value: OCR_ENGINE_PADDLE_CLOUD,
      label: {
        en: 'PaddleOCR (Cloud) - Access Token not set',
        zh: 'PaddleOCR（云端）- 未设置 Access Token',
      },
      needsModel: true,
    });
  }

  return available;
}

module.exports = {
  OCR_ENGINE_GUTEN,
  OCR_ENGINE_PADDLE_LOCAL,
  OCR_ENGINE_PADDLE_VL_LOCAL,
  OCR_ENGINE_DEEPSEEK_LOCAL,
  OCR_ENGINE_PADDLE_CLOUD,
  DEFAULT_DEEPSEEK_LOCAL_MODEL,
  DEFAULT_PADDLE_VL_LOCAL_MODEL,
  DEFAULT_PADDLE_CLOUD_MODEL,
  buildDefaultOcrConfig,
  getDefaultOcrEngine,
  getDefaultOcrFallbackEngine,
  getOcrEngineDisplayName,
  getSupportedOcrEngines,
  isEmbeddedPaddleOcrEngine,
  isMacPlatform,
  mergeOcrConfig,
  normalizeOcrEngineName,
  normalizePlatform,
  detectAvailableOcrEngines,
};

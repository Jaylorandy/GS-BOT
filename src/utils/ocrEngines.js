export const OCR_ENGINE_GUTEN = 'guten-ocr';
export const OCR_ENGINE_PADDLE_LOCAL = 'paddle-local';
export const OCR_ENGINE_PADDLE_VL_LOCAL = 'paddlevl-local';
export const OCR_ENGINE_DEEPSEEK_LOCAL = 'deepseek-local';
export const OCR_ENGINE_PADDLE_CLOUD = 'paddle-cloud';

export const DEFAULT_DEEPSEEK_LOCAL_MODEL = 'deepseek-ocr:3b';
export const DEFAULT_PADDLE_VL_LOCAL_MODEL = 'paddleocr-vl-1.6';
export const DEFAULT_PADDLE_CLOUD_MODEL = 'PaddleOCR-VL-1.6';

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
  'paddleocr-vl-1.6': OCR_ENGINE_PADDLE_VL_LOCAL,
  'paddlevl': OCR_ENGINE_PADDLE_VL_LOCAL,
  'paddlevl-local': OCR_ENGINE_PADDLE_VL_LOCAL,
  'paddle-cloud': OCR_ENGINE_PADDLE_CLOUD,
  'paddle-api': OCR_ENGINE_PADDLE_CLOUD,
  'paddle-online': OCR_ENGINE_PADDLE_CLOUD,
  'paddleocr-api': OCR_ENGINE_PADDLE_CLOUD,
};

export function normalizePlatform(platform = '') {
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

export function resolveCurrentPlatform() {
  if (typeof navigator === 'undefined') {
    return '';
  }

  return normalizePlatform(
    navigator.userAgentData?.platform
      || navigator.platform
      || navigator.userAgent
      || '',
  );
}

export function isMacPlatform(platform = resolveCurrentPlatform()) {
  return normalizePlatform(platform) === 'darwin';
}

export function getDefaultOcrEngine(platform = resolveCurrentPlatform()) {
  return OCR_ENGINE_GUTEN;
}

export function getDefaultOcrFallbackEngine(platform = resolveCurrentPlatform()) {
  return '';
}

export function normalizeOcrEngineName(value = '', options = {}) {
  const platform = options.platform || resolveCurrentPlatform();
  const allowEmpty = Boolean(options.allowEmpty);
  const defaultEngine = options.defaultEngine || getDefaultOcrEngine(platform);
  const normalized = String(value || '').trim().toLowerCase();

  if (!normalized) {
    return allowEmpty ? '' : defaultEngine;
  }

  return OCR_ENGINE_ALIASES[normalized] || normalized;
}

export function getOcrEngineDisplayLabel(engine, t, options = {}) {
  const normalized = normalizeOcrEngineName(engine, {
    allowEmpty: true,
    platform: options.platform || resolveCurrentPlatform(),
  });

  switch (normalized) {
    case OCR_ENGINE_GUTEN:
      return 'Guten OCR';
    case OCR_ENGINE_PADDLE_VL_LOCAL:
      return 'PaddleOCR-VL 1.6';
    case OCR_ENGINE_DEEPSEEK_LOCAL:
      return options.model ? `DeepSeek OCR (${options.model})` : 'DeepSeek OCR';
    case OCR_ENGINE_PADDLE_LOCAL:
      return 'Paddle OCR';
    case OCR_ENGINE_PADDLE_CLOUD:
      return options.model ? `PaddleOCR ${options.model}（云端）` : 'PaddleOCR（云端）';
    default:
      return normalized || getOcrEngineDisplayLabel(getDefaultOcrEngine(options.platform), t, options);
  }
}

export function isEmbeddedPaddleOcrEngine(engine, options = {}) {
  return normalizeOcrEngineName(engine, {
    allowEmpty: true,
    platform: options.platform || resolveCurrentPlatform(),
  }) === OCR_ENGINE_PADDLE_LOCAL;
}

export function buildDefaultOcrConfig(platform = resolveCurrentPlatform()) {
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

export function mergeOcrConfig(rawConfig = {}, platform = resolveCurrentPlatform()) {
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

export const DEFAULT_OCR_CONFIG = buildDefaultOcrConfig();

export function getSupportedOcrEngines(platform = resolveCurrentPlatform()) {
  return [OCR_ENGINE_GUTEN, OCR_ENGINE_DEEPSEEK_LOCAL, OCR_ENGINE_PADDLE_VL_LOCAL, OCR_ENGINE_PADDLE_CLOUD];
}

export function getOcrEngineCatalog(platform = resolveCurrentPlatform()) {
  const supported = getSupportedOcrEngines(platform);
  const catalog = {
    [OCR_ENGINE_GUTEN]: {
      value: OCR_ENGINE_GUTEN,
      labelEn: 'Guten OCR',
      labelZh: 'Guten OCR',
      descriptionEn: 'Built-in local OCR. Fast and reliable, no extra setup needed.',
      descriptionZh: '内置本地 OCR，快速稳定，无需额外配置。',
      recommended: true,
    },
    [OCR_ENGINE_PADDLE_VL_LOCAL]: {
      value: OCR_ENGINE_PADDLE_VL_LOCAL,
      labelEn: 'PaddleOCR-VL 1.6',
      labelZh: 'PaddleOCR-VL 1.6',
      descriptionEn: 'Enhanced OCR for complex labels. Stronger reads, but not the fastest path.',
      descriptionZh: '增强识别，适合复杂标签，识别更强但不是最快路线。',
      recommended: !isMacPlatform(platform),
    },
    [OCR_ENGINE_DEEPSEEK_LOCAL]: {
      value: OCR_ENGINE_DEEPSEEK_LOCAL,
      labelEn: 'DeepSeek OCR',
      labelZh: 'DeepSeek OCR',
      descriptionEn: 'Stronger OCR for harder labels and documents, but slower than Guten OCR.',
      descriptionZh: '更强，适合复杂标签和文档识别，但会比 Guten OCR 更慢。',
      recommended: true,
    },
    [OCR_ENGINE_PADDLE_CLOUD]: {
      value: OCR_ENGINE_PADDLE_CLOUD,
      labelEn: 'PaddleOCR (Cloud)',
      labelZh: 'PaddleOCR（云端）',
      descriptionEn: 'Cloud-based PaddleOCR via Baidu AI Studio API. Requires Access Token configuration.',
      descriptionZh: '通过百度 AI Studio API 调用云端 PaddleOCR。需要先配置 Access Token。',
      recommended: false,
    },
  };

  return supported.map((value) => catalog[value]).filter(Boolean);
}

export function isOcrEngineReady(engine, config = {}, systemStatus = {}, platform = resolveCurrentPlatform(), installedModels = []) {
  const normalized = normalizeOcrEngineName(engine, {
    allowEmpty: true,
    platform,
  });
  const merged = mergeOcrConfig(config, platform);

  if (normalized === OCR_ENGINE_GUTEN) {
    return true;
  }

  if (normalized === OCR_ENGINE_PADDLE_LOCAL) {
    return true;
  }

  if (normalized === OCR_ENGINE_DEEPSEEK_LOCAL) {
    const modelName = String(merged.deepseekLocal?.model || '').trim();
    const enabled = Boolean(merged.deepseekLocal?.enabled && modelName);
    if (!enabled) return false;

    if (installedModels.length > 0) {
      const wantedFamily = modelName.split(':')[0].toLowerCase();
      return installedModels.some((m) => {
        const nm = String(m || '').trim().toLowerCase();
        return nm === modelName.toLowerCase() || nm.startsWith(`${wantedFamily}:`);
      });
    }

    return true;
  }

  if (normalized === OCR_ENGINE_PADDLE_VL_LOCAL) {
    if (systemStatus?.paddleVl?.ready) return true;

    return Boolean(
      merged.paddleVlLocal?.enabled
      && String(merged.paddleVlLocal?.model || '').trim(),
    );
  }

  if (normalized === OCR_ENGINE_PADDLE_CLOUD) {
    return Boolean(String(merged.paddleCloud?.token || '').trim());
  }

  return false;
}

export function getOcrEngineOptions(platform = resolveCurrentPlatform(), config = {}, systemStatus = {}, installedModels = []) {
  return getOcrEngineCatalog(platform).filter((entry) => (
    entry.value === OCR_ENGINE_GUTEN
    || isOcrEngineReady(entry.value, config, systemStatus, platform, installedModels)
  )).map((entry) => ({
    value: entry.value,
    label: { en: entry.labelEn, zh: entry.labelZh },
  }));
}

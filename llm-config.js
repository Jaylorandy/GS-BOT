/**
 * LLM Configuration Manager
 * 统一管理本地和云端 Ollama 配置
 * 支持 Slides Maker 和 Product Analysis 模块共享配置
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { buildDefaultOcrConfig, mergeOcrConfig } = require('./ocr-engine-config');

// 配置文件路径
const CONFIG_DIR = path.join(os.homedir(), '.gsbot');
const CONFIG_FILE = path.join(CONFIG_DIR, 'llm-config.json');

// 通用API模型预设
const DEFAULT_API_PRESETS = [
  {
    id: 'glm',
    name: '智谱AI (GLM)',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    // Empty by default: the settings page auto-fills the endpoint's default
    // model after a successful connection test (highest-versioned "flash"
    // model for GLM), and the runtime chains resolve an empty model the same
    // way. Hardcoding a version here goes stale and text-only.
    model: '',
    apiKey: '',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKey: '',
  },
  {
    id: 'qwen',
    name: '通义千问 (Qwen)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    apiKey: '',
  },
  {
    id: 'custom',
    name: '自定义API',
    baseUrl: '',
    model: '',
    apiKey: '',
  },
];

// 默认配置
const DEFAULT_CONFIG = {
  // 本地 Ollama 配置
  local: {
    enabled: true,
    baseUrl: 'http://localhost:11434',
    model: '',
    // 本地模型安装状态（运行时检测）
    installed: false,
    running: false,
    installedModels: [],
    availableModels: [],
  },
  // 云端 Ollama 配置
  cloud: {
    enabled: false,
    baseUrl: '',
    model: '',
    apiKey: '',
    tavilyApiKey: '',
    availableModels: [],
    nativeWebSearch: true,
  },
  // 通用API云端配置（GLM、Deepseek等）
  apiCloud: {
    enabled: false,
    activePresetId: 'glm',
    presets: DEFAULT_API_PRESETS,
  },
  // 混合模式配置
  hybrid: {
    enabled: false,
    // 提取阶段使用哪个端点: 'cloud' | 'local' | 'apiCloud'
    extractionEndpoint: 'cloud',
    // 分析阶段使用哪个端点: 'cloud' | 'local' | 'apiCloud'
    analysisEndpoint: 'local',
  },
  // OCR 配置
  ocr: buildDefaultOcrConfig(),
  // 服装专业视觉模型配置
  apparelVision: {
    enabled: true,
    mode: 'dual-model',
    baseUrl: 'http://localhost:11434',
    garmentModel: 'moondream:1.8b',
    fabricModel: 'gr3-fabric',
    apiKey: '',
  },
  // 当前选择的模式: 'local' | 'cloud' | 'hybrid'
  mode: 'local',
  // 首次引导是否已完成
  onboardingCompleted: false,
  onboardingCompletedAt: null,
  // 最后更新时间
  lastUpdated: null,
};

function resolveSupportedMode(saved = {}) {
  const requestedMode = saved.mode;
  if (requestedMode === 'local' || requestedMode === 'cloud' || requestedMode === 'apiCloud') {
    return requestedMode;
  }

  if (requestedMode === 'hybrid') {
    const hasApiCloud = Boolean(saved.apiCloud?.activePresetId && 
      saved.apiCloud?.presets?.find(p => p.id === saved.apiCloud.activePresetId)?.apiKey);
    const hasCloud = Boolean(saved.cloud?.baseUrl && saved.cloud?.model);
    if (hasApiCloud) return 'apiCloud';
    return hasCloud ? 'cloud' : 'local';
  }

  return 'local';
}

function mergeWithDefaults(saved = {}) {
  const savedApiCloud = saved.apiCloud || {};
  const mergedPresets = DEFAULT_API_PRESETS.map(defaultPreset => {
    const savedPreset = (savedApiCloud.presets || []).find(p => p.id === defaultPreset.id);
    return savedPreset ? { ...defaultPreset, ...savedPreset } : { ...defaultPreset };
  });

  const merged = {
    ...DEFAULT_CONFIG,
    ...saved,
    local: {
      ...DEFAULT_CONFIG.local,
      ...(saved.local || {}),
    },
    cloud: {
      ...DEFAULT_CONFIG.cloud,
      ...(saved.cloud || {}),
    },
    apiCloud: {
      ...DEFAULT_CONFIG.apiCloud,
      ...savedApiCloud,
      presets: mergedPresets,
    },
    hybrid: {
      ...DEFAULT_CONFIG.hybrid,
      ...(saved.hybrid || {}),
    },
    ocr: mergeOcrConfig(saved.ocr || {}),
    apparelVision: {
      ...DEFAULT_CONFIG.apparelVision,
      ...(saved.apparelVision || {}),
    },
  };

  merged.mode = resolveSupportedMode(merged);
  return merged;
}

// 确保配置目录存在
function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

// 加载配置
function loadConfig() {
  ensureConfigDir();
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf8');
      const saved = JSON.parse(data);
      return mergeWithDefaults(saved);
    }
  } catch (e) {
    console.error('[LLMConfig] Failed to load config:', e.message);
  }
  return mergeWithDefaults();
}

// 保存配置
function saveConfig(config) {
  ensureConfigDir();
  try {
    const normalizedConfig = mergeWithDefaults(config);
    normalizedConfig.lastUpdated = new Date().toISOString();
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(normalizedConfig, null, 2));
    return true;
  } catch (e) {
    console.error('[LLMConfig] Failed to save config:', e.message);
    return false;
  }
}

// 获取当前激活的配置（根据模式）
function getActiveConfig(config = null) {
  const cfg = config || loadConfig();
  
  switch (cfg.mode) {
    case 'cloud':
      return {
        mode: 'cloud',
        baseUrl: cfg.cloud.baseUrl,
        model: cfg.cloud.model,
        apiKey: cfg.cloud.apiKey,
        provider: 'openai',
        isLocal: false,
      };
    case 'apiCloud': {
      const activePreset = (cfg.apiCloud?.presets || []).find(p => p.id === cfg.apiCloud?.activePresetId) || {};
      return {
        mode: 'apiCloud',
        baseUrl: activePreset.baseUrl || '',
        model: activePreset.model || '',
        apiKey: activePreset.apiKey || '',
        provider: 'openai',
        presetId: cfg.apiCloud?.activePresetId,
        isLocal: false,
      };
    }
    case 'local':
    default:
      return {
        mode: 'local',
        baseUrl: cfg.local.baseUrl,
        model: cfg.local.model,
        apiKey: '',
        provider: 'ollama',
        isLocal: true,
      };
  }
}

// 获取指定端点的配置（用于混合模式）
function getEndpointConfig(endpoint = 'local', config = null) {
  const cfg = config || loadConfig();
  
  switch (endpoint) {
    case 'cloud':
      return {
        mode: 'cloud',
        baseUrl: cfg.cloud.baseUrl,
        model: cfg.cloud.model,
        apiKey: cfg.cloud.apiKey,
        provider: 'openai',
        isLocal: false,
      };
    case 'apiCloud': {
      const activePreset = (cfg.apiCloud?.presets || []).find(p => p.id === cfg.apiCloud?.activePresetId) || {};
      return {
        mode: 'apiCloud',
        baseUrl: activePreset.baseUrl || '',
        model: activePreset.model || '',
        apiKey: activePreset.apiKey || '',
        provider: 'openai',
        presetId: cfg.apiCloud?.activePresetId,
        isLocal: false,
      };
    }
    case 'local':
    default:
      return {
        mode: 'local',
        baseUrl: cfg.local.baseUrl,
        model: cfg.local.model,
        apiKey: '',
        provider: 'ollama',
        isLocal: true,
      };
  }
}

// 更新本地配置
function updateLocalConfig(updates) {
  const config = loadConfig();
  config.local = { ...config.local, ...updates };
  return saveConfig(config);
}

// 更新云端配置
function updateCloudConfig(updates) {
  const config = loadConfig();
  config.cloud = { ...config.cloud, ...updates };
  return saveConfig(config);
}

// 更新混合模式配置
function updateHybridConfig(updates) {
  const config = loadConfig();
  config.hybrid = { ...config.hybrid, ...updates };
  return saveConfig(config);
}

// 设置当前模式
function setMode(mode) {
  const config = loadConfig();
  if (['local', 'cloud'].includes(mode)) {
    config.mode = mode;
    return saveConfig(config);
  }
  return false;
}

// 检测是否为本地 URL
function isLocalUrl(url) {
  if (!url) return false;
  const localPatterns = ['localhost', '127.0.0.1', '0.0.0.0', '::1'];
  return localPatterns.some(pattern => url.includes(pattern));
}

module.exports = {
  loadConfig,
  saveConfig,
  getActiveConfig,
  getEndpointConfig,
  updateLocalConfig,
  updateCloudConfig,
  updateHybridConfig,
  setMode,
  isLocalUrl,
  DEFAULT_CONFIG,
  DEFAULT_API_PRESETS,
  CONFIG_FILE,
  mergeWithDefaults,
};

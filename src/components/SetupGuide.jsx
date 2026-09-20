import React, { useEffect, useState } from 'react';
import { dispatchLLMConfigUpdate } from '../utils/llmConfigSync';
import { useI18n } from '../utils/i18n';
import {
  buildDefaultOcrConfig,
  isEmbeddedPaddleOcrEngine,
  mergeOcrConfig,
} from '../utils/ocrEngines';
import OcrModelStore from './OcrModelStore';
import './SetupGuide.css';

// ═══════════════════════════════════════════════════
// Firecrawl Configuration Panel
// ═══════════════════════════════════════════════════
function FirecrawlConfigPanel() {
  const { tx } = useI18n();
  const [apiKey, setApiKey] = React.useState('');
  const [isConfigured, setIsConfigured] = React.useState(false);
  const [isEnabled, setIsEnabled] = React.useState(false); // true = Manual Force, false = Disabled
  const [saving, setSaving] = React.useState(false);
  const [message, setMessage] = React.useState(null);

  // Load current config on mount
  React.useEffect(() => {
    loadConfig();
  }, []);

  async function loadConfig() {
    try {
      const [configResult, modeResult] = await Promise.all([
        window.electronAPI?.firecrawlGetConfig?.(),
        window.electronAPI?.firecrawlGetMode?.(),
      ]);
      
      if (configResult?.success) {
        setIsConfigured(configResult.isConfigured);
      }
      if (modeResult?.success) {
        // 'manual' = enabled, anything else = disabled
        setIsEnabled(modeResult.mode === 'manual');
      }
    } catch (error) {
      console.error('Failed to load Firecrawl config:', error);
    }
  }

  async function handleSave() {
    if (!apiKey.trim()) return;
    
    setSaving(true);
    setMessage(null);
    
    try {
      const result = await window.electronAPI?.firecrawlSaveConfig?.(apiKey.trim());
      
      if (result?.success) {
        setIsConfigured(true);
        setMessage({ type: 'success', text: tx('Firecrawl API Key saved successfully!', 'Firecrawl API Key 已保存!') });
        setApiKey(''); // Clear input after save
      } else {
        setMessage({ type: 'error', text: result?.error || tx('Save failed', '保存失败') });
      }
    } catch (error) {
      setMessage({ type: 'error', text: error.message || tx('Save error', '保存出错') });
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(enabled) {
    setSaving(true);
    setMessage(null);
    
    try {
      // Backend only accepts 'auto' or 'manual'
      // 'enabled' = manual mode (always use Firecrawl)
      // 'disabled' = auto mode (use Puppeteer normally)
      const newMode = enabled ? 'manual' : 'auto';
      const result = await window.electronAPI?.firecrawlSetMode?.(newMode);
      
      if (result?.success) {
        setIsEnabled(enabled);
        setMessage({ 
          type: 'success', 
          text: enabled 
            ? tx('Firecrawl enabled. All scraping will use Firecrawl.', 'Firecrawl 已启用。所有抓取将使用 Firecrawl。')
            : tx('Firecrawl disabled. Using local Puppeteer normally.', 'Firecrawl 已禁用。正常情况下使用本地 Puppeteer。')
        });
      } else {
        setMessage({ type: 'error', text: result?.error || tx('Toggle failed', '切换失败') });
      }
    } catch (error) {
      setMessage({ type: 'error', text: error.message || tx('Toggle error', '切换出错') });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="setup-panel">
      <h3 style={{ marginTop: 0 }}>Firecrawl {tx('Backup Scraper Engine', '备用抓取引擎')}</h3>
      
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.9em', marginBottom: '1.5em' }}>
        {tx(
          'When your local IP is blocked by target websites, GS Bot automatically falls back to Firecrawl cloud proxy pool to continue scraping.',
          '当本地 IP 被目标网站封禁时，GS Bot 会自动切换到 Firecrawl 云端代理池继续抓取。'
        )}
      </p>

      {/* Scrape Mode Selector */}
      <div style={{ marginBottom: '2em' }}>
        <label style={{ display: 'block', marginBottom: '0.8em', fontWeight: 600, fontSize: '0.95em' }}>
          {tx('Firecrawl Status', 'Firecrawl 状态')}
        </label>
        <div style={{ display: 'flex', gap: '0.8em' }}>
          <button
            onClick={() => handleToggle(true)}
            disabled={saving}
            style={{
              flex: 1,
              padding: '0.7em 1em',
              borderRadius: '6px',
              border: isEnabled ? '2px solid var(--primary-color)' : '1px solid var(--border-color)',
              background: isEnabled ? 'rgba(34, 197, 94, 0.08)' : 'transparent',
              color: 'var(--text-primary)',
              cursor: saving ? 'not-allowed' : 'pointer',
              textAlign: 'left',
              opacity: saving ? 0.6 : 1,
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: '0.3em', fontSize: '0.9em' }}>
              {tx('Enabled', '已启用')}
            </div>
            <div style={{ fontSize: '0.8em', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
              {tx('All scraping requests use Firecrawl.', '所有抓取请求都使用 Firecrawl。')}
            </div>
          </button>
          
          <button
            onClick={() => handleToggle(false)}
            disabled={saving}
            style={{
              flex: 1,
              padding: '0.7em 1em',
              borderRadius: '6px',
              border: !isEnabled ? '2px solid var(--primary-color)' : '1px solid var(--border-color)',
              background: !isEnabled ? 'rgba(239, 68, 68, 0.08)' : 'transparent',
              color: 'var(--text-primary)',
              cursor: saving ? 'not-allowed' : 'pointer',
              textAlign: 'left',
              opacity: saving ? 0.6 : 1,
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: '0.3em', fontSize: '0.9em' }}>
               {tx('Disabled', '已禁用')}
            </div>
            <div style={{ fontSize: '0.8em', color: 'var(--text-secondary)', lineHeight: 1.4 }}>
              {tx('Using local Puppeteer only.', '仅使用本地 Puppeteer。')}
            </div>
          </button>
        </div>
      </div>

      {/* API Key Input */}
      <div style={{ marginBottom: '1.5em' }}>
        <label style={{ display: 'block', marginBottom: '0.5em', fontWeight: 500 }}>
          {tx('API Key', 'API 密钥')}:
        </label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={tx('Enter Firecrawl API Key (fc-xxx...)', '输入 Firecrawl API Key (fc-xxx...)')}
          disabled={saving}
          style={{
            width: '100%',
            padding: '0.6em 0.8em',
            borderRadius: '6px',
            border: '1px solid var(--border-color)',
            background: 'var(--bg-input)',
            color: 'var(--text-primary)',
            fontSize: '0.95em',
            boxSizing: 'border-box',
          }}
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '1em', marginBottom: '1.5em' }}>
        <button
          onClick={handleSave}
          disabled={saving || !apiKey.trim()}
          style={{
            padding: '0.6em 1.5em',
            borderRadius: '6px',
            border: 'none',
            background: saving || !apiKey.trim() ? 'var(--btn-disabled-bg)' : 'var(--primary-color)',
            color: saving || !apiKey.trim() ? 'var(--btn-disabled-text)' : '#fff',
            cursor: saving || !apiKey.trim() ? 'not-allowed' : 'pointer',
            fontWeight: 500,
            fontSize: '0.95em',
          }}
        >
          {saving ? tx('Saving...', '保存中...') : tx('Save Configuration', '保存配置')}
        </button>

        <span style={{
          padding: '0.3em 0.8em',
          borderRadius: '4px',
          fontSize: '0.85em',
          background: isConfigured ? 'rgba(34, 197, 94, 0.1)' : 'rgba(251, 191, 36, 0.1)',
          color: isConfigured ? '#16a34a' : '#d97706',
        }}>
          {isConfigured ? '✅ ' + tx('Configured', '已配置') : '⚠️ ' + tx('Not configured', '未配置')}
        </span>
        
        <span style={{
          padding: '0.3em 0.8em',
          borderRadius: '4px',
          fontSize: '0.85em',
          background: isEnabled ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)',
          color: isEnabled ? '#16a34a' : '#dc2626',
          fontWeight: 500,
        }}>
          {isEnabled ? '✅ Enabled' : '❌ Disabled'}
        </span>
      </div>

      {message && (
        <div style={{
          padding: '0.8em 1em',
          borderRadius: '6px',
          marginBottom: '1.5em',
          background: message.type === 'success' ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)',
          color: message.type === 'success' ? '#16a34a' : '#dc2626',
          fontSize: '0.9em',
        }}>
          {message.text}
        </div>
      )}
    </section>
  );
}

// ═══════════════════════════════════════════════════
// PaddleOCR Configuration Panel
// ═══════════════════════════════════════════════════
function PaddleOcrConfigPanel() {
  const { tx } = useI18n();
  const [token, setToken] = React.useState('');
  const [useDocOrientationClassify, setUseDocOrientationClassify] = React.useState(false);
  const [useDocUnwarping, setUseDocUnwarping] = React.useState(false);
  const [useChartRecognition, setUseChartRecognition] = React.useState(false);
  const [isConfigured, setIsConfigured] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [message, setMessage] = React.useState(null);

  // Load current config on mount
  React.useEffect(() => {
    loadConfig();
  }, []);

  async function loadConfig() {
    try {
      const result = await window.electronAPI?.paddleOcrGetConfig?.();
      
      if (result?.success) {
        setToken(result.token || '');
        setUseDocOrientationClassify(result.options?.useDocOrientationClassify || false);
        setUseDocUnwarping(result.options?.useDocUnwarping || false);
        setUseChartRecognition(result.options?.useChartRecognition || false);
        setIsConfigured(!!result.token);
      }
    } catch (error) {
      console.error('Failed to load PaddleOCR config:', error);
    }
  }

  async function handleSave() {
    if (!token.trim()) return;
    
    setSaving(true);
    setMessage(null);
    
    try {
      const options = {
        useDocOrientationClassify,
        useDocUnwarping,
        useChartRecognition,
      };
      
      const result = await window.electronAPI?.paddleOcrSaveConfig?.(token.trim(), options);
      
      if (result?.success) {
        setIsConfigured(true);
        setMessage({ type: 'success', text: tx('PaddleOCR API Token saved successfully!', 'PaddleOCR API Token 已保存!') });
      } else {
        setMessage({ type: 'error', text: result?.error || tx('Save failed', '保存失败') });
      }
    } catch (error) {
      setMessage({ type: 'error', text: error.message || tx('Save error', '保存出错') });
    } finally {
      setSaving(false);
    }
  }

  async function handleTestConnection() {
    if (!token.trim()) {
      setMessage({ type: 'error', text: tx('Please enter a token first', '请先输入 Token') });
      return;
    }
    
    setSaving(true);
    setMessage(null);
    
    try {
      const result = await window.electronAPI?.paddleOcrTestConnection?.(token.trim());
      
      if (result?.success) {
        setMessage({ type: 'success', text: tx('Connection successful! API is working.', '连接成功!API 正常工作。') });
      } else {
        setMessage({ type: 'error', text: result?.error || tx('Connection failed', '连接失败') });
      }
    } catch (error) {
      setMessage({ type: 'error', text: error.message || tx('Test error', '测试出错') });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="setup-panel">
      <h3 style={{ marginTop: 0 }}>PaddleOCR-VL-1.6 {tx('API Configuration', 'API 配置')}</h3>
      
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.9em', marginBottom: '1.5em' }}>
        {tx(
          'Configure Baidu AI Studio PaddleOCR API for high-accuracy document OCR processing.',
          '配置百度 AI Studio PaddleOCR API，用于高精度文档 OCR 处理。'
        )}
      </p>

      {/* Token Input */}
      <div style={{ marginBottom: '2em' }}>
        <label style={{ display: 'block', marginBottom: '0.5em', fontWeight: 600, fontSize: '0.95em' }}>
          {tx('Access Token', '访问令牌')}
        </label>
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={tx('Enter your PaddleOCR Access Token', '请输入您的 PaddleOCR Access Token')}
          style={{
            width: '100%',
            padding: '0.7em 1em',
            borderRadius: '6px',
            border: '1px solid var(--border-color)',
            background: 'var(--bg-secondary)',
            color: 'var(--text-primary)',
            fontSize: '0.95em',
            fontFamily: 'monospace',
          }}
        />
      </div>

      {/* Optional Settings */}
      <div style={{ marginBottom: '2em' }}>
        <label style={{ display: 'block', marginBottom: '0.8em', fontWeight: 600, fontSize: '0.95em' }}>
          {tx('Optional Features', '可选功能')}
        </label>
        
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.8em' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.6em', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={useDocOrientationClassify}
              onChange={(e) => setUseDocOrientationClassify(e.target.checked)}
              style={{ width: '16px', height: '16px', cursor: 'pointer' }}
            />
            <span style={{ fontSize: '0.9em' }}>
              {tx('Document Orientation Classification', '文档方向分类')}
            </span>
          </label>
          
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.6em', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={useDocUnwarping}
              onChange={(e) => setUseDocUnwarping(e.target.checked)}
              style={{ width: '16px', height: '16px', cursor: 'pointer' }}
            />
            <span style={{ fontSize: '0.9em' }}>
              {tx('Document Unwarping', '文档去扭曲')}
            </span>
          </label>
          
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.6em', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={useChartRecognition}
              onChange={(e) => setUseChartRecognition(e.target.checked)}
              style={{ width: '16px', height: '16px', cursor: 'pointer' }}
            />
            <span style={{ fontSize: '0.9em' }}>
              {tx('Chart Recognition', '图表识别')}
            </span>
          </label>
        </div>
      </div>

      {/* Status Indicator */}
      {isConfigured && (
        <div style={{ 
          marginBottom: '1.5em', 
          padding: '0.8em 1em', 
          borderRadius: '6px', 
          background: 'rgba(34, 197, 94, 0.08)',
          border: '1px solid rgba(34, 197, 94, 0.2)',
          fontSize: '0.9em',
        }}>
          ✓ {tx('PaddleOCR API is configured and ready to use.', 'PaddleOCR API 已配置并可使用。')}
        </div>
      )}

      {/* Message Display */}
      {message && (
        <div style={{
          marginBottom: '1em',
          padding: '0.8em 1em',
          borderRadius: '6px',
          background: message.type === 'success' ? 'rgba(34, 197, 94, 0.08)' : 'rgba(239, 68, 68, 0.08)',
          border: `1px solid ${message.type === 'success' ? 'rgba(34, 197, 94, 0.2)' : 'rgba(239, 68, 68, 0.2)'}`,
          color: message.type === 'success' ? '#22c55e' : '#ef4444',
          fontSize: '0.9em',
        }}>
          {message.text}
        </div>
      )}

      {/* Action Buttons */}
      <div style={{ display: 'flex', gap: '0.8em' }}>
        <button
          onClick={handleSave}
          disabled={!token.trim() || saving}
          style={{
            flex: 1,
            padding: '0.7em 1.2em',
            borderRadius: '6px',
            border: 'none',
            background: !token.trim() || saving ? 'var(--border-color)' : 'var(--primary-color)',
            color: 'white',
            cursor: !token.trim() || saving ? 'not-allowed' : 'pointer',
            fontWeight: 600,
            fontSize: '0.9em',
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? tx('Saving...', '保存中...') : tx('Save Configuration', '保存配置')}
        </button>
        
        <button
          onClick={handleTestConnection}
          disabled={!token.trim() || saving}
          style={{
            padding: '0.7em 1.2em',
            borderRadius: '6px',
            border: '1px solid var(--border-color)',
            background: 'transparent',
            color: 'var(--text-primary)',
            cursor: !token.trim() || saving ? 'not-allowed' : 'pointer',
            fontWeight: 600,
            fontSize: '0.9em',
            opacity: saving ? 0.6 : 1,
          }}
        >
          {tx('Test Connection', '测试连接')}
        </button>
      </div>
    </section>
  );
}

const PREFERRED_LOCAL_MODEL = 'gr3-fabric';
const PREFERRED_CLOUD_MODEL = 'qwen3-vl:235b';
const LOCAL_DEEPSEEK_OCR_MODEL = 'deepseek-ocr:3b';
const DEFAULT_CLOUD_BASE_URL = 'https://api.ollama.com';
const DEFAULT_OCR_CONFIG = buildDefaultOcrConfig();

const DEFAULT_CONFIG = {
  mode: 'local',
  onboardingCompleted: false,
  onboardingCompletedAt: null,
  onboardingSkippedAt: null,
  local: {
    enabled: true,
    baseUrl: 'http://localhost:11434',
    model: '',
    installed: false,
    running: false,
    installedModels: [],
    availableModels: [],
  },
  cloud: {
    enabled: false,
    baseUrl: DEFAULT_CLOUD_BASE_URL,
    model: '',
    apiKey: '',
    tavilyApiKey: '',
    availableModels: [],
    nativeWebSearch: true,
  },
  apiCloud: {
    enabled: false,
    activePresetId: 'glm',
    presets: [
      {
        id: 'glm',
        name: 'GLM (智谱AI)',
        baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        apiKey: '',
        model: 'glm-4-plus',
        availableModels: [],
        fallbackModels: [
          'glm-4-plus',
          'glm-4-air',
          'glm-4-airx',
          'glm-4-flash',
          'glm-4-flashx',
          'glm-4-long',
          'glm-4',
          'glm-z1-air',
          'glm-z1-airx',
          'glm-z1-flash',
          'glm-z1-flashx',
        ],
      },
      {
        id: 'deepseek',
        name: 'DeepSeek',
        baseUrl: 'https://api.deepseek.com/v1',
        apiKey: '',
        model: 'deepseek-chat',
        availableModels: [],
        fallbackModels: ['deepseek-chat', 'deepseek-reasoner'],
      },
      {
        id: 'qwen',
        name: 'Qwen (通义千问)',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        apiKey: '',
        model: 'qwen-plus',
        availableModels: [],
        fallbackModels: [
          'qwen-plus',
          'qwen-turbo',
          'qwen-max',
          'qwen-max-latest',
          'qwen-long',
          'qwen-flash',
        ],
      },
      { id: 'custom', name: '自定义', baseUrl: '', apiKey: '', model: '', availableModels: [], fallbackModels: [] },
    ],
  },
  hybrid: {
    enabled: false,
    extractionEndpoint: 'cloud',
    analysisEndpoint: 'local',
  },
  ocr: DEFAULT_OCR_CONFIG,
};

function uniq(items = []) {
  return [...new Set(items.filter(Boolean))];
}

function normalizeModelName(modelName = '') {
  return String(modelName || '').trim().toLowerCase();
}

// Map of preset ID -> valid model name prefixes
// Any fetched model that doesn't match any prefix for its provider will be filtered out
const PRESET_MODEL_PREFIXES = {
  glm: ['glm-'],
  deepseek: ['deepseek-'],
  qwen: ['qwen-'],
};

// Check if a model name looks like a valid LLM model (not just a version number)
// e.g. "glm-4-plus" -> valid, "glm-4.6" -> looks like version only, filter it
function looksLikeValidModelName(modelName = '') {
  const name = String(modelName || '').trim();
  if (!name) return false;
  // Split by the last '-' to separate provider prefix from model suffix
  const lastDashIdx = name.lastIndexOf('-');
  if (lastDashIdx === -1 || lastDashIdx === name.length - 1) return false;
  const suffix = name.slice(lastDashIdx + 1);
  // If suffix is only digits and dots (like "4.6"), it's probably a version, not a model
  if (/^[\d.]+$/.test(suffix)) return false;
  return true;
}

function isValidModelForPreset(modelName = '', presetId = '') {
  const name = String(modelName || '').trim();
  if (!name) return false;
  const prefixes = PRESET_MODEL_PREFIXES[presetId];
  if (!prefixes || prefixes.length === 0) return true; // custom or unknown preset: accept all
  const lower = name.toLowerCase();
  const prefixOk = prefixes.some((p) => lower.startsWith(p.toLowerCase()));
  if (!prefixOk) return false;
  return looksLikeValidModelName(name);
}

function isLocalDeepseekOcrModel(modelName = '') {
  const normalized = normalizeModelName(modelName);
  const family = normalizeModelName(LOCAL_DEEPSEEK_OCR_MODEL).split(':')[0];
  return normalized === family || normalized.startsWith(`${family}:`);
}

function isGr3FabricModel(modelName = '') {
  const normalized = normalizeModelName(modelName);
  return normalized === normalizeModelName(PREFERRED_LOCAL_MODEL) || normalized.startsWith(`${normalizeModelName(PREFERRED_LOCAL_MODEL)}:`);
}

function resolvePreferredGarmentModel(installedModels = []) {
  const nonOcrModels = installedModels.filter(m => !isLocalDeepseekOcrModel(m));
  return nonOcrModels.find(m => !isGr3FabricModel(m)) || nonOcrModels[0] || PREFERRED_LOCAL_MODEL;
}

function areDualLocalModelsReady(installedModels = []) {
  const nonOcrModels = installedModels.filter(m => !isLocalDeepseekOcrModel(m));
  return nonOcrModels.length >= 1;
}

function pickPreferredInstalledModel(installedModels = []) {
  const exactPreferred = installedModels.find((name) => normalizeModelName(name) === normalizeModelName(PREFERRED_LOCAL_MODEL));
  if (exactPreferred) {
    return exactPreferred;
  }

  const familyPreferred = installedModels.find((name) => normalizeModelName(name).startsWith(`${normalizeModelName(PREFERRED_LOCAL_MODEL)}:`));
  if (familyPreferred) {
    return familyPreferred;
  }

  return installedModels.find((name) => !isLocalDeepseekOcrModel(name)) || '';
}

function resolveInstalledModelName(modelName = '', installedModels = []) {
  const wanted = normalizeModelName(modelName);
  if (!wanted) {
    return '';
  }

  const exact = installedModels.find((name) => normalizeModelName(name) === wanted);
  if (exact) {
    return exact;
  }

  const prefix = installedModels.find((name) => normalizeModelName(name).startsWith(`${wanted}:`));
  if (prefix) {
    return prefix;
  }

  const wantedFamily = wanted.split(':')[0];
  const familyMatch = installedModels.find((name) => normalizeModelName(name).startsWith(`${wantedFamily}:`));
  if (familyMatch) {
    return familyMatch;
  }

  const fuzzy = installedModels.find((name) => {
    const normalized = normalizeModelName(name);
    return normalized.startsWith(wanted) || wanted.startsWith(normalized);
  });

  return fuzzy || '';
}

function normalizeConfig(config, options = {}) {
  const merged = {
    ...DEFAULT_CONFIG,
    ...(config || {}),
    local: {
      ...DEFAULT_CONFIG.local,
      ...((config && config.local) || {}),
    },
    cloud: {
      ...DEFAULT_CONFIG.cloud,
      ...((config && config.cloud) || {}),
    },
    hybrid: {
      ...DEFAULT_CONFIG.hybrid,
      ...((config && config.hybrid) || {}),
    },
    apiCloud: {
      ...DEFAULT_CONFIG.apiCloud,
      ...((config && config.apiCloud) || {}),
      presets: ((config && config.apiCloud && config.apiCloud.presets) || DEFAULT_CONFIG.apiCloud.presets).map((p) => {
        const def = DEFAULT_CONFIG.apiCloud.presets.find((dp) => dp.id === p.id);
        return def
          ? { ...def, ...p, fallbackModels: p.fallbackModels || def.fallbackModels || [] }
          : { fallbackModels: [], ...p };
      }),
    },
    ocr: mergeOcrConfig((config && config.ocr) || {}),
  };

  const installedModels = Array.isArray(merged.local.installedModels) ? merged.local.installedModels : [];
  const availableModels = Array.isArray(merged.local.availableModels) ? merged.local.availableModels : [];
  const preferredInstalled = pickPreferredInstalledModel(installedModels);
  const preferredAvailable = resolveInstalledModelName('gr3-fabric', availableModels) || 'gr3-fabric';
  const preferGuideDefaults = Boolean(options.preferGuideDefaults);

  if (merged.mode === 'hybrid') {
    const cloudReady = merged.cloud?.baseUrl && merged.cloud?.model;
    const apiCloudPreset = (merged.apiCloud?.presets || []).find(p => p.id === merged.apiCloud?.activePresetId);
    const apiCloudReady = apiCloudPreset?.apiKey && apiCloudPreset?.model;
    merged.mode = cloudReady ? 'cloud' : (apiCloudReady ? 'apiCloud' : 'local');
  }

  if (!merged.cloud.baseUrl) {
    merged.cloud.baseUrl = DEFAULT_CLOUD_BASE_URL;
  }

  if (preferGuideDefaults && !merged.local.model) {
    merged.local.model = preferredInstalled || preferredAvailable;
  }

  if (!merged.apparelVision?.fabricModel) {
    merged.apparelVision.fabricModel = preferredInstalled || preferredAvailable;
  }
  if (!merged.apparelVision?.garmentModel) {
    merged.apparelVision.garmentModel = resolvePreferredGarmentModel(installedModels);
  }
  merged.apparelVision.mode = 'dual-model';

  return merged;
}

function normalizeSystemStatus(status) {
  return {
    platform: status?.platform || 'unknown',
    chrome: {
      installed: Boolean(status?.chrome?.installed),
      path: status?.chrome?.path || '',
      requiredBy: status?.chrome?.requiredBy || 'Zara Scraper',
    },
    python: {
      available: Boolean(status?.python?.available),
      command: status?.python?.command || '',
      packagesReady: Boolean(status?.python?.packagesReady),
      missingModules: status?.python?.missingModules || [],
      requiredBy: status?.python?.requiredBy || 'Slides Maker, PPTX analysis, and PDF Squeezer',
    },
    ollama: {
      installed: Boolean(status?.ollama?.installed),
      running: Boolean(status?.ollama?.running),
      path: status?.ollama?.path || '',
      requiredBy: status?.ollama?.requiredBy || 'Local AI',
    },
    paddleVl: {
      bundled: Boolean(status?.paddleVl?.bundled),
      downloaded: Boolean(status?.paddleVl?.downloaded),
      ready: Boolean(status?.paddleVl?.ready),
      home: status?.paddleVl?.home || '',
      path: status?.paddleVl?.path || '',
      entrypoint: status?.paddleVl?.entrypoint || '',
      model: status?.paddleVl?.model || 'paddleocr-vl-1.6',
      baseUrl: status?.paddleVl?.baseUrl || '',
      message: status?.paddleVl?.message || '',
      hint: status?.paddleVl?.hint || '',
      requiredBy: status?.paddleVl?.requiredBy || 'Windows OCR',
    },
  };
}

function SetupGuide({
  initialConfig,
  systemStatus,
  variant = 'onboarding',
  overlay = false,
  onComplete,
  onClose,
}) {
  const { tx } = useI18n();
  const isOnboarding = variant === 'onboarding';
  const [surfaceMode, setSurfaceMode] = useState(isOnboarding ? 'guide' : 'status');
  const [guideStep, setGuideStep] = useState(0);
  const [setupView, setSetupView] = useState('basic');
  const [settingsTab, setSettingsTab] = useState('ollama');
  const [setupAccessMode, setSetupAccessMode] = useState(
    initialConfig?.mode === 'cloud' ? 'cloud' : initialConfig?.mode === 'apiCloud' ? 'apiCloud' : 'local'
  );
  const [previewFirstRun, setPreviewFirstRun] = useState(false);
  const [autoAdvanceGuide, setAutoAdvanceGuide] = useState(false);
  const [config, setConfig] = useState(() => normalizeConfig(initialConfig));
  const [environmentStatus, setEnvironmentStatus] = useState(() => normalizeSystemStatus(systemStatus));
  const [loading, setLoading] = useState(true);
  const [systemLoading, setSystemLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busyAction, setBusyAction] = useState('');
  const [logs, setLogs] = useState([]);
  const [testStatus, setTestStatus] = useState({});
  const [apiCloudTestStatus, setApiCloudTestStatus] = useState({});
  const [cloudNativeStatus, setCloudNativeStatus] = useState({
    state: 'idle',
    supported: null,
    method: '',
    detail: '',
  });
  const [downloadingModels, setDownloadingModels] = useState({});
  const [downloadProgress, setDownloadProgress] = useState({});
  const [removingModels, setRemovingModels] = useState({});
  const [installingPaddleVl, setInstallingPaddleVl] = useState(false);

  useEffect(() => {
    setConfig(normalizeConfig(initialConfig, { preferGuideDefaults: variant === 'onboarding' }));
    setEnvironmentStatus(normalizeSystemStatus(systemStatus));
    setSurfaceMode(variant === 'onboarding' ? 'guide' : 'status');
    setGuideStep(0);
    setSetupView('basic');
    setSetupAccessMode((initialConfig?.mode === 'cloud' ? 'cloud' : initialConfig?.mode === 'apiCloud' ? 'apiCloud' : 'local'));
    setPreviewFirstRun(false);
    setAutoAdvanceGuide(false);
    setLogs([]);
    setTestStatus({});
    setCloudNativeStatus({
      state: 'idle',
      supported: null,
      method: '',
      detail: '',
    });
    setDownloadingModels({});
    setDownloadProgress({});
    setRemovingModels({});
    setInstallingPaddleVl(false);
  }, [initialConfig, systemStatus, variant]);

  const addLog = (msg, type = 'info') => {
    setLogs((prev) => [...prev.slice(-11), { msg, type, time: new Date().toLocaleTimeString() }]);
  };

  const updateLocalStateFromStatus = (status) => {
    const installedModels = status?.models || [];
    const preferredInstalled = pickPreferredInstalledModel(installedModels);

    setConfig((prev) => ({
      ...prev,
      local: {
        ...prev.local,
        installed: Boolean(status?.installed),
        running: Boolean(status?.running),
        installedModels,
        availableModels: installedModels,
        model: installedModels.includes(prev.local.model)
          ? prev.local.model
          : (preferredInstalled || (variant === 'onboarding' ? PREFERRED_LOCAL_MODEL : '')),
      },
    }));
  };

  const refreshOllamaStatus = async ({ silent = false } = {}) => {
    setLoading(true);
    setSystemLoading(true);

    try {
      const [status, system] = await Promise.all([
        window.electronAPI?.checkOllamaStatus?.(),
        window.electronAPI?.getSystemStatus?.(),
      ]);

      if (system) {
        setEnvironmentStatus(normalizeSystemStatus(system));
        if (!silent) {
          if (!system.chrome?.installed) {
            addLog('Chrome is missing. Zara Scraper will stay unavailable until Chrome is installed.', 'warning');
          }
          if (!system.python?.available) {
            addLog('Python 3 is missing. Slides Maker, PPTX analysis, and PDF Squeezer need Python 3.', 'warning');
          } else if (!system.python?.packagesReady) {
            addLog(
              `Python is installed, but required packages are missing: ${(system.python?.missingModules || []).join(', ')}.`,
              'warning',
            );
          }
        }
      }

      if (status) {
        updateLocalStateFromStatus(status);
        setEnvironmentStatus((prev) => ({
          ...prev,
          ollama: {
            ...prev.ollama,
            installed: Boolean(status.installed),
            running: Boolean(status.running),
          },
        }));
        if (!silent) {
          addLog(
            `Ollama ${status.installed ? 'installed' : 'not installed'}, ${status.running ? 'running' : 'stopped'}.`,
            status.running ? 'success' : 'info'
          );
        }
      }
    } catch (error) {
      addLog(`Failed to check Ollama: ${error.message}`, 'error');
    } finally {
      setLoading(false);
      setSystemLoading(false);
    }
  };

  useEffect(() => {
    refreshOllamaStatus({ silent: true });
  }, []);

  useEffect(() => {
    const systemReady =
      environmentStatus.chrome.installed &&
      environmentStatus.python.available &&
      environmentStatus.python.packagesReady;

    if (
      surfaceMode !== 'guide' ||
      guideStep !== 0 ||
      !autoAdvanceGuide ||
      loading ||
      systemLoading
    ) {
      return undefined;
    }

    if (!systemReady || !config.local.installed) {
      setAutoAdvanceGuide(false);
      return undefined;
    }

    const timer = window.setTimeout(() => {
      addLog('Local check complete. Moving to configuration.', 'info');
      setGuideStep(1);
      setAutoAdvanceGuide(false);
    }, 900);

    return () => window.clearTimeout(timer);
  }, [
    autoAdvanceGuide,
    config.local.installed,
    environmentStatus.chrome.installed,
    environmentStatus.python.available,
    environmentStatus.python.packagesReady,
    guideStep,
    loading,
    surfaceMode,
    systemLoading,
  ]);

  const installOllama = async () => {
    setBusyAction('install');
    addLog('Installing Ollama...', 'info');

    try {
      const result = await window.electronAPI?.installOllama?.();
      if (result?.success) {
        addLog(result.message || 'Ollama installed successfully.', 'success');
        if (!result.manual) {
          await refreshOllamaStatus({ silent: true });
        }
      } else {
        addLog(result?.error || 'Install failed.', 'error');
      }
    } catch (error) {
      addLog(`Install failed: ${error.message}`, 'error');
    } finally {
      setBusyAction('');
    }
  };

  const startOllamaServer = async () => {
    setBusyAction('start');
    addLog('Starting Ollama service...', 'info');

    try {
      const result = await window.electronAPI?.startOllamaServer?.();
      if (result?.success) {
        addLog(result.alreadyRunning ? 'Ollama was already running.' : 'Ollama started.', 'success');
        await refreshOllamaStatus({ silent: true });
      } else {
        addLog(result?.error || 'Failed to start Ollama.', 'error');
      }
    } catch (error) {
      addLog(`Start failed: ${error.message}`, 'error');
    } finally {
      setBusyAction('');
    }
  };

  const testConnection = async (type) => {
    setTestStatus((prev) => ({ ...prev, [type]: 'testing' }));
    addLog(`Testing ${type} connection...`, 'info');

    try {
      const payload =
        type === 'local'
          ? { baseUrl: config.local.baseUrl, apiKey: '' }
          : { baseUrl: config.cloud.baseUrl, apiKey: config.cloud.apiKey };

      const result = await window.electronAPI?.testLLMConnection?.(payload);
      if (result?.success) {
        setTestStatus((prev) => ({ ...prev, [type]: 'connected' }));
        addLog(`${type === 'local' ? 'Local' : 'Cloud'} connection successful.`, 'success');

        if (result.models?.length) {
          setConfig((prev) => ({
            ...prev,
            [type]: {
              ...prev[type],
              availableModels: result.models,
              model: prev[type].model || result.models[0],
            },
          }));
        }

        if (type === 'cloud') {
          await testCloudNativeWebSearch({
            ...payload,
            model: config.cloud.model,
          });
        }
      } else {
        setTestStatus((prev) => ({ ...prev, [type]: 'failed' }));
        addLog(result?.error || `${type} connection failed.`, 'error');
        if (type === 'cloud') {
          setCloudNativeStatus({
            state: 'idle',
            supported: null,
            method: '',
            detail: '',
          });
        }
      }
    } catch (error) {
      setTestStatus((prev) => ({ ...prev, [type]: 'failed' }));
      addLog(`Connection test failed: ${error.message}`, 'error');
      if (type === 'cloud') {
        setCloudNativeStatus({
          state: 'idle',
          supported: null,
          method: '',
          detail: '',
        });
      }
    }
  };

  const handleApiCloudPresetChange = (presetId) => {
    setConfig((prev) => ({
      ...prev,
      apiCloud: { ...prev.apiCloud, activePresetId: presetId },
    }));
  };

  const handleApiCloudFieldChange = (presetId, field, value) => {
    setConfig((prev) => ({
      ...prev,
      apiCloud: {
        ...prev.apiCloud,
        presets: (prev.apiCloud?.presets || []).map((p) =>
          p.id === presetId ? { ...p, [field]: value } : p
        ),
      },
    }));
  };

  const testApiCloudConnection = async () => {
    const activePreset = (config.apiCloud?.presets || []).find(
      (p) => p.id === config.apiCloud?.activePresetId
    );
    if (!activePreset) return;

    const presetId = activePreset.id;
    setApiCloudTestStatus((prev) => ({ ...prev, [presetId]: 'testing' }));
    addLog(`Testing ${activePreset.name} connection...`, 'info');

    try {
      const result = await window.electronAPI?.testApiCloudConnection?.({
        baseUrl: activePreset.baseUrl,
        model: activePreset.model,
        apiKey: activePreset.apiKey,
      });

      if (result?.success) {
        setApiCloudTestStatus((prev) => ({ ...prev, [presetId]: 'connected' }));
        addLog(`${activePreset.name} connection successful. Found ${result.models?.length || 0} models.`, 'success');

        if (result.models?.length > 0) {
          setConfig((prev) => ({
            ...prev,
            apiCloud: {
              ...prev.apiCloud,
              presets: (prev.apiCloud?.presets || []).map((p) =>
                p.id === presetId ? { ...p, availableModels: result.models } : p
              ),
            },
          }));
        }
      } else {
        setApiCloudTestStatus((prev) => ({ ...prev, [presetId]: 'failed' }));
        addLog(`${activePreset.name} connection failed: ${result?.error || 'Unknown error'}`, 'error');
      }
    } catch (error) {
      setApiCloudTestStatus((prev) => ({ ...prev, [presetId]: 'failed' }));
      addLog(`Connection test failed: ${error.message}`, 'error');
    }
  };

  const testCloudNativeWebSearch = async (payloadOverride = null) => {
    const payload = payloadOverride || {
      baseUrl: config.cloud.baseUrl,
      apiKey: config.cloud.apiKey,
      model: config.cloud.model,
    };

    if (!payload.baseUrl) {
      setCloudNativeStatus({
        state: 'idle',
        supported: null,
        method: '',
        detail: 'Enter a cloud URL first.',
      });
      return;
    }

    setCloudNativeStatus({
      state: 'testing',
      supported: null,
      method: '',
      detail: 'Checking provider-native web search...',
    });

    try {
      const result = await window.electronAPI?.testCloudNativeWebSearch?.(payload);

      if (result?.success && result.supported) {
        setCloudNativeStatus({
          state: 'supported',
          supported: true,
          method: result.method || '',
          detail: 'This endpoint supports provider-native web search. Cloud mode can use native live search before software-side fallback.',
        });
        addLog('Cloud native web search is available.', 'success');
        return;
      }

      if (result?.success) {
        setCloudNativeStatus({
          state: 'fallback',
          supported: false,
          method: '',
          detail: result?.error
            ? `Native web search is not available on this endpoint. GS Bot will use software-side web retrieval instead. (${result.error})`
            : 'Native web search is not available on this endpoint. GS Bot will use software-side web retrieval instead.',
        });
        addLog('Cloud native web search is unavailable. Falling back to software-side web retrieval.', 'warning');
        return;
      }

      setCloudNativeStatus({
        state: 'error',
        supported: false,
        method: '',
        detail: result?.error || 'Could not verify native web search support.',
      });
      addLog(result?.error || 'Could not verify native web search support.', 'error');
    } catch (error) {
      setCloudNativeStatus({
        state: 'error',
        supported: false,
        method: '',
        detail: error.message,
      });
      addLog(`Could not verify native web search support: ${error.message}`, 'error');
    }
  };

  const installPaddleVlRuntime = async () => {
    if (environmentStatus.platform !== 'win32') {
      addLog('Automatic PaddleOCR-VL download is only available on Windows.', 'warning');
      return;
    }

    setInstallingPaddleVl(true);
    setDownloadProgress((prev) => ({ ...prev, paddleVlRuntime: 0 }));
    addLog('Downloading and assembling PaddleOCR-VL 1.6 into the GS Bot OCR model directory...', 'info');

    try {
      const result = await window.electronAPI?.installPaddleOcrVlRuntime?.((payload) => {
        if (typeof payload?.progress === 'number') {
          setDownloadProgress((prev) => ({ ...prev, paddleVlRuntime: payload.progress }));
        }
        // Only log the final phase, not every intermediate progress line
        if (payload?.phase === 'complete' && payload?.status) {
          addLog(`PaddleOCR-VL: ${payload.status}`, 'success');
        }
      });

      if (result?.success) {
        addLog(`PaddleOCR-VL runtime is ready in ${result.outputPath}.`, 'success');
        await refreshOllamaStatus({ silent: true });

        const nextConfig = normalizeConfig({
          ...config,
          ocr: mergeOcrConfig({
            ...(config.ocr || {}),
            paddleVlLocal: {
              ...DEFAULT_OCR_CONFIG.paddleVlLocal,
              ...((config.ocr && config.ocr.paddleVlLocal) || {}),
              enabled: true,
              model: 'paddleocr-vl-1.6',
            },
          }),
        });

        nextConfig.ocr.paddleVlLocal.enabled = true;
        nextConfig.ocr.paddleVlLocal.model = 'paddleocr-vl-1.6';
        setConfig(nextConfig);
        await window.electronAPI?.saveLLMConfig?.(nextConfig);
        dispatchLLMConfigUpdate(nextConfig);
      } else {
        addLog(result?.error || 'PaddleOCR-VL download failed.', 'error');
        setDownloadProgress((prev) => ({ ...prev, paddleVlRuntime: 0 }));
      }
    } catch (error) {
      addLog(`PaddleOCR-VL download failed: ${error.message}`, 'error');
    } finally {
      setInstallingPaddleVl(false);
    }
  };

  const localModelList =
    config.local.installedModels?.length > 0
      ? config.local.installedModels
      : config.local.availableModels || [];
  const dualLocalModelsReady = areDualLocalModelsReady(localModelList);
  const cloudModelList = config.cloud.availableModels || [];
  const recommendedLocalModel = resolveInstalledModelName(PREFERRED_LOCAL_MODEL, localModelList)
    || pickPreferredInstalledModel(localModelList)
    || PREFERRED_LOCAL_MODEL;
  const recommendedGarmentModel = resolvePreferredGarmentModel(localModelList);
  const recommendedCloudModel = config.cloud.model || cloudModelList[0] || PREFERRED_CLOUD_MODEL;
  const isWindowsPlatform = environmentStatus.platform === 'win32';
  const pythonReady =
    environmentStatus.python.available &&
    environmentStatus.python.packagesReady;
  const chromeReady = environmentStatus.chrome.installed;
  const localReady = Boolean(config.local.baseUrl && config.local.model);
  const cloudReady = Boolean(config.cloud.baseUrl && config.cloud.model && config.cloud.apiKey);

  // API-cloud presets (GLM / DeepSeek / Qwen / custom) are a THIRD endpoint.
  // They used to be ignored here, so a user who only filled in an API key on
  // the API Cloud card left Save disabled — and the Settings button, which
  // read `canSave ? save : close`, silently closed and discarded the input.
  const activeApiCloudPreset =
    (config.apiCloud?.presets || []).find((p) => p.id === config.apiCloud?.activePresetId)
    || (config.apiCloud?.presets || [])[0];
  const apiCloudReady = Boolean(
    activeApiCloudPreset?.baseUrl && activeApiCloudPreset?.model && activeApiCloudPreset?.apiKey,
  );
  const recentLogs = logs.slice(-6);
  const paddleVlCardReady = environmentStatus.paddleVl.ready;
  const paddleVlCardPartial = environmentStatus.paddleVl.bundled || environmentStatus.paddleVl.downloaded;
  const paddleVlActionDisabled = installingPaddleVl || !isWindowsPlatform;
  // Saving should be allowed whenever the user has a usable configuration.
  // hybrid genuinely needs both endpoints. For local/cloud we accept the
  // chosen mode's own endpoint, but we also accept a fully-configured OTHER
  // endpoint as a fallback — so a complete cloud setup is never blocked just
  // because local is empty (the exact bug users hit), and vice-versa. Runtime
  // routing decides which endpoint is actually used.
  const canSave =
    config.mode === 'hybrid'
      ? (localReady && cloudReady)
      : (localReady || cloudReady || apiCloudReady);

  // When a cloud model list has been fetched but no model is selected yet, the
  // dropdown shows the "choose a model" placeholder while config.cloud.model
  // stays empty — which keeps Save greyed out even though models were detected.
  // Auto-select the first detected model so Save unblocks; the user can change
  // it. Runs regardless of mode so configuring cloud always completes cleanly.
  useEffect(() => {
    if (cloudModelList.length > 0 && !config.cloud.model) {
      setConfig((prev) => ({
        ...prev,
        cloud: { ...prev.cloud, model: cloudModelList[0] },
      }));
    }
  }, [cloudModelList, config.cloud.model]);

  // Human-readable reason Save is blocked, so a greyed-out button is never a
  // mystery. Mirrors canSave: hybrid needs both; otherwise either endpoint works.
  let saveHint = '';
  if (!canSave) {
    if (config.mode === 'hybrid') {
      // Hybrid requires both endpoints fully configured.
      if (!cloudReady && !localReady) {
        saveHint = tx('Configure both the cloud and local endpoints.', '请同时配置云端和本地接入。');
      } else if (!cloudReady) {
        if (!config.cloud.baseUrl) saveHint = tx('Enter the cloud API endpoint.', '请填写云端 API 接口地址。');
        else if (!config.cloud.apiKey) saveHint = tx('Enter your API key.', '请填写 API key。');
        else saveHint = tx('Select a cloud model.', '请选择云端模型。');
      } else {
        if (!config.local.baseUrl) saveHint = tx('Enter the local server URL.', '请填写本地服务地址。');
        else saveHint = tx('Select a local model.', '请选择本地模型。');
      }
    } else if (config.mode === 'cloud') {
      if (!config.cloud.baseUrl) saveHint = tx('Enter the cloud API endpoint.', '请填写云端 API 接口地址。');
      else if (!config.cloud.apiKey) saveHint = tx('Enter your API key.', '请填写 API key。');
      else if (!config.cloud.model) saveHint = tx('Select a cloud model.', '请选择云端模型。');
    } else if (config.mode === 'apiCloud') {
      if (!activeApiCloudPreset?.baseUrl) saveHint = tx('Enter the API endpoint.', '请填写 API 接口地址。');
      else if (!activeApiCloudPreset?.apiKey) saveHint = tx('Enter your API key.', '请填写 API key。');
      else saveHint = tx('Select an API model.', '请选择 API 模型。');
    } else {
      // local (or unset): nothing is fully configured yet — accept either side.
      saveHint = tx('Finish configuring a local model or a cloud API to save.', '请配置好本地模型或云端 API 后再保存。');
    }
  }



  const openExternalLink = async (url, label) => {
    try {
      const result = await window.electronAPI?.openExternalUrl?.(url);
      if (result?.success) {
        addLog(`Opened ${label}.`, 'info');
      } else {
        addLog(result?.error || `Could not open ${label}.`, 'error');
      }
    } catch (error) {
      addLog(`Could not open ${label}: ${error.message}`, 'error');
    }
  };

  // `allowPartial` is used by the Settings surface: the user explicitly pressed
  // "Save & Close", so whatever they filled in must be persisted rather than
  // silently dropped when `canSave` happens to be false. The strict gate stays
  // for the onboarding flow, where "nothing configured yet" should block.
  const saveConfig = async ({ allowPartial = false } = {}) => {
    if (!canSave && !allowPartial) {
      addLog('Complete the required setup before saving.', 'warning');
      return;
    }

    setSaving(true);
    const nextConfig = {
      ...config,
      onboardingCompleted: true,
      onboardingCompletedAt: config.onboardingCompletedAt || new Date().toISOString(),
    };

    try {
      const result = await window.electronAPI?.saveLLMConfig?.(nextConfig);
      if (result?.success) {
        dispatchLLMConfigUpdate(nextConfig);
        addLog(surfaceMode === 'guide' ? 'Setup saved. Entering workspace...' : 'Changes saved successfully.', 'success');
        onComplete?.(nextConfig);
      } else {
        addLog('Failed to save setup.', 'error');
      }
    } catch (error) {
      addLog(`Failed to save setup: ${error.message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  const skipForNow = async () => {
    if (!isOnboarding) {
      handleClose();
      return;
    }

    setSaving(true);
    const nextConfig = {
      ...config,
      onboardingCompleted: false,
      onboardingSkippedAt: new Date().toISOString(),
    };

    try {
      const result = await window.electronAPI?.saveLLMConfig?.(nextConfig);
      if (result?.success) {
        dispatchLLMConfigUpdate(nextConfig);
        addLog('Skipped setup for now. Entering workspace...', 'info');
        onComplete?.(nextConfig);
      } else {
        addLog('Could not skip setup right now.', 'error');
      }
    } catch (error) {
      addLog(`Could not skip setup: ${error.message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    if (surfaceMode === 'guide' && !isOnboarding) {
      setPreviewFirstRun(false);
      setSurfaceMode('status');
      setGuideStep(0);
      setAutoAdvanceGuide(false);
      return;
    }

    onClose?.();
  };

  const openGuide = async () => {
    setPreviewFirstRun(false);
    setSurfaceMode('guide');
    setGuideStep(0);
    setAutoAdvanceGuide(false);
    await refreshOllamaStatus({ silent: false });
  };

  const nextGuideStep = () => {
    addLog('Continue to the next setup step.', 'info');
    setAutoAdvanceGuide(false);
    setGuideStep((prev) => Math.min(prev + 1, 2));
  };

  const applyRecommendedMode = (mode) => {
    setConfig((prev) => {
      const nextConfig = {
        ...prev,
        mode,
        local: {
          ...prev.local,
          model: prev.local.model || recommendedLocalModel,
        },
        apparelVision: {
          ...prev.apparelVision,
          enabled: true,
          mode: 'dual-model',
          baseUrl: prev.local.baseUrl || DEFAULT_CONFIG.local.baseUrl,
          fabricModel: recommendedLocalModel,
          garmentModel: recommendedGarmentModel,
        },
        cloud: {
          ...prev.cloud,
          baseUrl: prev.cloud.baseUrl || DEFAULT_CLOUD_BASE_URL,
          model: prev.cloud.model || recommendedCloudModel,
          nativeWebSearch: true,
        },
      };

      return nextConfig;
    });

    addLog(
      mode === 'local'
        ? `Recommended local mode selected (${recommendedLocalModel} + ${recommendedGarmentModel}).`
        : 'Recommended cloud mode selected.',
      'success',
    );
    setSetupAccessMode(mode);
    setGuideStep(1);
  };

  const handleSetupAccessModeChange = (mode) => {
    setSetupAccessMode(mode);
    setConfig((prev) => ({ ...prev, mode }));
  };

  const refreshCloudModelsFromGuide = async () => {
    if (!config.cloud.apiKey) {
      addLog('Enter your cloud API key first, then refresh the model list.', 'warning');
      return;
    }

    await testConnection('cloud');
  };

  const renderGuideModePanel = () => (
    <section className="setup-panel setup-guide-focus-panel">
      <div className="setup-panel-header">
        <div>
          <h2>{tx('Choose a starting route', '选择开始方式')}</h2>
          <p>{tx('Cloud-only is enough to start using GS Bot. You can configure local models later in Setup.', '只配置云端就足够开始使用 GS Bot，本地模型可以之后再设置。')}</p>
        </div>
      </div>

      <div className="setup-recommend-grid setup-recommend-grid-guide">
        <button
          type="button"
          className={`setup-recommend-card setup-guide-mode-card ${config.mode === 'cloud' ? 'active' : ''}`}
          onClick={() => applyRecommendedMode('cloud')}
        >
          <span className="setup-recommend-kicker">{tx('Recommended', '推荐')}</span>
          <strong>{tx('Cloud first', '先用云端')}</strong>
          <em>{tx('Only enter your API key and choose a cloud model. Local setup can wait.', '只需填写 API key 并选择云端模型，本地配置可以稍后再做。')}</em>
        </button>

        <button
          type="button"
          className={`setup-recommend-card setup-guide-mode-card ${config.mode === 'local' ? 'active' : ''}`}
          onClick={() => applyRecommendedMode('local')}
        >
          <span className="setup-recommend-kicker">{tx('Optional', '可选')}</span>
          <strong>{tx('Local first', '先用本地')}</strong>
          <em>{tx('Use the fixed local Ollama address and choose one local model.', '使用固定的本地 Ollama 地址，并选择一个本地模型。')}</em>
        </button>
      </div>
    </section>
  );

  const renderGuideConfigurePanel = () => (
    <section className="setup-panel setup-guide-focus-panel setup-guide-config-panel">
      <div className="setup-panel-header">
        <div>
          <h2>{config.mode === 'cloud' ? tx('Cloud access', '云端接入') : tx('Local model', '本地模型')}</h2>
          <p>
            {config.mode === 'cloud'
              ? tx('The cloud endpoint is fixed. Just enter your API key and choose a model.', '云端地址已固定，只需填写 API key 并选择模型。')
              : tx('The local Ollama address is fixed to localhost. Just install Ollama if needed and choose a model.', '本地 Ollama 地址固定为 localhost，只需按需安装 Ollama 并选择模型。')}
          </p>
        </div>
        <div className="setup-panel-actions">
          {config.mode === 'cloud' ? (
            <>
              <button className={`setup-secondary-btn ${testStatus.cloud || ''}`} onClick={() => testConnection('cloud')}>
                {testStatus.cloud === 'testing'
                  ? tx('Testing...', '测试中...')
                  : testStatus.cloud === 'connected'
                    ? tx('Connected', '已连接')
                    : tx('Test cloud', '测试云端')}
              </button>
              <button className="setup-secondary-btn" onClick={() => refreshCloudModelsFromGuide()}>
                {tx('Refresh models', '刷新模型')}
              </button>
            </>
          ) : (
            <>
              <button className="setup-secondary-btn" onClick={() => refreshOllamaStatus()} disabled={loading}>
                {loading ? tx('Checking...', '检查中...') : tx('Refresh local', '刷新本地')}
              </button>
              <button className={`setup-secondary-btn ${testStatus.local || ''}`} onClick={() => testConnection('local')}>
                {testStatus.local === 'testing'
                  ? tx('Testing...', '测试中...')
                  : testStatus.local === 'connected'
                    ? tx('Connected', '已连接')
                    : tx('Test local', '测试本地')}
              </button>
            </>
          )}
        </div>
      </div>

      {config.mode === 'cloud' ? (
        <>
          <div className="setup-inline-hint">
            {tx('Fixed cloud URL', '固定云端地址')}：{config.cloud.baseUrl || DEFAULT_CLOUD_BASE_URL}
          </div>

          <div className="setup-form-grid">
            <label className="setup-field">
              <span>{tx('API key', 'API key')}</span>
              <input
                type="password"
                value={config.cloud.apiKey}
                onChange={(event) =>
                  setConfig((prev) => ({
                    ...prev,
                    cloud: {
                      ...prev.cloud,
                      baseUrl: prev.cloud.baseUrl || DEFAULT_CLOUD_BASE_URL,
                      apiKey: event.target.value,
                    },
                  }))
                }
                placeholder="your-api-key"
              />
            </label>

            {renderCloudModelField()}
          </div>
        </>
      ) : (
        <>
          <div className="setup-inline-hint">
            {tx('Fixed local URL', '固定本地地址')}：{config.local.baseUrl || 'http://localhost:11434'}
          </div>

          {!config.local.installed && (
            <div className="setup-check-actions" style={{ marginTop: '14px' }}>
              <button className="setup-primary-btn" onClick={installOllama} disabled={busyAction === 'install'}>
                {busyAction === 'install' ? tx('Opening...', '打开中...') : tx('Install Ollama', '安装 Ollama')}
              </button>
            </div>
          )}

          {config.local.installed && !config.local.running && (
            <div className="setup-check-actions" style={{ marginTop: '14px' }}>
              <button className="setup-primary-btn" onClick={startOllamaServer} disabled={busyAction === 'start'}>
                {busyAction === 'start' ? tx('Starting...', '启动中...') : tx('Start Ollama', '启动 Ollama')}
              </button>
            </div>
          )}

          <div className="setup-form-grid">
            {renderLocalModelField()}
          </div>
        </>
      )}
    </section>
  );

  const renderLocalModelField = () => {
    if (localModelList.length > 0) {
      return (
        <label className="setup-field">
          <span>{tx('Local model', '本地模型')}</span>
          <select
            value={config.local.model}
            onChange={(event) => {
              const nextValue = event.target.value;
              setConfig((prev) => ({
                ...prev,
                local: { ...prev.local, model: nextValue },
                apparelVision: {
                  ...prev.apparelVision,
                  enabled: true,
                  mode: 'dual-model',
                  baseUrl: prev.local.baseUrl || DEFAULT_CONFIG.local.baseUrl,
                  fabricModel: isGr3FabricModel(nextValue) ? nextValue : (prev.apparelVision?.fabricModel || recommendedLocalModel),
                  garmentModel: prev.apparelVision?.garmentModel || recommendedGarmentModel,
                },
              }));
            }}
          >
            <option value="">{tx('Choose a model...', '选择一个模型...')}</option>
            {localModelList.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </label>
      );
    }

    return (
      <label className="setup-field">
        <span>{tx('Local model', '本地模型')}</span>
        <input
          type="text"
          value={config.local.model}
          onChange={(event) =>
            setConfig((prev) => ({
              ...prev,
              local: { ...prev.local, model: event.target.value },
            }))
          }
          placeholder="qwen3-vl:4b"
        />
      </label>
    );
  };

  const renderCloudModelField = () => {
    if (cloudModelList.length > 0) {
      return (
        <label className="setup-field">
          <span>{tx('Cloud model', '云端模型')}</span>
          <select
            value={config.cloud.model}
            onChange={(event) =>
              setConfig((prev) => ({
                ...prev,
                cloud: { ...prev.cloud, model: event.target.value },
              }))
            }
          >
            <option value="">{tx('Choose a model...', '选择一个模型...')}</option>
            {cloudModelList.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </label>
      );
    }

      return (
      <label className="setup-field">
        <span>{tx('Cloud model', '云端模型')}</span>
        <input
          type="text"
          value={config.cloud.model}
          onChange={(event) =>
            setConfig((prev) => ({
              ...prev,
              cloud: { ...prev.cloud, model: event.target.value },
            }))
          }
          placeholder="qwen3-vl:235b"
        />
      </label>
    );
  };

  const removeLocalModel = async (modelName) => {
    setRemovingModels((prev) => ({ ...prev, [modelName]: true }));
    addLog(`Removing ${modelName}...`, 'info');

    try {
      const result = await window.electronAPI?.removeOllamaModel?.(modelName);
      if (!result?.success) {
        addLog(result?.error || `Could not remove ${modelName}.`, 'error');
        return;
      }

      const status = await window.electronAPI?.checkOllamaStatus?.();
      const nextInstalledModels = status?.models || [];
      const currentModelStillExists = Boolean(resolveInstalledModelName(config.local.model, nextInstalledModels));
      const installedDeepseekModel = resolveInstalledModelName(config.ocr?.deepseekLocal?.model, nextInstalledModels);
      const currentOcrConfig = mergeOcrConfig({
        ...(config.ocr || {}),
        deepseekLocal: {
          ...DEFAULT_OCR_CONFIG.deepseekLocal,
          ...((config.ocr && config.ocr.deepseekLocal) || {}),
        },
      });
      const nextOcrConfig = installedDeepseekModel
        ? {
          ...currentOcrConfig,
          deepseekLocal: {
            ...currentOcrConfig.deepseekLocal,
            enabled: true,
            model: installedDeepseekModel,
          },
        }
        : {
          ...currentOcrConfig,
          engine: currentOcrConfig.engine === 'deepseek-local'
            ? 'paddle-local'
            : currentOcrConfig.engine,
          fallbackEngine: '',
          deepseekLocal: {
            ...currentOcrConfig.deepseekLocal,
            enabled: false,
            model: LOCAL_DEEPSEEK_OCR_MODEL,
          },
        };
      const nextConfig = {
        ...config,
        local: {
          ...config.local,
          installed: Boolean(status?.installed),
          running: Boolean(status?.running),
          installedModels: nextInstalledModels,
          availableModels: nextInstalledModels,
          model: currentModelStillExists
            ? config.local.model
            : (pickPreferredInstalledModel(nextInstalledModels) || (variant === 'onboarding' ? PREFERRED_LOCAL_MODEL : '')),
        },
        ocr: nextOcrConfig,
      };

      setConfig(nextConfig);
      await window.electronAPI?.saveLLMConfig?.(nextConfig);
      dispatchLLMConfigUpdate(nextConfig);

      addLog(`${modelName} removed.`, 'success');
      if (!installedDeepseekModel && isLocalDeepseekOcrModel(modelName)) {
        addLog('DeepSeek OCR local route was removed, so the primary OCR switched to the embedded Paddle OCR route.', 'info');
      }
    } catch (error) {
      addLog(`Could not remove ${modelName}: ${error.message}`, 'error');
    } finally {
      setRemovingModels((prev) => ({ ...prev, [modelName]: false }));
    }
  };

  const renderRecommendedModesPanel = () => (
    <section className="setup-panel">
      <div className="setup-panel-header">
        <div>
          <h2>{tx('Recommended setup', '推荐配置')}</h2>
          <p>{tx('Start with a preset, then adjust details only if needed.', '先从推荐预设开始，之后再按需要调整。')}</p>
        </div>
      </div>

      <div className="setup-recommend-grid">
        <button
          type="button"
          className={`setup-recommend-card ${config.mode === 'local' ? 'active' : ''}`}
          onClick={() => applyRecommendedMode('local')}
        >
          <span className="setup-recommend-kicker">{tx('Recommended Local', '推荐本地')}</span>
          <strong>{tx('GR3-Fabric', 'GR3-Fabric')}</strong>
          <em>{tx('Recommended local style-description model.', '推荐的本地款式描述模型。')}</em>
        </button>

        <button
          type="button"
          className={`setup-recommend-card ${config.mode === 'cloud' ? 'active' : ''}`}
          onClick={() => applyRecommendedMode('cloud')}
        >
          <span className="setup-recommend-kicker">{tx('Recommended Cloud', '推荐云端')}</span>
          <strong>{tx('Qwen3 VL 235B', 'Qwen3 VL 235B')}</strong>
          <em>{tx('Recommended cloud style-description model.', '推荐的云端款式描述模型。')}</em>
        </button>
      </div>
    </section>
  );

  const renderSystemChecksPanel = () => (
    <section className="setup-panel">
      <div className="setup-panel-header">
        <div>
          <h2>{tx('System checks', '系统检查')}</h2>
          <p>{tx('Chrome, Python, packages, local runtime.', 'Chrome、Python、依赖包和本地运行时。')}</p>
        </div>
        <div className="setup-panel-actions">
          <button className="setup-secondary-btn" onClick={() => refreshOllamaStatus()} disabled={loading || systemLoading}>
            {loading || systemLoading ? tx('Checking...', '检查中...') : tx('Refresh checks', '刷新检查')}
          </button>
        </div>
      </div>

      <div className="setup-check-grid">
        <article className={`setup-check-card ${chromeReady ? 'ready' : 'warning'}`}>
          <div className="setup-check-topline">
            <strong>Chrome</strong>
            <span className={`setup-check-badge ${chromeReady ? 'ready' : 'warning'}`}>
              {chromeReady ? tx('Installed', '已安装') : tx('Missing', '缺失')}
            </span>
          </div>
          <p>{environmentStatus.chrome.requiredBy}</p>
          <em>{environmentStatus.chrome.path || tx('Google Chrome is required for Zara Scraper.', 'Zara 抓取需要安装 Google Chrome。')}</em>
          {!chromeReady && (
            <div className="setup-check-actions">
              <button
                className="setup-secondary-btn"
                onClick={() => openExternalLink('https://www.google.com/chrome/', 'Chrome download')}
              >
                {tx('Download Chrome', '下载 Chrome')}
              </button>
            </div>
          )}
        </article>

        <article className={`setup-check-card ${pythonReady ? 'ready' : 'warning'}`}>
          <div className="setup-check-topline">
            <strong>{tx('Python stack', 'Python 环境')}</strong>
            <span className={`setup-check-badge ${pythonReady ? 'ready' : 'warning'}`}>
              {pythonReady
                ? tx('Ready', '就绪')
                : environmentStatus.python.available
                  ? tx('Needs packages', '缺少依赖')
                  : tx('Missing', '缺失')}
            </span>
          </div>
          <p>{environmentStatus.python.requiredBy}</p>
          <em>
            {pythonReady
              ? environmentStatus.python.command || 'Python 3'
              : environmentStatus.python.available
                ? `${tx('Install', '安装')}：${environmentStatus.python.missingModules.join(', ')}`
                : tx('Install Python 3 first.', '请先安装 Python 3。')}
          </em>
          {!pythonReady && (
            <div className="setup-check-actions">
              <button
                className="setup-secondary-btn"
                onClick={() =>
                  openExternalLink(
                    environmentStatus.platform === 'win32'
                      ? 'https://www.python.org/downloads/windows/'
                      : 'https://www.python.org/downloads/',
                    'Python download',
                  )
                }
              >
                {tx('Download Python', '下载 Python')}
              </button>
            </div>
          )}
        </article>

        <article className={`setup-check-card ${config.local.installed ? 'ready' : 'warning'}`}>
          <div className="setup-check-topline">
            <strong>Ollama</strong>
            <span className={`setup-check-badge ${config.local.running ? 'ready' : config.local.installed ? 'soft' : 'warning'}`}>
              {config.local.running ? tx('Running', '运行中') : config.local.installed ? tx('Installed', '已安装') : tx('Missing', '缺失')}
            </span>
          </div>
          <p>{environmentStatus.ollama.requiredBy}</p>
          <em>{environmentStatus.ollama.path || tx('Install Ollama to use local AI.', '使用本地 AI 前请先安装 Ollama。')}</em>
          {!config.local.installed && (
            <div className="setup-check-actions">
              <button className="setup-secondary-btn" onClick={installOllama} disabled={busyAction === 'install'}>
                {busyAction === 'install' ? tx('Opening...', '打开中...') : tx('Install Ollama', '安装 Ollama')}
              </button>
            </div>
          )}
        </article>

        <article className={`setup-check-card ${paddleVlCardReady ? 'ready' : paddleVlCardPartial ? 'soft' : 'warning'}`}>
            <div className="setup-check-topline">
              <strong>{tx('PaddleOCR-VL', 'PaddleOCR-VL')}</strong>
              <span className={`setup-check-badge ${paddleVlCardReady ? 'ready' : paddleVlCardPartial ? 'soft' : 'warning'}`}>
                {paddleVlCardReady
                  ? tx('Ready', '已就绪')
                  : paddleVlCardPartial
                    ? tx('Partial', '部分就绪')
                    : tx('Not installed', '未安装')}
              </span>
            </div>
            <p>{environmentStatus.paddleVl.requiredBy}</p>
            <em>
              {paddleVlCardReady
                ? (environmentStatus.paddleVl.home || environmentStatus.paddleVl.entrypoint || environmentStatus.paddleVl.path || tx('Downloaded runtime detected.', '已检测到已下载运行时。'))
                : isWindowsPlatform
                  ? (environmentStatus.paddleVl.message
                    || environmentStatus.paddleVl.hint
                    || tx('PaddleOCR-VL is not downloaded yet.', 'PaddleOCR-VL 还没有下载。'))
                  : tx('This OCR runtime is shown here for parity, but automatic download is currently available on Windows first.', '这里保留这个 OCR 运行时入口以保持界面一致，但自动下载目前优先在 Windows 提供。')}
            </em>
            <div className="setup-check-actions">
              <button
                className="setup-secondary-btn"
                onClick={installPaddleVlRuntime}
                disabled={paddleVlActionDisabled}
              >
                {!isWindowsPlatform
                  ? tx('Windows first', 'Windows 优先')
                  : installingPaddleVl
                  ? tx('Downloading...', '下载中...')
                  : paddleVlCardReady
                    ? tx('Reinstall runtime', '重新安装运行时')
                    : tx('Download PaddleOCR-VL', '下载 PaddleOCR-VL')}
              </button>
            </div>
            {typeof downloadProgress.paddleVlRuntime === 'number' && downloadProgress.paddleVlRuntime > 0 && (
              <div className="setup-progress-bar">
                <div
                  className="setup-progress-fill"
                  style={{ width: `${Math.max(2, downloadProgress.paddleVlRuntime)}%` }}
                />
              </div>
            )}
          </article>
      </div>
    </section>
  );

  const renderAccessPanel = () => (
    <section className="setup-panel">
      <div className="setup-panel-header">
        <div>
          <h2>{tx('Ollama Configuration', 'Ollama 配置')}</h2>
          <p>{tx('Configure Ollama local and cloud access.', '配置 Ollama 本地和云端接入。')}</p>
        </div>
      </div>

      <div className="setup-access-grid">
        <div className="setup-section-block">
          <div className="setup-subtitle-row">
            <h3>{tx('Local configuration', '本地配置')}</h3>
          </div>
          <div className="setup-mini-summary">
            <span className={`setup-runtime-pill ${config.local.installed ? 'ready' : ''}`}>
              {config.local.installed ? tx('Installed', '已安装') : tx('Not installed', '未安装')}
            </span>
            <span className={`setup-runtime-pill ${config.local.running ? 'ready' : ''}`}>
              {config.local.running ? tx('Running', '运行中') : tx('Stopped', '已停止')}
            </span>
            <span className="setup-runtime-pill">{tx(`${localModelList.length} local models`, `${localModelList.length} 个本地模型`)}</span>
          </div>

          <div className="setup-form-grid">
            <label className="setup-field">
              <span>{tx('Local URL', '本地地址')}</span>
              <input
                type="text"
                value={config.local.baseUrl}
                onChange={(event) =>
                  setConfig((prev) => ({
                    ...prev,
                    local: { ...prev.local, baseUrl: event.target.value },
                  }))
                }
                placeholder="http://localhost:11434"
              />
            </label>

            {renderLocalModelField()}
          </div>

          <div className="setup-inline-actions">
            <button className="setup-secondary-btn" onClick={() => refreshOllamaStatus()} disabled={loading}>
              {loading ? tx('Checking...', '检查中...') : tx('Refresh', '刷新')}
            </button>
            {!config.local.installed && (
              <button className="setup-primary-btn" onClick={installOllama} disabled={busyAction === 'install'}>
                {busyAction === 'install' ? tx('Installing...', '安装中...') : tx('Install', '安装')}
              </button>
            )}
            {config.local.installed && !config.local.running && (
              <button className="setup-primary-btn" onClick={startOllamaServer} disabled={busyAction === 'start'}>
                {busyAction === 'start' ? tx('Starting...', '启动中...') : tx('Start', '启动')}
              </button>
            )}
            <button className={`setup-secondary-btn ${testStatus.local || ''}`} onClick={() => testConnection('local')}>
              {testStatus.local === 'testing'
                ? tx('Testing...', '测试中...')
                : testStatus.local === 'connected'
                  ? tx('Local connected', '本地已连接')
                  : tx('Test local connection', '测试本地连接')}
            </button>
          </div>
        </div>

        <div className="setup-section-block">
          <div className="setup-subtitle-row">
            <h3>{tx('Cloud configuration', '云端配置')}</h3>
          </div>
          <div className="setup-mini-summary">
            <span className={`setup-runtime-pill ${config.cloud.apiKey ? 'ready' : ''}`}>
              {config.cloud.apiKey ? tx('API key added', '已填写 API key') : tx('API key missing', '未填写 API key')}
            </span>
            <span className={`setup-runtime-pill ${config.cloud.model ? 'ready' : ''}`}>
              {config.cloud.model ? tx('Model selected', '已选择模型') : tx('Model missing', '未选择模型')}
            </span>
          </div>

          <div className="setup-form-grid">
            <label className="setup-field">
              <span>{tx('Cloud URL', '云端地址')}</span>
              <input
                type="text"
                value={config.cloud.baseUrl}
                onChange={(event) =>
                  setConfig((prev) => ({
                    ...prev,
                    cloud: { ...prev.cloud, baseUrl: event.target.value },
                  }))
                }
                placeholder={DEFAULT_CLOUD_BASE_URL}
              />
            </label>
            <label className="setup-field">
              <span>{tx('API key', 'API key')}</span>
              <input
                type="password"
                value={config.cloud.apiKey}
                onChange={(event) =>
                  setConfig((prev) => ({
                    ...prev,
                    cloud: { ...prev.cloud, apiKey: event.target.value },
                  }))
                }
                placeholder="your-api-key"
              />
            </label>
          </div>

          {renderCloudModelField()}

          <div className="setup-inline-actions">
            <button className={`setup-secondary-btn ${testStatus.cloud || ''}`} onClick={() => testConnection('cloud')}>
              {testStatus.cloud === 'testing'
                ? tx('Testing...', '测试中...')
                : testStatus.cloud === 'connected'
                  ? tx('Connected', '已连接')
                  : tx('Test cloud', '测试云端')}
            </button>
            <button className="setup-secondary-btn" onClick={refreshCloudModelsFromGuide}>
              {tx('Refresh models', '刷新模型')}
            </button>
          </div>

        </div>
      </div>
    </section>
  );

  const renderApiCloudPanel = () => (
    <section className="setup-panel">
      <div className="setup-panel-header">
        <div>
          <h2>{tx('API Cloud', 'API 云端')}</h2>
          <p>{tx('GLM, DeepSeek, Qwen and other API-based LLM services.', 'GLM、DeepSeek、Qwen 等基于 API 的大语言服务。')}</p>
        </div>
      </div>

      <div className="setup-access-grid">
        <div className="setup-section-block">
          <div className="setup-mini-summary">
            <span className={`setup-runtime-pill ${(config.apiCloud?.presets || []).find(p => p.id === config.apiCloud?.activePresetId)?.apiKey ? 'ready' : ''}`}>
              {(config.apiCloud?.presets || []).find(p => p.id === config.apiCloud?.activePresetId)?.apiKey
                ? tx('API key added', '已填写 API key')
                : tx('API key missing', '未填写 API key')}
            </span>
            <span className={`setup-runtime-pill ${(config.apiCloud?.presets || []).find(p => p.id === config.apiCloud?.activePresetId)?.model ? 'ready' : ''}`}>
              {(config.apiCloud?.presets || []).find(p => p.id === config.apiCloud?.activePresetId)?.model
                ? tx('Model selected', '已选择模型')
                : tx('Model missing', '未选择模型')}
            </span>
          </div>

          <div className="setup-form-grid">
            <label className="setup-field">
              <span>{tx('Service provider', '服务提供商')}</span>
              <select
                value={config.apiCloud?.activePresetId || 'glm'}
                onChange={(e) => handleApiCloudPresetChange(e.target.value)}
              >
                {(config.apiCloud?.presets || []).map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </label>
          </div>

          {(() => {
            const activePreset = (config.apiCloud?.presets || []).find(p => p.id === config.apiCloud?.activePresetId);
            if (!activePreset) return null;
            const testState = apiCloudTestStatus[activePreset.id] || '';
            const fetchedModels = Array.isArray(activePreset.availableModels) ? activePreset.availableModels : [];
            const fallbackModels = Array.isArray(activePreset.fallbackModels) ? activePreset.fallbackModels : [];
            const knownModels = uniq([...fetchedModels, ...fallbackModels]);
            const currentModel = activePreset.model || '';
            const modelIsKnown = currentModel && knownModels.includes(currentModel);

            return (
              <>
                <div className="setup-form-grid">
                  <label className="setup-field">
                    <span>{tx('Base URL', 'Base URL')}</span>
                    <input
                      type="text"
                      value={activePreset.baseUrl}
                      onChange={(e) => handleApiCloudFieldChange(activePreset.id, 'baseUrl', e.target.value)}
                      placeholder="https://api.example.com/v1"
                    />
                  </label>
                  <label className="setup-field">
                    <span>{tx('API key', 'API key')}</span>
                    <input
                      type="password"
                      value={activePreset.apiKey}
                      onChange={(e) => handleApiCloudFieldChange(activePreset.id, 'apiKey', e.target.value)}
                      placeholder="sk-xxxxxxxxxxxxxxxx"
                    />
                  </label>
                </div>

                <div className="setup-form-grid">
                  <label className="setup-field">
                    <span>{tx('Model', '模型')}</span>
                    {knownModels.length > 0 ? (
                      <select
                        value={modelIsKnown ? currentModel : '__custom_input__'}
                        onChange={(e) => {
                          if (e.target.value === '__custom_input__') {
                            handleApiCloudFieldChange(activePreset.id, 'model', '');
                          } else {
                            handleApiCloudFieldChange(activePreset.id, 'model', e.target.value);
                          }
                        }}
                      >
                        {knownModels.map((m) => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                        <option value="__custom_input__">{tx('Custom input...', '自定义输入...')}</option>
                        {!modelIsKnown && currentModel && (
                          <option value={currentModel}>{currentModel}</option>
                        )}
                      </select>
                    ) : (
                      <input
                        type="text"
                        value={activePreset.model}
                        onChange={(e) => handleApiCloudFieldChange(activePreset.id, 'model', e.target.value)}
                        placeholder="e.g. glm-4-plus, deepseek-chat"
                      />
                    )}
                  </label>
                  {knownModels.length > 0 && !modelIsKnown && (
                    <label className="setup-field">
                      <span>{tx('Custom model name', '自定义模型名称')}</span>
                      <input
                        type="text"
                        value={currentModel}
                        onChange={(e) => handleApiCloudFieldChange(activePreset.id, 'model', e.target.value)}
                        placeholder={tx('Type model name', '输入模型名称')}
                      />
                    </label>
                  )}
                </div>

                <div className="setup-inline-actions">
                  <button
                    className={`setup-secondary-btn ${testState}`}
                    onClick={testApiCloudConnection}
                    disabled={testState === 'testing'}
                  >
                    {testState === 'testing'
                      ? tx('Testing...', '测试中...')
                      : testState === 'connected'
                        ? tx('Connected', '已连接')
                        : testState === 'failed'
                          ? tx('Connection failed', '连接失败')
                          : tx('Test connection', '测试连接')}
                  </button>
                  <button
                    className="setup-secondary-btn"
                    onClick={testApiCloudConnection}
                    disabled={testState === 'testing'}
                    title={tx('Refresh model list', '刷新模型列表')}
                  >
                    {tx('Refresh models', '刷新模型')}
                  </button>
                </div>
              </>
            );
          })()}
        </div>
      </div>
    </section>
  );

  const renderLogsPanel = () => (
    <section className="setup-panel">
      <div className="setup-panel-header">
        <div>
          <h2>{tx('Recent Activity', '最近活动')}</h2>
          <p>{tx('Latest events.', '最新事件。')}</p>
        </div>
      </div>

      <div className="setup-log-list">
        {recentLogs.length === 0 && (
          <div className="setup-log-empty">{tx('No activity yet.', '暂无活动。')}</div>
        )}
        {recentLogs.map((log, index) => (
          <div key={`${log.time}-${index}`} className={`setup-log-line ${log.type}`}>
            <span>{log.time}</span>
            <strong>{log.msg}</strong>
          </div>
        ))}
      </div>
    </section>
  );

  const renderGuideReviewPanel = () => (
    <section className="setup-panel">
      <div className="setup-panel-header">
        <div>
          <h2>{tx('Ready to enter GS Bot', '准备进入 GS Bot')}</h2>
          <p>{tx('Review the current route before saving.', '保存前先确认当前路线。')}</p>
        </div>
      </div>

      <div className="setup-guide-checklist">
        <div className="setup-guide-check-item">
          <strong>{tx('Mode', '模式')}</strong>
          <span>{config.mode === 'cloud' ? tx('Cloud', '云端') : tx('Local', '本地')}</span>
        </div>
        <div className="setup-guide-check-item">
          <strong>{tx('Local model', '本地模型')}</strong>
          <span>{config.mode === 'cloud' ? tx('Configure later in Setup', '之后再去设置中配置') : (config.local.model || tx('Not selected yet', '尚未选择'))}</span>
        </div>
        <div className="setup-guide-check-item">
          <strong>{tx('Cloud model', '云端模型')}</strong>
          <span>{config.mode === 'cloud' ? (config.cloud.model || tx('Not selected yet', '尚未选择')) : tx('Optional later', '稍后可选')}</span>
        </div>
        <div className="setup-guide-check-item">
          <strong>{tx('System status', '系统状态')}</strong>
          <span>
            {config.mode === 'cloud'
              ? (cloudReady ? tx('Ready', '就绪') : tx('Needs attention', '需要处理'))
              : chromeReady && pythonReady && config.local.installed
                ? tx('Ready', '就绪')
                : tx('Needs attention', '需要处理')}
          </span>
        </div>
      </div>
    </section>
  );

  const renderStatusSurface = () => (
    <section className="setup-modules">
      <header className="setup-modules__header">
        <div>
          <h1>{tx('Settings', '设置')}</h1>
          <p>{tx('Configure API connections, models, and integrations.', '配置 API 连接、模型和集成。')}</p>
        </div>
        <div className="setup-modules__actions">
          {saveHint && <span className="setup-save-hint">{saveHint}</span>}
          <button
            className="setup-primary-btn"
            onClick={() => saveConfig({ allowPartial: true })}
            disabled={saving}
          >
            {saving ? tx('Saving...', '保存中...') : tx('Save & Close', '保存并关闭')}
          </button>
        </div>
      </header>

      <div className="setup-module-grid">
        {/* Module 1: API Cloud */}
        <div className="setup-module-card">
          <div className="setup-module-card__head">
            <div className="setup-module-card__icon setup-module-card__icon--llm">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ width: 22, height: 22 }}>
                <path d="M12 2a4 4 0 0 1 4 4v1h1a3 3 0 0 1 3 3v1a3 3 0 0 1-3 3h-1v1a4 4 0 0 1-4 4 4 4 0 0 1-4-4v-1H7a3 3 0 0 1-3-3v-1a3 3 0 0 1 3-3h1V6a4 4 0 0 1 4-4Z" />
                <path d="M12 6v12" />
              </svg>
            </div>
            <div className="setup-module-card__title-wrap">
              <h2>{tx('API Cloud Configuration', 'API 云端配置')}</h2>
              <p>{tx('GLM, DeepSeek, Qwen and other API-based LLM services.', 'GLM、DeepSeek、Qwen 等基于 API 的大语言服务。')}</p>
            </div>
          </div>
          <div className="setup-module-card__body">
            {renderApiCloudPanel()}
          </div>
          <div className="setup-module-card__foot">
            <button className="setup-secondary-btn" onClick={() => window.electronAPI?.openExternalUrl?.('https://open.bigmodel.cn/usercenter/apikeys')}>
              {tx('Get API Key', '获取 API Key')} ↗
            </button>
          </div>
        </div>

        {/* Module 2: Firecrawl */}
        <div className="setup-module-card">
          <div className="setup-module-card__head">
            <div className="setup-module-card__icon setup-module-card__icon--firecrawl">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ width: 22, height: 22 }}>
                <path d="M12 2c1 3 4 4 4 8a4 4 0 0 1-8 0c0-2 1-3 2-4-1 2 0 4 2 4-2-3 0-6 0-8Z" />
              </svg>
            </div>
            <div className="setup-module-card__title-wrap">
              <h2>Firecrawl</h2>
              <p>{tx('Backup scraping engine config.', '备用抓取引擎配置。')}</p>
            </div>
          </div>
          <div className="setup-module-card__body">
            <FirecrawlConfigPanel />
          </div>
          <div className="setup-module-card__foot">
            <button className="setup-secondary-btn" onClick={() => window.electronAPI?.openExternalUrl?.('https://www.firecrawl.dev/')}>
              {tx('Get API Key', '获取 API Key')} ↗
            </button>
          </div>
        </div>

        {/* Module 3: PaddleOCR */}
        <div className="setup-module-card">
          <div className="setup-module-card__head">
            <div className="setup-module-card__icon setup-module-card__icon--ocr">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ width: 22, height: 22 }}>
                <rect x="4" y="3" width="16" height="18" rx="2" />
                <path d="M8 8h8M8 12h8M8 16h5" />
              </svg>
            </div>
            <div className="setup-module-card__title-wrap">
              <h2>PaddleOCR</h2>
              <p>{tx('OCR API and label recognition.', 'OCR API 和标签识别。')}</p>
            </div>
          </div>
          <div className="setup-module-card__body">
            <PaddleOcrConfigPanel />
          </div>
          <div className="setup-module-card__foot">
            <button className="setup-secondary-btn" onClick={() => window.electronAPI?.openExternalUrl?.('https://aistudio.baidu.com/account/accessToken')}>
              {tx('Get API Key', '获取 API Key')} ↗
            </button>
          </div>
        </div>

        {/* Module 4: Ollama Configuration */}
        <div className="setup-module-card setup-module-card--wide">
          <div className="setup-module-card__head">
            <div className="setup-module-card__icon setup-module-card__icon--models">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ width: 22, height: 22 }}>
                <path d="M12 2 2 7l10 5 10-5-10-5Z" />
                <path d="m2 17 10 5 10-5M2 12l10 5 10-5" />
              </svg>
            </div>
            <div className="setup-module-card__title-wrap">
              <h2>{tx('Ollama Configuration & Models', 'Ollama 配置与模型')}</h2>
              <p>{tx('Configure Ollama local/cloud, and download/manage any Ollama model.', '配置 Ollama 本地/云端，下载和管理任意 Ollama 模型。')}</p>
            </div>
            <div className="setup-module-card__badge">
              <span className={`setup-status-dot ${config.local.running ? 'ready' : config.local.installed ? 'soft' : 'warning'}`} />
              <span className="setup-module-card__badge-text">
                {config.local.running ? tx('Running', '运行中') : config.local.installed ? tx('Installed', '已安装') : tx('Missing', '未安装')}
              </span>
            </div>
          </div>
          <div className="setup-module-card__body">
            {renderAccessPanel()}
            <OcrModelStore onModelStatusChange={() => refreshOllamaStatus()} />
          </div>
          <div className="setup-module-card__foot">
            <button className="setup-secondary-btn" onClick={() => refreshOllamaStatus()} disabled={loading}>
              {loading ? tx('Checking...', '检查中...') : tx('Refresh', '刷新')}
            </button>
            <button className="setup-secondary-btn" onClick={() => window.electronAPI?.openExternalUrl?.('https://ollama.com')}>
              {tx('Get Ollama', '获取 Ollama')} ↗
            </button>
          </div>
        </div>
      </div>

      {/* Logs panel — hidden in status mode, available in guide mode */}
      <div style={{ display: 'none' }}>
        {renderLogsPanel()}
      </div>
    </section>
  );

  const renderGuideSurface = () => (
    <section className="setup-guide-frame">
      <header className="setup-guide-header setup-panel">
        <div>
          <span className="setup-guide-eyebrow">
            {previewFirstRun ? tx('First-Run Preview', '首次引导预览') : tx('Automated Guide', '自动引导')}
          </span>
          <h1>
            {guideStep === 0
              ? tx('Pick a starting mode', '选择开始模式')
              : guideStep === 1
                ? tx('Configure the essentials', '配置必要项')
                : tx('Review and save', '确认并保存')}
          </h1>
          <p>
            {guideStep === 0
              ? tx('Cloud-only setup is enough to start using GS Bot today.', '只配置云端就足够开始使用 GS Bot。')
              : guideStep === 1
                ? tx('Use the fixed endpoints and only set the model details you need now.', '使用固定地址，只填写当前需要的模型信息。')
                : tx('Confirm the setup and enter GS Bot.', '确认配置后进入 GS Bot。')}
          </p>
        </div>
        <div className="setup-guide-progress">
          <span className={`setup-guide-progress-step ${guideStep === 0 ? 'active' : 'complete'}`}>{tx('01 Choose', '01 选择')}</span>
          <span className={`setup-guide-progress-step ${guideStep === 1 ? 'active' : guideStep > 1 ? 'complete' : ''}`}>{tx('02 Configure', '02 配置')}</span>
          <span className={`setup-guide-progress-step ${guideStep === 2 ? 'active' : ''}`}>{tx('03 Finish', '03 完成')}</span>
        </div>
      </header>

      {guideStep === 0 ? (
        <div className="setup-guide-stage compact">
          {renderGuideModePanel()}
        </div>
      ) : guideStep === 1 ? (
        <div className="setup-guide-stage compact">
          {renderGuideConfigurePanel()}
        </div>
      ) : (
        <div className="setup-guide-stage compact">
          {renderGuideReviewPanel()}
        </div>
      )}

      <div className="setup-footer setup-panel">
        <div className="setup-footer-group">
          <button className="setup-ghost-btn" onClick={isOnboarding ? skipForNow : handleClose} disabled={saving}>
            {isOnboarding
              ? tx('Skip for now', '暂时跳过')
              : previewFirstRun
                ? tx('Exit Preview', '退出预览')
                : guideStep === 0
                  ? tx('Back to Status', '返回状态页')
                  : tx('Cancel Guide', '取消引导')}
          </button>
          {guideStep > 0 && (
            <button
              className="setup-secondary-btn"
              onClick={() => {
                setAutoAdvanceGuide(false);
                setGuideStep((prev) => Math.max(prev - 1, 0));
              }}
            >
              {tx('Back', '返回')}
            </button>
          )}
        </div>
        <div className="setup-footer-group">
          {guideStep === 0 ? (
            <span className="setup-guide-footer-hint">{tx('Select a mode above to continue.', '请先在上方选择一种模式再继续。')}</span>
          ) : guideStep < 2 ? (
            <button className="setup-primary-btn" onClick={nextGuideStep}>
              {tx('Continue', '继续')}
            </button>
          ) : (
            <>
              {saveHint && <span className="setup-save-hint">{saveHint}</span>}
              <button className="setup-primary-btn" onClick={() => saveConfig()} disabled={saving || !canSave}>
                {saving ? tx('Saving...', '保存中...') : tx('Enter GS Bot', '进入 GS Bot')}
              </button>
            </>
          )}
        </div>
      </div>
    </section>
  );

  return (
    <div className={`setup-guide-shell ${overlay ? 'overlay' : ''}`}>
      {surfaceMode === 'status' ? renderStatusSurface() : renderGuideSurface()}
    </div>
  );
}

export default SetupGuide;

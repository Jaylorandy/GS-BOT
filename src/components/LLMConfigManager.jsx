import React, { useState, useEffect } from 'react';
import { dispatchLLMConfigUpdate } from '../utils/llmConfigSync';
import { buildDefaultOcrConfig, isEmbeddedPaddleOcrEngine, mergeOcrConfig } from '../utils/ocrEngines';
import './LLMConfigManager.css';

const LOCAL_DEEPSEEK_OCR_MODEL = 'deepseek-ocr:3b';
const DEFAULT_OCR_CONFIG = buildDefaultOcrConfig();

const POPULAR_OCR_MODELS = [
  { name: 'deepseek-ocr:3b', desc: 'DeepSeek OCR 3B (推荐)' },
  { name: 'deepseek-ocr:7b', desc: 'DeepSeek OCR 7B (更强)' },
  { name: 'paddleocr-vl:1.5', desc: 'PaddleOCR-VL 1.5' },
  { name: 'paddleocr-vl:2.0', desc: 'PaddleOCR-VL 2.0' },
];

function normalizeModelName(modelName = '') {
  return String(modelName || '').trim().toLowerCase();
}

function isLocalDeepseekOcrModel(modelName = '') {
  const normalized = normalizeModelName(modelName);
  const family = normalizeModelName(LOCAL_DEEPSEEK_OCR_MODEL).split(':')[0];
  return normalized === family || normalized.startsWith(`${family}:`);
}

function isOllamaOcrModel(modelName = '') {
  const normalized = normalizeModelName(modelName);
  if (!normalized) return false;
  const ocrFamilies = ['deepseek-ocr', 'paddleocr-vl', 'paddle-ocr', 'ocr'];
  const family = normalized.split(':')[0];
  return ocrFamilies.some(f => family === f || family.startsWith(f));
}

function LLMConfigManager() {
  const [config, setConfig] = useState({
    mode: 'local',
    local: { enabled: true, baseUrl: 'http://localhost:11434', model: '', installed: false, running: false, installedModels: [] },
    cloud: { enabled: false, baseUrl: '', model: '', apiKey: '', availableModels: [] },
    apiCloud: { enabled: false, activePresetId: 'glm', presets: [] },
    hybrid: { enabled: false, extractionEndpoint: 'cloud', analysisEndpoint: 'local' },
    ocr: DEFAULT_OCR_CONFIG,
  });
  const [apiCloudTestStatus, setApiCloudTestStatus] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testStatus, setTestStatus] = useState({});
  const [logs, setLogs] = useState([]);
  const [downloadingModels, setDownloadingModels] = useState({});
  const [downloadProgress, setDownloadProgress] = useState({});
  const [customOcrModel, setCustomOcrModel] = useState('');

  useEffect(() => {
    loadConfiguration();
  }, []);

  const addLog = (msg, type = 'info') => {
    setLogs(prev => [...prev.slice(-20), { time: new Date().toLocaleTimeString(), msg, type }]);
  };

  const loadConfiguration = async () => {
    setLoading(true);
    try {
      if (window.electronAPI?.loadLLMConfig) {
        const cfg = await window.electronAPI.loadLLMConfig();
        if (cfg && cfg.mode) {
          setConfig(cfg);
          addLog('Configuration loaded successfully.', 'success');
        }
      }
    } catch (e) {
      addLog(`Failed to load configuration: ${e.message}`, 'error');
    } finally {
      setLoading(false);
    }
  };

  const saveConfiguration = async () => {
    setSaving(true);
    try {
      if (window.electronAPI?.saveLLMConfig) {
        await window.electronAPI.saveLLMConfig(config);
        addLog('Configuration saved successfully.', 'success');
      }
    } catch (e) {
      addLog(`Failed to save configuration: ${e.message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async (type) => {
    const url = type === 'local' ? config.local.baseUrl : config.cloud.baseUrl;
    const apiKey = type === 'local' ? '' : config.cloud.apiKey;
    
    setTestStatus(prev => ({ ...prev, [type]: 'testing' }));
    addLog(`Testing the ${type === 'local' ? 'local' : 'cloud'} connection...`, 'info');

    try {
      if (window.electronAPI?.testLLMConnection) {
        const result = await window.electronAPI.testLLMConnection({
          baseUrl: url,
          apiKey: apiKey,
        });
        
        if (result.success) {
          setTestStatus(prev => ({ ...prev, [type]: 'connected' }));
          addLog(`${type === 'local' ? 'Local' : 'Cloud'} connection successful. Found ${result.models?.length || 0} models.`, 'success');
          
          if (result.models?.length > 0) {
            setConfig(prev => ({
              ...prev,
              [type]: { 
                ...prev[type], 
                availableModels: result.models,
                model: result.models.length === 1 ? result.models[0] : (prev[type].model || ''),
              },
            }));
          }
        } else {
          setTestStatus(prev => ({ ...prev, [type]: 'failed' }));
          addLog(`${type === 'local' ? 'Local' : 'Cloud'} connection failed: ${result.error}`, 'error');
        }
      }
    } catch (e) {
      setTestStatus(prev => ({ ...prev, [type]: 'failed' }));
      addLog(`Connection test failed: ${e.message}`, 'error');
    }
  };

  const installOllama = async () => {
    addLog('Installing Ollama...', 'info');
    try {
      if (window.electronAPI?.installOllama) {
        const result = await window.electronAPI.installOllama();
        if (result.success) {
          addLog(result.message || 'Ollama installed successfully.', 'success');
          if (!result.manual) {
            checkOllamaServer();
          }
        } else {
          addLog(`Install failed: ${result.error}`, 'error');
        }
      }
    } catch (e) {
      addLog(`Install failed: ${e.message}`, 'error');
    }
  };

  const startOllamaServer = async () => {
    addLog('Starting the Ollama service...', 'info');
    try {
      if (window.electronAPI?.startOllamaServer) {
        const result = await window.electronAPI.startOllamaServer();
        if (result.success) {
          addLog('Ollama service started.', 'success');
          checkOllamaServer();
        } else {
          addLog(`Startup failed: ${result.error}`, 'error');
        }
      }
    } catch (e) {
      addLog(`Startup failed: ${e.message}`, 'error');
    }
  };

  const downloadVisionModel = async (modelName) => {
    if (!config.local.running) {
      addLog('Start the Ollama service before downloading models.', 'error');
      return;
    }
    
    setDownloadingModels(prev => ({ ...prev, [modelName]: true }));
    setDownloadProgress(prev => ({ ...prev, [modelName]: 0 }));
    addLog(`Downloading model ${modelName}...`, 'info');
    
    try {
      if (window.electronAPI?.pullOllamaModel) {
        window.electronAPI.pullOllamaModel(
          modelName,
          (progress, status) => {
            setDownloadProgress(prev => ({ ...prev, [modelName]: progress }));
            if (status && status !== 'Complete') {
              addLog(`${modelName}: ${status}`, 'info');
            }
          }
        );
        
        const checkInterval = setInterval(async () => {
          const status = await window.electronAPI.checkOllamaStatus?.();
          const isOcrModel = isOllamaOcrModel(modelName);
          const installedName = (status?.models || []).find((entry) => {
            const entryNormalized = normalizeModelName(entry);
            const wantedNormalized = normalizeModelName(modelName);
            if (isOcrModel || isLocalDeepseekOcrModel(modelName)) {
              const wantedFamily = wantedNormalized.split(':')[0];
              return entryNormalized === wantedNormalized || entryNormalized.startsWith(`${wantedFamily}:`);
            }
            return entryNormalized === wantedNormalized;
          });
          if (installedName) {
            clearInterval(checkInterval);
            setDownloadingModels(prev => ({ ...prev, [modelName]: false }));
            let nextConfigSnapshot = null;
            setConfig(prev => {
              const nextOcrConfig = mergeOcrConfig({
                ...(prev.ocr || {}),
                deepseekLocal: {
                  ...DEFAULT_OCR_CONFIG.deepseekLocal,
                  ...((prev.ocr && prev.ocr.deepseekLocal) || {}),
                  baseUrl: prev.ocr?.deepseekLocal?.baseUrl || prev.local?.baseUrl || DEFAULT_OCR_CONFIG.deepseekLocal.baseUrl,
                  model: installedName,
                },
              });

              const shouldConfigureAsOcr = isLocalDeepseekOcrModel(installedName) || isOcrModel;
              if (shouldConfigureAsOcr) {
                nextOcrConfig.engine = isEmbeddedPaddleOcrEngine(nextOcrConfig.engine) ? 'deepseek-local' : nextOcrConfig.engine;
                nextOcrConfig.deepseekLocal = {
                  ...nextOcrConfig.deepseekLocal,
                  enabled: true,
                  model: installedName,
                };
              }

              nextConfigSnapshot = {
                ...prev,
                local: {
                  ...prev.local,
                  installed: Boolean(status?.installed),
                  running: Boolean(status?.running),
                  installedModels: status.models || [],
                  availableModels: status.models || [],
                  model: prev.local.model || installedName,
                },
                ocr: nextOcrConfig,
              };

              return nextConfigSnapshot;
            });
            if (nextConfigSnapshot && window.electronAPI?.saveLLMConfig) {
              await window.electronAPI.saveLLMConfig(nextConfigSnapshot);
              dispatchLLMConfigUpdate(nextConfigSnapshot);
            }
            addLog(`Model ${installedName} downloaded successfully.`, 'success');
            if (isLocalDeepseekOcrModel(installedName) || isOcrModel) {
              addLog(`OCR model ${installedName} is now configured for local Ollama use in Image Organizer, PPT, and Product Analysis.`, 'success');
            }
          }
        }, 2000);
        
        setTimeout(() => {
          clearInterval(checkInterval);
          setDownloadingModels(prev => ({ ...prev, [modelName]: false }));
        }, 30 * 60 * 1000);
      }
    } catch (e) {
      setDownloadingModels(prev => ({ ...prev, [modelName]: false }));
      addLog(`Download failed: ${e.message}`, 'error');
    }
  };

  const checkOllamaServer = async () => {
    addLog('Checking Ollama status...', 'info');
    try {
      if (window.electronAPI?.checkOllamaStatus) {
        const status = await window.electronAPI.checkOllamaStatus();
        setConfig(prev => ({
          ...prev,
          local: {
            ...prev.local,
            installed: status.installed,
            running: status.running,
            installedModels: status.models || [],
            availableModels: status.models || [],
          },
        }));
        addLog(`Ollama ${status.installed ? 'installed' : 'not installed'}, ${status.running ? 'running' : 'stopped'}.`, 'info');
      }
    } catch (e) {
      addLog(`Status check failed: ${e.message}`, 'error');
    }
  };

  const handleModeChange = (mode) => {
    setConfig(prev => ({ ...prev, mode }));
    addLog(`Switched to ${mode} mode.`, 'info');
  };

  const handlePresetChange = (presetId) => {
    setConfig(prev => ({
      ...prev,
      apiCloud: { ...prev.apiCloud, activePresetId: presetId },
    }));
  };

  const handlePresetFieldChange = (presetId, field, value) => {
    setConfig(prev => ({
      ...prev,
      apiCloud: {
        ...prev.apiCloud,
        presets: prev.apiCloud.presets.map(p =>
          p.id === presetId ? { ...p, [field]: value } : p
        ),
      },
    }));
  };

  const testApiCloudConnection = async () => {
    const activePreset = (config.apiCloud?.presets || []).find(p => p.id === config.apiCloud?.activePresetId);
    if (!activePreset) return;

    const presetId = activePreset.id;
    setApiCloudTestStatus(prev => ({ ...prev, [presetId]: 'testing' }));
    addLog(`Testing ${activePreset.name} connection...`, 'info');

    try {
      if (window.electronAPI?.testApiCloudConnection) {
        const result = await window.electronAPI.testApiCloudConnection({
          baseUrl: activePreset.baseUrl,
          model: activePreset.model,
          apiKey: activePreset.apiKey,
        });

        if (result.success) {
          setApiCloudTestStatus(prev => ({ ...prev, [presetId]: 'connected' }));
          addLog(`${activePreset.name} connection successful. Found ${result.models?.length || 0} models.`, 'success');

          if (result.models?.length > 0) {
            setConfig(prev => ({
              ...prev,
              apiCloud: {
                ...prev.apiCloud,
                presets: prev.apiCloud.presets.map(p =>
                  p.id === presetId ? { ...p, availableModels: result.models } : p
                ),
              },
            }));
          }
        } else {
          setApiCloudTestStatus(prev => ({ ...prev, [presetId]: 'failed' }));
          addLog(`${activePreset.name} connection failed: ${result.error}`, 'error');
        }
      }
    } catch (e) {
      setApiCloudTestStatus(prev => ({ ...prev, [presetId]: 'failed' }));
      addLog(`Connection test failed: ${e.message}`, 'error');
    }
  };

  if (loading) {
    return (
      <div className="llm-config-container">
        <div className="llm-config-loading">Loading configuration...</div>
      </div>
    );
  }

  return (
    <div className="llm-config-container">
      <div className="llm-config-header">
        <h2>LLM Configuration</h2>
        <p>Manage local and cloud routing with simplified recommendations for style-description work.</p>
      </div>

      <div className="llm-config-content">
        <div className="config-section mode-section">
          <h3>Choose mode</h3>
          <div className="mode-options mode-options-4">
            <label className={`mode-card ${config.mode === 'local' ? 'active' : ''}`}>
              <input
                type="radio"
                name="mode"
                value="local"
                checked={config.mode === 'local'}
                onChange={() => handleModeChange('local')}
              />
              <div className="mode-icon">💻</div>
              <div className="mode-info">
                <span className="mode-name">Ollama本地</span>
                <span className="mode-desc">完全离线，由本机 Ollama 驱动。</span>
              </div>
            </label>
            
            <label className={`mode-card ${config.mode === 'cloud' ? 'active' : ''}`}>
              <input
                type="radio"
                name="mode"
                value="cloud"
                checked={config.mode === 'cloud'}
                onChange={() => handleModeChange('cloud')}
              />
              <div className="mode-icon">☁️</div>
              <div className="mode-info">
                <span className="mode-name">Ollama云端</span>
                <span className="mode-desc">使用远程 Ollama 兼容 API 端点。</span>
              </div>
            </label>
            
            <label className={`mode-card ${config.mode === 'apiCloud' ? 'active' : ''}`}>
              <input
                type="radio"
                name="mode"
                value="apiCloud"
                checked={config.mode === 'apiCloud'}
                onChange={() => handleModeChange('apiCloud')}
              />
              <div className="mode-icon">🔑</div>
              <div className="mode-info">
                <span className="mode-name">API云端</span>
                <span className="mode-desc">使用通用API模型（GLM、DeepSeek等）。</span>
              </div>
            </label>
            
            <label className={`mode-card ${config.mode === 'hybrid' ? 'active' : ''}`}>
              <input
                type="radio"
                name="mode"
                value="hybrid"
                checked={config.mode === 'hybrid'}
                onChange={() => handleModeChange('hybrid')}
              />
              <div className="mode-icon">⚡</div>
              <div className="mode-info">
                <span className="mode-name">混合模式</span>
                <span className="mode-desc">不同阶段使用不同端点，平衡配置。</span>
              </div>
            </label>
          </div>
        </div>

        {(config.mode === 'local' || config.mode === 'hybrid') && (
          <div className="config-section">
            <div className="section-header">
              <h3>💻 Local Ollama</h3>
            </div>
            
            <div className="input-row">
              <div className="input-group flex-2">
                <label>Local URL</label>
                <input
                  type="text"
                  value={config.local.baseUrl}
                  onChange={(e) => setConfig(prev => ({ ...prev, local: { ...prev.local, baseUrl: e.target.value } }))}
                  placeholder="http://localhost:11434"
                />
              </div>
              <div className="input-group flex-1">
                <label>Actions</label>
                <div className="button-group">
                  <button onClick={checkOllamaServer} className="action-btn">Check</button>
                  {!config.local?.installed && (
                    <button onClick={installOllama} className="action-btn primary">Install</button>
                  )}
                  {config.local?.installed && !config.local?.running && (
                    <button onClick={startOllamaServer} className="action-btn">Start</button>
                  )}
                </div>
              </div>
            </div>

            <div className="input-group">
              <label>Select model</label>
              <select
                value={config.local.model}
                onChange={(e) => setConfig(prev => ({ ...prev, local: { ...prev.local, model: e.target.value } }))}
              >
                <option value="">Choose a model...</option>
                {(config.local.installedModels || config.local.availableModels || []).map(m => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
            <button
              onClick={() => testConnection('local')}
              disabled={testStatus.local === 'testing'}
              className={`test-btn ${testStatus.local}`}
            >
              {testStatus.local === 'testing' ? 'Testing...' :
               testStatus.local === 'connected' ? 'Connected ✓' :
               testStatus.local === 'failed' ? 'Connection failed ✗' : 'Test connection'}
            </button>

            <div className="section-desc" style={{ marginTop: '0.85rem' }}>
              Recommended local style-description model pairing: `GR3-Fabric + Moondream`
            </div>
          </div>
        )}

        <div className="config-section">
          <div className="section-header">
            <h3>🔍 Ollama OCR Models</h3>
          </div>
          <p className="section-desc">
            Download and manage OCR models via Ollama. Enter any Ollama OCR model name or select from popular ones.
            {!config.local?.installed && (
              <span style={{ display: 'block', marginTop: '0.5rem', color: '#e74c3c' }}>
                ⚠️ Ollama is not installed. Please install Ollama first to download OCR models.
              </span>
            )}
            {config.local?.installed && !config.local?.running && (
              <span style={{ display: 'block', marginTop: '0.5rem', color: '#f39c12' }}>
                ⚠️ Ollama service is not running. Click "Start" above to start the service before downloading models.
              </span>
            )}
          </p>

          <div className="input-row">
            <div className="input-group flex-2">
              <label>Custom OCR model</label>
              <input
                type="text"
                value={customOcrModel}
                onChange={(e) => setCustomOcrModel(e.target.value)}
                placeholder="e.g. deepseek-ocr:3b, paddleocr-vl:2.0"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && customOcrModel.trim()) {
                    downloadVisionModel(customOcrModel.trim());
                    setCustomOcrModel('');
                  }
                }}
              />
            </div>
            <div className="input-group flex-1">
              <label>Action</label>
              <div className="button-group">
                <button
                  onClick={() => {
                    if (customOcrModel.trim()) {
                      downloadVisionModel(customOcrModel.trim());
                      setCustomOcrModel('');
                    }
                  }}
                  disabled={!customOcrModel.trim() || !config.local.running || downloadingModels[customOcrModel]}
                  className="action-btn primary"
                >
                  {downloadingModels[customOcrModel] ? 'Downloading...' : 'Download'}
                </button>
              </div>
            </div>
          </div>

          <div className="input-group" style={{ marginTop: '0.5rem' }}>
            <label>Popular OCR models</label>
            <div className="button-group" style={{ flexWrap: 'wrap', gap: '0.5rem' }}>
              {POPULAR_OCR_MODELS.map((model) => {
                const isInstalled = (config.local.installedModels || []).some(
                  (m) => normalizeModelName(m) === normalizeModelName(model.name) ||
                          normalizeModelName(m).startsWith(`${normalizeModelName(model.name).split(':')[0]}:`)
                );
                const isDownloading = downloadingModels[model.name];
                return (
                  <button
                    key={model.name}
                    onClick={() => downloadVisionModel(model.name)}
                    disabled={!config.local.running || isDownloading}
                    className={`action-btn ${isInstalled ? 'installed' : ''}`}
                    title={model.desc}
                  >
                    {isDownloading
                      ? `${downloadProgress[model.name] || 0}%`
                      : isInstalled
                        ? `✓ ${model.name}`
                        : model.name}
                  </button>
                );
              })}
            </div>
          </div>

          {config.ocr?.deepseekLocal?.model && (
            <div className="section-desc" style={{ marginTop: '0.85rem' }}>
              Current OCR model configured: <code>{config.ocr.deepseekLocal.model}</code>
            </div>
          )}
        </div>

        {(config.mode === 'cloud' || config.mode === 'hybrid') && (
          <div className="config-section">
            <h3>☁️ Cloud Ollama</h3>
            
            <div className="input-group">
              <label>Cloud URL</label>
              <input
                type="text"
                value={config.cloud.baseUrl}
                onChange={(e) => setConfig(prev => ({ ...prev, cloud: { ...prev.cloud, baseUrl: e.target.value } }))}
                placeholder="https://api.ollama.com"
              />
            </div>

            <div className="input-group">
              <label>API Key</label>
              <input
                type="password"
                value={config.cloud.apiKey}
                onChange={(e) => setConfig(prev => ({ ...prev, cloud: { ...prev.cloud, apiKey: e.target.value } }))}
                placeholder="your-api-key"
              />
            </div>

            <button
              onClick={() => testConnection('cloud')}
              disabled={testStatus.cloud === 'testing'}
              className={`test-btn ${testStatus.cloud}`}
            >
              {testStatus.cloud === 'testing' ? 'Testing...' :
               testStatus.cloud === 'connected' ? 'Connected ✓' :
               testStatus.cloud === 'failed' ? 'Connection failed ✗' : 'Test connection and fetch models'}
            </button>

            {testStatus.cloud === 'connected' && config.cloud.availableModels?.length > 0 && (
              <div className="input-group" style={{ marginTop: '1rem' }}>
                <label>Select model</label>
                <select
                  value={config.cloud.model}
                  onChange={(e) => setConfig(prev => ({ ...prev, cloud: { ...prev.cloud, model: e.target.value } }))}
                >
                  <option value="">Choose a model...</option>
                  {config.cloud.availableModels.map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
            )}

            {testStatus.cloud === 'connected' && !config.cloud.availableModels?.length && (
              <div className="input-group" style={{ marginTop: '1rem' }}>
                <label>Model name (manual)</label>
                <input
                  type="text"
                  value={config.cloud.model}
                  onChange={(e) => setConfig(prev => ({ ...prev, cloud: { ...prev.cloud, model: e.target.value } }))}
                  placeholder="qwen3-vl:235b"
                />
              </div>
            )}

            <div className="section-desc" style={{ marginTop: '0.85rem' }}>
              Recommended cloud style-description model: `Qwen3 VL 235B`
            </div>
          </div>
        )}

        {(config.mode === 'apiCloud' || config.mode === 'hybrid') && (
          <div className="config-section">
            <h3>🔑 API Cloud (GLM / DeepSeek / etc.)</h3>
            <p className="section-desc">使用通用API模型服务，支持智谱AI、DeepSeek、通义千问等。</p>

            <div className="input-group">
              <label>选择服务提供商</label>
              <select
                value={config.apiCloud?.activePresetId || 'glm'}
                onChange={(e) => handlePresetChange(e.target.value)}
              >
                {(config.apiCloud?.presets || []).map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>

            {(() => {
              const activePreset = (config.apiCloud?.presets || []).find(p => p.id === config.apiCloud?.activePresetId);
              if (!activePreset) return null;
              const testState = apiCloudTestStatus[activePreset.id] || '';

              return (
                <>
                  <div className="input-group">
                    <label>Base URL</label>
                    <input
                      type="text"
                      value={activePreset.baseUrl}
                      onChange={(e) => handlePresetFieldChange(activePreset.id, 'baseUrl', e.target.value)}
                      placeholder="https://api.example.com/v1"
                    />
                  </div>

                  <div className="input-group">
                    <label>API Key</label>
                    <input
                      type="password"
                      value={activePreset.apiKey}
                      onChange={(e) => handlePresetFieldChange(activePreset.id, 'apiKey', e.target.value)}
                      placeholder="sk-xxxxxxxxxxxxxxxx"
                    />
                  </div>

                  <div className="input-group">
                    <label>Model</label>
                    <input
                      type="text"
                      value={activePreset.model}
                      onChange={(e) => handlePresetFieldChange(activePreset.id, 'model', e.target.value)}
                      placeholder="e.g. glm-4-plus, deepseek-chat"
                    />
                  </div>

                  {activePreset.availableModels?.length > 0 && (
                    <div className="input-group">
                      <label>或选择可用模型</label>
                      <select
                        value={activePreset.model}
                        onChange={(e) => handlePresetFieldChange(activePreset.id, 'model', e.target.value)}
                      >
                        <option value="">Choose a model...</option>
                        {activePreset.availableModels.map(m => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  <button
                    onClick={testApiCloudConnection}
                    disabled={testState === 'testing'}
                    className={`test-btn ${testState}`}
                  >
                    {testState === 'testing' ? 'Testing...' :
                     testState === 'connected' ? 'Connected ✓' :
                     testState === 'failed' ? 'Connection failed ✗' : 'Test connection and fetch models'}
                  </button>
                </>
              );
            })()}
          </div>
        )}

        {config.mode === 'hybrid' && (
          <div className="config-section hybrid-section">
            <h3>⚡ Hybrid routing</h3>
            <p className="section-desc">Choose separate endpoints for extraction and analysis.</p>
            
            <div className="hybrid-row">
              <div className="hybrid-item">
                <label>Extraction stage</label>
                <select
                  value={config.hybrid.extractionEndpoint}
                  onChange={(e) => setConfig(prev => ({ ...prev, hybrid: { ...prev.hybrid, extractionEndpoint: e.target.value } }))}
                >
                  <option value="cloud">☁️ Ollama Cloud</option>
                  <option value="apiCloud">🔑 API Cloud</option>
                  <option value="local">💻 Local</option>
                </select>
              </div>

              <div className="hybrid-arrow">→</div>

              <div className="hybrid-item">
                <label>Report analysis stage</label>
                <select
                  value={config.hybrid.analysisEndpoint}
                  onChange={(e) => setConfig(prev => ({ ...prev, hybrid: { ...prev.hybrid, analysisEndpoint: e.target.value } }))}
                >
                  <option value="local">💻 Local (more stable)</option>
                  <option value="cloud">☁️ Ollama Cloud</option>
                  <option value="apiCloud">🔑 API Cloud</option>
                </select>
              </div>
            </div>
          </div>
        )}

        <div className="config-footer">
          <button onClick={saveConfiguration} disabled={saving} className="save-btn">
            {saving ? 'Saving...' : 'Save configuration'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default LLMConfigManager;

import React, { useEffect, useState, useCallback, useRef } from 'react';

const PLATFORM_LABELS = { win32: 'Windows', darwin: 'macOS' };

function tx(en, zh) {
  try {
    const lang = (typeof navigator !== 'undefined' && navigator.language) || 'en';
    return String(lang || '').startsWith('zh') ? zh : en;
  } catch {
    return en;
  }
}

function formatSize(bytes) {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function normalizeModelName(modelName = '') {
  return String(modelName || '').trim().toLowerCase();
}

function isOllamaOcrModel(modelName = '') {
  const normalized = normalizeModelName(modelName);
  if (!normalized) return false;
  const ocrFamilies = ['deepseek-ocr', 'paddleocr-vl', 'paddle-ocr', 'ocr'];
  const family = normalized.split(':')[0];
  return ocrFamilies.some(f => family === f || family.startsWith(f));
}

const POPULAR_OCR_MODELS = [
  { name: 'deepseek-ocr:3b', desc: 'DeepSeek OCR 3B (推荐)' },
  { name: 'deepseek-ocr:7b', desc: 'DeepSeek OCR 7B (更强)' },
  { name: 'paddleocr-vl:1.5', desc: 'PaddleOCR-VL 1.5' },
  { name: 'paddleocr-vl:2.0', desc: 'PaddleOCR-VL 2.0' },
];

const POPULAR_LLM_MODELS = [
  { name: 'qwen2.5:7b', desc: 'Qwen 2.5 7B (推荐通用模型)' },
  { name: 'qwen2.5:14b', desc: 'Qwen 2.5 14B (更强)' },
  { name: 'llama3.1:8b', desc: 'Llama 3.1 8B' },
  { name: 'deepseek-r1:7b', desc: 'DeepSeek R1 7B (推理模型)' },
];

const DEFAULT_DEEPSEEK_LOCAL_MODEL = 'deepseek-ocr:3b';

export default function OcrModelStore({ onModelStatusChange }) {
  const [catalog, setCatalog] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState('');
  const [downloading, setDownloading] = useState({});
  const [downloadProgress, setDownloadProgress] = useState({});
  const [downloadStatus, setDownloadStatus] = useState({});
  const [deleting, setDeleting] = useState({});
  const cleanupRef = useRef({});

  // Ollama related state
  const [ollamaStatus, setOllamaStatus] = useState({ installed: false, running: false, models: [] });
  const [customOcrModel, setCustomOcrModel] = useState('');
  const [ollamaDownloading, setOllamaDownloading] = useState({});
  const [ollamaProgress, setOllamaProgress] = useState({});

  const api = typeof window !== 'undefined' ? window.electronAPI : null;

  // Refresh Ollama status
  const refreshOllamaStatus = useCallback(async () => {
    if (!api) return;
    try {
      const status = await api.checkOllamaStatus?.();
      if (status) setOllamaStatus(status);
    } catch { /* ignore */ }
  }, [api]);

  useEffect(() => {
    refreshOllamaStatus();
  }, [refreshOllamaStatus]);

  // Pull Ollama model
  const handlePullOllamaModel = useCallback(async (modelName) => {
    if (!api || !modelName) return;
    const trimmed = modelName.trim();
    if (!trimmed) return;

    setOllamaDownloading(prev => ({ ...prev, [trimmed]: true }));
    setOllamaProgress(prev => ({ ...prev, [trimmed]: 0 }));

    try {
      const channel = `ollama-pull-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await api.pullOllamaModel?.(trimmed, (progress, status) => {
        if (typeof progress === 'number') {
          setOllamaProgress(prev => ({ ...prev, [trimmed]: progress }));
        }
      });

      // Poll for completion
      const checkInterval = setInterval(async () => {
        const status = await api.checkOllamaStatus?.();
        if (status) setOllamaStatus(status);
        const installedName = (status?.models || []).find((entry) => {
          const entryNormalized = normalizeModelName(entry);
          const wantedNormalized = normalizeModelName(trimmed);
          const wantedFamily = wantedNormalized.split(':')[0];
          return entryNormalized === wantedNormalized || entryNormalized.startsWith(`${wantedFamily}:`);
        });
        if (installedName) {
          clearInterval(checkInterval);
          setOllamaDownloading(prev => ({ ...prev, [trimmed]: false }));
          setOllamaProgress(prev => ({ ...prev, [trimmed]: 100 }));
          onModelStatusChange?.();
        }
      }, 2000);

      // Timeout after 10 minutes
      setTimeout(() => clearInterval(checkInterval), 600000);
    } catch (err) {
      setOllamaDownloading(prev => ({ ...prev, [trimmed]: false }));
      alert(err.message || 'Failed to pull model');
    }
  }, [api, onModelStatusChange]);

  // Load local catalog (offline first, then sync online)
  const loadCatalog = useCallback(async (online = false) => {
    if (!api) return;

    try {
      if (online) {
        setSyncing(true);
        setSyncError('');
        const result = await api.ocrSyncCatalog();
        if (result?.success && result.data?.models) {
          setCatalog(result.data.models);
          setSyncError('');
        } else {
          setSyncError(result?.error || 'Sync failed');
        }
      }
    } catch (err) {
      setSyncError(err.message || 'Sync failed');
    } finally {
      setSyncing(false);
    }

    // Always fall back to local if sync failed
    if (!catalog || online === false) {
      try {
        const localResult = await api.ocrListCatalog();
        if (localResult?.success && localResult.models) {
          setCatalog(localResult.models);
        }
      } catch { /* ignore */ }
    }
  }, [api, catalog]);

  useEffect(() => {
    loadCatalog(false);
  }, []);

  // Download a model
  const handleDownload = useCallback(async (modelId) => {
    if (!api) return;

    setDownloading((prev) => ({ ...prev, [modelId]: true }));
    setDownloadProgress((prev) => ({ ...prev, [modelId]: 0 }));
    setDownloadStatus((prev) => ({ ...prev, [modelId]: tx('Starting…', '开始下载…') }));

    // Clean up any previous listener for this model
    if (cleanupRef.current[modelId]) {
      cleanupRef.current[modelId]();
    }

    try {
      const result = await api.ocrDownloadModel(modelId, (data) => {
        setDownloadProgress((prev) => ({ ...prev, [modelId]: data.progress ?? 0 }));
        setDownloadStatus((prev) => ({ ...prev, [modelId]: data.status || '' }));

        // Handle completion from progress callback
        if (data.phase === 'complete') {
          setDownloading((prev) => ({ ...prev, [modelId]: false }));
          setDownloadStatus((prev) => ({ ...prev, [modelId]: tx('Ready', '就绪') }));
        }
        if (data.phase === 'error') {
          setDownloading((prev) => ({ ...prev, [modelId]: false }));
          setDownloadStatus((prev) => ({ ...prev, [modelId]: data.status || tx('Download failed', '下载失败') }));
        }
      });

      cleanupRef.current[modelId] = result.cleanup;

      if (result?.success) {
        // Refresh catalog to show updated state
        await loadCatalog(false);
        onModelStatusChange?.();
      } else {
        setDownloading((prev) => ({ ...prev, [modelId]: false }));
        setDownloadStatus((prev) => ({ ...prev, [modelId]: result?.error || tx('Download failed', '下载失败') }));
        // Still refresh catalog to update local status
        await loadCatalog(false);
      }
    } catch (err) {
      setDownloading((prev) => ({ ...prev, [modelId]: false }));
      setDownloadStatus((prev) => ({ ...prev, [modelId]: err.message }));
    }
  }, [api, loadCatalog, onModelStatusChange]);

  // Delete a model
  const handleDelete = useCallback(async (modelId) => {
    if (!api) return;

    setDeleting((prev) => ({ ...prev, [modelId]: true }));
    try {
      const result = await api.ocrDeleteModel(modelId);
      if (result?.success) {
        await loadCatalog(false);
        onModelStatusChange?.();
      } else {
        alert(result?.error || tx('Delete failed', '删除失败'));
      }
    } catch (err) {
      alert(err.message);
    } finally {
      setDeleting((prev) => ({ ...prev, [modelId]: false }));
    }
  }, [api, loadCatalog, onModelStatusChange]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      Object.values(cleanupRef.current).forEach((fn) => {
        try { fn(); } catch { /* ignore */ }
      });
    };
  }, []);

  if (!api) {
    return (
      <section className="setup-panel">
        <p>{tx('Ollama model manager requires the Electron API.', 'Ollama 模型管理需要 Electron API。')}</p>
      </section>
    );
  }

  const installedModels = ollamaStatus.models || [];
  const isInstalled = (modelName) => {
    const normalized = normalizeModelName(modelName);
    const family = normalized.split(':')[0];
    return installedModels.some(m => {
      const mn = normalizeModelName(m);
      return mn === normalized || mn.startsWith(`${family}:`);
    });
  };

  const installedOcrModels = installedModels.filter(m => isOllamaOcrModel(m));
  const installedOtherModels = installedModels.filter(m => !isOllamaOcrModel(m));

  return (
    <section className="setup-panel">
      <div className="setup-panel-header">
        <div>
          <h2>{tx('Ollama Models', 'Ollama 模型')}</h2>
          <p>
            {tx(
              'Download and manage any Ollama model. Enter any model name or select from popular ones.',
              '通过 Ollama 下载和管理任意模型。输入任意模型名或从常用模型中选择。',
            )}
          </p>
        </div>
        <div className="setup-panel-actions">
          <span style={{ fontSize: '0.8rem', color: ollamaStatus.running ? 'var(--color-success, #4caf50)' : 'var(--text-warning, #c90)' }}>
            {ollamaStatus.installed
              ? ollamaStatus.running
                ? tx('Ollama: Running', 'Ollama: 运行中')
                : tx('Ollama: Not running', 'Ollama: 未运行')
              : tx('Ollama: Not installed', 'Ollama: 未安装')}
          </span>
          <button
            className="setup-secondary-btn"
            onClick={refreshOllamaStatus}
          >
            {tx('Refresh', '刷新')}
          </button>
        </div>
      </div>

      {!ollamaStatus.installed && (
        <div style={{ margin: '12px 0', padding: '12px', borderRadius: '8px', background: 'rgba(231,76,60,0.1)', border: '1px solid rgba(231,76,60,0.3)', fontSize: '0.85rem', color: 'var(--color-error, #e53935)' }}>
          {tx(
            'Ollama is not installed. Please install Ollama first before downloading models.',
            'Ollama 未安装。请先安装 Ollama 才能下载模型。',
          )}
        </div>
      )}

      {ollamaStatus.installed && !ollamaStatus.running && (
        <div style={{ margin: '12px 0', padding: '12px', borderRadius: '8px', background: 'rgba(243,156,18,0.1)', border: '1px solid rgba(243,156,18,0.3)', fontSize: '0.85rem', color: 'var(--text-warning, #c90)' }}>
          {tx(
            'Ollama service is not running. Start Ollama first before downloading models.',
            'Ollama 服务未运行。在下载模型前请先启动 Ollama。',
          )}
        </div>
      )}

      {/* Custom model input */}
      <div style={{ margin: '16px 0', padding: '16px', borderRadius: '10px', background: 'rgba(255,255,255,0.04)', border: '1px solid var(--glass-border, rgba(255,255,255,0.1))' }}>
        <h3 style={{ marginTop: 0, marginBottom: '12px', fontSize: '1rem' }}>
          {tx('Download Custom Model', '下载自定义模型')}
        </h3>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <input
            type="text"
            value={customOcrModel}
            onChange={(e) => setCustomOcrModel(e.target.value)}
            placeholder={tx('e.g. qwen2.5:7b, deepseek-ocr:3b', '例如：qwen2.5:7b, deepseek-ocr:3b')}
            style={{
              flex: '1 1 280px',
              padding: '10px 12px',
              borderRadius: '8px',
              border: '1px solid var(--glass-border, rgba(255,255,255,0.15))',
              background: 'rgba(0,0,0,0.2)',
              color: 'var(--text-primary, #fff)',
              fontSize: '0.9rem',
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && customOcrModel.trim()) {
                handlePullOllamaModel(customOcrModel.trim());
                setCustomOcrModel('');
              }
            }}
          />
          <button
            onClick={() => {
              if (customOcrModel.trim()) {
                handlePullOllamaModel(customOcrModel.trim());
                setCustomOcrModel('');
              }
            }}
            disabled={!customOcrModel.trim() || !ollamaStatus.running || ollamaDownloading[customOcrModel.trim()]}
            style={{
              padding: '10px 20px',
              borderRadius: '8px',
              border: 'none',
              background: ollamaStatus.running ? 'var(--bg-accent, #007aff)' : 'var(--bg-disabled, #555)',
              color: '#fff',
              fontSize: '0.9rem',
              cursor: !ollamaStatus.running ? 'not-allowed' : 'pointer',
            }}
          >
            {ollamaDownloading[customOcrModel.trim()]
              ? `${ollamaProgress[customOcrModel.trim()] || 0}%`
              : tx('Download', '下载')}
          </button>
        </div>
      </div>

      {/* Popular OCR models */}
      <div style={{ margin: '20px 0' }}>
        <h3 style={{ marginTop: 0, marginBottom: '12px', fontSize: '1rem' }}>
          {tx('Popular OCR Models', '常用 OCR 模型')}
        </h3>
        <div className="setup-model-grid">
          {POPULAR_OCR_MODELS.map((model) => {
            const installed = isInstalled(model.name);
            const downloading = ollamaDownloading[model.name];
            const progress = ollamaProgress[model.name] || 0;
            return (
              <article key={model.name} className={`setup-model-card ${installed ? 'installed' : ''}`}>
                <div>
                  <div className="setup-model-topline">
                    <strong>{model.name}</strong>
                  </div>
                  <p style={{ marginBottom: '6px' }}>{model.desc}</p>
                </div>
                <div className="setup-model-actions">
                  {installed ? (
                    <>
                      <button
                        className="setup-secondary-btn"
                        style={{ color: 'var(--color-error, #e53935)', borderColor: 'var(--color-error, #e53935)' }}
                        onClick={async () => {
                          if (confirm(tx(`Delete ${model.name}?`, `删除 ${model.name}？`))) {
                            await api.removeOllamaModel?.(model.name);
                            refreshOllamaStatus();
                            onModelStatusChange?.();
                          }
                        }}
                      >
                        {tx('Delete', '删除')}
                      </button>
                      <span className="setup-installed-current">{tx('Installed', '已安装')}</span>
                    </>
                  ) : (
                    <button
                      className="setup-secondary-btn"
                      onClick={() => handlePullOllamaModel(model.name)}
                      disabled={!ollamaStatus.running || downloading}
                    >
                      {downloading
                        ? `${progress || 0}%`
                        : tx('Download', '下载')}
                    </button>
                  )}
                  {downloading && progress > 0 && (
                    <div className="setup-progress-bar">
                      <div className="setup-progress-fill" style={{ width: `${Math.max(2, progress)}%` }} />
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </div>

      {/* Popular LLM models */}
      <div style={{ margin: '20px 0' }}>
        <h3 style={{ marginTop: 0, marginBottom: '12px', fontSize: '1rem' }}>
          {tx('Popular LLM Models', '常用大语言模型')}
        </h3>
        <div className="setup-model-grid">
          {POPULAR_LLM_MODELS.map((model) => {
            const installed = isInstalled(model.name);
            const downloading = ollamaDownloading[model.name];
            const progress = ollamaProgress[model.name] || 0;
            return (
              <article key={model.name} className={`setup-model-card ${installed ? 'installed' : ''}`}>
                <div>
                  <div className="setup-model-topline">
                    <strong>{model.name}</strong>
                  </div>
                  <p style={{ marginBottom: '6px' }}>{model.desc}</p>
                </div>
                <div className="setup-model-actions">
                  {installed ? (
                    <>
                      <button
                        className="setup-secondary-btn"
                        style={{ color: 'var(--color-error, #e53935)', borderColor: 'var(--color-error, #e53935)' }}
                        onClick={async () => {
                          if (confirm(tx(`Delete ${model.name}?`, `删除 ${model.name}？`))) {
                            await api.removeOllamaModel?.(model.name);
                            refreshOllamaStatus();
                            onModelStatusChange?.();
                          }
                        }}
                      >
                        {tx('Delete', '删除')}
                      </button>
                      <span className="setup-installed-current">{tx('Installed', '已安装')}</span>
                    </>
                  ) : (
                    <button
                      className="setup-secondary-btn"
                      onClick={() => handlePullOllamaModel(model.name)}
                      disabled={!ollamaStatus.running || downloading}
                    >
                      {downloading
                        ? `${progress || 0}%`
                        : tx('Download', '下载')}
                    </button>
                  )}
                  {downloading && progress > 0 && (
                    <div className="setup-progress-bar">
                      <div className="setup-progress-fill" style={{ width: `${Math.max(2, progress)}%` }} />
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </div>

      {/* Installed OCR models */}
      {installedOcrModels.length > 0 && (
        <div style={{ margin: '20px 0' }}>
          <h3 style={{ marginTop: 0, marginBottom: '12px', fontSize: '1rem' }}>
            {tx('Installed OCR Models', '已安装的 OCR 模型')}
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {installedOcrModels.map((modelName) => (
              <div
                key={modelName}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 14px',
                  borderRadius: '8px',
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid var(--glass-border, rgba(255,255,255,0.1))',
                }}
              >
                <span style={{ fontSize: '0.9rem' }}>{modelName}</span>
                <button
                  className="setup-secondary-btn"
                  style={{ color: 'var(--color-error, #e53935)', borderColor: 'var(--color-error, #e53935)', fontSize: '0.8rem', padding: '6px 12px' }}
                  onClick={async () => {
                    if (confirm(tx(`Delete ${modelName}?`, `删除 ${modelName}？`))) {
                      await api.removeOllamaModel?.(modelName);
                      refreshOllamaStatus();
                      onModelStatusChange?.();
                    }
                  }}
                >
                  {tx('Delete', '删除')}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Installed other models */}
      {installedOtherModels.length > 0 && (
        <div style={{ margin: '20px 0' }}>
          <h3 style={{ marginTop: 0, marginBottom: '12px', fontSize: '1rem' }}>
            {tx('Other Installed Models', '其他已安装模型')}
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {installedOtherModels.map((modelName) => (
              <div
                key={modelName}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '10px 14px',
                  borderRadius: '8px',
                  background: 'rgba(255,255,255,0.04)',
                  border: '1px solid var(--glass-border, rgba(255,255,255,0.1))',
                }}
              >
                <span style={{ fontSize: '0.9rem' }}>{modelName}</span>
                <button
                  className="setup-secondary-btn"
                  style={{ color: 'var(--color-error, #e53935)', borderColor: 'var(--color-error, #e53935)', fontSize: '0.8rem', padding: '6px 12px' }}
                  onClick={async () => {
                    if (confirm(tx(`Delete ${modelName}?`, `删除 ${modelName}？`))) {
                      await api.removeOllamaModel?.(modelName);
                      refreshOllamaStatus();
                      onModelStatusChange?.();
                    }
                  }}
                >
                  {tx('Delete', '删除')}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

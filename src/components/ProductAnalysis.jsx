import React, { useState, useEffect } from 'react';
import ActivityConsole from './ActivityConsole';
import { dispatchLLMConfigUpdate, subscribeLLMConfigUpdate } from '../utils/llmConfigSync';
import { useI18n } from '../utils/i18n';
import {
  buildDefaultOcrConfig,
  getOcrEngineOptions,
  mergeOcrConfig,
  normalizeOcrEngineName,
} from '../utils/ocrEngines';
import './ProductAnalysis.css';

const DEFAULT_OCR_CONFIG = buildDefaultOcrConfig();

const DEFAULT_LLM_CONFIG = {
  mode: 'local',
  local: { enabled: true, baseUrl: 'http://localhost:11434', model: '', installed: false, running: false, installedModels: [] },
  cloud: { enabled: false, baseUrl: '', model: '', apiKey: '' },
  hybrid: { enabled: false, extractionEndpoint: 'cloud', analysisEndpoint: 'local' },
  ocr: DEFAULT_OCR_CONFIG,
};

function getOcrSelection(config) {
  return mergeOcrConfig(config?.ocr || DEFAULT_LLM_CONFIG.ocr);
}

function mergeOcrSelection(config, updates = {}) {
  const baseConfig = config || DEFAULT_LLM_CONFIG;
  return {
    ...baseConfig,
    ocr: mergeOcrConfig({
      ...(baseConfig.ocr || {}),
      ...updates,
    }),
  };
}

function getPathLeaf(value = '') {
  return String(value || '')
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .filter(Boolean)
    .pop() || '';
}

function ProductAnalysis({ workspaceVisible = true }) {
  const { tx } = useI18n();
  const [sourcePath, setSourcePath] = useState('');
  const [sourceType, setSourceType] = useState('');
  const [outputPath, setOutputPath] = useState('');
  const [reportTitle, setReportTitle] = useState('Product Collection Analysis Report');
  const [reportTemplate] = useState('adaptive');
  const [collectionLabel, setCollectionLabel] = useState('');
  const [logs, setLogs] = useState([]);
  const [progress, setProgress] = useState(0);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [stats, setStats] = useState(null);
  const [completionFeedback, setCompletionFeedback] = useState(null);
  const [ocrEngine, setOcrEngine] = useState(DEFAULT_OCR_CONFIG.engine);

  const [llmEnabled, setLlmEnabled] = useState(true);
  const [llmConfig, setLlmConfig] = useState(null);
  const [llmConfigReady, setLlmConfigReady] = useState(false);
  const [availableOcrEngines, setAvailableOcrEngines] = useState([]);

  const getEffectiveMode = (cfg) => {
    if (cfg?.mode === 'cloud') {
      return 'cloud';
    }
    return 'local';
  };

  useEffect(() => {
    if (window.electronAPI) {
      window.electronAPI.onAnalysisLog?.((log) => setLogs(prev => [...prev, log]));
      window.electronAPI.onAnalysisProgress?.((value) => setProgress(value));
    }
    return () => { if (window.electronAPI) window.electronAPI.removeAnalysisListeners?.(); };
  }, []);

  useEffect(() => {
    loadLLMConfiguration();
  }, []);

  useEffect(() => {
    return subscribeLLMConfigUpdate((nextConfig) => {
      setLlmConfig(nextConfig);
      const nextOcr = getOcrSelection(nextConfig);
      setOcrEngine(nextOcr.engine);
      setLlmConfigReady(true);
    });
  }, []);

  const loadLLMConfiguration = async () => {
    try {
      if (window.electronAPI?.loadLLMConfig) {
        const cfg = await window.electronAPI.loadLLMConfig();
        setLlmConfig(cfg);
        const nextOcr = getOcrSelection(cfg);
        setOcrEngine(nextOcr.engine);
      }
      if (window.electronAPI?.ocrDetectAvailableEngines) {
        const oe = await window.electronAPI.ocrDetectAvailableEngines();
        if (oe?.success && oe.engines?.length > 0) {
          setAvailableOcrEngines(oe.engines);
        }
      }
    } catch (e) {
      console.error('Failed to load LLM config:', e);
    } finally {
      setLlmConfigReady(true);
    }
  };

  const persistOcrSelection = (updates = {}) => {
    const nextConfig = mergeOcrSelection(llmConfig, updates);
    setLlmConfig(nextConfig);
    setLlmConfigReady(true);
    window.electronAPI?.saveLLMConfig?.(nextConfig);
    dispatchLLMConfigUpdate(nextConfig);
  };
  const ocrEngineOptions = availableOcrEngines.length > 0
    ? availableOcrEngines
    : getOcrEngineOptions(undefined, llmConfig?.ocr || {}, {});

  useEffect(() => {
    if (ocrEngineOptions.length === 0) {
      return;
    }

    const normalizedCurrent = normalizeOcrEngineName(ocrEngine);
    if (!ocrEngineOptions.some((option) => option.value === normalizedCurrent)) {
      const nextEngine = ocrEngineOptions[0].value;
      setOcrEngine(nextEngine);
      persistOcrSelection({ engine: nextEngine, fallbackEngine: '' });
    }
  }, [ocrEngine, ocrEngineOptions]);

  const addLog = (message, type = 'info') => {
    setLogs(prev => [...prev, { time: new Date().toLocaleTimeString(), message, type }]);
  };

  const openLocalPath = async (targetPath) => {
    if (!targetPath || !window.electronAPI?.openLocalPath) {
      return;
    }

    const result = await window.electronAPI.openLocalPath(targetPath);
    if (!result?.success) {
      addLog(`Open failed: ${result?.error || 'Unknown error'}`, 'error');
    }
  };

  const revealLocalPath = async (targetPath) => {
    if (!targetPath || !window.electronAPI?.revealLocalPath) {
      return;
    }

    const result = await window.electronAPI.revealLocalPath(targetPath);
    if (!result?.success) {
      addLog(`Reveal failed: ${result?.error || 'Unknown error'}`, 'error');
    }
  };

  const handleSelectSource = async (type) => {
    if (!window.electronAPI) return;
    if (type === 'folder') {
      const dir = await window.electronAPI.selectDir();
      if (dir) { setSourcePath(dir); setSourceType('folder'); addLog(`Selected folder: ${dir}`, 'success'); }
    } else {
      const f = await window.electronAPI.selectAnalysisFile();
      if (f) { setSourcePath(f); setSourceType(f.split('.').pop().toLowerCase()); addLog(`Selected: ${f}`, 'success'); }
    }
  };

  const handleSelectOutput = async () => {
    if (!window.electronAPI) return;
    const f = await window.electronAPI.saveFile({
      defaultPath: 'Product_Analysis_Report.docx',
      filters: [{ name: 'Word Document', extensions: ['docx'] }]
    });
    if (f) setOutputPath(f);
  };

  const handleAnalyze = async () => {
    if (!sourcePath) return;
    setIsAnalyzing(true); setIsCancelling(false); setLogs([]); setProgress(0); setStats(null); setCompletionFeedback(null);
    addLog('Starting product analysis...', 'info');
    setProgress(5);

    try {
      let llmConfigData;
      const cfg = llmConfig || DEFAULT_LLM_CONFIG;
      
      const mode = getEffectiveMode(cfg);
      const apparelVisionConfig = mode === 'cloud'
        ? { ...(llmConfig?.apparelVision || {}), enabled: false }
        : (llmConfig?.apparelVision || null);
      llmConfigData = {
        enabled: true,
        mode,
        baseUrl: mode === 'cloud' ? cfg?.cloud?.baseUrl : cfg?.local?.baseUrl,
        model: mode === 'cloud' ? cfg?.cloud?.model : cfg?.local?.model,
        apiKey: mode === 'cloud' ? cfg?.cloud?.apiKey : '',
      };

      const config = {
        sourcePath, sourceType,
        outputPath: outputPath || sourcePath.replace(/\.[^.]+$/, '') + '_Analysis_Report.docx',
        title: reportTitle,
        template: reportTemplate,
        collectionLabel,
        brandName: 'Single Brand',
        aiOnly: true,
        enableVision: llmEnabled,
        ocrEngine,
        ocrFallbackEngine: '',
        apparelVision: apparelVisionConfig,
        llm: llmEnabled ? llmConfigData : { enabled: false },
      };

      addLog('Parsing product data...', 'info');
      setProgress(10);

      const result = await window.electronAPI.analyzeProducts(config);

      if (result.success) {
        setProgress(100);
        setStats(result);
        addLog(`Analysis complete`, 'success');
        addLog(`Products: ${result.productCount} | Categories: ${result.categories} | Materials: ${result.materials}`, 'info');
        addLog(`AI analysis: ${result.aiEnabled ? 'Enabled' : 'Disabled'}`, 'info');
        addLog(`Report saved: ${result.outputPath}`, 'success');
        setCompletionFeedback({
          state: 'success',
          title: 'Report complete',
          message: 'The analysis document is ready for review.',
          meta: [
            `${result.productCount} products`,
            `${result.categories} categories`,
            result.outputPath ? getPathLeaf(result.outputPath) : null,
          ],
          outputPath: result.outputPath,
        });
      } else if (result.cancelled) {
        setProgress(0);
        addLog('Analysis cancelled.', 'warning');
        setCompletionFeedback(null);
      } else {
        throw new Error(result.error);
      }
    } catch (error) {
      addLog(`Failed: ${error.message}`, 'error');
      setProgress(0);
      setCompletionFeedback(null);
    }
    setIsAnalyzing(false);
    setIsCancelling(false);
  };

  const latestLogMessage = logs[logs.length - 1]?.message || '';

  const getProgressLabel = () => {
    if (isAnalyzing) return 'Generating report';
    if (progress >= 100) return 'Report complete';
    return 'Analysis progress';
  };

  const getProgressDetail = () => {
    if (latestLogMessage) {
      return latestLogMessage;
    }

    if (progress < 20) return 'Parsing product sources and structuring the collection data.';
    if (progress < 45) return 'Preparing categories, materials, and baseline collection statistics.';
    if (progress < 75) {
      return llmEnabled
        ? 'Running AI analysis with image understanding enabled.'
        : 'Running AI analysis on the extracted product text.';
    }
    if (progress < 100) return 'Composing insights and exporting the final report.';
    return 'The analysis report is ready.';
  };

  const handleClearLogs = () => {
    setLogs([]);
    setStats(null);
    if (!isAnalyzing) {
      setProgress(0);
      setCompletionFeedback(null);
    }
  };

  const handleCancel = async () => {
    if (!window.electronAPI?.cancelTask || isCancelling || !isAnalyzing) {
      return;
    }

    setIsCancelling(true);
    addLog('Cancellation requested. Stopping analysis after the current step...', 'warning');
    await window.electronAPI.cancelTask('analysis');
  };

  const completionActions = completionFeedback?.outputPath
    ? [
        {
          label: tx('Open file', '打开文件'),
          onClick: () => openLocalPath(completionFeedback.outputPath),
        },
        {
          label: tx('Show in folder', '定位文件'),
          variant: 'secondary',
          onClick: () => revealLocalPath(completionFeedback.outputPath),
        },
      ]
    : [];

  return (
    <div className={`analysis-container ${isAnalyzing ? 'is-task-processing' : ''}`}>
      <div className="analysis-content">
        <div className="config-panel">

          {/* Data Source */}
          <div className="config-section">
            <h3>{tx('Data Source', '数据来源')}</h3>
            <div className="source-buttons">
              <button onClick={() => handleSelectSource('folder')} className="select-button">{tx('Scraper Folder', '抓取结果文件夹')}</button>
              <button onClick={() => handleSelectSource('file')} className="select-button">{tx('PDF / PPTX', 'PDF / PPTX')}</button>
            </div>
            {sourcePath && (
              <div className="source-info">
                <span className="source-type">{sourceType.toUpperCase()}</span>
                <span className="file-path">{sourcePath}</span>
              </div>
            )}
          </div>

          {/* Report Title */}
          <div className="config-section">
            <h3>{tx('Report Title', '报告标题')}</h3>
            <input type="text" className="title-input" value={reportTitle}
              onChange={(e) => setReportTitle(e.target.value)} placeholder={tx('Enter report title', '输入报告标题')} />
          </div>

          {/* Collection / Season */}
          <div className="config-section">
            <h3>{tx('Collection / Season', '系列 / 季节')}</h3>
            <input type="text" className="title-input" value={collectionLabel}
              onChange={(e) => setCollectionLabel(e.target.value)} placeholder={tx('e.g., SS 2026', '例如：SS 2026')} />
          </div>

          {/* Output */}
          <div className="config-section">
            <h3>{tx('Output File', '输出文件')}</h3>
            <div className="file-selector">
              <button onClick={handleSelectOutput} className="select-button">{tx('Save As', '另存为')}</button>
              <span className="file-path">{outputPath || tx('Auto-named .docx', '自动命名 .docx')}</span>
            </div>
          </div>

          {/* Action */}
          <div className="action-buttons">
            <button onClick={handleAnalyze} disabled={isAnalyzing || !sourcePath} className="primary-button">
              {isAnalyzing ? tx('Analyzing...', '分析中...') : tx('Generate Report', '生成报告')}
            </button>
            {isAnalyzing && (
              <button onClick={handleCancel} disabled={isCancelling} className="secondary-button danger-button">
                {isCancelling ? tx('Cancelling...', '取消中...') : tx('Cancel', '取消')}
              </button>
            )}
          </div>
        </div>

        <div className="log-panel">
          <div className="panel-log-anchor">
            <ActivityConsole
              title={tx('Console', '控制台')}
              layout="dock"
              isVisible={workspaceVisible}
              logs={logs}
              onClear={handleClearLogs}
              onCancel={handleCancel}
              progress={progress}
              isActive={isAnalyzing}
              isCancelling={isCancelling}
              progressLabel={getProgressLabel()}
              progressDetail={getProgressDetail()}
              compactCount={10}
              completionState={completionFeedback?.state}
              completionTitle={completionFeedback?.title}
              completionMessage={completionFeedback?.message}
              completionMeta={completionFeedback?.meta}
              completionActions={completionActions}
            />
          </div>

          <div className="config-section">
            <h3>{tx('OCR Engine', 'OCR 引擎')}</h3>
            <div className="analysis-ocr-row">
              <div className="input-group">
                <label>{tx('Primary OCR', '主 OCR')}</label>
                <select
                  className="sort-select"
                  value={ocrEngine}
                  onChange={(event) => {
                    const nextEngine = event.target.value;
                    setOcrEngine(nextEngine);
                    persistOcrSelection({ engine: nextEngine, fallbackEngine: '' });
                  }}
                >
                  {ocrEngineOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label ? tx(option.label.en, option.label.zh) : tx(option.labelEn, option.labelZh)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="help-text" style={{ marginLeft: 0, marginTop: '10px' }}>
              {tx(
                'Use one OCR engine at a time: Local OCR is faster for daily work, DeepSeek OCR V2 is stronger but slower, and PaddleOCR-VL 1.5 is best for more complex labels.',
                '当前一次只使用一个 OCR：本机 OCR 更快，适合日常处理；DeepSeek OCR V2 更强但更慢；PaddleOCR-VL 1.5 更适合复杂标签。',
              )}
            </div>
          </div>

          <div className="config-section">
            <h3>{tx('AI Analysis', 'AI 分析')}</h3>
            <label className="toggle-row">
              <input type="checkbox" checked={llmEnabled} onChange={(e) => setLlmEnabled(e.target.checked)} />
              <span>{tx('Enable AI analysis (recommended)', '启用 AI 分析（推荐）')}</span>
            </label>

            {llmEnabled && (
              <div className="llm-config-simplified">
                {!llmConfigReady ? (
                  <div className="current-mode-info">
                    <span>{tx('Loading saved AI settings...', '正在加载已保存的 AI 设置...')}</span>
                  </div>
                ) : (
                  <>
                    <div className="mode-select-group">
                      <label>{tx('LLM Mode', '模型模式')}</label>
                      <div className="mode-buttons">
                        <button
                          className={`mode-btn ${(llmConfig?.mode || 'local') === 'local' ? 'active' : ''}`}
                          onClick={() => {
                            const newConfig = { ...(llmConfig || DEFAULT_LLM_CONFIG), mode: 'local' };
                            setLlmConfig(newConfig);
                            setLlmConfigReady(true);
                            window.electronAPI?.saveLLMConfig?.(newConfig);
                            dispatchLLMConfigUpdate(newConfig);
                          }}
                        >
                          {tx('Local', '本地')}
                        </button>
                        <button
                          className={`mode-btn ${llmConfig?.mode === 'cloud' ? 'active' : ''}`}
                          onClick={() => {
                            const newConfig = { ...(llmConfig || DEFAULT_LLM_CONFIG), mode: 'cloud' };
                            setLlmConfig(newConfig);
                            setLlmConfigReady(true);
                            window.electronAPI?.saveLLMConfig?.(newConfig);
                            dispatchLLMConfigUpdate(newConfig);
                          }}
                        >
                          {tx('Cloud', '云端')}
                        </button>
                      </div>
                    </div>

                    <div className="vision-option">
                      <div className="vision-hint">
                        {tx(
                          'AI analysis reads images automatically when enabled.',
                          '启用 AI 分析后会自动识别图片内容。',
                        )}
                      </div>
                    </div>

                    {llmConfig && (
                      <div className="current-mode-info">
                        {llmConfig.mode === 'local' && (
                          <span>{tx('Using local:', '当前本地：')} {llmConfig.local?.baseUrl || 'localhost:11434'}</span>
                        )}
                        {llmConfig.mode === 'cloud' && (
                          <span>{tx('Using cloud:', '当前云端：')} {llmConfig.cloud?.baseUrl || tx('Not configured', '未配置')}</span>
                        )}
                      </div>
                    )}

                    {llmEnabled && llmConfig?.mode !== 'cloud' && (
                      <div className="current-mode-info">
                        <span>{tx('Recommended local apparel stack:', '推荐本地服装栈：')} Moondream2 + Gr3_Fabric</span>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          {stats && (
            <div className="config-section">
              <h3>{tx('Results', '结果')}</h3>
              <div className="stats-grid">
                <div className="stat-card">
                  <span className="stat-value">{stats.productCount}</span>
                  <span className="stat-label">{tx('Products', '产品')}</span>
                </div>
                <div className="stat-card">
                  <span className="stat-value">{stats.categories}</span>
                  <span className="stat-label">{tx('Categories', '类别')}</span>
                </div>
                <div className="stat-card">
                  <span className="stat-value">{stats.materials}</span>
                  <span className="stat-label">{tx('Materials', '面料')}</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default ProductAnalysis;

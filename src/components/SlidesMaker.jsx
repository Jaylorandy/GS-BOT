import React, { useEffect, useMemo, useRef, useState } from 'react';
import ActivityConsole from './ActivityConsole';
import LLMEndpointModelPicker, { getActiveApiCloudPreset as sharedGetActiveApiCloudPreset } from './LLMEndpointModelPicker';
import { subscribeLLMConfigUpdate } from '../utils/llmConfigSync';
import { useI18n } from '../utils/i18n';
import { buildCompletionIssues } from '../utils/completionIssues';
import './SlidesMaker.css';

const DEFAULT_STYLE_SUFFIX_PRESETS = {
  1: ['01'],
  2: ['F', 'S'],
  3: ['01', 'F', 'B'],
  4: ['01', 'F', 'B', 'S'],
  6: ['01', 'F', 'B', 'S', 'D', 'E'],
};

const DEFAULT_LLM_CONFIG = {
  mode: 'local',
  local: { enabled: true, baseUrl: 'http://localhost:11434', model: '', installed: false, running: false, installedModels: [] },
  cloud: { enabled: false, baseUrl: '', model: '', apiKey: '' },
  apiCloud: { enabled: false, activePresetId: 'glm', presets: [] },
  hybrid: { enabled: false, extractionEndpoint: 'cloud', analysisEndpoint: 'local' },
};

function getActiveApiCloudPreset(cfg) {
  return sharedGetActiveApiCloudPreset(cfg);
}

function buildDefaultLookbookPath(folderPath = '') {
  const trimmed = String(folderPath || '').replace(/[\\/]+$/, '');
  const brandName = trimmed.split(/[\\/]/).filter(Boolean).pop() || 'Brand';
  const separator = trimmed.includes('\\') ? '\\' : '/';
  return `${trimmed}${separator}${brandName}_Lookbook.pptx`;
}

function getPathLeaf(value = '') {
  return String(value || '')
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .filter(Boolean)
    .pop() || '';
}

function buildDefaultStyleSuffixes(count = 3) {
  return [...(DEFAULT_STYLE_SUFFIX_PRESETS[count] || Array.from({ length: count }, (_unused, index) => String(index + 1)))];
}

function normalizeStyleSuffixes(list = [], count = 3) {
  return Array.from({ length: count }, (_unused, index) => String(list[index] || '').replace(/^_+/, ''));
}

function buildStyleKeyFromSuffix(baseName = '', suffixes = []) {
  const normalizedSuffixes = (Array.isArray(suffixes) ? suffixes : [])
    .map((item) => String(item || '').trim().replace(/^_+/, ''))
    .filter(Boolean)
    .map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));

  if (!normalizedSuffixes.length) {
    return '';
  }

  const pattern = new RegExp(`_(${normalizedSuffixes.join('|')})$`, 'i');
  if (!pattern.test(baseName)) {
    return '';
  }

  return baseName.replace(pattern, '').trim();
}

function estimateStyleGroups(items = [], suffixes = [], sourceOrganization = 'auto') {
  const cleanItems = items.filter((item) => !String(item?.name || '').startsWith('.') && String(item?.name || '') !== '_organize_meta');
  if (sourceOrganization === 'style-folders') {
    return cleanItems.filter((item) => item?.isDirectory).length;
  }

  const files = cleanItems.filter((item) => item?.isFile);
  const groups = new Set();

  files.forEach((item) => {
    const baseName = String(item.name || '').replace(/\.[^.]+$/, '');
    const styleKey = buildStyleKeyFromSuffix(baseName, suffixes);
    if (styleKey) {
      groups.add(styleKey);
    }
  });

  return groups.size;
}

export default function SlidesMaker({ workspaceVisible = true, homeFeature }) {
  const { tx } = useI18n();
  const [sourceFolder, setSourceFolder] = useState('');
  const [outputPath, setOutputPath] = useState('');
  const [logs, setLogs] = useState([]);
  const [progress, setProgress] = useState(0);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [completionFeedback, setCompletionFeedback] = useState(null);
  const [folderInfo, setFolderInfo] = useState(null);
  const [showSuffixEditor, setShowSuffixEditor] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const acceptProgressRef = useRef(false);
  const [config, setConfig] = useState({
    sourceMode: 'style-images-only',
    sourceOrganization: 'style-folders',
    title: '',
    includeComposition: false,
    includeDescription: true,
    includeFabricCode: false,
    includeName: true,
    includePrice: true,
    includeStyleNumber: true,
    includeWidth: false,
    includeCuttable: false,
    includeWeight: false,
    generateDescription: false,
    sortBy: 'styleNumber',
    stylePageImageCount: 3,
    fabricPageImageCount: 1,
    imageSuffixes: buildDefaultStyleSuffixes(3),
    includeColorRef: false,
    fillMissingSlots: true,
  });
  const [ollamaEnabled, setOllamaEnabled] = useState(false);
  const [llmConfig, setLlmConfig] = useState(null);
  const [llmConfigReady, setLlmConfigReady] = useState(false);
  const [aiModeOverride, setAiModeOverride] = useState('local');
  const [aiModelOverride, setAiModelOverride] = useState('');
  const [forceRefresh, setForceRefresh] = useState(false);

  // Apply presets from the ModuleHome sub-feature selection.
  useEffect(() => {
    if (!homeFeature) return;
    switch (homeFeature) {
      case 'style-deck':
        setConfig((prev) => ({ ...prev, sourceMode: 'style-images-only' }));
        setOllamaEnabled(false);
        break;
      case 'fabric-deck':
        setConfig((prev) => ({ ...prev, sourceMode: 'fabric-images' }));
        break;
      case 'ai-descriptions':
        setOllamaEnabled(true);
        setConfig((prev) => ({ ...prev, includeDescription: true }));
        break;
      case 'advanced':
        setShowAdvanced(true);
        setShowSuffixEditor(true);
        break;
      default:
        break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homeFeature]);

  useEffect(() => {
    if (window.electronAPI) {
      window.electronAPI.onSlidesLog((log) => setLogs((prev) => [...prev, log]));
      window.electronAPI.onSlidesProgress((value) => {
        if (!acceptProgressRef.current) {
          return;
        }
        setProgress(value);
      });
    }
    return () => { window.electronAPI?.removeSlidesListeners?.(); };
  }, []);

  useEffect(() => {
    if (!window.electronAPI?.loadLLMConfig) {
      setLlmConfigReady(true);
      return;
    }

    window.electronAPI.loadLLMConfig()
      .then((cfg) => setLlmConfig(cfg))
      .catch((error) => console.error('Failed to load LLM config:', error))
      .finally(() => setLlmConfigReady(true));
  }, []);

  useEffect(() => subscribeLLMConfigUpdate((nextConfig) => {
    setLlmConfig(nextConfig);
    setLlmConfigReady(true);
  }), []);

  const addLog = (message, type = 'info') => {
    setLogs((prev) => [...prev, { time: new Date().toLocaleTimeString(), message, type }]);
  };

  const updateConfig = (updates) => {
    setConfig((prev) => {
      const next = typeof updates === 'function' ? updates(prev) : { ...prev, ...updates };

      // When switching source mode, uncheck fields irrelevant to that mode
      if (updates.sourceMode && updates.sourceMode !== prev.sourceMode) {
        if (updates.sourceMode === 'fabric-images') {
          // 面料图模式：款号/价格仍不适用，但「产品名称」现在可由 AI 生成，故保留勾选状态。
          next.includeStyleNumber = false;
          next.includePrice = false;
        } else if (updates.sourceMode === 'style-images-only') {
          // Style mode: uncheck fabric-related fields
          next.includeFabricCode = false;
          next.includeComposition = false;
          next.includeWidth = false;
          next.includeCuttable = false;
          next.includeWeight = false;
        }
      }

      const pageCount = Number(next.stylePageImageCount) || 3;
      return {
        ...next,
        imageSuffixes: normalizeStyleSuffixes(
          Array.isArray(next.imageSuffixes) && next.imageSuffixes.length > 0
            ? next.imageSuffixes
            : buildDefaultStyleSuffixes(pageCount),
          pageCount,
        ),
      };
    });
  };

  const styleGroupEstimate = useMemo(() => (
    folderInfo?.items
      ? estimateStyleGroups(folderInfo.items, config.imageSuffixes, config.sourceOrganization)
      : 0
  ), [folderInfo, config.imageSuffixes, config.sourceOrganization]);

  const effectiveSlidesAiMode = aiModeOverride === 'cloud' ? 'cloud' : aiModeOverride === 'apiCloud' ? 'apiCloud' : 'local';
  const isStyleMode = config.sourceMode === 'style-images-only';

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

  const handleSelectFolder = async () => {
    const dir = await window.electronAPI?.selectDir?.();
    if (!dir) {
      return;
    }

    setSourceFolder(dir);
    setOutputPath(buildDefaultLookbookPath(dir));
    const dirResult = await window.electronAPI?.readDir?.(dir);
    if (dirResult?.success) {
      const items = dirResult.items || [];
      const topLevelFiles = items.filter((item) => item.isFile && !String(item.name || '').startsWith('.'));
      setFolderInfo({ items, fileCount: topLevelFiles.length });
      addLog(`Found ${topLevelFiles.length} top-level files.`, 'success');
    }
  };

  const handleSelectOutput = async () => {
    const defaultFileName = `${getPathLeaf(sourceFolder) || 'Brand'}_Lookbook.pptx`;
    const filePath = await window.electronAPI?.saveFile?.({
      defaultPath: defaultFileName,
      filters: [{ name: 'PowerPoint', extensions: ['pptx'] }],
    });
    if (filePath) {
      setOutputPath(filePath);
    }
  };

  const handleGenerate = async () => {
    if (!sourceFolder) {
      return;
    }

    setIsGenerating(true);
    setIsCancelling(false);
    setLogs([]);
    setProgress(0);
    setCompletionFeedback(null);
    acceptProgressRef.current = true;
    addLog('Starting PPT generation...', 'info');
    if (forceRefresh) {
      addLog('Cache bypass enabled. OCR and slide preparation will run again.', 'info');
    }

    try {
      const defaultOutput = buildDefaultLookbookPath(sourceFolder);
      const cfg = llmConfig || DEFAULT_LLM_CONFIG;
      const effectiveMode = aiModeOverride === 'cloud' ? 'cloud' : aiModeOverride === 'apiCloud' ? 'apiCloud' : 'local';
      const activeApiPreset = getActiveApiCloudPreset(cfg);
      const chosenModel = aiModelOverride || '';
      const llmConfigData = ollamaEnabled
        ? effectiveMode === 'apiCloud'
          ? {
              mode: 'apiCloud',
              baseUrl: activeApiPreset?.baseUrl || '',
              model: chosenModel || activeApiPreset?.model || '',
              apiKey: activeApiPreset?.apiKey || '',
            }
          : {
              mode: effectiveMode,
              baseUrl: effectiveMode === 'cloud' ? cfg.cloud?.baseUrl : cfg.local?.baseUrl,
              model: chosenModel || (effectiveMode === 'cloud' ? cfg.cloud?.model : cfg.local?.model) || '',
              apiKey: effectiveMode === 'cloud' ? cfg.cloud?.apiKey : '',
            }
        : null;

      const imageLayout = config.sourceMode === 'fabric-images'
        ? (Number(config.fabricPageImageCount) === 2 ? 'fabric-pair' : 'fabric-single')
        : `style-gallery-${config.stylePageImageCount}`;
      const result = await window.electronAPI?.generatePPT?.({
        sourceFolder,
        outputPath: outputPath || defaultOutput,
        config: {
          ...config,
          forceRefresh,
          imageSuffixes: normalizeStyleSuffixes(config.imageSuffixes, Number(config.stylePageImageCount) || 3),
          imageLayout,
          ollamaEnabled,
          enableVision: ollamaEnabled,
          generateDescription: ollamaEnabled,
          llmConfig: llmConfigData,
          sourceMode: config.sourceMode,
        },
      });

      if (result?.success) {
        acceptProgressRef.current = false;
        setProgress(100);
        setOutputPath(result.outputPath || outputPath || defaultOutput);
        addLog('PPT generated successfully.', 'success');
        addLog(`Saved: ${result.outputPath}`, 'success');
        addLog(`Processed ${result.styleCount} ${config.sourceMode === 'fabric-images' ? 'fabric pages' : 'style groups'}`, 'info');
        if (!forceRefresh && logs.some((entry) => /Using cached slide preparation data/i.test(String(entry?.message || '')))) {
          addLog('Slide preparation cache was reused during this run.', 'info');
        }
        setCompletionFeedback({
          state: 'success',
          title: config.sourceMode === 'fabric-images' ? 'Fabric deck complete' : 'Style deck complete',
          message: config.sourceMode === 'fabric-images'
            ? 'The fabric presentation is ready to share.'
            : 'The style presentation is ready to share.',
          meta: [
            `${result.styleCount} ${config.sourceMode === 'fabric-images' ? tx('fabrics', '面料') : tx('groups', '组')}`,
            result.outputPath ? getPathLeaf(result.outputPath) : null,
            config.sourceMode === 'style-images-only' ? `${config.stylePageImageCount} ${tx('images per page', '张/页')}` : null,
            forceRefresh ? tx('Forced refresh', '强制重跑') : null,
          ],
          outputPath: result.outputPath || outputPath || defaultOutput,
          issues: result.issues || null,
        });
      } else if (result?.cancelled) {
        acceptProgressRef.current = false;
        setProgress(0);
        addLog('Generation cancelled.', 'warning');
      } else {
        throw new Error(result?.error || 'PPT generation failed.');
      }
    } catch (error) {
      acceptProgressRef.current = false;
      setProgress(0);
      addLog(`Failed: ${error.message}`, 'error');
    } finally {
      setIsGenerating(false);
      setIsCancelling(false);
    }
  };

  const handleCancel = async () => {
    if (!window.electronAPI?.cancelTask || isCancelling || !isGenerating) {
      return;
    }
    setIsCancelling(true);
    addLog('Cancellation requested. Stopping the generator...', 'warning');
    await window.electronAPI.cancelTask('slides');
  };

  const handleClearLogs = () => {
    setLogs([]);
    if (!isGenerating) {
      acceptProgressRef.current = false;
      setProgress(0);
      setCompletionFeedback(null);
    }
  };

  const latestLogMessage = logs[logs.length - 1]?.message || '';
  const completionActions = completionFeedback?.outputPath
    ? [
        { label: tx('Open file', '打开文件'), onClick: () => openLocalPath(completionFeedback.outputPath) },
        { label: tx('Show in folder', '定位文件'), variant: 'secondary', onClick: () => revealLocalPath(completionFeedback.outputPath) },
      ]
    : [];
  const completionIssues = buildCompletionIssues(completionFeedback?.issues, tx);

  // ── Summary chips for the header bar ──
  const summaryChips = [
    {
      key: 'folder',
      label: sourceFolder
        ? getPathLeaf(sourceFolder)
        : tx('No folder', '未选文件夹'),
      tone: sourceFolder ? 'ok' : 'muted',
    },
    {
      key: 'mode',
      label: isStyleMode ? tx('Style mode', '款式模式') : tx('Fabric mode', '面料模式'),
      tone: 'accent',
    },
    isStyleMode && folderInfo
      ? {
          key: 'count',
          label: `${styleGroupEstimate} ${tx('style groups', '款式组')}`,
          tone: styleGroupEstimate > 0 ? 'ok' : 'warn',
        }
      : null,
    !isStyleMode && folderInfo
      ? {
          key: 'count',
          label: `${Math.ceil((folderInfo.fileCount || 0) / (Number(config.fabricPageImageCount) === 2 ? 2 : 1))} ${tx('fabric pages', '面料页')}`,
          tone: (folderInfo.fileCount || 0) > 0 ? 'ok' : 'warn',
        }
      : null,
    isStyleMode
      ? {
          key: 'imgs',
          label: `${config.stylePageImageCount} ${tx('img/page', '图/页')}`,
          tone: 'muted',
        }
      : null,
    !isStyleMode
      ? {
          key: 'fabimgs',
          label: `${Number(config.fabricPageImageCount)} ${tx('img/page', '图/页')}`,
          tone: 'muted',
        }
      : null,
    {
      key: 'ai',
      label: ollamaEnabled
        ? `AI · ${effectiveSlidesAiMode === 'cloud' ? tx('Cloud', '云端') : effectiveSlidesAiMode === 'apiCloud' ? tx('API Cloud', 'API 云端') : tx('Local', '本地')}`
        : tx('AI off', 'AI 未启用'),
      tone: ollamaEnabled ? 'accent' : 'muted',
    },
  ].filter(Boolean);

  const canGenerate = Boolean(sourceFolder) && !isGenerating;
  const showConsolePanel = isGenerating || logs.length > 0 || Boolean(completionFeedback);

  return (
    <div className={`slides-container ${isGenerating ? 'is-task-processing' : ''} ${showConsolePanel ? 'has-console' : 'no-console'}`}>
      {/* ── Top summary bar ── */}
      <div className="slides-summary-bar">
        <div className="slides-summary-chips">
          {summaryChips.map((chip) => (
            <span key={chip.key} className={`slides-chip slides-chip--${chip.tone}`}>{chip.label}</span>
          ))}
        </div>
      </div>

      <div className={`slides-content slides-content--v2 ${showConsolePanel ? 'has-console' : 'no-console'}`}>
        <div className="config-panel slides-config-v2">
          {/* ─── STEP 1 ─── */}
          <section className="slides-step">
            <div className="slides-step-head">
              <span className="slides-step-num">1</span>
              <h3>{tx('Pick the source folder', '选择源文件夹')}</h3>
            </div>
            <div className="slides-step-body">
              <button onClick={handleSelectFolder} className="slides-bigchoice slides-bigchoice--folder">
                <div className="slides-bigchoice-text">
                  <div className="slides-bigchoice-title">
                    {sourceFolder ? getPathLeaf(sourceFolder) : tx('Choose folder…', '点击选择文件夹…')}
                  </div>
                  <div className="slides-bigchoice-sub">
                    {sourceFolder
                      ? sourceFolder
                      : tx('Pick the folder that holds your style images and info files.', '选择存放款式图片和信息文件的文件夹。')}
                  </div>
                </div>
              </button>
              {folderInfo && (
                <div className="slides-folder-summary">
                  <div className="slides-folder-stat">
                    <span className="slides-folder-stat-num">{folderInfo.fileCount || 0}</span>
                    <span className="slides-folder-stat-lbl">{tx('top-level files', '顶层文件')}</span>
                  </div>
                  <div className="slides-folder-stat slides-folder-stat--accent">
                    <span className="slides-folder-stat-num">
                      {isStyleMode
                        ? styleGroupEstimate
                        : Math.ceil((folderInfo.fileCount || 0) / (Number(config.fabricPageImageCount) === 2 ? 2 : 1))}
                    </span>
                    <span className="slides-folder-stat-lbl">
                      {isStyleMode ? tx('style groups detected', '识别到款式组') : tx('fabric pages', '面料页')}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* ─── STEP 2 ─── */}
          <section className="slides-step">
            <div className="slides-step-head">
              <span className="slides-step-num">2</span>
              <h3>{tx('Choose deck type', '选择 PPT 类型')}</h3>
            </div>
            <div className="slides-step-body">
              <div className="slides-mode-cards">
                <button
                  type="button"
                  className={`slides-mode-card ${isStyleMode ? 'is-active' : ''}`}
                  onClick={() => updateConfig({ sourceMode: 'style-images-only' })}
                >
                  <div className="slides-mode-card-title">{tx('Style mode', '款式模式')}</div>
                  <div className="slides-mode-card-sub">{tx('Group images by style number, one style per page.', '按款号分组，每款一页。')}</div>
                </button>
                <button
                  type="button"
                  className={`slides-mode-card ${!isStyleMode ? 'is-active' : ''}`}
                  onClick={() => updateConfig({ sourceMode: 'fabric-images' })}
                >
                  <div className="slides-mode-card-title">{tx('Fabric mode', '面料模式')}</div>
                  <div className="slides-mode-card-sub">{tx('One or two fabric images per page, fixed layout.', '每页一至两张面料图，固定版式。')}</div>
                </button>
              </div>

              {!isStyleMode && (
                <div className="slides-fabric-layout-row">
                  <div className="slides-sub-label">{tx('Images per page', '每页图片数')}</div>
                  <div className="slides-pill-row">
                    {[1, 2].map((count) => (
                      <button
                        key={count}
                        type="button"
                        className={`slides-pill slides-pill--num ${Number(config.fabricPageImageCount) === count ? 'is-active' : ''}`}
                        onClick={() => updateConfig({ fabricPageImageCount: count })}
                      >
                        {count}
                      </button>
                    ))}
                  </div>
                  <div className="slides-hint">
                    {Number(config.fabricPageImageCount) === 1
                      ? tx('One fabric image per page with a text block on the left.', '每页一张面料图，文字块在左侧。')
                      : tx('Two fabric images per page, side by side, each with its own text block.', '每页两张面料图并排，每张右侧配独立文字块。')}
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* ─── STEP 3 (Style mode only) ─── */}
          {isStyleMode && (
            <section className="slides-step">
              <div className="slides-step-head">
                <span className="slides-step-num">3</span>
                <h3>{tx('Layout & matching', '版式与匹配')}</h3>
              </div>
              <div className="slides-step-body">

                <div className="slides-sub-label">{tx('How are your styles organized?', '款式如何组织？')}</div>
                <div className="slides-pill-row">
                  <button
                    type="button"
                    className={`slides-pill ${config.sourceOrganization === 'style-folders' ? 'is-active' : ''}`}
                    onClick={() => updateConfig({ sourceOrganization: 'style-folders' })}
                  >
                    {tx('Each style in its own folder', '每款单独文件夹')}
                  </button>
                  <button
                    type="button"
                    className={`slides-pill ${config.sourceOrganization === 'single-folder' ? 'is-active' : ''}`}
                    onClick={() => updateConfig({ sourceOrganization: 'single-folder' })}
                  >
                    {tx('All styles in one folder', '所有款一个文件夹')}
                  </button>
                </div>

                <div className="slides-sub-label slides-sub-label--spaced">{tx('Images per page', '每页图片数')}</div>
                <div className="slides-pill-row">
                  {[1, 2, 3, 4, 6].map((count) => (
                    <button
                      key={count}
                      type="button"
                      className={`slides-pill slides-pill--num ${Number(config.stylePageImageCount) === count ? 'is-active' : ''}`}
                      onClick={() => updateConfig({
                        stylePageImageCount: count,
                        imageSuffixes: buildDefaultStyleSuffixes(count),
                      })}
                    >
                      {count}
                    </button>
                  ))}
                </div>
                <div className="slides-hint">
                  {Number(config.stylePageImageCount) === 3
                    ? tx('Three-image mode keeps the big model image plus front/back layout on the right.', '三图模式：左侧大模特图 + 右侧正/反面图。')
                    : tx('Picture count controls how many images sit on the right side of each style page.', '所选数量决定每个款式页右侧的图片数。')}
                </div>

                <button
                  type="button"
                  className="slides-disclosure"
                  onClick={() => setShowSuffixEditor((v) => !v)}
                >
                  {tx('Customize image suffixes', '自定义图片后缀')}
                  <span className="slides-disclosure-meta">
                    {config.imageSuffixes.filter(Boolean).join(' / ') || tx('default', '默认')}
                  </span>
                  <span className="slides-disclosure-toggle">{showSuffixEditor ? tx('Hide', '收起') : tx('Edit', '编辑')}</span>
                </button>
                {showSuffixEditor && (
                  <div className="slides-suffix-grid">
                    {config.imageSuffixes.map((suffix, index) => (
                      <div key={`ppt-suffix-${index + 1}`} className="slides-suffix-cell">
                        <label>{tx(`Image ${index + 1}`, `第 ${index + 1} 张`)}</label>
                        <input
                          type="text"
                          value={suffix}
                          onChange={(event) => {
                            const nextSuffixes = [...config.imageSuffixes];
                            nextSuffixes[index] = event.target.value;
                            updateConfig({ imageSuffixes: nextSuffixes });
                          }}
                        />
                      </div>
                    ))}
                    <div className="slides-hint slides-hint--full">
                      {tx(
                        'Type suffixes like F or X01 — actual filenames are matched as _F or _X01 to avoid colliding with style numbers ending with the same letters.',
                        '填入 F、X01 等后缀；实际匹配 _F、_X01，避免与款号末尾字母混淆。',
                      )}
                    </div>
                  </div>
                )}

                <label className="slides-check slides-check--standalone">
                  <input
                    type="checkbox"
                    checked={config.fillMissingSlots !== false}
                    onChange={(e) => updateConfig({ fillMissingSlots: e.target.checked })}
                  />
                  <span>
                    {tx('Fill empty slots with unused images', '名称未匹配时用未插入的图片填充')}
                    <span className="slides-check-hint">
                      {tx(
                        'When a named slot has no matching file, use any leftover image instead of leaving it blank. Slots stay empty only if the folder runs out of images.',
                        '当某个位置按名称没匹配到图片时，自动用文件夹里还没用过的图片填充；只有图片数量不够时才会留空。',
                      )}
                    </span>
                  </span>
                </label>
              </div>
            </section>
          )}

          {/* ─── STEP 4: Content fields ─── */}
          <section className="slides-step">
            <div className="slides-step-head">
              <span className="slides-step-num">{isStyleMode ? '4' : '3'}</span>
              <h3>{tx('What to include on each page', '每页显示哪些信息')}</h3>
            </div>
            <div className="slides-step-body">

              <div className="slides-field-group">
                <div className="slides-field-group-title">{tx('Basic', '基础')}</div>
                <div className="slides-checkbox-grid">
                  <label className="slides-check"><input type="checkbox" checked={config.includeStyleNumber} onChange={(e) => updateConfig({ includeStyleNumber: e.target.checked })} /><span>{tx('Style Number', '款号')}</span></label>
                  <label className="slides-check"><input type="checkbox" checked={config.includeName} onChange={(e) => updateConfig({ includeName: e.target.checked })} /><span>{tx('Product Name', '产品名称')}</span></label>
                  {isStyleMode && (
                    <label className="slides-check"><input type="checkbox" checked={config.includePrice} onChange={(e) => updateConfig({ includePrice: e.target.checked })} /><span>{tx('Price', '价格')}</span></label>
                  )}
                </div>
              </div>

              <div className="slides-field-group">
                <div className="slides-field-group-title">{tx('Fabric', '面料信息')}</div>
                <div className="slides-checkbox-grid">
                  <label className="slides-check"><input type="checkbox" checked={config.includeFabricCode} onChange={(e) => updateConfig({ includeFabricCode: e.target.checked })} /><span>{tx('Fabric Code', '面料代码')}</span></label>
                  <label className="slides-check"><input type="checkbox" checked={config.includeComposition} onChange={(e) => updateConfig({ includeComposition: e.target.checked })} /><span>{tx('Composition', '成分')}</span></label>
                  <label className="slides-check"><input type="checkbox" checked={config.includeWidth} onChange={(e) => updateConfig({ includeWidth: e.target.checked })} /><span>{tx('Width', '门幅')}</span></label>
                  <label className="slides-check"><input type="checkbox" checked={config.includeCuttable} onChange={(e) => updateConfig({ includeCuttable: e.target.checked })} /><span>{tx('Cuttable', '可裁门幅')}</span></label>
                  <label className="slides-check"><input type="checkbox" checked={config.includeWeight} onChange={(e) => updateConfig({ includeWeight: e.target.checked })} /><span>{tx('Weight', '克重')}</span></label>
                </div>
              </div>

              <div className="slides-field-group">
                <div className="slides-field-group-title">{tx('Description & AI Fill', '描述与 AI 补全')}</div>
                <label className="slides-check slides-check--wide">
                  <input type="checkbox" checked={config.includeDescription} onChange={(e) => updateConfig({ includeDescription: e.target.checked })} />
                  <span>{tx('Show description on slides', '在 PPT 中显示描述文字')}</span>
                </label>

                {(config.includeDescription || config.includeName) && (
                  <div className="slides-ai-block">
                    <label className="slides-check slides-check--wide slides-check--ai">
                      <input type="checkbox" checked={ollamaEnabled} onChange={(e) => setOllamaEnabled(e.target.checked)} />
                      <span>
                        <strong>{tx('Let AI fill missing product name / description from images', '让 AI 根据产品图自动补全缺失的产品名称、描述')}</strong>
                        <em>{tx('Only fields that are checked AND empty are filled — existing text is always kept.', '只补「已勾选且为空」的字段，已有内容一律保留。')}</em>
                      </span>
                    </label>

                    {ollamaEnabled && (
                      <div className="slides-ai-controls">
                        {!llmConfigReady ? (
                          <div className="slides-ai-status">{tx('Loading saved AI settings…', '正在加载 AI 设置…')}</div>
                        ) : (
                          <>
                            <div className="slides-ai-mode-row">
                              <span className="slides-ai-mode-label">{tx('AI Mode', 'AI 模式')}</span>
                              <div className="slides-pill-row slides-pill-row--tight">
                                <button
                                  type="button"
                                  className={`slides-pill ${aiModeOverride === 'local' ? 'is-active' : ''}`}
                                  onClick={() => setAiModeOverride('local')}
                                >
                                  {tx('Local', '本地')}
                                </button>
                                <button
                                  type="button"
                                  className={`slides-pill ${aiModeOverride === 'cloud' ? 'is-active' : ''}`}
                                  onClick={() => setAiModeOverride('cloud')}
                                >
                                  {tx('Cloud', '云端')}
                                </button>
                                <button
                                  type="button"
                                  className={`slides-pill ${aiModeOverride === 'apiCloud' ? 'is-active' : ''}`}
                                  onClick={() => setAiModeOverride('apiCloud')}
                                >
                                  {tx('API Cloud', 'API 云端')}
                                </button>
                              </div>
                            </div>
                            <div className="slides-ai-status">
                              {effectiveSlidesAiMode === 'cloud'
                                ? <>{tx('Using cloud:', '使用云端：')} {llmConfig?.cloud?.baseUrl || tx('Not configured', '未配置')}</>
                                : effectiveSlidesAiMode === 'apiCloud'
                                  ? <>{tx('Using API:', '使用 API：')} {getActiveApiCloudPreset(llmConfig)?.name || getActiveApiCloudPreset(llmConfig)?.baseUrl || tx('Not configured', '未配置')}</>
                                  : <>{tx('Using local:', '使用本地：')} {llmConfig?.local?.baseUrl || 'localhost:11434'}</>}
                            </div>
                            <div className="slides-ai-model-picker">
                              <LLMEndpointModelPicker
                                llmConfig={llmConfig}
                                mode={aiModeOverride}
                                onModeChange={setAiModeOverride}
                                model={aiModelOverride}
                                onModelChange={setAiModelOverride}
                                disabled={isGenerating}
                                showDefaultOption={false}
                                labels={{ endpointLabel: tx('AI endpoint', 'AI 端点'), modelLabel: tx('Model name', '模型名称') }}
                              />
                            </div>
                            {effectiveSlidesAiMode === 'local' && !aiModelOverride && (
                              <div className="slides-ai-status slides-ai-status--muted">
                                {tx('Recommended local stack:', '推荐本地栈：')} Moondream2 + GR3-Fabric
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* ─── Advanced ─── */}
          <section className="slides-step slides-step--advanced">
            <button
              type="button"
              className="slides-disclosure slides-disclosure--top"
              onClick={() => setShowAdvanced((v) => !v)}
            >
              {tx('Advanced options', '高级选项')}
              <span className="slides-disclosure-toggle">{showAdvanced ? tx('Hide', '收起') : tx('Show', '展开')}</span>
            </button>
            {showAdvanced && (
              <div className="slides-step-body">
                <div className="slides-sub-label">{tx('Output file', '输出文件')}</div>
                <button onClick={handleSelectOutput} className="slides-bigchoice slides-bigchoice--small">
                  <div className="slides-bigchoice-text">
                    <div className="slides-bigchoice-title">
                      {outputPath ? getPathLeaf(outputPath) : tx('Auto-named', '自动命名')}
                    </div>
                    <div className="slides-bigchoice-sub">{outputPath || tx('Save next to the source folder.', '与源文件夹相邻保存。')}</div>
                  </div>
                </button>

                <label className="slides-check slides-check--wide" style={{ marginTop: '0.6rem' }}>
                  <input
                    type="checkbox"
                    checked={forceRefresh}
                    onChange={(event) => setForceRefresh(event.target.checked)}
                  />
                  <span>
                    <strong>{tx('Ignore cache and re-run OCR / preprocess', '忽略缓存，重新执行 OCR / 预处理')}</strong>
                    <em>{tx('Slower but guarantees fresh results.', '较慢但保证使用最新结果。')}</em>
                  </span>
                </label>
              </div>
            )}
          </section>
        </div>

        {/* ─── Generate footer ─── */}
        <div className="slides-generate-footer">
          <button
            onClick={handleGenerate}
            disabled={!canGenerate}
            className="primary-button slides-generate-btn"
          >
            {isGenerating ? tx('Generating…', '生成中…') : tx('Generate PPT', '生成 PPT')}
          </button>
          {isGenerating && (
            <button onClick={handleCancel} disabled={isCancelling} className="secondary-button danger-button">
              {isCancelling ? tx('Cancelling…', '取消中…') : tx('Cancel', '取消')}
            </button>
          )}
          {!sourceFolder && (
            <div className="slides-generate-hint">
              {tx('Select a source folder first.', '请先选择源文件夹。')}
            </div>
          )}
        </div>

        {showConsolePanel && (
          <div className="preview-panel">
            <div className="panel-log-anchor">
              <ActivityConsole
                title={tx('Console', '控制台')}
                layout="dock"
                isVisible={workspaceVisible}
                logs={logs}
                onClear={handleClearLogs}
                onCancel={handleCancel}
                progress={progress}
                isActive={isGenerating}
                isCancelling={isCancelling}
                progressLabel={tx('Generating presentation', '正在生成演示文稿')}
                progressDetail={latestLogMessage || tx('Preparing slide layouts and writing the PowerPoint file.', '正在准备版式并写入 PowerPoint 文件。')}
                compactCount={10}
                completionState={completionFeedback?.state}
                completionTitle={completionFeedback?.title}
                completionMessage={completionFeedback?.message}
                completionMeta={completionFeedback?.meta}
                completionActions={completionActions}
                completionIssues={completionIssues}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

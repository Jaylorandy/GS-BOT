import React, { useEffect, useRef, useState } from 'react';
import ActivityConsole from './ActivityConsole';
import LLMEndpointModelPicker, { pickLlmEndpoint } from './LLMEndpointModelPicker';
import { useI18n } from '../utils/i18n';
import './BestsellerAnalysis.css';

const BRANDS = [
  { value: 'newyorker', label: 'New Yorker' },
];

const GENDERS = [
  { value: 'female', label: ['Women', '女装'] },
  { value: 'male', label: ['Men', '男装'] },
];

export default function BestsellerAnalysis({ homeFeature }) {
  const { tx } = useI18n();

  const [brand, setBrand] = useState('newyorker');
  const [gender, setGender] = useState('female');
  const [outputDir, setOutputDir] = useState('');
  const [imagesPerStyle, setImagesPerStyle] = useState(3);
  const [allColors, setAllColors] = useState(false);
  const [includeAccessories, setIncludeAccessories] = useState(false);
  const [language, setLanguage] = useState('en');
  const [llmMode, setLlmMode] = useState('default');
  const [llmModel, setLlmModel] = useState('');
  const [llmConfig, setLlmConfig] = useState(null);
  const [doAnalyze, setDoAnalyze] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Apply presets from the ModuleHome sub-feature selection.
  useEffect(() => {
    if (!homeFeature) return;
    switch (homeFeature) {
      case 'womens':
        setGender('female');
        setDoAnalyze(true);
        break;
      case 'mens':
        setGender('male');
        setDoAnalyze(true);
        break;
      case 'with-report':
        setDoAnalyze(true);
        break;
      case 'quick':
        setDoAnalyze(false);
        setImagesPerStyle(3);
        break;
      default:
        break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homeFeature]);

  const [logs, setLogs] = useState([]);
  const [progress, setProgress] = useState(0);
  const [isScraping, setIsScraping] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [scrapedDir, setScrapedDir] = useState('');
  const [reportPath, setReportPath] = useState('');

  const addLog = (message, type = 'info') => {
    setLogs((prev) => [...prev, { time: new Date().toLocaleTimeString(), message, type }]);
  };

  useEffect(() => {
    if (!window.electronAPI) return undefined;
    window.electronAPI.onBestsellerLog?.((log) => setLogs((prev) => [...prev, log]));
    window.electronAPI.onBestsellerProgress?.((value) => {
      if (typeof value === 'number') setProgress(value);
    });
    return () => window.electronAPI.removeBestsellerListeners?.();
  }, []);

  // 加载已保存的 LLM 配置，用于前端实时透传所选端点（不再由后端读磁盘决定）
  useEffect(() => {
    window.electronAPI?.loadLLMConfig?.()
      .then((cfg) => setLlmConfig(cfg))
      .catch((error) => console.error('Failed to load LLM config:', error));
  }, []);

  const brandLabel = BRANDS.find((b) => b.value === brand)?.label || 'New Yorker';
  const genderLabel = gender === 'male' ? 'Men' : 'Women';
  const isBusy = isScraping || isAnalyzing;

  const handleSelectOutput = async () => {
    const dir = await window.electronAPI?.selectDir?.();
    if (dir) setOutputDir(dir);
  };

  const handleScrape = async () => {
    if (isBusy) return;
    setIsScraping(true);
    setProgress(0);
    setReportPath('');
    addLog(`${tx('Starting bestseller scrape', '开始抓取热门款式')}: ${brandLabel} · ${tx(genderLabel, genderLabel === 'Men' ? '男装' : '女装')}`, 'info');
    try {
      const result = await window.electronAPI?.bestsellerScrape?.({
        brand,
        gender,
        outputDir,
        imagesPerStyle: Number(imagesPerStyle) || 0,
        allColors,
        includeAccessories,
        downloadConcurrency: 6,
      });
      if (result?.success) {
        setScrapedDir(result.outputPath || outputDir);
        addLog(`${tx('Scrape complete', '抓取完成')}: ${result.styleCount} ${tx('styles', '款')}`, 'success');
        if (doAnalyze) {
          await runAnalyze(result.outputPath || outputDir);
        }
      } else {
        addLog(`${tx('Scrape failed', '抓取失败')}: ${result?.error || 'unknown'}`, 'error');
      }
    } catch (error) {
      addLog(`${tx('Scrape failed', '抓取失败')}: ${error.message}`, 'error');
    } finally {
      setIsScraping(false);
      setProgress(0);
    }
  };

  const runAnalyze = async (dir) => {
    const sourceDir = dir || scrapedDir;
    if (!sourceDir) { addLog(tx('Nothing to analyze yet — scrape first.', '还没有可分析的内容，请先抓取。'), 'warning'); return; }
    setIsAnalyzing(true);
    addLog(tx('Starting trend analysis…', '开始趋势分析…'), 'info');
    try {
      const result = await window.electronAPI?.bestsellerAnalyze?.({
        sourceDir,
        language,
        llmMode,
        llm: { ...pickLlmEndpoint(llmMode, llmConfig), model: llmModel || pickLlmEndpoint(llmMode, llmConfig)?.model || '' },
        imagesPerStyle: Number(imagesPerStyle) || 3,
        brandLabel,
        genderLabel,
      });
      if (result?.success) {
        setReportPath(result.outputPath || '');
        addLog(`${tx('Report generated', '报告已生成')}: ${result.outputPath}`, 'success');
      } else {
        addLog(`${tx('Analysis failed', '分析失败')}: ${result?.error || 'unknown'}`, 'error');
      }
    } catch (error) {
      addLog(`${tx('Analysis failed', '分析失败')}: ${error.message}`, 'error');
    } finally {
      setIsAnalyzing(false);
      setProgress(0);
    }
  };

  const handleCancel = async () => {
    await window.electronAPI?.cancelTask?.('bestseller');
    addLog(tx('Cancellation requested…', '已请求取消…'), 'warning');
  };

  const openPath = (p) => { if (p) window.electronAPI?.openLocalPath?.(p); };
  const revealPath = (p) => { if (p) window.electronAPI?.revealLocalPath?.(p); };

  // Console becomes visible only once a run has started (matches the Scraper).
  const showConsole = isBusy || logs.length > 0 || progress > 0 || Boolean(reportPath);
  const progressLabel = isScraping
    ? tx('Scraping bestsellers', '抓取热门款式中')
    : isAnalyzing
      ? tx('Analyzing trends', '趋势分析中')
      : (progress >= 100 ? tx('Done', '已完成') : tx('Task progress', '任务进度'));

  return (
    <div className="bestseller-container">
      <div className="bestseller-header">
        <div className="bestseller-header-text">
          <h2>{tx('Bestseller Analysis', '热门款式分析')}</h2>
          <p>{tx('Scrape bestseller listings and generate an AI fashion-trend report.', '抓取畅销榜款式并生成 AI 流行趋势报告。')}</p>
        </div>
        {showConsole && (
          <ActivityConsole
            title="Console"
            layout="dock"
            logs={logs}
            onClear={() => { setLogs([]); setProgress(0); }}
            onCancel={handleCancel}
            progress={progress}
            isActive={isBusy}
            progressLabel={progressLabel}
            compactCount={10}
          />
        )}
      </div>

      <div className="bestseller-body">
        {/* STEP 1 — Configure */}
        <section className="bs-step">
          <div className="bs-step-head"><span className="bs-step-num">1</span><h3>{tx('Configure', '设置抓取')}</h3></div>
          <div className="bs-step-body">
            <div className="bs-field-row">
              <label>{tx('Category', '类别')}</label>
              <select value={gender} onChange={(e) => setGender(e.target.value)} disabled={isBusy}>
                {GENDERS.map((g) => <option key={g.value} value={g.value}>{tx(g.label[0], g.label[1])}</option>)}
              </select>
            </div>
            <div className="bs-field-row">
              <label>{tx('Output folder', '输出文件夹')}</label>
              <div className="bs-file">
                <button onClick={handleSelectOutput} disabled={isBusy} className="bs-btn-sm">{tx('Choose', '选择')}</button>
                <span className="bs-path">{outputDir || tx('Desktop (default)', '桌面（默认）')}</span>
              </div>
            </div>
            <label className="bs-check">
              <input type="checkbox" checked={doAnalyze} onChange={(e) => setDoAnalyze(e.target.checked)} disabled={isBusy} />
              <span>{tx('Run AI trend analysis after download (step 4)', '下载后自动运行 AI 趋势分析（第四步）')}</span>
            </label>
            <button
              type="button"
              className="advanced-toggle"
              onClick={() => setShowAdvanced(!showAdvanced)}
            >
              {showAdvanced ? tx('▾ Hide advanced', '▾ 收起高级选项') : tx('▸ Advanced', '▸ 高级选项')}
            </button>
            {showAdvanced && (
              <>
                <div className="bs-field-row">
                  <label>{tx('Colors', '颜色')}</label>
                  <select value={allColors ? 'all' : 'one'} onChange={(e) => setAllColors(e.target.value === 'all')} disabled={isBusy}>
                    <option value="one">{tx('One color per style', '每款一个颜色')}</option>
                    <option value="all">{tx('All colors', '抓取全部颜色')}</option>
                  </select>
                </div>
                <div className="bs-field-row">
                  <label>{tx('Images per style', '每款图片数')}</label>
                  <select value={imagesPerStyle} onChange={(e) => setImagesPerStyle(Number(e.target.value))} disabled={isBusy}>
                    <option value={0}>{tx('All', '全部')}</option>
                    {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
                <div className="bs-field-row">
                  <label>{tx('Report language', '报告语言')}</label>
                  <select value={language} onChange={(e) => setLanguage(e.target.value)} disabled={isBusy}>
                    <option value="en">English</option>
                    <option value="zh">中文</option>
                  </select>
                </div>
                <div className="bs-field-row">
                  <label>{tx('Analysis model', '分析模型')}</label>
                  <LLMEndpointModelPicker
                    llmConfig={llmConfig}
                    mode={llmMode}
                    onModeChange={setLlmMode}
                    model={llmModel}
                    onModelChange={setLlmModel}
                    disabled={isBusy}
                    labels={{ endpointLabel: tx('AI endpoint', 'AI 端点'), modelLabel: tx('Model name', '模型名称') }}
                  />
                </div>
                <label className="bs-check">
                  <input type="checkbox" checked={includeAccessories} onChange={(e) => setIncludeAccessories(e.target.checked)} disabled={isBusy} />
                  <span>{tx('Include footwear & accessories (default: apparel only)', '包含鞋履和配饰（默认仅服装）')}</span>
                </label>
              </>
            )}
          </div>
        </section>

        {/* STEP 2/3 — Scrape + Download */}
        <section className="bs-step">
          <div className="bs-step-head"><span className="bs-step-num">2·3</span><h3>{tx('Scrape & Download', '抓取并下载')}</h3></div>
          <div className="bs-step-body">
            <p className="bs-hint">{tx('Opens the bestseller listing, harvests every style across all pages, then downloads images + info.', '打开畅销榜页面，翻页抓取所有款式，然后下载图片和信息。')}</p>
            <div className="bs-actions">
              <button onClick={handleScrape} disabled={isBusy} className="bs-btn-primary">
                {isScraping ? tx('Scraping…', '抓取中…') : tx('Start Scrape', '开始抓取')}
              </button>
              {isBusy && <button onClick={handleCancel} className="bs-btn-sm">{tx('Cancel', '取消')}</button>}
            </div>
          </div>
        </section>

        {/* STEP 4 — Analyze */}
        <section className="bs-step">
          <div className="bs-step-head"><span className="bs-step-num">4</span><h3>{tx('Analyze (optional)', '分析（可选）')}</h3></div>
          <div className="bs-step-body">
            <p className="bs-hint">{tx('Vision + text models read each style and produce a trend-overview Word report.', '视觉+文本模型解读每个款式，生成趋势总览 Word 报告。')}</p>
            <div className="bs-actions">
              <button onClick={() => runAnalyze()} disabled={isBusy || !scrapedDir} className="bs-btn-primary">
                {isAnalyzing ? tx('Analyzing…', '分析中…') : tx('Run Analysis', '开始分析')}
              </button>
              {reportPath && (
                <>
                  <button onClick={() => openPath(reportPath)} className="bs-btn-sm">{tx('Open Report', '打开报告')}</button>
                  <button onClick={() => revealPath(reportPath)} className="bs-btn-sm">{tx('Show in Folder', '在文件夹中显示')}</button>
                </>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

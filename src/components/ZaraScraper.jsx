import React, { useState, useEffect, useRef } from 'react';
import ActivityConsole from './ActivityConsole';
import LLMEndpointModelPicker, { pickLlmEndpoint } from './LLMEndpointModelPicker';
import { useI18n } from '../utils/i18n';
import './ZaraScraper.css';

function getPathLeaf(value = '') {
  return String(value || '')
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .filter(Boolean)
    .pop() || '';
}

function getBrandLabel(brand) {
  if (brand === 'mixed') return 'Mixed Brands';
  if (brand === 'bershka') return 'Bershka';
  if (brand === 'stradivarius') return 'Stradivarius';
  if (brand === 'pullandbear') return 'Pull&Bear';
  if (brand === 'lefties') return 'Lefties';
  if (brand === 'mango') return 'Mango';
  if (brand === 'reserved') return 'Reserved';
  if (brand === 'sinsay') return 'Sinsay';
  if (brand === 'urbanrevivo') return 'Urban Revivo';
  if (brand === 'newyorker') return 'New Yorker';
  if (brand === 'hm') return 'H&M';
  if (brand === 'uniqlo') return 'UNIQLO';
  if (brand === 'gu') return 'GU';
  if (brand === 'abercrombie') return 'Abercrombie & Fitch';
  return 'Zara';
}

function parseManualStyleNumbers(value = '') {
  return String(value || '')
    .split(/[\n\r,，、;；\t]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildScrapeStatus(logs = []) {
  const items = new Map();
  let totalCount = 0;

  const ensureItem = (styleNumber) => {
    const key = String(styleNumber || '').trim();
    if (!key) return null;
    if (!items.has(key)) {
      items.set(key, {
        styleNumber: key,
        status: 'pending',
        detail: '',
      });
    }
    return items.get(key);
  };

  logs.forEach((log) => {
    const message = String(log?.message || '');

    const totalMatch = message.match(/Loaded\s+(\d+)\s+.+?\sfrom Excel\./i);
    if (totalMatch) {
      totalCount = Number(totalMatch[1]) || totalCount;
    }

    const rawInputMatch = message.match(/🎯\s+.+?input raw:\s+"([^"]+)"/i);
    if (rawInputMatch) {
      const styleNumber = rawInputMatch[1].replace(/\s+/g, '');
      const item = ensureItem(styleNumber);
      if (item && item.status === 'pending') {
        item.status = 'processing';
        item.detail = '处理中';
      }
    }

    const replacementMatch = message.match(/replacement product resolved:\s*(\d+)\s*→\s*(\d+)/i);
    if (replacementMatch) {
      const item = ensureItem(replacementMatch[1]);
      if (item) {
        item.status = 'replacement';
        item.detail = `替代款号 ${replacementMatch[2]}`;
      }
    }

    const substituteMatch = message.match(/🔁\s+\S+\s+substitute resolved:\s*(\d+)\s*→\s*(\d+)/i);
    if (substituteMatch) {
      const item = ensureItem(substituteMatch[1]);
      if (item) {
        item.status = 'replacement';
        item.detail = `替代款号 ${substituteMatch[2]}`;
      }
    }

    // Accept alphanumeric SKUs (e.g. Reserved "9430n-09m" or "WK490-39M") on
    // top of the original digit-only Zara/Bershka pattern. Normalise to upper
    // case so the slug-derived key can match the raw-input row created from
    // the original SKU spelling.
    const successMatch = message.match(/✅\s+.+?\s+([A-Za-z0-9][A-Za-z0-9/.\-]*)\s+captured\s+\|.*?\|\s+(\d+)\s+images/i);
    if (successMatch) {
      const styleNumber = successMatch[1].replace(/\s+/g, '');
      const imageCount = successMatch[2];
      const digitsOnly = styleNumber.replace(/[^\d]/g, '');
      const candidates = Array.from(new Set([
        styleNumber,
        styleNumber.toUpperCase(),
        digitsOnly,
      ].filter(Boolean)));
      // First try exact candidates (digitsOnly handles dotted article numbers
      // like New Yorker "03.01.040.0307" → raw-input row "03010400307").
      let item = candidates.map((key) => items.get(key)).find(Boolean);
      if (!item) {
        // Prefix fallback for SKUs that resolve to a longer code (e.g. Reserved
        // input "WK490" matched "WK490-59M"). Compare on digits when both sides
        // are purely numeric to avoid dotted-article false collisions.
        const skuUpper = styleNumber.toUpperCase();
        item = [...items.keys()].reduce((found, key) => {
          if (found) return found;
          const k = String(key || '').toUpperCase();
          if (k.length < 3) return null;
          const kDigits = k.replace(/[^\d]/g, '');
          // If both are all-digit codes, require an exact digit match (no prefix)
          // so 03010400307 / 03011100087 don't cross-match on a short "03".
          if (digitsOnly && kDigits && /^\d+$/.test(skuUpper.replace(/[^\d]/g, '')) && /^\d+$/.test(k)) {
            return kDigits === digitsOnly ? items.get(key) : null;
          }
          if (skuUpper.startsWith(k) || k.startsWith(skuUpper)) {
            return items.get(key);
          }
          return null;
        }, null);
      }
      if (!item) item = ensureItem(candidates[0]);
      if (item) {
        item.status = 'success';
        item.detail = `${imageCount} 张图`;
      }
    }

    const incompleteMatch = message.match(/❌\s+\S+\s+(\d[\d/]*)\s+incomplete\s+\|.*?\|\s+(.+)$/i);
    if (incompleteMatch) {
      const styleNumber = incompleteMatch[1].replace(/[^\d]/g, '');
      const reason = incompleteMatch[2].trim();
      const item = ensureItem(styleNumber);
      if (item) {
        item.status = 'failed';
        if (/0 images/i.test(reason) && /no description|no composition/i.test(reason)) {
          item.detail = '图片与文本均缺失';
        } else if (/0 images/i.test(reason)) {
          item.detail = '图片未抓到';
        } else if (/no description|no composition/i.test(reason)) {
          item.detail = '文本未抓到';
        } else {
          item.detail = reason;
        }
      }
    }

    const failedMatch = message.match(/⚠️\s+.+?reference failed\s+\(\d+\/\d+\):\s+(.+?)\s+->\s+(.+)$/i);
    if (failedMatch) {
      const styleNumber = failedMatch[1].replace(/[^\d]/g, '');
      const reason = failedMatch[2].trim();
      const item = ensureItem(styleNumber);
      if (item) {
        item.status = 'failed';
        if (/No .*product was found|Product not found|No GU product was found/i.test(reason)) {
          item.detail = '未找到产品';
        } else if (/Access Denied|site blocked|verification required/i.test(reason)) {
          item.detail = '站点拦截/需验证';
        } else if (/Execution context was destroyed|frame was detached|navigation/i.test(reason)) {
          item.detail = '页面跳转中断';
        } else if (/No product images found|0 images/i.test(reason)) {
          item.detail = '图片未抓到';
        } else {
          item.detail = reason;
        }
      }
    }

    const blockedMatch = message.match(/⛔\s+.+?site blocked:\s+(.+)$/i);
    if (blockedMatch) {
      items.forEach((item) => {
        if (item.status === 'processing' || item.status === 'pending') {
          item.status = 'failed';
          item.detail = '站点拦截/需验证';
        }
      });
    }

    // Stradivarius custom failure lines (and any future brand using the same
    // localized pattern). Mark the row as failed so the table doesn't stay
    // stuck on 处理中 after the run finishes.
    const secondPassFail = message.match(/❌\s*第二轮仍失败:\s*([^\s,]+)/);
    if (secondPassFail) {
      const styleNumber = secondPassFail[1].replace(/\s+/g, '');
      const item = ensureItem(styleNumber);
      if (item) {
        item.status = 'failed';
        if (!item.detail || item.detail === '处理中') item.detail = '第二轮仍失败';
      }
    }

    const summaryFail = message.match(/❌\s+(\d[\d/]*)\s*-\s*(.+)$/);
    if (summaryFail && !/incomplete/i.test(message)) {
      const styleNumber = summaryFail[1].replace(/[^\d]/g, '');
      const reason = summaryFail[2].trim();
      const item = ensureItem(styleNumber);
      if (item) {
        item.status = 'failed';
        if (/No .*product was found|Product not found/i.test(reason)) {
          item.detail = '未找到产品';
        } else if (/No product images found|0 images|No images/i.test(reason)) {
          item.detail = '图片未抓到';
        } else {
          item.detail = reason;
        }
      }
    }

    // After the brand summary line ("X styles succeeded, Y styles failed"),
    // anything still marked processing/pending is a failure with no specific
    // log line — flip it so the UI table reflects the real outcome.
    const summaryDone = message.match(/(\d+)\s+styles?\s+succeeded,\s+(\d+)\s+styles?\s+failed/i);
    const finishedDone = /(scraping finished|scraping complete|page extraction complete)/i.test(message);
    if (summaryDone || finishedDone) {
      items.forEach((item) => {
        if (item.status === 'processing' || item.status === 'pending') {
          item.status = 'failed';
          if (!item.detail || item.detail === '处理中') item.detail = '未完成';
        }
      });
    }
  });

  const rows = [...items.values()];
  return {
    totalCount,
    rows,
    successCount: rows.filter((item) => item.status === 'success').length,
    failedCount: rows.filter((item) => item.status === 'failed').length,
    replacementCount: rows.filter((item) => item.status === 'replacement').length,
    processingCount: rows.filter((item) => item.status === 'processing').length,
  };
}

function ZaraScraper({ workspaceVisible = true, homeFeature }) {
  const { tx } = useI18n();
  const [brand, setBrand] = useState('zara');
  const [styleNumbers, setStyleNumbers] = useState('');
  const [excelPath, setExcelPath] = useState('');
  const [outputDir, setOutputDir] = useState('');
  const [downloadConcurrency, setDownloadConcurrency] = useState(10);
  const [logs, setLogs] = useState([]);
  const [progress, setProgress] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [isAnnotating, setIsAnnotating] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [zaraBackupMode, setZaraBackupMode] = useState(false);
  const [activeTask, setActiveTask] = useState('');
  const [completionFeedback, setCompletionFeedback] = useState(null);
  const [excelPreview, setExcelPreview] = useState(null); // { total, byBrand }
  const [mixedBrandInputs, setMixedBrandInputs] = useState({
    zara: '', bershka: '', stradivarius: '', pullandbear: '', lefties: '', mango: '', uniqlo: '', gu: '',
  });
  const [llmMode, setLlmMode] = useState('default');
  const [llmModel, setLlmModel] = useState('');
  const [llmConfig, setLlmConfig] = useState(null);
  const [doAnalyze, setDoAnalyze] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [language, setLanguage] = useState('en');
  const [reportPath, setReportPath] = useState('');
  const [scrapedOutputDir, setScrapedOutputDir] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Apply presets from the ModuleHome sub-feature selection.
  const excelPickerRef = useRef(false);
  useEffect(() => {
    if (!homeFeature) return;
    switch (homeFeature) {
      case 'quick-scrape':
        setBrand('zara');
        setDoAnalyze(false);
        break;
      case 'mixed-brands':
        setBrand('mixed');
        break;
      case 'from-excel':
        excelPickerRef.current = true;
        break;
      case 'with-ai':
        setDoAnalyze(true);
        break;
      default:
        break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homeFeature]);

  // Trigger Excel picker after render if requested by the preset.
  useEffect(() => {
    if (excelPickerRef.current) {
      excelPickerRef.current = false;
      handleSelectExcel();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homeFeature]);

  useEffect(() => {
    if (window.electronAPI) {
      window.electronAPI.onLog((log) => setLogs(prev => [...prev, log]));
      window.electronAPI.onProgress((value) => setProgress(value));
      window.electronAPI.onBestsellerLog?.((log) => setLogs(prev => [...prev, log]));
      window.electronAPI.onBestsellerProgress?.((value) => {
        if (typeof value === 'number') setProgress(value);
      });
      window.electronAPI.loadLLMConfig?.()
        .then((cfg) => setLlmConfig(cfg))
        .catch((error) => console.error('Failed to load LLM config:', error));
    }
    return () => {
      if (window.electronAPI) {
        window.electronAPI.removeListeners();
        window.electronAPI.removeBestsellerListeners?.();
      }
    };
  }, []);

  const appendConsoleError = (prefix, error) => {
    setLogs((prev) => [
      ...prev,
      {
        time: new Date().toLocaleTimeString(),
        message: `${prefix}: ${error || 'Unknown error'}`,
        type: 'error',
      },
    ]);
  };

  const openLocalPath = async (targetPath) => {
    if (!targetPath || !window.electronAPI?.openLocalPath) {
      return;
    }

    const result = await window.electronAPI.openLocalPath(targetPath);
    if (!result?.success) {
      appendConsoleError('Open failed', result?.error);
    }
  };

  const revealLocalPath = async (targetPath) => {
    if (!targetPath || !window.electronAPI?.revealLocalPath) {
      return;
    }

    const result = await window.electronAPI.revealLocalPath(targetPath);
    if (!result?.success) {
      appendConsoleError('Reveal failed', result?.error);
    }
  };

  const handleSelectDir = async () => {
    if (window.electronAPI) { const dir = await window.electronAPI.selectDir(); if (dir) setOutputDir(dir); }
  };
  const refreshExcelPreview = async (path, brandOverride) => {
    if (!path || !window.electronAPI?.previewExcel) {
      setExcelPreview(null);
      return;
    }
    try {
      const result = await window.electronAPI.previewExcel({ excelPath: path, brand: brandOverride || brand });
      if (result?.success) {
        setExcelPreview({ total: result.total || 0, byBrand: result.byBrand || {} });
      } else {
        setExcelPreview(null);
      }
    } catch {
      setExcelPreview(null);
    }
  };

  const handleSelectExcel = async () => {
    if (window.electronAPI) {
      const f = await window.electronAPI.selectFile();
      if (f) {
        setExcelPath(f);
        await refreshExcelPreview(f, brand);
      }
    }
  };

  // Refresh preview when brand changes
  useEffect(() => {
    if (excelPath) {
      refreshExcelPreview(excelPath, brand);
    } else {
      setExcelPreview(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brand, excelPath]);
  const aggregatedMixedCount = brand === 'mixed'
    ? Object.values(mixedBrandInputs).reduce((sum, v) => sum + parseManualStyleNumbers(v || '').length, 0)
    : 0;
  const buildMixedBrandEntries = () => {
    const entries = [];
    Object.entries(mixedBrandInputs).forEach(([brandKey, raw]) => {
      const list = parseManualStyleNumbers(raw || '');
      list.forEach((styleNumber) => {
        entries.push({ brand: brandKey, styleNumber });
      });
    });
    return entries;
  };

  const handleStart = async () => {
    setIsRunning(true);
    setIsCancelling(false);
    setActiveTask('scrape');
    setCompletionFeedback(null);
    setLogs([]);
    setProgress(0);
    const config = {
      brand,
      styleNumbers: parseManualStyleNumbers(styleNumbers),
      mixedBrandEntries: brand === 'mixed' ? buildMixedBrandEntries() : null,
      excelPath: excelPath || null, outputDir,
      zaraBackupMode: brand === 'zara' ? zaraBackupMode : false,
      tabConcurrency: parseInt(downloadConcurrency), downloadConcurrency: parseInt(downloadConcurrency)
    };
    if (window.electronAPI) {
      const result = await window.electronAPI.startTask(config);
      if (!result.success && !result.cancelled) {
        setProgress(0);
        setCompletionFeedback(null);
        setLogs(prev => [...prev, { time: new Date().toLocaleTimeString(), message: result.error, type: 'error' }]);
      } else if (result.success) {
        setProgress(100);
        const currentBrandLabel = getBrandLabel(brand);
        const scrapedDir = outputDir || '';
        setScrapedOutputDir(scrapedDir);
        setCompletionFeedback({
          state: 'success',
          title: `${currentBrandLabel} scraping complete`,
          message: 'Assets and metadata are ready for the next step.',
          meta: [
            excelPath ? `Excel queue` : `${config.styleNumbers.length} styles`,
            outputDir ? `Output · ${getPathLeaf(outputDir)}` : 'Output ready',
          ],
          outputPath: scrapedDir,
          outputKind: 'folder',
        });
        if (doAnalyze && scrapedDir) {
          await handleAnalyze(scrapedDir);
        }
      } else {
        setProgress(0);
        setCompletionFeedback(null);
      }
    }
    setIsRunning(false);
    setIsCancelling(false);
    setActiveTask('');
  };
  const handleAnnotate = async () => {
    if (!excelPath) return;
    setIsAnnotating(true);
    setIsCancelling(false);
    setActiveTask('annotate');
    setCompletionFeedback(null);
    setLogs([]);
    setProgress(18);
    if (window.electronAPI) {
      const result = await window.electronAPI.annotateExcel({ excelPath, outputDir, brand });
      setProgress(result.success ? 100 : 0);
      if (!result.cancelled) {
        setLogs(prev => [...prev, { time: new Date().toLocaleTimeString(), message: result.success ? result.message : result.error, type: result.success ? 'success' : 'error' }]);
      }
      if (result.success) {
        setCompletionFeedback({
          state: 'success',
          title: `${getBrandLabel(brand)} workbook updated`,
          message: 'The Excel file has been marked with the latest scrape results.',
          meta: [
            getPathLeaf(result.outputPath || excelPath),
            outputDir ? `Output · ${getPathLeaf(outputDir)}` : 'Workbook ready',
          ],
          outputPath: result.outputPath || excelPath,
          outputKind: 'file',
        });
      } else if (!result.cancelled) {
        setCompletionFeedback(null);
      }
    }
    setIsAnnotating(false);
    setIsCancelling(false);
    setActiveTask('');
  };

  const handleAnalyze = async (dir) => {
    const sourceDir = dir || scrapedOutputDir;
    if (!sourceDir) {
      setLogs(prev => [...prev, { time: new Date().toLocaleTimeString(), message: tx('Nothing to analyze yet — scrape first.', '还没有可分析的内容，请先抓取。'), type: 'warning' }]);
      return;
    }
    setIsAnalyzing(true);
    setActiveTask('analyze');
    setReportPath('');
    setLogs(prev => [...prev, { time: new Date().toLocaleTimeString(), message: tx('Starting trend analysis…', '开始趋势分析…'), type: 'info' }]);
    try {
      const result = await window.electronAPI?.bestsellerAnalyze?.({
        sourceDir,
        language,
        llmMode,
        llm: pickLlmEndpoint(llmMode, llmConfig, llmModel),
        imagesPerStyle: 3,
        brandLabel,
        genderLabel: '',
      });
      if (result?.success) {
        setReportPath(result.outputPath || '');
        setProgress(100);
        setCompletionFeedback({
          state: 'success',
          title: tx('Trend analysis complete', '趋势分析完成'),
          message: tx('Report generated from scraped data.', '已从抓取数据生成趋势报告。'),
          meta: [
            getPathLeaf(result.outputPath),
            `Source · ${getPathLeaf(sourceDir)}`,
          ],
          outputPath: result.outputPath || '',
          outputKind: 'file',
        });
        setLogs(prev => [...prev, { time: new Date().toLocaleTimeString(), message: `${tx('Report generated', '报告已生成')}: ${result.outputPath}`, type: 'success' }]);
      } else {
        setLogs(prev => [...prev, { time: new Date().toLocaleTimeString(), message: `${tx('Analysis failed', '分析失败')}: ${result?.error || 'unknown'}`, type: 'error' }]);
        setCompletionFeedback(null);
      }
    } catch (error) {
      setLogs(prev => [...prev, { time: new Date().toLocaleTimeString(), message: `${tx('Analysis failed', '分析失败')}: ${error.message}`, type: 'error' }]);
      setCompletionFeedback(null);
    } finally {
      setIsAnalyzing(false);
      setActiveTask('');
      setProgress(0);
    }
  };

  const latestLogMessage = logs[logs.length - 1]?.message || '';
  const isActive = isRunning || isAnnotating || isAnalyzing;
  const brandLabel = getBrandLabel(brand);
  const scrapeStatus = buildScrapeStatus(logs);

  const getStyleLabel = () => {
    if (brand === 'mixed') return 'Brand + Style';
  if (brand === 'zara') return 'Style Numbers';
  if (brand === 'bershka') return 'SKU Numbers';
  if (brand === 'pullandbear') return 'SKU Numbers';
  if (brand === 'lefties') return 'SKU Numbers';
  if (brand === 'mango') return 'SKU Numbers';
  if (brand === 'reserved') return 'SKU Numbers';
  if (brand === 'sinsay') return 'SKU Numbers';
  if (brand === 'urbanrevivo') return 'SKU Numbers';
  if (brand === 'newyorker') return 'Article Numbers';
  if (brand === 'hm') return 'Article Numbers';
  if (brand === 'uniqlo') return 'Product ID';
    if (brand === 'gu') return 'Product ID';
    if (brand === 'abercrombie') return 'Style Numbers';
    return 'Style Numbers';
  };

  const getPlaceholder = () => {
    if (brand === 'mixed') return 'Use Excel import for mixed-brand queues';
    if (brand === 'zara') return 'Enter style numbers, comma separated';
    if (brand === 'bershka') return 'Enter Bershka SKU numbers, comma separated';
    if (brand === 'pullandbear') return 'Enter Pull&Bear SKU numbers, comma separated';
    if (brand === 'lefties') return 'Enter Lefties SKU numbers, comma separated';
    if (brand === 'mango') return 'Enter Mango SKU numbers, comma separated';
    if (brand === 'reserved') return 'Enter Reserved SKU numbers (e.g. WK490-39M), comma separated';
    if (brand === 'sinsay') return 'Enter Sinsay SKU numbers (e.g. 010HI-59X), comma separated';
    if (brand === 'urbanrevivo') return 'Enter Urban Revivo SKU numbers (e.g. UWJ750051), comma separated';
    if (brand === 'newyorker') return 'Enter New Yorker article numbers (e.g. 03.01.010.0134), comma separated';
    if (brand === 'hm') return 'Enter H&M article numbers (e.g. 1342946001), comma separated';
    if (brand === 'uniqlo') return 'Enter UNIQLO product IDs, comma separated';
    if (brand === 'gu') return 'Enter GU product IDs, comma separated';
    if (brand === 'abercrombie') return 'Enter A&F style numbers (e.g. 63300319), comma separated';
    return 'Enter Stradivarius style numbers, comma separated';
  };

  const getExcelHint = () => {
    if (brand === 'mixed') return 'Use column A for brand names and column B for style numbers / product IDs. The scraper will route each row to the matching site automatically.';
    if (brand === 'zara') return 'Use column B for style numbers.';
    if (brand === 'bershka') return 'Use column B for Bershka SKU numbers. The scraper opens the English Bershka storefront and searches by SKU automatically.';
    if (brand === 'pullandbear') return 'Use column B for Pull&Bear 10-digit style/color numbers. The scraper resolves products from the English US storefront catalog.';
    if (brand === 'lefties') return 'Use column B for Lefties SKU numbers. The scraper opens the English Spanish Lefties storefront and searches by SKU automatically.';
    if (brand === 'mango') return 'Use column B for Mango SKU numbers. The scraper opens the English Mango storefront and searches by SKU automatically.';
    if (brand === 'reserved') return 'Use column B for Reserved SKU values (e.g. WK490-39M). The scraper opens the GB/EN Reserved storefront, types the SKU into the search box, and clicks the first result.';
    if (brand === 'sinsay') return 'Use column B for Sinsay SKU values (e.g. 010HI-59X). The scraper opens the Polish Sinsay storefront and searches by SKU. If the full SKU returns no results, it retries with just the prefix before the dash.';
    if (brand === 'urbanrevivo') return 'Use column B for Urban Revivo SKU values (e.g. UWJ750051). The scraper opens the global Urban Revivo storefront, clicks the top-right search icon, types the SKU into the sidebar, and opens the first result. Description tabs are expanded with size/care/use-cases/craft filtered out.';
    if (brand === 'newyorker') return 'Use column B for New Yorker article numbers (e.g. 03.01.010.0134). The scraper uses the official New Yorker JSON API — no browser — taking the first colour variant, full-HD images, and fabric composition. No product description is available for this brand.';
    if (brand === 'hm') return 'Use column B for H&M article numbers (e.g. 1342946001 — 7-digit product + 3-digit colour). The scraper opens the product page directly, expands the Description and Materials panels, and keeps the paragraph description, the Composition lines (Shell / Embroidery / Lining …), and the high-res images for that colour only.';
    if (brand === 'uniqlo') return 'Use column B for UNIQLO Product ID values. The scraper resolves the US English product page and saves English product metadata plus image folders. Note: flat front/back images cannot be identified with fully reliable standard naming for every style at the moment.';
    if (brand === 'gu') return 'Use column B for GU Product ID values. The scraper resolves the US English product page and saves description, fabric info, and images. Note: flat front/back images cannot be identified with fully reliable standard naming for every style at the moment.';
    if (brand === 'abercrombie') return 'Use column B for A&F style numbers (e.g. 63300319). The scraper opens the US storefront, searches by style number, clicks the first result, and extracts description and fabric composition from the Details & Materials panel (wash/care info excluded).';
    return 'Use column B for Stradivarius style numbers. The scraper resolves products from the English US storefront catalog and saves English metadata.';
  };

  const getProgressLabel = () => {
    if (isAnalyzing) return tx('Analyzing trends', '趋势分析中');
    if (isAnnotating) return 'Annotating workbook';
    if (isRunning) return `Scraping ${brandLabel}`;
    if (progress >= 100 && activeTask === 'annotate') return 'Workbook updated';
    if (progress >= 100 && activeTask === 'analyze') return tx('Analysis complete', '分析完成');
    if (progress >= 100) return `${brandLabel} scraping complete`;
    return 'Task progress';
  };

  const getProgressDetail = () => {
    if (latestLogMessage) {
      return latestLogMessage;
    }

    if (isAnnotating) {
      return 'Updating the selected Excel file with the latest scraper results.';
    }

    if (progress < 20) return `Preparing the ${brandLabel} scraping queue and validating inputs.`;
    if (progress < 55) return 'Opening product pages and collecting metadata.';
    if (progress < 85) return 'Downloading images and consolidating product assets.';
    if (progress < 100) return 'Finalizing exports and writing the result set.';
    return 'Everything finished successfully.';
  };

  const handleClearLogs = () => {
    setLogs([]);
    if (!isActive) {
      setProgress(0);
      setActiveTask('');
      setCompletionFeedback(null);
    }
  };

  const handleCancel = async () => {
    if (!window.electronAPI?.cancelTask || !activeTask || isCancelling) {
      return;
    }

    setIsCancelling(true);
    setLogs((prev) => [
      ...prev,
      {
        time: new Date().toLocaleTimeString(),
        message: 'Cancellation requested. Finishing the current step...',
        type: 'warning',
      },
    ]);

    await window.electronAPI.cancelTask(activeTask);
  };

  const completionActions = completionFeedback?.outputPath
    ? completionFeedback.outputKind === 'file'
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
      : [
          {
            label: tx('Open folder', '打开文件夹'),
            onClick: () => openLocalPath(completionFeedback.outputPath),
          },
          ...(scrapedOutputDir && !reportPath ? [{
            label: tx('Run Analysis', '开始分析'),
            onClick: () => handleAnalyze(scrapedOutputDir),
          }] : []),
        ]
    : [];

  return (
    <div className={`scraper-container ${isActive ? 'is-task-processing' : ''}`}>
      <div className="scraper-content">
        <div className="config-panel">
          <div className="config-section">
            <h3>{tx('Brand', '品牌')}</h3>
            <div className="setting-row">
              <label>{tx('Target site', '目标站点')}</label>
              <select value={brand} onChange={(e) => setBrand(e.target.value)}>
                <option value="mixed">Mixed Brands</option>
                <option value="zara">Zara</option>
                <option value="bershka">Bershka</option>
                <option value="stradivarius">Stradivarius</option>
                <option value="pullandbear">Pull&Bear</option>
                <option value="lefties">Lefties</option>
                <option value="mango">Mango</option>
                <option value="reserved">Reserved</option>
                <option value="sinsay">Sinsay</option>
                <option value="urbanrevivo">Urban Revivo</option>
                <option value="newyorker">New Yorker</option>
                <option value="hm">H&amp;M</option>
                <option value="uniqlo">UNIQLO</option>
                <option value="gu">GU</option>
                <option value="abercrombie">Abercrombie &amp; Fitch</option>
              </select>
            </div>
          </div>
          <div className="config-section">
            <h3>{tx(getStyleLabel(), brand === 'bershka' ? 'SKU 款号' : '款号')}</h3>
            {brand === 'mixed' ? (
              <p className="hint">
                {tx(
                  'Mixed Brands mode uses Excel import only. Select an Excel below (column A = brand, column B = style number).',
                  'Mixed Brands 模式仅支持 Excel 导入：A 列写品牌名，B 列写对应款号。',
                )}
              </p>
            ) : (
              <textarea
                className="style-input"
                placeholder={tx(
                  getPlaceholder(),
                  brand === 'bershka'
                    ? '输入 Bershka SKU 款号，用逗号分隔'
                    : brand === 'pullandbear'
                      ? '输入 Pull&Bear 10位款号，用逗号分隔'
                    : brand === 'lefties'
                      ? '输入 Lefties SKU 款号，用逗号分隔'
                    : brand === 'mango'
                      ? '输入 Mango SKU 款号，用逗号分隔'
                    : brand === 'reserved'
                      ? '输入 Reserved 款号（如 WK490-39M），用逗号分隔'
                    : brand === 'sinsay'
                      ? '输入 Sinsay 款号（如 010HI-59X），用逗号分隔'
                    : brand === 'urbanrevivo'
                      ? '输入 Urban Revivo 款号（如 UWJ750051），用逗号分隔'
                    : brand === 'newyorker'
                      ? '输入 New Yorker 款号（如 03.01.010.0134），用逗号分隔'
                    : brand === 'hm'
                      ? '输入 H&M 款号（如 1342946001），用逗号分隔'
                    : brand === 'uniqlo'
                        ? '输入 UNIQLO Product ID，用逗号分隔'
                    : brand === 'gu'
                      ? '输入 GU Product ID，用逗号分隔'
                      : '输入款号，用逗号分隔',
                )}
                value={styleNumbers}
                onChange={(e) => setStyleNumbers(e.target.value)}
                rows={4}
              />
            )}
            {brand === 'zara' && (
              <label className="zara-backup-toggle" style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', marginTop: '10px', fontSize: '0.84rem', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={zaraBackupMode}
                  onChange={(e) => setZaraBackupMode(e.target.checked)}
                  disabled={isRunning || isAnnotating}
                  style={{ marginTop: '3px' }}
                />
                <span>
                  {tx('Backup scraping (search-box mode)', '备用抓取（搜索框模式）')}
                  <br />
                  <span style={{ opacity: 0.7, fontSize: '0.78rem' }}>
                    {tx(
                      'Skip the direct-link method and search each style number, then open the first result. Use this if direct scraping returns no images on this machine.',
                      '跳过直连方式，逐个款号在搜索框搜索并打开第一个结果。当本机直连抓不到图片时使用。',
                    )}
                  </span>
                </span>
              </label>
            )}
          </div>
          <div className="config-section">
            <h3>{tx('Excel Import', 'Excel 导入')}</h3>
            <div className="file-selector">
              <button onClick={handleSelectExcel} className="select-button">{tx('Choose File', '选择文件')}</button>
              <span className="file-path">{excelPath || tx('No file selected', '未选择文件')}</span>
            </div>
            <p className="hint">{tx(
              getExcelHint(),
              brand === 'mixed'
                ? 'Excel A 列放品牌名，B 列放对应款号，程序会自动分发到对应网站抓取。'
                : brand === 'bershka'
                ? 'Excel 第二列放 Bershka SKU 款号，程序会自动在英文站点搜索。'
                : brand === 'pullandbear'
                  ? 'Excel 第二列放 Pull&Bear 10位款号，程序会从美区英文站点保存英文信息。'
                : brand === 'lefties'
                  ? 'Excel 第二列放 Lefties SKU 款号，程序会自动在西班牙英文站点搜索。'
                : brand === 'mango'
                  ? 'Excel 第二列放 Mango SKU 款号，程序会自动在英文站点搜索。'
                : brand === 'reserved'
                  ? 'Excel 第二列放 Reserved SKU 款号（如 WK490-39M），程序会自动在英文站点搜索并点开第一个搜索结果。'
                : brand === 'sinsay'
                  ? 'Excel 第二列放 Sinsay SKU 款号（如 010HI-59X），程序会自动在波兰站点搜索，第一轮失败后自动尝试去掉"-"之后的部分重搜。'
                : brand === 'urbanrevivo'
                  ? 'Excel 第二列放 Urban Revivo 款号（如 UWJ750051），程序会打开全球站点，点右上角搜索图标，在侧边栏输入款号并打开第一个结果。描述自动展开折叠卡并过滤掉 size/care/use cases/craft。'
                : brand === 'newyorker'
                  ? 'Excel 第二列放 New Yorker 款号（如 03.01.010.0134），程序使用官方 JSON API（无需浏览器），只取第一个颜色、full-hd 高清图和面料成分。该品牌无产品描述。'
                : brand === 'hm'
                  ? 'Excel 第二列放 H&M 款号（如 1342946001，7 位货号 + 3 位颜色），程序直接打开产品页，展开 Description 和 Materials 折叠卡，只保留段落描述、Composition 成分行（Shell / Embroidery / Lining…）以及该颜色的高清产品图。'
                : brand === 'uniqlo'
                    ? 'Excel 第二列放 UNIQLO Product ID，程序会在美区英文站点抓取英文描述和商品图。当前无法对所有款式稳定标准识别平铺正反面图命名。'
                : brand === 'gu'
                  ? 'Excel 第二列放 GU Product ID，程序会在美区英文站点抓取描述、面料和商品图。当前无法对所有款式稳定标准识别平铺正反面图命名。'
                  : brand === 'stradivarius'
                    ? 'Excel 第二列放 Stradivarius 款号，程序会从英文站点保存英文信息。'
                    : 'Excel 第二列放款号。',
            )}</p>
            {(brand === 'uniqlo' || brand === 'gu') && (
              <div className="hint hint-warning">
                {tx(
                  'Current note: UNIQLO and GU images do not yet support fully reliable standard front/back flat naming for every style.',
                  '当前提示：UNIQLO 和 GU 的图片暂时还不支持对所有款式稳定、标准地识别平铺正反面命名。'
                )}
              </div>
            )}
          </div>
          <div className="config-section">
            <h3>{tx('Output Directory', '输出目录')}</h3>
            <div className="file-selector">
              <button onClick={handleSelectDir} className="select-button">{tx('Choose Folder', '选择文件夹')}</button>
              <span className="file-path">{outputDir || tx('No folder selected', '未选择文件夹')}</span>
            </div>
          </div>
          <div className="config-section">
            <h3>{tx('Settings', '设置')}</h3>
            <label className="scraper-checkbox-row">
              <input type="checkbox" checked={doAnalyze} onChange={(e) => setDoAnalyze(e.target.checked)} disabled={isActive} />
              <span>{tx('Run AI trend analysis after scraping', '抓取完成后自动运行 AI 趋势分析')}</span>
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
                <div className="setting-row">
                  <label>{tx('Download threads', '下载线程数')}</label>
                  <input type="number" min="1" max="20" value={downloadConcurrency} onChange={(e) => setDownloadConcurrency(e.target.value)} />
                </div>
                <div className="setting-row">
                  <label>{tx('Analysis model', '分析模型')}</label>
                  <LLMEndpointModelPicker
                    llmConfig={llmConfig}
                    mode={llmMode}
                    onModeChange={setLlmMode}
                    model={llmModel}
                    onModelChange={setLlmModel}
                    disabled={isActive}
                    labels={{ endpointLabel: tx('AI endpoint', 'AI 端点'), modelLabel: tx('Model name', '模型名称') }}
                  />
                </div>
                <div className="setting-row">
                  <label>{tx('Report language', '报告语言')}</label>
                  <select value={language} onChange={(e) => setLanguage(e.target.value)} disabled={isActive}>
                    <option value="en">English</option>
                    <option value="zh">中文</option>
                  </select>
                </div>
              </>
            )}
          </div>
          <div className="action-buttons">
            <button onClick={handleStart} disabled={isRunning || isAnnotating || isAnalyzing} className="primary-button">
              {isRunning ? tx(`Scraping ${brandLabel}...`, `正在抓取 ${brandLabel}...`) : isAnalyzing ? tx('Analyzing...', '分析中...') : tx(`Start ${brandLabel} Scraping`, `开始抓取 ${brandLabel}`)}
            </button>
            <button onClick={handleAnnotate} disabled={isAnnotating || isRunning || !excelPath} className="secondary-button">
              {isAnnotating ? tx('Annotating...', '标记中...') : tx(`Annotate ${brandLabel} Excel`, `标记 ${brandLabel} Excel`)}
            </button>
            <button
              onClick={() => {
                setLogs([]);
                setProgress(0);
                setCompletionFeedback(null);
                setActiveTask('');
                setExcelPreview(null);
                setExcelPath('');
                setStyleNumbers('');
                setReportPath('');
                setScrapedOutputDir('');
              }}
              disabled={isRunning || isAnnotating || isAnalyzing}
              className="secondary-button"
            >
              {tx('Reset', '重置')}
            </button>
            {isActive && (
              <button onClick={handleCancel} disabled={isCancelling} className="secondary-button danger-button">
                {isCancelling ? tx('Cancelling...', '取消中...') : tx('Cancel', '取消')}
              </button>
            )}
          </div>
        </div>
        <div className="log-panel">
          <div className="scraper-status-panel">
            <div className="scraper-status-header">
              <div>
                <h3>{tx('Run Status', '运行状态')}</h3>
                <p>{tx('Track processed styles and failure reasons for this run.', '查看本次已处理款号、失败款号和失败原因。')}</p>
              </div>
              <ActivityConsole
                title="Console"
                layout="dock"
                isVisible={workspaceVisible}
                logs={logs}
                onClear={handleClearLogs}
                onCancel={handleCancel}
                progress={progress}
                isActive={isActive}
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

            <div className="scraper-status-grid">
              <div className="scraper-status-card">
                <strong>{scrapeStatus.totalCount || excelPreview?.total || parseManualStyleNumbers(styleNumbers).length || aggregatedMixedCount || 0}</strong>
                <span>{tx('Total styles', '本次总款数')}</span>
              </div>
              <div className="scraper-status-card">
                <strong>{scrapeStatus.successCount}</strong>
                <span>{tx('Succeeded', '成功')}</span>
              </div>
              <div className="scraper-status-card">
                <strong>{scrapeStatus.failedCount}</strong>
                <span>{tx('Failed', '失败')}</span>
              </div>
              <div className="scraper-status-card">
                <strong>{scrapeStatus.replacementCount}</strong>
                <span>{tx('Replacement', '替代款')}</span>
              </div>
            </div>

            <div className="scraper-status-table">
              {scrapeStatus.rows.length > 0 ? scrapeStatus.rows.map((item) => (
                <div key={item.styleNumber} className={`scraper-status-row status-${item.status}`}>
                  <span className="style-number">{item.styleNumber}</span>
                  <span className="style-state">
                    {item.status === 'success' ? tx('Success', '成功')
                      : item.status === 'failed' ? tx('Failed', '失败')
                        : item.status === 'replacement' ? tx('Replacement', '替代款')
                          : tx('Processing', '处理中')}
                  </span>
                  <span className="style-detail">{item.detail || '—'}</span>
                </div>
              )) : (
                <div className="scraper-status-empty">
                  <strong>{tx('Status will appear here', '状态会显示在这里')}</strong>
                  <span>{latestLogMessage || tx('Start a scrape to see processed styles and failure reasons.', '开始抓取后，这里会显示已处理款号和失败原因。')}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default ZaraScraper;

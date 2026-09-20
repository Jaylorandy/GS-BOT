import React, { useEffect, useState } from 'react';
import { useI18n } from '../utils/i18n';
import './PdfSqueezer.css';

function getPathLeaf(value = '') {
  return String(value || '')
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .filter(Boolean)
    .pop() || '';
}

function getParentPath(value = '') {
  const normalized = String(value || '').replace(/[\\/]+$/, '');
  const segments = normalized.split(/[\\/]/);
  segments.pop();
  if (!segments.length) {
    return '';
  }
  if (/^[A-Za-z]:$/.test(segments[0])) {
    return `${segments[0]}\\${segments.slice(1).join('\\')}`.replace(/[\\]+$/, '');
  }
  return segments.join('/');
}

function stripPdfExtension(value = '') {
  return String(value || '').replace(/\.pdf$/i, '');
}

function buildSqueezedDefaultName(value = '') {
  const base = stripPdfExtension(getPathLeaf(value));
  if (!base) {
    return 'compressed_squeezed.pdf';
  }
  if (/_squeezed$/i.test(base)) {
    return `${base}.pdf`;
  }
  return `${base}_squeezed.pdf`;
}

function formatBytes(value = 0) {
  const size = Number(value) || 0;
  if (!Number.isFinite(size) || size <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB'];
  let next = size;
  let index = 0;
  while (next >= 1024 && index < units.length - 1) {
    next /= 1024;
    index += 1;
  }
  return `${next.toFixed(next >= 100 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatReductionPercent(originalBytes = 0, compressedBytes = 0) {
  const original = Number(originalBytes) || 0;
  const compressed = Number(compressedBytes) || 0;
  if (original <= 0 || compressed <= 0 || compressed >= original) {
    return 0;
  }
  return Math.round(((original - compressed) / original) * 100);
}

function normalizeDroppedPath(value = '') {
  let nextValue = String(value || '').trim();
  if (!nextValue) {
    return '';
  }

  if (
    (nextValue.startsWith('"') && nextValue.endsWith('"'))
    || (nextValue.startsWith('\'') && nextValue.endsWith('\''))
  ) {
    nextValue = nextValue.slice(1, -1).trim();
  }

  if (nextValue.startsWith('/')) {
    nextValue = nextValue.replace(/\\([ !"#$&'()*;<>?\[\]{}|`~])/g, '$1');
  }

  return nextValue;
}

function parseDroppedPlainText(rawValue = '') {
  return String(rawValue || '')
    .split(/[\r\n\0]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => !entry.startsWith('#'))
    .map((entry) => {
      if (entry.startsWith('file://')) {
        try {
          return normalizeDroppedPath(decodeURIComponent(entry.replace(/^file:\/\//i, '')));
        } catch {
          return normalizeDroppedPath(entry.replace(/^file:\/\//i, ''));
        }
      }
      return normalizeDroppedPath(entry);
    });
}

function extractDropPaths(dataTransfer) {
  const directPaths = [
    ...(dataTransfer?.files || []),
    ...[...(dataTransfer?.items || [])]
      .map((item) => item?.getAsFile?.())
      .filter(Boolean),
  ]
    .map((file) => (
      file?.path
      || file?.filePath
      || window.electronAPI?.getPathForDroppedFile?.(file)
      || ''
    ))
    .filter(Boolean);
  if (directPaths.length > 0) {
    return directPaths;
  }

  const types = new Set([
    'text/uri-list',
    'text/plain',
    'public.file-url',
    'public.url',
    'public.utf8-plain-text',
    'public.text',
  ]);

  [...(dataTransfer?.types || [])].forEach((type) => {
    if (type && type !== 'Files') {
      types.add(type);
    }
  });

  const discoveredPaths = [];
  types.forEach((type) => {
    try {
      const nextPaths = parseDroppedPlainText(dataTransfer?.getData?.(type));
      discoveredPaths.push(...nextPaths);
    } catch {
      // Ignore unsupported drag payload types.
    }
  });

  const uniquePaths = [...new Set(discoveredPaths)].filter(Boolean);
  if (uniquePaths.length > 0) {
    return uniquePaths;
  }

  return [];
}

function createSourceItem(entry = {}) {
  const nextPath = String(entry.path || '').trim();
  return {
    path: nextPath,
    name: String(entry.name || getPathLeaf(nextPath)).trim(),
    parentPath: String(entry.parentPath || getParentPath(nextPath)).trim(),
    originalBytes: Number(entry.originalBytes) || 0,
    compressedBytes: null,
    bytesSaved: 0,
    stagedPath: '',
    status: 'idle',
    keptOriginal: false,
    elapsedSeconds: 0,
    lastSavedPath: '',
  };
}

function DocumentDropIcon() {
  return (
    <svg viewBox="0 0 120 120" aria-hidden="true">
      <path d="M44 20h32c5.3 0 9.6 1.8 12.9 5.1l8 8C100.2 36.4 102 40.7 102 46v30c0 13.3-10.7 24-24 24H42C28.7 100 18 89.3 18 76V44c0-13.3 10.7-24 24-24h2Z" fill="none" stroke="currentColor" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M60 24v40" fill="none" stroke="currentColor" strokeWidth="6" strokeLinecap="round" />
      <path d="m42 50 18 18 18-18" fill="none" stroke="currentColor" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg viewBox="0 0 50 50" aria-hidden="true">
      <circle cx="25" cy="25" r="20" fill="none" stroke="currentColor" strokeWidth="5" opacity="0.16" />
      <path d="M45 25c0-11-9-20-20-20" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" />
    </svg>
  );
}

export default function PdfSqueezer({ homeFeature }) {
  const { tx } = useI18n();
  const [sourceItems, setSourceItems] = useState([]);
  const [activePath, setActivePath] = useState('');
  const [logs, setLogs] = useState([]);
  const [progress, setProgress] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [notice, setNotice] = useState(null);
  const [saveState, setSaveState] = useState({
    overwriteDone: false,
    savedPaths: [],
  });
  const [config, setConfig] = useState({
    preset: 'balanced',
  });

  useEffect(() => {
    if (!window.electronAPI) {
      return undefined;
    }

    const handleLog = (log) => {
      setLogs((prev) => [...prev, log]);
      const message = String(log?.message || '').trim();
      const runningMatch = message.match(/^\[(\d+)\/(\d+)\]\s+Compressing\s+(.+)$/i);
      if (runningMatch) {
        const runningName = runningMatch[3].trim();
        let matchedPath = '';
        setSourceItems((prev) => prev.map((item) => {
          if (item.name === runningName || getPathLeaf(item.path) === runningName) {
            matchedPath = item.path;
            return { ...item, status: 'running' };
          }
          if (item.status === 'running') {
            return { ...item, status: item.stagedPath ? item.status : 'queued' };
          }
          return item;
        }));
        if (matchedPath) {
          setActivePath(matchedPath);
        }
      }
    };

    const handleItem = (itemResult) => {
      const sourcePath = String(itemResult?.sourcePath || '').trim();
      if (!sourcePath) {
        return;
      }

      setActivePath(sourcePath);

      setSourceItems((prev) => prev.map((item) => {
        if (item.path !== sourcePath) {
          return item;
        }
        return {
          ...item,
          compressedBytes: Number(itemResult.compressedBytes) || item.originalBytes,
          bytesSaved: Number(itemResult.bytesSaved) || 0,
          stagedPath: String(itemResult.outputPath || '').trim(),
          keptOriginal: Boolean(itemResult.keptOriginal),
          elapsedSeconds: Number(itemResult.elapsedSeconds) || 0,
          status: itemResult.keptOriginal ? 'unchanged' : 'done',
        };
      }));
    };

    window.electronAPI.onPdfSqueezerLog(handleLog);
    window.electronAPI.onPdfSqueezerProgress((value) => setProgress(value));
    window.electronAPI.onPdfSqueezerItem(handleItem);

    return () => {
      window.electronAPI?.removePdfSqueezerListeners?.();
    };
  }, []);

  useEffect(() => {
    const preventWindowDrop = (event) => {
      event.preventDefault();
    };

    window.addEventListener('dragover', preventWindowDrop);
    window.addEventListener('drop', preventWindowDrop);

    return () => {
      window.removeEventListener('dragover', preventWindowDrop);
      window.removeEventListener('drop', preventWindowDrop);
    };
  }, []);

  const latestLogMessage = logs[logs.length - 1]?.message || '';
  const savableItems = sourceItems.filter((item) => item.stagedPath);
  const hasCompressedResults = savableItems.length > 0;
  const totalOriginalBytes = sourceItems.reduce((sum, item) => sum + (Number(item.originalBytes) || 0), 0);
  const totalCompressedBytes = hasCompressedResults
    ? sourceItems.reduce((sum, item) => sum + (Number(item.compressedBytes) || Number(item.originalBytes) || 0), 0)
    : 0;
  const totalBytesSaved = hasCompressedResults
    ? sourceItems.reduce((sum, item) => sum + (Number(item.bytesSaved) || 0), 0)
    : 0;
  const totalReductionPercent = formatReductionPercent(totalOriginalBytes, totalCompressedBytes);
  const activeItem = sourceItems.find((item) => item.path === activePath) || sourceItems[0] || null;

  const mergeSourceItems = (entries, { append = false } = {}) => {
    const nextEntries = (Array.isArray(entries) ? entries : [])
      .map(createSourceItem)
      .filter((item) => item.path);

    if (!nextEntries.length) {
      setNotice({
        type: 'warning',
        title: tx('No PDFs found', '没有找到 PDF'),
        message: tx('Drop PDF files or folders that contain PDFs.', '请拖入 PDF 文件，或包含 PDF 的文件夹。'),
      });
      return { mergedItems: [], addedItems: [] };
    }

    const existingItems = append
      ? sourceItems.map((item) => createSourceItem(item))
      : [];
    const existingPaths = new Set(existingItems.map((item) => item.path));
    const addedItems = nextEntries.filter((item) => !existingPaths.has(item.path));
    const merged = append
      ? [...existingItems, ...nextEntries]
      : nextEntries;
    const seen = new Set();
    const mergedItems = merged.filter((item) => {
      if (seen.has(item.path)) {
        return false;
      }
      seen.add(item.path);
      return true;
    });

    return { mergedItems, addedItems };
  };

  const primeSourceItems = (items, preferredActivePath = '') => {
    const nextItems = Array.isArray(items) ? items : [];
    setSourceItems(nextItems);
    setActivePath(preferredActivePath || nextItems[0]?.path || '');
    setProgress(0);
    setLogs([]);
    setNotice(null);
    setSaveState({
      overwriteDone: false,
      savedPaths: [],
    });
  };

  const updateSources = (entries, { append = false, autoStart = false, configOverride = null } = {}) => {
    const { mergedItems, addedItems } = mergeSourceItems(entries, { append });
    if (!mergedItems.length) {
      return;
    }

    const preferredActivePath = addedItems[0]?.path || mergedItems[0]?.path || '';
    primeSourceItems(mergedItems, preferredActivePath);

    if (autoStart && !isRunning) {
      void runCompression(mergedItems, configOverride || config);
    }
  };

  const handleSelectSources = async () => {
    const filePaths = await window.electronAPI?.selectPdfFiles?.();
    if (!Array.isArray(filePaths) || filePaths.length === 0) {
      return;
    }
    const entries = await window.electronAPI?.resolvePdfSources?.(filePaths);
    if (!Array.isArray(entries) || entries.length === 0) {
      return;
    }
    updateSources(entries, { append: true, autoStart: true });
  };

  const handleSelectFolder = async () => {
    const entries = await window.electronAPI?.selectPdfFolders?.();
    if (!Array.isArray(entries) || entries.length === 0) {
      return;
    }
    updateSources(entries, { append: true, autoStart: true });
  };

  // Apply homepage feature presets
  const folderPickerPending = React.useRef(false);
  useEffect(() => {
    if (!homeFeature) return;
    switch (homeFeature) {
      case 'balanced':
      case 'light':
      case 'strong':
        handlePresetChange(homeFeature);
        break;
      case 'batch':
        folderPickerPending.current = true;
        break;
      default:
        break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homeFeature]);

  // Trigger folder picker after render if requested by the preset.
  useEffect(() => {
    if (folderPickerPending.current) {
      folderPickerPending.current = false;
      handleSelectFolder();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homeFeature]);

  const handleDrop = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);

    const paths = extractDropPaths(event.dataTransfer);

    if (!paths.length) {
      setNotice({
        type: 'warning',
        title: tx('Drop not recognized', '没有识别到拖拽内容'),
        message: tx('Try dragging the PDF again, or use Add PDFs.', '请再拖一次 PDF，或者改用“添加 PDF”。'),
      });
      return;
    }

    const entries = await window.electronAPI?.resolvePdfSources?.(paths);
    if (!Array.isArray(entries) || entries.length === 0) {
      setNotice({
        type: 'warning',
        title: tx('No PDFs found', '没有找到 PDF'),
        message: tx('The dropped items did not include any PDF files.', '拖入的内容里没有找到 PDF 文件。'),
      });
      return;
    }

    updateSources(entries, { append: true, autoStart: true });
  };

  const handleDragState = (event, nextActive) => {
    event.preventDefault();
    event.stopPropagation();
    if (!isRunning) {
      setDragActive(nextActive);
    }
  };

  const resetCompressionState = () => {
    setSourceItems((prev) => prev.map((item) => ({
      ...item,
      compressedBytes: null,
      bytesSaved: 0,
      stagedPath: '',
      status: 'idle',
      keptOriginal: false,
      elapsedSeconds: 0,
      lastSavedPath: '',
    })));
    setProgress(0);
    setLogs([]);
    setNotice(null);
    setSaveState({
      overwriteDone: false,
      savedPaths: [],
    });
  };

  const handlePresetChange = (preset) => {
    if (preset === config.preset || isRunning) {
      return;
    }
    const nextConfig = { preset };
    setConfig(nextConfig);
    if (sourceItems.length > 0) {
      resetCompressionState();
      void runCompression(sourceItems.map((item) => createSourceItem(item)), nextConfig);
    }
  };

  const runCompression = async (items = sourceItems, configToUse = config) => {
    const itemsToCompress = (Array.isArray(items) ? items : [])
      .map((item) => createSourceItem(item))
      .filter((item) => item.path);

    if (!itemsToCompress.length || isRunning) {
      return;
    }

    setIsRunning(true);
    setIsCancelling(false);
    setProgress(0);
    setLogs([]);
    setNotice(null);
    setSaveState({
      overwriteDone: false,
      savedPaths: [],
    });
    setSourceItems(itemsToCompress.map((item, index) => ({
      ...item,
      compressedBytes: null,
      bytesSaved: 0,
      stagedPath: '',
      status: index === 0 ? 'running' : 'queued',
      keptOriginal: false,
      elapsedSeconds: 0,
      lastSavedPath: '',
    })));
    setActivePath((current) => current || itemsToCompress[0]?.path || '');

    try {
      const result = await window.electronAPI?.squeezePDFs?.({
        sourceFiles: itemsToCompress.map((item) => item.path),
        config: configToUse,
      });

      if (result?.success) {
        setProgress(100);
        setSourceItems((prev) => prev.map((item) => {
          if (result.failedFiles?.includes(item.name)) {
            return { ...item, status: 'error' };
          }
          if (item.status === 'running' || item.status === 'queued') {
            return item.stagedPath ? item : { ...item, status: 'error' };
          }
          return item;
        }));
        setNotice({
          type: (result.issues?.targetExceededFiles?.length || 0) > 0
            ? 'warning'
            : Number(result.totalBytesSaved) > 0 ? 'success' : 'warning',
          title: (result.issues?.targetExceededFiles?.length || 0) > 0
            ? tx('Still above email size', '仍高于邮件大小限制')
            : Number(result.totalBytesSaved) > 0
            ? tx('Compression complete', '压缩完成')
            : tx('No size reduction found', '未获得压缩收益'),
          message: (result.issues?.targetExceededFiles?.length || 0) > 0
            ? tx('Strong compression finished, but some PDFs are still above the common 10 MB email attachment limit.', '强力压缩已完成，但部分 PDF 仍高于常见的 10 MB 邮件附件限制。')
            : Number(result.totalBytesSaved) > 0
            ? tx('Review the size reduction, then choose Save or Save as...', '先检查压缩结果，再选择“保存”或“另存为”…')
            : tx('This preset did not make the PDFs smaller. You can still save unchanged copies or try a stronger preset.', '当前预设没把 PDF 压得更小。你仍然可以保存未缩小副本，或者尝试更强的压缩强度。'),
        });
      } else if (result?.cancelled) {
        setProgress(0);
        setSourceItems((prev) => prev.map((item) => ({
          ...item,
          status: item.stagedPath ? item.status : 'idle',
        })));
        setNotice({
          type: 'warning',
          title: tx('Compression cancelled', '已取消压缩'),
          message: tx('The current compression run was stopped.', '当前压缩任务已经停止。'),
        });
      } else {
        throw new Error(result?.error || 'PDF Squeezer failed.');
      }
    } catch (error) {
      setProgress(0);
      setSourceItems((prev) => prev.map((item) => ({
        ...item,
        status: item.stagedPath ? item.status : 'idle',
      })));
      setNotice({
        type: 'error',
        title: tx('Compression failed', '压缩失败'),
        message: error.message || String(error),
      });
    } finally {
      setIsRunning(false);
      setIsCancelling(false);
    }
  };

  const handleCancel = async () => {
    if (!isRunning || isCancelling || !window.electronAPI?.cancelTask) {
      return;
    }

    setIsCancelling(true);
    await window.electronAPI.cancelTask('pdf-squeezer');
  };

  const handleClear = () => {
    setSourceItems([]);
    setActivePath('');
    setProgress(0);
    setLogs([]);
    setNotice(null);
    setSaveState({
      overwriteDone: false,
      savedPaths: [],
    });
    setIsCancelling(false);
  };

  const handleSave = async () => {
    if (!savableItems.length || isSaving) {
      return;
    }

    setIsSaving(true);
    try {
      const result = await window.electronAPI?.saveSqueezedPDFs?.({
        mode: 'overwrite',
        items: savableItems.map((item) => ({
          sourcePath: item.path,
          stagedPath: item.stagedPath,
          name: item.name,
        })),
      });

      if (!result?.success) {
        throw new Error(result?.error || 'Failed to overwrite the original files.');
      }

      const savedSet = new Set(result.savedPaths || []);
      setSourceItems((prev) => prev.map((item) => (
        savedSet.has(item.path)
          ? { ...item, status: 'saved', lastSavedPath: item.path }
          : item
      )));
      setSaveState({
        overwriteDone: true,
        savedPaths: result.savedPaths || [],
      });
      setNotice({
        type: 'success',
        title: tx('Original PDFs updated', '原 PDF 已更新'),
        message: tx('The compressed versions have replaced the original PDFs.', '压缩后的版本已经覆盖原 PDF。'),
      });
    } catch (error) {
      setNotice({
        type: 'error',
        title: tx('Save failed', '保存失败'),
        message: error.message || String(error),
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveAs = async () => {
    if (!savableItems.length || isSaving) {
      return;
    }

    setIsSaving(true);
    try {
      let result = null;
      if (savableItems.length === 1) {
        const targetPath = await window.electronAPI?.saveFile?.({
          defaultPath: buildSqueezedDefaultName(savableItems[0].name),
          filters: [{ name: 'PDF', extensions: ['pdf'] }],
        });
        if (!targetPath) {
          setIsSaving(false);
          return;
        }
        result = await window.electronAPI?.saveSqueezedPDFs?.({
          mode: 'save-as',
          targetPath,
          items: [{
            sourcePath: savableItems[0].path,
            stagedPath: savableItems[0].stagedPath,
            name: savableItems[0].name,
          }],
        });
      } else {
        const targetFolder = await window.electronAPI?.selectDir?.();
        if (!targetFolder) {
          setIsSaving(false);
          return;
        }
        result = await window.electronAPI?.saveSqueezedPDFs?.({
          mode: 'save-as',
          targetFolder,
          items: savableItems.map((item) => ({
            sourcePath: item.path,
            stagedPath: item.stagedPath,
            name: item.name,
          })),
        });
      }

      if (!result?.success) {
        throw new Error(result?.error || 'Failed to save the compressed files.');
      }

      const lastSavedBySource = new Map();
      savableItems.forEach((item, index) => {
        const savedPath = result.savedPaths?.[index];
        if (savedPath) {
          lastSavedBySource.set(item.path, savedPath);
        }
      });

      setSourceItems((prev) => prev.map((item) => {
        const savedPath = lastSavedBySource.get(item.path) || item.lastSavedPath;
        return savedPath ? { ...item, lastSavedPath: savedPath } : item;
      }));
      setSaveState({
        overwriteDone: saveState.overwriteDone,
        savedPaths: result.savedPaths || [],
      });
      setNotice({
        type: 'success',
        title: tx('Compressed PDFs saved', '压缩后的 PDF 已保存'),
        message: tx('Your compressed PDFs were written to the selected destination.', '压缩后的 PDF 已经保存到你选择的位置。'),
      });
    } catch (error) {
      setNotice({
        type: 'error',
        title: tx('Save as failed', '另存为失败'),
        message: error.message || String(error),
      });
    } finally {
      setIsSaving(false);
    }
  };

  const statusLabel = (() => {
    if (isRunning) {
      return tx('Compressing', '正在压缩');
    }
    if (activeItem?.status === 'saved') {
      return tx('Saved', '已保存');
    }
    if (activeItem?.status === 'done') {
      return tx('Ready to save', '等待保存');
    }
    if (activeItem?.status === 'unchanged') {
      return tx('No savings', '未缩小');
    }
    if (activeItem?.status === 'error') {
      return tx('Needs attention', '需要处理');
    }
    return tx('Drop PDFs to begin', '拖入 PDF 开始');
  })();

  const activeOriginal = Number(activeItem?.originalBytes) || 0;
  const activeCompressed = Number(activeItem?.compressedBytes) || 0;
  const activeHasResult = Boolean(activeItem?.stagedPath);
  const activeReductionPercent = formatReductionPercent(activeOriginal, activeCompressed);
  const batchCountLabel = tx(
    `${sourceItems.length} PDF${sourceItems.length === 1 ? '' : 's'}`,
    `${sourceItems.length} 个 PDF`,
  );

  return (
    <div
      className={`pdf-squeezer-page ${dragActive ? 'is-dragging' : ''} ${isRunning ? 'is-task-processing' : ''}`}
      onDragEnter={(event) => handleDragState(event, true)}
      onDragOver={(event) => handleDragState(event, true)}
      onDragLeave={(event) => handleDragState(event, false)}
      onDrop={handleDrop}
    >
      <div className="pdf-squeezer-shell">
        <div className="pdf-squeezer-toolbar">
          <div className="pdf-squeezer-brand">
            <div className="pdf-squeezer-brand-icon">PDF</div>
            <div className="pdf-squeezer-brand-copy">
              <h1>{tx('PDF Squeezer', 'PDF压缩器')}</h1>
              <p>{tx('Drag in PDF files or folders, preview the reduction, then save or save as.', '拖入 PDF 文件或文件夹，先预览压缩结果，再选择保存或另存为。')}</p>
            </div>
          </div>

          <div className="pdf-squeezer-toolbar-actions">
            <div className="pdf-squeezer-strength" role="tablist" aria-label={tx('Compression strength', '压缩强度')}>
              {[
                ['light', tx('Light', '轻度')],
                ['balanced', tx('Balanced', '均衡')],
                ['strong', tx('Strong', '强力')],
              ].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={`pdf-squeezer-strength-btn ${config.preset === value ? 'active' : ''}`}
                  onClick={() => handlePresetChange(value)}
                  disabled={isRunning}
                >
                  {label}
                </button>
              ))}
            </div>

            <button type="button" className="pdf-squeezer-action ghost" onClick={handleSelectSources} disabled={isRunning}>
              {tx('Add PDFs', '添加 PDF')}
            </button>
            <button type="button" className="pdf-squeezer-action ghost" onClick={handleSelectFolder} disabled={isRunning}>
              {tx('Add folder', '添加文件夹')}
            </button>
            <button
              type="button"
              className={`pdf-squeezer-action ${saveState.overwriteDone ? 'success' : ''}`}
              onClick={handleSave}
              disabled={!hasCompressedResults || isRunning || isSaving || saveState.overwriteDone}
            >
              {saveState.overwriteDone ? tx('Saved', '已保存') : tx('Save', '保存')}
            </button>
            <button
              type="button"
              className="pdf-squeezer-action"
              onClick={handleSaveAs}
              disabled={!hasCompressedResults || isRunning || isSaving}
            >
              {tx('Save as...', '另存为...')}
            </button>
          </div>
        </div>

        <div className={`pdf-squeezer-canvas ${sourceItems.length === 0 ? 'empty' : ''}`}>
          {sourceItems.length === 0 ? (
            <div className={`pdf-squeezer-dropzone ${dragActive ? 'active' : ''}`}>
              <div className="pdf-squeezer-drop-icon">
                <DocumentDropIcon />
              </div>
              <strong>{tx('Drag and drop your PDF files or folders here...', '将 PDF 文件或文件夹拖到这里...')}</strong>
              <p>{tx('Compression starts automatically after you drop or add PDFs.', '拖入或添加 PDF 后会自动开始压缩。')}</p>
            </div>
          ) : (
            <div className="pdf-squeezer-stage">
              <div className="pdf-squeezer-hero">
                <div className={`pdf-squeezer-preview-card ${activeItem?.status || 'idle'}`}>
                  <div className="pdf-squeezer-preview-fold" />
                  <div className="pdf-squeezer-preview-watermark">{tx('PDF', 'PDF')}</div>
                  <div className="pdf-squeezer-preview-name">
                    {stripPdfExtension(activeItem?.name || tx('Choose a PDF', '选择一个 PDF'))}
                  </div>
                  <div className="pdf-squeezer-preview-meta">
                    {activeItem?.parentPath ? getPathLeaf(activeItem.parentPath) : tx('Ready', '就绪')}
                  </div>
                </div>

                <div className="pdf-squeezer-status-pill">
                  {statusLabel}
                </div>

                {isRunning ? (
                  <div className="pdf-squeezer-progress-wrap">
                    <div className="pdf-squeezer-spinner">
                      <SpinnerIcon />
                    </div>
                    <div className="pdf-squeezer-progress-track">
                      <div className="pdf-squeezer-progress-fill" style={{ width: `${Math.max(0, Math.min(100, progress))}%` }} />
                    </div>
                    <div className="pdf-squeezer-progress-copy">
                      <strong>{Math.round(progress)}%</strong>
                      <span>{latestLogMessage || tx('Recompressing embedded images...', '正在重压缩内嵌图片...')}</span>
                    </div>
                  </div>
                ) : null}

                <div className="pdf-squeezer-size-line">
                  {activeHasResult ? (
                    <span>{formatBytes(activeOriginal)} <span className="arrow">→</span> {formatBytes(activeCompressed || activeOriginal)}</span>
                  ) : (
                    <span>{formatBytes(activeOriginal)}</span>
                  )}
                </div>

                <div className="pdf-squeezer-size-caption">
                  {activeHasResult
                    ? (activeReductionPercent > 0
                      ? tx(`Size reduced by ${activeReductionPercent}%`, `体积减少了 ${activeReductionPercent}%`)
                      : tx('No meaningful size reduction with this preset', '这个预设没有带来明显缩小'))
                    : tx('Add PDFs and compression will start automatically. The preview will appear here.', '添加 PDF 后会自动开始压缩，结果会显示在这里。')}
                </div>

                <div className="pdf-squeezer-summary-row">
                  <span className="pdf-squeezer-summary-chip">{batchCountLabel}</span>
                  <span className="pdf-squeezer-summary-chip">{tx('Original', '原始')} · {formatBytes(totalOriginalBytes)}</span>
                  {hasCompressedResults ? (
                    <>
                      <span className="pdf-squeezer-summary-chip">{tx('Compressed', '压缩后')} · {formatBytes(totalCompressedBytes)}</span>
                      <span className={`pdf-squeezer-summary-chip ${totalBytesSaved > 0 ? 'success' : 'muted'}`}>
                        {totalBytesSaved > 0
                          ? tx(`Saved ${formatBytes(totalBytesSaved)}`, `节省 ${formatBytes(totalBytesSaved)}`)
                          : tx('No savings', '未缩小')}
                      </span>
                    </>
                  ) : null}
                </div>
              </div>

              <div className="pdf-squeezer-file-list">
                {sourceItems.map((item) => {
                  const isActive = item.path === activeItem?.path;
                  const reductionPercent = formatReductionPercent(item.originalBytes, item.compressedBytes || 0);
                  return (
                    <button
                      key={item.path}
                      type="button"
                      className={`pdf-squeezer-file-row ${isActive ? 'active' : ''}`}
                      onClick={() => setActivePath(item.path)}
                    >
                      <div className="pdf-squeezer-file-main">
                        <strong>{item.name}</strong>
                        <span>{item.status === 'saved'
                          ? tx('Saved', '已保存')
                          : item.status === 'done'
                            ? tx('Ready', '可保存')
                            : item.status === 'unchanged'
                              ? tx('Unchanged', '未缩小')
                              : item.status === 'running'
                                ? tx('Compressing', '压缩中')
                                : item.status === 'queued'
                                  ? tx('Queued', '排队中')
                                  : item.status === 'error'
                                    ? tx('Problem', '有问题')
                                    : tx('Waiting', '等待中')}</span>
                      </div>
                      <div className="pdf-squeezer-file-stats">
                        {item.stagedPath ? (
                          <>
                            <span>{formatBytes(item.originalBytes)} → {formatBytes(item.compressedBytes || item.originalBytes)}</span>
                            <span className={reductionPercent > 0 ? 'success' : 'muted'}>
                              {reductionPercent > 0 ? `-${reductionPercent}%` : tx('No savings', '未缩小')}
                            </span>
                          </>
                        ) : (
                          <span>{formatBytes(item.originalBytes)}</span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {notice ? (
          <div className={`pdf-squeezer-notice ${notice.type || 'info'}`}>
            <div>
              <strong>{notice.title}</strong>
              <p>{notice.message}</p>
            </div>
            {saveState.savedPaths.length > 0 ? (
              <button
                type="button"
                className="pdf-squeezer-inline-link"
                onClick={() => {
                  const targetPath = saveState.savedPaths.length === 1
                    ? saveState.savedPaths[0]
                    : getParentPath(saveState.savedPaths[0] || '');
                  if (targetPath) {
                    window.electronAPI?.revealLocalPath?.(targetPath);
                  }
                }}
              >
                {tx('Show in Finder', '定位文件')}
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="pdf-squeezer-footer">
          <div className="pdf-squeezer-footer-left">
            <span>{tx('Compression strength', '压缩强度')} · {config.preset === 'light' ? tx('Light', '轻度') : config.preset === 'strong' ? tx('Strong', '强力') : tx('Balanced', '均衡')}</span>
            {hasCompressedResults ? (
              <span>{totalBytesSaved > 0 ? tx(`${totalReductionPercent}% smaller overall`, `整体缩小 ${totalReductionPercent}%`) : tx('No meaningful reduction yet', '目前还没有明显缩小')}</span>
            ) : null}
          </div>
          <div className="pdf-squeezer-footer-right">
            {isRunning ? (
              <button type="button" className="pdf-squeezer-inline-link" onClick={handleCancel} disabled={isCancelling}>
                {isCancelling ? tx('Stopping...', '停止中...') : tx('Cancel', '取消')}
              </button>
            ) : null}
            {sourceItems.length > 0 ? (
              <button type="button" className="pdf-squeezer-inline-link" onClick={handleClear}>
                {tx('Clear', '清空')}
              </button>
            ) : null}
            {logs.length > 0 ? (
              <details className="pdf-squeezer-details">
                <summary>{tx('Details', '详细信息')}</summary>
                <div className="pdf-squeezer-log-list">
                  {logs.slice(-10).map((log) => (
                    <div key={`${log.time}-${log.message}`} className={`pdf-squeezer-log-row ${log.type || 'info'}`}>
                      <span>{log.time}</span>
                      <span>{log.message}</span>
                    </div>
                  ))}
                </div>
              </details>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

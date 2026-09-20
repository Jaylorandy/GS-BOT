import React, { useEffect, useMemo, useRef, useState } from 'react';
import ActivityConsole from './ActivityConsole';
import { useI18n } from '../utils/i18n';
import { buildCompletionIssues } from '../utils/completionIssues';
import {
  LABEL_OCR_FIELD_META,
  parseLabelOcrAliasDraft,
} from '../utils/labelOcrProfile';
import {
  loadSharedLabelOcrProfile,
  subscribeSharedLabelOcrProfile,
} from '../utils/labelOcrProfileStore';
import {
  buildDefaultOcrConfig,
  getOcrEngineOptions,
  normalizeOcrEngineName,
} from '../utils/ocrEngines';
import './SlidesMaker.css';

const DEFAULT_OCR_CONFIG = buildDefaultOcrConfig();
const DEFAULT_SUFFIXES = ['F', 'B', 'S', 'D', 'E', '6'];
const DETECTOR_BOX_HOLD_MS = 1800;
const STYLE_NAME_FIELD_OPTIONS = [
  { value: 'styleNumber', label: ['Style Number', '款号'] },
  { value: 'fabricCode', label: ['CODE', 'CODE'] },
  { value: 'description', label: ['DESC', 'DESC'] },
  { value: 'composition', label: ['CONT', 'CONT'] },
  { value: 'width', label: ['WIDTH', 'WIDTH'] },
  { value: 'cuttable', label: ['CUTTABLE', 'CUTTABLE'] },
  { value: 'weight', label: ['WEIGHT', 'WEIGHT'] },
];

function buildDefaultOrganizerConfig() {
  return syncSuffixConfig({
    organizeAction: 'move',
    organizeOutputMode: 'single-folder',
    namingMode: 'label',
    labelNamingTarget: 'fabric',
    styleNameField: 'styleNumber',
    groupSize: 4,
    labelIndex: 4,
    labelSuffix: '',
    imageSuffixes: ['F', 'B', 'S'],
    numberStart: 1,
    ocrEngine: DEFAULT_OCR_CONFIG.engine,
    labelOcrProfile: loadSharedLabelOcrProfile(),
  });
}

function buildDefaultSuffixes(count = 0) {
  return Array.from({ length: Math.max(0, Number(count) || 0) }, (_unused, index) => DEFAULT_SUFFIXES[index] || String(index + 1));
}

function normalizeSuffixes(list = [], count = 0) {
  return Array.from({ length: Math.max(0, Number(count) || 0) }, (_unused, index) => String(list[index] || '').replace(/^_+/, ''));
}

function buildDefaultOrganizerTarget(folderPath = '') {
  return String(folderPath || '').replace(/[\\/]+$/, '');
}

function getPathLeaf(value = '') {
  return String(value || '')
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .filter(Boolean)
    .pop() || '';
}

function buildLocalFileUrl(filePath = '') {
  const rawPath = String(filePath || '').trim();
  if (!rawPath) {
    return '';
  }

  const normalizedPath = rawPath.replace(/\\/g, '/');
  const fileUrl = /^[a-zA-Z]:\//.test(normalizedPath)
    ? `file:///${normalizedPath}`
    : normalizedPath.startsWith('//')
      ? `file:${normalizedPath}`
      : normalizedPath.startsWith('/')
        ? `file://${normalizedPath}`
        : `file:///${normalizedPath}`;

  return encodeURI(fileUrl).replace(/#/g, '%23');
}

function getOcrEngineDisplayLabel(value = '', tx) {
  const normalized = normalizeOcrEngineName(value, { allowEmpty: true });
  if (normalized === 'paddle-local') {
    return tx('Local OCR', '本机 OCR');
  }
  if (normalized === 'deepseek-local') {
    return 'DeepSeek OCR';
  }
  if (normalized === 'paddlevl-local') {
    return 'PaddleOCR-VL 1.6';
  }
  if (normalized === 'paddle-api') {
    return 'PaddleOCR API';
  }
  return String(value || '').trim();
}

function getExpectedSuffixCount(config = {}) {
  const groupSize = Math.max(1, Number(config.groupSize) || 1);
  if (config.namingMode === 'number') {
    return groupSize;
  }
  if (config.labelNamingTarget === 'style') {
    return Math.max(0, groupSize - 1);
  }
  return 0;
}

function syncSuffixConfig(nextConfig = {}) {
  const expectedCount = getExpectedSuffixCount(nextConfig);
  return {
    ...nextConfig,
    imageSuffixes: normalizeSuffixes(
      Array.isArray(nextConfig.imageSuffixes) && nextConfig.imageSuffixes.length > 0
        ? nextConfig.imageSuffixes
        : buildDefaultSuffixes(expectedCount),
      expectedCount,
    ),
  };
}

function normalizeStyleNameField(value = '') {
  const raw = String(value || '').trim();
  return STYLE_NAME_FIELD_OPTIONS.some((option) => option.value === raw) ? raw : 'styleNumber';
}

function cleanReviewComposition(value = '') {
  const normalized = String(value || '')
    .trim()
    .replace(/^(?:C[O0]MPOSITI[O0]N|C[O0]MPOSITI[O0]|C[O0]MPOSIT|C[O0]NTENT|C[O0]NT|C[O0]MP|[O0]NTENT|NTENT|TENT|ENT|SPEC)C?\s*[:：-]?\s*/i, '')
    .replace(/(\d)\s*%\s*([A-Za-z]+)/g, '$1%$2')
    .replace(/%\s*([A-Za-z])/g, '% $1')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return normalized;
}

function looksLikeReviewComposition(value = '') {
  const text = String(value || '').trim();
  const compact = text.replace(/\s+/g, '').toUpperCase();
  return /\d{1,3}\s*%/.test(text)
    || /(COTTON|CTN|POLYESTER|POLY|SPANDEX|SPAN|ELASTANE|VISCOSE|RAYON|NYLON|LINEN|WOOL|ACRYLIC|MODAL|TENCEL|LYOCELL|SILK)/i.test(text)
    || (/\b\d{1,3}\s*\/\s*\d{1,3}(?:\s*\/\s*\d{1,3}){0,5}\s*[A-Z][A-Z/\s]{0,24}/i.test(text) && !/["”″]/.test(text))
    || (compact.includes('%') && /\d{1,3}%?[A-Z]{1,8}\d{1,3}%?[A-Z]{1,8}/i.test(compact));
}

function extractReviewCompositionFromRawText(rawText = '') {
  const lines = String(rawText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index];
    const isCompositionLine = /^(?:C[O0]MPOSITI[O0]N|C[O0]NTENT|C[O0]NT|C[O0]MP|[O0]NTENT|NTENT|TENT|ENT)\b/i.test(current);
    if (!isCompositionLine) {
      continue;
    }
    const candidates = [
      cleanReviewComposition(current),
      cleanReviewComposition(lines[index + 1] || ''),
      cleanReviewComposition(lines[index - 1] || ''),
    ].filter(Boolean);
    const match = candidates.find((candidate) => looksLikeReviewComposition(candidate));
    if (match) {
      return match;
    }
  }

  const fallback = lines
    .map((line) => cleanReviewComposition(line))
    .find((line) => looksLikeReviewComposition(line));
  return fallback || '';
}

function getDetectorBoxSource(value = '') {
  return String(value || '').trim();
}

function isOcrLocatedBox(value = '') {
  return ['ocr-fields', 'ocr-lines', 'crop-region'].includes(getDetectorBoxSource(value));
}

function getPreviewHitLabel(preview = {}, tx) {
  if (!preview?.detectorCropBox) {
    return tx('No label box detected', '未检测到标签框');
  }
  if (preview.detectorUsed) {
    return tx('Detector hit', '检测命中');
  }
  if (isOcrLocatedBox(preview.detectorBoxSource || preview.detectorFallbackReason)) {
    return tx('Text located', '文字定位');
  }
  return tx('Label located', '已定位标签');
}

function getPreviewConfidenceLabel(preview = {}, tx) {
  const confidence = Number(preview?.detectorConfidence);
  if (Number.isFinite(confidence)) {
    return tx(`Confidence ${confidence.toFixed(2)}`, `置信度 ${confidence.toFixed(2)}`);
  }
  if (preview?.detectorCropBox && isOcrLocatedBox(preview.detectorBoxSource || preview.detectorFallbackReason)) {
    return tx('Text-location box', '文字定位框');
  }
  return tx('No detector confidence', '无检测置信度');
}

function getReviewPriority(item = {}) {
  const labelInfo = item?.labelInfo || {};
  if (labelInfo.detectorCropBox && isOcrLocatedBox(labelInfo.detectorBoxSource || labelInfo.detectorFallbackReason)) {
    return 2;
  }
  const confidence = Number(item?.labelInfo?.detectorConfidence);
  if (!Number.isFinite(confidence)) {
    return 1;
  }
  if (confidence < 0.72) {
    return 1;
  }
  return 2;
}

function sortReviewItems(items = []) {
  return [...items].sort((left, right) => {
    const priorityDiff = getReviewPriority(left) - getReviewPriority(right);
    if (priorityDiff !== 0) {
      return priorityDiff;
    }

    const leftConfidence = Number(left?.labelInfo?.detectorConfidence);
    const rightConfidence = Number(right?.labelInfo?.detectorConfidence);
    const normalizedLeft = Number.isFinite(leftConfidence) ? leftConfidence : 999;
    const normalizedRight = Number.isFinite(rightConfidence) ? rightConfidence : 999;
    if (normalizedLeft !== normalizedRight) {
      return normalizedLeft - normalizedRight;
    }

    return String(left?.styleNumber || left?.folderName || '').localeCompare(
      String(right?.styleNumber || right?.folderName || ''),
      undefined,
      { numeric: true, sensitivity: 'base' },
    );
  });
}

function buildPreviewStateFromReviewItem(item = {}) {
  const labelInfo = item?.labelInfo || {};
  const imagePath = String(
    item?.labelImagePath
    || item?.files?.label
    || item?.sourceFiles?.label
    || '',
  ).trim();

  if (!imagePath) {
    return null;
  }

  return {
    stage: 'review',
    imagePath,
    detectorSourceImagePath: imagePath,
    crop: labelInfo.crop || 'full',
    angle: Number(labelInfo.angle || 0),
    detectorUsed: Boolean(labelInfo.detectorUsed),
    detectorFallbackReason: labelInfo.detectorFallbackReason || '',
    detectorCropBox: labelInfo.detectorCropBox || null,
    detectorBoxSource: labelInfo.detectorBoxSource || '',
    detectorConfidence: Number.isFinite(Number(labelInfo.detectorConfidence))
      ? Number(labelInfo.detectorConfidence)
      : null,
    detectorSourceImageSize: labelInfo.detectorSourceImageSize || null,
  };
}

function clampPreviewBox(box = null, size = null) {
  if (!box || !size?.width || !size?.height) {
    return null;
  }

  const left = Math.max(0, Math.min(Number(box.left) || 0, size.width - 1));
  const top = Math.max(0, Math.min(Number(box.top) || 0, size.height - 1));
  const right = Math.max(left + 1, Math.min((Number(box.left) || 0) + (Number(box.width) || 0), size.width));
  const bottom = Math.max(top + 1, Math.min((Number(box.top) || 0) + (Number(box.height) || 0), size.height));

  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
  };
}

function mergeLivePreview(currentPreview = null, nextPreview = null) {
  if (!nextPreview) {
    return currentPreview;
  }

  const currentPath = String(
    currentPreview?.detectorSourceImagePath || currentPreview?.imagePath || '',
  ).trim();
  const nextPath = String(
    nextPreview?.detectorSourceImagePath || nextPreview?.imagePath || '',
  ).trim();

  if (
    currentPreview?.detectorCropBox
    && !nextPreview?.detectorCropBox
    && currentPath
    && nextPath
    && currentPath === nextPath
  ) {
    return currentPreview;
  }

  return nextPreview;
}

function OrganizerLivePreviewCard({ preview, tx, title }) {
  const stageWrapRef = useRef(null);
  const dragRef = useRef(null);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  const displayPath = String(preview?.detectorSourceImagePath || preview?.imagePath || '').trim();
  const imageSrc = useMemo(() => (displayPath ? buildLocalFileUrl(displayPath) : ''), [displayPath]);
  const size = preview?.detectorSourceImageSize || naturalSize;
  const hasBox = Boolean(preview?.detectorCropBox);
  const fitScale = useMemo(() => {
    if (!size?.width || !size?.height || !stageSize.width || !stageSize.height) {
      return 0.58;
    }
    const fitWidthScale = Math.max(0.05, (stageSize.width - 32) / size.width);
    const fitHeightScale = Math.max(0.05, (stageSize.height - 32) / size.height);
    return Math.max(0.05, Math.min(fitWidthScale, fitHeightScale, 1));
  }, [size?.height, size?.width, stageSize.height, stageSize.width]);
  const renderScale = useMemo(() => {
    const box = clampPreviewBox(preview?.detectorCropBox, size);
    if (!box || !size?.width || !size?.height || !stageSize.width || !stageSize.height) {
      return fitScale;
    }
    const safeWidthScale = Math.max(0.05, (stageSize.width - 80) / Math.max(1, box.width));
    const safeHeightScale = Math.max(0.05, (stageSize.height - 80) / Math.max(1, box.height));
    return Math.max(fitScale, Math.min(safeWidthScale, safeHeightScale, 1));
  }, [fitScale, preview?.detectorCropBox, size, stageSize.height, stageSize.width]);
  const boxLayout = useMemo(() => {
    const box = clampPreviewBox(preview?.detectorCropBox, size);
    if (!box || !size?.width || !size?.height) {
      return null;
    }
    return {
      left: box.left * renderScale,
      top: box.top * renderScale,
      width: box.width * renderScale,
      height: box.height * renderScale,
    };
  }, [preview?.detectorCropBox, renderScale, size]);
  const drawSize = useMemo(() => {
    if (!size?.width || !size?.height) {
      return {
        width: Math.max(1, Math.round((stageSize.width || 1) * 0.72)),
        height: Math.max(1, Math.round((stageSize.height || 1) * 0.72)),
      };
    }
    return {
      width: Math.max(1, Math.round(size.width * renderScale)),
      height: Math.max(1, Math.round(size.height * renderScale)),
    };
  }, [renderScale, size?.height, size?.width, stageSize.height, stageSize.width]);
  const canScroll = hasBox || drawSize.width > stageSize.width || drawSize.height > stageSize.height;

  useEffect(() => {
    setNaturalSize({ width: 0, height: 0 });
    const wrap = stageWrapRef.current;
    if (wrap) {
      wrap.scrollTo({ left: 0, top: 0, behavior: 'auto' });
    }
  }, [displayPath]);

  useEffect(() => {
    const element = stageWrapRef.current;
    if (!element || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) {
        setStageSize({
          width: Math.max(1, Math.round(box.width)),
          height: Math.max(1, Math.round(box.height)),
        });
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const wrap = stageWrapRef.current;
    if (!wrap || !boxLayout) {
      return undefined;
    }
    const centerBox = () => {
      const boxCenterX = boxLayout.left + (boxLayout.width / 2);
      const boxCenterY = boxLayout.top + (boxLayout.height / 2);
      wrap.scrollTo({
        left: Math.min(Math.max(0, wrap.scrollWidth - wrap.clientWidth), Math.max(0, boxCenterX - (wrap.clientWidth / 2))),
        top: Math.min(Math.max(0, wrap.scrollHeight - wrap.clientHeight), Math.max(0, boxCenterY - (wrap.clientHeight / 2))),
        behavior: 'auto',
      });
    };
    const frameId = window.requestAnimationFrame(() => {
      centerBox();
      window.setTimeout(centerBox, 80);
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [boxLayout, displayPath, renderScale]);

  const handleImageLoad = (event) => {
    const image = event.currentTarget;
    setNaturalSize({
      width: Math.max(1, Math.round(image.naturalWidth || 0)),
      height: Math.max(1, Math.round(image.naturalHeight || 0)),
    });
  };
  const handleImageError = () => setNaturalSize({ width: 0, height: 0 });
  const handleDragStart = (event) => {
    const wrap = stageWrapRef.current;
    if (!wrap || event.button !== 0) {
      return;
    }
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: wrap.scrollLeft,
      scrollTop: wrap.scrollTop,
    };
    wrap.setPointerCapture?.(event.pointerId);
  };
  const handleDragMove = (event) => {
    const drag = dragRef.current;
    const wrap = stageWrapRef.current;
    if (!drag || !wrap || drag.pointerId !== event.pointerId) {
      return;
    }
    wrap.scrollLeft = drag.scrollLeft - (event.clientX - drag.startX);
    wrap.scrollTop = drag.scrollTop - (event.clientY - drag.startY);
  };
  const handleDragEnd = (event) => {
    const wrap = stageWrapRef.current;
    if (wrap && dragRef.current?.pointerId === event.pointerId) {
      wrap.releasePointerCapture?.(event.pointerId);
    }
    dragRef.current = null;
  };

  return (
    <div className={`image-organizer-live-preview-card ${hasBox ? 'has-hit' : ''}`}>
      <div className="organizer-preview-meta compact">
        <span className="organizer-preview-context-pill">{title}</span>
        <span className={`organizer-preview-pill ${hasBox ? 'hit' : ''}`}>
          {hasBox ? getPreviewHitLabel(preview, tx) : tx('Full image', '整张原图')}
        </span>
        <span className="organizer-preview-filename">{getPathLeaf(preview?.imagePath || '')}</span>
      </div>
      <div
        ref={stageWrapRef}
        className={`image-organizer-preview-stage-wrap ${canScroll ? 'is-scrollable' : 'is-fit'}`}
        onPointerDown={handleDragStart}
        onPointerMove={handleDragMove}
        onPointerUp={handleDragEnd}
        onPointerCancel={handleDragEnd}
        onPointerLeave={handleDragEnd}
      >
        <div className="organizer-preview-stage image-organizer-preview-stage">
          {imageSrc ? (
            <img
              key={imageSrc}
              src={imageSrc}
              alt=""
              className="organizer-preview-image"
              draggable="false"
              decoding="async"
              style={{
                width: `${drawSize.width}px`,
                height: `${drawSize.height}px`,
              }}
              onLoad={handleImageLoad}
              onError={handleImageError}
            />
          ) : null}
          {boxLayout ? (
            <>
              <div
                className="image-organizer-preview-overlay"
                style={{
                  left: `${boxLayout.left}px`,
                  top: `${boxLayout.top}px`,
                  width: `${boxLayout.width}px`,
                  height: `${boxLayout.height}px`,
                }}
              />
              <div
                className="image-organizer-preview-tag"
                style={{
                  left: `${boxLayout.left}px`,
                  top: `${Math.max(boxLayout.top - 30, 10)}px`,
                }}
              >
                {tx('Label hit', '标签命中')}
              </div>
            </>
          ) : null}
        </div>
      </div>
      <div className="image-organizer-hero-meta compact">
        <span>{preview?.stage === 'label-source' ? tx('Source image', '原始图') : tx('OCR stage', 'OCR 阶段')}</span>
        <span>{Math.round(renderScale * 100)}%</span>
        <span>
          {getPreviewConfidenceLabel(preview, tx)}
        </span>
      </div>
    </div>
  );
}

function buildReviewDraftFromItem(item = {}, options = {}) {
  const labelInfo = item?.labelInfo || {};
  const isFabricNaming = options.labelNamingTarget === 'fabric';
  const composition = cleanReviewComposition(labelInfo.composition || '')
    || extractReviewCompositionFromRawText(labelInfo.rawText || '');
  return {
    fabricCode: labelInfo.fabricCode || '',
    styleNumber: isFabricNaming
      ? ''
      : (item?.styleNumber || labelInfo.styleNumber || ''),
    description: labelInfo.description || item?.description || '',
    composition,
    width: labelInfo.width || '',
    cuttable: labelInfo.cuttable || '',
    weight: labelInfo.weight || '',
    reviewNote: item?.review?.note || '',
  };
}

export default function ImageOrganizer({ onNavigate, workspaceVisible = true, homeFeature }) {
  const { tx } = useI18n();
  const [sourceFolder, setSourceFolder] = useState('');
  const [outputPath, setOutputPath] = useState('');
  const [folderInfo, setFolderInfo] = useState(null);
  const [logs, setLogs] = useState([]);
  const [progress, setProgress] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [completionFeedback, setCompletionFeedback] = useState(null);
  const [previewState, setPreviewState] = useState(null);
  const [llmConfig, setLlmConfig] = useState(null);
  const [systemStatus, setSystemStatus] = useState({});
  const [availableOcrEngines, setAvailableOcrEngines] = useState([]);
  const acceptProgressRef = useRef(false);
  const previewObjectUrlRef = useRef('');
  const previewStateRef = useRef(null);
  const previewHoldUntilRef = useRef(0);
  const pendingPreviewRef = useRef(null);
  const previewHoldTimerRef = useRef(null);
  const pendingLivePreviewSlotsRef = useRef([]);
  const livePreviewHoldTimersRef = useRef([]);
  const previewStageRef = useRef(null);
  const previewStageWrapRef = useRef(null);
  const previewDragRef = useRef(null);
  const [previewStageSize, setPreviewStageSize] = useState({ width: 0, height: 0 });
  const [previewNaturalSize, setPreviewNaturalSize] = useState({ width: 0, height: 0 });
  const [config, setConfig] = useState(() => buildDefaultOrganizerConfig());
  const [forceRefresh, setForceRefresh] = useState(false);
  const [organizeSummaryPath, setOrganizeSummaryPath] = useState('');
  const [reviewSummary, setReviewSummary] = useState(null);
  const [reviewItems, setReviewItems] = useState([]);
  const [selectedReviewIndex, setSelectedReviewIndex] = useState(0);
  const [reviewDraft, setReviewDraft] = useState(null);
  const [isSavingReview, setIsSavingReview] = useState(false);
  const [isApplyingReview, setIsApplyingReview] = useState(false);
  const [isExportingExcel, setIsExportingExcel] = useState(false);
  const [reviewModeEnabled, setReviewModeEnabled] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Apply presets from the ModuleHome sub-feature selection.
  useEffect(() => {
    if (!homeFeature) return;
    switch (homeFeature) {
      case 'by-label-fabric':
        setConfig((prev) => ({ ...prev, namingMode: 'label', labelNamingTarget: 'fabric' }));
        break;
      case 'by-label-style':
        setConfig((prev) => ({ ...prev, namingMode: 'label', labelNamingTarget: 'style' }));
        break;
      case 'by-number':
        setConfig((prev) => ({ ...prev, namingMode: 'number' }));
        break;
      case 'review-mode':
        setReviewModeEnabled(true);
        break;
      default:
        break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [homeFeature]);
	  const [reviewZoomMode, setReviewZoomMode] = useState('fit');
	  const [reviewZoomScale, setReviewZoomScale] = useState(1);
	  const [reviewAutoActual, setReviewAutoActual] = useState(true);
  const [livePreviewSlots, setLivePreviewSlots] = useState([]);
  const previewDisplayPath = String(
    previewState?.detectorSourceImagePath || previewState?.imagePath || '',
  ).trim();
  const filteredReviewItems = useMemo(() => reviewItems, [reviewItems]);
  const selectedReviewItem = filteredReviewItems[selectedReviewIndex] || null;
  const previewImageSrc = useMemo(() => {
    const nextPath = previewDisplayPath;
    if (!nextPath) {
      if (previewObjectUrlRef.current) {
        URL.revokeObjectURL(previewObjectUrlRef.current);
        previewObjectUrlRef.current = '';
      }
      return '';
    }
    return buildLocalFileUrl(nextPath);
  }, [previewDisplayPath]);

  useEffect(() => {
    setConfig(buildDefaultOrganizerConfig());
  }, []);

  const clearLivePreviewHolds = () => {
    livePreviewHoldTimersRef.current.forEach((timerId) => {
      if (timerId) {
        window.clearTimeout(timerId);
      }
    });
    livePreviewHoldTimersRef.current = [];
    pendingLivePreviewSlotsRef.current = [];
  };

  useEffect(() => {
    previewStateRef.current = previewState;
  }, [previewState]);

  useEffect(() => {
    setPreviewNaturalSize({ width: 0, height: 0 });
    const wrap = previewStageWrapRef.current;
    if (wrap) {
      wrap.scrollTo({ left: 0, top: 0, behavior: 'auto' });
    }
  }, [previewDisplayPath]);

  useEffect(() => {
    if (window.electronAPI) {
      window.electronAPI.onSlidesLog((log) => setLogs((prev) => [...prev, log]));
      window.electronAPI.onSlidesProgress((value) => {
        if (!acceptProgressRef.current) {
          return;
        }
        setProgress(value);
      });
      window.electronAPI.onSlidesPreview((value) => {
        if (!acceptProgressRef.current) {
          return;
        }
        const nextPreview = value || null;
        if (nextPreview && Number.isInteger(Number(nextPreview.previewSlot))) {
          const slotIndex = Math.max(0, Math.min(1, Number(nextPreview.previewSlot) || 0));
          setLivePreviewSlots((currentSlots) => {
            const nextSlots = [...currentSlots].slice(0, 2);
            const currentSlot = nextSlots[slotIndex] || null;
            const currentPath = String(
              currentSlot?.detectorSourceImagePath || currentSlot?.imagePath || '',
            ).trim();
            const nextPath = String(
              nextPreview?.detectorSourceImagePath || nextPreview?.imagePath || '',
            ).trim();
            const shouldHoldCurrentHit = currentSlot?.detectorCropBox
              && !nextPreview?.detectorCropBox
              && currentPath
              && nextPath
              && currentPath !== nextPath;

            if (nextPreview?.detectorCropBox) {
              pendingLivePreviewSlotsRef.current[slotIndex] = null;
              if (livePreviewHoldTimersRef.current[slotIndex]) {
                window.clearTimeout(livePreviewHoldTimersRef.current[slotIndex]);
                livePreviewHoldTimersRef.current[slotIndex] = null;
              }
              nextSlots[slotIndex] = nextPreview;
              return nextSlots;
            }

            if (shouldHoldCurrentHit) {
              pendingLivePreviewSlotsRef.current[slotIndex] = nextPreview;
              if (livePreviewHoldTimersRef.current[slotIndex]) {
                window.clearTimeout(livePreviewHoldTimersRef.current[slotIndex]);
              }
              livePreviewHoldTimersRef.current[slotIndex] = window.setTimeout(() => {
                const pendingPreview = pendingLivePreviewSlotsRef.current[slotIndex];
                pendingLivePreviewSlotsRef.current[slotIndex] = null;
                livePreviewHoldTimersRef.current[slotIndex] = null;
                if (pendingPreview) {
                  setLivePreviewSlots((latestSlots) => {
                    const updatedSlots = [...latestSlots].slice(0, 2);
                    updatedSlots[slotIndex] = mergeLivePreview(updatedSlots[slotIndex], pendingPreview);
                    return updatedSlots;
                  });
                }
              }, DETECTOR_BOX_HOLD_MS);
              return nextSlots;
            }

            pendingLivePreviewSlotsRef.current[slotIndex] = null;
            nextSlots[slotIndex] = mergeLivePreview(currentSlot, nextPreview);
            return nextSlots;
          });
          setPreviewState(nextPreview);
          return;
        }
        setPreviewState((currentPreview) => {
          const activePreview = currentPreview || previewStateRef.current || null;
          const hasDetectorBox = Boolean(nextPreview?.detectorCropBox);
          const currentPreviewPath = String(
            activePreview?.detectorSourceImagePath || activePreview?.imagePath || '',
          ).trim();
          const nextPreviewPath = String(
            nextPreview?.detectorSourceImagePath || nextPreview?.imagePath || '',
          ).trim();

          if (hasDetectorBox) {
            pendingPreviewRef.current = null;
            if (previewHoldTimerRef.current) {
              window.clearTimeout(previewHoldTimerRef.current);
              previewHoldTimerRef.current = null;
            }
            return nextPreview;
          }

          if (
            activePreview?.detectorCropBox
            && currentPreviewPath
            && nextPreviewPath
            && currentPreviewPath === nextPreviewPath
          ) {
            return activePreview;
          }

          if (
            activePreview?.detectorCropBox
            && currentPreviewPath
            && nextPreviewPath
            && currentPreviewPath !== nextPreviewPath
          ) {
            pendingPreviewRef.current = nextPreview;
            previewHoldUntilRef.current = Date.now() + DETECTOR_BOX_HOLD_MS;
            if (previewHoldTimerRef.current) {
              window.clearTimeout(previewHoldTimerRef.current);
            }
            previewHoldTimerRef.current = window.setTimeout(() => {
              previewHoldTimerRef.current = null;
              const pendingPreview = pendingPreviewRef.current;
              pendingPreviewRef.current = null;
              previewHoldUntilRef.current = 0;
              if (pendingPreview) {
                setPreviewState(pendingPreview);
              }
            }, DETECTOR_BOX_HOLD_MS);
            return activePreview;
          }

          pendingPreviewRef.current = null;
          previewHoldUntilRef.current = 0;
          return nextPreview;
        });
      });
    }

    return () => {
      if (previewHoldTimerRef.current) {
        window.clearTimeout(previewHoldTimerRef.current);
        previewHoldTimerRef.current = null;
      }
      clearLivePreviewHolds();
      window.electronAPI?.removeSlidesListeners?.();
    };
  }, []);

  useEffect(() => () => {
    if (previewObjectUrlRef.current) {
      URL.revokeObjectURL(previewObjectUrlRef.current);
      previewObjectUrlRef.current = '';
    }
  }, []);

  useEffect(() => {
    const element = previewStageWrapRef.current || previewStageRef.current;
    if (!element || typeof ResizeObserver === 'undefined') {
      return undefined;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      const box = entry?.contentRect;
      if (!box) {
        return;
      }
      setPreviewStageSize({
        width: Math.round(box.width) || 0,
        height: Math.round(box.height) || 0,
      });
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, [previewImageSrc, reviewModeEnabled]);

  useEffect(() => {
    let disposed = false;
    window.electronAPI?.loadLLMConfig?.().then((cfg) => {
      if (!disposed) {
        setLlmConfig(cfg || null);
      }
    }).catch(() => {});
    // Load system status for OCR engine availability checks
    window.electronAPI?.getSystemStatus?.().then((status) => {
      if (!disposed) {
        setSystemStatus(status || {});
      }
    }).catch(() => {});
    // Detect available OCR engines from backend
    window.electronAPI?.ocrDetectAvailableEngines?.().then((oe) => {
      if (!disposed && oe?.success && oe.engines?.length > 0) {
        setAvailableOcrEngines(oe.engines);
      }
    }).catch(() => {});
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => (
    subscribeSharedLabelOcrProfile((nextProfile) => {
      setConfig((prev) => ({
        ...prev,
        labelOcrProfile: nextProfile,
      }));
    })
  ), []);

  const addLog = (message, type = 'info') => {
    setLogs((prev) => [...prev, { time: new Date().toLocaleTimeString(), message, type }]);
  };

  const updateConfig = (updates) => {
    setConfig((prev) => syncSuffixConfig(
      typeof updates === 'function' ? updates(prev) : { ...prev, ...updates },
    ));
  };

  const groupSize = Math.max(1, Number(config.groupSize) || 1);
  const labelIndex = Math.min(groupSize, Math.max(1, Number(config.labelIndex) || groupSize));
  const usesOcr = config.namingMode === 'label';
  const usesFixedGroups = config.namingMode === 'number' || config.labelNamingTarget === 'style';
  const isFabricLabelNaming = config.namingMode === 'label' && config.labelNamingTarget === 'fabric';
  const visibleSuffixFields = useMemo(() => {
    if (!usesFixedGroups) {
      return [];
    }

    if (config.namingMode === 'label') {
      let suffixIndex = 0;
      return Array.from({ length: groupSize }, (_unused, slotIndex) => {
        const position = slotIndex + 1;
        if (position === labelIndex) {
          return null;
        }

        const currentSuffixIndex = suffixIndex;
        suffixIndex += 1;
        return {
          position,
          suffixIndex: currentSuffixIndex,
          value: config.imageSuffixes[currentSuffixIndex] || '',
        };
      }).filter(Boolean);
    }

    return Array.from({ length: groupSize }, (_unused, slotIndex) => ({
      position: slotIndex + 1,
      suffixIndex: slotIndex,
      value: config.imageSuffixes[slotIndex] || '',
    }));
  }, [config.imageSuffixes, config.namingMode, groupSize, labelIndex, usesFixedGroups]);
  const estimatedGroups = useMemo(() => {
    if (!folderInfo?.fileCount) {
      return 0;
    }
    if (isFabricLabelNaming) {
      return folderInfo.fileCount;
    }
    return Math.floor(folderInfo.fileCount / Math.max(1, groupSize));
  }, [folderInfo, groupSize, isFabricLabelNaming]);
  const ocrEngineOptions = useMemo(
    () => {
      if (availableOcrEngines.length > 0) {
        return availableOcrEngines;
      }
      return getOcrEngineOptions(
        undefined,
        llmConfig?.ocr || {},
        systemStatus,
        llmConfig?.local?.installedModels || [],
      );
    },
    [llmConfig, systemStatus, availableOcrEngines],
  );

  useEffect(() => {
    if (!usesOcr || ocrEngineOptions.length === 0) {
      return;
    }

    const normalizedCurrent = normalizeOcrEngineName(config.ocrEngine);
    if (!ocrEngineOptions.some((option) => option.value === normalizedCurrent)) {
      updateConfig({ ocrEngine: ocrEngineOptions[0].value });
    }
  }, [config.ocrEngine, ocrEngineOptions, usesOcr]);

  const openLocalPath = async (targetPath) => {
    if (!targetPath || !window.electronAPI?.openLocalPath) {
      return;
    }

    const result = await window.electronAPI.openLocalPath(targetPath);
    if (!result?.success) {
      addLog(`Open failed: ${result?.error || 'Unknown error'}`, 'error');
    }
  };

  const loadOrganizerReviewData = async (summaryPath) => {
    if (!summaryPath || !window.electronAPI?.readFile) {
      return [];
    }

    const summaryResult = await window.electronAPI.readFile(summaryPath);
    if (!summaryResult?.success) {
      addLog(`Review load failed: ${summaryResult?.error || 'Unknown error'}`, 'warning');
      return [];
    }

    try {
      const parsedSummary = JSON.parse(summaryResult.content || '{}');
      const styles = sortReviewItems(Array.isArray(parsedSummary?.styles) ? parsedSummary.styles : []);
      setReviewSummary(parsedSummary);
      setReviewItems(styles);
      setSelectedReviewIndex(0);
      setReviewModeEnabled(false);
      setReviewDraft(styles[0] ? buildReviewDraftFromItem(styles[0], {
        labelNamingTarget: parsedSummary?.labelNamingTarget,
      }) : null);
      return styles;
    } catch (error) {
      addLog(`Review parse failed: ${error.message}`, 'warning');
      return [];
    }
  };

  const handleSelectFolder = async () => {
    const dir = await window.electronAPI?.selectDir?.();
    if (!dir) {
      return;
    }

    setSourceFolder(dir);
    setOutputPath(buildDefaultOrganizerTarget(dir));

    const dirResult = await window.electronAPI?.readDir?.(dir);
    if (dirResult?.success) {
      const topLevelFiles = dirResult.items.filter((item) => item.isFile && !String(item.name || '').startsWith('.'));
      setFolderInfo({ fileCount: topLevelFiles.length });
      addLog(`Found ${topLevelFiles.length} top-level files.`, 'success');
    }
  };

  const handleSelectOutput = async () => {
    const dir = await window.electronAPI?.selectDir?.();
    if (dir) {
      setOutputPath(dir);
    }
  };

  const handleOutputModeChange = (organizeOutputMode) => {
    updateConfig((prev) => ({
      ...prev,
      organizeOutputMode,
      organizeAction: organizeOutputMode === 'single-folder' ? 'move' : 'copy',
    }));
  };

  const handleGenerate = async () => {
    if (!sourceFolder) {
      return;
    }

    setIsRunning(true);
    setIsCancelling(false);
    setLogs([]);
    setProgress(0);
    setPreviewState(null);
    setLivePreviewSlots([]);
    setOrganizeSummaryPath('');
    previewHoldUntilRef.current = 0;
    pendingPreviewRef.current = null;
    if (previewHoldTimerRef.current) {
      window.clearTimeout(previewHoldTimerRef.current);
      previewHoldTimerRef.current = null;
    }
    clearLivePreviewHolds();
    setCompletionFeedback(null);
    acceptProgressRef.current = true;
    addLog('Starting image organizer...', 'info');
    if (forceRefresh) {
      addLog('Cache bypass enabled. Label OCR will run again for this task.', 'info');
    }

    try {
      const result = await window.electronAPI?.organizeStyleImages?.({
        sourceFolder,
        outputFolder: outputPath || buildDefaultOrganizerTarget(sourceFolder),
        config: {
          ...config,
          groupSize,
          labelIndex,
          forceRefresh,
        },
      });

      if (result?.success) {
        acceptProgressRef.current = false;
        setProgress(100);
        addLog('Image organization completed.', 'success');
        addLog(`Saved to: ${result.outputPath}`, 'success');
        addLog(`Organized ${result.styleCount} groups`, 'info');
        if (!forceRefresh && logs.some((entry) => /Using cached label analysis\./i.test(String(entry?.message || '')))) {
          addLog('Label OCR: This run reused cached label analysis, so OCR did not need to run again for those images.', 'info');
        }
        if (result.failedCount) {
          addLog(`${result.failedCount} groups still need manual review.`, 'warning');
        }
        if (result.unmatchedCount) {
          addLog(`${result.unmatchedCount} images were left unmatched.`, 'warning');
        }
        setCompletionFeedback({
          state: 'success',
          title: tx('Image organization complete', '图片整理完成'),
          message: tx('Renamed files are ready for review.', '重命名后的文件已经准备好。'),
          meta: [
            `${result.styleCount} ${tx('groups', '组')}`,
            result.outputPath ? `${tx('Folder', '文件夹')} · ${getPathLeaf(result.outputPath)}` : null,
            forceRefresh ? tx('Forced refresh', '强制重跑') : null,
            logs.some((entry) => /Using cached label analysis\./i.test(String(entry?.message || '')))
              ? tx('Used cached OCR', '使用了缓存 OCR')
              : null,
            result.unmatchedCount ? `${result.unmatchedCount} ${tx('unmatched', '未匹配')}` : null,
          ],
          outputPath: result.outputPath,
          issues: result.issues || null,
        });
        if (result.summaryPath) {
          setOrganizeSummaryPath(result.summaryPath);
          const loadedStyles = await loadOrganizerReviewData(result.summaryPath);
          if ((loadedStyles?.length || 0) === 0) {
            addLog('Review mode data was not prepared for this run.', 'warning');
          }
        }
      } else if (result?.cancelled) {
        acceptProgressRef.current = false;
        setProgress(0);
        setPreviewState(null);
        clearLivePreviewHolds();
        setLivePreviewSlots([]);
        addLog('Organization cancelled.', 'warning');
        setCompletionFeedback(null);
      } else {
        throw new Error(result?.error || 'Organizer failed.');
      }
    } catch (error) {
      acceptProgressRef.current = false;
      addLog(`Failed: ${error.message}`, 'error');
      setProgress(0);
      setPreviewState(null);
      clearLivePreviewHolds();
      setLivePreviewSlots([]);
      setCompletionFeedback(null);
    } finally {
      setIsRunning(false);
      setIsCancelling(false);
    }
  };

  const handleCancel = async () => {
    if (!window.electronAPI?.cancelTask || isCancelling || !isRunning) {
      return;
    }

    setIsCancelling(true);
    addLog('Cancellation requested. Stopping the organizer...', 'warning');
    await window.electronAPI.cancelTask('slides');
  };

  const handleClearLogs = () => {
    setLogs([]);
    if (!isRunning) {
      acceptProgressRef.current = false;
      setProgress(0);
      setPreviewState(null);
      clearLivePreviewHolds();
      setLivePreviewSlots([]);
      setCompletionFeedback(null);
    }
  };

  const handleResetWorkspace = () => {
    setSourceFolder('');
    setOutputPath('');
    setFolderInfo(null);
    setLogs([]);
    setProgress(0);
    setIsRunning(false);
    setIsCancelling(false);
    setCompletionFeedback(null);
    setPreviewState(null);
    setLivePreviewSlots([]);
    setOrganizeSummaryPath('');
    acceptProgressRef.current = false;
    previewHoldUntilRef.current = 0;
    pendingPreviewRef.current = null;
    if (previewHoldTimerRef.current) {
      window.clearTimeout(previewHoldTimerRef.current);
      previewHoldTimerRef.current = null;
    }
    clearLivePreviewHolds();
    setConfig(buildDefaultOrganizerConfig());
    setReviewSummary(null);
    setReviewItems([]);
    setSelectedReviewIndex(0);
    setReviewDraft(null);
    setReviewModeEnabled(false);
  };

  useEffect(() => {
    const nextItem = filteredReviewItems[selectedReviewIndex] || null;
    setReviewDraft(nextItem ? buildReviewDraftFromItem(nextItem, {
      labelNamingTarget: reviewSummary?.labelNamingTarget,
    }) : null);
    const reviewPreview = buildPreviewStateFromReviewItem(nextItem);
    if (reviewPreview && !isRunning) {
      setPreviewNaturalSize({ width: 0, height: 0 });
      setPreviewState(reviewPreview);
    }
  }, [filteredReviewItems, isRunning, reviewSummary?.labelNamingTarget, selectedReviewIndex]);

  useEffect(() => {
    if (reviewModeEnabled) {
      setReviewZoomMode('fit');
      setReviewZoomScale(1);
      setReviewAutoActual(true);
    }
  }, [reviewModeEnabled, selectedReviewIndex]);

  useEffect(() => {
    if (selectedReviewIndex >= filteredReviewItems.length) {
      setSelectedReviewIndex(0);
    }
  }, [filteredReviewItems.length, selectedReviewIndex]);

	  const persistReviewSummary = async (nextStyles) => {
	    if (!reviewSummary?.summaryPath || !window.electronAPI?.saveOrganizeInfo) {
	      return;
	    }

    const nextSummary = {
      ...reviewSummary,
      styles: nextStyles,
      reviewedAt: new Date().toISOString(),
    };
    const result = await window.electronAPI.saveOrganizeInfo({
      filePath: reviewSummary.summaryPath,
      content: nextSummary,
    });
    if (!result?.success) {
      throw new Error(result?.error || 'Summary save failed');
    }
	    setReviewSummary(nextSummary);
	  };

	  const handleReviewStyleNameFieldChange = async (fieldName) => {
	    if (!reviewSummary?.summaryPath || !window.electronAPI?.saveOrganizeInfo) {
	      return;
	    }

	    const nextField = normalizeStyleNameField(fieldName);
	    const nextSummary = {
	      ...reviewSummary,
	      styleNameField: nextField,
	      reviewedAt: new Date().toISOString(),
	    };
	    const result = await window.electronAPI.saveOrganizeInfo({
	      filePath: reviewSummary.summaryPath,
	      content: nextSummary,
	    });
	    if (!result?.success) {
	      addLog(`Review setting save failed: ${result?.error || 'Unknown error'}`, 'error');
	      return;
	    }
	    setReviewSummary(nextSummary);
	  };

  const handleSaveReview = async (options = {}) => {
    if (!selectedReviewItem?.infoPath || !reviewDraft || !window.electronAPI?.saveOrganizeInfo) {
      return false;
    }

    setIsSavingReview(true);
    try {
	        const nextPayload = {
	          ...selectedReviewItem,
	          styleNumber: reviewSummary?.labelNamingTarget === 'fabric'
	            ? (selectedReviewItem.styleNumber || '')
	            : (reviewDraft.styleNumber || ''),
	          description: reviewDraft.description || '',
	          labelInfo: {
	            ...(selectedReviewItem.labelInfo || {}),
	            styleNumber: reviewSummary?.labelNamingTarget === 'fabric'
	              ? ''
	              : (reviewDraft.styleNumber || ''),
	            description: reviewDraft.description || '',
	            fabricCode: reviewDraft.fabricCode || '',
	            composition: reviewDraft.composition || '',
          width: reviewDraft.width || '',
          cuttable: reviewDraft.cuttable || '',
          weight: reviewDraft.weight || '',
        },
        review: {
          ...(selectedReviewItem.review || {}),
          note: reviewDraft.reviewNote || '',
          savedAt: new Date().toISOString(),
        },
      };

      const result = await window.electronAPI.saveOrganizeInfo({
        filePath: selectedReviewItem.infoPath,
        content: nextPayload,
      });

      if (!result?.success) {
        throw new Error(result?.error || 'Save failed');
      }

      const nextItems = sortReviewItems(reviewItems.map((item) => (
        item.infoPath === selectedReviewItem.infoPath ? nextPayload : item
      )));
      setReviewItems(nextItems);
      await persistReviewSummary(nextItems);
      addLog(`Review saved: ${getPathLeaf(selectedReviewItem.infoPath)}`, 'success');
      if (options.advanceNext && selectedReviewIndex < (filteredReviewItems.length - 1)) {
        setSelectedReviewIndex((prev) => Math.min(filteredReviewItems.length - 1, prev + 1));
      }
      return true;
    } catch (error) {
      addLog(`Review save failed: ${error.message}`, 'error');
      return false;
    } finally {
      setIsSavingReview(false);
    }
  };

  const handleApplyReviewResults = async () => {
    if (!reviewSummary?.summaryPath || !window.electronAPI?.applyOrganizeReviewResults || isApplyingReview) {
      return;
    }

    setIsApplyingReview(true);
    try {
      const didSave = await handleSaveReview();
      if (!didSave) {
        throw new Error('Please save the current review item before applying.');
      }

      const result = await window.electronAPI.applyOrganizeReviewResults({
        summaryPath: reviewSummary.summaryPath,
      });
      if (!result?.success) {
        throw new Error(result?.error || 'Apply review failed');
      }

      addLog(`Applied review updates to ${result.updatedCount || 0} groups.`, 'success');
      if (result.summaryPath) {
        await loadOrganizerReviewData(result.summaryPath);
      }
    } catch (error) {
      addLog(`Apply review failed: ${error.message}`, 'error');
    } finally {
      setIsApplyingReview(false);
    }
  };

  const handleExportExcel = async () => {
    const summaryPath = organizeSummaryPath || reviewSummary?.summaryPath || '';
    if (!summaryPath || !window.electronAPI?.exportOrganizeExcel || isExportingExcel) {
      return;
    }

    setIsExportingExcel(true);
    try {
      const result = await window.electronAPI.exportOrganizeExcel({
        summaryPath,
      });
      if (!result?.success) {
        throw new Error(result?.error || 'Excel export failed');
      }

      addLog(`Excel exported: ${result.outputPath}${result.imageCount ? ` (${result.imageCount} images)` : ''}`, 'success');
      if (result.outputPath) {
        await openLocalPath(result.outputPath);
      }
    } catch (error) {
      addLog(`Excel export failed: ${error.message}`, 'error');
    } finally {
      setIsExportingExcel(false);
    }
  };

  const latestLogMessage = logs[logs.length - 1]?.message || '';
  const isReviewMode = reviewModeEnabled && reviewItems.length > 0;
  const fitPreviewScale = useMemo(() => {
    const size = previewState?.detectorSourceImageSize;
    const stageWidth = previewStageSize.width;
    const stageHeight = previewStageSize.height;
    if (!size?.width || !size?.height || !stageWidth || !stageHeight) {
      return 0.58;
    }

    const fitWidthScale = Math.max(0.05, (stageWidth - 40) / size.width);
    const fitHeightScale = Math.max(0.05, (stageHeight - 40) / size.height);
    const fitScale = Math.min(fitWidthScale, fitHeightScale, 1);
    return Math.max(0.05, fitScale);
  }, [previewStageSize.height, previewStageSize.width, previewState]);

	  const previewHasDetectorBox = Boolean(previewState?.detectorCropBox);
  const focusedPreviewScale = useMemo(() => {
    const size = previewState?.detectorSourceImageSize || previewNaturalSize;
    const box = clampPreviewBox(previewState?.detectorCropBox, size);
    const stageWidth = previewStageSize.width;
    const stageHeight = previewStageSize.height;
    if (!box || !size?.width || !size?.height || !stageWidth || !stageHeight) {
      return 1;
    }

    const safeWidthScale = Math.max(0.05, (stageWidth - 96) / Math.max(1, box.width));
    const safeHeightScale = Math.max(0.05, (stageHeight - 96) / Math.max(1, box.height));
    const safeScale = Math.min(safeWidthScale, safeHeightScale);
    const gentleFocusScale = Math.min(1, safeScale);
    return Math.max(fitPreviewScale, gentleFocusScale);
  }, [fitPreviewScale, previewNaturalSize, previewStageSize.height, previewStageSize.width, previewState]);

	  const previewRenderScale = useMemo(() => {
	    if (reviewZoomMode === 'actual') {
	      return 1;
	    }
	
	    if (reviewZoomMode === 'manual') {
	      return Math.max(0.4, Math.min(2.4, Number(reviewZoomScale) || 1));
	    }

	    if (previewHasDetectorBox && reviewAutoActual) {
	      return focusedPreviewScale;
	    }
			
	    return fitPreviewScale;
	  }, [fitPreviewScale, focusedPreviewScale, previewHasDetectorBox, reviewAutoActual, reviewZoomMode, reviewZoomScale]);

  const previewBoxLayout = useMemo(() => {
    const size = previewState?.detectorSourceImageSize || previewNaturalSize;
    const box = clampPreviewBox(previewState?.detectorCropBox, size);
    const stageWidth = previewStageSize.width;
    const stageHeight = previewStageSize.height;
    if (!box || !size?.width || !size?.height || !stageWidth || !stageHeight) {
      return null;
    }

    return {
      left: box.left * previewRenderScale,
      top: box.top * previewRenderScale,
      width: box.width * previewRenderScale,
      height: box.height * previewRenderScale,
    };
  }, [previewNaturalSize, previewRenderScale, previewStageSize.height, previewStageSize.width, previewState]);

  const previewDrawSize = useMemo(() => {
    const sourceSize = previewNaturalSize.width && previewNaturalSize.height
      ? previewNaturalSize
      : (previewState?.detectorSourceImageSize || null);
    if (!sourceSize?.width || !sourceSize?.height) {
      const stageWidth = Math.max(1, previewStageSize.width || 1);
      const stageHeight = Math.max(1, previewStageSize.height || 1);
      return {
        width: Math.max(1, Math.round(stageWidth * 0.72)),
        height: Math.max(1, Math.round(stageHeight * 0.72)),
      };
    }

    return {
      width: Math.max(1, Math.round(sourceSize.width * previewRenderScale)),
      height: Math.max(1, Math.round(sourceSize.height * previewRenderScale)),
    };
  }, [previewNaturalSize, previewRenderScale, previewStageSize.height, previewStageSize.width, previewState]);
  const previewCanScroll = previewHasDetectorBox
    || previewDrawSize.width > previewStageSize.width
    || previewDrawSize.height > previewStageSize.height;

  useEffect(() => {
    if (!previewBoxLayout) {
      return;
    }

    const wrap = previewStageWrapRef.current;
    if (!wrap) {
      return;
    }

    const centerBox = () => {
      const boxCenterX = previewBoxLayout.left + (previewBoxLayout.width / 2);
      const boxCenterY = previewBoxLayout.top + (previewBoxLayout.height / 2);
      const maxLeft = Math.max(0, wrap.scrollWidth - wrap.clientWidth);
      const maxTop = Math.max(0, wrap.scrollHeight - wrap.clientHeight);
      wrap.scrollTo({
        left: Math.min(maxLeft, Math.max(0, boxCenterX - (wrap.clientWidth / 2))),
        top: Math.min(maxTop, Math.max(0, boxCenterY - (wrap.clientHeight / 2))),
        behavior: 'auto',
      });
    };

    const frameId = window.requestAnimationFrame(() => {
      centerBox();
      window.setTimeout(centerBox, 60);
      window.setTimeout(centerBox, 160);
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [
    previewBoxLayout,
    previewRenderScale,
    previewState?.imagePath,
    previewState?.detectorSourceImagePath,
    selectedReviewIndex,
  ]);

  const handlePreviewImageLoad = (event) => {
    const image = event.currentTarget;
    const naturalWidth = Math.max(1, Math.round(image.naturalWidth || 0));
    const naturalHeight = Math.max(1, Math.round(image.naturalHeight || 0));
    setPreviewNaturalSize((current) => (
      current.width === naturalWidth && current.height === naturalHeight
        ? current
        : { width: naturalWidth, height: naturalHeight }
    ));
  };

  const handlePreviewImageError = () => {
    setPreviewNaturalSize({ width: 0, height: 0 });
  };

  const handlePreviewDragStart = (event) => {
    const wrap = previewStageWrapRef.current;
    if (!wrap || event.button !== 0) {
      return;
    }

    previewDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: wrap.scrollLeft,
      scrollTop: wrap.scrollTop,
    };
    wrap.setPointerCapture?.(event.pointerId);
  };

  const handlePreviewDragMove = (event) => {
    const drag = previewDragRef.current;
    const wrap = previewStageWrapRef.current;
    if (!drag || !wrap || drag.pointerId !== event.pointerId) {
      return;
    }

    wrap.scrollLeft = drag.scrollLeft - (event.clientX - drag.startX);
    wrap.scrollTop = drag.scrollTop - (event.clientY - drag.startY);
  };

  const handlePreviewDragEnd = (event) => {
    const wrap = previewStageWrapRef.current;
    if (wrap && previewDragRef.current?.pointerId === event.pointerId) {
      wrap.releasePointerCapture?.(event.pointerId);
    }
    previewDragRef.current = null;
  };

  const progressDetail = latestLogMessage || tx(
    'Detecting labels, grouping images, and writing renamed files.',
    '正在识别标签、分组图片并写入重命名后的文件。',
  );

  const completionActions = completionFeedback?.outputPath
    ? [
        {
          label: tx('Open folder', '打开文件夹'),
          onClick: () => openLocalPath(completionFeedback.outputPath),
        },
        organizeSummaryPath || reviewSummary?.summaryPath ? {
          label: tx('Export Excel', '生成 Excel'),
          onClick: () => { void handleExportExcel(); },
        } : null,
      ]
        .filter(Boolean)
    : [];
  const completionIssues = buildCompletionIssues(completionFeedback?.issues, tx);
	  const previewHasBox = previewHasDetectorBox;
  const previewStatusLabel = getPreviewHitLabel(previewState, tx);
  const taskStateLabel = isRunning
    ? tx('Processing', '处理中')
    : completionFeedback?.state === 'success'
      ? tx('Completed', '已完成')
      : sourceFolder
        ? tx('Ready', '已就绪')
        : tx('Waiting', '待选择');
  const sourceLabel = sourceFolder ? getPathLeaf(sourceFolder) : tx('No folder', '未选择');
  const outputLabel = outputPath ? getPathLeaf(outputPath) : tx('Source folder', '源文件夹');
  const engineLabel = usesOcr
    ? (() => {
        const option = ocrEngineOptions.find((opt) => opt.value === normalizeOcrEngineName(config.ocrEngine));
        if (option?.label) {
          return typeof option.label === 'string' ? option.label : tx(option.label.en, option.label.zh);
        }
        return getOcrEngineDisplayLabel(config.ocrEngine, tx);
      })()
    : tx('Disabled', '未启用');
  const visibleOcrEngineOptions = ocrEngineOptions.length > 0
    ? ocrEngineOptions
    : [{
        value: normalizeOcrEngineName(config.ocrEngine || DEFAULT_OCR_CONFIG.engine),
        label: engineLabel || tx('Local OCR', '本机 OCR'),
      }];
  const reviewSourceLabel = selectedReviewItem?.labelInfo?.ocrEngine
    ? getOcrEngineDisplayLabel(selectedReviewItem.labelInfo.ocrEngine, tx)
    : tx('Unknown', '未知');
  const reviewRawText = String(selectedReviewItem?.labelInfo?.rawText || '').trim();
  const isFabricReview = reviewSummary?.labelNamingTarget === 'fabric';
  const reviewFieldDefs = useMemo(() => {
    const rawTextOriginal = String(selectedReviewItem?.labelInfo?.rawText || '');
    const rawTextUpper = rawTextOriginal.toUpperCase();
    const usedLabels = new Set();
    return LABEL_OCR_FIELD_META.filter((field) => (
      !(isFabricReview && field.key === 'styleNumber')
    )).map((field) => {
      const aliases = parseLabelOcrAliasDraft(config?.labelOcrProfile?.fields?.[field.key]);
      const fallbackLabel = tx(field.label[0].replace(' labels', ''), field.label[1].replace('标签', ''));
      const aliasMatches = (alias) => {
        const token = String(alias || '').trim();
        if (!token) {
          return false;
        }
        if (/[一-鿿]/.test(token)) {
          return rawTextOriginal.includes(token);
        }
        return rawTextUpper.includes(token.toUpperCase());
      };
      // Sort aliases by length (longest first) so "DESCRIPTION" beats "DESC", etc.
      const sortedAliases = [...aliases].sort((left, right) => (
        String(right || '').length - String(left || '').length
      ));
      // 1) Try aliases actually present in the OCR text and not yet claimed by an earlier field.
      let primaryAlias = sortedAliases.find((alias) => aliasMatches(alias) && !usedLabels.has(alias));
      // 2) Otherwise fall back to the first alias in the user's settings list that isn't already taken.
      if (!primaryAlias) {
        primaryAlias = aliases.find((alias) => alias && !usedLabels.has(alias));
      }
      // 3) Last resort: use the localized field label (always unique per field).
      if (!primaryAlias) {
        primaryAlias = fallbackLabel;
      }
      usedLabels.add(primaryAlias);
      return {
        key: field.key,
        displayLabel: primaryAlias,
        fallbackLabel,
      };
    });
  }, [config?.labelOcrProfile, isFabricReview, tx, selectedReviewItem]);
  const hasPrevReview = selectedReviewIndex > 0;
  const hasNextReview = selectedReviewIndex < (filteredReviewItems.length - 1);
  const reviewConfidence = Number(selectedReviewItem?.labelInfo?.detectorConfidence);
	  const reviewHasOcrLocatedBox = Boolean(selectedReviewItem?.labelInfo?.detectorCropBox)
	    && isOcrLocatedBox(selectedReviewItem?.labelInfo?.detectorBoxSource || selectedReviewItem?.labelInfo?.detectorFallbackReason);
	  const reviewPriorityLabel = reviewHasOcrLocatedBox
	    ? tx('Normal', '正常')
	    : Number.isFinite(reviewConfidence) && reviewConfidence < 0.72
	    ? tx('Low confidence', '低置信度')
	    : tx('Normal', '正常');
	  const activeStyleNameField = normalizeStyleNameField(reviewSummary?.styleNameField || config.styleNameField);
  const livePreviewItems = livePreviewSlots.filter(Boolean).slice(0, 2);
  const showLiveSplitPreview = isRunning && livePreviewItems.length > 0 && !isReviewMode;
  const hasPreviewContent = showLiveSplitPreview || Boolean(previewImageSrc);

  return (
    <div className={`slides-container image-organizer-container ${isRunning ? 'is-task-processing' : ''}`}>
      <div className="image-organizer-shell">
        <div className="image-organizer-stage-card">
          <div className={`image-organizer-toolbar ${isRunning ? 'is-processing' : ''}`}>
            <div className="image-organizer-toolbar-title">
              <strong>{tx('Image Organizer', '图片整理')}</strong>
            </div>

            <div className="image-organizer-toolbar-right">
              <div className="image-organizer-console-anchor">
                <ActivityConsole
                  title={tx('Console', '控制台')}
                  layout="dock"
                  isVisible={workspaceVisible}
                  logs={logs}
                  onClear={handleClearLogs}
                  onCancel={handleCancel}
                  progress={progress}
                  isActive={isRunning}
                  isCancelling={isCancelling}
                  progressLabel={tx('Organizing images', '正在整理图片')}
                  progressDetail={progressDetail}
                  compactCount={8}
                  completionState={completionFeedback?.state}
                  completionTitle={completionFeedback?.title}
                  completionMessage={completionFeedback?.message}
                  completionMeta={completionFeedback?.meta}
                  completionActions={completionActions}
                  completionIssues={completionIssues}
                  showDockStatus={false}
                  showCompletionCard={false}
                />
              </div>

            <div className="image-organizer-toolbar-actions">
              <label className="image-organizer-toolbar-toggle">
                <input
                  type="checkbox"
                  checked={forceRefresh}
                  onChange={(event) => setForceRefresh(event.target.checked)}
                  disabled={isRunning || isCancelling}
                />
                <span>{tx('Force rerun', '强制重跑')}</span>
              </label>
              {reviewItems.length > 0 ? (
                <button
                  type="button"
                  className={`image-organizer-toolbar-btn secondary image-organizer-review-mode-btn ${isReviewMode ? 'active' : ''}`}
                  onClick={() => setReviewModeEnabled((prev) => !prev)}
                  disabled={isRunning || isCancelling || isExportingExcel}
                >
                  {isReviewMode ? tx('Exit Review', '退出审核') : tx('Review Mode', '审核模式')}
                </button>
              ) : null}
              {organizeSummaryPath || reviewSummary?.summaryPath ? (
                <button
                  type="button"
                  className="image-organizer-toolbar-btn"
                  onClick={() => { void handleExportExcel(); }}
                  disabled={isRunning || isCancelling || isSavingReview || isApplyingReview || isExportingExcel}
                >
                  {isExportingExcel ? tx('Exporting...', '生成中...') : tx('Export Excel', '生成 Excel')}
                </button>
              ) : null}
              <button type="button" className="image-organizer-toolbar-btn secondary" onClick={handleResetWorkspace} disabled={isRunning || isCancelling}>
                {tx('Reset', '重置')}
              </button>
            </div>
            </div>
          </div>

          <div className="image-organizer-status-row">
            <span className={`image-organizer-status-pill ${isRunning ? 'active' : ''}`}>{taskStateLabel}</span>
            <span>{usesOcr ? tx('OCR naming', 'OCR 命名') : tx('Number naming', '数字命名')}</span>
            <span>{config.organizeOutputMode === 'style-folders' ? tx('Grouped folders', '分组文件夹') : tx('Single folder', '单文件夹')}</span>
            <span>{engineLabel}</span>
          </div>

          <div className="image-organizer-stage-body">
            <div className={`image-organizer-hero ${hasPreviewContent ? 'active' : ''} ${isRunning ? 'is-processing' : ''}`}>
              {showLiveSplitPreview ? (
                <div className={`image-organizer-live-preview-grid ${livePreviewItems.length > 1 ? 'is-split' : ''}`}>
                  {livePreviewItems.map((item, index) => (
                    <OrganizerLivePreviewCard
                      key={`${index}-${item.detectorSourceImagePath || item.imagePath || ''}`}
                      preview={item}
                      tx={tx}
                      title={tx(`Live OCR ${index + 1}`, `实时检测 ${index + 1}`)}
                    />
                  ))}
                </div>
              ) : previewImageSrc ? (
                <div className="image-organizer-preview-stack">
                  <div className="image-organizer-preview-main">
                  <div className="organizer-preview-meta">
                    <span className="organizer-preview-context-pill">
                      {selectedReviewItem
                        ? tx('Reviewing current group', '当前审核组')
                        : tx('Live OCR preview', '实时 OCR 预览')}
                    </span>
                    <span className={`organizer-preview-pill ${previewHasBox ? 'hit' : ''}`}>{previewStatusLabel}</span>
                    <span className="organizer-preview-filename">{getPathLeaf(previewState?.imagePath || '')}</span>
                  </div>

                  {isReviewMode ? (
                    <div className="organizer-preview-zoombar">
                      <button
                        type="button"
                        className="image-organizer-toolbar-btn secondary"
	                        onClick={() => {
	                          setReviewZoomMode('manual');
	                          setReviewAutoActual(false);
	                          setReviewZoomScale((prev) => Math.max(0.4, (Number(prev) || previewRenderScale) - 0.1));
	                        }}
                      >
                        {tx('Zoom Out', '缩小')}
                      </button>
                      <button
                        type="button"
                        className="image-organizer-toolbar-btn secondary"
	                        onClick={() => {
	                          setReviewZoomMode('manual');
	                          setReviewAutoActual(false);
	                          setReviewZoomScale((prev) => Math.min(2.4, (Number(prev) || previewRenderScale) + 0.1));
	                        }}
                      >
                        {tx('Zoom In', '放大')}
                      </button>
	                      <button
	                        type="button"
	                        className={`image-organizer-toolbar-btn secondary ${reviewZoomMode === 'fit' && !(previewHasDetectorBox && reviewAutoActual) ? 'active' : ''}`}
	                        onClick={() => {
	                          setReviewZoomMode('fit');
	                          setReviewZoomScale(1);
	                          setReviewAutoActual(false);
	                        }}
	                      >
	                        {tx('Fit', '适配')}
                      </button>
		                      <button
		                        type="button"
		                        className={`image-organizer-toolbar-btn secondary ${reviewZoomMode === 'actual' || (previewHasDetectorBox && reviewAutoActual) ? 'active' : ''}`}
		                        onClick={() => {
		                          setReviewZoomMode('actual');
	                          setReviewZoomScale(1);
	                          setReviewAutoActual(false);
		                        }}
		                      >
                        {tx('Focus', '聚焦')}
	                      </button>
                      <span className="organizer-preview-zoom-readout">{Math.round(previewRenderScale * 100)}%</span>
                    </div>
                  ) : null}

                  <div
                    ref={previewStageWrapRef}
                    className={`image-organizer-preview-stage-wrap ${previewCanScroll ? 'is-scrollable' : 'is-fit'}`}
                    onPointerDown={handlePreviewDragStart}
                    onPointerMove={handlePreviewDragMove}
                    onPointerUp={handlePreviewDragEnd}
                    onPointerCancel={handlePreviewDragEnd}
                    onPointerLeave={handlePreviewDragEnd}
                  >
                    <div ref={previewStageRef} className="organizer-preview-stage image-organizer-preview-stage">
                      <img
                        key={previewImageSrc}
                        src={previewImageSrc}
                        alt=""
                        className="organizer-preview-image"
                        draggable="false"
                        decoding="async"
                        style={{
                          width: `${previewDrawSize.width}px`,
                          height: `${previewDrawSize.height}px`,
                        }}
                        onLoad={handlePreviewImageLoad}
                        onError={handlePreviewImageError}
                      />
                      {previewBoxLayout ? (
                        <div
                          className="image-organizer-preview-overlay"
                          style={{
                            left: `${previewBoxLayout.left}px`,
                            top: `${previewBoxLayout.top}px`,
                            width: `${previewBoxLayout.width}px`,
                            height: `${previewBoxLayout.height}px`,
                          }}
                        />
                      ) : null}
                      {previewBoxLayout ? (
                        <div
                          className="image-organizer-preview-tag"
                          style={{
                            left: `${previewBoxLayout.left}px`,
                            top: `${Math.max(previewBoxLayout.top - 30, 10)}px`,
                          }}
                        >
                          {tx('Label hit', '标签命中')}
                        </div>
                      ) : null}
                    </div>
                  </div>

                  <div className="image-organizer-hero-meta">
                    <span>{previewState?.stage === 'label-source' ? tx('Source image', '原始图') : tx('OCR stage', 'OCR 阶段')}</span>
                    <span>{tx('Full original image', '整张原图')}</span>
                    <span>
                      {getPreviewConfidenceLabel(previewState, tx)}
                    </span>
                  </div>

                  <p className="image-organizer-preview-caption">
                    {previewState?.detectorCropBox
                      ? tx(
                          `Current OCR image: ${previewState.crop || 'full'} · ${previewState.detectorUsed ? 'detector hit' : getPreviewHitLabel(previewState, tx)}${previewState.detectorConfidence ? ` · conf ${Number(previewState.detectorConfidence).toFixed(2)}` : ''}`,
                          `当前 OCR 图像：${previewState.crop || 'full'} · ${previewState.detectorUsed ? '检测命中' : getPreviewHitLabel(previewState, tx)}${previewState.detectorConfidence ? ` · 置信度 ${Number(previewState.detectorConfidence).toFixed(2)}` : ''}`,
                        )
                      : tx(
                          'The preview always shows the full original image. No detector box was found for this frame, so the OCR fell back to the broader image pass.',
                          '预览区始终显示整张原图；当前这一帧没有检测到标签框，所以 OCR 回退到了更大范围的整图识别。',
                        )}
                  </p>
                  </div>
                </div>
              ) : (
                <div className="image-organizer-empty-state">
                  <div className="image-organizer-empty-placeholder">
                    <p>{tx('Configure the steps on the right to get started.', '请在右侧面板完成几步设置后开始整理。')}</p>
                  </div>
                </div>
              )}
            </div>

            <aside className="image-organizer-side-panel">
              {isRunning ? (
                <div className="image-organizer-side-alert">
                  <div>
                    <span>{tx('Task Running', '任务处理中')}</span>
                    <strong>{progress}%</strong>
                  </div>
                  <button onClick={handleCancel} disabled={isCancelling} className="image-organizer-cancel-btn">
                    {isCancelling ? tx('Cancelling...', '取消中...') : tx('Cancel', '取消')}
                  </button>
                </div>
              ) : null}

              {isReviewMode ? (
                <section className="image-organizer-side-section">
                  <div className="image-organizer-side-heading">
                    <span>{tx('Review Mode', '审核模式')}</span>
                    <strong>{tx('Item {current} / {total}', '第 {current} / {total} 张')
                      .replace('{current}', String(selectedReviewIndex + 1))
                      .replace('{total}', String(filteredReviewItems.length || 0))}</strong>
                  </div>

                  <div className="image-organizer-review-toolbar">
                    <button
                      type="button"
                      className="image-organizer-toolbar-btn secondary"
                      disabled={!hasPrevReview}
                      onClick={() => setSelectedReviewIndex((prev) => Math.max(0, prev - 1))}
                    >
                      {tx('Previous', '上一张')}
                    </button>
                    <button
                      type="button"
                      className="image-organizer-toolbar-btn secondary"
                      disabled={!hasNextReview}
                      onClick={() => setSelectedReviewIndex((prev) => Math.min(filteredReviewItems.length - 1, prev + 1))}
                    >
                      {tx('Next', '下一张')}
                    </button>
                  </div>

                  {selectedReviewItem && reviewDraft ? (
	                    <div className="image-organizer-review-form">
	                      <div className="image-organizer-review-meta">
	                        <span>{tx('Source', '来源')} · {reviewSourceLabel}</span>
	                        <span>
                          {tx('Review Priority', '审核优先级')} · {reviewPriorityLabel}
                          {Number.isFinite(reviewConfidence) ? ` · ${tx(`Conf ${reviewConfidence.toFixed(2)}`, `置信度 ${reviewConfidence.toFixed(2)}`)}` : ''}
	                        </span>
	                      </div>
	                      {!isFabricReview ? (
	                        <label className="image-organizer-field">
	                          <span>{tx('Rename by', '命名依据')}</span>
	                          <select
	                            value={activeStyleNameField}
	                            disabled={isSavingReview || isApplyingReview}
	                            onChange={(event) => { void handleReviewStyleNameFieldChange(event.target.value); }}
	                          >
	                            {STYLE_NAME_FIELD_OPTIONS.map((option) => (
	                              <option key={`review-style-name-${option.value}`} value={option.value}>
	                                {tx(option.label[0], option.label[1])}
	                              </option>
	                            ))}
	                          </select>
	                        </label>
	                      ) : null}
	                      <div className="image-organizer-review-dynamic-grid">
                        {reviewFieldDefs.map((field) => (
                          <label key={field.key} className="image-organizer-field">
                            <span title={field.fallbackLabel}>{field.displayLabel}</span>
                            <input
                              type="text"
                              value={reviewDraft?.[field.key] || ''}
                              onChange={(event) => setReviewDraft((prev) => ({ ...prev, [field.key]: event.target.value }))}
                            />
                          </label>
                        ))}
                      </div>
                      <label className="image-organizer-field">
                        <span>{tx('Review Note', '复核备注')}</span>
                        <input
                          type="text"
                          value={reviewDraft.reviewNote}
                          onChange={(event) => setReviewDraft((prev) => ({ ...prev, reviewNote: event.target.value }))}
                        />
                      </label>
                      <div className="image-organizer-review-rawtext">
                        <span>{tx('Raw OCR Text', '原始 OCR 文本')}</span>
                        <pre>{reviewRawText || tx('No OCR text available for this group.', '这一组暂时没有原始 OCR 文本。')}</pre>
                      </div>
                      <div className="image-organizer-review-toolbar">
                        <button
                          type="button"
                          className="image-organizer-toolbar-btn secondary"
                          disabled={isSavingReview || isApplyingReview}
                          onClick={() => { void handleSaveReview(); }}
                        >
                          {isSavingReview ? tx('Saving...', '保存中...') : tx('Save', '保存')}
                        </button>
                        <button
                          type="button"
                          className="image-organizer-toolbar-btn"
                          disabled={isSavingReview || isApplyingReview}
                          onClick={() => { void handleSaveReview({ advanceNext: true }); }}
                        >
                          {hasNextReview ? tx('Confirm & Next', '确认并下一张') : tx('Confirm', '确认')}
                        </button>
                        <button
                          type="button"
                          className="image-organizer-toolbar-btn primary"
                          disabled={isSavingReview || isApplyingReview || isExportingExcel}
                          title={tx('Save edits and rename files on disk immediately', '保存修改并立即重命名磁盘上的文件')}
                          onClick={() => {
                            void (async () => {
                              const saved = await handleSaveReview();
                              if (saved) await handleApplyReviewResults();
                            })();
                          }}
                        >
                          {isApplyingReview ? tx('Renaming...', '重命名中...') : tx('Save & Rename Files', '保存并重命名文件')}
                        </button>
                        <button
                          type="button"
                          className="image-organizer-toolbar-btn secondary"
                          disabled={isSavingReview || isApplyingReview || isExportingExcel}
                          onClick={() => { void handleApplyReviewResults(); }}
                        >
                          {isApplyingReview ? tx('Applying...', '应用中...') : tx('Apply To Files', '应用到文件')}
                        </button>
                      </div>
                    </div>
                  ) : null}

                  <button
                    type="button"
                    className="image-organizer-toolbar-btn secondary"
                    onClick={() => setReviewModeEnabled(false)}
                  >
                    {tx('Exit Review Mode', '退出审核模式')}
                  </button>
                </section>
              ) : (
                <>
              <section className="image-organizer-side-section image-organizer-onboarding-section">
                <div className="image-organizer-onboarding">
                  <div className="image-organizer-onboarding-header">
                    <strong>{tx('Get started', '开始使用')}</strong>
                    <p>{tx('Pick a source folder, then choose how files should be named.', '选好源文件夹和命名方式，就可以开始整理。')}</p>
                  </div>

                  <ol className="image-organizer-onboarding-steps">
                    <li className={`image-organizer-onboarding-step ${sourceFolder ? 'is-done' : 'is-active'}`}>
                      <span className="image-organizer-onboarding-num">1</span>
                      <div className="image-organizer-onboarding-body">
                        <div className="image-organizer-onboarding-row">
                          <span className="image-organizer-onboarding-title">{tx('Source folder', '源文件夹')}</span>
                          <button
                            type="button"
                            className="image-organizer-onboarding-action"
                            onClick={handleSelectFolder}
                          >
                            {sourceFolder ? tx('Change', '更换') : tx('Choose', '选择')}
                          </button>
                        </div>
                        <p className="image-organizer-onboarding-hint">
                          {sourceFolder
                            ? sourceLabel
                            : tx('The folder that contains the original photos.', '里面是原始图片的那个文件夹。')}
                        </p>
                        {sourceFolder && folderInfo ? (
                          <p className="image-organizer-onboarding-meta">
                            {folderInfo.fileCount || 0} {tx('top-level files', '顶层文件')}
                            {' · '}
                            {estimatedGroups} {tx('estimated groups', '预计分组')}
                          </p>
                        ) : null}
                      </div>
                    </li>

                    <li className={`image-organizer-onboarding-step ${outputPath ? 'is-done' : sourceFolder ? 'is-active' : ''}`}>
                      <span className="image-organizer-onboarding-num">2</span>
                      <div className="image-organizer-onboarding-body">
                        <div className="image-organizer-onboarding-row">
                          <span className="image-organizer-onboarding-title">{tx('Target folder', '目标文件夹')}</span>
                          <button
                            type="button"
                            className="image-organizer-onboarding-action"
                            onClick={handleSelectOutput}
                          >
                            {outputPath ? tx('Change', '更换') : tx('Choose', '选择')}
                          </button>
                        </div>
                        <p className="image-organizer-onboarding-hint">
                          {outputPath
                            ? outputLabel
                            : tx('Optional — defaults to the source folder.', '可选，默认会写到源文件夹。')}
                        </p>
                      </div>
                    </li>

                    <li className="image-organizer-onboarding-step is-active">
                      <span className="image-organizer-onboarding-num">3</span>
                      <div className="image-organizer-onboarding-body">
                        <div className="image-organizer-onboarding-row">
                          <span className="image-organizer-onboarding-title">{tx('Naming mode', '命名方式')}</span>
                        </div>
                        <div className="image-organizer-onboarding-modes">
                          <button
                            type="button"
                            className={config.namingMode === 'label' ? 'is-selected' : ''}
                            onClick={() => updateConfig({ namingMode: 'label' })}
                          >
                            <strong>{tx('By label', '按标签')}</strong>
                            <span>{tx('Read fabric/style number from the label via OCR.', 'OCR 识别标签上的面料/款号')}</span>
                          </button>
                          <button
                            type="button"
                            className={config.namingMode === 'number' ? 'is-selected' : ''}
                            onClick={() => updateConfig({ namingMode: 'number' })}
                          >
                            <strong>{tx('By number', '按数字')}</strong>
                            <span>{tx('Rename in group order — 1, 2, 3…', '按顺序 1, 2, 3 命名')}</span>
                          </button>
                        </div>
                      </div>
                    </li>
                  </ol>
                </div>
              </section>

              <section className="image-organizer-side-section">
                <div className="image-organizer-side-heading">
                  <span>{tx('Workflow', '流程')}</span>
                  <strong>{usesOcr ? tx('Label OCR', '标签 OCR') : tx('Number mode', '数字模式')}</strong>
                </div>

                {config.namingMode === 'label' ? (
                  <div className="image-organizer-subsection">
                    <span className="image-organizer-subsection-label">{tx('Label target', '标签子模式')}</span>
                    <div className="image-organizer-segmented" role="group" aria-label={tx('Label naming target', '标签命名目标')}>
                      <button
                        type="button"
                        className={config.labelNamingTarget === 'fabric' ? 'active' : ''}
                        onClick={() => updateConfig({ labelNamingTarget: 'fabric' })}
                      >
                        {tx('Fabric', '面料')}
                      </button>
                      <button
                        type="button"
                        className={config.labelNamingTarget === 'style' ? 'active' : ''}
                        onClick={() => updateConfig({ labelNamingTarget: 'style' })}
                      >
                        {tx('Style', '款式')}
                      </button>
                    </div>
	                  </div>
	                ) : null}

	                {config.namingMode === 'label' && config.labelNamingTarget === 'style' ? (
	                  <label className="image-organizer-field">
	                    <span>{tx('Rename by', '命名依据')}</span>
	                    <select
	                      value={normalizeStyleNameField(config.styleNameField)}
	                      onChange={(event) => updateConfig({ styleNameField: event.target.value })}
	                    >
	                      {STYLE_NAME_FIELD_OPTIONS.map((option) => (
	                        <option key={`style-name-${option.value}`} value={option.value}>
	                          {tx(option.label[0], option.label[1])}
	                        </option>
	                      ))}
	                    </select>
	                  </label>
                ) : null}

                <button
                  type="button"
                  className="advanced-toggle"
                  onClick={() => setShowAdvanced(!showAdvanced)}
                >
                  {showAdvanced ? tx('▾ Hide advanced', '▾ 收起高级选项') : tx('▸ Advanced', '▸ 高级选项')}
                </button>
                {showAdvanced && (
                  <>
                    <label className="image-organizer-field">
                      <span>{tx('Output structure', '输出结构')}</span>
                      <select value={config.organizeOutputMode} onChange={(event) => handleOutputModeChange(event.target.value)}>
                        <option value="style-folders">{tx('One folder per group', '一组一个文件夹')}</option>
                        <option value="single-folder">{tx('Rename all files in one folder', '所有文件在同一文件夹重命名')}</option>
                      </select>
                    </label>

                    <label className="image-organizer-field">
                      <span>{tx('Write mode', '写入方式')}</span>
                      <select value={config.organizeAction} onChange={(event) => updateConfig({ organizeAction: event.target.value })}>
                        <option value="copy">{tx('Copy files', '复制文件')}</option>
                        <option value="move">{tx('Move files', '移动文件')}</option>
                      </select>
                    </label>

                    {config.namingMode === 'label' ? (
                      <label className="image-organizer-field">
                        <span>{tx('OCR Engine', 'OCR 引擎')}</span>
                        <div className="image-organizer-select-shell">
                          <select
                            value={normalizeOcrEngineName(config.ocrEngine)}
                            onChange={(event) => updateConfig({ ocrEngine: event.target.value })}
                          >
                            {visibleOcrEngineOptions.map((option) => (
                              <option key={option.value} value={option.value}>
                                {typeof option.label === 'string' ? option.label : tx(option.label?.en, option.label?.zh)}
                              </option>
                            ))}
                          </select>
                          <span className="image-organizer-select-value">
                            {(() => {
                              const found = visibleOcrEngineOptions.find((option) => option.value === normalizeOcrEngineName(config.ocrEngine));
                              if (found?.label) {
                                return typeof found.label === 'string' ? found.label : tx(found.label.en, found.label.zh);
                              }
                              return engineLabel;
                            })()}
                          </span>
                        </div>
                      </label>
                    ) : null}
                  </>
                )}
              </section>

              {usesFixedGroups ? (
                <section className="image-organizer-side-section">
                  <div className="image-organizer-side-heading">
                    <span>{tx('Grouping', '分组')}</span>
                    <strong>{tx('{count} images', '{count} 张').replace('{count}', String(groupSize))}</strong>
                  </div>

                  <div className="image-organizer-inline-grid">
                    <label className="image-organizer-field">
                      <span>{tx('Images per group', '每组图片数')}</span>
                      <input
                        type="number"
                        min="1"
                        value={groupSize}
                        onChange={(event) => {
                          const nextGroupSize = Math.max(1, Number(event.target.value) || 1);
                          updateConfig((prev) => ({
                            ...prev,
                            groupSize: nextGroupSize,
                            labelIndex: Math.min(prev.labelIndex, nextGroupSize),
                          }));
                        }}
                      />
                    </label>

                    {config.namingMode === 'label' ? (
                      <label className="image-organizer-field">
                        <span>{tx('Label position', '标签位置')}</span>
                        <input
                          type="number"
                          min="1"
                          max={groupSize}
                          value={labelIndex}
                          onChange={(event) => {
                            const nextLabelIndex = Math.min(
                              Math.max(1, Number(event.target.value) || 1),
                              groupSize,
                            );
                            updateConfig({ labelIndex: nextLabelIndex });
                          }}
                        />
                      </label>
                    ) : (
                      <label className="image-organizer-field">
                        <span>{tx('Starting number', '起始编号')}</span>
                        <input
                          type="number"
                          min="1"
                          value={Math.max(1, Number(config.numberStart) || 1)}
                          onChange={(event) => updateConfig({ numberStart: Math.max(1, Number(event.target.value) || 1) })}
                        />
                      </label>
                    )}
                  </div>
                </section>
              ) : null}

              {usesFixedGroups && visibleSuffixFields.length > 0 ? (
                <section className="image-organizer-side-section">
                  <div className="image-organizer-side-heading">
                    <span>{tx('Suffixes', '后缀')}</span>
                    <strong>{tx('Image positions', '图片位置')}</strong>
                  </div>
                  <div className="image-organizer-inline-grid">
                    {visibleSuffixFields.map((field) => (
                      <label key={`organizer-suffix-${field.position}`} className="image-organizer-field">
                        <span>{tx(`Image ${field.position}`, `第 ${field.position} 张`)}</span>
                        <input
                          type="text"
                          value={field.value}
                          onChange={(event) => {
                            const nextSuffixes = [...config.imageSuffixes];
                            nextSuffixes[field.suffixIndex] = event.target.value;
                            updateConfig({ imageSuffixes: nextSuffixes });
                          }}
                        />
                      </label>
                    ))}
                  </div>
                </section>
              ) : null}

              <button
                type="button"
                className="image-organizer-run-btn"
                onClick={handleGenerate}
                disabled={isRunning || !sourceFolder}
              >
                {isRunning ? tx('Organizing...', '整理中...') : tx('Organize Images', '整理图片')}
              </button>

                </>
              )}
            </aside>
          </div>
        </div>
      </div>
    </div>
  );
}

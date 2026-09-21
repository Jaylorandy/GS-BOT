import React, { useState, useEffect, useRef, useCallback, useMemo, createContext, useContext } from 'react';
import LabelOcrSettings from './components/LabelOcrSettings';
import { useI18n } from './utils/i18n';
import { WIZARD_CONFIG } from './wizardConfig';
import {
  loadSharedLabelOcrProfile,
  saveSharedLabelOcrProfile,
  subscribeSharedLabelOcrProfile,
} from './utils/labelOcrProfileStore';
import { subscribeLLMConfigUpdate } from './utils/llmConfigSync';
import './ModuleHome.css';

// ── Inline icon helpers (PO wizard status) ─────────────────
function PoIconCheck({ size = 16, style }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
    >
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
function PoIconAlert({ size = 16, style }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
    >
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}
function PoIconSearch({ size = 16, style }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}
function PoIconSave({ size = 16, style }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
    >
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <polyline points="17 21 17 13 7 13 7 21" />
      <polyline points="7 3 7 8 15 8" />
    </svg>
  );
}

// ── Model name validation helpers ──────────────────────────
const PRESET_MODEL_PREFIXES = {
  glm: ['glm-'],
  deepseek: ['deepseek-'],
  qwen: ['qwen-'],
};

function looksLikeValidModelName(modelName = '') {
  const name = String(modelName || '').trim();
  if (!name) return false;
  const lastDashIdx = name.lastIndexOf('-');
  if (lastDashIdx === -1 || lastDashIdx === name.length - 1) return false;
  const suffix = name.slice(lastDashIdx + 1);
  if (/^[\d.]+$/.test(suffix)) return false;
  return true;
}

function isValidModelForPreset(modelName = '', presetId = '') {
  const name = String(modelName || '').trim();
  if (!name) return false;
  const prefixes = PRESET_MODEL_PREFIXES[presetId];
  if (!prefixes || prefixes.length === 0) return true;
  const lower = name.toLowerCase();
  const prefixOk = prefixes.some((p) => lower.startsWith(p.toLowerCase()));
  if (!prefixOk) return false;
  return looksLikeValidModelName(name);
}

// ── Log channel → IPC method mapping ──────────────────────
const LOG_CHANNELS = {
  slides: { log: 'onSlidesLog', progress: 'onSlidesProgress', remove: 'removeSlidesListeners' },
  scraper: { log: 'onLog', progress: 'onProgress', remove: 'removeListeners' },
  bestseller: { log: 'onBestsellerLog', progress: 'onBestsellerProgress', remove: 'removeBestsellerListeners' },
  pdfSqueezer: { log: 'onPdfSqueezerLog', progress: 'onPdfSqueezerProgress', item: 'onPdfSqueezerItem', remove: 'removePdfSqueezerListeners' },
};

// ── PO 布局确认面板辅助 ──────────────────────────────────
// semantic 下拉候选（与 main.js po-template-utils 的语义集合对齐）。
// 按级别拆分：PO 字段映射区只列订单级字段、SKU 字段映射区只列行级字段，
// 让"每单一次的表头字段"与"每行重复的明细字段"一眼区分，避免重复值困惑。
const PO_LEVEL_OPTIONS = [
  { value: '', label: '— 无 —' },
  { value: 'orderNo', label: 'orderNo · 订单号' },
  { value: 'styleNumber', label: 'styleNumber · 款号' },
  { value: 'modelNo', label: 'modelNo · 型号' },
  { value: 'poNo', label: 'poNo · PO 号' },
  { value: 'shipmentDate', label: 'shipmentDate · 出货期' },
  { value: 'transportType', label: 'transportType · 运输方式' },
  { value: 'packingMethod', label: 'packingMethod · 包装方式' },
  { value: 'currency', label: 'currency · 货币' },
  { value: 'incoterms', label: 'incoterms · 贸易条款' },
  { value: 'customer', label: 'customer · 客户' },
  { value: 'destination', label: 'destination · 目的地(描述)' },
  { value: 'destinationCode', label: 'destinationCode · 目的地代码' },
  { value: 'destinationName', label: 'destinationName · 目的地名称' },
  { value: 'destinationPort', label: 'destinationPort · 目的港' },
  { value: 'departurePort', label: 'departurePort · 出运港' },
  { value: 'totalQty', label: 'totalQty · 总数' },
  { value: 'division', label: 'division · 部门/品类' },
  { value: 'gender', label: 'gender · 性别' },
  { value: 'brand', label: 'brand · 品牌' },
  { value: 'description', label: 'description · 描述' },
  { value: 'unknown', label: 'unknown · 忽略' },
];

// 两个级别列表互斥：订单级字段只在 PO 区、行级字段只在 SKU 区，不出现重复。
// 自动识别出的语义即使不在当前级别列表（如历史 spec 残留），下拉框仍会回退显示，不会断链。
const SKU_LEVEL_OPTIONS = [
  { value: '', label: '— 无 —' },
  { value: 'longSku', label: 'SKU · 完整SKU' },
  { value: 'colorCode', label: 'colorCode · 颜色代码' },
  { value: 'colorName', label: 'colorName · 颜色(描述)' },
  { value: 'inseam', label: 'inseam · 内长' },
  { value: 'quantity', label: 'quantity · 数量' },
  { value: 'price', label: 'price · 单价' },
  { value: 'barcode', label: 'barcode · 条码' },
  { value: 'size', label: 'size · 尺码' },
  { value: 'unknown', label: 'unknown · 忽略' },
];

// 全语义 → 中文标签（下拉回退显示用：当前行语义不在该级别选项里时，仍能显示正确名称）
const SEMANTIC_LABELS = (() => {
  const m = {};
  for (const opt of [...PO_LEVEL_OPTIONS, ...SKU_LEVEL_OPTIONS]) {
    if (opt.value) m[opt.value] = opt.label;
  }
  return m;
})();

// 0-based 列号 → Excel 字母（0→A, 25→Z, 26→AA）
function colLetter(col) {
  if (!Number.isInteger(col) || col < 0) return '?';
  let n = col;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}


// ── Field renderer ────────────────────────────────────────
// `t` handles {en, zh} objects from wizardConfig; `tx` handles (en, zh) inline strings.
function FieldRenderer({ field, value, onChange, t, tx, accentRgb, allParams }) {
  const val = value ?? field.default ?? '';

  // Model picker state
  const [modelList, setModelList] = useState([]);
  // Vision-capable models, split out by the main process. This picker feeds the
  // scrape -> vision-note -> trend-report chain, where a text-only model does not
  // error but silently produces prose about images it never received.
  const [visionModels, setVisionModels] = useState([]);
  const [otherModels, setOtherModels] = useState([]);
  const [showNonVision, setShowNonVision] = useState(false);
  // The model this run will really use when the field is left empty, and whether
  // it can read images. Without these the most common path — empty field on a
  // text-only default model — shows no warning at all.
  const [currentModel, setCurrentModel] = useState('');
  const [currentModelVision, setCurrentModelVision] = useState(null);
  const [modelLoading, setModelLoading] = useState(false);
  const retryRef = useRef(false);
  // Model pickers are no longer part of any wizard (AI config lives in the
  // settings page), so 'llmMode' stays 'default' — the fetch/effects below only
  // run if a model-picker field is ever reintroduced.
  const llmMode = allParams?.llmMode || allParams?.aiModeOverride || 'default';
  const fetchModels = useCallback(async (mode, force = false) => {
    const api = window.electronAPI;
    if (!api?.listLLMModels) return [];
    setModelLoading(true);
    try {
      const result = await api.listLLMModels({ mode: mode === 'default' ? undefined : mode, force });
      if (result?.success && Array.isArray(result.models)) {
        setModelList(result.models);
        setVisionModels(Array.isArray(result.visionModels) ? result.visionModels : []);
        setOtherModels(Array.isArray(result.otherModels) ? result.otherModels : []);
        setCurrentModel(typeof result.currentModel === 'string' ? result.currentModel : '');
        setCurrentModelVision(typeof result.currentModelVision === 'boolean' ? result.currentModelVision : null);
        return result.models;
      } else {
        setModelList([]); setVisionModels([]); setOtherModels([]);
        setCurrentModel(''); setCurrentModelVision(null);
        return [];
      }
    } catch {
      setModelList([]); setVisionModels([]); setOtherModels([]);
      setCurrentModel(''); setCurrentModelVision(null);
      return [];
    }
    finally { setModelLoading(false); }
  }, []);

  useEffect(() => {
    if (field.type !== 'model-picker' || !llmMode) return;
    retryRef.current = false;
    let cancelled = false;
    (async () => {
      const models = await fetchModels(llmMode);
      if (cancelled || models.length > 0) return;
      // Retry once with force=true after a short delay if first fetch returned empty
      retryRef.current = true;
      await new Promise(r => setTimeout(r, 600));
      if (!cancelled) await fetchModels(llmMode, true);
    })();
    return () => { cancelled = true; };
  }, [llmMode, field.type, fetchModels]);

  if (field.type === 'hidden') {
    return null;
  }

  if (field.type === 'divider') {
    return <div className="wizard-field-divider">{t(field.label)}</div>;
  }

  if (field.type === 'source-or-file-picker') {
    return (
      <div className="wizard-field wizard-field--picker">
        <label className="wizard-field__label">{t(field.label)}</label>
        <div className="wizard-source-options">
          <button
            type="button"
            className="wizard-picker-btn"
            style={{ '--accent-rgb': accentRgb }}
            onClick={async () => {
              const api = window.electronAPI;
              if (!api) return;
              const dir = await api.selectDir?.();
              if (dir) onChange({ path: dir, kind: 'folder' });
            }}
          >
            <span className="wizard-picker-btn__icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ width: 20, height: 20 }}>
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
              </svg>
            </span>
            <span className="wizard-picker-btn__text">{val?.kind === 'folder' ? (typeof val.path === 'string' ? val.path.split('/').pop().split('\\').pop() : '') : tx('Folder', '文件夹')}</span>
          </button>
          <button
            type="button"
            className="wizard-picker-btn"
            style={{ '--accent-rgb': accentRgb }}
            onClick={async () => {
              const api = window.electronAPI;
              if (!api) return;
              const opts = { properties: ['openFile'] };
              if (field.ext) opts.filters = [{ name: 'Images', extensions: field.ext }];
              const r = await api.selectFile?.(opts);
              if (r) {
                const filePath = Array.isArray(r) ? r[0] : r;
                onChange({ path: filePath, kind: 'file' });
              }
            }}
          >
            <span className="wizard-picker-btn__icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ width: 20, height: 20 }}>
                <rect x="3" y="4" width="18" height="16" rx="2.2" />
                <circle cx="8.8" cy="9.8" r="1.6" />
                <path d="m21 16-5-5L6 20" />
              </svg>
            </span>
            <span className="wizard-picker-btn__text">{val?.kind === 'file' ? (typeof val.path === 'string' ? val.path.split('/').pop().split('\\').pop() : '') : tx('File', '文件')}</span>
          </button>
        </div>
        {field.hint && <span className="wizard-field__hint">{t(field.hint)}</span>}
      </div>
    );
  }

  if (field.type === 'dir-picker' || field.type === 'file-picker' || field.type === 'save-picker') {
    return (
      <div className="wizard-field wizard-field--picker">
        <label className="wizard-field__label">{t(field.label)}</label>
        <button
          type="button"
          className="wizard-picker-btn"
          style={{ '--accent-rgb': accentRgb }}
          onClick={async () => {
            const api = window.electronAPI;
            if (!api) return;
            if (field.type === 'dir-picker') {
              const dir = await api.selectDir?.();
              if (dir) onChange(dir);
            } else if (field.type === 'save-picker') {
              const r = await api.saveFile?.({
                filters: [{ name: field.ext?.toUpperCase() || 'File', extensions: [field.ext || 'pptx'] }],
              });
              if (r) onChange(r);
            } else {
              const opts = { properties: field.multiple ? ['openFile', 'multiSelections'] : ['openFile'] };
              if (field.ext) opts.filters = [{ name: field.ext.map(e => e.toUpperCase()).join('/'), extensions: field.ext }];
              const r = await api.selectFile?.(opts);
              if (r) onChange(field.multiple ? r : (Array.isArray(r) ? r[0] : r));
            }
          }}
        >
          <span className="wizard-picker-btn__icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ width: 20, height: 20 }}>
              <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
            </svg>
          </span>
          <span className="wizard-picker-btn__text">{val ? (typeof val === 'string' ? val.split('/').pop().split('\\').pop() : `${Array.isArray(val) ? val.length : 1} file(s)`) : tx('Select…', '选择…')}</span>
        </button>
        {field.hint && <span className="wizard-field__hint">{t(field.hint)}</span>}
      </div>
    );
  }

  if (field.type === 'model-picker') {
    const showModels = modelList.length > 0;
    const optStyle = { background: '#2a2a3e', color: '#e8e8f0' };
    // Grouped rendering when the main process annotated capabilities AND this
    // field's chain actually needs image input (`vision: true` in wizardConfig).
    // Vision models come first; the rest stay hidden behind a toggle unless one
    // of them is the current value (so we never drop the user's saved selection).
    const hasVisionSplit = field.vision === true && (visionModels.length + otherModels.length > 0);
    // The model this run will really use: the explicit pick, or — when the field
    // is left empty ("use default model") — whatever the active endpoint
    // resolves to. Warning off the effective model, not just off `val`, so the
    // default path is covered too.
    const effectiveModel = String(val || currentModel || '').trim();
    const effectiveIsNonVision = Boolean(effectiveModel) && (
      otherModels.includes(effectiveModel)
      || (currentModelVision === false && effectiveModel === currentModel)
    );
    const selectedIsNonVision = effectiveIsNonVision && effectiveModel === val;
    const visibleOthers = showNonVision
      ? otherModels
      : (otherModels.includes(effectiveModel) ? [effectiveModel] : []);
    const noVisionAvailable = hasVisionSplit && visionModels.length === 0;
    const followLabel = field.key === 'visionModel'
      ? tx('Follow the main model', '跟随主模型')
      : tx('Use default model', '使用默认模型');
    return (
      <div className="wizard-field wizard-field--select">
        <label className="wizard-field__label">{t(field.label)}</label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {showModels ? (
            <select
              value={val || ''}
              onChange={(e) => onChange(e.target.value)}
              style={{
                flex: 1, padding: '8px 12px', borderRadius: 8, border: '1px solid rgba(128,128,128,0.3)',
                background: 'rgba(0,0,0,0.15)', color: 'inherit', fontSize: 14, cursor: 'pointer',
              }}
            >
              <option value="" style={optStyle}>
                {showModels && currentModel
                  ? `${followLabel}（${currentModel}）`
                  : followLabel}
              </option>
              {hasVisionSplit ? (
                <>
                  {visionModels.length > 0 && (
                    <optgroup label={tx(`Reads images (${visionModels.length})`, `可读图（${visionModels.length}）`)}>
                      {visionModels.map((m) => (
                        <option key={m} value={m} style={optStyle}>{m}</option>
                      ))}
                    </optgroup>
                  )}
                  {visibleOthers.length > 0 && (
                    <optgroup label={tx(`Text only — cannot read images (${otherModels.length})`, `纯文本 · 不看图（${otherModels.length}）`)}>
                      {visibleOthers.map((m) => (
                        <option key={m} value={m} style={optStyle}>{m}</option>
                      ))}
                    </optgroup>
                  )}
                </>
              ) : (
                modelList.map((m) => (
                  <option key={m} value={m} style={optStyle}>{m}</option>
                ))
              )}
            </select>
          ) : (
            <input
              type="text"
              value={val || ''}
              onChange={(e) => onChange(e.target.value)}
              placeholder={tx('Enter model name (e.g. llama3)', '输入模型名称（如 llama3）')}
              style={{
                flex: 1, padding: '8px 12px', borderRadius: 8, border: '1px solid rgba(128,128,128,0.3)',
                background: 'rgba(0,0,0,0.15)', color: 'inherit', fontSize: 14,
              }}
            />
          )}
          <button
            type="button"
            onClick={() => fetchModels(llmMode, true)}
            disabled={modelLoading}
            style={{
              padding: '8px 12px', borderRadius: 8, border: '1px solid rgba(128,128,128,0.3)',
              background: modelLoading ? 'rgba(128,128,128,0.1)' : 'rgba(0,0,0,0.12)',
              cursor: modelLoading ? 'not-allowed' : 'pointer', fontSize: 13, whiteSpace: 'nowrap',
            }}
          >
            {modelLoading ? '...' : tx('Refresh', '刷新')}
          </button>
        </div>
        {showModels && hasVisionSplit && (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="wizard-field__hint" style={{ margin: 0 }}>
              {tx(`${visionModels.length} of ${modelList.length} models can read images`,
                `${modelList.length} 个模型中 ${visionModels.length} 个支持读图`)}
            </span>
            {otherModels.length > 0 && !showNonVision && !selectedIsNonVision && (
              <button
                type="button"
                onClick={() => setShowNonVision(true)}
                style={{
                  background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                  color: 'inherit', opacity: 0.75, fontSize: 12, textDecoration: 'underline',
                }}
              >
                {tx(`Show ${otherModels.length} text-only models`, `展开其余 ${otherModels.length} 个不看图的模型`)}
              </button>
            )}
            {(showNonVision || selectedIsNonVision) && otherModels.length > 0 && (
              <button
                type="button"
                onClick={() => setShowNonVision(false)}
                style={{
                  background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                  color: 'inherit', opacity: 0.75, fontSize: 12, textDecoration: 'underline',
                }}
              >
                {tx('Collapse text-only models', '收起不看图的模型')}
              </button>
            )}
          </div>
        )}
        {noVisionAvailable && (
          <span className="wizard-field__hint" style={{ color: '#e0a24a' }}>
            {tx('No image-capable model found on this endpoint. AI notes will have no visual basis — install a vision model (e.g. llava, qwen2.5-vl) or switch the model above.',
              '该端点下没有找到支持读图的模型。AI 笔记将没有图像依据——请安装视觉模型（如 llava、qwen2.5-vl）或在上方切换模型。')}
          </span>
        )}
        {effectiveIsNonVision && (
          <span className="wizard-field__hint" style={{ color: '#e0a24a' }}>
            {selectedIsNonVision
              ? tx(`"${effectiveModel}" cannot read images — the analysis will describe styles without looking at the product photos.`,
                `「${effectiveModel}」不支持读图——分析将不会查看产品图片。`)
              : tx(`The default model "${effectiveModel}" cannot read images — the analysis will describe styles without looking at the product photos. Pick an image-capable model above, or change the default in settings.`,
                `当前默认模型「${effectiveModel}」不支持读图——分析将不会查看产品图片。请在上方更换支持读图的模型，或到设置页更换默认模型。`)}
          </span>
        )}
        {field.hint && <span className="wizard-field__hint">{t(field.hint)}</span>}
        {llmMode === 'default' && (
          <span className="wizard-field__hint" style={{ opacity: 0.7 }}>
            {tx('Select an AI model above to customize', '在上方选择 AI 模型以自定义')}
          </span>
        )}
      </div>
    );
  }

  if (field.type === 'select') {
    const opts = field.options || [];
    const hasDesc = opts.some(o => o.desc);
    return (
      <div className="wizard-field wizard-field--select">
        <label className="wizard-field__label">{t(field.label)}</label>
        <div className={`wizard-select-grid ${hasDesc ? 'wizard-select-grid--cards' : 'wizard-select-grid--pills'}`}>
          {opts.map((opt) => (
            <button
              key={String(opt.value)}
              type="button"
              className={`wizard-option ${val === opt.value ? 'active' : ''}`}
              style={{ '--accent-rgb': accentRgb }}
              onClick={() => onChange(opt.value)}
            >
              <span className="wizard-option__label">{t(opt.label)}</span>
              {opt.desc && <span className="wizard-option__desc">{t(opt.desc)}</span>}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (field.type === 'toggle') {
    return (
      <div className="wizard-field wizard-field--toggle">
        <button
          type="button"
          className={`wizard-toggle ${val ? 'on' : ''}`}
          style={{ '--accent-rgb': accentRgb }}
          onClick={() => onChange(!val)}
        >
          <span className="wizard-toggle__track">
            <span className="wizard-toggle__thumb" />
          </span>
          <span className="wizard-toggle__text">
            <span className="wizard-toggle__label">{t(field.label)}</span>
            {field.desc && <span className="wizard-toggle__desc">{t(field.desc)}</span>}
          </span>
        </button>
      </div>
    );
  }

  if (field.type === 'group') {
    return (
      <div className="wizard-field wizard-field--group">
        {field.label && <label className="wizard-field__label">{t(field.label)}</label>}
        <div className="wizard-toggle-group">
          {field.toggles.map((tg) => {
            const tVal = value?.[tg.key] ?? tg.default ?? false;
            return (
              <button
                key={tg.key}
                type="button"
                className={`wizard-mini-toggle ${tVal ? 'on' : ''}`}
                style={{ '--accent-rgb': accentRgb }}
                onClick={() => onChange({ ...value, [tg.key]: !tVal })}
              >
                <span className="wizard-mini-toggle__dot" />
                {t(tg.label)}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  if (field.type === 'text' || field.type === 'textarea') {
    const ph = field.placeholder || '';
    return (
      <div className="wizard-field wizard-field--text">
        <label className="wizard-field__label">{t(field.label)}</label>
        {field.type === 'textarea' ? (
          <textarea
            className="wizard-textarea"
            value={val}
            placeholder={ph}
            onChange={(e) => onChange(e.target.value)}
            rows={4}
          />
        ) : (
          <input
            type="text"
            className="wizard-input"
            value={val}
            placeholder={ph}
            onChange={(e) => onChange(e.target.value)}
          />
        )}
      </div>
    );
  }

  if (field.type === 'number') {
    return (
      <div className="wizard-field wizard-field--number">
        <label className="wizard-field__label">{t(field.label)}</label>
        <input
          type="number"
          className="wizard-input wizard-input--number"
          value={val}
          min={field.min}
          max={field.max}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </div>
    );
  }

  if (field.type === 'button-action') {
    return (
      <div className="wizard-field wizard-field--button-action">
        <button
          type="button"
          className="wizard-action-btn"
          style={{ '--accent-rgb': accentRgb }}
          onClick={field.onClick || (() => {})}
        >
          <PoIconSave size={13} style={{ verticalAlign: '-2px', marginRight: 5 }} /> {t(field.label)}
        </button>
      </div>
    );
  }

  return null;
}

// ── LayoutMapEditor: 布局确认面板的可编辑映射列表 ──────────
// 三列布局：序号(列号) | 语义下拉（或标签提示）| PDF 预填值（可编辑）
// rows: [{ col, label, semantic?, value?, origValue? }]，支持增删行。
function LayoutMapEditor({ title, caption, rows, semantic, options = PO_LEVEL_OPTIONS, onChange, onRemove, onAdd, accentRgb, tx }) {
  const rowStyle = {
    display: 'grid',
    gridTemplateColumns: semantic ? '52px 185px 1fr 26px' : '52px 1fr 26px',
    gap: '6px',
    alignItems: 'center',
    marginBottom: '4px',
  };
  const inputStyle = {
    padding: '3px 6px',
    borderRadius: '4px',
    border: '1px solid rgba(var(--accent-rgb), 0.35)',
    background: 'rgba(38, 44, 70, 0.92)',
    color: '#f2f0f8',
    fontSize: '0.78rem',
    minWidth: 0,
  };
  // 语义下拉框单独样式：更亮的背景 + 更强边框，保证可读性
  const selectStyle = {
    ...inputStyle,
    fontSize: '0.78rem',
    fontWeight: 500,
    background: 'rgba(44, 52, 84, 0.95)',
    border: '1px solid rgba(var(--accent-rgb), 0.6)',
    color: '#f6f4fc',
    cursor: 'pointer',
  };
  return (
    <div style={{ marginBottom: '10px' }}>
      <div style={{ fontWeight: 600, marginBottom: '2px', fontSize: '0.76rem' }}>
        {title} <span style={{ opacity: 0.5, fontWeight: 400 }}>({rows.length})</span>
      </div>
      {caption ? (
        <div style={{ fontSize: '0.68rem', opacity: 0.55, marginBottom: '4px' }}>{caption}</div>
      ) : null}
      {(rows || []).map((row, idx) => {
        const unmapped = semantic && !String(row.semantic || '').trim();
        // 当前行语义不在本级别选项里时（自动识别出的跨级语义），回退追加一项保证显示不断链
        const curSem = String(row.semantic || '').trim();
        const opts = !curSem || options.some(o => o.value === curSem)
          ? options
          : [...options, { value: curSem, label: SEMANTIC_LABELS[curSem] || curSem + ' · 自动识别' }];
        return (
        <div key={idx} style={{ ...rowStyle, ...(unmapped ? { background: 'rgba(255,255,255,0.025)', borderRadius: 4, padding: '2px 4px' } : {}) }}>
          {/* 第一列：序号（列号 + 字母） */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <input
              type="number"
              value={row.col ?? 0}
              min={0}
              onChange={(e) => onChange(idx, { col: Number(e.target.value) })}
              style={{ ...inputStyle, textAlign: 'center', width: 30 }}
              title={tx('Column index (0-based)', '列索引（0 起）')}
            />
            <span style={{ fontSize: '0.68rem', opacity: 0.55, minWidth: 12 }}>{colLetter(row.col)}</span>
          </div>
          {/* 第二列：语义下拉（字段映射）或 只读标签（尺码列） */}
          {semantic ? (
            <select
              value={row.semantic || ''}
              onChange={(e) => onChange(idx, { semantic: e.target.value })}
              style={{ ...selectStyle, ...(unmapped ? { borderColor: 'rgba(var(--accent-rgb), 0.3)', background: 'rgba(34, 39, 61, 0.95)', color: '#b9b6c9', fontStyle: 'italic' } : {}) }}
            >
              {opts.map(opt => (
                <option
                  key={opt.value}
                  value={opt.value}
                  style={{ background: '#232741', color: '#f2f0f8', fontStyle: 'normal' }}
                >
                  {opt.label}
                </option>
              ))}
            </select>
          ) : (
            <div
              style={{ ...inputStyle, fontSize: '0.74rem', color: '#b9b6c9', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              title={String(row.label || '')}
            >
              {row.label || '—'}
            </div>
          )}
          {/* 第三列：PDF 预填值（可编辑，人工纠正）+ 模板列头小提示 */}
          <div style={{ minWidth: 0 }}>
            <input
              type="text"
              value={row.value ?? ''}
              placeholder={unmapped ? tx('Select semantic to fill', '选择语义后填写/核对') : tx('Prefilled from PDF', 'PDF 预填值')}
              onChange={(e) => onChange(idx, { value: e.target.value })}
              style={{ ...inputStyle, width: '100%' }}
              title={row.label ? `${row.label}` : ''}
            />
            {row.label ? (
              <div style={{ fontSize: '0.62rem', opacity: unmapped ? 0.75 : 0.5, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontStyle: unmapped ? 'italic' : 'normal', color: unmapped ? '#9a97ab' : 'inherit' }} title={String(row.label)}>
                {unmapped && <span style={{ color: 'rgba(240, 180, 80, 0.85)' }}>◌ </span>}
                {row.label}
                {unmapped && <span style={{ marginLeft: 4, color: 'rgba(240, 180, 80, 0.7)', fontSize: '0.58rem' }}>{tx('unmapped', '未映射')}</span>}
              </div>
            ) : null}
          </div>
          <button
            type="button"
            title={tx('Remove row', '删除此行')}
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'rgba(220, 60, 60, 0.8)', fontSize: '0.85rem', lineHeight: 1,
            }}
            onClick={() => onRemove(idx)}
          >
            ✕
          </button>
        </div>
        );
      })}
      <button
        type="button"
        style={{
          padding: '3px 10px', borderRadius: '5px', fontSize: '0.74rem', cursor: 'pointer',
          border: '1px dashed rgba(var(--accent-rgb), 0.4)',
          background: 'rgba(var(--accent-rgb), 0.06)',
          color: '#e8e6f0',
        }}
        onClick={onAdd}
      >
        ＋ {tx('Add row', '添加一行')}
      </button>
    </div>
  );
}

// ── SizePreviewMatrix: 尺码表 2D 预览（横 = 尺码列，纵 = 颜色/内长）──
// 若传入 onColumnLabelChange，表头变为可编辑输入框，直接修改尺码列映射标签
function SizePreviewMatrix({ matrix, accentRgb, tx, onColumnLabelChange }) {
  const columns = matrix?.columns || [];
  const rows = matrix?.rows || [];
  const MAX_ROWS = 15;
  const showRows = rows.slice(0, MAX_ROWS);
  const hasInseam = rows.some(r => r.inseam);
  const editable = typeof onColumnLabelChange === 'function';
  const cellStyle = {
    padding: '2px 6px',
    fontSize: '0.7rem',
    fontVariantNumeric: 'tabular-nums',
    textAlign: 'center',
    borderBottom: '1px solid rgba(255,255,255,0.06)',
    minWidth: 34,
  };
  const thStyle = {
    padding: '2px 6px',
    fontSize: '0.68rem',
    fontWeight: 600,
    textAlign: 'center',
    color: 'rgba(var(--accent-rgb), 0.9)',
    borderBottom: '1px solid rgba(var(--accent-rgb), 0.35)',
    whiteSpace: 'nowrap',
  };
  return (
    <div style={{ overflowX: 'auto', borderRadius: 6, border: '1px solid rgba(var(--accent-rgb), 0.18)', background: 'rgba(20, 24, 40, 0.6)' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr>
            <th style={{ ...thStyle, textAlign: 'left' }}>
              {tx('Color', '颜色')}
            </th>
            {hasInseam && (
              <th style={{ ...thStyle, textAlign: 'left' }}>
                {tx('Inseam', '内长')}
              </th>
            )}
            {columns.map((c, i) => (
              <th key={i} style={thStyle} title={c.label}>
                {editable ? (
                  <input
                    value={c.label}
                    onChange={(e) => onColumnLabelChange(c.origIdx ?? i, e.target.value)}
                    style={{
                      width: '100%',
                      minWidth: 28,
                      background: 'transparent',
                      border: 'none',
                      borderBottom: '1px solid rgba(var(--accent-rgb), 0.35)',
                      color: 'rgba(var(--accent-rgb), 0.95)',
                      fontSize: '0.68rem',
                      fontWeight: 600,
                      textAlign: 'center',
                      outline: 'none',
                      padding: '1px 2px',
                    }}
                    onFocus={(e) => { e.target.style.borderBottom = '1px solid rgba(var(--accent-rgb), 0.9)'; }}
                    onBlur={(e) => { e.target.style.borderBottom = '1px solid rgba(var(--accent-rgb), 0.35)'; }}
                  />
                ) : (
                  c.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {showRows.length === 0 && (
            <tr>
              <td colSpan={columns.length + (hasInseam ? 2 : 1)} style={{ ...cellStyle, opacity: 0.5, padding: '8px' }}>
                {tx('No size data extracted yet.', '暂无尺码数据。')}
              </td>
            </tr>
          )}
          {showRows.map((r, ri) => (
            <tr key={ri}>
              <td style={{ ...cellStyle, textAlign: 'left', color: '#e6e4f0', fontWeight: 500, background: 'rgba(20,24,40,0.95)', whiteSpace: 'nowrap' }}>
                {r.color}
              </td>
              {hasInseam && (
                <td style={{ ...cellStyle, textAlign: 'left', color: '#e6e4f0', fontWeight: 500, background: 'rgba(20,24,40,0.95)', whiteSpace: 'nowrap' }}>
                  {r.inseam || ''}
                </td>
              )}
              {columns.map((c, ci) => {
                const qty = r.cells?.[c.norm];
                return (
                  <td key={ci} style={{ ...cellStyle, color: qty ? '#d8f5e3' : 'rgba(255,255,255,0.14)' }}>
                    {qty || ''}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > MAX_ROWS && (
        <div style={{ fontSize: '0.66rem', opacity: 0.55, padding: '4px 8px' }}>
          {tx('And N more rows', `… 还有 ${rows.length - MAX_ROWS} 行未显示`)}
        </div>
      )}
    </div>
  );
}

// ── LabelOcrBridge: connects LabelOcrSettings to shared store ──
function LabelOcrBridge({ tx }) {
  const [profile, setProfile] = useState(() => loadSharedLabelOcrProfile());

  useEffect(() => {
    return subscribeSharedLabelOcrProfile((next) => setProfile(next));
  }, []);

  const handleChange = useCallback((next) => {
    saveSharedLabelOcrProfile(next);
  }, []);

  return (
    <LabelOcrSettings
      value={profile}
      onChange={handleChange}
      tx={tx}
    />
  );
}

// ── Main Component ─────────────────────────────────────────
export default function ModuleHome({ tab, iconNode, fabIconNode, onLogToggle, onLog, onNavigate }) {
  const { language, tx } = useI18n();
  const config = WIZARD_CONFIG[tab.id];
  const accentRgb = tab.accentRgb || '168, 199, 250';
  const accentInk = tab.accentInk || '#0a1e30';

  // t() handles {en, zh} objects from wizardConfig; tx() handles (en, zh) inline strings
  const t = useCallback((pair) => {
    if (!pair) return '';
    if (typeof pair === 'string') return pair;
    return language === 'zh' ? pair.zh : pair.en;
  }, [language]);

  const [params, setParams] = useState({});
  const [stepIdx, setStepIdx] = useState(0);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState('');
  const [logs, setLogs] = useState([]);
  const [done, setDone] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [direction, setDirection] = useState('forward');
  const [llmSettings, setLlmSettings] = useState(null);
  const [aiSource, setAiSource] = useState('cloud'); // 'local' or 'cloud'
  const [availableOcrEngines, setAvailableOcrEngines] = useState([]);
  const [reviewData, setReviewData] = useState(null);
  const [reviewPath, setReviewPath] = useState(null);
  const [reviewIdx, setReviewIdx] = useState(0);
  const [reviewDraft, setReviewDraft] = useState({});
  const [reviewZoom, setReviewZoom] = useState(1);
  const [reviewPan, setReviewPan] = useState({ x: 0, y: 0 });
  const [reviewDragging, setReviewDragging] = useState(false);
  const [presetSaveInput, setPresetSaveInput] = useState('');
  const [presetSaveVisible, setPresetSaveVisible] = useState(false);
  const [presetSaveMsg, setPresetSaveMsg] = useState(null);
  // 布局确认面板：layoutDraft=可编辑的 spec 视图；layoutBusy=提交中；layoutMsg=结果提示
  const [layoutDraft, setLayoutDraft] = useState(null);
  const [layoutBusy, setLayoutBusy] = useState(false);
  const [layoutMsg, setLayoutMsg] = useState(null);
  const [layoutConfirmed, setLayoutConfirmed] = useState(false);

  const getZoomForRoi = useCallback((roiW, roiH, fillRatio = 0.9) => {
    const stage = stageSizeRef.current;
    if (!stage || !stage.w || !stage.h || !roiW || !roiH) return 1;
    const scale = Math.min(stage.w / roiW, stage.h / roiH);
    return Math.max(0.1, scale * fillRatio);
  }, []);

  const getCenterPan = useCallback((zoom) => {
    const stage = stageSizeRef.current;
    return { x: (stage.w * (1 - zoom)) / 2, y: (stage.h * (1 - zoom)) / 2 };
  }, []);

  const getFocusPan = useCallback((cx, cy, zoom) => {
    const stage = stageSizeRef.current;
    return { x: stage.w / 2 - cx * zoom, y: stage.h / 2 - cy * zoom };
  }, []);

  const dragStart = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const stageSizeRef = useRef({ w: 400, h: 300 });
  const stageRef = useRef(null);
  const imgDisplaySizeRef = useRef({ w: 0, h: 0 });
  const imgNatSizeRef = useRef({ w: 0, h: 0 });
  const runningRef = useRef(false);

  // Keep runningRef in sync with running state (for use in effects that shouldn't re-run on running change)
  useEffect(() => {
    runningRef.current = running;
  }, [running]);

  // Shared wizard field-change handler.
  // The summary page is AI-generated, so ticking it auto-enables the AI master
  // switch. Without this the payload carried no llmConfig, the generator logged
  // "LLM disabled" and silently skipped the summary — which is exactly what
  // happened when only "Summary Page" had been ticked.
  const handleFieldChange = useCallback((key, value) => {
    setParams((prev) => {
      const next = { ...prev, [key]: value };
      if (key === 'enableSummary' && value) next.ollamaEnabled = true;
      return next;
    });
  }, []);

  const visibleSteps = useMemo(() => {
    if (!config) return [];
    const steps = config.steps.filter(step => {
      if (!step.showWhen) return true;
      return step.showWhen(params);
    });
    // Inject dynamic OCR engine options for the organizer tab
    if (tab.id === 'organizer') {
      return steps.map(step => ({
        ...step,
        fields: step.fields.map(field => {
          if (field.key === 'ocrEngine.engine' && availableOcrEngines.length > 0) {
            return { ...field, options: availableOcrEngines };
          }
          return field;
        }),
      }));
    }
    return steps;
  }, [config, params, tab.id, llmSettings, aiSource, availableOcrEngines]);

  const isSinglePage = !config?.adaptive || visibleSteps.length <= 1;
  const currentStep = visibleSteps[stepIdx];

  // Ensure stepIdx is within bounds when visibleSteps changes (e.g. field mapping step appears)
  useEffect(() => {
    if (stepIdx >= visibleSteps.length && visibleSteps.length > 0) {
      setStepIdx(visibleSteps.length - 1);
    }
  }, [visibleSteps.length, stepIdx]);

  // Auto-advance one step after template type is selected (next step, not skipping ahead)
  useEffect(() => {
    setParams({});
    setStepIdx(0);
    setProgress(0);
    setProgressLabel('');
    setLogs([]);
    setDone(false);
    setResult(null);
    setError(null);
    setReviewData(null);
    setReviewIdx(0);
    setReviewDraft({});
    setReviewZoom(1);
    setReviewPan({ x: 0, y: 0 });
    setReviewPath(null);
    setReviewDraft({});
    setLayoutDraft(null);
    setLayoutBusy(false);
    setLayoutMsg(null);
    setLayoutConfirmed(false);
  }, [tab.id]);

  // Initialize params with default values from the wizard config for the current tab
  useEffect(() => {
    if (!config) return;
    setParams(prev => {
      const updated = { ...prev };
      let changed = false;
      for (const step of config.steps) {
        for (const field of step.fields) {
          if (field.default !== undefined && updated[field.key] === undefined) {
            updated[field.key] = field.default;
            changed = true;
          }
          if (field.type === 'group' && field.toggles) {
            for (const tg of field.toggles) {
              if (tg.default !== undefined && updated[tg.key] === undefined) {
                updated[tg.key] = tg.default;
                changed = true;
              }
            }
          }
        }
      }
      return changed ? updated : prev;
    });
  }, [config]);

  // Load LLM settings for slides (AI descriptions) and bestseller analysis.
  // Also load OCR engines for the organizer tab.
  useEffect(() => {
    if (tab.id !== 'organizer' && tab.id !== 'slides' && tab.id !== 'bestseller') return;
    const loadSettings = async () => {
      const api = window.electronAPI;
      try {
        if ((tab.id === 'slides' || tab.id === 'bestseller') && api?.loadLLMConfig) {
          const cfg = await api.loadLLMConfig();
          if (cfg) {
            setLlmSettings(cfg);
          }
        }
        if (api?.ocrDetectAvailableEngines) {
          const oe = await api.ocrDetectAvailableEngines();
          if (oe?.success && oe.engines?.length > 0) {
            setAvailableOcrEngines(oe.engines);
          }
        }
      } catch (e) {
        console.error('Failed to load settings:', e);
      }
    };
    loadSettings();
  }, [tab.id]);

  // Subscribe to live LLM config updates (e.g. when user saves settings in LLMConfigManager)
  useEffect(() => {
    return subscribeLLMConfigUpdate((cfg) => {
      if (cfg) setLlmSettings(cfg);
    });
  }, []);

  // Keep aiSource state in sync with params.aiSource (when user changes selection)
  useEffect(() => {
    if (params.aiSource && params.aiSource !== aiSource) {
      setAiSource(params.aiSource);
    }
  }, [params.aiSource]);

  useEffect(() => {
    if (!config?.logChannel) return;
    const channel = LOG_CHANNELS[config.logChannel];
    if (!channel) return;
    const api = window.electronAPI;
    if (!api) return;

    // If a task is currently running from another tab, keep its listeners
    // We only (re)register listeners when no task is running
    if (runningRef.current) return;

    const logCb = (entry) => {
      const line = typeof entry === 'string' ? entry : (entry?.message || JSON.stringify(entry));
      const tm = entry?.time || new Date().toLocaleTimeString();
      const type = entry?.type || 'info';
      const logEntry = { time: tm, message: line, type };
      setLogs(prev => [...prev.slice(-200), logEntry]);
      onLog?.(logEntry);
    };

    const progCb = (p) => {
      const pct = typeof p === 'number' ? p : (p?.progress ?? 0);
      const label = typeof p === 'string' ? p : (p?.label || p?.message || '');
      setProgress(pct);
      if (label) setProgressLabel(label);
    };

    api[channel.log]?.(logCb);
    api[channel.progress]?.(progCb);
    if (channel.item) api[channel.item]?.((item) => setLogs(prev => [...prev.slice(-200), { time: new Date().toLocaleTimeString(), message: `📦 ${item.name || ''}`, type: 'item' }]));

    return () => {
      // Only remove listeners when no task is running
      // This preserves progress/log updates for background tasks
      if (!runningRef.current) {
        api[channel.remove]?.();
      }
    };
  }, [config?.logChannel]);

  // Auto-zoom to label/cropBox position when switching review items
  useEffect(() => {
    if (!reviewData) return;
    const reviewItems = Array.isArray(reviewData) ? reviewData
      : Array.isArray(reviewData?.styles) ? reviewData.styles
      : Array.isArray(reviewData?.items) ? reviewData.items
      : [];
    if (reviewItems.length === 0) return;
    const item = reviewItems[reviewIdx];
    if (!item) return;
    const labelInfo = item.labelInfo || {};
    const cropBox = labelInfo.detectorCropBox || labelInfo.cropBox;
    const fields = labelInfo.fields || {};

    // Determine the region of interest (ROI): prefer cropBox, otherwise compute from field bboxes
    let roi = null;
    if (cropBox && cropBox.width > 0 && cropBox.height > 0) {
      roi = { ...cropBox };
    } else {
      const bboxes = Object.values(fields)
        .map(f => f && (f.bbox || f.box))
        .filter(Boolean);
      if (bboxes.length > 0) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const b of bboxes) {
          const x = b.left ?? b.x ?? 0;
          const y = b.top ?? b.y ?? 0;
          const w = b.width ?? b.w ?? 0;
          const h = b.height ?? b.h ?? 0;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x + w);
          maxY = Math.max(maxY, y + h);
        }
        if (isFinite(minX)) {
          roi = { left: minX, top: minY, width: maxX - minX, height: maxY - minY };
        }
      }
    }

    if (roi && roi.width > 0 && roi.height > 0 && imgNatSizeRef.current.w > 0) {
      const cx = roi.left + roi.width / 2;
      const cy = roi.top + roi.height / 2;
      const targetZoom = getZoomForRoi(roi.width, roi.height, 0.9);
      setReviewZoom(targetZoom);
      setReviewPan(getFocusPan(cx, cy, targetZoom));
    } else {
      // No ROI: fit to stage
      setReviewZoom(1);
      setReviewPan(getCenterPan(1));
    }
    setReviewDraft({});
  }, [reviewIdx, reviewData, getFocusPan, getCenterPan, getZoomForRoi]);

  const handleRun = useCallback(async () => {
    if (!config?.runIPC || running) return;
    const api = window.electronAPI;
    if (!api) return;

    setRunning(true);
    setDone(false);
    setError(null);
    setReviewData(null);
    setReviewIdx(0);
    setReviewDraft({});
    setReviewZoom(1);
    setReviewPan({ x: 0, y: 0 });
    setReviewPath(null);
    setReviewDraft({});
    setLayoutDraft(null);
    setLayoutBusy(false);
    setLayoutMsg(null);
    setLayoutConfirmed(false);
    setResult(null);
    setProgress(0);
    setProgressLabel(tx('Starting…', '正在启动…'));
    setLogs([]);

    try {
      const payload = { ...params };
      if (tab.id === 'slides') {
        const styleGrp = params.styleInfoGroup || {};
        const fabricGrp = params.fabricInfoGroup || {};
        const imageLayout = params.sourceMode === 'fabric-images'
          ? (Number(params.fabricPageImageCount) === 2 ? 'fabric-pair' : 'fabric-single')
          : `style-gallery-${params.stylePageImageCount}`;
        // Pass-through FIRST, then explicit overrides. A strict whitelist here
        // silently dropped newly added wizard fields (enableToc / enableSummary /
        // exportPdf / pptTheme were lost this way — backend defaulted them to off).
        // generate_slides.py only does settings.get(...) on known keys, so unknown
        // extras are harmless; SlidesMaker.jsx already spreads `...config`.
        payload.config = {
          ...params,
          imageLayout,
          includeStyleNumber: styleGrp.includeStyleNumber ?? true,
          includeName: styleGrp.includeName ?? true,
          includePrice: styleGrp.includePrice ?? true,
          includeDescription: styleGrp.includeDescription ?? true,
          includeFabricCode: fabricGrp.includeFabricCode ?? false,
          includeComposition: fabricGrp.includeComposition ?? false,
          includeWidth: fabricGrp.includeWidth ?? false,
          includeCuttable: fabricGrp.includeCuttable ?? false,
          includeWeight: fabricGrp.includeWeight ?? false,
          sortBy: params.sortBy || 'styleNumber',
          fillMissingSlots: params.fillMissingSlots ?? true,
        };
        // AI is needed by AI descriptions AND by the summary page (its overview
        // and category suggestions are AI-generated). The wizard only carries
        // the on/off switch — mode, endpoint and model all come from the saved
        // settings config (an empty model is resolved by the main process).
        if (params.ollamaEnabled || params.enableSummary) {
          const cfg = llmSettings || {};
          const mode = cfg.mode || 'local';
          const apiPreset = (cfg.apiCloud?.presets || []).find((p) => p.id === cfg.apiCloud?.activePresetId) || {};
          const endpoint = mode === 'cloud'
            ? cfg.cloud || {}
            : mode === 'apiCloud'
              ? apiPreset
              : (cfg.local || {});
          payload.config.ollamaEnabled = true;
          payload.config.enableVision = true;
          payload.config.generateDescription = !!params.ollamaEnabled;
          payload.config.llmConfig = {
            mode,
            baseUrl: endpoint.baseUrl || (mode === 'local' ? 'http://localhost:11434' : ''),
            model: endpoint.model || '',
            apiKey: endpoint.apiKey || '',
          };
          // Vision slots stay empty = follow the main model (resolved by Python
          // and guarded by the main-process vision pre-flight).
          payload.config.apparelVision = {
            enabled: true,
            garmentModel: '',
            fabricModel: '',
          };
        }
      }
      if (tab.id === 'organizer') {
        payload.config = {
          namingMode: params.namingMode,
          labelNamingTarget: params.labelNamingTarget,
          styleNameField: params.styleNameField,
          organizeOutputMode: params.organizeOutputMode || 'single-folder',
          organizeAction: params.organizeAction || 'move',
          groupSize: params.groupSize || 4,
          numberStart: params.numberStart,
          imageSuffixes: params.imageSuffixes || '',
          labelIndex: params.labelIndex || 4,
          ocrEngine: params['ocrEngine.engine'] || 'guten-ocr',
        };
        payload.outputFolder = params.sourceFolder;
      }
      if (tab.id === 'scraper') {
        payload.tabConcurrency = 2;
        payload.zaraBackupMode = params.zaraBackupMode || false;
        payload.downloadConcurrency = params.downloadConcurrency || 10;
        if (params.brand === 'mixed' && params.mixedBrandInputs) {
          payload.mixedBrandEntries = params.mixedBrandInputs;
        } else {
          payload.styleNumbers = params.styleNumbers || '';
        }
        payload.excelPath = params.excelPath || '';
        // The AI trend analysis (params.doAnalyze) uses the saved settings
        // config: the scraper handler falls back to 'default' mode when no
        // explicit llm endpoint is passed, and resolves an empty model itself.
      }
      if (tab.id === 'bestseller') {
        payload.brand = params.brand || 'newyorker';
        payload.downloadConcurrency = 6;
        payload.brandLabel = params.brand === 'newyorker' ? 'New Yorker' : (params.brand === 'intersport' ? 'Intersport' : (params.brand || 'Brand'));
        payload.genderLabel = params.gender === 'female' ? 'Women' : 'Men';
        if (params.brand === 'intersport') {
          payload.intersportCategory = params.intersportCategory || 'funktionsjacken';
          payload.productCount = Number(params.productCount) || 0;
        }
        // doAnalyze defaults to true (matching wizardConfig default);
        // the toggle's default is only used at render time so params may be
        // undefined. The AI trend report uses the saved settings config: the
        // report falls back to 'default' mode and resolves an empty model from
        // the endpoint itself.
      }
      if (tab.id === 'cleaner') {
        const src = params.sourcePath;
        if (src && typeof src === 'object' && src.path) {
          payload.sourcePath = src.path;
          payload.sourceKind = src.kind || 'folder';
        } else if (typeof src === 'string') {
          payload.sourcePath = src;
          payload.sourceKind = 'folder';
        }
        payload.options = {
          cleanerMode: params.cleanerMode || 'lite',
          backgroundMode: params.backgroundMode || 'transparent',
          outputRatio: params.outputRatio || 'original',
        };
      }
      if (tab.id === 'pdfsqueezer') {
        payload.config = { preset: params.preset || 'balanced' };
        payload.sourceFiles = Array.isArray(params.sourceFiles) ? params.sourceFiles : (params.sourceFiles ? [params.sourceFiles] : []);
      }

      const res = await api[config.runIPC]?.(payload);

      // Bestseller: if AI trend report is enabled, run analysis after scraping
      // (doAnalyze defaults to true, matching wizardConfig — toggle default is render-only)
      if (tab.id === 'bestseller' && params.doAnalyze !== false && res?.success !== false) {
        setProgressLabel(tx('Running AI analysis…', '正在运行 AI 分析…'));
        setLogs(prev => [...prev, { id: Date.now(), type: 'info', text: tx('🤖 Starting AI trend report analysis…', '🤖 开始 AI 趋势报告分析…') }]);
        try {
          const analyzePayload = {
            sourceDir: res?.outputPath || res?.outputDir || payload.outputDir || '',
            language: params.language || 'en',
            // 'default' = use the saved settings config (mode/endpoint/model);
            // an empty model is resolved by bestseller-report itself.
            llmMode: 'default',
            imagesPerStyle: Number(params.imagesPerStyle) || 3,
            brandLabel: payload.brandLabel,
            genderLabel: payload.genderLabel,
          };
          const analyzeRes = await api.bestsellerAnalyze?.(analyzePayload);
          if (analyzeRes?.success === false) {
            setLogs(prev => [...prev, { id: Date.now(), type: 'warning', text: `AI analysis warning: ${analyzeRes.error || 'Unknown error'}` }]);
          }
        } catch (analyzeErr) {
          setLogs(prev => [...prev, { id: Date.now(), type: 'warning', text: `AI analysis failed: ${analyzeErr.message}` }]);
        }
      }

      // Scraper: same optional post-scrape AI trend analysis as bestseller.
      // Historically the wizard's doAnalyze toggle was display-only; wire it
      // here so the picked endpoint + model actually drive the report.
      if (tab.id === 'scraper' && params.doAnalyze && res?.success !== false) {
        const brandLabels = {
          zara: 'Zara', bershka: 'Bershka', stradivarius: 'Stradivarius', pullandbear: 'Pull & Bear',
          lefties: 'Lefties', mango: 'Mango', reserved: 'Reserved', sinsay: 'Sinsay',
          urbanrevivo: 'Urban Revivo', newyorker: 'New Yorker', hm: 'H&M', uniqlo: 'Uniqlo',
          gu: 'GU', abercrombie: 'Abercrombie', mixed: 'Mixed Brands',
        };
        setProgressLabel(tx('Running AI analysis…', '正在运行 AI 分析…'));
        setLogs(prev => [...prev, { id: Date.now(), type: 'info', text: tx('🤖 Starting AI trend report analysis…', '🤖 开始 AI 趋势报告分析…') }]);
        try {
          const analyzePayload = {
            sourceDir: res?.outputPath || res?.outputDir || params.outputDir || '',
            language: params.language || 'en',
            // 'default' = use the saved settings config (mode/endpoint/model);
            // an empty model is resolved by bestseller-report itself.
            llmMode: 'default',
            imagesPerStyle: 3,
            brandLabel: brandLabels[params.brand] || params.brand || 'Brand',
            genderLabel: '',
          };
          const analyzeRes = await api.bestsellerAnalyze?.(analyzePayload);
          if (analyzeRes?.success === false) {
            setLogs(prev => [...prev, { id: Date.now(), type: 'warning', text: `AI analysis warning: ${analyzeRes.error || 'Unknown error'}` }]);
          }
        } catch (analyzeErr) {
          setLogs(prev => [...prev, { id: Date.now(), type: 'warning', text: `AI analysis failed: ${analyzeErr.message}` }]);
        }
      }

      setRunning(false);
      setProgress(100);
      setProgressLabel(tx('Done', '完成'));

      if (res?.success === false) {
        setError(res.error || tx('Task failed.', '任务失败。'));
      } else {
        setDone(true);
        setResult(res);
      }
    } catch (err) {
      setRunning(false);
      setError(err.message || tx('Unexpected error.', '意外错误。'));
    }
  }, [config, params, running, tab.id, tx, llmSettings]);

  const handleCancel = useCallback(() => {
    if (!config?.cancelIPC) return;
    const api = window.electronAPI;
    api?.[config.cancelIPC]?.(config.cancelArg);
    setRunning(false);
    setProgressLabel(tx('Cancelled', '已取消'));
  }, [config, tx]);

  const goNext = () => {
    if (stepIdx < visibleSteps.length - 1) {
      setDirection('forward');
      setStepIdx(i => i + 1);
    }
  };
  const goPrev = () => {
    if (stepIdx > 0) {
      setDirection('backward');
      setStepIdx(i => i - 1);
    }
  };

  const stepValid = (step) => {
    if (!step?.fields) return true;
    // Check requiredAnyOf: at least one of these keys must be filled
    if (step.requiredAnyOf) {
      const hasAny = step.requiredAnyOf.some(k => {
        const v = params[k];
        return v !== undefined && v !== '' && v !== null;
      });
      if (!hasAny) return false;
    }
    return step.fields.every(f => {
      if (!f.required) return true;
      if (f.showWhen && !f.showWhen(params)) return true;
      const v = params[f.key];
      if (v === undefined || v === '' || v === null) return false;
      // Handle object values from source-or-file-picker
      if (typeof v === 'object' && !Array.isArray(v)) {
        return Boolean(v.path);
      }
      return true;
    });
  };
  const allValid = visibleSteps.every(stepValid);
  const reachedLastStep = isSinglePage || stepIdx === visibleSteps.length - 1;
  const canRun = !running && allValid && reachedLastStep && config?.runIPC;

  if (!config) return null;

  // ── Custom render (e.g. Label OCR settings) ──
  if (config.customRender === 'labelocr') {
    return (
      <section
        className="module-home module-home--settings"
        style={{ '--home-accent-rgb': accentRgb, '--home-accent-ink': accentInk }}
      >
        <div className="module-home__scroll-wrap">
          <div className="module-home__content module-home__content--wide">
            <div className="module-home__header">
              <div className="module-home__badge">{iconNode}</div>
              <h1 className="module-home__title">{tab.label}</h1>
              <p className="module-home__subtitle">{tab.description}</p>
            </div>
            <LabelOcrBridge tx={tx} />
          </div>
        </div>
      </section>
    );
  }

  // ── Main render ──
  const ctxValue = {
    params, setParams, llmSettings, aiSource,
  };

  return (
        <section
      className={`module-home ${isSinglePage ? 'module-home--single' : 'module-home--stepped'} ${running ? 'is-running' : ''} ${done ? 'is-done' : ''}`}
      style={{ '--home-accent-rgb': accentRgb, '--home-accent-ink': accentInk }}
      data-direction={direction}
    >
      <div className="module-home__scroll-wrap">
        <div className="module-home__content">
        <div className="module-home__header">
          <div className="module-home__badge">{iconNode}</div>
          <h1 className="module-home__title">{tab.label}</h1>
          <p className="module-home__subtitle">{tab.description}</p>
        </div>

        {(running || done) && !reviewData && (
          <div className="wizard-progress">
            <div className="wizard-progress__bar" style={{ width: `${progress}%` }} />
            <span className="wizard-progress__label">{progressLabel}</span>
          </div>
        )}

        {!reviewData && isSinglePage ? (
          <div className="wizard-body wizard-body--single" key={tab.id}>
            {visibleSteps.map((step) => (
              <div key={step.title?.en} className="wizard-step-section">
                {step.title && <h3 className="wizard-step-section__title">{t(step.title)}</h3>}
                {step.desc && <p className="wizard-step-section__desc">{t(step.desc)}</p>}
                <div className="wizard-step-section__fields">
                  {step.fields.map((field) => {
                    if (field.showWhen && !field.showWhen(params)) return null;
                    return (
                      <FieldRenderer
                        key={field.key}
                        field={field}
                        value={params[field.key]}
                        onChange={(v) => handleFieldChange(field.key, v)}
                        t={t}
                        tx={tx}
                        accentRgb={accentRgb}
                        allParams={params}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {!reviewData && !isSinglePage && (
          <div className="wizard-body wizard-body--stepped" key={`${tab.id}-${stepIdx}`}>
            <div className="wizard-step-indicator">
              {visibleSteps.map((_, i) => (
                <span
                  key={i}
                  className={`wizard-step-dot ${i === stepIdx ? 'active' : ''} ${i < stepIdx ? 'done' : ''}`}
                  style={{ '--accent-rgb': accentRgb }}
                  onClick={() => { setDirection(i > stepIdx ? 'forward' : 'backward'); setStepIdx(i); }}
                />
              ))}
            </div>

            {currentStep && (
              <div className="wizard-step wizard-step--active" data-direction={direction}>
                <h3 className="wizard-step__title">{t(currentStep.title)}</h3>
                {currentStep.desc && <p className="wizard-step__desc">{t(currentStep.desc)}</p>}
                <div className="wizard-step__fields">
                  {currentStep.fields.map((field) => {
                    if (field.showWhen && !field.showWhen(params)) return null;
                    return (
                      <FieldRenderer
                        key={field.key}
                        field={field}
                        value={params[field.key]}
                        onChange={(v) => handleFieldChange(field.key, v)}
                        t={t}
                        tx={tx}
                        accentRgb={accentRgb}
                        allParams={params}
                      />
                    );
                  })}
                </div>
              </div>
            )}

            <div className="wizard-nav">
              <button
                type="button"
                className="wizard-nav__btn wizard-nav__btn--prev"
                onClick={goPrev}
                disabled={stepIdx === 0}
                style={{ '--accent-rgb': accentRgb }}
              >
                ← {tx('Previous', '上一步')}
              </button>
              <span className="wizard-nav__counter">
                {stepIdx + 1} / {visibleSteps.length}
              </span>
              {stepIdx < visibleSteps.length - 1 ? (
                <button
                  type="button"
                  className="wizard-nav__btn wizard-nav__btn--next"
                  onClick={goNext}
                  disabled={!stepValid(currentStep)}
                  style={{ '--accent-rgb': accentRgb }}
                >
                  {tx('Next', '下一步')} →
                </button>
              ) : (
                <span className="wizard-nav__ready" style={{ '--accent-rgb': accentRgb }}>
                  ✓ {tx('Ready', '已就绪')}
                </span>
              )}
            </div>
          </div>
        )}


        {error && (
          <div className="wizard-msg wizard-msg--error">
            <PoIconAlert size={14} style={{ verticalAlign: '-2px', marginRight: 6 }} />{error}
          </div>
        )}
        {done && result && !reviewData && (
          <div className="wizard-msg wizard-msg--success" style={{ '--accent-rgb': accentRgb }}>
            <PoIconCheck size={15} style={{ verticalAlign: '-3px', marginRight: 6 }} />
            {tx('Task completed.', '任务完成。')}
            {result.orders && result.orders.length > 0 && (
              <span className="wizard-msg__detail">
                {tx(`${result.orders.length} order(s) extracted`, `已提取 ${result.orders.length} 个订单`)}
              </span>
            )}
            {result.outputPath && (
              <button type="button" className="wizard-msg__action" onClick={() => window.electronAPI?.openLocalPath?.(result.outputPath)}>
                {tx('Open file', '打开文件')}
              </button>
            )}
            {result.outputDir && (
              <button type="button" className="wizard-msg__action" onClick={() => window.electronAPI?.openLocalPath?.(result.outputDir)}>
                {tx('Open folder', '打开文件夹')}
              </button>
            )}
            {tab.id === 'organizer' && result.summaryPath && !reviewData && (
              <button
                type="button"
                className="wizard-msg__action"
                style={{ background: 'rgba(var(--accent-rgb), 0.18)', borderColor: 'rgba(var(--accent-rgb), 0.4)' }}
                onClick={async () => {
                  const api = window.electronAPI;
                  console.log('[REVIEW] button clicked, summaryPath:', result.summaryPath);
                  if (!api) { alert('Electron API not available'); return; }
                  if (!result.summaryPath) { alert('No summary path'); return; }
                  try {
                    const raw = await api.readFile?.(result.summaryPath);
                    console.log('[REVIEW] raw data:', raw);
                    const fileContent = raw && raw.success ? raw.content : raw;
                    if (fileContent) {
                      const parsed = typeof fileContent === 'string' ? JSON.parse(fileContent) : fileContent;
                      console.log('[REVIEW] parsed items count:',
                        Array.isArray(parsed) ? parsed.length
                          : Array.isArray(parsed?.styles) ? parsed.styles.length
                          : Array.isArray(parsed?.items) ? parsed.items.length : 0);
                      setReviewPath(result.summaryPath);
                      setReviewData(parsed);
                    } else {
                      alert(tx('No review data found.', '未找到审核数据。'));
                    }
                  } catch (e) {
                    console.error('[REVIEW] error:', e);
                    alert(tx('Failed to load review data: ', '加载审核数据失败：') + e.message);
                  }
                }}
              >
                <PoIconSearch size={13} style={{ verticalAlign: '-2px', marginRight: 5 }} />
                {tx('Review Results', '审核结果')}
              </button>
            )}
          </div>
        )}
        {reviewData && (() => {
          const reviewItems = Array.isArray(reviewData) ? reviewData
            : Array.isArray(reviewData?.styles) ? reviewData.styles
            : Array.isArray(reviewData?.items) ? reviewData.items
            : [];
          if (reviewItems.length === 0) return null;
          const item = reviewItems[reviewIdx];
          if (!item) return null;
          const labelInfo = item.labelInfo || {};
          const fields = labelInfo.fields || labelInfo || {};
          const imgPath = item.files?.label || item.sourceFiles?.label || item.files?.image1 || item.galleryImagePaths?.[0] || '';
          const imgSrc = imgPath ? `file://${imgPath}` : '';
          const cropBox = labelInfo.detectorCropBox || labelInfo.cropBox;
          const FIELD_KEYS = ['fabricCode', 'styleNumber', 'description', 'composition', 'width', 'cuttable', 'weight'];
          const FIELD_LABELS = {
            fabricCode: tx('Fabric Code', '面料代码'), styleNumber: tx('Style Number', '款号'),
            description: tx('Description', '描述'), composition: tx('Composition', '成分'),
            width: tx('Width', '门幅'), cuttable: tx('Cuttable', '可裁幅'), weight: tx('Weight', '克重'),
          };
          return (
            <div className="wizard-review">
              <div className="wizard-review__head">
                <h3 className="wizard-review__title">{tx('Review OCR Results', '审核 OCR 结果')}</h3>
                <span className="wizard-review__counter">{reviewIdx + 1} / {reviewItems.length}</span>
              </div>
              {(() => {
                // Compute base scale that fits the image into the stage
                const nat = imgNatSizeRef.current;
                const stage = stageSizeRef.current;
                const baseFitScale = (nat.w > 0 && nat.h > 0 && stage.w > 0 && stage.h > 0)
                  ? Math.min(stage.w / nat.w, stage.h / nat.h)
                  : 1;
                const actualScale = baseFitScale * reviewZoom;
                return (
              <div className="wizard-review__layout">
                {/* Image viewer */}
                <div className="wizard-review__viewer">
                  {imgSrc ? (
                    <div
                      ref={(el) => {
                        if (el && stageRef.current !== el) {
                          stageRef.current = el;
                          const rect = el.getBoundingClientRect();
                          stageSizeRef.current = { w: rect.width, h: rect.height };
                        }
                      }}
                      className="wizard-review__stage"
                      onPointerDown={(e) => { setReviewDragging(true); dragStart.current = { x: e.clientX, y: e.clientY, panX: reviewPan.x, panY: reviewPan.y }; }}
                      onPointerMove={(e) => { if (reviewDragging) { setReviewPan({ x: dragStart.current.panX + (e.clientX - dragStart.current.x), y: dragStart.current.panY + (e.clientY - dragStart.current.y) }); } }}
                      onPointerUp={() => setReviewDragging(false)}
                      onPointerLeave={() => setReviewDragging(false)}
                    >
                      <img
                        src={imgSrc}
                        alt={item.styleNumber || `Item ${reviewIdx + 1}`}
                        className="wizard-review__img"
                        style={{ width: nat.w > 0 ? nat.w : 'auto', height: nat.h > 0 ? nat.h : 'auto', transform: `translate(${reviewPan.x}px, ${reviewPan.y}px) scale(${actualScale})` }}
                        onLoad={(e) => {
                          const el = e.currentTarget;
                          imgNatSizeRef.current = { w: el.naturalWidth, h: el.naturalHeight };
                          // Recompute stage size too
                          if (stageRef.current) {
                            const r = stageRef.current.getBoundingClientRect();
                            stageSizeRef.current = { w: r.width, h: r.height };
                          }
                          // Re-trigger auto-zoom after image loads
                          setReviewPan(prev => ({ ...prev }));
                        }}
                        draggable={false}
                      />
                      {cropBox && (
                        <div
                          className="wizard-review__bbox"
                          style={{
                            left: `${cropBox.left * actualScale + reviewPan.x}px`,
                            top: `${cropBox.top * actualScale + reviewPan.y}px`,
                            width: `${cropBox.width * actualScale}px`,
                            height: `${cropBox.height * actualScale}px`,
                          }}
                        />
                      )}
                    </div>
                  ) : (
                    <div className="wizard-review__no-img">{tx('No image available', '无图片')}</div>
                  )}
                  <div className="wizard-review__zoom-bar">
                    <button type="button" onClick={() => setReviewZoom(z => Math.max(0.3, z - 0.2))}>−</button>
                    <span>{Math.round(reviewZoom * 100)}%</span>
                    <button type="button" onClick={() => setReviewZoom(z => Math.min(4, z + 0.2))}>+</button>
                    <button type="button" onClick={() => { setReviewZoom(1); setReviewPan(getCenterPan(1)); }}>{tx('Fit', '适应')}</button>
                    {cropBox && <button type="button" onClick={() => {
                      if (cropBox) {
                        const cx = cropBox.left + cropBox.width / 2;
                        const cy = cropBox.top + cropBox.height / 2;
                        const targetZoom = getZoomForRoi(cropBox.width, cropBox.height, 0.9);
                        setReviewZoom(targetZoom);
                        setReviewPan(getFocusPan(cx, cy, targetZoom));
                      }
                    }}>{tx('Focus', '聚焦标签')}</button>}
                  </div>
                </div>
                {/* Form panel */}
                <div className="wizard-review__form">
                  <div className="wizard-review__form-head">
                    <span className="wizard-review__item-name">{item.styleNumber || item.folderName || `Item ${reviewIdx + 1}`}</span>
                    {item.needsReview && <span className="wizard-review__tag wizard-review__tag--warn">{tx('Needs Review', '需审核')}</span>}
                  </div>
                  <div className="wizard-review__fields">
                    {FIELD_KEYS.map((fKey) => (
                      <label key={fKey} className="wizard-review__field">
                        <span className="wizard-review__field-label">{FIELD_LABELS[fKey] || fKey}</span>
                        <input
                          type="text"
                          className="wizard-input wizard-review__field-input"
                          value={reviewDraft[fKey] ?? fields[fKey] ?? ''}
                          onChange={(e) => setReviewDraft(prev => ({ ...prev, [fKey]: e.target.value }))}
                        />
                      </label>
                    ))}
                    <label className="wizard-review__field">
                      <span className="wizard-review__field-label">{tx('Style Number', '款号')}</span>
                      <input
                        type="text"
                        className="wizard-input wizard-review__field-input"
                        value={reviewDraft.styleNumber ?? item.styleNumber ?? ''}
                        onChange={(e) => setReviewDraft(prev => ({ ...prev, styleNumber: e.target.value }))}
                      />
                    </label>
                  </div>
                  {labelInfo.rawText && (
                    <details className="wizard-review__raw">
                      <summary>{tx('Raw OCR Text', '原始 OCR 文本')}</summary>
                      <pre>{labelInfo.rawText}</pre>
                    </details>
                  )}
                  <div className="wizard-review__nav">
                    <button type="button" className="wizard-nav__btn wizard-nav__btn--prev" disabled={reviewIdx === 0}
                      onClick={() => { setReviewIdx(i => i - 1); setReviewDraft({}); setReviewZoom(1); setReviewPan(getCenterPan(1)); }}>
                      ← {tx('Previous', '上一张')}
                    </button>
                    <button type="button" className="wizard-nav__btn wizard-nav__btn--next" style={{ '--accent-rgb': accentRgb }}
                      disabled={reviewIdx >= reviewItems.length - 1}
                      onClick={() => { setReviewIdx(i => i + 1); setReviewDraft({}); setReviewZoom(1); setReviewPan(getCenterPan(1)); }}>
                      {tx('Next', '下一张')} →
                    </button>
                  </div>
                  <div className="wizard-review__actions">
                    <button type="button" className="wizard-nav__btn" style={{ '--accent-rgb': accentRgb }}
                      onClick={async () => {
                        const api = window.electronAPI;
                        if (!api || !reviewPath) return;
                        const updatedItems = reviewItems.map((it, i) => i === reviewIdx ? { ...it, labelInfo: { ...it.labelInfo, ...reviewDraft }, styleNumber: reviewDraft.styleNumber || it.styleNumber } : it);
                        const updatedData = reviewData.styles ? { ...reviewData, styles: updatedItems, reviewedAt: new Date().toISOString() } : updatedItems;
                        await api.saveOrganizeInfo?.({ filePath: reviewPath, content: JSON.stringify(updatedData, null, 2) });
                        if (item.infoPath) {
                          await api.saveOrganizeInfo?.({ filePath: item.infoPath, content: { ...item, labelInfo: { ...labelInfo, ...reviewDraft } } });
                        }
                        setReviewData(updatedData);
                        if (reviewIdx < reviewItems.length - 1) { setReviewIdx(i => i + 1); setReviewDraft({}); setReviewZoom(1); setReviewPan(getCenterPan(1)); }
                      }}>
                      {tx('Save & Next', '保存并下一张')}
                    </button>
                    <button type="button" className="wizard-nav__btn" style={{ '--accent-rgb': accentRgb }}
                      onClick={async () => {
                        const api = window.electronAPI;
                        if (!api || !reviewPath) return;
                        await api.applyOrganizeReviewResults?.({ summaryPath: reviewPath });
                        setReviewData(null);
                        setDone(true);
                        setResult({ outputDir: params.sourceFolder });
                      }}>
                      ✓ {tx('Apply All', '应用重命名')}
                    </button>
                    <button type="button" className="wizard-nav__btn"
                      onClick={() => window.electronAPI?.exportOrganizeExcel?.({ summaryPath: reviewPath })}>
                      {tx('Export Excel', '导出 Excel')}
                    </button>
                    <button type="button" className="wizard-nav__btn wizard-nav__btn--prev"
                      onClick={() => { setReviewData(null); }}>
                      {tx('Exit', '退出')}
                    </button>
                  </div>
                </div>
              </div>
                );
              })()}
            </div>
          );
        })()}
      </div>
      </div>

      <button
        type="button"
        className={`module-home__fab ${running ? 'is-running' : ''} ${!canRun && !running ? 'is-disabled' : ''}`}
        onClick={running ? handleCancel : handleRun}
        disabled={!canRun && !running}
        aria-label={running ? tx('Cancel', '取消') : tx('Run', '运行')}
      >
        {running ? (
          <span className="module-home__fab-icon module-home__fab-icon--cancel">✕</span>
        ) : (
          <span className="module-home__fab-icon">{fabIconNode}</span>
        )}
        <span className="module-home__fab-pulse" style={{ '--accent-rgb': accentRgb }} />
        <span className="module-home__fab-tip">
          {running ? tx('Cancel', '取消') : tx('Run', '运行')}
        </span>
      </button>
    </section>
  );
}

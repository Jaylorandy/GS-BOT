import React, { useEffect, useMemo, useState } from 'react';
import {
  LABEL_OCR_FIELD_META,
  createLabelOcrProfileDraft,
  parseLabelOcrAliasDraft,
  resetLabelOcrProfileDraft,
  updateLabelOcrFieldDraft,
} from '../utils/labelOcrProfile';

const STORAGE_KEY = 'gsbot-label-ocr-presets-v1';
const DEFAULT_PRESET_ID = 'default';

function loadSavedPresets() {
  if (typeof window === 'undefined') {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = JSON.parse(raw || '[]');
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((preset) => preset && typeof preset === 'object')
      .map((preset) => ({
        id: String(preset.id || '').trim(),
        name: String(preset.name || '').trim(),
        profile: createLabelOcrProfileDraft(preset.profile || {}),
      }))
      .filter((preset) => preset.id && preset.name);
  } catch {
    return [];
  }
}

function savePresetsToStorage(presets = []) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
}

export default function LabelOcrSettings({
  value,
  onChange,
  tx,
  showHelpText = true,
  compact = false,
}) {
  const profile = createLabelOcrProfileDraft(value || {});
  const [savedPresets, setSavedPresets] = useState([]);
  const [selectedPresetId, setSelectedPresetId] = useState(DEFAULT_PRESET_ID);
  const [isCreatingPreset, setIsCreatingPreset] = useState(false);
  const [newPresetName, setNewPresetName] = useState('');
  const [fieldDrafts, setFieldDrafts] = useState(() => Object.fromEntries(
    LABEL_OCR_FIELD_META.map((field) => [field.key, '']),
  ));

  useEffect(() => {
    setSavedPresets(loadSavedPresets());
  }, []);

  const presets = useMemo(() => ([
    {
      id: DEFAULT_PRESET_ID,
      name: tx('Default preset', '默认预设'),
      profile: resetLabelOcrProfileDraft(),
    },
    ...savedPresets,
  ]), [savedPresets, tx]);
  const selectedPreset = presets.find((item) => item.id === selectedPresetId) || null;
  const selectedPresetIsDefault = selectedPresetId === DEFAULT_PRESET_ID;
  const selectedPresetDirty = Boolean(
    selectedPreset
    && !selectedPresetIsDefault
    && JSON.stringify(createLabelOcrProfileDraft(selectedPreset.profile))
      !== JSON.stringify(createLabelOcrProfileDraft(profile)),
  );

  const updateFieldAliases = (fieldKey, nextAliases) => {
    onChange(updateLabelOcrFieldDraft(profile, fieldKey, nextAliases));
  };

  const addAliasTag = (fieldKey) => {
    const draftValue = String(fieldDrafts[fieldKey] || '').trim();
    if (!draftValue) {
      return;
    }

    const currentAliases = parseLabelOcrAliasDraft(profile.fields?.[fieldKey]);
    updateFieldAliases(fieldKey, [...currentAliases, draftValue]);
    setFieldDrafts((prev) => ({ ...prev, [fieldKey]: '' }));
  };

  const removeAliasTag = (fieldKey, aliasToRemove) => {
    const currentAliases = parseLabelOcrAliasDraft(profile.fields?.[fieldKey]);
    updateFieldAliases(fieldKey, currentAliases.filter((alias) => alias !== aliasToRemove));
  };

  const applyPreset = (presetId) => {
    setSelectedPresetId(presetId);
    const preset = presets.find((item) => item.id === presetId);
    if (preset) {
      onChange(createLabelOcrProfileDraft(preset.profile));
    }
  };

  const beginCreatePreset = () => {
    setIsCreatingPreset(true);
    setNewPresetName('');
  };

  const cancelCreatePreset = () => {
    setIsCreatingPreset(false);
    setNewPresetName('');
  };

  const saveCurrentAsPreset = () => {
    const trimmedName = String(newPresetName || '').trim();
    if (!trimmedName) {
      return;
    }

    const presetId = `preset-${Date.now().toString(36)}`;
    const nextPresets = [
      ...savedPresets,
      {
        id: presetId,
        name: trimmedName,
        profile: createLabelOcrProfileDraft(profile),
      },
    ];
    setSavedPresets(nextPresets);
    savePresetsToStorage(nextPresets);
    setSelectedPresetId(presetId);
    setIsCreatingPreset(false);
    setNewPresetName('');
  };

  const saveSelectedPreset = () => {
    if (selectedPresetIsDefault) {
      return;
    }

    const nextPresets = savedPresets.map((preset) => (
      preset.id === selectedPresetId
        ? {
            ...preset,
            profile: createLabelOcrProfileDraft(profile),
          }
        : preset
    ));

    setSavedPresets(nextPresets);
    savePresetsToStorage(nextPresets);
  };

  const deleteCurrentPreset = () => {
    if (selectedPresetId === DEFAULT_PRESET_ID) {
      return;
    }

    const nextPresets = savedPresets.filter((preset) => preset.id !== selectedPresetId);
    setSavedPresets(nextPresets);
    savePresetsToStorage(nextPresets);
    setSelectedPresetId(DEFAULT_PRESET_ID);
  };

  return (
    <section className={`label-ocr-settings label-ocr-settings-expanded ${compact ? 'label-ocr-settings-compact' : ''}`}>
      {!compact && (
        <div className="label-ocr-settings-header">
          <div>
            <h4>{tx('Label OCR Rules', '标签 OCR 规则')}</h4>
            {showHelpText && (
              <p className="help-text label-ocr-help">
                {tx(
                  'Build field tags as removable chips, then save reusable OCR presets for different label layouts.',
                  '把识别字段做成可增删的 tag，并保存成适用于不同标签版式的 OCR 预设模板。',
                )}
              </p>
            )}
          </div>
        </div>
      )}

      <div className="label-ocr-settings-body">
        <div className="label-ocr-preset-section">
          <label className="label-ocr-section-label">{tx('Keyword preset', '关键词预设')}</label>
          <div className="label-ocr-preset-bar">
            <select
              className="sort-select"
              value={selectedPresetId}
              onChange={(event) => applyPreset(event.target.value)}
            >
              {presets.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="secondary-button"
              onClick={isCreatingPreset ? saveCurrentAsPreset : beginCreatePreset}
            >
              {isCreatingPreset ? tx('Save preset', '保存预设') : tx('New preset', '新增预设')}
            </button>
            {selectedPresetId !== DEFAULT_PRESET_ID && (
              <button type="button" className="secondary-button" onClick={deleteCurrentPreset}>
                {tx('Delete preset', '删除预设')}
              </button>
            )}
          </div>
          {isCreatingPreset && (
            <div className="label-ocr-preset-create-row">
              <input
                type="text"
                value={newPresetName}
                autoFocus
                onChange={(event) => setNewPresetName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    saveCurrentAsPreset();
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    cancelCreatePreset();
                  }
                }}
                placeholder={tx('Enter a preset name', '输入预设名称')}
              />
              <button type="button" className="secondary-button" onClick={cancelCreatePreset}>
                {tx('Cancel', '取消')}
              </button>
            </div>
          )}
          {!isCreatingPreset && !selectedPresetIsDefault && (
            <div className="label-ocr-preset-action-row">
              <button
                type="button"
                className="secondary-button"
                onClick={saveSelectedPreset}
                disabled={!selectedPresetDirty}
              >
                {tx('Save current preset', '保存当前预设')}
              </button>
            </div>
          )}
        </div>

        <div className="label-ocr-field-list">
          {LABEL_OCR_FIELD_META.map((field) => {
            const aliases = parseLabelOcrAliasDraft(profile.fields?.[field.key]);
            return (
              <div key={field.key} className="label-ocr-field-card">
                <label>{tx(field.label[0], field.label[1])}</label>
                <div className="label-ocr-add-row">
                  <input
                    type="text"
                    value={fieldDrafts[field.key] || ''}
                    onChange={(event) => setFieldDrafts((prev) => ({ ...prev, [field.key]: event.target.value }))}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        addAliasTag(field.key);
                      }
                    }}
                    placeholder={tx('Add a field tag and press Enter', '输入字段 tag 后按回车')}
                  />
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => addAliasTag(field.key)}
                  >
                    {tx('Add', '添加')}
                  </button>
                </div>
                <div className="label-ocr-tag-row">
                  {aliases.length > 0 ? aliases.map((alias) => (
                    <button
                      type="button"
                      key={alias}
                      className="label-ocr-tag"
                      onClick={() => removeAliasTag(field.key, alias)}
                      title={tx('Remove this alias', '删除这个别名')}
                    >
                      <span>{alias}</span>
                      <strong>×</strong>
                    </button>
                  )) : (
                    <span className="label-ocr-empty-tag">
                      {tx('No tags yet', '还没有 tag')}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="input-group">
          <label>{tx('Character whitelist', '关键词白名单')}</label>
          <textarea
            value={profile.whitelist}
            onChange={(event) => onChange({ ...profile, whitelist: event.target.value })}
            rows={3}
            className="label-ocr-textarea"
            spellCheck="false"
          />
        </div>

        <div className="label-ocr-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setSelectedPresetId(DEFAULT_PRESET_ID);
              onChange(resetLabelOcrProfileDraft());
            }}
          >
            {tx('Reset to defaults', '恢复默认')}
          </button>
        </div>
      </div>
    </section>
  );
}

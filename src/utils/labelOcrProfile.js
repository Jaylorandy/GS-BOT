import labelOcrDefaults from '../shared/labelOcrDefaults.json';

export const LABEL_OCR_FIELD_META = [
  { key: 'fabricCode', label: ['Fabric Code labels', '面料代码标签'] },
  { key: 'styleNumber', label: ['Style Number labels', '款号标签'] },
  { key: 'description', label: ['Description labels', '描述标签'] },
  { key: 'composition', label: ['Composition labels', '成分标签'] },
  { key: 'width', label: ['Width labels', '门幅标签'] },
  { key: 'cuttable', label: ['Cuttable labels', '可裁幅标签'] },
  { key: 'weight', label: ['Weight labels', '克重标签'] },
];

function uniq(items = []) {
  return [...new Set(items.map((item) => String(item || '').trim()).filter(Boolean))];
}

export function parseLabelOcrAliasDraft(value, fallback = []) {
  if (Array.isArray(value)) {
    const parsed = uniq(value);
    return parsed.length > 0 ? parsed : uniq(fallback);
  }

  if (typeof value === 'string') {
    const parsed = uniq(value.split(/[\n,]+/));
    return parsed.length > 0 ? parsed : uniq(fallback);
  }

  return uniq(fallback);
}

function normalizeAliasDraft(value, fallback = []) {
  return parseLabelOcrAliasDraft(value, fallback).join(', ');
}

export function createLabelOcrProfileDraft(overrides = {}) {
  const profile = {
    whitelist: typeof overrides?.whitelist === 'string' && overrides.whitelist.trim()
      ? overrides.whitelist
      : labelOcrDefaults.whitelist,
    fields: {},
  };

  Object.entries(labelOcrDefaults.fields || {}).forEach(([fieldKey, aliases]) => {
    profile.fields[fieldKey] = normalizeAliasDraft(overrides?.fields?.[fieldKey], aliases);
  });

  return profile;
}

export function resetLabelOcrProfileDraft() {
  return createLabelOcrProfileDraft();
}

export function normalizeLabelOcrProfileDraft(profile = {}) {
  return createLabelOcrProfileDraft(profile);
}

export function updateLabelOcrFieldDraft(profile = {}, fieldKey, aliases = []) {
  return {
    ...createLabelOcrProfileDraft(profile),
    fields: {
      ...createLabelOcrProfileDraft(profile).fields,
      [fieldKey]: parseLabelOcrAliasDraft(aliases).join(', '),
    },
  };
}

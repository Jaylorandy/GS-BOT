const labelOcrDefaults = require('./src/shared/labelOcrDefaults.json');

const LABEL_OCR_FIELD_KEYS = Object.keys(labelOcrDefaults.fields || {});

function normalizeAliasList(value, fallback = []) {
  if (Array.isArray(value)) {
    const parsed = [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
    return parsed.length > 0 ? parsed : [...fallback];
  }

  if (typeof value === 'string') {
    const parsed = [...new Set(
      value
        .split(/[\n,]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    )];
    return parsed.length > 0 ? parsed : [...fallback];
  }

  return [...fallback];
}

function normalizeLabelOcrProfile(profile = {}) {
  const normalizedFields = {};

  LABEL_OCR_FIELD_KEYS.forEach((fieldKey) => {
    normalizedFields[fieldKey] = normalizeAliasList(
      profile?.fields?.[fieldKey],
      labelOcrDefaults.fields[fieldKey] || [],
    );
  });

  const whitelist = typeof profile?.whitelist === 'string' && profile.whitelist.trim()
    ? profile.whitelist
    : labelOcrDefaults.whitelist;

  return {
    whitelist,
    fields: normalizedFields,
  };
}

function serializeLabelOcrProfile(profile = {}) {
  const normalized = normalizeLabelOcrProfile(profile);

  const serializedFields = {};
  LABEL_OCR_FIELD_KEYS.forEach((fieldKey) => {
    serializedFields[fieldKey] = normalized.fields[fieldKey].join(', ');
  });

  return {
    whitelist: normalized.whitelist,
    fields: serializedFields,
  };
}

module.exports = {
  LABEL_OCR_DEFAULTS: labelOcrDefaults,
  LABEL_OCR_FIELD_KEYS,
  normalizeLabelOcrProfile,
  serializeLabelOcrProfile,
};

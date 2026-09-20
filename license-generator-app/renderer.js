const state = {
  appState: null,
  generated: null,
  history: [],
  featurePresets: {},
};

const FEATURE_LABELS = {
  license: 'License',
  'image-organizer': 'Image Organizer',
  'ppt-fabric': 'Fabric PPT',
  'ppt-style': 'Style PPT',
  'garment-cleaner': 'Garment Cleaner',
  'pdf-tools': 'PDF Tools',
};

const PRESET_LABELS = {
  basic: 'Basic',
  organizer: 'Organizer',
  ppt: 'PPT',
  full: 'Full',
};

const elements = {
  keyStatusBadge: document.getElementById('keyStatusBadge'),
  keyStatusMessage: document.getElementById('keyStatusMessage'),
  keyPath: document.getElementById('keyPath'),
  logPath: document.getElementById('logPath'),
  customerNameInput: document.getElementById('customerNameInput'),
  emailInput: document.getElementById('emailInput'),
  licenseModeSelect: document.getElementById('licenseModeSelect'),
  daysInput: document.getElementById('daysInput'),
  noteInput: document.getElementById('noteInput'),
  featureChips: document.getElementById('featureChips'),
  summaryCustomer: document.getElementById('summaryCustomer'),
  summaryMode: document.getElementById('summaryMode'),
  summaryBinding: document.getElementById('summaryBinding'),
  summaryExpiry: document.getElementById('summaryExpiry'),
  summaryFeatures: document.getElementById('summaryFeatures'),
  formFeedback: document.getElementById('formFeedback'),
  licenseOutput: document.getElementById('licenseOutput'),
  resultCustomer: document.getElementById('resultCustomer'),
  resultExpiry: document.getElementById('resultExpiry'),
  resultDuration: document.getElementById('resultDuration'),
  resultKeySource: document.getElementById('resultKeySource'),
  resultMode: document.getElementById('resultMode'),
  resultVerified: document.getElementById('resultVerified'),
  generatorRuntime: document.getElementById('generatorRuntime'),
  copyButton: document.getElementById('copyButton'),
  saveTxtButton: document.getElementById('saveTxtButton'),
  saveJsonButton: document.getElementById('saveJsonButton'),
  selectKeyButton: document.getElementById('selectKeyButton'),
  generateButton: document.getElementById('generateButton'),
  historyEmpty: document.getElementById('historyEmpty'),
  historyList: document.getElementById('historyList'),
};

function setBadge(element, tone, text) {
  element.className = `pill ${tone}`;
  element.textContent = text;
}

function setFeedback(message, tone = 'neutral') {
  elements.formFeedback.className = `feedback ${tone}`;
  elements.formFeedback.textContent = message || '';
}

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatFeatureName(value) {
  return FEATURE_LABELS[value] || value;
}

function formatPresetName(value) {
  return PRESET_LABELS[value] || value;
}

function getSelectedFeatures() {
  return state.featurePresets.full || [];
}

function computeExpiry(days) {
  const numericDays = Number(days || 0);
  if (!Number.isFinite(numericDays) || numericDays <= 0) {
    return '-';
  }
  const expires = new Date(Date.now() + numericDays * 24 * 60 * 60 * 1000);
  return formatDate(expires.toISOString());
}

function renderFeatureChips() {
  const features = getSelectedFeatures();
  elements.featureChips.innerHTML = features
    .map((feature) => `<span class="feature-chip">${formatFeatureName(feature)}</span>`)
    .join('');
}

function updateSummary() {
  const customer = elements.customerNameInput.value.trim();
  const days = Number(elements.daysInput.value || state.appState?.defaultDays || 365);
  const mode = elements.licenseModeSelect.value === 'test' ? 'Test license' : 'Formal license';
  const features = getSelectedFeatures();

  elements.summaryCustomer.textContent = customer || '-';
  elements.summaryMode.textContent = mode;
  elements.summaryBinding.textContent = 'General';
  elements.summaryExpiry.textContent = computeExpiry(days);
  elements.summaryFeatures.textContent = features.map(formatFeatureName).join(', ') || '-';
  renderFeatureChips();
}

function renderState(appState) {
  state.appState = appState;
  state.featurePresets = appState.featurePresets || {};
  state.history = Array.isArray(appState.history) ? appState.history : [];

  elements.daysInput.value = String(appState.defaultDays || 365);
  elements.generatorRuntime.textContent = `${appState.hostname || 'This machine'} · ${appState.platform || ''}`;
  elements.logPath.textContent = appState.logPath || '-';

  const keyStatus = appState.keyStatus || {};
  if (keyStatus.found && keyStatus.source === 'custom') {
    setBadge(elements.keyStatusBadge, 'success', 'Formal key ready');
  } else if (keyStatus.found) {
    setBadge(elements.keyStatusBadge, 'warning', 'Using bundled key');
  } else {
    setBadge(elements.keyStatusBadge, 'danger', 'Missing private key');
  }

  elements.keyStatusMessage.textContent = keyStatus.message || 'No signing key detected.';
  elements.keyPath.textContent = keyStatus.privateKeyPath || '';
  updateSummary();
  renderHistory(state.history);
}

function renderGenerated(generated, verified = false) {
  state.generated = generated;
  elements.licenseOutput.value = generated?.licenseKey || '';
  elements.resultCustomer.textContent = generated?.customerName || '-';
  elements.resultExpiry.textContent = formatDate(generated?.expiresAt);
  elements.resultDuration.textContent = generated?.days ? `${generated.days} days` : '-';
  elements.resultKeySource.textContent = generated?.privateKeyPath || 'Bundled default key';
  elements.resultMode.textContent = generated?.licenseMode === 'test' ? 'Test' : (generated ? 'Formal' : '-');
  elements.resultVerified.textContent = generated ? (verified ? 'Verified' : 'Pending') : '-';

  const hasOutput = Boolean(generated?.licenseKey);
  elements.copyButton.disabled = !hasOutput;
  elements.saveTxtButton.disabled = !hasOutput;
  elements.saveJsonButton.disabled = !hasOutput;
}

function buildPayloadFromForm() {
  return {
    customerName: elements.customerNameInput.value.trim(),
    email: elements.emailInput.value.trim(),
    days: Number(elements.daysInput.value || state.appState?.defaultDays || 365),
    note: elements.noteInput.value.trim(),
    licenseMode: elements.licenseModeSelect.value || 'formal',
    featurePreset: 'full',
    features: getSelectedFeatures(),
  };
}

function validatePayload(payload) {
  if (!payload.customerName) {
    return 'Customer name is required.';
  }
  if (!Number.isFinite(payload.days) || payload.days <= 0) {
    return 'Duration must be a positive number of days.';
  }
  return '';
}

function getSummaryText(payload) {
  const mode = payload.licenseMode === 'test' ? 'Test license' : 'Formal license';
  const features = (payload.features || []).map(formatFeatureName).join(', ') || 'None';
  return `Customer: ${payload.customerName}\nMode: ${mode}\nScope: General\nDuration: ${payload.days} days\nFeatures: ${features}\n\nProceed to sign this license?`;
}

function renderHistory(history) {
  const entries = Array.isArray(history) ? history : [];
  elements.historyEmpty.hidden = entries.length > 0;
  elements.historyList.innerHTML = entries.map((entry) => {
    const revokedClass = entry.revoked ? ' history-entry revoked' : ' history-entry';
    const modeLabel = entry.licenseMode === 'test' ? 'Test' : 'Formal';
    const bindingLabel = 'General';
    const features = (entry.features || []).map(formatFeatureName).join(', ');
    return `
      <article class="${revokedClass}" data-entry-id="${entry.id}">
        <div class="history-row">
          <div>
            <strong>${entry.customerName || '-'}</strong>
            <div class="history-meta">${formatDate(entry.createdAt)} · ${modeLabel} · ${bindingLabel}</div>
          </div>
          <div class="inline-actions">
            <button class="ghost-button history-copy" type="button" data-license-key="${encodeURIComponent(entry.licenseKey || '')}">Copy</button>
            <button class="ghost-button history-refill" type="button" data-entry-id="${entry.id}">Reuse</button>
            <button class="ghost-button history-revoke" type="button" data-entry-id="${entry.id}" ${entry.revoked ? 'disabled' : ''}>${entry.revoked ? 'Revoked' : 'Revoke'}</button>
          </div>
        </div>
        <div class="history-meta">Expires: ${formatDate(entry.expiresAt)} · Package: ${formatPresetName(entry.featurePreset || 'full')}</div>
        <div class="history-meta">Features: ${features || '-'}</div>
        ${entry.note ? `<div class="history-note">${entry.note}</div>` : ''}
      </article>
    `;
  }).join('');
}

function refillFromHistory(entryId) {
  const entry = state.history.find((item) => item.id === entryId);
  if (!entry?.snapshot) {
    return;
  }
  elements.customerNameInput.value = entry.snapshot.customerName || '';
  elements.emailInput.value = entry.snapshot.email || '';
  elements.daysInput.value = String(entry.snapshot.days || state.appState?.defaultDays || 365);
  elements.noteInput.value = entry.snapshot.note || '';
  elements.licenseModeSelect.value = entry.snapshot.licenseMode || 'formal';
  updateSummary();
  setFeedback('Loaded the saved license settings into the form.', 'success');
}

async function refreshState() {
  const appState = await window.generatorAPI.getState();
  renderState(appState);
}

async function handleSelectKey() {
  const result = await window.generatorAPI.selectPrivateKey();
  if (result?.keyStatus) {
    renderState({
      ...state.appState,
      keyStatus: result.keyStatus,
      history: state.history,
      featurePresets: state.featurePresets,
      logPath: state.appState?.logPath || '',
    });
  }
  if (result?.success) {
    setFeedback('Private key updated.', 'success');
  }
}

async function handleGenerate() {
  setFeedback('');
  const payload = buildPayloadFromForm();
  const validationError = validatePayload(payload);
  if (validationError) {
    setFeedback(validationError, 'error');
    return;
  }

  const confirmed = window.confirm(getSummaryText(payload));
  if (!confirmed) {
    setFeedback('License generation cancelled before signing.', 'neutral');
    return;
  }

  const result = await window.generatorAPI.generateLicense(payload);
  if (!result?.success) {
    if (result?.keyStatus) {
      renderState({
        ...state.appState,
        keyStatus: result.keyStatus,
        history: state.history,
        featurePresets: state.featurePresets,
        logPath: state.appState?.logPath || '',
      });
    }
    setFeedback(result?.error || 'Could not generate the license.', 'error');
    renderGenerated(null, false);
    return;
  }

  if (result?.keyStatus || result?.history) {
    renderState({
      ...state.appState,
      keyStatus: result.keyStatus || state.appState?.keyStatus,
      history: result.history || state.history,
      featurePresets: state.featurePresets,
      logPath: state.appState?.logPath || '',
    });
  }

  renderGenerated(result.generated, Boolean(result.verified));
  setFeedback('License generated and verified successfully.', 'success');
}

async function handleCopy() {
  if (!state.generated?.licenseKey) return;
  await navigator.clipboard.writeText(state.generated.licenseKey);
  setFeedback('License key copied.', 'success');
}

async function handleSave(asJson) {
  if (!state.generated?.licenseKey) return;
  const customerSlug = (state.generated.customerName || 'license')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  const defaultPath = asJson ? `${customerSlug || 'license'}.json` : `${customerSlug || 'license'}.txt`;

  const result = await window.generatorAPI.saveLicense({
    defaultPath,
    licenseKey: state.generated.licenseKey,
    content: state.generated,
  });

  if (result?.success) {
    setFeedback(`Saved to ${result.filePath}`, 'success');
  }
}

async function handleHistoryClick(event) {
  const copyButton = event.target.closest('.history-copy');
  if (copyButton) {
    const encoded = copyButton.getAttribute('data-license-key') || '';
    const licenseKey = decodeURIComponent(encoded);
    if (licenseKey) {
      await navigator.clipboard.writeText(licenseKey);
      setFeedback('Historical license copied.', 'success');
    }
    return;
  }

  const refillButton = event.target.closest('.history-refill');
  if (refillButton) {
    refillFromHistory(refillButton.getAttribute('data-entry-id') || '');
    return;
  }

  const revokeButton = event.target.closest('.history-revoke');
  if (revokeButton) {
    const entryId = revokeButton.getAttribute('data-entry-id') || '';
    if (!entryId) {
      return;
    }
    const confirmed = window.confirm('Mark this license record as revoked?');
    if (!confirmed) {
      return;
    }
    const result = await window.generatorAPI.revokeLicense({ id: entryId });
    if (result?.success) {
      state.history = result.history || [];
      renderHistory(state.history);
      setFeedback('License record marked as revoked.', 'success');
    } else {
      setFeedback(result?.error || 'Could not revoke the selected license record.', 'error');
    }
  }
}

function bindEvents() {
  elements.selectKeyButton.addEventListener('click', handleSelectKey);
  elements.generateButton.addEventListener('click', handleGenerate);
  elements.copyButton.addEventListener('click', handleCopy);
  elements.saveTxtButton.addEventListener('click', () => handleSave(false));
  elements.saveJsonButton.addEventListener('click', () => handleSave(true));
  elements.licenseModeSelect.addEventListener('change', updateSummary);
  elements.customerNameInput.addEventListener('input', updateSummary);
  elements.emailInput.addEventListener('input', updateSummary);
  elements.daysInput.addEventListener('input', updateSummary);
  elements.noteInput.addEventListener('input', updateSummary);
  elements.historyList.addEventListener('click', handleHistoryClick);
}

async function init() {
  bindEvents();
  await refreshState();
  renderGenerated(null, false);
}

init();

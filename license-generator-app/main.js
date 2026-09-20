const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const {
  DEFAULT_DAYS,
  FEATURE_PRESETS,
  generateLicense,
  loadPrivateKey,
  verifyLicenseKey,
  normalizeFeatureList,
  normalizeFeaturePreset,
  normalizeLicenseMode,
} = require('../license-generator-core');

let generatorWindow = null;

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'generator-settings.json');
}

function getLogPath() {
  return path.join(app.getPath('userData'), 'license-log.json');
}

function loadSettings() {
  try {
    if (!fs.existsSync(getSettingsPath())) {
      return {};
    }
    return JSON.parse(fs.readFileSync(getSettingsPath(), 'utf8'));
  } catch {
    return {};
  }
}

function saveSettings(nextSettings) {
  fs.mkdirSync(path.dirname(getSettingsPath()), { recursive: true });
  fs.writeFileSync(getSettingsPath(), JSON.stringify(nextSettings, null, 2), 'utf8');
}

function loadLog() {
  try {
    if (!fs.existsSync(getLogPath())) {
      return [];
    }
    const parsed = JSON.parse(fs.readFileSync(getLogPath(), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveLog(entries) {
  fs.mkdirSync(path.dirname(getLogPath()), { recursive: true });
  fs.writeFileSync(getLogPath(), JSON.stringify(entries, null, 2), 'utf8');
}

function summarizeKeyStatus(status) {
  const source = status.privateKeyPath ? 'custom' : 'bundled';
  return {
    ...status,
    source,
    severity: status.found ? (source === 'custom' ? 'success' : 'warning') : 'danger',
  };
}

function getKeyStatus() {
  const settings = loadSettings();
  try {
    const loaded = loadPrivateKey(settings.privateKeyPath || '');
    return summarizeKeyStatus({
      found: true,
      privateKeyPath: loaded.privateKeyPath || settings.privateKeyPath || '',
      message: loaded.privateKeyPath
        ? `Using signing key: ${loaded.privateKeyPath}`
        : 'Using the default signing key.',
    });
  } catch (error) {
    return summarizeKeyStatus({
      found: false,
      privateKeyPath: settings.privateKeyPath || '',
      message: error.message,
    });
  }
}

function buildHistoryEntry(generated, payload, keyStatus) {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    customerName: generated.customerName,
    email: generated.email || '',
    note: generated.note || '',
    days: generated.days,
    expiresAt: generated.expiresAt,
    issuedAt: generated.issuedAt,
    installationId: '',
    bindingMode: 'general',
    licenseMode: generated.licenseMode || 'formal',
    featurePreset: generated.featurePreset || 'full',
    features: Array.isArray(generated.features) ? generated.features : [],
    keySource: keyStatus.source || 'bundled',
    privateKeyPath: generated.privateKeyPath || '',
    licenseKey: generated.licenseKey,
    revoked: false,
    revokedAt: '',
    snapshot: {
      customerName: payload.customerName || '',
      email: payload.email || '',
      note: payload.note || '',
      days: payload.days || DEFAULT_DAYS,
      installationId: '',
      licenseMode: payload.licenseMode || 'formal',
      featurePreset: 'full',
      features: FEATURE_PRESETS.full,
    },
  };
}

function createWindow() {
  generatorWindow = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 920,
    minHeight: 700,
    title: 'GS Bot License Generator',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  generatorWindow.loadFile(path.join(__dirname, 'index.html'));

  generatorWindow.on('closed', () => {
    generatorWindow = null;
  });
}

ipcMain.handle('generator:get-state', async () => {
  return {
    keyStatus: getKeyStatus(),
    defaultDays: DEFAULT_DAYS,
    featurePresets: FEATURE_PRESETS,
    history: loadLog(),
    platform: process.platform,
    hostname: os.hostname(),
    logPath: getLogPath(),
  };
});

ipcMain.handle('generator:get-history', async () => {
  return {
    success: true,
    history: loadLog(),
    logPath: getLogPath(),
  };
});

ipcMain.handle('generator:select-private-key', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [
      { name: 'PEM Key', extensions: ['pem'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });

  if (result.canceled || !result.filePaths?.[0]) {
    return {
      success: false,
      cancelled: true,
      keyStatus: getKeyStatus(),
    };
  }

  const nextPath = result.filePaths[0];
  const settings = loadSettings();
  saveSettings({
    ...settings,
    privateKeyPath: nextPath,
  });

  return {
    success: true,
    keyStatus: getKeyStatus(),
  };
});

ipcMain.handle('generator:generate-license', async (_event, payload = {}) => {
  try {
    const settings = loadSettings();
    const normalizedPayload = {
      customerName: String(payload.customerName || '').trim(),
      email: String(payload.email || '').trim(),
      note: String(payload.note || '').trim(),
      days: Number(payload.days || DEFAULT_DAYS),
      licenseMode: normalizeLicenseMode(payload.licenseMode),
    };
    const generated = generateLicense({
      ...normalizedPayload,
      privateKeyPath: settings.privateKeyPath || '',
    });
    verifyLicenseKey(generated.licenseKey);
    const keyStatus = getKeyStatus();
    const nextHistory = [
      buildHistoryEntry(generated, normalizedPayload, keyStatus),
      ...loadLog(),
    ];
    saveLog(nextHistory);

    return {
      success: true,
      generated,
      verified: true,
      keyStatus,
      history: nextHistory,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      keyStatus: getKeyStatus(),
    };
  }
});

ipcMain.handle('generator:revoke-license', async (_event, payload = {}) => {
  try {
    const targetId = String(payload.id || '').trim();
    if (!targetId) {
      throw new Error('Missing record id.');
    }

    const nextHistory = loadLog().map((entry) => {
      if (entry.id !== targetId) {
        return entry;
      }
      return {
        ...entry,
        revoked: true,
        revokedAt: new Date().toISOString(),
      };
    });
    saveLog(nextHistory);
    return {
      success: true,
      history: nextHistory,
    };
  } catch (error) {
    return {
      success: false,
      error: error.message || String(error),
      history: loadLog(),
    };
  }
});

ipcMain.handle('generator:save-license', async (_event, payload = {}) => {
  const result = await dialog.showSaveDialog({
    defaultPath: payload.defaultPath || 'gs-bot-license.txt',
    filters: [
      { name: 'Text File', extensions: ['txt'] },
      { name: 'JSON File', extensions: ['json'] },
    ],
  });

  if (result.canceled || !result.filePath) {
    return { success: false, cancelled: true };
  }

  const filePath = result.filePath;
  if (filePath.toLowerCase().endsWith('.json')) {
    fs.writeFileSync(filePath, JSON.stringify(payload.content, null, 2), 'utf8');
  } else {
    fs.writeFileSync(filePath, String(payload.licenseKey || ''), 'utf8');
  }

  return { success: true, filePath };
});

ipcMain.handle('generator:open-external', async (_event, target) => {
  try {
    await shell.openExternal(target);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

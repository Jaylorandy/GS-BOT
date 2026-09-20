const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PRODUCT_NAME = 'GS Bot';
const LICENSE_PREFIX = 'GSBOT1';
const LICENSE_VERSION = 1;
const DEFAULT_DAYS = 365;
const FULL_FEATURE_SET = ['license', 'image-organizer', 'ppt-fabric', 'ppt-style', 'pdf-tools'];
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtbP3tEMqoCcOvst6QS8h
q384+ku9hV9PFpGipX+yUHzasqmEJKMb6ZmEJGA5x0Ps6YoJjmJXjkqTzF5Gw+C6
HjBk9pOK24sPOeprorWrfdsrbXt2rpeaZ+S3q2kCUYZHkzWV0RrOx5+Jrfx9LfOM
iiX6EwO/bdkq2qRbaZ51PQrDiVM8So2dD7kGHMe1pKv63mRkGfTZbih0Fdmd+S28
TJ0BPAxW9/OPa4ZPUe3Ve2GQNpi3faa2YIIcM0LT4nbJn5BVzQexDqyuoepML/8y
aELGIG4GBBDjN0LS4Z6OXx0a1wrPSFCKqrDizuhu0pUI1SnuH/j+TotBAdeXLkiw
lwIDAQAB
-----END PUBLIC KEY-----`;

const FEATURE_PRESETS = {
  full: FULL_FEATURE_SET,
};

function base64UrlEncode(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(input) {
  const normalized = String(input || '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
  return Buffer.from(padded, 'base64');
}

function getIsoAfterDays(days) {
  const now = new Date();
  const expires = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  return {
    issuedAt: now.toISOString(),
    expiresAt: expires.toISOString(),
  };
}

function getGsBotUserDataDir() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'GS Bot');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'GS Bot');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'GS Bot');
}

function getInstallationFilePath() {
  return path.join(getGsBotUserDataDir(), 'license', 'installation.json');
}

function detectLocalInstallationId() {
  const filePath = getInstallationFilePath();
  if (!fs.existsSync(filePath)) {
    return {
      found: false,
      installationId: '',
      filePath,
      message: 'Device binding is disabled for this generator.',
    };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      found: Boolean(parsed?.installationId),
      installationId: parsed?.installationId || '',
      filePath,
      message: 'Device binding is disabled for this generator.',
    };
  } catch (error) {
    return {
      found: false,
      installationId: '',
      filePath,
      message: `Device binding is disabled for this generator: ${error.message}`,
    };
  }
}

function resolvePrivateKeyCandidates(baseDir = process.cwd()) {
  const execDir = path.dirname(process.execPath || '');
  return [
    path.join(baseDir, 'license-keys', 'private.pem'),
    path.join(__dirname, 'license-keys', 'private.pem'),
    path.join(execDir, 'private.pem'),
    path.join(execDir, 'license-keys', 'private.pem'),
    path.join(process.resourcesPath || '', 'private.pem'),
    path.join(process.resourcesPath || '', 'license-keys', 'private.pem'),
  ].filter(Boolean);
}

function loadPrivateKey(privateKeyPath = '') {
  const candidates = privateKeyPath
    ? [privateKeyPath]
    : resolvePrivateKeyCandidates();

  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        return {
          privateKeyPem: fs.readFileSync(candidate, 'utf8'),
          privateKeyPath: candidate,
        };
      }
    } catch {
      // Ignore unreadable candidate and continue.
    }
  }

  throw new Error('No private key was found. Choose a private.pem signing key first.');
}

function normalizeLicenseMode(value = '') {
  return String(value || '').trim().toLowerCase() === 'test' ? 'test' : 'formal';
}

function normalizeFeaturePreset() {
  return 'full';
}

function normalizeFeatureList() {
  return [...FULL_FEATURE_SET];
}

function splitLicenseKey(licenseKey = '') {
  const trimmed = String(licenseKey || '').trim();
  const parts = trimmed.split('.');
  if (parts.length !== 3 || parts[0] !== LICENSE_PREFIX) {
    throw new Error('The license code format is invalid.');
  }
  return {
    payloadEncoded: parts[1],
    signatureEncoded: parts[2],
  };
}

function verifyLicenseSignature(payloadEncoded, signatureEncoded) {
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(payloadEncoded);
  verifier.end();
  return verifier.verify(PUBLIC_KEY_PEM, base64UrlDecode(signatureEncoded));
}

function verifyLicenseKey(licenseKey = '') {
  const { payloadEncoded, signatureEncoded } = splitLicenseKey(licenseKey);
  if (!verifyLicenseSignature(payloadEncoded, signatureEncoded)) {
    throw new Error('The generated license signature could not be verified.');
  }

  const payload = JSON.parse(base64UrlDecode(payloadEncoded).toString('utf8'));
  return payload;
}

function generateLicense({
  customerName,
  email = '',
  note = '',
  days = DEFAULT_DAYS,
  privateKeyPath = '',
  privateKeyPem = '',
  licenseMode = 'formal',
}) {
  const trimmedCustomer = String(customerName || '').trim();
  if (!trimmedCustomer) {
    throw new Error('Customer name is required.');
  }

  const durationDays = Number(days || DEFAULT_DAYS);
  if (!Number.isFinite(durationDays) || durationDays <= 0) {
    throw new Error('Duration must be a positive number of days.');
  }

  const signingMaterial = privateKeyPem
    ? { privateKeyPem, privateKeyPath: privateKeyPath || '' }
    : loadPrivateKey(privateKeyPath);

  const { issuedAt, expiresAt } = getIsoAfterDays(durationDays);
  const payload = {
    product: PRODUCT_NAME,
    version: LICENSE_VERSION,
    customerName: trimmedCustomer,
    email: String(email || '').trim(),
    note: String(note || '').trim(),
    installationId: '',
    licenseMode: normalizeLicenseMode(licenseMode),
    featurePreset: 'full',
    features: [...FULL_FEATURE_SET],
    issuedAt,
    expiresAt,
  };

  const payloadEncoded = base64UrlEncode(JSON.stringify(payload));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(payloadEncoded);
  signer.end();

  const signatureEncoded = signer
    .sign(signingMaterial.privateKeyPem)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');

  return {
    customerName: payload.customerName,
    email: payload.email,
    note: payload.note,
    installationId: '',
    licenseMode: payload.licenseMode,
    featurePreset: 'full',
    features: [...FULL_FEATURE_SET],
    issuedAt,
    expiresAt,
    days: durationDays,
    licenseKey: `${LICENSE_PREFIX}.${payloadEncoded}.${signatureEncoded}`,
    privateKeyPath: signingMaterial.privateKeyPath || privateKeyPath || '',
  };
}

module.exports = {
  PRODUCT_NAME,
  LICENSE_PREFIX,
  LICENSE_VERSION,
  DEFAULT_DAYS,
  FEATURE_PRESETS,
  FULL_FEATURE_SET,
  detectLocalInstallationId,
  loadPrivateKey,
  generateLicense,
  verifyLicenseKey,
  normalizeLicenseMode,
  normalizeFeaturePreset,
  normalizeFeatureList,
};

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LICENSE_PREFIX = 'GSBOT1';
const LICENSE_VERSION = 1;
const PRODUCT_NAME = 'GS Bot';
const DEFAULT_DURATION_DAYS = 365;
const PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAtbP3tEMqoCcOvst6QS8h
q384+ku9hV9PFpGipX+yUHzasqmEJKMb6ZmEJGA5x0Ps6YoJjmJXjkqTzF5Gw+C6
HjBk9pOK24sPOeprorWrfdsrbXt2rpeaZ+S3q2kCUYZHkzWV0RrOx5+Jrfx9LfOM
iiX6EwO/bdkq2qRbaZ51PQrDiVM8So2dD7kGHMe1pKv63mRkGfTZbih0Fdmd+S28
TJ0BPAxW9/OPa4ZPUe3Ve2GQNpi3faa2YIIcM0LT4nbJn5BVzQexDqyuoepML/8y
aELGIG4GBBDjN0LS4Z6OXx0a1wrPSFCKqrDizuhu0pUI1SnuH/j+TotBAdeXLkiw
lwIDAQAB
-----END PUBLIC KEY-----`;

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function getLicenseDir() {
  return ensureDir(path.join(app.getPath('userData'), 'license'));
}

function getLicenseFilePath() {
  return path.join(getLicenseDir(), 'license.json');
}

function getInstallFilePath() {
  return path.join(getLicenseDir(), 'installation.json');
}

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

function readJsonSafe(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function getInstallationId() {
  const installPath = getInstallFilePath();
  const existing = readJsonSafe(installPath, null);
  if (existing?.installationId) {
    return existing.installationId;
  }

  const installationId = crypto.randomUUID();
  writeJson(installPath, {
    installationId,
    createdAt: new Date().toISOString(),
  });
  return installationId;
}

function loadStoredLicense() {
  return readJsonSafe(getLicenseFilePath(), null);
}

function clearStoredLicense() {
  const licenseFile = getLicenseFilePath();
  if (fs.existsSync(licenseFile)) {
    fs.unlinkSync(licenseFile);
  }
}

function splitLicenseKey(licenseKey) {
  const trimmed = String(licenseKey || '').trim();
  const parts = trimmed.split('.');
  if (parts.length !== 3 || parts[0] !== LICENSE_PREFIX) {
    throw new Error('The license code format is invalid.');
  }
  return {
    prefix: parts[0],
    payloadEncoded: parts[1],
    signatureEncoded: parts[2],
  };
}

function parsePayload(payloadEncoded) {
  const json = base64UrlDecode(payloadEncoded).toString('utf8');
  return JSON.parse(json);
}

function verifySignature(payloadEncoded, signatureEncoded) {
  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(payloadEncoded);
  verifier.end();
  return verifier.verify(PUBLIC_KEY_PEM, base64UrlDecode(signatureEncoded));
}

function normalizeCustomerName(payload) {
  return payload.customerName || payload.customer || payload.company || '';
}

function getDaysRemaining(expiresAt) {
  const diff = new Date(expiresAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
}

function buildStatus(valid, reason, extra = {}) {
  const installationId = getInstallationId();
  return {
    valid,
    reason,
    installationId,
    productName: PRODUCT_NAME,
    defaultDurationDays: DEFAULT_DURATION_DAYS,
    ...extra,
  };
}

function validateLicenseKey(licenseKey, options = {}) {
  const installationId = options.installationId || getInstallationId();
  const now = options.now ? new Date(options.now) : new Date();

  let payload;
  let payloadEncoded;
  let signatureEncoded;

  try {
    ({ payloadEncoded, signatureEncoded } = splitLicenseKey(licenseKey));
    payload = parsePayload(payloadEncoded);
  } catch (error) {
    return buildStatus(false, 'invalid-format', {
      message: error.message || 'The license code could not be read.',
    });
  }

  if (!verifySignature(payloadEncoded, signatureEncoded)) {
    return buildStatus(false, 'invalid-signature', {
      message: 'The license signature is invalid.',
    });
  }

  if (payload.product !== PRODUCT_NAME || payload.version !== LICENSE_VERSION) {
    return buildStatus(false, 'invalid-product', {
      message: 'This license is not valid for this product.',
    });
  }

  if (!payload.expiresAt || Number.isNaN(new Date(payload.expiresAt).getTime())) {
    return buildStatus(false, 'invalid-expiry', {
      message: 'The license expiry date is invalid.',
    });
  }

  if (payload.installationId && payload.installationId !== installationId) {
    return buildStatus(false, 'device-mismatch', {
      message: 'This license is bound to a different device.',
      license: {
        customerName: normalizeCustomerName(payload),
        issuedAt: payload.issuedAt || null,
        expiresAt: payload.expiresAt,
      },
    });
  }

  const expiresAt = new Date(payload.expiresAt);
  if (expiresAt.getTime() < now.getTime()) {
    return buildStatus(false, 'expired', {
      message: 'This license has expired.',
      license: {
        customerName: normalizeCustomerName(payload),
        email: payload.email || '',
        issuedAt: payload.issuedAt || null,
        expiresAt: payload.expiresAt,
        note: payload.note || '',
        installationId: payload.installationId || '',
      },
      daysRemaining: 0,
    });
  }

  return buildStatus(true, 'valid', {
    message: 'License verified.',
    license: {
      customerName: normalizeCustomerName(payload),
      email: payload.email || '',
      issuedAt: payload.issuedAt || null,
      expiresAt: payload.expiresAt,
      note: payload.note || '',
      installationId: payload.installationId || '',
    },
    daysRemaining: getDaysRemaining(payload.expiresAt),
  });
}

function activateLicense(licenseKey) {
  const status = validateLicenseKey(licenseKey);
  if (!status.valid) {
    return status;
  }

  writeJson(getLicenseFilePath(), {
    licenseKey: String(licenseKey || '').trim(),
    activatedAt: new Date().toISOString(),
  });

  return {
    ...status,
    message: 'License activated successfully.',
  };
}

function getLicenseStatus() {
  const stored = loadStoredLicense();
  if (!stored?.licenseKey) {
    return buildStatus(false, 'missing', {
      message: 'No license has been activated yet.',
    });
  }

  return validateLicenseKey(stored.licenseKey);
}

function assertLicensed() {
  const status = getLicenseStatus();
  if (status.valid) {
    return status;
  }

  const error = new Error(status.message || 'A valid license is required.');
  error.code = 'LICENSE_REQUIRED';
  error.licenseStatus = status;
  throw error;
}

module.exports = {
  PRODUCT_NAME,
  LICENSE_PREFIX,
  LICENSE_VERSION,
  DEFAULT_DURATION_DAYS,
  getInstallationId,
  getLicenseStatus,
  activateLicense,
  validateLicenseKey,
  clearStoredLicense,
  assertLicensed,
};

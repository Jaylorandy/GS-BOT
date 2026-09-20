const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const https = require('https');

const CONFIG_FILE = path.join(app.getPath('userData'), 'paddleocr-config.json');

const DEFAULT_CONFIG = {
  token: '',
  options: {
    useDocOrientationClassify: false,
    useDocUnwarping: false,
    useChartRecognition: false,
  },
};

let cachedConfig = null;

function loadConfig() {
  if (cachedConfig) {
    return cachedConfig;
  }

  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf-8');
      cachedConfig = JSON.parse(data);
    } else {
      cachedConfig = { ...DEFAULT_CONFIG };
    }
  } catch (error) {
    console.error('Failed to load PaddleOCR config:', error);
    cachedConfig = { ...DEFAULT_CONFIG };
  }

  return cachedConfig;
}

function saveConfig(token, options = {}) {
  try {
    const config = {
      token: String(token || '').trim(),
      options: {
        useDocOrientationClassify: Boolean(options.useDocOrientationClassify),
        useDocUnwarping: Boolean(options.useDocUnwarping),
        useChartRecognition: Boolean(options.useChartRecognition),
      },
    };

    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
    cachedConfig = config;

    return { success: true };
  } catch (error) {
    console.error('Failed to save PaddleOCR config:', error);
    return { success: false, error: error.message };
  }
}

function getConfig() {
  const config = loadConfig();
  return {
    token: config.token || '',
    options: config.options || DEFAULT_CONFIG.options,
  };
}

function isConfigured() {
  const config = loadConfig();
  return Boolean(config.token && config.token.trim());
}

async function testConnection(token) {
  try {
    const testToken = String(token || '').trim();
    if (!testToken) {
      return { success: false, error: 'Token is required' };
    }

    // Test by making a simple request to the API endpoint
    return new Promise((resolve) => {
      const url = 'https://paddleocr.aistudio-app.com/api/v2/ocr/jobs';
      const postData = JSON.stringify({
        model: 'PaddleOCR-VL-1.6',
        fileUrl: 'https://example.com/test.pdf', // Use a dummy URL for testing
      });

      const options = {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${testToken}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
      };

      const req = https.request(url, options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
          data += chunk;
        });

      res.on('end', () => {
        // 401 means invalid token
        if (res.statusCode === 401) {
          resolve({ success: false, error: 'Invalid token (401 Unauthorized)' });
        } else if (res.statusCode === 422 || res.statusCode === 400) {
          // 422 or 400 with code 10002 means auth worked but file URL is invalid (expected for dummy URL)
          try {
            const body = JSON.parse(data);
            if (body.code === 10002 && body.msg && body.msg.includes('URL')) {
              // Token is valid, just the dummy URL was rejected
              resolve({ success: true });
            } else {
              resolve({ success: false, error: `HTTP ${res.statusCode}: ${data}` });
            }
          } catch {
            // If we can't parse JSON, treat as success (auth worked)
            resolve({ success: true });
          }
        } else if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ success: true });
        } else {
          resolve({ success: false, error: `HTTP ${res.statusCode}: ${data}` });
        }
      });
    });

    req.on('error', (error) => {
      resolve({ success: false, error: `Network error: ${error.message}` });
    });

    req.setTimeout(10000, () => {
      req.destroy();
      resolve({ success: false, error: 'Request timeout' });
    });

    req.write(postData);
    req.end();
  });
  } catch (error) {
    return { success: false, error: error.message };
  }
}

module.exports = {
  loadConfig,
  saveConfig,
  getConfig,
  isConfigured,
  testConnection,
};

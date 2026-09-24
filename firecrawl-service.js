/**
 * Firecrawl API 集成模块
 * 作为 Puppeteer 的备用抓取引擎,用于绕过 IP/设备指纹封禁
 */

const https = require('https');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

// Firecrawl API 配置
let FIRECRAWL_API_KEY = '';
const FIRECRAWL_BASE_URL = 'https://api.firecrawl.dev/v1';

// Firecrawl 抓取模式: 'auto' (自动降级) | 'manual' (手动强制使用)
let FIRECRAWL_MODE = 'auto';

/**
 * 从配置文件加载 API Key 和模式
 */
function loadConfig() {
  try {
    const configPath = path.join(app.getPath('userData'), 'firecrawl-config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      FIRECRAWL_API_KEY = config.apiKey || '';
      FIRECRAWL_MODE = config.mode || 'auto';
    }
  } catch (error) {
    console.error('Failed to load Firecrawl config:', error);
  }
}

/**
 * 保存 API Key 到配置文件
 */
function saveConfig(apiKey) {
  try {
    const configPath = path.join(app.getPath('userData'), 'firecrawl-config.json');
    fs.writeFileSync(configPath, JSON.stringify({ apiKey }, null, 2), 'utf8');
    FIRECRAWL_API_KEY = apiKey;
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * 设置抓取模式
 */
function setMode(mode) {
  try {
    const validModes = ['auto', 'manual'];
    if (!validModes.includes(mode)) {
      throw new Error(`Invalid mode: ${mode}. Must be one of: ${validModes.join(', ')}`);
    }
    
    const configPath = path.join(app.getPath('userData'), 'firecrawl-config.json');
    let config = {};
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
    config.mode = mode;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    FIRECRAWL_MODE = mode;
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * 获取当前抓取模式
 */
function getMode() {
  return FIRECRAWL_MODE;
}

/**
 * 检查是否已配置 API Key
 */
function isConfigured() {
  return !!FIRECRAWL_API_KEY;
}

/**
 * 使用 Firecrawl API 抓取单个页面
 * @param {string} url - 目标URL
 * @param {Object} options - 可选配置
 * @returns {Promise<{html: string, markdown?: string, links?: string[]}>}
 */
async function scrapePage(url, options = {}) {
  if (!FIRECRAWL_API_KEY) {
    throw new Error('Firecrawl API key not configured. Please set it in Settings.');
  }

  const {
    formats = ['html'],
    onlyMainContent = false,
    timeout = 30000,
  } = options;

  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      url,
      formats,
      onlyMainContent,
      timeout,
    });

    const reqOptions = {
      hostname: 'api.firecrawl.dev',
      port: 443,
      path: '/v1/scrape',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${FIRECRAWL_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          
          if (!result.success) {
            const errorMsg = result.error || 'Unknown Firecrawl API error';
            reject(new Error(`Firecrawl API error: ${errorMsg}`));
            return;
          }

          const responseData = result.data || {};
          resolve({
            html: responseData.html || '',
            // rawHtml = untouched server response; H&M's __NEXT_DATA__ payload
            // lives in a <script> tag that the cleaned "html" format may strip.
            rawHtml: responseData.rawHtml || '',
            markdown: responseData.markdown || '',
            links: responseData.links || [],
            metadata: responseData.metadata || {},
          });
        } catch (error) {
          reject(new Error(`Failed to parse Firecrawl response: ${error.message}`));
        }
      });
    });

    req.on('error', (error) => {
      reject(new Error(`Firecrawl request failed: ${error.message}`));
    });

    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new Error(`Firecrawl request timeout after ${timeout}ms`));
    });

    req.write(postData);
    req.end();
  });
}

/**
 * 检测错误是否由封禁导致
 * @param {Error} error 
 * @returns {boolean}
 */
function isBlockedError(error) {
  if (!error) return false;
  const msg = String(error.message || '').toLowerCase();
  return (
    msg.includes('403') ||
    msg.includes('access denied') ||
    msg.includes('cloudflare') ||
    msg.includes('forbidden') ||
    msg.includes('net::err_blocked') ||
    msg.includes('blocked by client') ||
    msg.includes('rate limit') ||
    msg.includes('too many requests')
  );
}

// 初始化时加载配置
loadConfig();

module.exports = {
  loadConfig,
  saveConfig,
  setMode,
  getMode,
  isConfigured,
  scrapePage,
  isBlockedError,
};

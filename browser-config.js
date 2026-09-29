/**
 * 抓取浏览器配置模块
 *
 * 背景：H&M 等站点由 Akamai 保护，会校验浏览器身份。原先只用 Google Chrome，
 * 但很多 Windows 机器只自带 Edge（没有 Chrome），且 Chrome 可能装在非标准路径
 * （绿色版/便携版），旧的硬编码 Program Files 扫描读不到。
 *
 * 本模块只解决「用哪个浏览器可执行文件」这一件事 —— 不改任何 cookie/身份逻辑。
 * 身份与 session 目录仍由 main.js 的 prepareHmChromeProfile / getHmSessionDir 负责。
 *
 * 配置文件：<userData>/browser-config.json
 *   {
 *     "preference": "auto",   // 'auto' | 'chrome' | 'edge' | 'bundled'
 *     "chromePath": "",       // 用户手填，空 = 自动探测
 *     "edgePath": ""          // 用户手填，空 = 自动探测
 *   }
 */

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const VALID_PREFERENCES = ['auto', 'chrome', 'edge', 'bundled'];
const DEFAULT_PREFERENCE = 'auto';

// 模块级缓存，避免每次抓取都重读磁盘
let cachedConfig = null;

function getConfigPath() {
  return path.join(app.getPath('userData'), 'browser-config.json');
}

function normalizePreference(value) {
  const raw = String(value || '').trim().toLowerCase();
  return VALID_PREFERENCES.includes(raw) ? raw : DEFAULT_PREFERENCE;
}

function fileExists(p) {
  try {
    return !!p && fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * 读取配置。文件不存在或损坏时回退到默认值（不抛错 —— 抓取不应因配置问题整体失败）。
 */
function loadConfig(options = {}) {
  if (cachedConfig && !options.forceRefresh) return { ...cachedConfig };

  const fallback = { preference: DEFAULT_PREFERENCE, chromePath: '', edgePath: '' };
  try {
    const configPath = getConfigPath();
    if (fs.existsSync(configPath)) {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      cachedConfig = {
        preference: normalizePreference(parsed.preference),
        chromePath: String(parsed.chromePath || '').trim(),
        edgePath: String(parsed.edgePath || '').trim(),
      };
      return { ...cachedConfig };
    }
  } catch (error) {
    console.error('Failed to load browser config:', error);
  }

  cachedConfig = fallback;
  return { ...fallback };
}

/**
 * 保存配置（局部更新）。只写白名单字段，避免把意外字段带进磁盘。
 */
function saveConfig(patch = {}) {
  try {
    const current = loadConfig({ forceRefresh: true });
    const next = {
      preference: patch.preference === undefined
        ? current.preference
        : normalizePreference(patch.preference),
      chromePath: patch.chromePath === undefined
        ? current.chromePath
        : String(patch.chromePath || '').trim(),
      edgePath: patch.edgePath === undefined
        ? current.edgePath
        : String(patch.edgePath || '').trim(),
    };

    fs.writeFileSync(getConfigPath(), JSON.stringify(next, null, 2), 'utf8');
    cachedConfig = next;
    return { success: true, config: { ...next } };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * 清理配置缓存。用于设置页保存后强制下次重新读取。
 */
function clearCache() {
  cachedConfig = null;
}

module.exports = {
  VALID_PREFERENCES,
  DEFAULT_PREFERENCE,
  getConfigPath,
  normalizePreference,
  loadConfig,
  saveConfig,
  clearCache,
  fileExists,
};

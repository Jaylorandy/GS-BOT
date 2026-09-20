/**
 * Zara图片URL生成器
 * 提供完整的图片URL模式库和智能生成策略
 */

/**
 * Zara图片URL后缀映射
 * 基于实际观察到的URL模式
 */
const IMAGE_SUFFIXES = {
  // 主要视图
  front: ['2-1-p', 'e1', '1-1-p'],           // 正面
  back: ['2-2-p', 'e2', '1-2-p'],            // 背面
  side: ['2-3-p', 'e3', '1-3-p'],            // 侧面
  detail1: ['2-4-p', 'e4', '1-4-p'],         // 细节1
  detail2: ['2-5-p', 'a1', '1-5-p'],         // 细节2
  detail3: ['2-6-p', 'a2', '1-6-p'],         // 细节3
  detail4: ['2-7-p', 'a3', '1-7-p'],         // 细节4
  detail5: ['2-8-p', 'a4', '1-8-p'],         // 细节5
  detail6: ['2-9-p', 'a5', '1-9-p'],         // 细节6
  detail7: ['2-10-p', 'a6', '1-10-p'],       // 细节7
  detail8: ['2-11-p', 'a7', '1-11-p'],       // 细节8
  detail9: ['2-12-p', 'a8', '1-12-p'],       // 细节9
  
  // 额外视图
  model: ['2-0-p', '1-0-p'],                 // 模特图
  flat: ['6-1-p', '6-2-p'],                  // 平铺图
  lifestyle: ['3-1-p', '3-2-p', '3-3-p'],    // 生活场景
  closeup: ['4-1-p', '4-2-p'],               // 特写
  packaging: ['5-1-p'],                      // 包装
};

/**
 * 所有可能的后缀列表（按优先级排序）
 */
const ALL_SUFFIXES = [
  // 最常见的视图
  '2-1-p', '2-2-p', '2-3-p', '2-4-p', '2-5-p', '2-6-p', '2-7-p', '2-8-p',
  '1-1-p', '1-2-p', '1-3-p', '1-4-p', '1-5-p', '1-6-p', '1-7-p', '1-8-p',
  
  // e系列（常用于主要视图）
  'e1', 'e2', 'e3', 'e4',
  
  // a系列（常用于细节图）
  'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8',
  
  // 其他视图
  '2-0-p', '1-0-p',
  '6-1-p', '6-2-p',
  '3-1-p', '3-2-p', '3-3-p',
  '4-1-p', '4-2-p',
  '5-1-p',
  
  // 额外的可能后缀
  '2-9-p', '2-10-p', '2-11-p', '2-12-p',
  '1-9-p', '1-10-p', '1-11-p', '1-12-p',
];

/**
 * Zara季节和年份模式
 */
const SEASON_PATTERNS = [
  // 2026年（未来）
  { year: '2026', season: 'I' },  // 春夏
  { year: '2026', season: 'V' },  // 秋冬
  
  // 2025年（当前）
  { year: '2025', season: 'I' },
  { year: '2025', season: 'V' },
  
  // 2024年
  { year: '2024', season: 'I' },
  { year: '2024', season: 'V' },
  
  // 2023年
  { year: '2023', season: 'I' },
  { year: '2023', season: 'V' },
  
  // 2022年（较旧）
  { year: '2022', season: 'I' },
  { year: '2022', season: 'V' },
];

/**
 * 图片格式
 */
const IMAGE_FORMATS = ['jpg', 'webp'];

/**
 * 生成所有可能的图片URL
 * @param {string} fullId - 8位产品ID
 * @param {object} options - 配置选项
 * @returns {Array<string>} URL列表
 */
function generateAllPossibleUrls(fullId, options = {}) {
  const {
    maxUrls = 100,           // 最大URL数量
    prioritySeasons = 5,     // 优先季节数量
    prioritySuffixes = 15,   // 优先后缀数量
    includeWebp = false,     // 是否包含webp格式
  } = options;

  const urls = [];
  const formats = includeWebp ? IMAGE_FORMATS : ['jpg'];
  
  // 使用优先级策略
  const seasons = SEASON_PATTERNS.slice(0, prioritySeasons);
  const suffixes = ALL_SUFFIXES.slice(0, prioritySuffixes);
  
  for (const { year, season } of seasons) {
    for (const suffix of suffixes) {
      for (const format of formats) {
        const url = `https://static.zara.net/photos///${year}/${season}/${fullId}/2/${fullId}_${suffix}.${format}`;
        urls.push(url);
        
        if (urls.length >= maxUrls) {
          return urls;
        }
      }
    }
  }
  
  return urls;
}

/**
 * 生成智能URL列表（基于当前日期）
 * @param {string} fullId - 8位产品ID
 * @returns {Array<string>} URL列表
 */
function generateSmartUrls(fullId) {
  const urls = [];
  const currentDate = new Date();
  const currentYear = currentDate.getFullYear();
  const currentMonth = currentDate.getMonth() + 1; // 1-12
  
  // 判断当前季节
  // I (春夏): 1-6月, V (秋冬): 7-12月
  const currentSeason = currentMonth <= 6 ? 'I' : 'V';
  
  // 智能季节优先级
  const smartSeasons = [
    { year: currentYear.toString(), season: currentSeason },     // 当前季节
    { year: currentYear.toString(), season: currentSeason === 'I' ? 'V' : 'I' }, // 另一季节
    { year: (currentYear - 1).toString(), season: 'V' },         // 去年秋冬
    { year: (currentYear - 1).toString(), season: 'I' },         // 去年春夏
    { year: (currentYear + 1).toString(), season: currentSeason }, // 明年同季
  ];
  
  // 最常见的后缀（基于观察）
  const commonSuffixes = [
    '2-1-p', '2-2-p', '2-3-p', '2-4-p', '2-5-p', '2-6-p',
    '1-1-p', '1-2-p', '1-3-p', '1-4-p',
    'e1', 'e2', 'e3', 'e4',
    'a1', 'a2', 'a3', 'a4',
  ];
  
  for (const { year, season } of smartSeasons) {
    for (const suffix of commonSuffixes) {
      const url = `https://static.zara.net/photos///${year}/${season}/${fullId}/2/${fullId}_${suffix}.jpg`;
      urls.push(url);
    }
  }
  
  return urls;
}

/**
 * 从已捕获的URL中推断模式
 * @param {Array<string>} capturedUrls - 已捕获的URL
 * @param {string} fullId - 8位产品ID
 * @returns {Array<string>} 推断出的额外URL
 */
function inferAdditionalUrls(capturedUrls, fullId) {
  if (capturedUrls.length === 0) return [];
  
  const additionalUrls = [];
  
  // 分析已捕获的URL，提取年份和季节
  const patterns = new Set();
  for (const url of capturedUrls) {
    const match = url.match(/\/(\d{4})\/(I|V)\//);
    if (match) {
      patterns.add(`${match[1]}-${match[2]}`);
    }
  }
  
  // 基于发现的模式生成更多URL
  for (const pattern of patterns) {
    const [year, season] = pattern.split('-');
    
    // 为这个年份/季节生成所有后缀
    for (const suffix of ALL_SUFFIXES.slice(0, 20)) {
      const url = `https://static.zara.net/photos///${year}/${season}/${fullId}/2/${fullId}_${suffix}.jpg`;
      
      // 只添加未捕获的URL
      if (!capturedUrls.includes(url)) {
        additionalUrls.push(url);
      }
    }
  }
  
  return additionalUrls;
}

function inferSiblingUrls(capturedUrls) {
  const additionalUrls = [];
  const suffixes = [
    'f1', 'f2', 'f3', 'f4', 'f5', 'f6',
    'p', 'b',
    'a1', 'a2', 'a3', 'a4', 'a5', 'a6',
    'e1', 'e2', 'e3', 'e4',
    's1', 's2',
  ];

  for (const url of capturedUrls || []) {
    const cleanUrl = String(url || '').split('?')[0];
    const match = cleanUrl.match(/^(.*?)(?:[-_](?:f\d+|p|b|a\d+|e\d+|s\d+))\.(jpg|jpeg|webp|png)$/i);
    if (!match) {
      continue;
    }

    const [, prefix, ext] = match;
    suffixes.forEach((suffix) => {
      additionalUrls.push(`${prefix}-${suffix}.${ext}`);
      additionalUrls.push(`${prefix}_${suffix}.${ext}`);
    });
  }

  return [...new Set(additionalUrls)].filter((url) => !capturedUrls.includes(url));
}

/**
 * 验证URL是否有效（通过HEAD请求）
 * @param {string} url - 图片URL
 * @returns {Promise<boolean>} 是否有效
 */
async function validateImageUrl(url) {
  const https = require('https');
  const http = require('http');
  
  return new Promise((resolve) => {
    const protocol = url.startsWith('https') ? https : http;
    
    const req = protocol.request(url, { method: 'HEAD', timeout: 5000 }, (res) => {
      resolve(res.statusCode === 200);
    });
    
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    
    req.end();
  });
}

module.exports = {
  IMAGE_SUFFIXES,
  ALL_SUFFIXES,
  SEASON_PATTERNS,
  generateAllPossibleUrls,
  generateSmartUrls,
  inferAdditionalUrls,
  inferSiblingUrls,
  validateImageUrl,
};

/**
 * Firecrawl 自动降级模块
 * 
 * 提供通用的降级逻辑,供各品牌抓取器复用
 */

const firecrawlService = require('./firecrawl-service');

/**
 * 尝试使用 Firecrawl 抓取页面并提取图片
 * @param {string} url - 目标URL
 * @param {Object} options - 配置选项
 * @param {Function} options.imageFilter - 图片过滤函数 (url, candidateIds) => boolean
 * @param {Function} options.urlNormalizer - URL标准化函数 (url) => string
 * @param {Array<string>} options.candidateIds - 候选ID列表用于图片匹配
 * @param {Function} options.emitLog - 日志输出函数
 * @returns {Promise<{imageUrls: string[], html: string, usedEngine: string}>}
 */
async function tryFirecrawlFallback(url, options = {}) {
  const {
    imageFilter = () => true,
    urlNormalizer = (u) => u,
    candidateIds = [],
    emitLog = () => {},
  } = options;

  if (!firecrawlService.isConfigured()) {
    throw new Error('Firecrawl not configured. Please set API Key in Settings.');
  }

  emitLog(`🔄 Attempting Firecrawl fallback for: ${url}`, 'warning');

  try {
    const result = await firecrawlService.scrapePage(url, {
      formats: ['html', 'links'],
      onlyMainContent: false,
      timeout: 30000,
    });

    const html = result.html || '';
    let imageUrls = [];

    // ─ Extract from srcset attributes (Zara uses lazy-loading) ────────
    // Zara product images are stored in srcset with responsive sizes:
    //   srcset="https://...jpg?ts=xxx&w=563 563w, https://...jpg?ts=xxx&w=375 375w"
    const srcsetPattern = /srcset=["']([^"']+)["']/gi;
    let srcsetMatch;
    while ((srcsetMatch = srcsetPattern.exec(html)) !== null) {
      const srcsetValue = srcsetMatch[1];
      // Split by comma to get individual URLs, then extract the URL part before width descriptor
      const candidates = srcsetValue.split(',').map(part => part.trim().split(/\s+/)[0]);
      for (const candidate of candidates) {
        if (/\.(jpg|jpeg|webp|png)/i.test(candidate)) {
          let fullUrl = candidate;
          if (candidate.startsWith('/')) {
            fullUrl = new URL(url).origin + candidate;
          }
          if (imageFilter(fullUrl, candidateIds)) {
            imageUrls.push(urlNormalizer(fullUrl));
          }
        }
      }
    }

    // ── Extract from data-src attributes (fallback for other sites) ────
    const dataSrcPattern = /data-src=["']([^"']+\.(?:jpg|jpeg|webp|png)[^"']*)["']/gi;
    let dataSrcMatch;
    while ((dataSrcMatch = dataSrcPattern.exec(html)) !== null) {
      const imgUrl = dataSrcMatch[1];
      let fullUrl = imgUrl;
      if (imgUrl.startsWith('/')) {
        fullUrl = new URL(url).origin + imgUrl;
      }
      if (imageFilter(fullUrl, candidateIds)) {
        imageUrls.push(urlNormalizer(fullUrl));
      }
    }

    // ── Extract from regular src attributes (legacy fallback) ──────────
    const imgPattern = /src=["']([^"']+\.(?:jpg|jpeg|webp|png)(?:\?[^"']*)?)["']/gi;
    let match;
    while ((match = imgPattern.exec(html)) !== null) {
      const imgUrl = match[1];
      let fullUrl = imgUrl;
      if (imgUrl.startsWith('/')) {
        fullUrl = new URL(url).origin + imgUrl;
      }
      if (imageFilter(fullUrl, candidateIds)) {
        imageUrls.push(urlNormalizer(fullUrl));
      }
    }

    // 从 links 字段补充
    if (result.links && result.links.length > 0) {
      for (const link of result.links) {
        if (/\.(jpg|jpeg|webp|png)$/i.test(link) && imageFilter(link, candidateIds)) {
          const normalized = urlNormalizer(link);
          if (!imageUrls.includes(normalized)) {
            imageUrls.push(normalized);
          }
        }
      }
    }

    // 去重
    imageUrls = [...new Set(imageUrls)];

    emitLog(`✅ Firecrawl success: extracted ${imageUrls.length} images`, 'success');

    return {
      imageUrls,
      html,
      usedEngine: 'firecrawl',
    };

  } catch (error) {
    emitLog(`❌ Firecrawl fallback failed: ${error.message}`, 'error');
    throw error;
  }
}

/**
 * 智能降级包装器: 先尝试主引擎,失败后自动切换到 Firecrawl
 * @param {Function} primaryFn - 主抓取函数 (返回 Promise)
 * @param {string} url - 目标URL
 * @param {Object} fallbackOptions - Firecrawl 降级选项
 * @param {Function} emitLog - 日志函数
 * @returns {Promise<{result: Object, usedEngine: string}>}
 */
async function smartScrapeWithFallback(primaryFn, url, fallbackOptions = {}, emitLog = () => {}) {
  let lastError = null;

  // 尝试主引擎
  try {
    const result = await primaryFn();
    return {
      result,
      usedEngine: 'primary',
    };
  } catch (error) {
    lastError = error;
    
    // 检测是否为封禁错误
    if (firecrawlService.isBlockedError(error)) {
      emitLog(`⚠️ Primary engine blocked, switching to Firecrawl...`, 'warning');
      
      try {
        const firecrawlResult = await tryFirecrawlFallback(url, {
          ...fallbackOptions,
          emitLog,
        });
        
        return {
          result: firecrawlResult,
          usedEngine: 'firecrawl',
        };
      } catch (firecrawlError) {
        // Firecrawl 也失败,抛出原始错误
        emitLog(`❌ Both engines failed. Original error: ${error.message}`, 'error');
        throw lastError;
      }
    }
    
    // 非封禁错误,直接抛出
    throw error;
  }
}

/**
 * 批量降级处理器: 为多个款号提供统一的降级逻辑
 * @param {Array<Object>} styleList - 款号列表 [{styleNum, url, ...}]
 * @param {Function} scrapeFn - 单个款号抓取函数
 * @param {Object} options - 配置选项
 * @returns {Promise<Array<Object>>} 抓取结果列表
 */
async function batchScrapeWithFallback(styleList, scrapeFn, options = {}) {
  const {
    emitLog = () => {},
    emitProgress = () => {},
    concurrency = 3,
    firecrawlOptions = {},
  } = options;

  const results = [];
  let completedCount = 0;
  const total = styleList.length;

  // 并发控制
  const processStyle = async (styleInfo, index) => {
    try {
      const { result, usedEngine } = await smartScrapeWithFallback(
        () => scrapeFn(styleInfo),
        styleInfo.url,
        firecrawlOptions,
        (msg, type) => emitLog(`[${index + 1}/${total}] ${msg}`, type)
      );

      results[index] = {
        ...result,
        usedEngine,
        styleNum: styleInfo.styleNum,
      };

      completedCount++;
      emitProgress(Math.round((completedCount / total) * 100));

    } catch (error) {
      results[index] = {
        styleNum: styleInfo.styleNum,
        url: styleInfo.url,
        error: error.message,
        imageUrls: [],
        usedEngine: 'failed',
      };
      
      completedCount++;
      emitProgress(Math.round((completedCount / total) * 100));
      
      emitLog(`❌ Style ${styleInfo.styleNum} failed: ${error.message}`, 'error');
    }
  };

  // 分批并发执行
  for (let i = 0; i < total; i += concurrency) {
    const batch = styleList.slice(i, i + concurrency);
    const promises = batch.map((style, idx) => 
      processStyle(style, i + idx)
    );
    await Promise.all(promises);
  }

  return results;
}

module.exports = {
  tryFirecrawlFallback,
  smartScrapeWithFallback,
  batchScrapeWithFallback,
};

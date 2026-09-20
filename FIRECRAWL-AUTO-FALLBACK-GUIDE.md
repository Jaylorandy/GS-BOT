# Firecrawl 自动降级 - 实施指南

## 📌 概述

本指南说明如何在各个品牌抓取器中集成 Firecrawl 自动降级逻辑。

---

## 🎯 核心模块

已创建的文件:
- `firecrawl-service.js` - API 封装和配置管理
- `firecrawl-fallback.js` - 通用降级逻辑
- `FIRECRAWL-INTEGRATION.md` - 用户文档

---

## 🔧 集成方式(两种方案)

### **方案 A: 最小侵入(推荐)**

在现有抓取函数的 try-catch 块中添加降级调用,**无需重构整个函数**。

#### 示例: Zara 抓取器

找到 `runScraper` 函数中的 `processStyleOnce` 函数(约 17033 行):

```javascript
// 原代码结构
for (let attempt = 1; attempt <= maxRetries; attempt++) {
  try {
    // ... Puppeteer 抓取逻辑 ...
    const page = await browser.newPage();
    await page.goto(url);
    // ... 提取图片 ...
    
  } catch (error) {
    lastError = error;
    // 原有重试逻辑
  }
}
```

**修改为:**

```javascript
const firecrawlFallback = require('./firecrawl-fallback');

for (let attempt = 1; attempt <= maxRetries; attempt++) {
  try {
    // ... 原有 Puppeteer 逻辑不变 ...
    
  } catch (error) {
    lastError = error;
    
    // === 新增: 检测封禁并降级 ===
    if (attempt >= maxRetries && firecrawlService.isBlockedError(error)) {
      emitLog(`⚠️ ${styleNum} blocked, trying Firecrawl fallback...`, 'warning');
      
      try {
        const candidateIds = [fullId, cleanNum];
        const fcResult = await firecrawlFallback.tryFirecrawlFallback(url, {
          imageFilter: looksLikeZaraProductImageUrl,
          urlNormalizer: normalizeZaraImageUrl,
          candidateIds,
          emitLog: (msg, type) => emitLog(`[Firecrawl] ${msg}`, type),
        });
        
        // 复用现有的分类逻辑
        const classified = {};
        for (const imgUrl of fcResult.imageUrls) {
          const label = classifyImage(imgUrl, styleNum);
          if (label) {
            if (!classified[label]) classified[label] = [];
            classified[label].push(imgUrl);
          }
        }
        
        return {
          styleNumber: styleNum,
          productId: fullId,
          url,
          imageUrls: fcResult.imageUrls,
          classified,
          usedEngine: 'firecrawl',
        };
        
      } catch (fcError) {
        emitLog(`❌ Firecrawl also failed: ${fcError.message}`, 'error');
        // 继续抛出原始错误
      }
    }
    
    if (attempt < maxRetries) {
      await antiDetection.randomDelay(2000, 4000);
    }
  }
}
```

---

### **方案 B: 批量处理器(适合新品牌)**

对于尚未实现的品牌,直接使用 `batchScrapeWithFallback`:

```javascript
async function runNewBrandScraper(config, emitLog, emitProgress, taskController) {
  const firecrawlFallback = require('./firecrawl-fallback');
  
  const styleList = config.styleNumbers.map(num => ({
    styleNum: num,
    url: buildBrandUrl(num), // 你的URL构建函数
  }));
  
  // 定义单个款号的抓取逻辑
  async function scrapeSingle(styleInfo) {
    // 你的 Puppeteer 抓取代码
    const browser = await puppeteer.launch({...});
    const page = await browser.newPage();
    await page.goto(styleInfo.url);
    
    // 提取图片
    const imageUrls = await page.evaluate(() => {
      // ... 你的DOM解析逻辑 ...
    });
    
    await browser.close();
    return { imageUrls, /* 其他字段 */ };
  }
  
  // 批量执行,自动降级
  const results = await firecrawlFallback.batchScrapeWithFallback(
    styleList,
    scrapeSingle,
    {
      emitLog,
      emitProgress,
      concurrency: 3,
      firecrawlOptions: {
        imageFilter: (url, ids) => isValidBrandImage(url),
        urlNormalizer: (url) => url.split('?')[0],
        candidateIds: [styleInfo.styleNum],
      },
    }
  );
  
  // 处理结果...
  return results;
}
```

---

## 📊 各品牌适配清单

| 品牌 | 主函数 | 难度 | 预估工作量 |
|------|--------|------|-----------|
| **Zara** | `runScraper` (16898行) | ⭐⭐ | 30分钟 |
| **Uniqlo** | `runUniqloScraper` (2640行) | ⭐⭐ | 25分钟 |
| **H&M** | `runHmScraper` (15192行) | ⭐⭐⭐ | 40分钟 |
| **Mango** | `runMangoScraper` (10527行) | ⭐⭐ | 30分钟 |
| **Bershka** | `runBershkaScraper` (8063行) | ⭐⭐ | 25分钟 |
| **Pull&Bear** | `runPullAndBearScraper` (7557行) | ⭐⭐ | 25分钟 |
| **Stradivarius** | `runStradivariusScraper` (7206行) | ⭐⭐ | 25分钟 |
| **Reserved** | `runReservedScraper` (12873行) | ⭐⭐⭐ | 40分钟 |
| **Sinsay** | `runSinsayScraper` (13656行) | ⭐⭐ | 30分钟 |
| **Urban Revivo** | `runUrbanRevivoScraper` (14534行) | ⭐⭐ | 30分钟 |
| **NewYorker** | `runNewYorkerScraper` (15528行) | ⭐⭐ | 25分钟 |
| **Abercrombie** | `runAbercrombieScraper` (12598行) | ⭐⭐⭐ | 40分钟 |
| **Lefties** | `runLeftiesScraper` (9232行) | ⭐⭐ | 25分钟 |
| **GU** | `runGuScraper` (3460行) | ⭐⭐ | 20分钟 |

---

## 🛠️ 快速实施步骤

### Step 1: 选择首个目标品牌

建议从 **Zara** 开始(已有完整测试用例)。

### Step 2: 定位关键位置

在 `main.js` 中找到:
1. 品牌抓取函数(如 `runScraper`)
2. 单个款号处理循环(如 `processStyleOnce`)
3. 现有的 try-catch 错误处理块

### Step 3: 添加降级代码

复制上面的"方案 A"示例代码,替换为你的品牌特定函数:
- `looksLikeZaraProductImageUrl` → 你的图片过滤函数
- `normalizeZaraImageUrl` → 你的URL标准化函数
- `classifyImage` → 你的图片分类函数

### Step 4: 测试

1. 配置 Firecrawl API Key
2. 故意触发封禁(连续快速抓取 10+ 个款号)
3. 观察日志是否显示 `🔄 Using Firecrawl fallback...`
4. 验证返回的图片数量和质量

### Step 5: 复制到其他品牌

一旦 Zara 测试通过,将相同模式应用到其他品牌。

---

## 💡 最佳实践

### ✅ 推荐做法

1. **保留原有逻辑**: 不要删除 Puppeteer 代码,仅添加降级分支
2. **复用业务函数**: 继续使用 `classifyImage()`, `buildUrl()` 等
3. **记录引擎来源**: 在返回结果中添加 `usedEngine` 字段
4. **限制降级频率**: 避免所有请求都走 Firecrawl(成本高)

### ❌ 避免的做法

1. **完全替换 Puppeteer**: Firecrawl 无法提供浏览器交互能力
2. **忽略成本监控**: 定期检查 Firecrawl 使用量
3. **硬编码 API Key**: 始终通过配置文件加载

---

## 📈 监控和优化

### 查看使用统计

```javascript
// 在前端组件中
const stats = await window.electronAPI.invoke('firecrawl-get-usage');
console.log(stats);
// {
//   totalCalls: 15,
//   successfulCalls: 14,
//   successRate: "93.3%",
//   totalCost: 0.15
// }
```

### 优化策略

如果 Firecrawl 使用率过高(>30%):
1. 检查本地 IP 是否仍在封禁期
2. 增加 Puppeteer 请求间隔
3. 考虑轮换代理池

---

## 🔗 相关文档

- [Firecrawl 集成总览](./FIRECRAWL-INTEGRATION.md)
- [前端集成示例](./firecrawl-integration-guide.js)
- [API 参考](https://docs.firecrawl.dev/)

---

## 📞 需要帮助?

如需在具体品牌中实施降级逻辑,请提供:
1. 品牌名称
2. 遇到的具体问题
3. 期望的降级行为

我可以帮你编写针对性的集成代码。

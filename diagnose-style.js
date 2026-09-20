#!/usr/bin/env node

/**
 * 诊断特定款号的图片URL问题
 * 款号: 4661064733
 */

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const antiDetection = require('./anti-detection');

const TEST_STYLE = '4661064733';

async function findChrome() {
  const paths = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ];
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('未找到Chrome浏览器');
}

function buildUrl(styleNum) {
  const cleanNum = styleNum.replace(/[^0-9]/g, '');
  let pid;
  if (cleanNum.length >= 9) {
    pid = cleanNum.substring(0, 7).padStart(8, '0');
  } else if (cleanNum.length === 7) {
    pid = cleanNum.padStart(8, '0');
  } else if (cleanNum.length === 8) {
    pid = cleanNum;
  } else {
    pid = cleanNum.padStart(8, '0');
  }
  return `https://www.zara.com/us/en/-p${pid}.html`;
}

async function diagnoseStyle() {
  console.log('🔍 诊断款号图片URL问题...\n');
  console.log('=' .repeat(70));
  console.log(`📋 款号: ${TEST_STYLE}`);
  
  const cleanNum = TEST_STYLE.replace(/[^0-9]/g, '');
  const fullId = cleanNum.substring(0, 7).padStart(8, '0');
  const url = buildUrl(TEST_STYLE);
  
  console.log(`🆔 产品ID: ${fullId}`);
  console.log(`🔗 URL: ${url}\n`);
  console.log('=' .repeat(70));

  const chromePath = await findChrome();
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: false,
    args: antiDetection.getEnhancedLaunchArgs(),
    ignoreDefaultArgs: ['--enable-automation'],
    defaultViewport: null,
  });

  const page = await browser.newPage();
  await antiDetection.applyAntiDetection(page);
  const viewport = antiDetection.getRandomViewport();
  await page.setViewport(viewport);
  const userAgent = antiDetection.getRandomUserAgent();
  await page.setUserAgent(userAgent);

  console.log('\n🌍 正在访问页面...');
  
  // 监听所有图片请求
  const allImageUrls = new Set();
  const imagesByPattern = {
    withFullId: [],
    withPartialId: [],
    staticZara: [],
    other: []
  };

  page.on('response', async (resp) => {
    const reqUrl = resp.url();
    if (reqUrl.match(/\.(jpg|jpeg|webp|png)(\?|$)/i)) {
      allImageUrls.add(reqUrl);
      
      // 分类
      if (reqUrl.includes(fullId)) {
        imagesByPattern.withFullId.push(reqUrl);
      } else if (reqUrl.includes(cleanNum.substring(0, 6)) || reqUrl.includes(cleanNum.substring(0, 5))) {
        imagesByPattern.withPartialId.push(reqUrl);
      } else if (reqUrl.includes('static.zara.net')) {
        imagesByPattern.staticZara.push(reqUrl);
      } else {
        imagesByPattern.other.push(reqUrl);
      }
    }
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await antiDetection.randomDelay(3000, 5000);

  // 关闭cookie
  try {
    const btn = await page.$('#onetrust-accept-btn-handler');
    if (btn) {
      await btn.click();
      await antiDetection.randomDelay(500, 1000);
    }
  } catch (e) {}

  console.log('✅ 页面加载完成');
  console.log('📜 滚动页面加载所有图片...');

  // 滚动加载
  await antiDetection.humanScroll(page);
  await antiDetection.randomDelay(2000, 3000);

  // 提取DOM中的所有图片
  const domImages = await page.evaluate(() => {
    const images = [];
    
    // 所有img标签
    document.querySelectorAll('img').forEach(img => {
      if (img.src) images.push({ type: 'img.src', url: img.src });
      if (img.dataset.src) images.push({ type: 'img[data-src]', url: img.dataset.src });
      if (img.srcset) {
        const srcsetUrls = img.srcset.split(',').map(s => s.trim().split(' ')[0]);
        srcsetUrls.forEach(u => images.push({ type: 'img.srcset', url: u }));
      }
    });
    
    // picture source
    document.querySelectorAll('picture source').forEach(source => {
      if (source.srcset) {
        const srcsetUrls = source.srcset.split(',').map(s => s.trim().split(' ')[0]);
        srcsetUrls.forEach(u => images.push({ type: 'picture source', url: u }));
      }
    });
    
    // 背景图片
    document.querySelectorAll('[style*="background-image"]').forEach(el => {
      const match = el.style.backgroundImage.match(/url\(['"]?([^'"]+)['"]?\)/);
      if (match) images.push({ type: 'background-image', url: match[1] });
    });
    
    return images;
  });

  await browser.close();

  // 输出分析结果
  console.log('\n\n' + '='.repeat(70));
  console.log('📊 图片URL分析结果');
  console.log('='.repeat(70));

  console.log(`\n总计捕获图片: ${allImageUrls.size} 张\n`);

  console.log('📌 按ID匹配分类:');
  console.log(`  包含完整ID (${fullId}): ${imagesByPattern.withFullId.length} 张`);
  console.log(`  包含部分ID: ${imagesByPattern.withPartialId.length} 张`);
  console.log(`  Zara静态资源: ${imagesByPattern.staticZara.length} 张`);
  console.log(`  其他: ${imagesByPattern.other.length} 张`);

  console.log('\n\n📸 包含完整ID的图片URL:');
  console.log('-'.repeat(70));
  if (imagesByPattern.withFullId.length > 0) {
    imagesByPattern.withFullId.forEach((url, i) => {
      console.log(`${i + 1}. ${url}`);
    });
  } else {
    console.log('❌ 没有找到包含完整ID的图片！');
  }

  console.log('\n\n📸 包含部分ID的图片URL:');
  console.log('-'.repeat(70));
  if (imagesByPattern.withPartialId.length > 0) {
    imagesByPattern.withPartialId.slice(0, 10).forEach((url, i) => {
      console.log(`${i + 1}. ${url}`);
    });
    if (imagesByPattern.withPartialId.length > 10) {
      console.log(`... 还有 ${imagesByPattern.withPartialId.length - 10} 张`);
    }
  } else {
    console.log('❌ 没有找到包含部分ID的图片！');
  }

  console.log('\n\n📸 Zara静态资源图片URL (前20个):');
  console.log('-'.repeat(70));
  if (imagesByPattern.staticZara.length > 0) {
    imagesByPattern.staticZara.slice(0, 20).forEach((url, i) => {
      console.log(`${i + 1}. ${url}`);
    });
    if (imagesByPattern.staticZara.length > 20) {
      console.log(`... 还有 ${imagesByPattern.staticZara.length - 20} 张`);
    }
  }

  console.log('\n\n🔍 DOM提取的图片 (前20个):');
  console.log('-'.repeat(70));
  const uniqueDomImages = [...new Set(domImages.map(img => img.url))];
  uniqueDomImages.slice(0, 20).forEach((url, i) => {
    const types = domImages.filter(img => img.url === url).map(img => img.type);
    console.log(`${i + 1}. [${types.join(', ')}] ${url}`);
  });
  if (uniqueDomImages.length > 20) {
    console.log(`... 还有 ${uniqueDomImages.length - 20} 张`);
  }

  // URL模式分析
  console.log('\n\n🔬 URL模式分析:');
  console.log('-'.repeat(70));
  
  const patterns = new Map();
  allImageUrls.forEach(url => {
    // 提取URL模式
    const match = url.match(/\/photos\/\/\/(\d{4})\/([IV])\/(\d+)\/(\d+)\/(\d+)_([^.]+)\.(jpg|webp|png)/);
    if (match) {
      const [, year, season, id, folder, filename, suffix, ext] = match;
      const pattern = `${year}/${season}/${folder}/*_${suffix}.${ext}`;
      patterns.set(pattern, (patterns.get(pattern) || 0) + 1);
    }
  });

  if (patterns.size > 0) {
    console.log('发现的URL模式:');
    [...patterns.entries()].sort((a, b) => b[1] - a[1]).forEach(([pattern, count]) => {
      console.log(`  ${pattern} (${count}张)`);
    });
  } else {
    console.log('❌ 未发现标准Zara URL模式');
  }

  // 诊断建议
  console.log('\n\n' + '='.repeat(70));
  console.log('💡 诊断建议');
  console.log('='.repeat(70));

  if (imagesByPattern.withFullId.length === 0) {
    console.log('\n⚠️ 问题: 没有找到包含完整产品ID的图片');
    console.log('\n可能原因:');
    console.log('  1. 该款号使用了不同的ID格式');
    console.log('  2. 图片URL中使用了缩短的ID');
    console.log('  3. 该商品使用了特殊的图片存储方式');
    
    console.log('\n建议解决方案:');
    console.log('  1. 检查部分ID匹配的图片');
    console.log('  2. 分析实际捕获的URL模式');
    console.log('  3. 添加对短ID的支持');
    console.log('  4. 增强DOM图片提取逻辑');
  } else {
    console.log('\n✅ 找到了包含完整ID的图片');
    console.log(`   数量: ${imagesByPattern.withFullId.length} 张`);
  }

  console.log('\n');
}

diagnoseStyle().catch(err => {
  console.error('\n❌ 诊断失败:', err.message);
  console.error(err.stack);
  process.exit(1);
});

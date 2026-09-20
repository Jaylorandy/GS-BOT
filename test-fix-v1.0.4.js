#!/usr/bin/env node

/**
 * 快速验证修复效果
 * 测试面料信息抓取和图片下载功能
 */

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

// 测试款号
const TEST_STYLE = '1934/470/807';

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

async function testFix() {
  console.log('🧪 开始验证修复效果...\n');
  console.log(`📋 测试款号: ${TEST_STYLE}\n`);

  const chromePath = await findChrome();
  console.log(`✅ 找到Chrome: ${chromePath}\n`);

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: false,
    args: ['--no-sandbox']
  });

  const page = await browser.newPage();
  
  // 计算ID
  const cleanNum = TEST_STYLE.replace(/[^0-9]/g, '');
  const fullId = cleanNum.substring(0, 7).padStart(8, '0');
  const url = `https://www.zara.com/us/en/-p${fullId}.html`;
  
  console.log(`🔗 访问URL: ${url}`);
  console.log(`🆔 匹配ID: ${fullId}\n`);

  const capturedUrls = new Set();

  // 监听网络响应
  page.on('response', (resp) => {
    const reqUrl = resp.url();
    if (reqUrl.includes(fullId) &&
        (reqUrl.endsWith('.jpg') || reqUrl.includes('.jpg?') || 
         reqUrl.endsWith('.webp') || reqUrl.includes('.webp?'))) {
      const cleanUrl = reqUrl.split('?')[0];
      capturedUrls.add(cleanUrl);
      console.log(`📸 捕获图片: ${path.basename(cleanUrl)}`);
    }
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await new Promise(r => setTimeout(r, 5000));

  // 关闭cookie弹窗
  try {
    const btn = await page.$('#onetrust-accept-btn-handler');
    if (btn) await btn.click();
  } catch (e) {}

  console.log('\n📝 提取产品信息...\n');

  // 提取信息
  const info = await page.evaluate(() => {
    const h1 = document.querySelector('h1');
    const name = h1 ? h1.textContent.trim() : '';

    let price = '';
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const t = walker.currentNode.textContent.trim();
      if (t.match(/^\$\s*[\d,.]+$/) && t.length < 20) {
        price = t;
        break;
      }
    }

    // 面料信息提取（增强版）
    let composition = '';
    const compositionKeywords = [
      'COMPOSITION', 'OUTER SHELL', 'LINING', 'SHELL', 'FILLING',
      'Outer shell', 'Lining', 'Main material', 'Fabric', 'Material',
      'CARE', 'MATERIALS', 'FABRIC'
    ];
    
    const allText = document.body.innerText;
    const sections = allText.split(/\n{2,}/);

    for (const section of sections) {
      const sectionTrimmed = section.trim();
      if (compositionKeywords.some(kw => sectionTrimmed.toUpperCase().includes(kw.toUpperCase()))) {
        const materialLines = sectionTrimmed.split('\n')
          .filter(line => {
            const l = line.trim();
            return (
              /\d+%/.test(l) ||
              /Wool|Cotton|Viscose|Polyester|Leather|Suede|Linen|Silk|Nylon|Spandex|Elastane|Acrylic|Cashmere/i.test(l)
            ) && l.length < 150 && l.length > 3;
          })
          .map(line => line.trim());
        
        if (materialLines.length > 0) {
          composition = materialLines.join(' | ');
          break;
        }
      }
    }
    
    if (!composition) {
      const detailElements = document.querySelectorAll('.product-detail-info, .product-detail, [class*="composition"], [class*="material"]');
      for (const el of detailElements) {
        const text = el.textContent.trim();
        if (/\d+%|Wool|Cotton|Viscose|Polyester/i.test(text) && text.length < 300) {
          composition = text.split('\n').filter(l => l.trim().length > 0).join(' | ');
          break;
        }
      }
    }

    return { name, price, composition };
  });

  // 滚动加载图片
  const bodyHeight = await page.evaluate(() => document.body.scrollHeight);
  for (let y = 0; y < bodyHeight; y += 400) {
    await page.evaluate(sy => window.scrollTo(0, sy), y);
    await new Promise(r => setTimeout(r, 300));
  }
  await new Promise(r => setTimeout(r, 1500));

  // DOM提取
  const domUrls = await page.evaluate((fid) => {
    const urls = [];
    const selectors = [
      'img',
      'picture source',
      '[style*="background-image"]',
      '[data-src]',
      '[data-srcset]'
    ];
    
    document.querySelectorAll(selectors.join(', ')).forEach(el => {
      const srcs = [
        el.src,
        el.getAttribute('data-src'),
        el.getAttribute('srcset'),
        el.getAttribute('data-srcset'),
        el.style?.backgroundImage?.match(/url\(['"]?([^'"]+)['"]?\)/)?.[1]
      ].filter(Boolean);
      
      for (const s of srcs) {
        const matches = s.match(/https?:\/\/[^\s,'"]+\.(jpg|jpeg|webp|png)[^\s,'"']*/gi) || [];
        for (const u of matches) {
          const cleanUrl = u.split('?')[0];
          if (cleanUrl.includes(fid) && !cleanUrl.includes('transparent-background')) {
            urls.push(cleanUrl);
          }
        }
      }
    });
    
    return [...new Set(urls)];
  }, fullId);

  domUrls.forEach(u => {
    capturedUrls.add(u);
    console.log(`🖼️ DOM提取: ${path.basename(u)}`);
  });

  await browser.close();

  // 输出结果
  console.log('\n' + '='.repeat(60));
  console.log('📊 验证结果\n');
  console.log(`✅ 产品名称: ${info.name || '未找到'}`);
  console.log(`✅ 价格: ${info.price || '未找到'}`);
  console.log(`✅ 面料信息: ${info.composition || '❌ 未找到'}`);
  console.log(`✅ 捕获图片数量: ${capturedUrls.size} 张`);
  console.log('='.repeat(60));

  // 判断修复是否成功
  console.log('\n🎯 修复验证:\n');
  
  const compositionFixed = info.composition && info.composition.length > 0;
  const imagesFixed = capturedUrls.size > 0;

  console.log(`${compositionFixed ? '✅' : '❌'} 面料信息抓取: ${compositionFixed ? '成功' : '失败'}`);
  console.log(`${imagesFixed ? '✅' : '❌'} 图片捕获: ${imagesFixed ? '成功' : '失败'}`);

  if (compositionFixed && imagesFixed) {
    console.log('\n🎉 所有修复验证通过！');
  } else {
    console.log('\n⚠️ 部分功能需要进一步检查');
    if (!compositionFixed) {
      console.log('   - 面料信息可能在此商品页面不存在');
    }
    if (!imagesFixed) {
      console.log('   - 请检查款号是否有效或网络连接');
    }
  }

  console.log('\n');
}

testFix().catch(err => {
  console.error('❌ 测试失败:', err.message);
  process.exit(1);
});

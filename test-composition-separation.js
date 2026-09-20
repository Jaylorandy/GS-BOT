#!/usr/bin/env node

/**
 * 面料信息分离功能测试
 * 测试outer shell和lining的识别和分离
 */

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const antiDetection = require('./anti-detection');

// 测试款号（选择可能有外壳和里布的款式，如外套）
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

function buildUrl(styleNum) {
  const cleanNum = styleNum.replace(/[^0-9]/g, '');
  let pid;
  if (cleanNum.length >= 9) {
    pid = cleanNum.substring(0, 7).padStart(8, '0');
  } else if (cleanNum.length === 7) {
    pid = cleanNum.padStart(8, '0');
  } else {
    pid = cleanNum.padStart(8, '0');
  }
  return `https://www.zara.com/us/en/-p${pid}.html`;
}

async function testCompositionSeparation() {
  console.log('🧪 开始测试面料信息分离功能...\n');
  console.log('=' .repeat(70));

  const chromePath = await findChrome();
  console.log(`✅ Chrome路径: ${chromePath}\n`);

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: false,
    args: antiDetection.getEnhancedLaunchArgs(),
    ignoreDefaultArgs: ['--enable-automation'],
    defaultViewport: null,
  });

  const url = buildUrl(TEST_STYLE);
  console.log(`🔗 测试款号: ${TEST_STYLE}`);
  console.log(`🌐 URL: ${url}\n`);
  console.log('=' .repeat(70) + '\n');

  const page = await browser.newPage();
  
  await antiDetection.applyAntiDetection(page);
  const viewport = antiDetection.getRandomViewport();
  await page.setViewport(viewport);
  const userAgent = antiDetection.getRandomUserAgent();
  await page.setUserAgent(userAgent);

  console.log('🌍 正在访问页面...');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await antiDetection.randomDelay(3000, 5000);

  // 关闭cookie
  try {
    const btn = await page.$('#onetrust-accept-btn-handler');
    if (btn) {
      await btn.click();
      console.log('🍪 Cookie弹窗已关闭');
      await antiDetection.randomDelay(500, 1000);
    }
  } catch (e) {}

  console.log('📝 提取面料信息...\n');

  // 提取面料信息（使用新的分离逻辑）
  const composition = await page.evaluate(() => {
    let outerShell = '';
    let lining = '';
    let otherComposition = '';
    
    const allText = document.body.innerText;
    const sections = allText.split(/\n{2,}/);

    // Find the composition section
    let compositionSection = '';
    const compositionKeywords = [
      'COMPOSITION', 'OUTER SHELL', 'LINING', 'SHELL', 'FILLING',
      'Outer shell', 'Lining', 'Main material', 'Fabric', 'Material',
      'CARE', 'MATERIALS', 'FABRIC'
    ];
    
    for (const section of sections) {
      const sectionTrimmed = section.trim();
      if (compositionKeywords.some(kw => sectionTrimmed.toUpperCase().includes(kw.toUpperCase()))) {
        compositionSection = sectionTrimmed;
        break;
      }
    }
    
    // If found composition section, parse it
    if (compositionSection) {
      const lines = compositionSection.split('\n').map(l => l.trim()).filter(l => l.length > 0);
      
      let currentCategory = 'other';
      
      for (const line of lines) {
        const lineUpper = line.toUpperCase();
        
        // Detect category headers
        if (lineUpper.includes('OUTER SHELL') || lineUpper.includes('SHELL') && !lineUpper.includes('LINING')) {
          currentCategory = 'outer';
          // Check if material info is on the same line
          if (/\d+%|Wool|Cotton|Viscose|Polyester|Leather|Suede|Linen|Silk|Nylon|Spandex|Elastane|Acrylic|Cashmere/i.test(line)) {
            const materialPart = line.replace(/OUTER SHELL:?/i, '').replace(/SHELL:?/i, '').trim();
            if (materialPart) {
              outerShell += (outerShell ? ' | ' : '') + materialPart;
            }
          }
          continue;
        }
        
        if (lineUpper.includes('LINING')) {
          currentCategory = 'lining';
          // Check if material info is on the same line
          if (/\d+%|Wool|Cotton|Viscose|Polyester|Leather|Suede|Linen|Silk|Nylon|Spandex|Elastane|Acrylic|Cashmere/i.test(line)) {
            const materialPart = line.replace(/LINING:?/i, '').trim();
            if (materialPart) {
              lining += (lining ? ' | ' : '') + materialPart;
            }
          }
          continue;
        }
        
        if (lineUpper.includes('FILLING') || lineUpper.includes('PADDING')) {
          currentCategory = 'other';
          continue;
        }
        
        // Extract material lines
        if (/\d+%|Wool|Cotton|Viscose|Polyester|Leather|Suede|Linen|Silk|Nylon|Spandex|Elastane|Acrylic|Cashmere/i.test(line) && line.length < 150) {
          if (currentCategory === 'outer') {
            outerShell += (outerShell ? ' | ' : '') + line;
          } else if (currentCategory === 'lining') {
            lining += (lining ? ' | ' : '') + line;
          } else {
            otherComposition += (otherComposition ? ' | ' : '') + line;
          }
        }
      }
    }
    
    // Method 2: If not found, search in specific elements
    if (!outerShell && !lining && !otherComposition) {
      const detailElements = document.querySelectorAll('.product-detail-info, .product-detail, [class*="composition"], [class*="material"]');
      for (const el of detailElements) {
        const text = el.textContent.trim();
        if (/\d+%|Wool|Cotton|Viscose|Polyester/i.test(text) && text.length < 300) {
          otherComposition = text.split('\n').filter(l => l.trim().length > 0).join(' | ');
          break;
        }
      }
    }

    return {
      outerShell: outerShell || null,
      lining: lining || null,
      other: otherComposition || null,
      rawSection: compositionSection || null
    };
  });

  await browser.close();

  // 输出结果
  console.log('=' .repeat(70));
  console.log('📊 面料信息提取结果\n');
  console.log('=' .repeat(70));

  console.log('\n🔍 原始面料信息段落:');
  console.log('-'.repeat(70));
  if (composition.rawSection) {
    console.log(composition.rawSection);
  } else {
    console.log('❌ 未找到面料信息段落');
  }

  console.log('\n📦 分离后的结果:');
  console.log('-'.repeat(70));

  if (composition.outerShell) {
    console.log(`\n✅ 外壳面料 (Outer Shell):`);
    console.log(`   ${composition.outerShell}`);
  } else {
    console.log(`\n❌ 外壳面料: 未找到`);
  }

  if (composition.lining) {
    console.log(`\n✅ 里布面料 (Lining):`);
    console.log(`   ${composition.lining}`);
  } else {
    console.log(`\n❌ 里布面料: 未找到`);
  }

  if (composition.other) {
    console.log(`\n✅ 其他面料信息:`);
    console.log(`   ${composition.other}`);
  }

  console.log('\n' + '=' .repeat(70));
  console.log('📄 JSON格式输出:\n');
  console.log(JSON.stringify({
    composition: {
      outerShell: composition.outerShell,
      lining: composition.lining,
      other: composition.other
    }
  }, null, 2));

  console.log('\n' + '=' .repeat(70));
  console.log('🎯 功能验证:\n');

  const hasOuterShell = composition.outerShell !== null;
  const hasLining = composition.lining !== null;
  const hasAnyComposition = hasOuterShell || hasLining || composition.other !== null;

  console.log(`${hasOuterShell ? '✅' : '⚠️'} 外壳面料识别: ${hasOuterShell ? '成功' : '未找到（可能此商品无外壳）'}`);
  console.log(`${hasLining ? '✅' : '⚠️'} 里布面料识别: ${hasLining ? '成功' : '未找到（可能此商品无里布）'}`);
  console.log(`${hasAnyComposition ? '✅' : '❌'} 面料信息提取: ${hasAnyComposition ? '成功' : '失败'}`);

  if (hasOuterShell && hasLining) {
    console.log('\n🎉 完美！成功分离外壳和里布面料信息！');
  } else if (hasAnyComposition) {
    console.log('\n✅ 成功提取面料信息（部分商品可能只有单层面料）');
  } else {
    console.log('\n⚠️ 未找到面料信息，可能原因：');
    console.log('   1. 此商品页面不包含面料信息');
    console.log('   2. 面料信息格式发生变化');
    console.log('   3. 页面加载不完整');
  }

  console.log('\n');
}

testCompositionSeparation().catch(err => {
  console.error('\n❌ 测试失败:', err.message);
  console.error(err.stack);
  process.exit(1);
});

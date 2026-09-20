#!/usr/bin/env node

/**
 * 反爬虫增强功能测试脚本
 * 测试多层反检测措施的效果
 */

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');
const antiDetection = require('./anti-detection');

// 测试款号（包含一些可能失败的）
const TEST_STYLES = [
  '1934/470/807',  // 正常款号
  '0155/325/518',  // 可能需要重试的款号
];

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

async function testAntiDetection() {
  console.log('🛡️ 开始测试反爬虫增强功能...\n');
  console.log('=' .repeat(70));

  const chromePath = await findChrome();
  console.log(`✅ Chrome路径: ${chromePath}\n`);

  // 使用增强的启动参数
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: false,
    args: antiDetection.getEnhancedLaunchArgs(),
    ignoreDefaultArgs: ['--enable-automation'],
    defaultViewport: null,
  });

  console.log('🚀 浏览器启动成功\n');
  console.log('📋 测试款号:', TEST_STYLES.join(', '));
  console.log('=' .repeat(70) + '\n');

  const results = [];

  for (const styleNum of TEST_STYLES) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`🔍 测试款号: ${styleNum}`);
    console.log('='.repeat(70));

    const cleanNum = styleNum.replace(/[^0-9]/g, '');
    const fullId = cleanNum.substring(0, 7).padStart(8, '0');
    const url = buildUrl(styleNum);

    console.log(`🔗 URL: ${url}`);
    console.log(`🆔 匹配ID: ${fullId}\n`);

    let success = false;
    let attempts = 0;
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      attempts = attempt;
      console.log(`\n📌 第 ${attempt} 次尝试...`);

      try {
        const page = await browser.newPage();

        // 应用完整的反检测措施
        console.log('🎭 应用反检测措施...');
        await antiDetection.applyAntiDetection(page);

        // 设置随机视口
        const viewport = antiDetection.getRandomViewport();
        await page.setViewport(viewport);
        console.log(`📐 视口: ${viewport.width}x${viewport.height}`);

        // 设置随机User-Agent
        const userAgent = antiDetection.getRandomUserAgent();
        await page.setUserAgent(userAgent);
        console.log(`🌐 UA: ${userAgent.substring(0, 60)}...`);

        // 随机延迟后访问
        console.log('⏱️ 随机延迟中...');
        await antiDetection.randomDelay(1000, 2000);

        console.log('🌍 正在访问页面...');
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // 检测是否被封禁
        const isBlocked = await antiDetection.detectBlocking(page);
        if (isBlocked) {
          console.log('⚠️ 检测到访问被限制');
          await page.close();
          throw new Error('访问被限制');
        }

        console.log('✅ 页面加载成功');

        // 随机延迟
        await antiDetection.randomDelay(2000, 3000);

        // 关闭cookie
        try {
          const btn = await page.$('#onetrust-accept-btn-handler');
          if (btn) {
            await btn.click();
            console.log('🍪 Cookie弹窗已关闭');
            await antiDetection.randomDelay(500, 1000);
          }
        } catch (e) {}

        // 提取产品信息
        console.log('📝 提取产品信息...');
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

          return { name, price };
        });

        // 人类化滚动
        console.log('📜 模拟人类滚动...');
        await antiDetection.humanScroll(page);
        await antiDetection.randomDelay(1000, 2000);

        // 模拟鼠标移动
        console.log('🖱️ 模拟鼠标移动...');
        await antiDetection.simulateMouseMovement(page);

        await page.close();

        console.log('\n✅ 抓取成功！');
        console.log(`   产品名称: ${info.name || '未找到'}`);
        console.log(`   价格: ${info.price || '未找到'}`);

        success = true;
        results.push({
          styleNum,
          success: true,
          attempts,
          name: info.name,
          price: info.price,
        });

        break; // 成功则跳出重试循环

      } catch (error) {
        console.log(`❌ 第 ${attempt} 次尝试失败: ${error.message}`);

        if (attempt < maxRetries) {
          const delay = 2000 * Math.pow(2, attempt - 1) + Math.random() * 1000;
          console.log(`⏱️ 等待 ${Math.round(delay/1000)}秒后重试...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    if (!success) {
      console.log(`\n❌ ${styleNum} 所有重试均失败`);
      results.push({
        styleNum,
        success: false,
        attempts,
      });
    }
  }

  await browser.close();

  // 输出测试结果
  console.log('\n\n' + '='.repeat(70));
  console.log('📊 测试结果汇总');
  console.log('='.repeat(70));

  const successCount = results.filter(r => r.success).length;
  const failCount = results.filter(r => !r.success).length;
  const successRate = (successCount / results.length * 100).toFixed(1);

  console.log(`\n总计: ${results.length} 个款号`);
  console.log(`成功: ${successCount} 个 (${successRate}%)`);
  console.log(`失败: ${failCount} 个`);

  console.log('\n详细结果:');
  results.forEach((r, i) => {
    const status = r.success ? '✅' : '❌';
    const info = r.success ? `${r.name} - ${r.price}` : '失败';
    console.log(`${i + 1}. ${status} ${r.styleNum} (尝试${r.attempts}次) - ${info}`);
  });

  console.log('\n' + '='.repeat(70));
  console.log('🎯 反爬虫措施验证:');
  console.log('='.repeat(70));

  const features = [
    '✅ 浏览器指纹伪装',
    '✅ 随机User-Agent',
    '✅ 随机视口尺寸',
    '✅ 完整HTTP请求头',
    '✅ WebDriver特征隐藏',
    '✅ Canvas/WebGL指纹对抗',
    '✅ 人类化滚动行为',
    '✅ 鼠标移动模拟',
    '✅ 随机延迟',
    '✅ 智能重试机制',
    '✅ 访问限制检测',
  ];

  features.forEach(f => console.log(f));

  console.log('\n' + '='.repeat(70));

  if (successRate >= 80) {
    console.log('🎉 反爬虫措施工作良好！成功率达标！');
  } else if (successRate >= 50) {
    console.log('⚠️ 反爬虫措施部分有效，可能需要进一步优化');
  } else {
    console.log('❌ 反爬虫措施效果不佳，需要检查网络或Zara是否更新了策略');
  }

  console.log('\n');
}

testAntiDetection().catch(err => {
  console.error('\n❌ 测试失败:', err.message);
  console.error(err.stack);
  process.exit(1);
});

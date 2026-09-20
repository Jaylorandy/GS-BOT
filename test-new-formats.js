/**
 * 测试新格式款号
 */

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

// 测试款号列表
const testStyles = [
  '1934/470/807',   // 带斜杠格式
  '7446/444/629',   // 带斜杠格式
  '406018400',      // 9位数字
  '5474/055/407',   // 带斜杠格式
  '7484/892/723',   // 带斜杠格式
  '0084074811',     // 10位数字
  '9632055756'      // 10位数字
];

// Zara URL 构建函数（当前逻辑）
function buildUrlOld(styleNum) {
  // 移除斜杠和空格，只保留数字
  const cleanNum = styleNum.replace(/[^0-9]/g, '');
  const pid = cleanNum.substring(0, 7).padStart(8, '0');
  return `https://www.zara.com/us/en/-p${pid}.html`;
}

// 新的 URL 构建函数尝试
function buildUrlNew(styleNum) {
  const cleanNum = styleNum.replace(/[^0-9]/g, '');

  // 尝试多种方式
  const attempts = [];

  // 方式1: 取前8位
  if (cleanNum.length >= 8) {
    attempts.push({
      method: '取前8位',
      url: `https://www.zara.com/us/en/-p${cleanNum.substring(0, 8)}.html`
    });
  }

  // 方式2: 取后8位
  if (cleanNum.length >= 8) {
    attempts.push({
      method: '取后8位',
      url: `https://www.zara.com/us/en/-p${cleanNum.substring(cleanNum.length - 8)}.html`
    });
  }

  // 方式3: 取前7位，补8位
  if (cleanNum.length >= 7) {
    attempts.push({
      method: '取前7位补8位',
      url: `https://www.zara.com/us/en/-p${cleanNum.substring(0, 7).padStart(8, '0')}.html`
    });
  }

  // 方式4: 取中间段（对于带斜杠的格式）
  const parts = styleNum.split('/');
  if (parts.length === 3) {
    attempts.push({
      method: '斜杠格式-中段',
      url: `https://www.zara.com/us/en/-p${parts[1].padStart(8, '0')}.html`
    });
  }

  // 方式5: 拼接所有部分
  if (parts.length === 3) {
    attempts.push({
      method: '斜杠格式-全拼接',
      url: `https://www.zara.com/us/en/-p${parts.join('').substring(0, 8)}.html`
    });
  }

  return attempts;
}

async function testStyle(styleNum) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`测试款号: ${styleNum}`);
  console.log(`${'='.repeat(60)}`);

  const cleanNum = styleNum.replace(/[^0-9]/g, '');
  console.log(`清理后的数字: ${cleanNum} (${cleanNum.length}位)`);

  // 测试旧逻辑
  const oldUrl = buildUrlOld(styleNum);
  console.log(`\n🔴 旧逻辑 URL: ${oldUrl}`);

  // 测试新逻辑
  const newAttempts = buildUrlNew(styleNum);
  console.log(`\n🟢 新逻辑尝试 (${newAttempts.length} 种):`);
  newAttempts.forEach((att, i) => {
    console.log(`  ${i+1}. [${att.method}]`);
    console.log(`     ${att.url}`);
  });

  // 实际测试第一个 URL（旧逻辑）
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();

    // 测试旧逻辑
    console.log(`\n📝 测试旧逻辑 URL...`);
    const response1 = await page.goto(oldUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
    const title1 = await page.title();
    const found1 = !title1.includes('Page Not Found') && !title1.includes('404') && response1.status() === 200;
    console.log(`   结果: ${found1 ? '✅ 找到' : '❌ 404'} (${response1.status()})`);
    console.log(`   标题: ${title1.substring(0, 60)}...`);

    // 测试新逻辑的每种方式
    console.log(`\n📝 测试新逻辑的各种 URL...`);
    for (let i = 0; i < Math.min(3, newAttempts.length); i++) {
      const att = newAttempts[i];
      console.log(`\n  ${i+1}. 测试 [${att.method}]...`);
      const response = await page.goto(att.url, { waitUntil: 'domcontentloaded', timeout: 10000 });
      const title = await page.title();
      const found = !title.includes('Page Not Found') && !title.includes('404') && response.status() === 200;
      console.log(`     结果: ${found ? '✅ 找到' : '❌ 404'} (${response.status()})`);
      console.log(`     标题: ${title.substring(0, 60)}...`);

      if (found) {
        console.log(`\n✅✅✅ 成功！款号 ${styleNum} 使用方法 [${att.method}]`);
        console.log(`   正确 URL: ${att.url}`);

        // 提取产品信息
        const info = await page.evaluate(() => {
          const h1 = document.querySelector('h1');
          return {
            name: h1 ? h1.textContent.trim() : '',
            url: window.location.href
          };
        });
        console.log(`   产品: ${info.name}`);
      }
    }

    await page.close();
  } catch (error) {
    console.error(`   错误: ${error.message}`);
  }

  await browser.close();
}

async function main() {
  console.log('========================================');
  console.log('Zara 新格式款号测试');
  console.log('========================================');

  for (const style of testStyles) {
    await testStyle(style);
    // 延迟避免请求过快
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log('\n========================================');
  console.log('测试完成');
  console.log('========================================');
}

main().catch(console.error);

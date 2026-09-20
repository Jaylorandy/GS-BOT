/**
 * 测试新格式款号 - 带反爬虫措施
 */

const puppeteer = require('puppeteer-core');
const fs = require('fs');

// 测试款号列表
const testStyles = [
  '1934/470/807',
  '7446/444/629',
  '406018400',
  '5474/055/407',
  '7484/892/723',
  '0084074811',
  '9632055756'
];

// URL 构建函数
function buildUrl(styleNum) {
  const cleanNum = styleNum.replace(/[^0-9]/g, '');
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

  // 方式4: 斜杠格式 - 取中段
  const parts = styleNum.split('/');
  if (parts.length === 3) {
    attempts.push({
      method: '斜杠-中段',
      url: `https://www.zara.com/us/en/-p${parts[1].padStart(8, '0')}.html`
    });
  }

  // 方式5: 斜杠格式 - 全拼接取前8位
  if (parts.length === 3) {
    attempts.push({
      method: '斜杠-全拼接',
      url: `https://www.zara.com/us/en/-p${parts.join('').substring(0, 8)}.html`
    });
  }

  return attempts;
}

async function testStyle(styleNum) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`测试款号: ${styleNum}`);
  console.log(`${'='.repeat(70)}`);

  const cleanNum = styleNum.replace(/[^0-9]/g, '');
  console.log(`清理后: ${cleanNum} (${cleanNum.length}位)`);

  const attempts = buildUrl(styleNum);
  console.log(`\n共 ${attempts.length} 种 URL 构建方式`);

  const browser = await puppeteer.launch({
    headless: false,
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--window-position=0,0',
      '--window-size=1920,1080'
    ],
    ignoreDefaultArgs: ['--enable-automation']
  });

  try {
    for (let i = 0; i < attempts.length; i++) {
      const { method, url } = attempts[i];
      console.log(`\n${i+1}. [${method}]`);
      console.log(`   URL: ${url}`);

      const page = await browser.newPage();
      await page.setViewport({ width: 1920, height: 1080 });
      await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

      // 反检测
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        window.chrome = { runtime: {} };
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      });

      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await new Promise(r => setTimeout(r, 2000));

      // 关闭 cookie 弹窗
      try {
        const btn = await page.$('#onetrust-accept-btn-handler');
        if (btn) {
          await btn.click();
          await new Promise(r => setTimeout(r, 500));
        }
      } catch (e) {}

      const title = await page.title();
      const status = response ? response.status() : 0;

      // 判断是否找到产品
      const is404 = title.includes('404') || title.includes('Not Found') || title.includes('Access Denied') || status === 404 || status === 403;
      const hasProduct = title.length > 10 && !is404 && status === 200;

      if (hasProduct) {
        console.log(`   ✅✅✅ 成功！找到产品页面`);
        console.log(`   状态: ${status}`);
        console.log(`   标题: ${title}`);

        // 提取产品信息
        const info = await page.evaluate(() => {
          const h1 = document.querySelector('h1');
          return {
            name: h1 ? h1.textContent.trim() : '',
            url: window.location.href
          };
        });
        console.log(`   产品: ${info.name}`);
        console.log(`\n✅ 款号 ${styleNum} 正确的构建方式: [${method}]`);
        console.log(`   正确 URL: ${url}`);

        // 保存成功的结果
        const result = {
          styleNum,
          method,
          url,
          productName: info.name
        };
        fs.appendFileSync('/Users/jaylorandy/zara-app/successful-urls.txt', JSON.stringify(result) + '\n', 'utf-8');

        await page.close();
        break; // 找到后就不用继续测试其他方式了
      } else {
        console.log(`   ❌ 未找到 (${status})`);
        console.log(`   标题: ${title.substring(0, 50)}...`);
        await page.close();
      }
    }
  } catch (error) {
    console.error(`错误: ${error.message}`);
  }

  await browser.close();
  await new Promise(r => setTimeout(r, 3000)); // 延迟避免被限流
}

async function main() {
  console.log('========================================');
  console.log('Zara 新格式款号测试 v2');
  console.log('========================================');

  // 清空之前的结果
  fs.writeFileSync('/Users/jaylorandy/zara-app/successful-urls.txt', '', 'utf-8');

  for (const style of testStyles) {
    await testStyle(style);
  }

  console.log('\n========================================');
  console.log('测试完成');
  console.log('========================================');

  // 输出总结
  console.log('\n✅ 成功的 URL 列表:');
  const results = fs.readFileSync('/Users/jaylorandy/zara-app/successful-urls.txt', 'utf-8').trim().split('\n').filter(Boolean);
  if (results.length > 0) {
    results.forEach(r => {
      const result = JSON.parse(r);
      console.log(`\n  款号: ${result.styleNum}`);
      console.log(`  方式: ${result.method}`);
      console.log(`  URL: ${result.url}`);
      console.log(`  产品: ${result.productName}`);
    });
  } else {
    console.log('  (没有找到任何成功的产品页面)');
  }
}

main().catch(console.error);

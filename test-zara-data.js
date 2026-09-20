const puppeteer = require('puppeteer-core');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: false,
    args: ['--no-sandbox']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

  // 测试一个款号
  const styleNum = '4772049620';
  const pid = styleNum.substring(styleNum.length - 8).padStart(8, '0');
  const url = `https://www.zara.com/us/en/-p${pid}.html`;

  console.log('访问URL:', url);

  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(resolve => setTimeout(resolve, 3000));

  // 查找内嵌的JSON数据
  const scriptData = await page.evaluate(() => {
    const scripts = document.querySelectorAll('script[type="application/ld+json"], script[type="application/json"], script:not([src])');
    const result = [];

    scripts.forEach(script => {
      const content = script.textContent;
      if (content && content.length > 100 && content.length < 50000 &&
          (content.includes('"image"') || content.includes('"id"') || content.includes('"product"'))) {
        result.push({
          type: script.type || 'text/javascript',
          length: content.length,
          contentPreview: content.substring(0, 500)
        });
      }
    });

    return result;
  });

  console.log('\n找到的脚本数据:');
  scriptData.forEach((data, i) => {
    console.log(`\n${i+1}. Type: ${data.type}, Length: ${data.length}`);
    console.log(`Preview: ${data.contentPreview.substring(0, 300)}...`);
  });

  // 尝试查找window对象中的产品数据
  const windowData = await page.evaluate(() => {
    const result = {};
    // 检查常见的全局变量
    const possibleKeys = ['__NEXT_DATA__', '__NUXT__', 'product', 'productData', 'appState'];
    possibleKeys.forEach(key => {
      if (window[key]) {
        try {
          const str = JSON.stringify(window[key]);
          result[key] = str.substring(0, 500);
        } catch (e) {
          result[key] = '(无法序列化)';
        }
      }
    });
    return result;
  });

  console.log('\n\n全局对象数据:');
  Object.entries(windowData).forEach(([key, val]) => {
    console.log(`\n${key}:\n${val.substring(0, 400)}...`);
  });

  // 监听网络请求，查找API调用
  const apiRequests = [];
  page.on('response', async (resp) => {
    const url = resp.url();
    if (url.includes('api') && url.includes('product')) {
      try {
        const text = await resp.text();
        if (text) {
          apiRequests.push({
            url: url,
            preview: text.substring(0, 500)
          });
        }
      } catch (e) {}
    }
  });

  await new Promise(resolve => setTimeout(resolve, 2000));
  await browser.close();

  console.log('\n\nAPI请求数据:');
  apiRequests.forEach((req, i) => {
    console.log(`\n${i+1}. ${req.url}`);
    console.log(`Preview: ${req.preview}`);
  });
})();

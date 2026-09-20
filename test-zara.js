const puppeteer = require('puppeteer-core');
const fs = require('fs');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: false,
    args: ['--no-sandbox']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });

  // 测试一个款号
  const styleNum = '4772049620';
  const pid = styleNum.substring(styleNum.length - 8).padStart(8, '0');
  const url = `https://www.zara.com/us/en/-p${pid}.html`;

  console.log('访问URL:', url);

  const capturedUrls = [];

  page.on('response', (resp) => {
    const reqUrl = resp.url();
    // 捕获所有jpg/webp图片
    if ((reqUrl.endsWith('.jpg') || reqUrl.includes('.webp')) &&
        !reqUrl.includes('transparent-background') &&
        !reqUrl.includes('w=66')) {
      capturedUrls.push(reqUrl);
    }
  });

  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

  console.log('抓取到的图片数量:', capturedUrls.length);
  console.log('前5个图片URL:');
  capturedUrls.slice(0, 5).forEach((u, i) => {
    console.log(`${i+1}. ${u}`);
  });

  await browser.close();
})();

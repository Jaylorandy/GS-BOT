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
  console.log('款号:', styleNum);
  console.log('PID:', pid);

  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(resolve => setTimeout(resolve, 3000));

  // 滚动页面以加载更多图片
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await new Promise(resolve => setTimeout(resolve, 2000));

  // 从DOM提取所有图片URL
  const allImages = await page.evaluate(() => {
    const result = [];
    const imgs = document.querySelectorAll('img');
    imgs.forEach(img => {
      const src = img.src || img.dataset.src || img.dataset.srcset;
      if (src && (src.includes('jpg') || src.includes('webp')) && src.includes('static.zara.net')) {
        result.push(src.split('?')[0]);
      }
    });
    return [...new Set(result)]; // 去重
  });

  console.log('\n找到的图片数量:', allImages.length);
  console.log('\n所有图片URL:');
  allImages.forEach((u, i) => {
    console.log(`${i+1}. ${u}`);
  });

  // 分析URL模式
  console.log('\n\nURL模式分析:');
  allImages.forEach(u => {
    const parts = u.split('/');
    const lastPart = parts[parts.length - 1];
    console.log(`文件名: ${lastPart}`);
  });

  await browser.close();
})();

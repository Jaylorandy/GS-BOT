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
  await new Promise(resolve => setTimeout(resolve, 2000));

  // 从DOM提取图片
  const images = await page.evaluate(() => {
    const result = [];
    // 查找所有img标签
    const imgs = document.querySelectorAll('img');
    imgs.forEach(img => {
      const src = img.src || img.dataset.src || img.dataset.srcset;
      if (src && (src.includes('jpg') || src.includes('webp'))) {
        result.push({
          src: src,
          alt: img.alt || '',
          class: img.className || ''
        });
      }
    });
    return result;
  });

  console.log('DOM中的图片数量:', images.length);
  console.log('前10个图片:');
  images.slice(0, 10).forEach((img, i) => {
    console.log(`${i+1}. ${img.src.substring(0, 100)}...`);
  });

  // 也检查一下是否有data属性的图片
  const dataImages = await page.evaluate(() => {
    const result = [];
    const elements = document.querySelectorAll('[data-src], [data-image-src]');
    elements.forEach(el => {
      const src = el.getAttribute('data-src') || el.getAttribute('data-image-src');
      if (src && (src.includes('jpg') || src.includes('webp'))) {
        result.push(src);
      }
    });
    return result;
  });

  console.log('\ndata-src中的图片数量:', dataImages.length);
  dataImages.slice(0, 5).forEach((u, i) => {
    console.log(`${i+1}. ${u.substring(0, 100)}...`);
  });

  await browser.close();
})();

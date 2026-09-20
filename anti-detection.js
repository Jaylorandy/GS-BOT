/**
 * 反爬虫检测增强模块
 * 提供多层反检测措施，提高抓取成功率
 */

// 随机User-Agent池
const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15',
];

// 随机视口尺寸
const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1680, height: 1050 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1366, height: 768 },
];

// 随机延迟函数（模拟人类行为）
function randomDelay(min = 1000, max = 3000) {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(resolve => setTimeout(resolve, delay));
}

// 获取随机User-Agent
function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// 获取随机视口
function getRandomViewport() {
  return VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)];
}

// 增强的浏览器启动参数
function getEnhancedLaunchArgs() {
  return [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
    '--disable-web-security',
    '--disable-features=IsolateOrigins,site-per-process',
    '--allow-running-insecure-content',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--no-zygote',
    '--disable-gpu',
    '--hide-scrollbars',
    '--mute-audio',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    `--window-size=${getRandomViewport().width},${getRandomViewport().height}`,
  ];
}

function getRetailLaunchArgs() {
  return [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    `--window-size=${getRandomViewport().width},${getRandomViewport().height}`,
  ];
}

// 完整的反检测脚本
async function applyAntiDetection(page) {
  // 1. 基础WebDriver隐藏
  await page.evaluateOnNewDocument(() => {
    // 隐藏webdriver属性
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false,
    });

    // 伪装chrome对象
    window.chrome = {
      runtime: {},
      loadTimes: function() {},
      csi: function() {},
      app: {},
    };

    // 伪装plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        {
          0: { type: "application/x-google-chrome-pdf", suffixes: "pdf", description: "Portable Document Format", enabledPlugin: Plugin },
          description: "Portable Document Format",
          filename: "internal-pdf-viewer",
          length: 1,
          name: "Chrome PDF Plugin"
        },
        {
          0: { type: "application/pdf", suffixes: "pdf", description: "", enabledPlugin: Plugin },
          description: "",
          filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai",
          length: 1,
          name: "Chrome PDF Viewer"
        },
        {
          0: { type: "application/x-nacl", suffixes: "", description: "Native Client Executable", enabledPlugin: Plugin },
          1: { type: "application/x-pnacl", suffixes: "", description: "Portable Native Client Executable", enabledPlugin: Plugin },
          description: "",
          filename: "internal-nacl-plugin",
          length: 2,
          name: "Native Client"
        }
      ],
    });

    // 伪装languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    });

    // 伪装permissions
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) => (
      parameters.name === 'notifications' ?
        Promise.resolve({ state: Notification.permission }) :
        originalQuery(parameters)
    );

    // 覆盖Date对象的getTimezoneOffset
    const originalGetTimezoneOffset = Date.prototype.getTimezoneOffset;
    Date.prototype.getTimezoneOffset = function() {
      return -300; // EST timezone
    };

    // 伪装canvas指纹
    const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(type) {
      if (type === 'image/png' && this.width === 280 && this.height === 60) {
        return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      }
      return originalToDataURL.apply(this, arguments);
    };

    // 伪装WebGL指纹
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
      if (parameter === 37445) {
        return 'Intel Inc.';
      }
      if (parameter === 37446) {
        return 'Intel Iris OpenGL Engine';
      }
      return getParameter.apply(this, arguments);
    };

    // 移除自动化特征
    delete navigator.__proto__.webdriver;

    // 伪装battery API
    if (navigator.getBattery) {
      navigator.getBattery = () => Promise.resolve({
        charging: true,
        chargingTime: 0,
        dischargingTime: Infinity,
        level: 1,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => true,
      });
    }

    // 伪装connection
    Object.defineProperty(navigator, 'connection', {
      get: () => ({
        effectiveType: '4g',
        rtt: 50,
        downlink: 10,
        saveData: false,
      }),
    });

    // 伪装hardwareConcurrency
    Object.defineProperty(navigator, 'hardwareConcurrency', {
      get: () => 8,
    });

    // 伪装deviceMemory
    Object.defineProperty(navigator, 'deviceMemory', {
      get: () => 8,
    });

    // 伪装maxTouchPoints
    Object.defineProperty(navigator, 'maxTouchPoints', {
      get: () => 0,
    });
  });

  // 2. 设置额外的请求头
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-User': '?1',
    'Sec-Fetch-Dest': 'document',
    'Upgrade-Insecure-Requests': '1',
  });

  // 3. 设置真实的浏览器特征
  await page.evaluateOnNewDocument(() => {
    // 设置屏幕分辨率
    Object.defineProperty(screen, 'width', { get: () => 1920 });
    Object.defineProperty(screen, 'height', { get: () => 1080 });
    Object.defineProperty(screen, 'availWidth', { get: () => 1920 });
    Object.defineProperty(screen, 'availHeight', { get: () => 1055 });
    Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
    Object.defineProperty(screen, 'pixelDepth', { get: () => 24 });
  });
}

async function applyRetailBrowsingProfile(page) {
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false,
    });

    if (!window.chrome) {
      window.chrome = { runtime: {} };
    }

    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    });

    const originalQuery = window.navigator.permissions?.query;
    if (originalQuery) {
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters)
      );
    }
  });
}

// 模拟人类滚动行为
async function humanScroll(page, distance = null) {
  let scrollDistance = distance;
  try {
    if (!scrollDistance) {
      scrollDistance = await page.evaluate(() => document.body.scrollHeight);
    }
  } catch {
    return; // context gone — nothing to scroll
  }

  // Guard against pathological / infinite-growth pages (a throttled or
  // lazy-loading page can report a scrollHeight of hundreds of thousands of
  // px, which would turn this into a multi-minute "infinite" scroll). Cap the
  // height, the step count, and the wall-clock time, and bail out the moment a
  // navigation destroys the context.
  scrollDistance = Math.min(Number(scrollDistance) || 0, 40000);
  if (scrollDistance <= 0) return;

  const maxSteps = 60;
  const stepSize = Math.max(100, Math.ceil(scrollDistance / maxSteps));
  const steps = Math.min(maxSteps, Math.ceil(scrollDistance / stepSize));
  const startedAt = Date.now();

  for (let i = 0; i < steps; i++) {
    if (Date.now() - startedAt > 20000) break; // hard 20s wall-clock guard
    const scrollY = Math.min((i + 1) * stepSize, scrollDistance);
    try {
      // eslint-disable-next-line no-await-in-loop
      await page.evaluate((y) => { window.scrollTo(0, y); }, scrollY);
    } catch {
      break; // navigation destroyed the context — stop instead of hanging
    }
    // 随机停顿，模拟阅读
    // eslint-disable-next-line no-await-in-loop
    await randomDelay(80, 200);
  }
}

// 模拟鼠标移动
async function simulateMouseMovement(page) {
  await page.evaluate(() => {
    const event = new MouseEvent('mousemove', {
      view: window,
      bubbles: true,
      cancelable: true,
      clientX: Math.random() * window.innerWidth,
      clientY: Math.random() * window.innerHeight,
    });
    document.dispatchEvent(event);
  });
}

// 智能重试函数
async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 2000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      
      const delay = baseDelay * Math.pow(2, i) + Math.random() * 1000;
      console.log(`重试 ${i + 1}/${maxRetries}，等待 ${Math.round(delay)}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

// 检测是否被封禁
async function detectBlocking(page) {
  const indicators = await page.evaluate(() => {
    const bodyText = document.body.innerText.toLowerCase();
    return {
      hasCaptcha: bodyText.includes('captcha') || bodyText.includes('verify'),
      hasAccessDenied: bodyText.includes('access denied') || bodyText.includes('forbidden'),
      hasRateLimit: bodyText.includes('rate limit') || bodyText.includes('too many requests'),
      is404: bodyText.includes('404') || bodyText.includes('not found'),
    };
  });

  return Object.values(indicators).some(v => v);
}

module.exports = {
  randomDelay,
  getRandomUserAgent,
  getRandomViewport,
  getEnhancedLaunchArgs,
  getRetailLaunchArgs,
  applyAntiDetection,
  applyRetailBrowsingProfile,
  humanScroll,
  simulateMouseMovement,
  retryWithBackoff,
  detectBlocking,
};

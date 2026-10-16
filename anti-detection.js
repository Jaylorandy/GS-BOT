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

// @deprecated 2026-10-14 — 不要再用于抓取。在用户本机的真实 Chrome 上覆盖 UA 会
// 连带抹掉 userAgentData（UA-CH），使 UA 字符串与真实引擎版本互相矛盾，反而成为
// 伪造证据。实测依据：H&M 路径（main.js 的 scrapeHmProduct）曾因此被 Akamai 直接
// 返回 Access Denied，移除覆盖后恢复。池内的 Chrome 120-122 / Safari 17.x 也已远
// 落后于当前本机 Chrome。保留定义仅为兼容旧测试脚本。
// 获取随机User-Agent
function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// 获取随机视口
function getRandomViewport() {
  return VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)];
}

// @deprecated 2026-10-14 — 不要再使用。这里的 --disable-web-security、
// --disable-features=IsolateOrigins,site-per-process、--no-zygote、--disable-gpu、
// --disable-accelerated-2d-canvas 都会改变真实浏览器的指纹与渲染行为，真实用户
// 不可能处于这种状态。请统一改用 getRetailLaunchArgs()。保留仅为兼容旧测试脚本。
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

// @deprecated 2026-10-14 — 不要再用在抓取路径上（main.js 已全部移除调用）。函数内
// 每一处 patch 都会留下真实 Chrome 不具备的痕迹，理由见下方 applyRetailBrowsingProfile
// 上方 2026-10-12 的实测记录：改写 webdriver / languages / permissions.query 会改变
// own-property descriptor 与 toString()；伪造 plugins / screen / connection / battery /
// WebGL / canvas 会与真实 GPU、字体、时区互相矛盾；setExtraHTTPHeaders 手动覆盖
// Sec-Fetch-* 也不是真实 Chrome 的行为。
// 正确做法是 applyRetailBrowsingProfile()：只补真实浏览器可能缺失的缺口。
// 保留定义仅为兼容旧测试脚本（test-anti-detection.js / test-composition-separation.js
// / diagnose-style.js）。
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

// 2026-10-12: this used to patch navigator.webdriver / navigator.languages and
// replace window.navigator.permissions.query. Measured on Chrome 154 (same
// machine, same launch args, patch ON vs OFF) every one of those patches left a
// fingerprint that a genuine browser never exposes:
//   • Object.getOwnPropertyDescriptor(navigator, 'webdriver') returned a
//     function `() => false`, while a real Chrome returns undefined (the
//     property lives on Navigator.prototype as a native getter);
//   • navigator.languages was forced to ['en-US','en'] on a zh-CN system,
//     contradicting the UA / timezone;
//   • permissions.query.toString() became `(parameters) => …` instead of
//     `function query() { [native code] }`.
// `--disable-blink-features=AutomationControlled` already makes
// navigator.webdriver === false, so the webdriver patch was redundant as well as
// detectable. Leaving the browser's own identity untouched is both cleaner and
// closer to the self-consistent identity these probes are meant to pass.
async function applyRetailBrowsingProfile(page) {
  await page.evaluateOnNewDocument(() => {
    // Only ever fill a *gap*: a genuine Chrome already exposes window.chrome, so
    // this branch is a no-op there and never replaces a populated object with an
    // empty shell.
    if (!window.chrome) {
      window.chrome = { runtime: {} };
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
      await page.evaluate((y) => { window.scrollTo(0, y); }, scrollY);
    } catch {
      break; // navigation destroyed the context — stop instead of hanging
    }
    // 随机停顿，模拟阅读
    await randomDelay(80, 200);
  }
}

// 模拟鼠标移动（合成事件版，isTrusted=false）。
// 已弃用：新代码请用 humanMoveMouse / humanClick。它们走 CDP Input 域，事件
// isTrusted 为真且带真实轨迹。保留定义仅为兼容 test-anti-detection.js 等旧脚本。
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

// ── 人形指针输入 ──────────────────────────────────────────────────────────
// 页面内合成点击（page.evaluate 里的 el.click()）只产生一个 isTrusted:false
// 的 click 事件，既没有配对的 pointerdown/pointerup，也没有接近过程中的任何
// mousemove —— 与真实输入极易区分。下面两个函数改走 CDP Input 域，事件全部
// isTrusted，并把接近路径塑造成随机三次贝塞尔曲线，使相邻采样点之间具有真实的
// 轨迹熵，而不是一次瞬移。
//
// 实测（puppeteer-core 24.43.1 / Chrome 141）：一次 humanClick 约 250-400ms，
// 原生 handle.click() 约 0-80ms。设 GSBOT_HUMAN_POINTER=0 可全局关闭并直接回
// 落到原生点击，这就是 A/B 对照与回滚用的逃生开关。
const POINTER_DISABLED = process.env.GSBOT_HUMAN_POINTER === '0';

// 每个页面记录指针最后落点：真实鼠标不会在两次操作之间瞬移，贝塞尔起点必须
// 接上一次的终点，否则第一条轨迹会从 (0,0) 突然横跨整屏。
const pointerState = new WeakMap();

function pointerAt(page) {
  const p = pointerState.get(page);
  if (p) return p;
  // puppeteer 的鼠标初始位置就是 (0,0)，保持一致可避免首帧出现跳跃。
  const init = { x: 0, y: 0, scrollY: 0 };
  pointerState.set(page, init);
  return init;
}

// 落点必须随页面滚动一起换算：元素 scrollIntoView 之后，同一个屏幕位置的视口
// 坐标就变了，不补偿的话下一条轨迹的起点会落在错误的坐标上，表现为一次横跨整
// 屏的跳跃 —— 而真实用户滚动页面后移动鼠标时，屏幕位置是连续的。
async function pointerFrom(page) {
  const raw = pointerAt(page);
  let env = null;
  try {
    env = await page.evaluate(() => ({
      scrollY: window.scrollY, w: window.innerWidth, h: window.innerHeight,
    }));
  } catch { /* context gone — page navigating */ }
  if (!env) return { x: raw.x, y: raw.y, scrollY: raw.scrollY, vw: null, vh: null };
  const shifted = raw.scrollY == null ? raw.y : raw.y + (raw.scrollY - env.scrollY);
  return { x: raw.x, y: shifted, scrollY: env.scrollY, vw: env.w, vh: env.h };
}

function cubicPoint(p0, c1, c2, p3, t) {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * c1.x + c * c2.x + d * p3.x,
    y: a * p0.y + b * c1.y + c * c2.y + d * p3.y,
  };
}

// 瞄准元素内部而非正中心，并避开边框：每次都落在同一像素本身就是指纹。
// 元素若不在视口内，CDP 会把坐标钳制到视口边界，点击就会落到别的元素上 ——
// 所以这种情况必须返回 null，让 humanClick 回退到原生点击，而不是点错地方。
async function elementAimPoint(handle) {
  const geom = await handle.evaluate((el) => {
    if (!el || typeof el.getBoundingClientRect !== 'function') return null;
    if (typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'center', inline: 'center' });
    }
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height, vw: window.innerWidth, vh: window.innerHeight };
  }).catch(() => null);
  if (!geom || geom.w <= 0 || geom.h <= 0) return null;
  if (geom.x + geom.w <= 0 || geom.y + geom.h <= 0 || geom.x >= geom.vw || geom.y >= geom.vh) return null;
  const insetX = Math.min(geom.w * 0.22, 10);
  const insetY = Math.min(geom.h * 0.22, 7);
  const usableW = Math.max(1, geom.w - insetX * 2);
  const usableH = Math.max(1, geom.h - insetY * 2);
  return {
    x: Math.round(geom.x + insetX + Math.random() * usableW),
    y: Math.round(geom.y + insetY + Math.random() * usableH),
  };
}

async function resolveAimPoint(page, target) {
  if (!target) return null;
  if (typeof target === 'string') {
    const handle = await page.$(target).catch(() => null);
    return handle ? elementAimPoint(handle) : null;
  }
  if (typeof target.boundingBox === 'function') return elementAimPoint(target);
  if (typeof target.x === 'number' && typeof target.y === 'number') {
    return { x: Math.round(target.x), y: Math.round(target.y) };
  }
  return null;
}

// 沿贝塞尔弧线靠近任意目标点。返回实际到达的点；无法解析目标时返回 null。
// target 支持：CSS 选择器 / ElementHandle / {x,y}。
async function humanMoveMouse(page, target, opts = {}) {
  if (POINTER_DISABLED) return null;
  const to = await resolveAimPoint(page, target);
  if (!to) return null;
  const from = await pointerFrom(page);

  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const points = Math.max(
    opts.minPoints ?? 10,
    Math.min(opts.maxPoints ?? 28, Math.round(dist / 26)),
  );
  const stepMin = opts.stepMin ?? 5;
  const stepMax = opts.stepMax ?? 15;

  // 路径向侧向鼓起；鼓度随距离缩放 —— 短距离近乎直线，长距离明显弯曲。
  const bow = Math.min(70, dist * 0.18) * (Math.random() < 0.5 ? -1 : 1);
  const nx = dist === 0 ? 0 : -(to.y - from.y) / dist;
  const ny = dist === 0 ? 0 : (to.x - from.x) / dist;
  const jitter = () => (Math.random() - 0.5) * 18;
  const c1 = {
    x: from.x + (to.x - from.x) * 0.3 + nx * bow + jitter(),
    y: from.y + (to.y - from.y) * 0.3 + ny * bow + jitter(),
  };
  const c2 = {
    x: from.x + (to.x - from.x) * 0.72 + nx * bow * 0.7 + jitter(),
    y: from.y + (to.y - from.y) * 0.72 + ny * bow * 0.7 + jitter(),
  };

  for (let i = 1; i <= points; i++) {
    const t = i / points;
    const p = cubicPoint(from, c1, c2, to, t);
    try {
      await page.mouse.move(Math.round(p.x), Math.round(p.y));
    } catch {
      return null; // 移动途中页面已导航
    }
    if (i < points) await randomDelay(stepMin, stepMax);
  }
  // CDP 会把超出视口的坐标钳制到边界，所以落点必须记录「实际到过的位置」而非
  // 意图坐标，否则下一条轨迹会从一个鼠标从未在过的点出发。
  const clamp = (v, max) => (max == null ? v : Math.min(Math.max(v, 0), Math.max(0, max)));
  pointerState.set(page, {
    x: clamp(to.x, from.vw),
    y: clamp(to.y, from.vh),
    scrollY: from.scrollY,
  });
  return to;
}

// 先像人一样移动，再经 CDP Input 域按下，使元素收到完整的
// pointerover -> pointerdown -> focus -> pointerup -> click 序列。
// 目标无法瞄准（不可见 / 已 detach / 被遮挡）时回退到原生点击，
// 因此没有任何调用点会失去它原本能点到的元素。
async function humanClick(page, target, opts = {}) {
  const nativeOpts =
    opts.native || (opts.delay != null ? { delay: opts.delay } : {});

  if (POINTER_DISABLED) {
    if (typeof target === 'string') await page.click(target);
    else await target.click(nativeOpts);
    return true;
  }

  const reached = await humanMoveMouse(page, target, opts);
  if (!reached) {
    if (typeof target === 'string') await page.click(target);
    else await target.click(nativeOpts);
    return true;
  }

  await randomDelay(opts.hesitateMin ?? 30, opts.hesitateMax ?? 110);
  await page.mouse.down({ button: opts.button || 'left' });
  await randomDelay(opts.holdMin ?? 40, opts.holdMax ?? 120);
  await page.mouse.up({ button: opts.button || 'left' });
  return true;
}

// ---------------------------------------------------------------------------
// 真人键盘输入
//
// `page.keyboard.type()` 底层是 CDP `Input.dispatchKeyEvent`（rawKeyDown / char /
// keyUp），由浏览器进程派发 → isTrusted:true，页面侧与真人敲键同构。相比之下
// `el.value = x` + `dispatchEvent(new Event('input'))` 会产生「value 变了、却零
// 按键序列」这一**强自动化特征** —— 正是要消除的东西。
//
// 但真按键会被 React 受控输入 / autocomplete debounce / 抢焦点的弹窗吃掉
// （历史上表现为「只输入了第一位数字」），所以本函数**输入后必须回验 value**；
// 返回 false 时由调用方回退到 DOM 直写。可靠性优先于洁癖：输不进比不够像人更糟。
// ---------------------------------------------------------------------------
const TYPING_DISABLED = process.env.GSBOT_HUMAN_TYPING === '0';

// 把 CSS 选择器 / ElementHandle / 页内 evaluateHandle 统一解析成元素句柄。
// owned=true 表示句柄由本函数创建，用完需要 dispose；调用方传入的句柄不接管。
//
// ⚠️ 字符串选择器**不能**用 `page.$(sel)`：本项目给 puppeteer-core 打了
// rebrowser 补丁（延迟/按需创建 isolated world），`page.$()` 内部的
// `IsolatedWorld.adoptBackendNode` 会抛
// `Protocol error (DOM.resolveNode): Node with given id does not belong to the document`
// （实测 Chrome 155 + puppeteer-core 24.43.1，稳定复现）。
// `page.evaluateHandle()` 在 main world 直接取 remote object，不做 adopt，故安全 ——
// 本项目既有的 clickInPage/clickFirstInPage 一直用 evaluateHandle，也是这个道理。
async function resolveElementHandle(page, target) {
  if (!target) return { handle: null, owned: false };
  if (typeof target === 'string') {
    const h = await page.evaluateHandle((sel) => document.querySelector(sel), target).catch(() => null);
    if (!h) return { handle: null, owned: false };
    const el = h.asElement();
    if (!el) { await h.dispose().catch(() => {}); return { handle: null, owned: false }; }
    return { handle: el, owned: true };
  }
  if (typeof target.asElement === 'function') {
    // ElementHandle.asElement() 返回自身；页内 evaluateHandle 若是 null/非元素则返回 null
    return { handle: target.asElement(), owned: false };
  }
  if (typeof target.evaluate === 'function') return { handle: target, owned: false };
  return { handle: null, owned: false };
}

// 全选修饰键按平台取一个：Windows/Linux 用 Control，macOS 用 Meta。
// （同时发两个在 Windows 上会让 Win+A 落到系统层。）
const SELECT_ALL_MODIFIER = process.platform === 'darwin' ? 'Meta' : 'Control';

async function humanType(page, target, text, opts = {}) {
  const want = String(text ?? '');
  if (TYPING_DISABLED) return false;

  const { handle, owned } = await resolveElementHandle(page, target);
  if (!handle) return false;

  try {
    // focus 必须真的落在目标元素上，否则 CDP 按键会打到别处
    // （最坏情况：Ctrl+A 作用到整页文档上）
    const focused = await handle.evaluate((el) => {
      if (!el || typeof el.focus !== 'function') return false;
      try { el.focus(); } catch { /* noop */ }
      return document.activeElement === el;
    }).catch(() => false);
    if (!focused) return false;

    if (opts.clear !== false) {
      await page.keyboard.down(SELECT_ALL_MODIFIER).catch(() => {});
      await page.keyboard.press('A').catch(() => {});
      await page.keyboard.up(SELECT_ALL_MODIFIER).catch(() => {});
      await page.keyboard.press('Backspace').catch(() => {});
      await randomDelay(60, 140);
    }

    await page.keyboard.type(want, { delay: opts.delay ?? 90 });
    await randomDelay(opts.verifyDelayMin ?? 120, opts.verifyDelayMax ?? 220);

    // 回验：受控输入可能在打字中途把 value 重置，这里必须实测
    const ok = await handle.evaluate((el, w) => Boolean(el && el.value === w), want).catch(() => false);
    return ok === true;
  } finally {
    if (owned && handle) await handle.dispose().catch(() => {});
  }
}

// 一次最多点几个。这是一个防止选择器写错就狂点整页的**安全上限**，不是节流策略：
// cookie 同意框这类批量遍历偶尔会匹配到十几个元素，但人形点击每次要 300-600ms，
// 无上限会让一次遍历卡住十几秒。20 足以覆盖「展开页面上所有折叠面板」这类真实
// 需求，又不会因为一个过宽的选择器把整页按钮点一遍。
const CLICK_IN_PAGE_MAX = 20;

// 在页面上下文里挑选元素，再用真人方式逐个点击。
// picker 在页面内执行，返回**单个元素**或**元素数组**；其余返回值视为没有候选。
// 注意 humanClick 失败（元素不可见 / 被遮挡 / 已 detach）时会退回页内合成点击 ——
// 反爬之外的「点得到」这件事优先级更高，不能因为改成人形点击就让 cookie 框关不掉。
// 返回实际点击的元素个数。
async function clickInPage(page, picker, ...args) {
  const handle = await page.evaluateHandle(picker, ...args).catch(() => null);
  if (!handle) return 0;

  // picker 可能返回单个元素也可能返回数组，evaluateHandle 对两者都只给回一个
  // JSHandle，只有 asElement() 能区分。
  let candidates = [];
  const direct = handle.asElement();
  if (direct) {
    candidates = [direct];
  } else {
    const props = await handle.getProperties().catch(() => null);
    if (props) {
      for (const v of props.values()) {
        const el = v.asElement();
        if (el) candidates.push(el);
      }
    }
  }
  candidates = candidates.slice(0, CLICK_IN_PAGE_MAX);

  let clicked = 0;
  try {
    for (const el of candidates) {
      try {
        await humanClick(page, el);
      } catch {
        await el.evaluate((n) => n.click()).catch(() => {});
      }
      clicked += 1;
      await randomDelay(140, 340);
    }
  } finally {
    for (const el of candidates) await el.dispose().catch(() => {});
    await handle.dispose().catch(() => {});
  }
  return clicked;
}

// clickInPage 的单目标版本：点第一个匹配的元素，并返回它的可见文本（供日志用）。
async function clickFirstInPage(page, picker, ...args) {
  const handle = await page.evaluateHandle(picker, ...args).catch(() => null);
  if (!handle) return '';
  const el = handle.asElement();
  if (!el) { await handle.dispose().catch(() => {}); return ''; }
  const label = await el.evaluate((n) => String(n.textContent || '').trim().slice(0, 40)).catch(() => '');
  try {
    await humanClick(page, el);
  } catch {
    await el.evaluate((n) => n.click()).catch(() => {});
  } finally {
    await el.dispose().catch(() => {});
  }
  return label;
}

// 在页面内挑元素并用真人方式点击，**同时**把元素相关的数据带回 Node 侧。
// 专为「点完之后还要用被点元素的数据」的站点准备 —— 例如商品列表页：
// 点第一张匹配 SKU 的卡片跳转 PDP，同时必须回报它的 href 和候选数量用于日志与
// 重试判断。这类站点没法直接换成 clickInPage，因为返回值被调用方消费。
//
// picker 在页面上下文执行，返回 { el, info }：
//   el   要点击的元素；为 null / undefined 表示本轮没有候选，则不点击（不报错）
//   info 需要带回 Node 侧的可序列化数据（href / pass / candidates / snippet ...）
// 只返回元素本身也可以（等价于 info 为 null）。
// 元素无法人形点击时回退页内合成点击 —— 「点得到」优先级高于反爬。
// 返回 info。
async function pickInPage(page, picker, ...args) {
  const handle = await page.evaluateHandle(picker, ...args).catch(() => null);
  if (!handle) return null;

  const direct = handle.asElement();
  let el = direct;
  let info = null;
  if (!direct) {
    const props = await handle.getProperties().catch(() => null);
    if (props) {
      const elH = props.get('el');
      const infoH = props.get('info');
      if (elH) el = elH.asElement();
      // 元素句柄要么马上用、要么在这里释放；数据句柄读完 jsonValue 就释放。
      if (infoH) {
        info = await infoH.jsonValue().catch(() => null);
        await infoH.dispose().catch(() => {});
      }
      if (elH && !el) await elH.dispose().catch(() => {});
    }
  }

  try {
    if (el) {
      try {
        await humanClick(page, el);
      } catch {
        await el.evaluate((n) => n.click()).catch(() => {});
      }
    }
  } finally {
    if (el && el !== handle) await el.dispose().catch(() => {});
    await handle.dispose().catch(() => {});
  }
  return info;
}

/**
 * `page.$(selector)` 的替代实现 —— 绕开本项目里**坏掉的 CDP adopt 路径**。
 *
 * 背景（实测，非推测）：本项目给 puppeteer-core 打了 rebrowser 补丁，核心目的是
 * 不发 CDP `Runtime.enable`（它有指纹价值）。代价是 FrameManager 只能手工种一个
 * `id: -1` 的 main world context；而每次导航都会把 isolated world 的 id 清成 `-2`。
 * 补丁只在 `ExecutionContext.#evaluate` 里补了「id < 0 时重新获取」，但
 * `IsolatedWorld.adoptBackendNode`（`page.$` / `page.$$` / `$eval` / `$$eval` /
 * `waitForSelector` / `elementHandle.$` 的必经之路）会把这个 `-2` 原样当
 * `executionContextId` 发给 `DOM.resolveNode`，Chrome 直接回：
 *   Protocol error (DOM.resolveNode): Node with given id does not belong to the document
 *
 * 实测对照（Chrome 152 / puppeteer-core 24.43.1，每组独立 page）：
 *   goto 之后 isolatedWorld.id 恒为 -2；
 *   page.$ / page.$$ / page.$eval / page.$$eval → 全部抛错，且**连续调用不自愈**；
 *   page.evaluate / evaluateHandle / waitForFunction → 走 main realm，修不了它；
 *   只有 waitForSelector（或直接 `frame.isolatedRealm().evaluate()`）能把它推回真实值。
 *
 * `page.evaluateHandle` 走 main world 拿 remote object，完全不经过 adoptBackendNode，
 * 因此不受影响。返回的句柄可照常交给 humanClick / evaluate / scrollIntoView 使用。
 *
 * 返回 null 而非抛错 —— 与原 `page.$` 的「未命中」语义一致，调用方无需 try/catch。
 */
async function queryOne(page, selector) {
  const sel = String(selector || '');
  if (!sel) return null;
  const handle = await page
    .evaluateHandle((s) => document.querySelector(s), sel)
    .catch(() => null);
  if (!handle) return null;
  const el = typeof handle.asElement === 'function' ? handle.asElement() : null;
  if (!el) {
    await handle.dispose().catch(() => {});
    return null;
  }
  return el;
}

/** `page.$$(selector)` 的替代实现；语义同 queryOne，返回元素句柄数组（已剔除 length 等非元素句柄）。 */
async function queryAll(page, selector) {
  const sel = String(selector || '');
  if (!sel) return [];
  const handle = await page
    .evaluateHandle((s) => Array.from(document.querySelectorAll(s)), sel)
    .catch(() => null);
  if (!handle) return [];
  const out = [];
  try {
    const props = await handle.getProperties().catch(() => null);
    if (props) {
      for (const v of props.values()) {
        const el = typeof v.asElement === 'function' ? v.asElement() : null;
        if (el) out.push(el);
        else await v.dispose().catch(() => {});
      }
    }
  } finally {
    await handle.dispose().catch(() => {});
  }
  return out;
}

/**
 * `elementHandle.isIntersectingViewport()` 的替代实现。
 *
 * 为什么不能直接用：该方法被 puppeteer 的 `bindIsolatedHandle` 装饰器包着，
 * 装饰器第一步就是 `frame.isolatedRealm().adoptHandle(this)` —— 撞的是查询句柄那套
 * 同一个坏掉的 adopt 路径（详见 queryOne 的注释）。实测即使句柄本身已经取到手，
 * 调用它仍会抛 `DOM.resolveNode: Node ... does not belong to the document`。
 *
 * ElementHandle 上**没有**被 `bindIsolatedHandle` 装饰的只有 `evaluate()` 一族
 * （见 puppeteer api/ElementHandle.js 的装饰器清单），所以这里直接用页内
 * getBoundingClientRect 判断视口相交 —— 与 isIntersectingViewport 语义一致，
 * 并顺带排除零尺寸元素。
 *
 * 与 humanClick 的关系：humanClick 内部会先 scrollIntoView 再取点，所以元素只要在
 * 文档里就点得到。本函数只用于「候选选择器里筛掉隐藏元素」。
 */
async function isInViewport(handle) {
  return await handle.evaluate((el) => {
    if (!el || typeof el.getBoundingClientRect !== 'function') return false;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    return r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
  }).catch(() => true);
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
  humanMoveMouse,
  humanClick,
  clickInPage,
  clickFirstInPage,
  pickInPage,
  queryOne,
  queryAll,
  isInViewport,
  humanType,
  simulateMouseMovement,
  retryWithBackoff,
  detectBlocking,
};

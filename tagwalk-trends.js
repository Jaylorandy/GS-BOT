'use strict';
/**
 * Trends Dashboard · Tagwalk 采集核心
 * ════════════════════════════════════════════════════════════════════════
 * 纯 Node（无浏览器 / 无 puppeteer）。Tagwalk 对常规桌面 UA 直连 200，
 * 图片 CDN 也直连（实测 cover 75KB / thumb 36KB，均 200 image/jpeg）。
 *
 * 两层结构（均为 SSR，HTML 里直接有数据）：
 *   1. 季节清单  GET /zh/trends
 *                → <a href="/zh/trends/{woman|man}/{slug}"><div class="collections-card">
 *                  文字即人类可读季节名（"Resort 2027" / "Fall/Winter 2026"）
 *                  实测一次给出 40 季：女装 20（SS27→FW21）+ 男装 20（SS27→FW17）
 *   2. 关键词    GET /zh/trends/{woman|man}/{slug}
 *                → 每张 <a href="/zh/look/search?..."> 包一个 <div class="trend-card">：
 *                    <h3>pattern mix</h3>              关键词
 *                    <h6>See all pattern mix looks</h6>  副标题（固定句式，不用）
 *                    <div class="trend-card-info-hover">
 *                      <h6>DOLCE & GABBANA</h6>          代表品牌
 *                      <h6>SPRING/SUMMER 2027 - Look 17</h6> 季节 + look 号
 *                    <img src=".../cover/xxx.jpg" alt="pattern mix">
 *                  卡片顺序 = Tagwalk 的热度排序，直接当 rank 用
 *
 * 🔴 关键坑（实测）：
 *   - 季节 slug 年份位数不统一：`spring-summer-2027` 但 `resort-27`
 *     → 年份只能 `len===2 ? 2000+n : n`
 *   - 季节 slug 前缀可能是两段（`pre-fall`）→ 不能用 split('-')[0] 取前缀
 *   - `/zh/trends/{woman|man}`（只带性别）会 302 回首页，**不是**季节列表
 *   - 页面里另有一批 `trends/...` 锚点（首页 hero 的 4 个），
 *     **只有带 `collections-card` 的才是季节卡**，否则会重复/混入
 *   - 同一季的图有 5 档 srcset（fit_cover 各尺寸），原图在 `/cover/<file>.jpg`
 *     → 缩略图自己拼 `custom,fit_cover,height_541,width_361/<file>.jpg`
 *   - robots.txt：除 `/api` 外全允许，但要求 `Crawl-delay: 2`
 *     → 所有请求走串行队列，强制间隔 ≥2.1s
 * ════════════════════════════════════════════════════════════════════════
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const SITE = 'https://www.tag-walk.com';
const CDN = 'https://cdn.tag-walk.com';
const INDEX_PATH = '/zh/trends';

/** robots.txt 要求 Crawl-delay: 2 —— 留 100ms 余量，串行队列保证不并发 */
const MIN_GAP_MS = 2100;
let lastRequestAt = 0;
let queue = Promise.resolve();

const GENDERS = {
  woman: { key: 'woman', label: 'Womenswear', labelZh: '女装' },
  man: { key: 'man', label: 'Menswear', labelZh: '男装' },
};

const SEASON_PREFIX_LABEL = {
  'spring-summer': 'Spring/Summer',
  'fall-winter': 'Fall/Winter',
  resort: 'Resort',
  'pre-fall': 'Pre-Fall',
};

const SEASON_QUARTER = {
  'spring-summer': 'SS',
  'fall-winter': 'FW',
  resort: 'Resort',
  'pre-fall': 'Pre-Fall',
};

// ── 工具 ────────────────────────────────────────────────────────────────
function decodeEntities(value) {
  return String(value)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function stripTags(value) {
  return decodeEntities(String(value).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * slug → 季节元信息。
 * `spring-summer-2027` → { prefix:'spring-summer', year:2027, quarter:'SS', label:'Spring/Summer 2027' }
 * `resort-27`          → { prefix:'resort',        year:2027, quarter:'Resort', label:'Resort 2027' }
 */
function seasonMeta(slug) {
  const raw = String(slug || '').trim();
  const m = raw.match(/^(.*?)-(\d{2}|\d{4})$/);
  if (!m) return { slug: raw, prefix: raw, year: 0, quarter: '', label: raw, sortYear: 0 };
  const prefix = m[1];
  const yearNum = Number(m[2]);
  const year = m[2].length === 2 ? 2000 + yearNum : yearNum;
  return {
    slug: raw,
    prefix,
    year,
    quarter: SEASON_QUARTER[prefix] || prefix,
    label: `${SEASON_PREFIX_LABEL[prefix] || prefix} ${year}`,
    sortYear: year,
  };
}

// ── HTTP（串行 + 最小间隔，遵守 Crawl-delay） ─────────────────────────────
async function throttledFetch(url, { timeoutMs = 40000, retries = 2 } = {}) {
  const task = queue.then(async () => {
    const waitFor = MIN_GAP_MS - (Date.now() - lastRequestAt);
    if (waitFor > 0) await sleep(waitFor);
    let lastError = null;
    try {
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          const res = await fetch(url, {
            headers: {
              'user-agent': UA,
              accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
            },
            redirect: 'follow',
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
          return { url: res.url, status: res.status, text: await res.text() };
        } catch (error) {
          lastError = error;
          if (attempt < retries) await sleep(1200 * (attempt + 1));
        }
      }
      throw lastError || new Error(`请求失败：${url}`);
    } finally {
      // 无论成败都刷新时间戳，失败重试也不会打穿 crawl-delay
      lastRequestAt = Date.now();
    }
  });
  // 队列不能因为某次失败而卡死：把错误吞在队列链上，由调用方拿到的 promise 抛出
  queue = task.then(() => undefined, () => undefined);
  return task;
}

// ── 解析：季节清单 ───────────────────────────────────────────────────────
/** 站点文字名只在这个形状下可信："Resort 2027" / "Fall/Winter 2026" / "Spring/Summer 27" */
function looksLikeSeasonLabel(text) {
  const value = String(text || '').trim();
  if (!value || value.length > 28) return false;
  return /^(spring|summer|fall|winter|resort|pre[\s/-]?fall|couture|bridal)[\s/,-]*\d{2,4}$/i.test(value);
}

function parseSeasonIndex(html) {
  const source = String(html || '');
  const seasons = [];
  const seen = new Set();
  const anchorRe = /<a\b[^>]*href="([^"]*\/trends\/(woman|man)\/([a-z0-9-]+))"[^>]*>([\s\S]*?)<\/a>/g;
  let match;
  while ((match = anchorRe.exec(source))) {
    const [, href, gender, slug, body] = match;
    // 🔴 最新一季（SS27）在首页只有 hero 卡（class="trend-card"），**没有** collections-card。
    //    只认 collections-card 会让「最新季」凭空消失（实测 40 → 38），所以两种都收。
    const isSeasonCard = /class="[^"]*\bcollections-card\b/.test(body);
    const isHeroCard = /class="[^"]*\btrend-card\b/.test(body);
    if (!isSeasonCard && !isHeroCard) continue;
    const meta = seasonMeta(slug);
    // hero 卡放宽了 class 判断，就必须补一道 slug 守卫：只收「前缀+年份」形状
    if (!isSeasonCard && !meta.year) continue;
    const dedupeKey = `${gender}:${slug}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    // hero 卡的文字是 "CELINE - Look 42Discover the latest trends"，不能当季节名用
    const textLabel = stripTags(body);
    seasons.push({
      gender,
      slug,
      year: meta.year,
      quarter: meta.quarter,
      label: isSeasonCard && looksLikeSeasonLabel(textLabel) ? textLabel : meta.label,
      url: `${SITE}${href}`,
    });
  }
  return seasons;
}

// ── 图片多档 ─────────────────────────────────────────────────────────────
/**
 * Tagwalk 的图走 Imgix 风格变换：`/custom,fit_cover,width_W,height_H/<file>`。
 * 实测同一张图各档（文件与像素都真实测过）：
 *   361×541  35KB / 720×1080 115KB / 1080×1620 242KB / 1600×2400 463KB
 *   → 3000 宽会 302 拒绝，**1600×2400 是站点上限**
 * 原图 `/cover/<file>` 只有 552×828（比 1080 档还小），别拿它当高清源。
 *
 * 为什么要多档：卡片宽度随窗口从 210 拉到 340+ CSS px，2x 屏需要 ×2 像素，
 * 只喂 361 档等于放大 2 倍 → 肉眼发糊。交给 srcset 让浏览器按 DPR 自选。
 */
const IMAGE_TIERS = {
  thumb: { width: 361, height: 541 }, // 1x 小图，省流量
  thumbMd: { width: 720, height: 1080 }, // 1x 大卡 / 2x 中卡
  thumbLg: { width: 1080, height: 1620 }, // 2x 大卡
  downloadImage: { width: 1600, height: 2400 }, // 下载：站点上限
};

function imageFileName(url) {
  const match = String(url || '').match(/\/([^/]+\.(?:jpg|jpeg|png|webp))$/i);
  return match ? match[1] : '';
}

/** 按档位改写图片 URL；拿不到文件名时原样返回 */
function imageVariant(url, tier) {
  const file = imageFileName(url);
  if (!file) return String(url || '');
  const size = IMAGE_TIERS[tier];
  if (!size) return String(url || '');
  return `${CDN}/custom,fit_cover,width_${size.width},height_${size.height}/${file}`;
}

/** 一次给出四个档位，parseTrendPage 与主进程补算共用 */
function imageVariants(url) {
  return {
    thumb: imageVariant(url, 'thumb'),
    thumbMd: imageVariant(url, 'thumbMd'),
    thumbLg: imageVariant(url, 'thumbLg'),
    downloadImage: imageVariant(url, 'downloadImage'),
  };
}

// ── 解析：单季关键词 ─────────────────────────────────────────────────────
function parseTrendPage(html, meta = {}) {
  const source = String(html || '');
  const keywords = [];
  const seen = new Set();
  const anchorRe = /<a\b[^>]*href="([^"]*\/look\/search\?[^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  let match;
  while ((match = anchorRe.exec(source))) {
    const href = decodeEntities(match[1]);
    const body = match[2];
    if (!/class="trend-card"/.test(body)) continue;

    const titleMatch = body.match(/<div class="trend-card-info">\s*<h3>([\s\S]*?)<\/h3>/);
    const title = titleMatch ? stripTags(titleMatch[1]) : '';
    if (!title) continue;

    // hover 层两个 h6：品牌 / 季节 + look 号
    const hoverMatch = body.match(/<div class="trend-card-info-hover">([\s\S]*?)<\/div>/);
    const hoverItems = hoverMatch
      ? [...hoverMatch[1].matchAll(/<h6>([\s\S]*?)<\/h6>/g)].map((hit) => stripTags(hit[1]))
      : [];
    const brand = hoverItems[0] || '';
    const lookText = hoverItems[1] || '';
    const lookMatch = lookText.match(/Look\s*(\d+)/i);

    const imgMatch = body.match(/<img\b[^>]*\bsrc="([^"]+)"/);
    const image = imgMatch ? decodeEntities(imgMatch[1]) : '';
    // image 是 `/cover/<file>`（552×828，站点展示原图）；
    // 卡片显示按 DPR 取档，下载走站点上限 1600×2400。
    const variants = imageVariants(image);

    const tagMatch = href.match(/tags(?:%5B0%5D|\[0\])=([^&]+)/);
    const key = tagMatch ? decodeURIComponent(tagMatch[1]) : title.toLowerCase().replace(/[^a-z0-9]+/g, '-');

    if (seen.has(key)) continue;
    seen.add(key);

    keywords.push({
      key,
      title,
      brand,
      look: lookMatch ? Number(lookMatch[1]) : null,
      lookText,
      image,
      ...variants,
      href: href.startsWith('http') ? href : `${SITE}${href}`,
      rank: keywords.length + 1,
      // 品牌合集：优先直推「品牌 × 性别 × 季节」整场 look；
      // slug 推错时 Tagwalk 会 302 回 collection/search，页面仍可用，不会 404。
      brandSlug: brandSlug(brand),
      brandSearchUrl: collectionSearchUrl(brand, meta.slug || meta.season || ''),
      brandCollectionUrl: collectionUrl(brand, meta.slug || meta.season || '', meta.gender || ''),
    });
  }
  return {
    gender: meta.gender || '',
    season: meta.slug || meta.season || '',
    seasonLabel: meta.label || '',
    keywords,
  };
}

// ── 对外：季节清单 ───────────────────────────────────────────────────────
async function fetchSeasonIndex({ log } = {}) {
  const emit = typeof log === 'function' ? log : () => {};
  emit('正在读取 Tagwalk 季节清单…');
  const { text } = await throttledFetch(`${SITE}${INDEX_PATH}`);
  const seasons = parseSeasonIndex(text);
  if (!seasons.length) {
    throw new Error('季节清单解析为空：页面结构可能已改版（collections-card 缺失）');
  }
  const woman = seasons.filter((item) => item.gender === 'woman').length;
  const man = seasons.filter((item) => item.gender === 'man').length;
  emit(`季节清单已获取：女装 ${woman} 季 / 男装 ${man} 季`, 'success');
  return { seasons, counts: { woman, man, total: seasons.length } };
}

// ── 品牌合集链接 ─────────────────────────────────────────────────────────
// Tagwalk 的「品牌 × 季节」合集页靠 designer slug。实测 12 个当季品牌里 11 个
// 可以直接由展示名推导（DOLCE & GABBANA → dolce-gabbana，DIOR HOMME → dior-homme）；
// 反例：SYSTEM 推不出来（站内 slug 不是 system），K-WAY 因重名被加后缀（k-way-2）。
// 所以这里只做「尽力推导」，失败由调用方回落到关键词页，不要在这里抛错。
function brandSlug(brand) {
  return String(brand || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

// 品牌在该季的全部场次（女装/男装/配饰）——不确定性别时的安全入口
function collectionSearchUrl(brand, season) {
  const slug = brandSlug(brand);
  const s = String(season || '').trim();
  if (!slug || !s) return '';
  return `${SITE}/zh/collection/search?designer=${encodeURIComponent(slug)}&season=${encodeURIComponent(s)}`;
}

// 直达某品牌该季某个性别的一场秀（女装/男装整场 look）
function collectionUrl(brand, season, gender) {
  const slug = brandSlug(brand);
  const s = String(season || '').trim();
  const g = GENDERS[gender] ? gender : 'woman';
  if (!slug || !s) return '';
  return `${SITE}/zh/collection/${g}/${encodeURIComponent(slug)}/${encodeURIComponent(s)}`;
}

// ── 品牌场次存在性探测 ───────────────────────────────────────────────────
/**
 * 为什么需要探测：`collection/{gender}/{slug}/{season}` 是唯一能直达**整场**的 URL，
 * 但场次缺失（品牌当季没走秀 / slug 推导错）时它会 **302 到 /zh/collection/search**
 * （全站列表，失败模式很差）。实测：
 *   7-for-all-mankind 女 SS27 → 200（整场）
 *   dolce-gabbana 女 SS27     → 302（该季只有男装场）
 *   not-a-real-brand 女 SS27  → 302
 *
 * 由用户点击触发，量极小，所以**不走 Crawl-delay 队列**（否则点一下要等 2 秒）；
 * 结果缓存 30 分钟，反复点同一品牌不重复请求。
 */
const probeCache = new Map();

async function probeCollection({ gender, slug, season, ttlMs = 30 * 60 * 1000, timeoutMs = 12000 } = {}) {
  const key = `${gender}:${slug}:${season}`;
  const hit = probeCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return { ...hit.value, cached: true };

  const url = collectionUrl(slug, season, gender);
  let status = 0;
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = res.status;
    // 只要状态码，body 直接丢弃（整场页有 45KB）
    if (res.body) { try { await res.body.cancel(); } catch { /* 关不掉就算了 */ } }
  } catch {
    status = -1;
  }

  const ok = status === 200;
  const value = {
    ok,
    status,
    url,
    // 探测失败时回退到「该品牌该季的场次索引」——比全站列表有用得多
    fallbackUrl: collectionSearchUrl(slug, season),
  };
  probeCache.set(key, { at: Date.now(), value });
  return { ...value, cached: false };
}

// ── 对外：单季关键词 ─────────────────────────────────────────────────────
async function fetchTrends({ gender, season, log } = {}) {
  const emit = typeof log === 'function' ? log : () => {};
  const genderKey = GENDERS[gender] ? gender : 'woman';
  const slug = String(season || '').trim();
  // slug 会进 URL 与缓存文件名，必须挡住路径穿越
  if (!/^[a-z0-9-]{3,64}$/.test(slug)) {
    throw new Error(`无效的季节标识：${slug || '(空)'}`);
  }
  const meta = seasonMeta(slug);
  emit(`正在抓取 ${GENDERS[genderKey].labelZh} ${meta.label} 的关键词…`);
  const url = `${SITE}/zh/trends/${genderKey}/${slug}`;
  const { text } = await throttledFetch(url);
  const parsed = parseTrendPage(text, { gender: genderKey, slug, label: meta.label });
  if (!parsed.keywords.length) {
    throw new Error(`${meta.label} 未解析到关键词：页面结构可能已改版（trend-card/h3 缺失）`);
  }
  emit(`${meta.label}：${parsed.keywords.length} 个关键词`, 'success');
  return { ...parsed, sourceUrl: url };
}

module.exports = {
  GENDERS,
  SITE,
  seasonMeta,
  parseSeasonIndex,
  parseTrendPage,
  fetchSeasonIndex,
  fetchTrends,
  brandSlug,
  collectionSearchUrl,
  collectionUrl,
  imageVariant,
  imageVariants,
  IMAGE_TIERS,
  probeCollection,
};

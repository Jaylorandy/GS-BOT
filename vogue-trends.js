'use strict';
/**
 * 趋势前瞻 · Vogue Runway 采集核心
 * ════════════════════════════════════════════════════════════════════════
 * 纯 Node（无需浏览器 / 无 puppeteer）。Vogue 没有反爬，常规 UA 直连 200。
 *
 * 三层结构：
 *   1. 季节列表  GET /fashion-shows/seasons
 *                → 页面内直接含 227 个季节路径（最新在前）
 *   2. 品牌列表  GET /fashion-shows/<season>
 *                → __PRELOADED_STATE__.transformed.runwaySeasonContent.allShows[]
 *                  每个分组 {groupName:'A', links:[{text:'A. Potts', url:'/fashion-shows/.../apotts'}]}
 *                  text = 品牌显示名；url 末段 = slug
 *   3. 秀场图    GET /fashion-shows/<season>/<brand>/slideshow/collection
 *                → assets.vogue.com/photos/<photoId>/master/w_<N>,c_limit/<NNNNN>-<slug>-...jpg
 *
 * 🔴 关键坑（实测）：
 *   - 同一 look 可能有多个 photoId（16:9 / 1:1 社交裁切），只认 `master/` 规格
 *   - CDN 路径里的 `w_<N>,c_limit` 是「按需缩放」指令，不是固定资源：
 *     w_360 → 20KB/360×540；w_5000 → ~1MB/2732×4098 原图。c_limit = 只缩不放
 *   - HTML 里 URL 形态不一（&quot; / %2C / &amp; / \u002F）→ 必须整篇解码后再匹配
 *   - slug 不统一：导航写 dior，真实 slug 是 christian-dior（404 页的导航仍写错）
 *     所以品牌 slug 只能取「季节页 JSON 里的 url」，不能自己拼
 *   - `-details-` 是同款细节特写，需单独过滤
 * ════════════════════════════════════════════════════════════════════════
 */

const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const SITE = 'https://www.vogue.com';
const CDN = 'https://assets.vogue.com/photos/';

const SEASON_PREFIX = { spring: 'Spring', fall: 'Fall', resort: 'Resort', 'pre-fall': 'Pre-Fall' };
const SEASON_SUFFIX = {
  'ready-to-wear': 'Ready-to-Wear',
  menswear: 'Menswear',
  couture: 'Couture',
  bridal: 'Bridal',
};

/** slug → 人类可读名：spring-2027-ready-to-wear → Spring 2027 Ready-to-Wear */
function seasonLabel(slug) {
  const m = String(slug).match(/^(.+?)-(\d{4})(?:-(.+))?$/);
  if (!m) return String(slug);
  const [, prefix, year, suffix] = m;
  const head = SEASON_PREFIX[prefix] || prefix.replace(/(^|-)([a-z])/g, (_, s, c) => s + c.toUpperCase());
  const tail = suffix ? (SEASON_SUFFIX[suffix] || suffix) : '';
  return [head, year, tail].filter(Boolean).join(' ');
}

/** 排序权重：越新的季节越靠前（spring/fall 同年 → fall 更新） */
function seasonRank(slug) {
  const m = String(slug).match(/-(\d{4})/);
  const year = m ? Number(m[1]) : 0;
  const order = { spring: 1, resort: 2, 'pre-fall': 3, fall: 4 };
  const p = String(slug).split('-')[0];
  return year * 10 + (order[p] || 0);
}

// ── HTTP ────────────────────────────────────────────────────────────────
async function fetchText(url, { timeoutMs = 45000, retries = 2 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: {
          'user-agent': UA,
          accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  // 不吞真实报错：把网络层错误原样抛出，附带目标 URL
  throw new Error(`Vogue request failed: ${url} — ${lastErr ? lastErr.message : 'unknown'}`);
}

/** 取 __PRELOADED_STATE__ 并 JSON.parse（url 里的 \u002F 会被 JSON 自动还原成 /） */
function extractPreloadedState(html) {
  const key = 'window.__PRELOADED_STATE__ = ';
  const i = html.indexOf(key);
  if (i < 0) return null;
  const start = i + key.length;
  const end = html.indexOf('</script>', start);
  if (end < 0) return null;
  const raw = html.slice(start, end).trim().replace(/;$/, '');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`__PRELOADED_STATE__ 解析失败: ${err.message}`);
  }
}

// ── 1. 季节列表 ─────────────────────────────────────────────────────────
async function fetchSeasons({ log } = {}) {
  const html = await fetchText(`${SITE}/fashion-shows/seasons`);
  // 严格白名单：<prefix>-<year>[-<suffix>]。
  // 🔴 不能用「段数」过滤：`spring-2027-ready-to-wear` 是 5 段，按段数会把它连同
  //    77 个 ready-to-wear 季节一起误杀（实测 227 → 150）。后缀才是唯一可靠判据。
  //    `resort-2027-menswear` 是真实季节（Vogue 导航里就叫 Resort 2027 Menswear）。
  const re = /\/fashion-shows\/((?:spring|fall|resort|pre-fall)-\d{4}(?:-(?:ready-to-wear|menswear|couture|bridal))?)(?=["'\\\s?)<])/g;
  const seen = new Set();
  const seasons = [];
  for (const m of html.matchAll(re)) {
    const slug = m[1];
    if (seen.has(slug)) continue;
    seen.add(slug);
    seasons.push({ slug, label: seasonLabel(slug), rank: seasonRank(slug) });
  }
  seasons.sort((a, b) => b.rank - a.rank);
  if (log) log(`🗓️ Vogue 季节档案：${seasons.length} 个（最新 ${seasons[0]?.label || '-'}）`);
  if (!seasons.length) throw new Error('季节列表为空：Vogue 页面结构可能已变更');
  return seasons;
}

// ── 2. 品牌列表 ─────────────────────────────────────────────────────────
async function fetchBrands(season, { log } = {}) {
  const slug = String(season || '').trim();
  if (!slug) throw new Error('fetchBrands: 缺少 season');
  const html = await fetchText(`${SITE}/fashion-shows/${slug}`);
  const state = extractPreloadedState(html);
  const rsc = state?.transformed?.runwaySeasonContent;
  if (!rsc || !Array.isArray(rsc.allShows)) {
    throw new Error(`品牌列表解析失败：${slug} 页面缺少 runwaySeasonContent（结构可能已变更）`);
  }
  const brands = [];
  const seen = new Set();
  for (const group of rsc.allShows) {
    const links = Array.isArray(group?.links) ? group.links : [];
    for (const link of links) {
      const url = String(link?.url || '');
      const brandSlug = url.split('/').filter(Boolean).pop();
      const name = String(link?.text || '').trim();
      if (!brandSlug || !name || seen.has(brandSlug)) continue;
      seen.add(brandSlug);
      brands.push({
        name,
        slug: brandSlug,
        group: String(group?.groupName || '#').trim() || '#',
        url: url.startsWith('http') ? url : SITE + url,
        season: slug,
      });
    }
  }
  brands.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  if (log) log(`🏷️ ${rsc.name || slug}：${brands.length} 个品牌`);
  if (!brands.length) throw new Error(`品牌列表为空：${slug}`);
  return { season: slug, seasonName: rsc.name || seasonLabel(slug), brands };
}

// ── 3. 秀场图 ───────────────────────────────────────────────────────────
/** 整篇解码：HTML 实体 + 百分号 + JS 转义斜杠（多形态并存，必须统一） */
function decodeAll(html) {
  return html
    .replace(/\\u002F/gi, '/')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/%2C/gi, ',')
    .replace(/%2F/gi, '/');
}

/**
 * 从 collection 页解析 look：
 *   { look: 7, photoId, file }  —— 只认 master/ 规格
 */
function parseLooks(html, { includeDetails = false } = {}) {
  const doc = decodeAll(html);
  const RE = /https:\/\/assets\.vogue\.com\/photos\/([a-f0-9]+)\/master\/w_\d+,c_limit\/(\d{3,5})-([^"'\s\\?)]+?\.(?:jpg|jpeg|png))/g;
  const byLook = new Map();
  for (const m of doc.matchAll(RE)) {
    const [, photoId, lookNo, tail] = m;
    const file = `${lookNo}-${tail}`;
    const isDetail = /-details-/.test(file);
    if (isDetail && !includeDetails) continue;
    const key = isDetail ? `d${lookNo}` : lookNo;
    if (!byLook.has(key)) byLook.set(key, []);
    const bucket = byLook.get(key);
    if (!bucket.some((x) => x.photoId === photoId)) bucket.push({ photoId, file, look: Number(lookNo), isDetail });
  }
  // 稳定排序：look 升序
  return [...byLook.values()]
    .map((arr) => arr[0])
    .sort((a, b) => (a.look - b.look) || Number(a.isDetail) - Number(b.isDetail));
}

/** 按需缩放取图。w 越大越清晰；c_limit = 只缩不放 */
function assetUrl(photoId, file, width = 5000) {
  return `${CDN}${photoId}/master/w_${width},c_limit/${file}`;
}

/** 读 JPEG/PNG 尺寸（不做全量解码，只扫到 SOF 段） */
function imageSize(buf) {
  if (buf.slice(0, 3).toString('hex') === 'ffd8ff') {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xFF) { i += 1; continue; }
      const marker = buf[i + 1];
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
        return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
      }
      if (i + 4 > buf.length) break;
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

async function fetchBinary(url, { timeoutMs = 60000, retries = 2 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, referer: `${SITE}/` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const head = buf.slice(0, 4).toString('hex');
      if (!(head.startsWith('ffd8ff') || head.startsWith('89504e47'))) {
        throw new Error(`返回内容不是图片（magic=${head}，${buf.length}B）`);
      }
      return buf;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    }
  }
  throw new Error(lastErr ? lastErr.message : 'download failed');
}

/** 简易并发池 */
async function pool(items, limit, worker) {
  const queue = items.slice();
  const results = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(limit, queue.length)).fill(0).map(async () => {
    for (;;) {
      const idx = cursor;
      cursor += 1;
      if (idx >= queue.length) return;
      results[idx] = await worker(queue[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();
}

/**
 * 抓取单品牌单个季节的秀场图。
 * config: { season, brand:{slug,name}, outputDir, imageWidth, includeDetails, concurrency, maxLooks }
 * hooks : { log, progress, ensureActive }
 */
async function scrapeShow(config = {}, hooks = {}) {
  const { log = () => {}, progress = () => {}, ensureActive = () => {} } = hooks;
  const season = String(config.season || '').trim();
  const brand = config.brand || {};
  const brandSlug = String(brand.slug || '').trim();
  const brandName = String(brand.name || brandSlug).trim();
  if (!season || !brandSlug) throw new Error('scrapeShow: 缺少 season 或 brand.slug');

  const outputRoot = String(config.outputDir || '').trim();
  if (!outputRoot) throw new Error('scrapeShow: 缺少 outputDir');
  const imageWidth = Number(config.imageWidth) || 5000;
  const includeDetails = Boolean(config.includeDetails);
  const concurrency = Math.min(Math.max(Number(config.concurrency) || 3, 1), 8);
  const maxLooks = Number(config.maxLooks) > 0 ? Number(config.maxLooks) : 0;

  const showUrl = `${SITE}/fashion-shows/${season}/${brandSlug}/slideshow/collection`;
  log(`🎬 打开秀场页：${brandName} @ ${season}`);
  const html = await fetchText(showUrl);
  const looks = parseLooks(html, { includeDetails });
  if (!looks.length) throw new Error(`${brandName} @ ${season} 未解析到任何秀场图（页面结构可能已变更）`);
  const picked = maxLooks ? looks.slice(0, maxLooks) : looks;
  log(`🖼️ 解析出 ${looks.length} 张（look ${looks[0].look} → ${looks[looks.length - 1].look}）${maxLooks ? `，取前 ${picked.length} 张` : ''}`);

  const dir = path.join(outputRoot, safeName(season), safeName(brandName));
  fs.mkdirSync(dir, { recursive: true });

  const manifest = {
    source: 'vogue.com/fashion-shows',
    season,
    brand: brandName,
    brandSlug,
    showUrl,
    imageWidth,
    includeDetails,
    fetchedAt: new Date().toISOString(),
    images: [],
  };

  let done = 0;
  let bytes = 0;
  const failures = [];

  await pool(picked, concurrency, async (item) => {
    ensureActive();
    const url = assetUrl(item.photoId, item.file, imageWidth);
    const stamp = String(item.look).padStart(3, '0');
    const ext = /\.png$/i.test(item.file) ? 'png' : 'jpg';
    const fileName = `${item.isDetail ? 'detail-' : ''}look-${stamp}.${ext}`;
    const target = path.join(dir, fileName);
    try {
      const buf = await fetchBinary(url);
      fs.writeFileSync(target, buf);
      const size = imageSize(buf);
      bytes += buf.length;
      manifest.images.push({
        file: fileName,
        look: item.look,
        photoId: item.photoId,
        sourceFile: item.file,
        url,
        bytes: buf.length,
        width: size ? size.w : null,
        height: size ? size.h : null,
      });
      log(`  ✓ ${fileName}  ${Math.round(buf.length / 1024)}KB${size ? `  ${size.w}×${size.h}` : ''}`, 'success');
    } catch (err) {
      failures.push({ file: fileName, url, error: err.message });
      log(`  ✗ ${fileName}  ${err.message}`, 'error');
      throw err;
    } finally {
      done += 1;
      progress(Math.round((done / picked.length) * 100));
    }
  });

  // 清单按 look 排序后落盘，便于 PPT / 分析链路消费
  manifest.images.sort((a, b) => a.look - b.look);
  manifest.count = manifest.images.length;
  manifest.failed = failures.length;
  manifest.bytes = bytes;
  const manifestPath = path.join(dir, '_manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  log(`✅ ${brandName}：${manifest.images.length} 张 / ${(bytes / 1048576).toFixed(1)}MB → ${dir}`
    + (failures.length ? `（${failures.length} 张失败）` : ''), failures.length ? 'warning' : 'success');

  return {
    success: failures.length === 0,
    brand: brandName,
    brandSlug,
    season,
    dir,
    manifestPath,
    count: manifest.images.length,
    failed: failures.length,
    bytes,
    failures,
  };
}

module.exports = {
  seasonLabel,
  seasonRank,
  fetchSeasons,
  fetchBrands,
  parseLooks,
  assetUrl,
  scrapeShow,
  imageSize,
};

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from './utils/i18n';

const STORAGE_KEY = 'gsbot-trends-dashboard-selection';
// 提到模块作用域：useCallback / useEffect 的依赖里出现 `window.x || {}` 会让
// 每次渲染都换引用，触发 exhaustive-deps 告警（也确实会反复重建回调）
const API = (typeof window !== 'undefined' && window.electronAPI) || {};

/** 从 "Spring/Summer 2027" 里剥掉年份，只留季度名（年份已经在上一个下拉里选过了） */
function quarterOnly(label, year) {
  const text = String(label || '').trim();
  if (!year) return text;
  const stripped = text.replace(new RegExp(`\\s*['’]?\\d{2,4}\\s*$`), '').trim();
  return stripped || text;
}

function readSavedSelection() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return { gender: parsed.gender === 'man' ? 'man' : 'woman', season: String(parsed.season || '') };
  } catch {
    return null;
  }
}

function writeSavedSelection(selection) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // 存不下就算了，不影响主流程
  }
}

function formatStamp(value, language) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

/** 文件名片段：小写、去重音、非字母数字转 - */
function slugPart(value, maxLength = 40) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
}

/** 01-pattern-mix-dolce-gabbana-look17.jpg —— 排序、关键词、品牌、look 号都在名字里 */
function buildFileName(item) {
  const ext = (String(item?.image || '').match(/\.(jpe?g|png|webp)$/i) || ['.jpg'])[0].toLowerCase();
  const parts = [
    String(item?.rank || 0).padStart(2, '0'),
    slugPart(item?.title),
    slugPart(item?.brand),
    item?.look ? `look${item.look}` : '',
  ].filter(Boolean);
  return `${parts.join('-') || 'look'}${ext}`;
}

const DOWNLOAD_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 4v10" />
    <path d="m7.5 10 4.5 4.5L16.5 10" />
    <path d="M5 19h14" />
  </svg>
);

const CHECK_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m5 12.5 4.5 4.5L19 7" />
  </svg>
);

const SPINNER_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
    <path d="M12 3a9 9 0 1 0 9 9" />
  </svg>
);

export default function TrendsDashboard({ iconNode }) {
  const { language, tx } = useI18n();
  const api = API;

  const [seasons, setSeasons] = useState([]);
  const [indexLoading, setIndexLoading] = useState(true);
  const [indexError, setIndexError] = useState('');
  const [indexStamp, setIndexStamp] = useState('');

  const [gender, setGender] = useState(() => readSavedSelection()?.gender || 'woman');
  const [year, setYear] = useState(null);
  const [season, setSeason] = useState(() => readSavedSelection()?.season || '');

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [logLine, setLogLine] = useState('');
  // 下载状态：key → 'loading' | 'done' | 'error'
  const [dlState, setDlState] = useState({});
  const [notice, setNotice] = useState(null);
  // 品牌跳转的"探测中"态：key
  const [brandPending, setBrandPending] = useState('');
  // 滚动时给容器加 class，停止 900ms 后滚动条淡出
  const [scrolling, setScrolling] = useState(false);
  const scrollTimerRef = useRef(0);

  const requestRef = useRef(0);

  const handleScroll = useCallback(() => {
    setScrolling(true);
    window.clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = window.setTimeout(() => setScrolling(false), 900);
  }, []);

  useEffect(() => () => window.clearTimeout(scrollTimerRef.current), []);

  // ── 季节清单 ─────────────────────────────────────────────────────────
  const loadSeasons = useCallback(async (force = false) => {
    setIndexLoading(true);
    setIndexError('');
    try {
      const res = force && api.trendsDashboardSeasons
        ? await api.trendsDashboardSeasons({ force: true })
        : await (api.trendsDashboardSeasons ? api.trendsDashboardSeasons({}) : Promise.resolve({ success: false, error: 'no api' }));
      // 缓存为空时自动回源一次（首次安装 / 用户清过缓存）
      const list = Array.isArray(res?.seasons) ? res.seasons : [];
      const source = !force && api.trendsDashboardSeasons && list.length === 0
        ? await api.trendsDashboardSeasons({ force: true })
        : res;
      const finalList = Array.isArray(source?.seasons) ? source.seasons : list;
      if (!source?.success) {
        setIndexError(source?.error || tx('Failed to load seasons.', '季节清单读取失败。'));
        setSeasons([]);
        return;
      }
      setSeasons(finalList);
      setIndexStamp(String(source?.updatedAt || ''));
      if (!finalList.length) {
        setIndexError(tx('No seasons returned.', '没有拿到任何季节数据。'));
      }
    } catch (err) {
      setIndexError(err?.message || String(err));
    } finally {
      setIndexLoading(false);
    }
  }, [api, tx]);

  useEffect(() => { loadSeasons(false); }, [loadSeasons]);

  // 该性别下的季节，保持站点顺序（= 时间由新到旧）
  const genderSeasons = useMemo(() => seasons.filter((item) => item.gender === gender), [seasons, gender]);

  const years = useMemo(() => {
    const seen = [];
    genderSeasons.forEach((item) => { if (!seen.includes(item.year)) seen.push(item.year); });
    return seen.sort((a, b) => b - a);
  }, [genderSeasons]);

  // 年份/季节的默认值与修正：切换性别后旧季节可能不存在
  useEffect(() => {
    if (!genderSeasons.length) return;
    const current = genderSeasons.find((item) => item.slug === season);
    if (current) {
      if (year !== current.year) setYear(current.year);
      return;
    }
    const fallback = genderSeasons[0];
    setSeason(fallback.slug);
    setYear(fallback.year);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genderSeasons, season]);

  const yearSeasons = useMemo(
    () => genderSeasons.filter((item) => item.year === year),
    [genderSeasons, year],
  );

  // 选中年份下没有当前季节 → 落到该年第一季
  useEffect(() => {
    if (!yearSeasons.length) return;
    if (yearSeasons.some((item) => item.slug === season)) return;
    setSeason(yearSeasons[0].slug);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [yearSeasons]);

  // ── 关键词 ───────────────────────────────────────────────────────────
  const loadKeywords = useCallback(async (targetGender, targetSeason, force = false) => {
    if (!targetSeason || !api.trendsDashboardFetch) return;
    const token = requestRef.current + 1;
    requestRef.current = token;
    setLoading(true);
    setError('');
    setLogLine('');
    try {
      const res = await api.trendsDashboardFetch({ gender: targetGender, season: targetSeason, force });
      if (requestRef.current !== token) return; // 用户已经切走了，丢弃旧结果
      if (!res?.success) {
        setError(res?.error || tx('Failed to load keywords.', '关键词读取失败。'));
        setData(null);
        return;
      }
      setData(res);
    } catch (err) {
      if (requestRef.current !== token) return;
      setError(err?.message || String(err));
      setData(null);
    } finally {
      if (requestRef.current === token) setLoading(false);
    }
  }, [api, tx]);

  useEffect(() => {
    if (!season) return;
    writeSavedSelection({ gender, season });
    loadKeywords(gender, season, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gender, season]);

  // 数据抓取过程中的中文提示（主进程逐条推）
  useEffect(() => {
    if (!api.onTrendsDashboardLog) return undefined;
    const handler = (payload) => {
      if (payload?.message) setLogLine(String(payload.message));
    };
    api.onTrendsDashboardLog(handler);
    return () => api.removeTrendsDashboardListeners?.();
  }, [api]);

  const openSource = (url) => {
    if (!url) return;
    if (api.openExternalUrl) api.openExternalUrl(url);
    else window.open(url, '_blank', 'noopener,noreferrer');
  };

  /**
   * 点品牌 → 该品牌这一季的**整场 look**。
   * 为什么不直接 open：`collection/{gender}/{slug}/{season}` 在场次缺失时会 302 到
   * 全站列表（失败模式很差），所以主进程先探测 200/302 再决定直达还是退回场次索引。
   * 这里只负责 pending 态与失败兜底。
   */
  const openBrandCollection = async (item) => {
    if (!item || brandPending) return;
    const fallback = item.brandSearchUrl || item.brandCollectionUrl || item.href;
    if (!api.trendsOpenCollection) {
      openSource(fallback);
      return;
    }
    setBrandPending(item.key);
    try {
      const res = await api.trendsOpenCollection({
        gender: data?.gender || gender,
        season: data?.season || season,
        slug: item.brandSlug,
      });
      // 主进程已经 openExternal 了；只有彻底失败才用前端兜底
      if (!res?.success) openSource(fallback);
    } catch {
      openSource(fallback);
    } finally {
      setBrandPending('');
    }
  };

  // ── 下载单张 look 原图（主进程负责落盘到「下载/GS Bot Trends/<季节>/」）──
  // 用 downloadImage = CDN 上限 1600×2400；`/cover/` 原图其实只有 552×828。
  const downloadImage = async (item) => {
    if (!item || dlState[item.key] === 'loading') return;
    if (!api.trendsDownloadImages) {
      setNotice({ type: 'err', text: tx('Downloading is unavailable in this build.', '当前版本不支持下载。') });
      return;
    }
    const key = item.key;
    setDlState((prev) => ({ ...prev, [key]: 'loading' }));
    setNotice(null);
    try {
      const res = await api.trendsDownloadImages({
        items: [{ url: item.downloadImage || item.image, filename: buildFileName(item) }],
        seasonLabel: data?.seasonLabel || '',
      });
      if (res?.success) {
        setDlState((prev) => ({ ...prev, [key]: 'done' }));
        setNotice({
          type: 'ok',
          text: tx(`Saved to ${res.dir}`, `已保存到 ${res.dir}`),
          dir: res.dir,
        });
        window.setTimeout(() => {
          setDlState((prev) => (prev[key] === 'done' ? { ...prev, [key]: 'idle' } : prev));
        }, 3200);
      } else {
        setDlState((prev) => ({ ...prev, [key]: 'error' }));
        setNotice({ type: 'err', text: res?.error || tx('Download failed.', '下载失败。') });
      }
    } catch (err) {
      setDlState((prev) => ({ ...prev, [key]: 'error' }));
      setNotice({ type: 'err', text: err?.message || String(err) });
    }
  };

  const keywords = data?.keywords || [];
  const total = keywords.length;

  // ── 焦点款（专辑封面式：一次只展示一款大图，其余堆在下方胶片条）──
  const [activeIndex, setActiveIndex] = useState(0);
  const stripRef = useRef(null);
  // 换季/换性别 → 回到第一款；关键词数变少时避免下标越界
  useEffect(() => { setActiveIndex(0); }, [gender, season]);
  useEffect(() => {
    setActiveIndex((prev) => (prev >= total ? 0 : prev));
  }, [total]);

  const goTo = useCallback((delta) => {
    setActiveIndex((prev) => {
      if (!total) return 0;
      return Math.max(0, Math.min(total - 1, prev + delta));
    });
  }, [total]);

  // 选中项滚进胶片条视野（block:'nearest' 防整页跳动）
  useEffect(() => {
    const el = stripRef.current?.querySelector('.td-thumb.is-active');
    if (el) el.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }, [activeIndex]);

  // ← → 切换（焦点在输入控件里时不抢键）
  useEffect(() => {
    const onKeyDown = (event) => {
      const tag = event.target?.tagName || '';
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag)) return;
      if (event.key === 'ArrowLeft') { event.preventDefault(); goTo(-1); }
      if (event.key === 'ArrowRight') { event.preventDefault(); goTo(1); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [goTo]);

  const active = keywords[Math.min(activeIndex, Math.max(total - 1, 0))] || null;
  const activeRank = activeIndex + 1;

  return (
    <div
      className={`trends-dash${scrolling ? ' is-scrolling' : ''}`}
      onScroll={handleScroll}
    >
      <header className="trends-dash__head">
        <div className="trends-dash__heading">
          <p className="trends-dash__eyebrow">
            <span className="trends-dash__icon" aria-hidden="true">{iconNode}</span>
            <span>TAGWALK · TREND KEYWORDS</span>
          </p>
          <h1 className="trends-dash__title">{tx('Trends Dashboard', '趋势看板')}</h1>
          <p className="trends-dash__sub">
            {tx(
              'The most tagged keywords of each season, with the look that best represents it.',
              '每一季被标注最多的关键词，附最具代表性的 look。',
            )}
          </p>
        </div>
        <div className="trends-dash__actions">
          <button
            type="button"
            className="trends-dash__ghost"
            onClick={() => { loadSeasons(true); if (season) loadKeywords(gender, season, true); }}
            disabled={indexLoading || loading}
          >
            {indexLoading || loading ? tx('Refreshing…', '更新中…') : tx('Refresh', '更新数据')}
          </button>
        </div>
      </header>

      {notice ? (
        <div className={`trends-dash__notice${notice.type === 'err' ? ' is-err' : ''}`} role="status">
          <span className="trends-dash__notice-text" title={notice.text}>{notice.text}</span>
          {notice.dir ? (
            <button type="button" className="trends-dash__notice-btn" onClick={() => api.revealLocalPath?.(notice.dir)}>
              {tx('Open folder', '打开文件夹')}
            </button>
          ) : null}
          <button
            type="button"
            className="trends-dash__notice-close"
            onClick={() => setNotice(null)}
            aria-label={tx('Dismiss', '关闭')}
          >
            ✕
          </button>
        </div>
      ) : null}

      <div className="trends-dash__controls">
        <div className="trends-seg" role="group" aria-label={tx('Gender', '性别')}>
          {[{ key: 'woman', en: 'Womenswear', zh: '女装' }, { key: 'man', en: 'Menswear', zh: '男装' }].map((item) => (
            <button
              key={item.key}
              type="button"
              className={`trends-seg__btn${gender === item.key ? ' is-active' : ''}`}
              onClick={() => setGender(item.key)}
              aria-pressed={gender === item.key}
            >
              {tx(item.en, item.zh)}
            </button>
          ))}
        </div>

        <label className="trends-field">
          <span className="trends-field__label">{tx('Year', '年份')}</span>
          <select
            value={year ?? ''}
            onChange={(event) => setYear(Number(event.target.value))}
            disabled={!years.length}
          >
            {years.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>

        <label className="trends-field">
          <span className="trends-field__label">{tx('Season', '季度')}</span>
          <select
            value={season}
            onChange={(event) => setSeason(event.target.value)}
            disabled={!yearSeasons.length}
          >
            {yearSeasons.map((item) => (
              <option key={item.slug} value={item.slug}>{quarterOnly(item.label, item.year)}</option>
            ))}
          </select>
        </label>

        <div className="trends-dash__meta">
          {indexError ? <span className="trends-dash__meta-error">{indexError}</span> : null}
          {!indexError && data ? (
            <>
              <span className="trends-dash__chip">{tx(`${total} keywords`, `${total} 个关键词`)}</span>
              {data.newCount > 0 ? (
                <span className="trends-dash__chip is-new">{tx(`${data.newCount} new`, `${data.newCount} 个本季新增`)}</span>
              ) : null}
              {data.comparedWith ? (
                <span className="trends-dash__chip is-muted">
                  {tx(`vs ${data.comparedWith.label}`, `对比 ${data.comparedWith.label}`)}
                </span>
              ) : null}
              {data.updatedAt ? (
                <span className="trends-dash__stamp">{formatStamp(data.updatedAt, language)}</span>
              ) : null}
            </>
          ) : null}
        </div>
      </div>

      {error ? (
        <div className="trends-dash__error" role="alert">
          <strong>{tx('Could not load keywords', '关键词加载失败')}</strong>
          <span>{error}</span>
          <button type="button" onClick={() => loadKeywords(gender, season, true)}>{tx('Retry', '重试')}</button>
        </div>
      ) : null}

      {!error && loading && !keywords.length ? (
        <div className="trends-dash__hint">{logLine || tx('Loading keywords…', '正在读取关键词…')}</div>
      ) : null}

      {!error && !loading && !keywords.length && !indexLoading ? (
        <div className="trends-dash__hint">
          {indexError || tx('Pick a season to see its keywords.', '选择一个季节查看关键词。')}
        </div>
      ) : null}

      {/* 专辑封面式：左列 = 标题 + 胶片条，右列 = 当前款大图 */}
      {active ? (
        <section className="td-stage" aria-live="polite">
          <div className="td-stage__left">
            <div className="td-stage__info">
              <p className="td-stage__index">
                <span className="td-stage__num">{String(activeRank).padStart(2, '0')}</span>
                <span className="td-stage__sep">/</span>
                <span className="td-stage__total">{String(total).padStart(2, '0')}</span>
                {active.isNew ? <span className="td-stage__new">{tx('NEW', '新增')}</span> : null}
              </p>

              <h2 className="td-stage__title">{active.title}</h2>

              <p className="td-stage__by">
                <span className="td-stage__brand">{active.brand}</span>
                {active.look ? <span className="td-stage__look">Look {active.look}</span> : null}
              </p>

              <div className="td-stage__actions">
                <button
                  type="button"
                  className="td-btn td-btn--solid"
                  onClick={() => openBrandCollection(active)}
                  disabled={Boolean(brandPending)}
                >
                  {brandPending === active.key ? tx('Opening…', '正在打开…') : tx('Full runway', '品牌整场')}
                  <span aria-hidden="true">↗</span>
                </button>
                <button
                  type="button"
                  className={`td-btn is-${dlState[active.key] || 'idle'}`}
                  onClick={() => downloadImage(active)}
                  disabled={dlState[active.key] === 'loading'}
                >
                  {dlState[active.key] === 'loading'
                    ? SPINNER_ICON
                    : dlState[active.key] === 'done' ? CHECK_ICON : DOWNLOAD_ICON}
                  <span>
                    {dlState[active.key] === 'done'
                      ? tx('Saved', '已保存')
                      : dlState[active.key] === 'error' ? tx('Retry', '重试') : tx('Download', '下载原图')}
                  </span>
                </button>
              </div>

              <div className="td-stage__nav">
                <button
                  type="button"
                  className="td-nav-btn"
                  onClick={() => goTo(-1)}
                  disabled={activeIndex <= 0}
                  aria-label={tx('Previous keyword', '上一个关键词')}
                >
                  ‹
                </button>
                <span className="td-stage__count">
                  {activeRank} <span>/ {total}</span>
                </span>
                <button
                  type="button"
                  className="td-nav-btn"
                  onClick={() => goTo(1)}
                  disabled={activeIndex >= total - 1}
                  aria-label={tx('Next keyword', '下一个关键词')}
                >
                  ›
                </button>
              </div>
            </div>

            {/* 胶片条：标题正下方，仍留在左列 */}
            {total ? (
              <div className="td-strip" ref={stripRef} role="tablist" aria-label={tx('Keywords', '关键词')}>
                {keywords.map((item, index) => (
                  <button
                    key={item.key}
                    type="button"
                    role="tab"
                    aria-selected={index === activeIndex}
                    className={`td-thumb${index === activeIndex ? ' is-active' : ''}`}
                    onClick={() => setActiveIndex(index)}
                    title={`${item.rank}. ${item.title}`}
                  >
                    <img
                      src={item.thumb || item.image}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      referrerPolicy="no-referrer"
                    />
                    <span className="td-thumb__num">{String(item.rank).padStart(2, '0')}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          {/* 右：当前款大图，点了去该关键词下面的全部 look */}
          <button
            type="button"
            className="td-stage__frame"
            onClick={() => openSource(active.href)}
            title={tx('Open all looks tagged with this keyword', '打开该关键词下的全部 look')}
          >
            <img
              key={active.key}
              src={active.thumbLg || active.thumb || active.image}
              srcSet={[
                active.thumbMd && `${active.thumbMd} 720w`,
                active.thumbLg && `${active.thumbLg} 1080w`,
                active.downloadImage && `${active.downloadImage} 1600w`,
              ].filter(Boolean).join(', ') || undefined}
              sizes="(max-width: 900px) 92vw, 46vw"
              alt={active.title}
              decoding="async"
              referrerPolicy="no-referrer"
            />
          </button>
        </section>
      ) : null}

      {keywords.length ? (
        <footer className="trends-dash__foot">
          {tx('Source: Tagwalk trend pages. Rank follows Tagwalk’s own ordering.', '数据来源：Tagwalk 趋势页；排序沿用 Tagwalk 原始顺序。')}
          {indexStamp ? ` · ${tx('Season list updated', '季节清单更新于')} ${formatStamp(indexStamp, language)}` : ''}
        </footer>
      ) : null}
    </div>
  );
}

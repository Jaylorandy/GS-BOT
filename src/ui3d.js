// ui3d.js — Dynamic Pro 3D 引擎（从 ui-demo/gs-bot-dynamic-3d.html 移植并 React 化）
//
// 职责：
//   1. 背景引擎（Aurora Mesh）：1/6 降采样画布上叠 4 团极慢流动的低饱和径向光雾，
//      用 'lighter' 混合；指针只做轻微视差（lerp 0.14），不做斥力。单一 rAF 循环。
//   2. 3D 倾斜引擎：自动接管容器内所有 [data-tilt] 元素（含动态新增/移除），
//      按预设（hero / nav / tool）做 perspective + rotate + lift + zoom + glare。
//
// 用法：
//   const cleanup = initDynamic3D(canvasEl);   // canvas 放在 .app-background 里
//   cleanup();                                  // 卸载时调用（回调 ref 自动管理）
//
// 标注约定（JSX 里加一个属性即可）：
//   data-tilt="hero" — 模块主页大图标（大幅倾斜 + 上浮 + 动态阴影）
//   data-tilt="nav"  — 侧栏导航图标壳（轻微倾斜 + glare）
//   data-tilt="tool" — 工具条按钮图标壳（最轻微）
//
// 全程尊重 prefers-reduced-motion：命中时不启动任何循环、不注入 glare。

const REDUCED =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (f) => f * f * (3 - 2 * f); // smoothstep

const TILT_PRESETS = {
  hero: { max: 20, radius: 340, lift: 10, zoom: 0.14, persp: 800, shadow: true, glare: true },
  nav: { max: 12, radius: 220, lift: 0, zoom: 0.06, persp: 700, shadow: false, glare: true },
  tool: { max: 10, radius: 170, lift: 0, zoom: 0.05, persp: 600, shadow: false, glare: true },
};

// 背景：Aurora Mesh（2026-10-19 替换原「星空粒子 + 连线 + 流星」）
//   AURORA_SCALE 降采样倍率：画布像素 = 容器尺寸 / SCALE，由浏览器双线性放大，
//   既天然平滑又把逐帧填充成本压到 1/36；AURORA_FPS 限频，主线程只在需要时绘制。
const AURORA_SCALE = 6;
const AURORA_FPS = 30;
const AURORA_PARALLAX = 22; // 指针视差幅度（CSS px），0 = 完全静止
const AURORA_BLOBS = [
  { x: 0.26, y: 0.30, r: 0.62, col: '70,88,186', a: 0.30, ax: 0.10, ay: 0.07, sp: 0.00013, px: 1.0 },
  { x: 0.74, y: 0.66, r: 0.56, col: '52,118,140', a: 0.24, ax: 0.09, ay: 0.08, sp: 0.00011, px: 0.7 },
  { x: 0.50, y: 0.20, r: 0.46, col: '98,76,152', a: 0.22, ax: 0.08, ay: 0.06, sp: 0.00015, px: 0.5 },
  { x: 0.84, y: 0.28, r: 0.36, col: '58,130,104', a: 0.17, ax: 0.06, ay: 0.05, sp: 0.00009, px: 0.35 },
];
const POINTER_LERP = 0.14;

let activeCleanup = null; // 单例守卫：重复挂载时先拆旧实例

export function initDynamic3D(canvas) {
  if (!canvas || REDUCED) return () => {};
  if (activeCleanup) activeCleanup(); // 防止双实例叠加

  const root = canvas.closest('.app-shell') || canvas.parentElement;
  const ctx = canvas.getContext('2d');
  if (!root || !ctx) return () => {};

  // ── 尺寸（降采样；CSS 尺寸仍铺满容器）──────────────
  let W = 0;
  let H = 0;
  let lastBgT = 0;
  const resize = () => {
    W = Math.max(1, Math.round(root.clientWidth / AURORA_SCALE));
    H = Math.max(1, Math.round(root.clientHeight / AURORA_SCALE));
    canvas.width = W;
    canvas.height = H;
    lastBgT = 0; // 尺寸变了立刻重绘一帧，避免拉伸期的旧画面
  };
  resize();

  // ── 背景：Aurora Mesh ───────────────────────────
  // 2026-10-19：用户看腻星空粒子（70 星 + 连线 + 流星），换成低饱和流动色雾。
  // 旧实现见 git 历史（粒子/连线/流星/指针斥力），回滚只需还原 drawBackground。
  const blobs = AURORA_BLOBS.map((b) => ({ ...b, ph: Math.random() * 6.2832 }));

  // ── 指针（目标 + 平滑）──────────────────────────
  let tx = window.innerWidth / 2;
  let ty = window.innerHeight * 0.4;
  let mx = tx;
  let my = ty;
  const onMove = (e) => {
    tx = e.clientX;
    ty = e.clientY;
  };
  window.addEventListener('mousemove', onMove, { passive: true });
  window.addEventListener('resize', resize);

  // ── 3D 注册表 ───────────────────────────────────
  const registered = new Map(); // el -> { preset, glareEl }
  const ensureGlare = (el) => {
    let glare = el.querySelector(':scope > .d3d-glare');
    if (!glare) {
      glare = document.createElement('span');
      glare.className = 'd3d-glare';
      glare.setAttribute('aria-hidden', 'true');
      el.appendChild(glare);
    }
    return glare;
  };
  const register = (el) => {
    if (!el || !el.matches('[data-tilt]') || registered.has(el)) return;
    const kind = el.getAttribute('data-tilt') || 'nav';
    const preset = TILT_PRESETS[kind] || TILT_PRESETS.nav;
    if (preset.glare) {
      const pos = window.getComputedStyle(el).position;
      if (pos === 'static') el.style.position = 'relative';
      if (!el.style.overflow) el.style.overflow = 'hidden';
    }
    registered.set(el, { preset, glareEl: preset.glare ? ensureGlare(el) : null });
  };
  const unregister = (el) => {
    const rec = registered.get(el);
    if (!rec) return;
    el.style.transform = '';
    el.style.boxShadow = '';
    el.style.position = '';
    el.style.overflow = '';
    if (rec.glareEl && rec.glareEl.parentNode) rec.glareEl.parentNode.removeChild(rec.glareEl);
    registered.delete(el);
  };
  const scan = (node) => {
    if (!(node instanceof Element)) return;
    if (node.matches('[data-tilt]')) register(node);
    node.querySelectorAll('[data-tilt]').forEach(register);
  };

  const observer = new MutationObserver((records) => {
    for (const rec of records) {
      rec.addedNodes.forEach(scan);
      rec.removedNodes.forEach((n) => {
        if (n instanceof Element) {
          if (n.matches('[data-tilt]')) unregister(n);
          n.querySelectorAll('[data-tilt]').forEach(unregister);
        }
      });
    }
  });
  observer.observe(root, { childList: true, subtree: true });
  scan(root);

  // ── 每帧：3D 更新 ───────────────────────────────
  const updateTilts = () => {
    for (const [el, rec] of registered) {
      const rect = el.getBoundingClientRect();
      if (!rect.width) continue;
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = mx - cx;
      const dy = my - cy;
      const dist = Math.hypot(dx, dy);
      const f = smooth(Math.max(0, 1 - dist / rec.preset.radius));
      const { max, lift, zoom, persp, shadow } = rec.preset;
      if (f < 0.015) {
        el.style.transform = '';
        el.style.boxShadow = '';
        if (rec.glareEl) rec.glareEl.style.opacity = '0';
        continue;
      }
      const ry = clamp(dx / rect.width, -1.1, 1.1) * max * f;
      const rx = clamp(-dy / rect.height, -1.1, 1.1) * max * f;
      el.style.transform =
        `perspective(${persp}px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)` +
        ` translateY(${(-lift * f).toFixed(2)}px) scale(${(1 + zoom * f).toFixed(4)})`;
      if (rec.glareEl) {
        rec.glareEl.style.setProperty('--gx', `${(50 + (dx / rect.width) * 40).toFixed(1)}%`);
        rec.glareEl.style.setProperty('--gy', `${(50 + (dy / rect.height) * 40).toFixed(1)}%`);
        rec.glareEl.style.opacity = (0.25 + 0.55 * f).toFixed(3);
      }
      if (shadow) {
        // hero：用自身 accent 色做动态投影（拿不到 accent 时退化为中性色）
        el.style.boxShadow =
          `${(-ry * 0.9).toFixed(1)}px ${(8 - rx * 0.9).toFixed(1)}px ${(26 + f * 16).toFixed(0)}px` +
          ` rgba(var(--home-accent-rgb, 109, 214, 153), ${(0.18 + f * 0.2).toFixed(3)}),` +
          ' 0 3px 10px rgba(0, 0, 0, 0.22)';
      }
    }
  };

  // ── 每帧：背景绘制 ──────────────────────────────
  // 首帧/尺寸变化后立即绘制；之后按 AURORA_FPS 限频（背景很慢，30fps 足够）
  const drawBackground = (t) => {
    if (lastBgT && t - lastBgT < 1000 / AURORA_FPS - 1) return;
    lastBgT = t;

    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'lighter';

    // 指针视差：以容器中心为原点，画布坐标需再除以降采样倍率
    const px = ((mx / Math.max(1, root.clientWidth)) - 0.5) * (AURORA_PARALLAX / AURORA_SCALE);
    const py = ((my / Math.max(1, root.clientHeight)) - 0.5) * (AURORA_PARALLAX / AURORA_SCALE);

    for (const b of blobs) {
      // 每团雾沿自己的正弦轨道漂移（周期 40~70s），互相错相 → 永不重复
      const x = (b.x + Math.sin(t * b.sp + b.ph) * b.ax) * W + px * b.px;
      const y = (b.y + Math.cos(t * b.sp * 0.8 + b.ph * 1.7) * b.ay) * H + py * b.px;
      const r = b.r * Math.max(W, H);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `rgba(${b.col}, ${b.a})`);
      g.addColorStop(0.45, `rgba(${b.col}, ${(b.a * 0.36).toFixed(3)})`);
      g.addColorStop(1, `rgba(${b.col}, 0)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }

    ctx.globalCompositeOperation = 'source-over';
  };

  // ── 单一 rAF 循环 ───────────────────────────────
  let rafId = 0;
  const frame = (t) => {
    mx += (tx - mx) * POINTER_LERP;
    my += (ty - my) * POINTER_LERP;
    drawBackground(t);
    updateTilts();
    rafId = window.requestAnimationFrame(frame);
  };
  rafId = window.requestAnimationFrame(frame);

  // ── cleanup ────────────────────────────────────
  const cleanup = () => {
    window.cancelAnimationFrame(rafId);
    observer.disconnect();
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('resize', resize);
    for (const el of [...registered.keys()]) unregister(el);
    ctx.clearRect(0, 0, W, H);
    if (activeCleanup === cleanup) activeCleanup = null;
  };
  activeCleanup = cleanup;
  return cleanup;
}

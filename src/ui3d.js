// ui3d.js — Dynamic Pro 3D 引擎（从 ui-demo/gs-bot-dynamic-3d.html 移植并 React 化）
//
// 职责：
//   1. 背景粒子引擎：canvas 上绘制 3 个径向渐变光球 + 70 个粒子 + 粒子连线，
//      指针斥力用「平滑指针」驱动（lerp 0.14），全部在单一 rAF 循环里。
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

const PARTICLE_COUNT = 70;
const LINK_DIST = 110;
const REPEL_RADIUS = 130;
const POINTER_LERP = 0.14;

let activeCleanup = null; // 单例守卫：重复挂载时先拆旧实例

export function initDynamic3D(canvas) {
  if (!canvas || REDUCED) return () => {};
  if (activeCleanup) activeCleanup(); // 防止双实例叠加

  const root = canvas.closest('.app-shell') || canvas.parentElement;
  const ctx = canvas.getContext('2d');
  if (!root || !ctx) return () => {};

  // ── 尺寸（DPR 感知）───────────────────────────────
  let W = 0;
  let H = 0;
  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = root.clientWidth;
    H = root.clientHeight;
    canvas.width = Math.max(1, Math.round(W * dpr));
    canvas.height = Math.max(1, Math.round(H * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();

  // ── 背景：粒子 ──────────────────────────────────
  // 请求 P（2026-09-29）：移除三团大半径径向光斑（原 blobs：紫 124,110,255@0.16 /
  // 蓝 64,160,255@0.14 / 绿 109,214,153@0.10，半径可达 ~350px）——它们沿窗口边缘
  // 与内容区 22px 圆角晕开，被读成「光晕边框」。保留粒子 + 连线。
  const particles = Array.from({ length: PARTICLE_COUNT }, () => ({
    // 锚点用画布比例坐标（0~1）：窗口/画布任意 resize 后自动重锚，不会聚集在旧区域
    hfx: Math.random(),
    hfy: Math.random(),
    ph: Math.random() * 6.2832,
    x: 0,
    y: 0,
    vx: (Math.random() - 0.5) * 0.35,
    vy: (Math.random() - 0.5) * 0.35,
    r: Math.random() * 1.6 + 0.6,
    // 背景动态（2026-09-29）：闪烁相位/速度 + ~8% 特亮星
    tw: Math.random() * 6.2832,
    ts: 0.6 + Math.random() * 1.1,
    bright: Math.random() < 0.08,
  }));

  // 流星池：同屏最多 2 颗，间隔 2.8~7s 随机；直线飞行 + 渐隐尾迹
  const meteors = [];
  let nextMeteorAt = 2200;
  let lastBgT = 0;

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
  let spawned = false; // 首帧按比例锚点撒粒子
  const drawBackground = (t) => {
    ctx.clearRect(0, 0, W, H);
    // 粒子：比例锚点漂移 + 指针斥力 + 归位弹簧（被推开后慢慢恢复原位）
    if (!spawned) {
      for (const p of particles) { p.x = p.hfx * W; p.y = p.hfy * H; }
      spawned = true;
    }
    for (const p of particles) {
      // 锚点 = 比例坐标 × 当前画布尺寸 + 缓慢正弦漂移（保持场域有机感）
      const hx = p.hfx * W + Math.sin(t * 0.0002 + p.ph) * 26;
      const hy = p.hfy * H + Math.cos(t * 0.00016 + p.ph) * 22;
      const dx = p.x - mx;
      const dy = p.y - my;
      const d2 = dx * dx + dy * dy;
      if (d2 < REPEL_RADIUS * REPEL_RADIUS && d2 > 0.01) {
        const d = Math.sqrt(d2);
        const force = ((REPEL_RADIUS - d) / REPEL_RADIUS) * 0.55;
        p.vx += (dx / d) * force;
        p.vy += (dy / d) * force;
      }
      p.vx += (hx - p.x) * 0.0025;
      p.vy += (hy - p.y) * 0.0025;
      p.vx *= 0.96;
      p.vy *= 0.96;
      p.vx += (Math.random() - 0.5) * 0.012;
      p.vy += (Math.random() - 0.5) * 0.012;
      p.x += p.vx;
      p.y += p.vy;
      // 软夹紧（不再对穿回绕，锚点弹簧会把粒子拉回家）
      if (p.x < -12) p.x = -12;
      if (p.x > W + 12) p.x = W + 12;
      if (p.y < -12) p.y = -12;
      if (p.y > H + 12) p.y = H + 12;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, 6.2832);
      // 闪烁：每颗星独立相位/速度；特亮星带柔光晕
      const twk = 0.68 + 0.32 * Math.sin(t * 0.0012 * p.ts + p.tw);
      if (p.bright) {
        const halo = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.r * 4.5);
        halo.addColorStop(0, `rgba(215, 228, 255, ${(0.42 * twk).toFixed(3)})`);
        halo.addColorStop(1, 'rgba(215, 228, 255, 0)');
        ctx.fillStyle = halo;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r * 4.5, 0, 6.2832);
        ctx.fill();
        ctx.fillStyle = `rgba(235, 242, 255, ${(0.85 * twk).toFixed(3)})`;
        ctx.arc(p.x, p.y, p.r * 1.15, 0, 6.2832);
        ctx.fill();
      } else {
        ctx.fillStyle = `rgba(190, 200, 255, ${(0.5 * twk).toFixed(3)})`;
        ctx.fill();
      }
    }
    // 连线
    ctx.lineWidth = 1;
    for (let i = 0; i < particles.length; i += 1) {
      for (let j = i + 1; j < particles.length; j += 1) {
        const a = particles[i];
        const b = particles[j];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d < LINK_DIST) {
          ctx.strokeStyle = `rgba(150, 165, 235, ${((1 - d / LINK_DIST) * 0.14).toFixed(3)})`;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(b.x, b.y);
          ctx.stroke();
        }
      }
    }
    // 流星：随机间隔生成，直线飞行 + 渐隐尾迹（画在粒子/连线上层）
    if (t > nextMeteorAt && meteors.length < 2) {
      const dir = Math.random() < 0.5 ? 1 : -1;
      const spd = (0.32 + Math.random() * 0.22) * (Math.max(W, H) / 1000);
      meteors.push({
        x: W * (0.15 + Math.random() * 0.7),
        y: H * (0.04 + Math.random() * 0.3),
        vx: dir * spd,
        vy: spd * (0.45 + Math.random() * 0.3),
        life: 0,
        maxLife: 750 + Math.random() * 650,
      });
      nextMeteorAt = t + 2800 + Math.random() * 4200;
    }
    const dt = lastBgT ? Math.min(64, t - lastBgT) : 16.7;
    lastBgT = t;
    for (let i = meteors.length - 1; i >= 0; i -= 1) {
      const m = meteors[i];
      m.life += dt;
      m.x += m.vx * dt;
      m.y += m.vy * dt;
      const k = m.life / m.maxLife;
      const fade = Math.sin(Math.min(1, k) * Math.PI);
      const sp = Math.hypot(m.vx, m.vy) || 1;
      const tail = 120 * (Math.max(W, H) / 1000);
      const tailX = m.x - (m.vx / sp) * tail;
      const tailY = m.y - (m.vy / sp) * tail;
      const grad = ctx.createLinearGradient(m.x, m.y, tailX, tailY);
      grad.addColorStop(0, `rgba(205, 222, 255, ${(0.8 * fade).toFixed(3)})`);
      grad.addColorStop(1, 'rgba(205, 222, 255, 0)');
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(m.x, m.y);
      ctx.lineTo(tailX, tailY);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(m.x, m.y, 1.6, 0, 6.2832);
      ctx.fillStyle = `rgba(236, 243, 255, ${(0.9 * fade).toFixed(3)})`;
      ctx.fill();
      if (m.life >= m.maxLife || m.x < -60 || m.x > W + 60 || m.y > H + 60) meteors.splice(i, 1);
    }
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

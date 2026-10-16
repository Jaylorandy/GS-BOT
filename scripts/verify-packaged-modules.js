#!/usr/bin/env node
/**
 * 打包完整性守卫 —— 在 electron-builder 打包前运行，静态检查「打包后会 require 失败」的两类事故。
 *
 * 起因（2026-10-14 体检发现的两类线上事故）：
 *   1) build.files 白名单漏列某个被 require 的顶层 .js
 *      实例：product-parser.js 在包内，require('./rag-service') 却不在 → 报告/Slides 分析链路炸
 *   2) 源码 require 了一个「未在 dependencies 声明」的包
 *      electron-builder 只打包生产依赖闭包，未声明的包不会进包（dev 环境下能跑，打包后炸）
 *      实例：label-ocr-engine.js 的 Paddle 云 OCR 路径 require('form-data')，而 form-data 只是
 *            electron-publish（dev 依赖）的传递依赖 → 线上必然 MODULE_NOT_FOUND
 *
 * 退出码 0 = 通过；1 = 发现问题（构建应中断）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const FILES = (pkg.build && pkg.build.files) || [];

const errors = [];
const warns = [];

const BUILTINS = new Set(Module.builtinModules);
// 覆盖 require('x') / require.resolve('x') / import('x')，但不匹配散文里的 from 'x'
const RELATIVE_RE = /(?:\brequire(?:\.resolve)?|\bimport)\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
const BARE_RE = /(?:\brequire(?:\.resolve)?|\bimport)\s*\(\s*['"]([^'"./][^'"]*)['"]\s*\)/g;

// ── build.files 里「指向本地文件的字面条目」（排除 glob 与 node_modules） ──
const literalLocal = FILES.filter(
  (p) => !p.startsWith('!') && !p.startsWith('node_modules/') && !p.includes('*'),
);

// ── 检查 0：字面条目在磁盘上存在（捕捉改名/删除后的陈旧条目） ──
for (const f of literalLocal) {
  if (f.endsWith('/')) continue; // 目录条目
  if (!fs.existsSync(path.join(ROOT, f))) {
    const isFileLike = /\.[a-z0-9]+$/i.test(f);
    (isFileLike ? errors : warns).push(`build.files 条目在磁盘上不存在：${f}`);
  }
}

// ── 打包面运行时入口 ──
const ENTRIES = ['main.js', 'preload.js'].filter((f) => fs.existsSync(path.join(ROOT, f)));

function resolveRelative(fromAbs, spec) {
  const base = path.resolve(path.dirname(fromAbs), spec);
  for (const c of [base, `${base}.js`, `${base}.cjs`, `${base}.json`, path.join(base, 'index.js')]) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch { /* 继续 */ }
  }
  return null;
}

// ── 检查 1：本地相对 require 的可达闭包必须全部被 build.files 覆盖 ──
const reachable = new Map(); // abs -> Set(引用者)
const queue = ENTRIES.map((f) => path.join(ROOT, f));
while (queue.length) {
  const file = queue.shift();
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch { continue; }
  let m; RELATIVE_RE.lastIndex = 0;
  while ((m = RELATIVE_RE.exec(src))) {
    const target = resolveRelative(file, m[1]);
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    if (!target) {
      errors.push(`${rel} 里的相对引用解析不到文件：${m[1]}`);
      continue;
    }
    if (target.endsWith('.json')) continue;
    if (!reachable.has(target)) { reachable.set(target, new Set()); queue.push(target); }
    reachable.get(target).add(rel);
  }
}

const literalSet = new Set(literalLocal);
for (const abs of reachable.keys()) {
  const rel = path.relative(ROOT, abs).replace(/\\/g, '/');
  // 渲染层源码由 esbuild 打进 dist/，不按文件逐个打包
  if (rel.startsWith('src/') || rel.startsWith('dist/')) continue;
  if (!literalSet.has(rel)) {
    errors.push(
      `模块被 require 但未列入 build.files：${rel}\n` +
      `      引用者：${[...reachable.get(abs)].join(', ')}`,
    );
  }
}

// ── 检查 2：生产依赖闭包 —— 源码 require 的裸包必须真的会进包 ──
const prodRoots = [
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.optionalDependencies || {}),
];
const prodClosure = new Set();
const dq = [...prodRoots];
while (dq.length) {
  const name = dq.shift();
  if (prodClosure.has(name)) continue;
  prodClosure.add(name);
  const dir = path.join(ROOT, 'node_modules', ...name.split('/'));
  let meta;
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { continue; }
  for (const d of Object.keys(meta.dependencies || {})) dq.push(d);
  for (const d of Object.keys(meta.optionalDependencies || {})) dq.push(d);
}

// build.files 中显式列出的 node_modules 包
const listedNodePkgs = new Set();
for (const p of FILES) {
  const m = p.match(/^!?node_modules\/((?:@[^/]+\/[^/]+|[^/]+))(\/|$)/);
  if (m) listedNodePkgs.add(m[1]);
}

const packagedJs = literalLocal.filter(
  (rel) => /\.(js|cjs|mjs)$/.test(rel) && fs.existsSync(path.join(ROOT, rel)),
);

for (const rel of packagedJs) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  let m; BARE_RE.lastIndex = 0;
  const seen = new Set();
  while ((m = BARE_RE.exec(src))) {
    const spec = m[1];
    if (spec.startsWith('node:')) continue;
    const parts = spec.split('/');
    const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
    if (BUILTINS.has(name) || name === 'electron' || seen.has(name)) continue;
    seen.add(name);

    if (!prodClosure.has(name)) {
      errors.push(
        `require('${name}') 不在生产依赖闭包里，打包后必然 MODULE_NOT_FOUND\n` +
        `      位置：${rel}\n` +
        `      修法：把 "${name}" 加进 package.json 的 dependencies（或改掉这处 require）`,
      );
    } else if (!listedNodePkgs.has(name) && !listedNodePkgs.has('*')) {
      // 生产依赖会被 electron-builder 自动收进来；这里只提示显式白名单不完整
      warns.push(`require('${name}') 是生产依赖，但 build.files 未显式列出它（依赖自动收集兜底）  位置：${rel}`);
    }
  }
}

// ── 检查 3：声明了但没人用的生产依赖（白占安装包体积） ──
// 实例：exceljs 在 dependencies 里躺了很久、源码零引用，却被 electron-builder
// 一并打进 asar（含它 20 MB 的传递依赖树）；react/react-dom 只是渲染层构建期依赖。
const usedBare = new Set();
for (const rel of packagedJs) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  let m; BARE_RE.lastIndex = 0;
  while ((m = BARE_RE.exec(src))) {
    const spec = m[1];
    if (spec.startsWith('node:')) continue;
    const parts = spec.split('/');
    usedBare.add(spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
  }
}

const dependedOn = new Set();
for (const name of prodClosure) {
  const dir = path.join(ROOT, 'node_modules', ...name.split('/'));
  let meta;
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { continue; }
  for (const d of Object.keys({ ...(meta.dependencies || {}), ...(meta.optionalDependencies || {}) })) dependedOn.add(d);
}

for (const name of Object.keys(pkg.dependencies || {})) {
  if (usedBare.has(name) || dependedOn.has(name)) continue;
  warns.push(
    `dependencies 里的 "${name}" 没有被任何打包文件 require，也没有被其他依赖引用 —— ` +
    '它只会白占安装包体积，建议移除或移到 devDependencies',
  );
}

// ── 输出 ──
const line = '─'.repeat(66);
console.log(line);
console.log('打包完整性守卫  verify-packaged-modules');
console.log(line);
console.log(`  入口：${ENTRIES.join(', ')}`);
console.log(`  可达本地模块：${reachable.size}   生产依赖闭包：${prodClosure.size} 个包`);
console.log(`  build.files 字面条目：${literalLocal.length}  显式 node_modules 包：${listedNodePkgs.size}`);

if (errors.length) {
  console.log('');
  console.log(`🔴 发现 ${errors.length} 个会导致打包后运行失败的问题：`);
  errors.forEach((e, i) => console.log(`  ${i + 1}. ${e}`));
}
if (warns.length) {
  console.log('');
  console.log(`⚠️  ${warns.length} 条提示（不阻塞构建）：`);
  warns.slice(0, 15).forEach((w) => console.log(`  - ${w}`));
  if (warns.length > 15) console.log(`  … 另有 ${warns.length - 15} 条`);
}

console.log('');
if (errors.length) {
  console.log('结果：FAILED —— 请先修复上述问题再打包。');
  process.exit(1);
}
console.log('结果：PASS —— 打包面完整。');

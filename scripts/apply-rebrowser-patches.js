#!/usr/bin/env node
/**
 * 对 node_modules/puppeteer-core 应用 rebrowser-patches（CJS 适配版）。
 *
 * 背景：rebrowser-patches 用于堵住 Puppeteer 的 CDP `Runtime.enable` 泄漏。
 * 上游最后一次发版是 1.0.19（2025-05-09），README 明写官方完全测试到
 * puppeteer 24.8.1；本项目使用 24.43.1，原版补丁有 4 个 hunk 因上游把
 * `newPage()` / `_createPageInContext()` 加上 options 参数而失配。
 * patches/rebrowser-cjs-adapted.patch 是仅针对 lib/cjs 的适配版
 * （esm 与 es5-iife 已剔除，本项目只经 require() 走 CJS），
 * 实测 dry-run 9/9 文件 0 FAILED，运行时 Runtime 域确认不再启用。
 *
 * 行为：幂等 —— 先用「内容校验和」判定是否已完整应用；不一致则先反向还原、
 * 再正向应用（因为 `patch --forward` 遇到文件级 reversed 时会跳过整个文件，
 * 单靠重复执行无法补回缺失的 hunk）。失败只告警，绝不阻塞 npm install。
 * 回滚：cd node_modules/puppeteer-core && patch -p1 -R --input=<补丁路径>
 */
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PKG_DIR = path.join(ROOT, 'node_modules', 'puppeteer-core');
const PATCH_FILE = path.join(ROOT, 'patches', 'rebrowser-cjs-adapted.patch');

const log = (m) => { console.log('[rebrowser-patch] ' + m); };

if (!fs.existsSync(PKG_DIR)) {
  log('未找到 node_modules/puppeteer-core，跳过。');
  process.exit(0);
}
if (!fs.existsSync(PATCH_FILE)) {
  log('未找到补丁文件，跳过：' + PATCH_FILE);
  process.exit(0);
}

let version = 'unknown';
try {
  version = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')).version;
} catch { /* 读不到版本不影响流程 */ }

// ── 完整性判定：内容校验和，而非字符串标记 ─────────────────────────────
// 旧实现是「扫 cdp 目录，任一文件含 'rebrowser-patches' 就整体跳过」。
// 2026-10-14 事故：IsolatedWorld.js 的 hunk 3/4 因补丁文件自身格式错误被 patch
// 静默丢弃，但同目录 FrameManager.js 带标记 → 整体判定为「已完成」，
// 于是 page.$ / page.$$ / $eval / handle.click / boundingBox 全部报
// "Node with given id does not belong to the document"，潜伏整整一轮。
// 更隐蔽的是：`patch --forward` 在文件级 reversed 时会跳过**整个文件**，
// 重复执行也补不回缺失的 hunk —— 所以必须先反向还原再正向应用。
const PATCH_TARGETS = (() => {
  const set = [];
  try {
    for (const line of fs.readFileSync(PATCH_FILE, 'utf8').split('\n')) {
      if (line.startsWith('+++ b/')) {
        const f = line.slice(6).trim();
        if (!set.includes(f)) set.push(f);
      }
    }
  } catch { /* 解析失败则退化为空表，仍走正常 patch 流程 */ }
  return set;
})();

const sha256 = (abs) => (fs.existsSync(abs)
  ? crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')
  : null);
const snapshotTargets = () =>
  Object.fromEntries(PATCH_TARGETS.map((rel) => [rel, sha256(path.join(PKG_DIR, rel))]));

const STATE_FILE = path.join(ROOT, 'patches', '.applied-state.json');

if (PATCH_TARGETS.length > 0 && fs.existsSync(STATE_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const cur = snapshotTargets();
    const drift = PATCH_TARGETS.filter((rel) => !saved[rel] || saved[rel] !== cur[rel]);
    if (drift.length === 0) {
      log('puppeteer-core@' + version + ' 补丁已完整应用（' + PATCH_TARGETS.length + ' 个文件校验和一致），跳过。');
      process.exit(0);
    }
    log('⚠️ 校验和与上次成功记录不一致，' + drift.length + '/' + PATCH_TARGETS.length + ' 个文件可能未完整打补丁：');
    drift.forEach((f) => log('  - ' + f));
    log('  → 执行「先反向还原、再正向应用」以保证幂等。');
  } catch { /* 状态文件损坏 → 继续走还原 + 应用 */ }
}

// 1) 尽力反向还原到原始状态（首次安装时反向失败属正常，忽略）
try {
  execFileSync('patch', ['-p1', '-R', '--batch', '--forward', '--input=' + PATCH_FILE, '--reject-file=-'],
    { cwd: PKG_DIR, encoding: 'utf8' });
  log('已按反向补丁把目标文件还原到原始状态。');
} catch (e) {
  const lines = (String((e && e.stdout) || '') + String((e && e.stderr) || ''))
    .split('\n').filter((l) => /FAILED|Reversed|ignored|Hunk #/.test(l)).slice(-4);
  log('反向还原未完全成功（首次安装属正常）：' + (lines.join(' | ') || 'n/a'));
}

// 2) 正向应用
try {
  const out = execFileSync('patch', [
    '--batch',
    '-p1',
    '--input=' + PATCH_FILE,
    '--no-backup-if-mismatch',
    '--reject-file=-',
    '--forward',
  ], { cwd: PKG_DIR, encoding: 'utf8' });

  const failed = String(out || '').split('\n').filter((l) => /FAILED/.test(l));
  if (failed.length) {
    log('⚠️ 存在 FAILED hunk，补丁未完整应用，请复查：');
    failed.forEach((l) => log('  ' + l));
  } else {
    log('puppeteer-core@' + version + ' 补丁应用成功。');
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(snapshotTargets(), null, 1) + '\n', 'utf8');
      log('已记录 ' + PATCH_TARGETS.length + ' 个目标文件的校验和。');
    } catch { /* 状态文件写失败不影响补丁本身 */ }
  }
} catch (e) {
  log('⚠️ 补丁应用失败（不阻塞安装）。puppeteer-core@' + version);
  if (e.stdout) log('  stdout: ' + String(e.stdout).trim().split('\n').slice(-6).join('\n  '));
  if (e.stderr) log('  stderr: ' + String(e.stderr).trim().split('\n').slice(-6).join('\n  '));
  log('  常见原因：PATH 中无 patch 命令（Windows 需 Git for Windows），');
  log('  或 puppeteer-core 版本已变动导致 hunk 失配 —— 此时需重新适配补丁。');
}
process.exit(0);

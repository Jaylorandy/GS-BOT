/**
 * ref/core/cache.js — 版式指纹算法（复刻 Purchase Order Extractor V2 core/store/cache.py）
 *
 * 逆向来源：core__store__cache__dis.txt（3370 行反汇编，逐字节码还原）
 *
 * 指纹语义：内容不敏感（数字/款号/色码/长单词全部屏蔽为 '#'），同布局不同
 * 数据 → 同一指纹；不同布局 → 不同指纹。最终指纹 = SHA256(skeleton) 前 32 位。
 *
 * 管线：逐 token 屏蔽 → _collapseTokens（相邻重复跳过 + 子序列 RLE 折叠）
 *      → _collapseValueRuns（纯 # run → 单 #）→ _normalizeParens（(纯#) → (#) + 合并）
 *      → 去重排序 token 类型序列 → markers（<<HAS_*>>）拼接到指纹串。
 *
 * 设计铁律（对齐原版 docstring）：
 *  - ORDER VOLUME（行数/尺码列数/小计）不影响指纹
 *  - TEMPLATE IDENTITY（标签词集合/顺序）决定指纹
 *  - 结构标点 '(' ')' '<' '>' '+' '!' '=' 保留，行列版式仍可区分
 */

const crypto = require('crypto');

const APP_NAME = 'Purchase Order Extractor V2';
const CACHE_SCHEMA = 3;

/** 引号类字符集合（命中即屏蔽） */
const _APOS = new Set("'‘’‛`´ʼˮ".split(''));

/** 长字母数字 token（≥2 字符）→ '#' */
const _MARK_RE = /[A-Za-z0-9]{2,}/g;

/**
 * 子序列 RLE 折叠：相同 token 连续段折叠为一段。
 * 先相邻去重，再贪心删除 [i, i+L) == [i+L, i+2L) 的重复段，循环直至稳定。
 * @param {string[]} toks
 * @returns {string[]}
 */
function _collapseTokens(toks) {
  // 第一遍：相邻重复跳过
  const dedup = [];
  for (const t of toks) {
    if (dedup.length && t === dedup[dedup.length - 1]) continue;
    dedup.push(t);
  }

  let out = dedup;
  let changed = true;
  while (changed) {
    changed = false;
    const n = out.length;
    for (let i = 0; i < n; i++) {
      const maxL = Math.floor((n - i) / 2);
      for (let L = maxL; L > 0; L--) {
        const a = out.slice(i, i + L);
        const b = out.slice(i + L, i + 2 * L);
        if (a.join('\u0000') === b.join('\u0000')) {
          out.splice(i + L, L);
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
  }
  return out;
}

/**
 * 纯 '#' run → 单个 '#'。数字/代码屏蔽后表头区出现长度不定的 '#' 序列，
 * 折叠后指纹对内容词数量不敏感，而结构标点保留。
 * @param {string[]} toks
 * @returns {string[]}
 */
function _collapseValueRuns(toks) {
  const out = [];
  let buf = 0;
  for (const t of toks) {
    if (/^#+$/.test(t)) {
      buf += 1;
    } else {
      if (buf) { out.push('#'); buf = 0; }
      out.push(t);
    }
  }
  if (buf) out.push('#');
  return out;
}

/**
 * 括号内容组折叠：'(' 后紧跟若干 '#' 直到 ')' → '(#)'；连续 '(#)' 合并。
 * @param {string[]} toks
 * @returns {string[]}
 */
function _normalizeParens(toks) {
  const out = [];
  let i = 0;
  const n = toks.length;
  while (i < n) {
    if (toks[i] === '(') {
      let j = i + 1;
      let ok = false;
      while (j < n) {
        if (toks[j] === ')') { ok = true; break; }
        if (toks[j] !== '#') break;
        j += 1;
      }
      if (ok) {
        out.push('(#)');
        i = j + 1;
        continue;
      }
    }
    out.push(toks[i]);
    i += 1;
  }

  // 合并连续 '(#)'
  const res = [];
  let run = 0;
  for (const t of out) {
    if (t === '(#)') {
      run += 1;
    } else {
      if (run) { res.push('(#)'); run = 0; }
      res.push(t);
    }
  }
  if (run) res.push('(#)');
  return res;
}

/**
 * 版式骨架：逐行 split token → 逐 token 屏蔽 → 折叠 → 去重排序 token 类型序列。
 * @param {string} text
 * @returns {string} 指纹串（markers 换行 + token 类型空格连接）
 */
function skeleton(text) {
  const markers = [];
  if (/Entity\s+\d+\s+Order No/.test(text)) markers.push('<<HAS_ENTITY>>');
  if (text.includes('Destination Code')) markers.push('<<HAS_DESTINATION>>');
  if (text.includes('COLOR NO')) markers.push('<<HAS_COLORNO>>');

  const toks = [];
  // Python str.splitlines()：按 \n \r \r\n \v \f \x1c-\x1e \x85 \u2028 \u2029 拆分
  const lines = String(text).split(/[\r\n\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  for (const ln of lines) {
    for (const raw of ln.trim().split(/\s+/)) {
      if (raw === '') continue;

      // 含数字 → '#'
      if (/\d/.test(raw)) { toks.push('#'); continue; }
      // 非 ASCII → '#'
      if ([...raw].some((c) => c.codePointAt(0) > 127)) { toks.push('#'); continue; }
      // 含引号 / apostrophe → '#'
      if ([...raw].some((c) => _APOS.has(c))) { toks.push('#'); continue; }
      // 连字符代码 / 下划线 / 点(含字母) → '#'
      if (raw.includes('-') || raw.includes('_') || (raw.includes('.') && /[A-Za-z]/.test(raw))) {
        toks.push('#'); continue;
      }
      // 字母后跟 ) 或 .（项目符号 "a)" "b." 等）→ '#'
      if (/[A-Za-z][).]/.test(raw)) { toks.push('#'); continue; }

      let t = raw.replace(_MARK_RE, '#');
      t = t.replace(/[.,:;/\-_&]+/g, '#');
      // 1-2 字母（如 US / A / B）→ '#'
      if (/^[A-Za-z]{1,2}$/.test(t)) t = '#';
      toks.push(t);
    }
  }

  const body = _normalizeParens(_collapseValueRuns(_collapseTokens(toks)));
  const seq = [...new Set(body)].sort();
  // return '\n'.join(sorted(markers) + [' '.join(seq)])
  return [...markers.sort(), seq.join(' ')].join('\n');
}

/**
 * 布局指纹：SHA256(skeleton) 前 32 位 hex。
 * @param {string} rawText
 * @returns {string}
 */
function layoutFingerprint(rawText) {
  return crypto.createHash('sha256').update(skeleton(rawText), 'utf8').digest('hex').slice(0, 32);
}

/**
 * 布局感知指纹（extraction 缓存键）。
 * 结构检测命中 → 追加 `_<layout>` 后缀（消除同骨架不同版式碰撞）；
 * 未命中 → 与 layoutFingerprint 完全一致（兼容旧缓存）。
 * @param {string} rawText
 * @param {string} [structuralLayout] 由调用方传入 detectStructuralLayout 的结果（recipe_synth 落地后接线）
 * @returns {string}
 */
function layoutFingerprintScoped(rawText, structuralLayout = '') {
  const base = layoutFingerprint(rawText);
  if (structuralLayout) return `${base}_${structuralLayout}`;
  return base;
}

module.exports = {
  APP_NAME,
  CACHE_SCHEMA,
  skeleton,
  layoutFingerprint,
  layoutFingerprintScoped,
  _collapseTokens,
  _collapseValueRuns,
  _normalizeParens,
};

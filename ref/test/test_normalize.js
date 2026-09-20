#!/usr/bin/env node
/**
 * test_normalize.js — 校验 ref/core/normalize.js 与原版 normalize.pyc oracle 输出一致。
 * 前置：oracle_normalize.json 已由 oracle_normalize.py 生成（见同目录生成脚本）。
 *
 * 覆盖：
 *   1. 11 个常量/词表深比较（_NORMALIZERS 为函数映射，只比键集合）
 *   2. 7 组标量函数采样逐条断言
 *      - _normalize_amount(s)
 *      - _normalize_season(s, {})
 *      - _normalize_inseam(s, {})
 *      - _normalize_payment_terms(s, {})
 *      - _normalize_size(s, _SIZE_VOCAB)
 *      - _normalize_term(s, vocab)   // 词表按采样分组，硬编码自 oracle_normalize.py
 *      - _normalize_date(s, '', dayfirst)  // 键尾 _dayfirst → dayfirst=true
 */
const fs = require('fs');
const path = require('path');
const norm = require('../core/normalize');

const oracle = JSON.parse(fs.readFileSync(path.join(__dirname, 'oracle_normalize.json'), 'utf8'));

let fail = 0;
const ok = (cond, msg) => {
  if (!cond) { fail++; console.log(`  FAIL: ${msg}`); }
  else console.log(`  ok: ${msg}`);
};

// ---------- 1. 常量深比较 ----------
function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length) return false;
    return ka.every((k, i) => k === kb[i] && deepEqual(a[k], b[k]));
  }
  return false;
}

const CONST_KEYS = [
  '_SU_VOCAB', '_CURRENCY_VOCAB', '_PRICE_TERM_VOCAB', '_SHIP_MODE_VOCAB',
  '_COUNTRY_VOCAB', '_SIZE_VOCAB', '_PORT_FORBIDDEN_SHIP_WORDS',
  '_DATE_FIELDS', '_EXPLICIT_FORMATS', '_NUMERIC_FORMATS',
];
console.log('== constants ==');
for (const k of CONST_KEYS) {
  ok(deepEqual(norm[k], oracle[k]), `${k} 深比较一致`);
}
ok(
  Array.isArray(norm._NUMERIC_FORMATS) && norm._NUMERIC_FORMATS.every(p => Array.isArray(p) && p.length === 2 && typeof p[1] === 'boolean'),
  '_NUMERIC_FORMATS 结构为 [format, dayfirst] 对'
);
const normKeys = Object.keys(norm._NORMALIZERS).sort();
const oracleKeys = Object.keys(oracle._NORMALIZERS).sort();
ok(
  normKeys.length === oracleKeys.length && normKeys.every((k, i) => k === oracleKeys[i]),
  `_NORMALIZERS 键集合一致 (${normKeys.join(',')})`
);

// ---------- 2. 函数采样 ----------
console.log('== _normalize_amount ==');
for (const [input, expected] of Object.entries(oracle._normalize_amount)) {
  const got = norm._normalize_amount(input);
  ok(got === expected, `${JSON.stringify(input)} → ${JSON.stringify(expected)} (got ${JSON.stringify(got)})`);
}

console.log('== _normalize_season ==');
for (const [input, expected] of Object.entries(oracle._normalize_season)) {
  const got = norm._normalize_season(input, {});
  ok(got === expected, `${JSON.stringify(input)} → ${JSON.stringify(expected)} (got ${JSON.stringify(got)})`);
}

console.log('== _normalize_inseam ==');
for (const [input, expected] of Object.entries(oracle._normalize_inseam)) {
  const got = norm._normalize_inseam(input, {});
  ok(got === expected, `${JSON.stringify(input)} → ${JSON.stringify(expected)} (got ${JSON.stringify(got)})`);
}

console.log('== _normalize_payment_terms ==');
for (const [input, expected] of Object.entries(oracle._normalize_payment_terms)) {
  const got = norm._normalize_payment_terms(input, {});
  ok(got === expected, `${JSON.stringify(input)} → ${JSON.stringify(expected)} (got ${JSON.stringify(got)})`);
}

console.log('== _normalize_size ==');
for (const [input, expected] of Object.entries(oracle._normalize_size)) {
  const got = norm._normalize_size(input, norm._SIZE_VOCAB);
  ok(got === expected, `${JSON.stringify(input)} → ${JSON.stringify(expected)} (got ${JSON.stringify(got)})`);
}

console.log('== _normalize_term ==');
// 词表分组：硬编码自 oracle_normalize.py 的采样调用
const TERM_VOCAB = {
  usd: '_CURRENCY_VOCAB', EUROS: '_CURRENCY_VOCAB',
  'by sea': '_SHIP_MODE_VOCAB', VESSEL: '_SHIP_MODE_VOCAB',
  'P.R.CHINA': '_COUNTRY_VOCAB',
  pc: '_SU_VOCAB', PAIRS: '_SU_VOCAB', DOZENS: '_SU_VOCAB',
};
for (const [input, expected] of Object.entries(oracle._normalize_term)) {
  const vocab = norm[TERM_VOCAB[input]];
  const got = norm._normalize_term(input, vocab);
  ok(got === expected, `${JSON.stringify(input)} → ${JSON.stringify(expected)} (got ${JSON.stringify(got)})`);
}

console.log('== _normalize_date ==');
for (const [key, expected] of Object.entries(oracle._normalize_date)) {
  const dayfirst = key.endsWith('_dayfirst');
  const input = dayfirst ? key.slice(0, -'_dayfirst'.length) : key;
  const got = norm._normalize_date(input, '', dayfirst);
  ok(got === expected, `${JSON.stringify(input)} dayfirst=${dayfirst} → ${JSON.stringify(expected)} (got ${JSON.stringify(got)})`);
}

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);

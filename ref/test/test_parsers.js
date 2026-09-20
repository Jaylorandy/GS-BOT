#!/usr/bin/env node
/**
 * test_parsers.js — 校验 ref/core/parsers/base.js + line_items.js
 *   与原版 .pyc oracle 输出一致。
 *
 * 覆盖 oracle_parsers.json 的全量键：
 *   Token (xc/yc/is_number/eq)
 *   PageWords (lines/text/empty)
 *   _to_int / _to_float / _looks_like_style / _looks_like_sku
 *   norm_date / extract_color_from_combined / merge_wrapped_rows
 *   _color_desc_from / _recover_style_from_line / _parse_size_breakdown
 *   _norm_ship / LineItemsParser
 *
 * 风格对齐 test_models.js：deepEqual + ok/FAIL + fail 计数 + process.exit。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const B = require('../core/parsers/base');
const LI = require('../core/parsers/line_items');

const rawOracle = fs.readFileSync(path.join(__dirname, 'oracle_parsers.json'), 'utf8');
const oracle = JSON.parse(rawOracle.replace(/^\uFEFF/, ''));

let fail = 0;
const ok = (cond, msg) => {
  if (!cond) { fail++; console.log(`  FAIL: ${msg}`); }
  else console.log(`  ok: ${msg}`);
};

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

// ── Token ──────────────────────────────────────────────────
console.log('\n=== Token ===');

const Tok = B.Token;

// xc / yc
{
  const t = new Tok({ text: 'hello', x0: 1, y0: 2, x1: 3, y1: 4, page: 0 });
  ok(t.xc === oracle.Token.xc, `Token.xc = ${t.xc} (expect ${oracle.Token.xc})`);
  ok(t.yc === oracle.Token.yc, `Token.yc = ${t.yc} (expect ${oracle.Token.yc})`);
}

// is_number
for (const [txt, expected] of Object.entries(oracle.Token.is_number)) {
  const t = new Tok({ text: txt, x0: 0, y0: 0, x1: 10, y1: 10, page: 0 });
  const result = t.is_number();
  ok(result === expected, `Token.is_number('${txt}') = ${result} (expect ${expected})`);
}

// eq
ok(new Tok({ text: 'A', x0: 0, y0: 0, x1: 10, y1: 10, page: 0 }).equals(new Tok({ text: 'A', x0: 0, y0: 0, x1: 10, y1: 10, page: 0 })) === oracle.Token.eq_same, 'Token.eq_same');
ok(new Tok({ text: 'A', x0: 0, y0: 0, x1: 10, y1: 10, page: 0 }).equals(new Tok({ text: 'B', x0: 0, y0: 0, x1: 10, y1: 10, page: 0 })) === oracle.Token.eq_diff_text, 'Token.eq_diff_text');
ok(new Tok({ text: 'A', x0: 0, y0: 0, x1: 10, y1: 10, page: 0 }).equals(new Tok({ text: 'A', x0: 1, y0: 0, x1: 10, y1: 10, page: 0 })) === oracle.Token.eq_diff_x, 'Token.eq_diff_x');

// ── PageWords ──────────────────────────────────────────────
console.log('\n=== PageWords ===');

{
  const tokens = [
    new Tok({ text: 'COLOR', x0: 0, y0: 0, x1: 50, y1: 10, page: 0 }),
    new Tok({ text: 'NO', x0: 55, y0: 0, x1: 70, y1: 10, page: 0 }),
    new Tok({ text: 'XS', x0: 80, y0: 0, x1: 90, y1: 10, page: 0 }),
    new Tok({ text: 'S', x0: 95, y0: 0, x1: 105, y1: 10, page: 0 }),
    new Tok({ text: 'M', x0: 110, y0: 0, x1: 120, y1: 10, page: 0 }),
    new Tok({ text: 'TOTAL', x0: 200, y0: 0, x1: 240, y1: 10, page: 0 }),
    new Tok({ text: '637JO', x0: 0, y0: 20, x1: 40, y1: 30, page: 0 }),
    new Tok({ text: '80X', x0: 45, y0: 20, x1: 65, y1: 30, page: 0 }),
    new Tok({ text: '100', x0: 80, y0: 20, x1: 95, y1: 30, page: 0 }),
    new Tok({ text: '200', x0: 95, y0: 20, x1: 110, y1: 30, page: 0 }),
    new Tok({ text: '150', x0: 110, y0: 20, x1: 125, y1: 30, page: 0 }),
    new Tok({ text: '450', x0: 200, y0: 20, x1: 240, y1: 30, page: 0 }),
  ];
  const pw = new B.PageWords({ page: 0, width: 300, height: 100, tokens });
  const lines = pw.lines();
  ok(lines.length === oracle.PageWords.lines_count, `PageWords.lines count = ${lines.length} (expect ${oracle.PageWords.lines_count})`);
  ok(deepEqual(lines[0].map(t => t.text), oracle.PageWords.line0), 'PageWords.line0 texts');
  ok(deepEqual(lines[1].map(t => t.text), oracle.PageWords.line1), 'PageWords.line1 texts');
  ok(pw.text() === oracle.PageWords.text, `PageWords.text matches`);
}

// 3-line page
{
  const tokens3 = [
    new Tok({ text: 'A', x0: 0, y0: 0, x1: 10, y1: 10, page: 0 }),
    new Tok({ text: 'B', x0: 20, y0: 0, x1: 30, y1: 10, page: 0 }),
    new Tok({ text: 'C', x0: 0, y0: 20, x1: 10, y1: 30, page: 0 }),
    new Tok({ text: 'D', x0: 20, y0: 20, x1: 30, y1: 30, page: 0 }),
    new Tok({ text: 'E', x0: 0, y0: 40, x1: 10, y1: 50, page: 0 }),
  ];
  const pw3 = new B.PageWords({ page: 1, width: 100, height: 100, tokens: tokens3 });
  const lines3 = pw3.lines();
  ok(lines3.length === oracle.PageWords.lines3_count, `PageWords.lines3 count = ${lines3.length} (expect ${oracle.PageWords.lines3_count})`);
  ok(deepEqual(lines3.map(l => l.map(t => t.text)), oracle.PageWords.lines3), 'PageWords.lines3 texts');
}

// Empty page
{
  const pw_empty = new B.PageWords({ page: 0, width: 100, height: 100, tokens: [] });
  ok(deepEqual(pw_empty.lines(), oracle.PageWords.empty_lines), 'PageWords.empty.lines');
  ok(pw_empty.text() === oracle.PageWords.empty_text, 'PageWords.empty.text');
}

// ── _to_int ────────────────────────────────────────────────
console.log('\n=== _to_int ===');
for (const [input, expected] of Object.entries(oracle._to_int)) {
  const result = B._to_int(input === 'None' ? null : input);
  ok(deepEqual(result, expected), `_to_int('${input}') = ${result} (expect ${expected})`);
}

// ── _to_float ──────────────────────────────────────────────
console.log('\n=== _to_float ===');
for (const [input, expected] of Object.entries(oracle._to_float)) {
  const result = B._to_float(input === 'None' ? null : input);
  ok(deepEqual(result, expected), `_to_float('${input}') = ${result} (expect ${expected})`);
}

// ── _looks_like_style ──────────────────────────────────────
console.log('\n=== _looks_like_style ===');
for (const [input, expected] of Object.entries(oracle._looks_like_style)) {
  const result = B._looks_like_style(input);
  ok(result === expected, `_looks_like_style('${input}') = ${result} (expect ${expected})`);
}

// ── _looks_like_sku ────────────────────────────────────────
console.log('\n=== _looks_like_sku ===');
for (const [input, expected] of Object.entries(oracle._looks_like_sku)) {
  const result = B._looks_like_sku(input);
  ok(result === expected, `_looks_like_sku('${input}') = ${result} (expect ${expected})`);
}

// ── norm_date ──────────────────────────────────────────────
console.log('\n=== norm_date ===');
for (const [input, expected] of Object.entries(oracle.norm_date)) {
  const result = B.norm_date(input);
  ok(result === expected, `norm_date('${input}') = '${result}' (expect '${expected}')`);
}

// ── extract_color_from_combined ────────────────────────────
console.log('\n=== extract_color_from_combined ===');
for (const [input, expected] of Object.entries(oracle.extract_color_from_combined)) {
  const result = B.extract_color_from_combined(input);
  ok(result === expected, `extract_color_from_combined('${input}') = '${result}' (expect '${expected}')`);
}

// ── merge_wrapped_rows ─────────────────────────────────────
console.log('\n=== merge_wrapped_rows ===');
for (const [key, expected] of Object.entries(oracle.merge_wrapped_rows)) {
  let input;
  if (key === 'simple') input = 'PURCHASE ORDER\n637JO 80X BEIGE 100\nTOTAL 100';
  else if (key === 'packed') input = '1-1 AW11078 BLACK 100\n1-2 AW11079 WHITE 200';
  else if (key === 'wrapped') input = '1-1 AW11078\nBLACK T-SHIRT\n100 200';
  else if (key === 'empty') input = '';
  else continue;
  const result = B.merge_wrapped_rows(input);
  ok(deepEqual(result, expected), `merge_wrapped_rows('${key}') = ${JSON.stringify(result)}`);
}

// ── _color_desc_from (line_items) ──────────────────────────
console.log('\n=== _color_desc_from ===');
for (const [input, expected] of Object.entries(oracle._color_desc_from)) {
  const result = LI._color_desc_from(input);
  ok(result === expected, `_color_desc_from('${input}') = '${result}' (expect '${expected}')`);
}

// ── _recover_style_from_line ───────────────────────────────
console.log('\n=== _recover_style_from_line ===');
for (const [key, expected] of Object.entries(oracle._recover_style_from_line)) {
  const [style, line] = key.split('|');
  const result = LI._recover_style_from_line(style, line);
  ok(result === expected, `_recover_style_from_line('${style}', '${line.slice(0, 30)}...') = '${result}' (expect '${expected}')`);
}

// ── _parse_size_breakdown ──────────────────────────────────
console.log('\n=== _parse_size_breakdown ===');
for (const [key, expected] of Object.entries(oracle._parse_size_breakdown)) {
  const [line, qtyStr] = key.split('|');
  const qty = parseInt(qtyStr, 10);
  const result = LI._parse_size_breakdown(line, qty);
  const resultArr = result.map(sq => [sq.size, sq.qty]);
  ok(deepEqual(resultArr, expected), `_parse_size_breakdown('${line}', ${qty}) = ${JSON.stringify(resultArr)}`);
}

// ── _norm_ship ─────────────────────────────────────────────
console.log('\n=== _norm_ship ===');
for (const [input, expected] of Object.entries(oracle._norm_ship)) {
  const result = B._norm_ship(input);
  ok(result === expected, `_norm_ship('${input}') = '${result}' (expect '${expected}')`);
}

// ── LineItemsParser ────────────────────────────────────────
console.log('\n=== LineItemsParser ===');
{
  const parser = new LI.LineItemsParser();
  ok(parser.layout_type === oracle.LineItemsParser.layout_type, `LineItemsParser.layout_type = '${parser.layout_type}' (expect '${oracle.LineItemsParser.layout_type}')`);
}

// ── 总结 ──────────────────────────────────────────────────
console.log(`\n${'='.repeat(50)}`);
if (fail === 0) {
  console.log('ALL TESTS PASSED');
} else {
  console.log(`${fail} TEST(S) FAILED`);
  process.exit(1);
}

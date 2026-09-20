#!/usr/bin/env node
/**
 * test_cache.js — 校验 ref/core/cache.js 与原版 cache.pyc oracle 输出一致。
 * 前置：先跑 ./py311/python.exe oracle_cache.py > oracle_cache.json
 */
const fs = require('fs');
const path = require('path');
const cache = require('../core/cache');

const oracle = JSON.parse(fs.readFileSync(path.join(__dirname, 'oracle_cache.json'), 'utf8'));
const samples = JSON.parse(fs.readFileSync(path.join(__dirname, 'oracle_samples.json'), 'utf8'));

let fail = 0;
for (const [name, text] of Object.entries(samples)) {
  const o = oracle.samples[name];
  const mySkeleton = cache.skeleton(text);
  const myFp = cache.layoutFingerprint(text);
  const skOk = mySkeleton === o.skeleton;
  const fpOk = myFp === o.fp;
  if (!skOk || !fpOk) fail++;
  console.log(
    `${name}: skeleton ${skOk ? 'OK' : `MISMATCH\n  oracle: ${JSON.stringify(o.skeleton)}\n  mine:   ${JSON.stringify(mySkeleton)}`} | ` +
    `fp ${fpOk ? 'OK' : `MISMATCH oracle=${o.fp} mine=${myFp}`}`
  );
}

// 额外自检：同布局不同数据必须同指纹
const a = cache.layoutFingerprint(samples.lpp_line_items);
const b = cache.layoutFingerprint(samples.lpp_variant_numbers);
console.log(`collision check (lpp variants): ${a === b ? 'OK' : 'FAIL'}`);
if (a !== b) fail++;

console.log(fail === 0 ? '\nALL PASS' : `\n${fail} FAILURES`);
process.exit(fail === 0 ? 0 : 1);

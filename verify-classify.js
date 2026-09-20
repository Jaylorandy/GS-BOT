#!/usr/bin/env node
const path = require('path');

const SUFFIX_MAP = {
  '_e1': 'F',   '-e1': 'F',
  '_e2': 'B',   '-e2': 'B',
  '_e3': 'D1',  '-e3': 'D1',
  '_e4': 'D2',  '-e4': 'D2',
  '_2-1-p': 'F',
  '_2-2-p': 'B',
  '_2-3-p': 'D1',
  '_2-4-p': 'D2',
  '_2-5-p': 'D3',
  '_2-6-p': 'D4',
  '_1-1-p': 'F',
  '_1-2-p': 'B',
  '_1-3-p': 'D1',
  '_1-4-p': 'D2',
  '_2-0-p': '01', '_1-0-p': '01', '-p': '01',
  '_a1': '02',  '-a1': '02',
  '_a2': '03',  '-a2': '03',
  '_a3': '04',  '-a3': '04',
  '_a4': '05',  '-a4': '05',
  '_a5': '06',  '-a5': '06',
  '_a6': '07',  '-a6': '07',
  '_a7': '08',  '-a7': '08',
  '_a8': '09',  '-a8': '09',
};

function classifyImage(url, fullId) {
  const basename = path.basename(url).toLowerCase();
  const sortedEntries = Object.entries(SUFFIX_MAP).sort((a, b) => b[0].length - a[0].length);
  for (const [suffix, label] of sortedEntries) {
    if (basename.includes(`${fullId.toLowerCase()}${suffix}`)) return label;
  }
  return null;
}

const fullId = '01934470';
const testUrls = [
  'https://static.zara.net/photos///2025/V/01934470/2/01934470_2-1-p.jpg',
  'https://static.zara.net/photos///2025/V/01934470/2/01934470_2-2-p.jpg',
  'https://static.zara.net/photos///2025/V/01934470/2/01934470_2-3-p.jpg',
  'https://static.zara.net/photos///2025/V/01934470/2/01934470_2-4-p.jpg',
  'https://static.zara.net/photos///2025/V/01934470/2/01934470_e1.jpg',
  'https://static.zara.net/photos///2025/V/01934470/2/01934470_e2.jpg',
  'https://static.zara.net/photos///2025/V/01934470/2/01934470-e1.jpg',
  'https://static.zara.net/photos///2025/V/01934470/2/01934470-e2.jpg',
  'https://static.zara.net/photos///2025/V/01934470/2/01934470_a1.jpg',
  'https://static.zara.net/photos///2025/V/01934470/2/01934470_a2.jpg',
  'https://static.zara.net/photos///2025/V/01934470/2/01934470_2-0-p.jpg',
  'https://static.zara.net/photos///2025/V/01934470/2/01934470_2-5-p.jpg',
];

console.log('🧪 验证修复后的 classifyImage\n');
let pass = 0, fail = 0;

testUrls.forEach(url => {
  const basename = path.basename(url);
  const label = classifyImage(url, fullId);
  const status = label ? '✅' : '❌';
  if (label) pass++; else fail++;
  console.log(`${status} ${basename.padEnd(30)} → ${label || 'X?? (未匹配)'}`);
});

console.log(`\n结果: ${pass}/${pass+fail} 匹配成功`);
if (fail === 0) console.log('🎉 全部通过！');
else console.log(`⚠️ ${fail} 个未匹配`);

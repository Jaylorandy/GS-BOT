#!/usr/bin/env node
const path = require('path');

const SUFFIX_MAP = {
  '_e1': 'F',   '-e1': 'F',
  '_e2': 'B',   '-e2': 'B',
  '_e3': 'D1',  '-e3': 'D1',
  '_e4': 'D2',  '-e4': 'D2',
  '_2-1-p': 'F', '_2-2-p': 'B', '_2-3-p': 'D1', '_2-4-p': 'D2',
  '_2-5-p': 'D3', '_2-6-p': 'D4',
  '_1-1-p': 'F', '_1-2-p': 'B', '_1-3-p': 'D1', '_1-4-p': 'D2',
  '_2-0-p': '01', '_1-0-p': '01', '-p': '01',
  '_a1': '02',  '-a1': '02',
  '_a2': '03',  '-a2': '03',
  '_a3': '04',  '-a3': '04',
};

function classifyImage(url, styleNum) {
  const cleanNum = styleNum.replace(/[^0-9]/g, '');
  const basename = path.basename(url).toLowerCase();
  const possibleIds = new Set();
  possibleIds.add(cleanNum);
  possibleIds.add(cleanNum.padStart(11, '0'));
  possibleIds.add(cleanNum.padStart(10, '0'));
  if (cleanNum.length >= 9) {
    possibleIds.add(cleanNum.substring(0, 7).padStart(8, '0'));
  }
  if (cleanNum.length >= 8) {
    possibleIds.add(cleanNum.substring(0, 8));
  }
  const sortedEntries = Object.entries(SUFFIX_MAP).sort((a, b) => b[0].length - a[0].length);
  for (const id of possibleIds) {
    for (const [suffix, label] of sortedEntries) {
      if (basename.includes(`${id.toLowerCase()}${suffix}`)) return label;
    }
  }
  return null;
}

console.log('🧪 验证修复 - 使用实际失败的URL\n');

// 从 2127887046_info.json 里提取的实际URL
const realUrls = {
  '2127887046': [
    ['https://static.zara.net/assets/public/5ad5/8485/.../02127887046-e1/02127887046-e1.jpg', 'F'],
    ['https://static.zara.net/assets/public/8268/89c8/.../02127887046-e2/02127887046-e2.jpg', 'B'],
    ['https://static.zara.net/assets/public/31ab/aa48/.../02127887046-e3/02127887046-e3.jpg', 'D1'],
    ['https://static.zara.net/assets/public/5665/bf80/.../02127887046-p/02127887046-p.jpg', '01'],
    ['https://static.zara.net/assets/public/9df6/0fb9/.../02127887046-a1/02127887046-a1.jpg', '02'],
    ['https://static.zara.net/assets/public/de85/e084/.../02127887046-a2/02127887046-a2.jpg', '03'],
    ['https://static.zara.net/assets/public/d255/8c2c/.../02127887046-a3/02127887046-a3.jpg', '04'],
  ],
  '1934470807': [
    ['https://static.zara.net/photos///2025/V/01934470/2/01934470_2-1-p.jpg', 'F'],
    ['https://static.zara.net/photos///2025/V/01934470/2/01934470_2-2-p.jpg', 'B'],
    ['https://static.zara.net/photos///2025/V/01934470/2/01934470_e1.jpg', 'F'],
    ['https://static.zara.net/photos///2025/V/01934470/2/01934470_e2.jpg', 'B'],
  ],
};

let pass = 0, fail = 0;

for (const [styleNum, urls] of Object.entries(realUrls)) {
  console.log(`\n款号: ${styleNum}`);
  console.log('-'.repeat(60));
  
  for (const [url, expected] of urls) {
    const basename = path.basename(url);
    const result = classifyImage(url, styleNum);
    const ok = result === expected;
    if (ok) pass++; else fail++;
    console.log(`${ok ? '✅' : '❌'} ${basename.padEnd(30)} → ${(result || 'null').padEnd(5)} (期望: ${expected})`);
  }
}

console.log(`\n${'='.repeat(60)}`);
console.log(`结果: ${pass}/${pass+fail} 匹配成功`);
if (fail === 0) console.log('🎉 全部通过！');
else console.log(`❌ ${fail} 个失败`);

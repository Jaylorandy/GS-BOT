#!/usr/bin/env node

/**
 * 分析款号4661064733的ID计算
 */

const styleNum = '4661064733';

console.log('🔍 款号ID计算分析\n');
console.log('=' .repeat(70));
console.log(`原始款号: ${styleNum}`);
console.log(`款号长度: ${styleNum.length} 位`);
console.log('=' .repeat(70));

const cleanNum = styleNum.replace(/[^0-9]/g, '');
console.log(`\n清理后数字: ${cleanNum}`);
console.log(`数字长度: ${cleanNum.length} 位`);

// 当前逻辑
let fullId;
if (cleanNum.length >= 9) {
  fullId = cleanNum.substring(0, 7).padStart(8, '0');
} else if (cleanNum.length === 7) {
  fullId = cleanNum.padStart(8, '0');
} else if (cleanNum.length === 8) {
  fullId = cleanNum;
} else {
  fullId = cleanNum.padStart(8, '0');
}

console.log(`\n当前计算的ID: ${fullId}`);
console.log(`ID长度: ${fullId.length} 位`);

// 可能的其他ID格式
console.log('\n\n可能的ID格式:');
console.log('-'.repeat(70));

const alternatives = [
  { name: '前8位', value: cleanNum.substring(0, 8) },
  { name: '前7位补0', value: cleanNum.substring(0, 7).padStart(8, '0') },
  { name: '后8位', value: cleanNum.substring(cleanNum.length - 8) },
  { name: '中间8位', value: cleanNum.substring(1, 9) },
  { name: '完整10位', value: cleanNum },
  { name: '前6位', value: cleanNum.substring(0, 6) },
  { name: '前5位', value: cleanNum.substring(0, 5) },
];

alternatives.forEach((alt, i) => {
  console.log(`${i + 1}. ${alt.name.padEnd(15)}: ${alt.value}`);
});

// 生成测试URL
console.log('\n\n测试URL:');
console.log('-'.repeat(70));

const testIds = [
  cleanNum.substring(0, 8),  // 前8位
  cleanNum.substring(0, 7).padStart(8, '0'),  // 前7位补0
];

testIds.forEach((id, i) => {
  const url = `https://www.zara.com/us/en/-p${id}.html`;
  console.log(`${i + 1}. ${url}`);
});

console.log('\n\n可能的图片URL模式:');
console.log('-'.repeat(70));

const seasons = ['2026/I', '2025/V', '2025/I'];
const suffixes = ['2-1-p', '2-2-p', 'e1', 'e2'];

testIds.forEach(id => {
  console.log(`\nID: ${id}`);
  seasons.slice(0, 2).forEach(season => {
    suffixes.slice(0, 2).forEach(suffix => {
      const imgUrl = `https://static.zara.net/photos///${season}/${id}/2/${id}_${suffix}.jpg`;
      console.log(`  ${imgUrl}`);
    });
  });
});

console.log('\n');

#!/usr/bin/env node

/**
 * 测试10位款号的ID计算修复
 */

console.log('🧪 测试10位款号ID计算修复\n');
console.log('='.repeat(70));

// 测试用例
const testCases = [
  { styleNum: '4661064733', expected: '46610647', desc: '10位款号' },
  { styleNum: '1934/470/807', expected: '01934470', desc: '9位款号（带斜杠）' },
  { styleNum: '1934470807', expected: '01934470', desc: '9位款号（纯数字）' },
  { styleNum: '0155/325/518', expected: '00155325', desc: '9位款号（前导0）' },
  { styleNum: '12345678', expected: '12345678', desc: '8位款号' },
  { styleNum: '1234567', expected: '01234567', desc: '7位款号' },
];

// ID计算函数（修复后）
function calculateId(styleNum) {
  const cleanNum = styleNum.replace(/[^0-9]/g, '');
  
  let fullId;
  if (cleanNum.length === 10) {
    fullId = cleanNum.substring(0, 8);
  } else if (cleanNum.length === 9) {
    fullId = cleanNum.substring(0, 7).padStart(8, '0');
  } else if (cleanNum.length === 8) {
    fullId = cleanNum;
  } else if (cleanNum.length === 7) {
    fullId = cleanNum.padStart(8, '0');
  } else {
    fullId = cleanNum.padStart(8, '0');
  }
  
  return fullId;
}

// 运行测试
let passed = 0;
let failed = 0;

console.log('\n测试结果:');
console.log('-'.repeat(70));

testCases.forEach((test, i) => {
  const result = calculateId(test.styleNum);
  const status = result === test.expected ? '✅ PASS' : '❌ FAIL';
  
  console.log(`\n${i + 1}. ${test.desc}`);
  console.log(`   输入: ${test.styleNum}`);
  console.log(`   期望: ${test.expected}`);
  console.log(`   实际: ${result}`);
  console.log(`   ${status}`);
  
  if (result === test.expected) {
    passed++;
  } else {
    failed++;
  }
});

console.log('\n' + '='.repeat(70));
console.log('测试总结:');
console.log(`  总计: ${testCases.length} 个测试`);
console.log(`  通过: ${passed} 个 ✅`);
console.log(`  失败: ${failed} 个 ❌`);
console.log(`  成功率: ${(passed / testCases.length * 100).toFixed(1)}%`);

if (failed === 0) {
  console.log('\n🎉 所有测试通过！');
} else {
  console.log('\n⚠️ 部分测试失败，需要检查');
}

// 生成测试URL
console.log('\n\n' + '='.repeat(70));
console.log('生成的URL示例:');
console.log('-'.repeat(70));

testCases.forEach(test => {
  const id = calculateId(test.styleNum);
  const url = `https://www.zara.com/us/en/-p${id}.html`;
  console.log(`\n${test.desc}: ${test.styleNum}`);
  console.log(`  → ${url}`);
});

// 生成图片URL示例
console.log('\n\n' + '='.repeat(70));
console.log('图片URL示例 (款号: 4661064733):');
console.log('-'.repeat(70));

const testId = calculateId('4661064733');
const seasons = ['2026/I', '2025/V'];
const suffixes = ['2-1-p', '2-2-p', 'e1', 'e2'];

seasons.forEach(season => {
  console.log(`\n${season}:`);
  suffixes.forEach(suffix => {
    const imgUrl = `https://static.zara.net/photos///${season}/${testId}/2/${testId}_${suffix}.jpg`;
    console.log(`  ${imgUrl}`);
  });
});

console.log('\n');

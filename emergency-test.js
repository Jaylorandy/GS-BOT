#!/usr/bin/env node

/**
 * 紧急测试 - 检查ID计算是否正确
 */

// 测试常见款号
const testCases = [
  { input: '1934/470/807', expected: '01934470', desc: '9位标准款号（带斜杠）' },
  { input: '1934470807', expected: '01934470', desc: '10位纯数字（标准格式去斜杠）' },
  { input: '4661064733', expected: '46610647', desc: '10位纯数字（非标准格式）' },
  { input: '4661/064/733', expected: '04661064', desc: '10位带斜杠（标准格式）' },
];

console.log('🔍 紧急测试 - ID计算验证\n');
console.log('='.repeat(70));

// 修复后的计算逻辑
function calculateId(styleNum) {
  const cleanNum = styleNum.replace(/[^0-9]/g, '');
  const hasSlash = styleNum.includes('/');
  
  let fullId;
  if (hasSlash && cleanNum.length === 10) {
    // 标准格式 XXXX/XXX/XXX: 取前7位，补0到8位
    fullId = cleanNum.substring(0, 7).padStart(8, '0');
  } else if (cleanNum.length === 10 && !hasSlash) {
    // 10位纯数字（非标准格式）: 取前8位
    fullId = cleanNum.substring(0, 8);
  } else if (cleanNum.length === 9) {
    // 9位数字: 取前7位，补0到8位
    fullId = cleanNum.substring(0, 7).padStart(8, '0');
  } else if (cleanNum.length === 8) {
    // 8位数字: 直接使用
    fullId = cleanNum;
  } else if (cleanNum.length === 7) {
    // 7位数字: 补0到8位
    fullId = cleanNum.padStart(8, '0');
  } else if (cleanNum.length > 10) {
    // 超过10位: 取前7位，补0到8位
    fullId = cleanNum.substring(0, 7).padStart(8, '0');
  } else {
    // 其他情况: 补0到8位
    fullId = cleanNum.padStart(8, '0');
  }
  
  return { cleanNum, fullId, hasSlash };
}

let passed = 0;
let failed = 0;

testCases.forEach(test => {
  const result = calculateId(test.input);
  const status = result.fullId === test.expected ? '✅ PASS' : '❌ FAIL';
  
  if (result.fullId === test.expected) {
    passed++;
  } else {
    failed++;
  }
  
  console.log(`\n${test.desc}:`);
  console.log(`  输入: ${test.input}`);
  console.log(`  清理后: ${result.cleanNum} (${result.cleanNum.length}位, 斜杠:${result.hasSlash})`);
  console.log(`  期望ID: ${test.expected}`);
  console.log(`  实际ID: ${result.fullId}`);
  console.log(`  ${status}`);
  console.log(`  URL: https://www.zara.com/us/en/-p${result.fullId}.html`);
});

console.log('\n' + '='.repeat(70));
console.log(`测试结果: ${passed}/${testCases.length} 通过`);

if (failed === 0) {
  console.log('🎉 所有测试通过！');
} else {
  console.log(`⚠️ ${failed} 个测试失败！`);
}
console.log('\n');

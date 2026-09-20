#!/usr/bin/env node

/**
 * 最简单的测试 - 确认基本逻辑
 */

console.log('🔍 基础测试\n');

// 最原始的Zara ID计算逻辑（v1.0.7之前的版本）
function originalLogic(styleNum) {
  const cleanNum = styleNum.replace(/[^0-9]/g, '');
  let pid;
  
  if (cleanNum.length >= 9) {
    // 取前7位，补0到8位
    pid = cleanNum.substring(0, 7).padStart(8, '0');
  } else if (cleanNum.length === 8) {
    pid = cleanNum;
  } else if (cleanNum.length === 7) {
    pid = cleanNum.padStart(8, '0');
  } else {
    pid = cleanNum.padStart(8, '0');
  }
  
  return pid;
}

// 测试用例
const tests = [
  '1934/470/807',
  '0155/325/518',
  '4661064733',
  '4661/064/733',
];

console.log('原始逻辑测试:\n');
tests.forEach(test => {
  const id = originalLogic(test);
  console.log(`${test.padEnd(20)} → ${id}`);
});

console.log('\n已知正确的映射:');
console.log('1934/470/807         → 01934470');
console.log('0155/325/518         → 00155325');
console.log('\n');

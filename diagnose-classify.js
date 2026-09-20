#!/usr/bin/env node
/**
 * 诊断：打印实际捕获的图片URL，分析为什么classifyImage匹配失败
 */

const SUFFIX_MAP = { '-e1': 'F', '-e2': 'B', '-e3': 'D1', '-e4': 'D2', '-p': '01', '-a1': '02', '-a2': '03', '-a3': '04', '-a4': '05', '-a5': '06', '-a6': '07', '-a7': '08', '-a8': '09' };

// 模拟一些Zara常见的URL格式
const testUrls = [
  // 格式1: 下划线+后缀
  'https://static.zara.net/photos///2025/V/01934470/2/01934470_2-1-p.jpg',
  'https://static.zara.net/photos///2025/V/01934470/2/01934470_2-2-p.jpg',
  'https://static.zara.net/photos///2025/V/01934470/2/01934470_2-3-p.jpg',
  'https://static.zara.net/photos///2025/V/01934470/2/01934470_2-4-p.jpg',
  // 格式2: 下划线+e系列
  'https://static.zara.net/photos///2025/V/01934470/2/01934470_e1.jpg',
  'https://static.zara.net/photos///2025/V/01934470/2/01934470_e2.jpg',
  // 格式3: 连字符+e系列（SUFFIX_MAP期望的格式）
  'https://static.zara.net/photos///2025/V/01934470/2/01934470-e1.jpg',
  'https://static.zara.net/photos///2025/V/01934470/2/01934470-e2.jpg',
  // 格式4: 下划线+a系列
  'https://static.zara.net/photos///2025/V/01934470/2/01934470_a1.jpg',
  'https://static.zara.net/photos///2025/V/01934470/2/01934470_a2.jpg',
];

const path = require('path');
const fullId = '01934470';

console.log('🔍 诊断 classifyImage 匹配问题\n');
console.log('='.repeat(80));
console.log(`\nSUFFIX_MAP 定义的后缀:`);
for (const [suffix, label] of Object.entries(SUFFIX_MAP)) {
  console.log(`  "${suffix}" → "${label}"  (匹配: ${fullId}${suffix})`);
}

console.log(`\n${'='.repeat(80)}`);
console.log('\n测试URL匹配结果:\n');

testUrls.forEach(url => {
  const basename = path.basename(url).toLowerCase();
  let matched = false;
  
  for (const [suffix, label] of Object.entries(SUFFIX_MAP)) {
    const pattern = `${fullId.toLowerCase()}${suffix}`;
    if (basename.includes(pattern)) {
      console.log(`✅ ${basename}`);
      console.log(`   匹配: "${pattern}" → 标签: "${label}"`);
      matched = true;
      break;
    }
  }
  
  if (!matched) {
    console.log(`❌ ${basename}`);
    console.log(`   未匹配任何后缀 → 将被命名为 X01, X02...`);
    
    // 分析为什么没匹配
    console.log(`   分析: 文件名中的后缀部分是: "${basename.replace(fullId, '').replace('.jpg', '')}"`);
  }
  console.log('');
});

console.log('='.repeat(80));
console.log('\n💡 结论:');
console.log('SUFFIX_MAP 使用连字符(-)作为分隔符: 01934470-e1');
console.log('但实际Zara URL使用下划线(_)作为分隔符: 01934470_e1');
console.log('或者使用: 01934470_2-1-p 这种格式');
console.log('\n需要同时支持两种分隔符，并添加 _2-1-p 等格式的映射');

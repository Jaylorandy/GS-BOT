/**
 * Excel标注功能测试脚本
 * 测试annotate_excel.js模块的基本功能
 */

const { annotateExcel } = require('./annotate_excel.js');
const path = require('path');

// 测试配置
const testExcelPath = '/Users/jaylorandy/Desktop/zara copy 3.xlsx';
const outputDir = '/Users/jaylorandy/Desktop/zara';

// 日志回调
const logCallback = (message) => {
  console.log(message);
};

async function runTest() {
  console.log('='.repeat(60));
  console.log('Excel标注功能测试');
  console.log('='.repeat(60));
  console.log();

  try {
    console.log(`📂 测试文件: ${testExcelPath}`);
    console.log(`📁 输出目录: ${outputDir}`);
    console.log();

    const result = await annotateExcel(testExcelPath, outputDir, logCallback);

    console.log();
    console.log('='.repeat(60));
    console.log('✅ 测试完成!');
    console.log(`📁 结果文件: ${result}`);
    console.log('='.repeat(60));

  } catch (error) {
    console.error();
    console.error('❌ 测试失败:');
    console.error(error);
    console.error();
  }
}

// 运行测试
runTest();

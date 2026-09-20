#!/bin/bash

echo "🚀 开始打包 Windows 版本..."

# 清理之前的构建
echo "🧹 清理旧的构建文件..."
rm -rf dist release/*.exe release/*.nsis release/win-* release/*.blockmap

# 安装依赖（如果需要）
echo "📦 检查依赖..."
if [ ! -d "node_modules" ]; then
  echo "安装 npm 依赖..."
  npm install
fi

# 构建 React 前端
echo "🔨 构建 React 前端..."
npm run build

# 使用 electron-builder 打包 Windows 版本
echo "💿 正在构建 Windows 安装程序..."
npm run dist:win

# 检查构建结果
if [ -d "release/win-unpacked" ] || ls release/*.exe >/dev/null 2>&1; then
  echo ""
  echo "✅ Windows 版本打包成功！"
  echo ""
  echo "📦 构建产物："
  ls -lh release/*.exe 2>/dev/null || echo "  (未找到 .exe 文件，检查 release/win-unpacked/ 目录)"
  echo ""
  echo "📁 输出目录: $(pwd)/release"
else
  echo "❌ Windows 版本打包失败，请检查日志"
  exit 1
fi

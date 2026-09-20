#!/bin/bash

echo "🚀 开始打包 Zara Scraper Pro 应用..."

echo "📦 步骤 1: 构建 Vite 项目..."
npm run build

if [ $? -ne 0 ]; then
    echo "❌ Vite 构建失败！"
    exit 1
fi

echo "✅ Vite 构建成功！"

echo "📦 步骤 2: 使用 Electron Builder 打包应用..."
npm run dist

if [ $? -eq 0 ]; then
    echo "🎉 打包成功！"
    echo "📁 安装包位置: ./release/"
    echo "📱 Mac DMG 文件: ./release/Zara Scraper Pro-1.0.0.dmg"
else
    echo "❌ 打包失败！"
    exit 1
fi

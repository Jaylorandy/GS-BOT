#!/bin/bash

echo "======================================"
echo "🚀 开始打包 Zara Scraper Pro"
echo "======================================"
echo ""

# 检查是否在正确的目录
if [ ! -f "package.json" ]; then
    echo "❌ 错误：请在 zara-app 根目录下运行此脚本"
    exit 1
fi

echo "📦 步骤 1: 清理旧的构建文件..."
rm -rf dist release node_modules/.vite

echo "✅ 清理完成"
echo ""

echo "📦 步骤 2: 构建 Vite 前端..."
npm run build

if [ $? -ne 0 ]; then
    echo "❌ Vite 构建失败！"
    exit 1
fi

echo "✅ Vite 构建成功！"
echo ""

echo "📦 步骤 3: 开始 Electron 打包..."
echo "⏱️  这可能需要 3-8 分钟，请耐心等待..."
echo ""

# 使用 electron-builder 打包
npx electron-builder --mac --publish=never

if [ $? -eq 0 ]; then
    echo ""
    echo "======================================"
    echo "🎉 打包成功！"
    echo "======================================"
    echo ""
    echo "📁 安装包位置: ./release/"
    echo ""
    # 查找生成的 .dmg 文件
    DMG_FILE=$(find release -name "*.dmg" | head -n 1)
    if [ -n "$DMG_FILE" ]; then
        echo "📱 Mac DMG 文件: $DMG_FILE"
        echo ""
        echo "📦 文件大小: $(du -h "$DMG_FILE" | cut -f1)"
        echo ""
        echo "💡 双击 .dmg 文件即可安装应用！"
    else
        echo "⚠️  未找到 .dmg 文件，请检查 release 文件夹"
    fi
else
    echo ""
    echo "======================================"
    echo "❌ 打包失败"
    echo "======================================"
    echo ""
    echo "💡 请检查以下内容："
    echo "  1. 确保有足够的磁盘空间（至少 1GB）"
    echo "  2. 确保网络连接正常"
    echo "  3. 检查是否有权限问题"
    echo ""
    echo "📝 查看完整日志: release/builder-effective-config.yaml"
    exit 1
fi

echo ""
echo "======================================"
echo "✨ 完成！"
echo "======================================"

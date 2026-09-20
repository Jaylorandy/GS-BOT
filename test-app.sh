#!/bin/bash

echo "======================================"
echo "🧪 测试 Zara Scraper Pro 应用"
echo "======================================"
echo ""

APP_PATH="/Users/jaylorandy/zara-app/release/mac-arm64/Zara Scraper Pro.app"

echo "📁 应用路径: $APP_PATH"
echo ""

# 检查应用是否存在
if [ ! -d "$APP_PATH" ]; then
    echo "❌ 应用不存在！"
    exit 1
fi

echo "✅ 应用文件存在"
echo ""

# 检查应用结构
echo "🔍 检查应用结构..."
echo ""

echo "📦 Contents 目录:"
ls -la "$APP_PATH/Contents/"
echo ""

echo "📦 Resources 目录:"
ls -la "$APP_PATH/Contents/Resources/" | head -20
echo ""

echo "📦 检查 main.js 是否在 app.asar 中..."
if [ -f "$APP_PATH/Contents/Resources/app.asar" ]; then
    echo "✅ app.asar 存在"
    echo ""
    echo "📄 app.asar 内容列表（前 20 行）:"
    npx asar list "$APP_PATH/Contents/Resources/app.asar" | head -20
else
    echo "❌ app.asar 不存在"
fi

echo ""
echo "======================================"
echo "🚀 准备启动应用进行测试"
echo "======================================"
echo ""
echo "💡 应用即将启动，请检查："
echo "   1. 界面是否正常显示"
echo "   2. 点击按钮是否有响应"
echo "   3. 控制台是否有错误信息"
echo ""
echo "按 Enter 键继续启动应用..."
read

echo ""
echo "🚀 正在启动应用..."
open "$APP_PATH"

echo ""
echo "✨ 应用已启动！"
echo ""
echo "💡 提示：如果遇到问题，请查看以下信息："
echo "   - 打开 Console.app 查看应用日志"
echo "   - 检查是否有 Chrome 浏览器已安装"
echo "   - 确认网络连接正常"

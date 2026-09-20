#!/bin/bash

echo "🧪 Zara Tools Pro v2.0.0 - 最终验证"
echo "======================================"
echo ""

# 检查应用
APP_PATH="/Users/jaylorandy/zara-app/release/mac-arm64/Zara Scraper Pro.app"

if [ -d "$APP_PATH" ]; then
    echo "✅ 应用程序存在"
    
    # 检查Python脚本
    PYTHON_SCRIPT="$APP_PATH/Contents/Resources/app.asar.unpacked/generate_slides.py"
    if [ -f "$PYTHON_SCRIPT" ]; then
        echo "✅ Python脚本已正确解包"
        ls -lh "$PYTHON_SCRIPT"
    else
        echo "❌ Python脚本未找到"
    fi
    
    echo ""
    echo "📋 应用信息:"
    echo "  路径: $APP_PATH"
    echo "  大小: $(du -sh "$APP_PATH" | cut -f1)"
    
    echo ""
    echo "🚀 启动应用进行测试..."
    open "$APP_PATH"
    
    echo ""
    echo "⏱️ 等待5秒检查是否有错误..."
    sleep 5
    
    # 检查是否有崩溃报告
    CRASH_LOG=$(ls -t ~/Library/Logs/DiagnosticReports/Zara* 2>/dev/null | head -1)
    if [ -n "$CRASH_LOG" ]; then
        echo "⚠️ 发现崩溃日志: $CRASH_LOG"
        echo "最后几行:"
        tail -20 "$CRASH_LOG"
    else
        echo "✅ 未发现崩溃日志"
    fi
    
    echo ""
    echo "======================================"
    echo "✅ 验证完成！"
    echo ""
    echo "请检查应用是否正常启动："
    echo "1. 是否显示双功能导航界面？"
    echo "2. 能否切换 Zara Scraper 和 Slides Maker？"
    echo "3. 是否有任何错误提示？"
    echo ""
    
else
    echo "❌ 应用程序未找到"
    exit 1
fi

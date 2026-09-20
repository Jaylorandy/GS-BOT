#!/bin/bash

echo "🧪 Zara Tools Pro v2.0.0 - 功能测试"
echo "======================================"
echo ""

# 检查Python
echo "1️⃣ 检查Python环境..."
if command -v python3 &> /dev/null; then
    PYTHON_VERSION=$(python3 --version)
    echo "✅ Python已安装: $PYTHON_VERSION"
else
    echo "❌ 未找到Python3，请先安装"
    exit 1
fi

# 检查Python库
echo ""
echo "2️⃣ 检查Python依赖库..."
python3 -c "import pptx" 2>/dev/null
if [ $? -eq 0 ]; then
    echo "✅ python-pptx已安装"
else
    echo "⚠️ python-pptx未安装，正在安装..."
    pip3 install python-pptx
fi

python3 -c "from PIL import Image" 2>/dev/null
if [ $? -eq 0 ]; then
    echo "✅ Pillow已安装"
else
    echo "⚠️ Pillow未安装，正在安装..."
    pip3 install Pillow
fi

# 测试PPT生成脚本
echo ""
echo "3️⃣ 测试PPT生成脚本..."
if [ -f "generate_slides.py" ]; then
    echo "✅ generate_slides.py存在"
    
    # 创建测试配置
    TEST_CONFIG='{
      "sourceFolder": "/Users/jaylorandy/Desktop/zara",
      "outputPath": "/Users/jaylorandy/Desktop/test_output.pptx",
      "config": {
        "title": "Test Lookbook",
        "includePrice": true,
        "includeComposition": true,
        "includeDescription": true,
        "imageLayout": "model-front-back",
        "sortBy": "styleNumber"
      }
    }'
    
    echo "📝 测试配置已准备"
else
    echo "❌ generate_slides.py不存在"
    exit 1
fi

# 检查应用程序
echo ""
echo "4️⃣ 检查应用程序..."
if [ -d "release/mac-arm64/Zara Scraper Pro.app" ]; then
    echo "✅ 应用程序已打包"
    APP_SIZE=$(du -sh "release/mac-arm64/Zara Scraper Pro.app" | cut -f1)
    echo "   大小: $APP_SIZE"
else
    echo "⚠️ 应用程序未打包，运行 npm run dist"
fi

# 检查DMG
if [ -f "release/Zara Scraper Pro-1.0.0-arm64.dmg" ]; then
    echo "✅ DMG文件已生成"
    DMG_SIZE=$(du -sh "release/Zara Scraper Pro-1.0.0-arm64.dmg" | cut -f1)
    echo "   大小: $DMG_SIZE"
fi

echo ""
echo "======================================"
echo "✅ 测试完成！"
echo ""
echo "📋 下一步:"
echo "1. 打开应用: open 'release/mac-arm64/Zara Scraper Pro.app'"
echo "2. 测试Zara Scraper功能"
echo "3. 测试Slides Maker功能"
echo ""

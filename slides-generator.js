/**
 * PPT生成模块
 * 基于Python脚本create_zara_lookbook_v2.py的逻辑
 * 使用Node.js的pptxgenjs库实现
 */

const PptxGenJS = require('pptxgenjs');
const fs = require('fs');
const path = require('path');

/**
 * 分析文件夹内容
 */
function analyzeFolderContent(folderPath) {
  const styles = [];
  let totalImages = 0;

  try {
    const items = fs.readdirSync(folderPath);
    
    for (const item of items) {
      const itemPath = path.join(folderPath, item);
      const stat = fs.statSync(itemPath);
      
      if (stat.isDirectory() && !item.startsWith('.')) {
        // 检查是否有info.json
        const infoPath = path.join(itemPath, `${item}_info.json`);
        const images = fs.readdirSync(itemPath).filter(f => 
          /\.(jpg|jpeg|png|webp)$/i.test(f)
        );
        
        totalImages += images.length;
        
        styles.push({
          styleNumber: item,
          folder: itemPath,
          hasInfo: fs.existsSync(infoPath),
          imageCount: images.length
        });
      }
    }
    
    return {
      success: true,
      styleCount: styles.length,
      totalImages,
      styles
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * 加载款式信息
 */
function loadStyleInfo(styleFolder, styleNumber) {
  const infoPath = path.join(styleFolder, `${styleNumber}_info.json`);
  
  const defaultInfo = {
    styleNumber,
    name: 'Unknown Product',
    price: '',
    colorRef: '',
    description: '',
    composition: null
  };
  
  try {
    if (fs.existsSync(infoPath)) {
      const data = JSON.parse(fs.readFileSync(infoPath, 'utf-8'));
      return { ...defaultInfo, ...data };
    }
  } catch (error) {
    console.error(`Error loading info for ${styleNumber}:`, error);
  }
  
  return defaultInfo;
}

/**
 * 查找特定类型的图片
 */
function findImage(styleFolder, styleNumber, types) {
  for (const type of types) {
    const imagePath = path.join(styleFolder, `${styleNumber}_${type}.jpg`);
    if (fs.existsSync(imagePath)) {
      return imagePath;
    }
    // 尝试其他扩展名
    for (const ext of ['jpeg', 'png', 'webp']) {
      const altPath = path.join(styleFolder, `${styleNumber}_${type}.${ext}`);
      if (fs.existsSync(altPath)) {
        return altPath;
      }
    }
  }
  return null;
}

/**
 * 生成PPT
 */
async function generateSlides(params, emitLog, emitProgress) {
  const { sourceFolder, outputPath, templatePath, config } = params;
  
  emitLog('🚀 开始生成PPT...', 'info');
  emitProgress(5);
  
  try {
    // 分析文件夹
    emitLog('📁 分析文件夹内容...', 'info');
    const analysis = analyzeFolderContent(sourceFolder);
    
    if (!analysis.success) {
      throw new Error(analysis.error);
    }
    
    emitLog(`✅ 发现 ${analysis.styleCount} 个款式`, 'success');
    emitProgress(10);
    
    // 创建PPT对象
    const pptx = new PptxGenJS();
    
    // 设置PPT属性
    pptx.layout = 'LAYOUT_16x9';
    pptx.author = 'GS R&D Studio';
    pptx.company = 'Zara Tools Pro';
    pptx.title = config.title || 'Zara Style Lookbook';
    
    // 定义颜色
    const ZARA_DARK = '000000';
    const ZARA_GRAY = '808080';
    const ZARA_WHITE = 'FFFFFF';
    
    // 添加封面页
    emitLog('📄 创建封面页...', 'info');
    const coverSlide = pptx.addSlide();
    coverSlide.background = { color: ZARA_DARK };
    coverSlide.addText(config.title || 'Zara Style Lookbook', {
      x: 0.5,
      y: '40%',
      w: '90%',
      h: 1.5,
      fontSize: 48,
      bold: true,
      color: ZARA_WHITE,
      align: 'center'
    });
    coverSlide.addText(`${analysis.styleCount} Styles Collection`, {
      x: 0.5,
      y: '55%',
      w: '90%',
      h: 0.8,
      fontSize: 24,
      color: ZARA_GRAY,
      align: 'center'
    });
    
    emitProgress(15);
    
    // 排序款式
    let sortedStyles = [...analysis.styles];
    if (config.sortBy === 'name') {
      sortedStyles.sort((a, b) => {
        const infoA = loadStyleInfo(a.folder, a.styleNumber);
        const infoB = loadStyleInfo(b.folder, b.styleNumber);
        return infoA.name.localeCompare(infoB.name);
      });
    } else if (config.sortBy === 'price') {
      sortedStyles.sort((a, b) => {
        const infoA = loadStyleInfo(a.folder, a.styleNumber);
        const infoB = loadStyleInfo(b.folder, b.styleNumber);
        const priceA = parseFloat(infoA.price.replace(/[^0-9.]/g, '')) || 0;
        const priceB = parseFloat(infoB.price.replace(/[^0-9.]/g, '')) || 0;
        return priceB - priceA;
      });
    }
    
    // 为每个款式创建页面
    const totalStyles = sortedStyles.length;
    for (let i = 0; i < totalStyles; i++) {
      const style = sortedStyles[i];
      const progress = 15 + Math.round((i / totalStyles) * 80);
      emitProgress(progress);
      
      emitLog(`📄 创建页面: ${style.styleNumber} (${i + 1}/${totalStyles})`, 'info');
      
      const info = loadStyleInfo(style.folder, style.styleNumber);
      const slide = pptx.addSlide();
      
      // 左侧文本区域
      let textY = 0.5;
      
      // 款号
      slide.addText(info.styleNumber, {
        x: 0.5,
        y: textY,
        w: 3.5,
        fontSize: 16,
        bold: true,
        color: ZARA_GRAY
      });
      textY += 0.4;
      
      // 产品名称
      slide.addText(info.name, {
        x: 0.5,
        y: textY,
        w: 3.5,
        fontSize: 24,
        bold: true,
        color: ZARA_DARK
      });
      textY += 0.8;
      
      // 价格
      if (config.includePrice && info.price) {
        slide.addText(info.price, {
          x: 0.5,
          y: textY,
          w: 3.5,
          fontSize: 20,
          color: ZARA_DARK
        });
        textY += 0.6;
      }
      
      // 颜色参考
      if (config.includeColorRef === true && info.colorRef) {
        slide.addText(info.colorRef, {
          x: 0.5,
          y: textY,
          w: 3.5,
          fontSize: 12,
          color: ZARA_GRAY
        });
        textY += 0.4;
      }
      
      // 面料成分
      if (config.includeComposition && info.composition) {
        let compositionText = '';
        if (typeof info.composition === 'object') {
          if (info.composition.outerShell) {
            compositionText += `Outer Shell: ${info.composition.outerShell}\n`;
          }
          if (info.composition.lining) {
            compositionText += `Lining: ${info.composition.lining}\n`;
          }
          if (info.composition.other && !info.composition.outerShell && !info.composition.lining) {
            compositionText += info.composition.other;
          }
        } else {
          compositionText = info.composition;
        }
        
        if (compositionText) {
          slide.addText(compositionText.trim(), {
            x: 0.5,
            y: textY,
            w: 3.5,
            fontSize: 10,
            color: ZARA_GRAY
          });
          textY += 0.8;
        }
      }
      
      // 商品描述
      if (config.includeDescription && info.description) {
        slide.addText(info.description, {
          x: 0.5,
          y: textY,
          w: 3.5,
          fontSize: 11,
          color: ZARA_GRAY
        });
      }
      
      // 右侧图片区域
      if (config.imageLayout === 'model-front-back') {
        // 模特图 + 正反面布局
        const modelImg = findImage(style.folder, style.styleNumber, ['X01', 'X02', '01', '02']);
        const frontImg = findImage(style.folder, style.styleNumber, ['F', 'e1', '2-1-p']);
        const backImg = findImage(style.folder, style.styleNumber, ['B', 'e2', '2-2-p']);
        
        // 模特图（大图）
        if (modelImg) {
          slide.addImage({
            path: modelImg,
            x: 4.3,
            y: 0.6,
            w: 4.2,
            h: 6.3,
            sizing: { type: 'contain' }
          });
        }
        
        // 正面图（右上）
        if (frontImg) {
          slide.addImage({
            path: frontImg,
            x: 9.6,
            y: 0.3,
            w: 2.3,
            h: 3.4,
            sizing: { type: 'contain' }
          });
        }
        
        // 背面图（右下）
        if (backImg) {
          slide.addImage({
            path: backImg,
            x: 9.6,
            y: 3.8,
            w: 2.3,
            h: 3.4,
            sizing: { type: 'contain' }
          });
        }
      } else if (config.imageLayout === 'grid') {
        // 网格布局 - 显示多张图片
        const images = fs.readdirSync(style.folder)
          .filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f))
          .slice(0, 6)
          .map(f => path.join(style.folder, f));
        
        const cols = 3;
        const rows = 2;
        const imgW = 2.5;
        const imgH = 3.2;
        const startX = 4.5;
        const startY = 0.5;
        const gap = 0.3;
        
        images.forEach((img, idx) => {
          const col = idx % cols;
          const row = Math.floor(idx / cols);
          slide.addImage({
            path: img,
            x: startX + col * (imgW + gap),
            y: startY + row * (imgH + gap),
            w: imgW,
            h: imgH,
            sizing: { type: 'contain' }
          });
        });
      }
    }
    
    // 保存PPT
    emitLog('💾 保存PPT文件...', 'info');
    emitProgress(95);
    
    const finalOutputPath = outputPath || path.join(sourceFolder, 'Zara_Lookbook.pptx');
    await pptx.writeFile({ fileName: finalOutputPath });
    
    emitProgress(100);
    emitLog(`✅ PPT生成成功: ${finalOutputPath}`, 'success');
    
    return {
      success: true,
      outputPath: finalOutputPath,
      styleCount: totalStyles
    };
    
  } catch (error) {
    emitLog(`❌ 生成失败: ${error.message}`, 'error');
    return {
      success: false,
      error: error.message
    };
  }
}

module.exports = {
  analyzeFolderContent,
  generateSlides
};

/**
 * Slides Maker IPC处理器
 * 添加到main.js中
 */

const slidesGenerator = require('./slides-generator');

// 在main.js的createWindow函数后添加以下IPC处理器

// 分析文件夹内容
ipcMain.handle('analyze-folder-content', async (event, folderPath) => {
  return slidesGenerator.analyzeFolderContent(folderPath);
});

// 生成PPT
ipcMain.handle('generate-slides', async (event, params) => {
  const mainWindow = BrowserWindow.getAllWindows()[0];
  
  const emitLog = (message, type = 'info') => {
    mainWindow.webContents.send('slides-log', {
      time: new Date().toLocaleTimeString(),
      message,
      type
    });
  };
  
  const emitProgress = (value) => {
    mainWindow.webContents.send('slides-progress', value);
  };
  
  return await slidesGenerator.generateSlides(params, emitLog, emitProgress);
});

// 选择文件（带过滤器）
ipcMain.handle('select-file-with-filter', async (event, options) => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: options.filters || []
  });
  return result.canceled ? null : result.filePaths[0];
});

// 保存文件对话框
ipcMain.handle('save-file', async (event, options) => {
  const result = await dialog.showSaveDialog({
    defaultPath: options.defaultPath || 'output.pptx',
    filters: options.filters || [{ name: 'PowerPoint', extensions: ['pptx'] }]
  });
  return result.canceled ? null : result.filePath;
});

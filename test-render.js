// 测试：在主进程中打开DevTools查看渲染错误
const { app, BrowserWindow } = require('electron');
const path = require('path');

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    }
  });

  win.loadFile(path.join(__dirname, 'dist', 'index.html'));
  win.webContents.openDevTools();

  // 捕获渲染进程的console输出
  win.webContents.on('console-message', (event, level, message, line, sourceId) => {
    const levels = ['LOG', 'WARN', 'ERROR'];
    console.log(`[RENDERER ${levels[level] || level}] ${message}`);
  });

  // 捕获渲染进程崩溃
  win.webContents.on('render-process-gone', (event, details) => {
    console.log('[CRASH]', details);
  });

  win.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.log('[LOAD FAIL]', errorCode, errorDescription);
  });
});

const { app, dialog, BrowserWindow } = require('electron');
const { autoUpdater } = require('electron-updater');

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 运行中每 4 小时复查一次
const FIRST_CHECK_DELAY_MS = 8000;            // 启动 8 秒后首次检查，不抢占启动 IO

let mainWindowRef = null;

function sendToRenderer(channel, payload) {
  try {
    const win = mainWindowRef || BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  } catch (err) {
    console.warn('[auto-updater] sendToRenderer failed:', err.message);
  }
}

async function promptUpdateAvailable(info) {
  const version = info && info.version ? info.version : '';
  sendToRenderer('update-available', { version });
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: '发现新版本',
    message: `GS Bot 发现新版本 ${version}`,
    detail: '是否立即下载更新？下载完成后你可以选择立即安装，或退出时自动安装。',
    buttons: ['立即下载', '暂不更新'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (response === 0) {
    autoUpdater.downloadUpdate().catch((err) => {
      console.warn('[auto-updater] downloadUpdate failed:', err.message);
      dialog.showMessageBox({
        type: 'warning',
        title: '下载失败',
        message: '更新包下载失败，请稍后重试或到 GitHub Releases 手动下载。',
        detail: String(err && err.message ? err.message : err),
        buttons: ['好的'],
        noLink: true,
      }).catch(() => {});
    });
  }
}

async function promptUpdateDownloaded() {
  sendToRenderer('update-downloaded', {});
  const { response } = await dialog.showMessageBox({
    type: 'info',
    title: '更新已就绪',
    message: '新版本已下载完成',
    detail: '立即重启并安装？选择"稍后"的话，下次退出应用时会自动完成安装。',
    buttons: ['立即重启安装', '稍后'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (response === 0) {
    setImmediate(() => {
      app.quitting = true;
      autoUpdater.quitAndInstall(false, true);
    });
  }
}

function checkNow() {
  if (!app.isPackaged) return Promise.resolve(null);
  return autoUpdater.checkForUpdates().catch((err) => {
    console.warn('[auto-updater] checkForUpdates failed:', err.message);
    return null;
  });
}

function initAutoUpdater(options = {}) {
  if (!app.isPackaged) {
    console.log('[auto-updater] dev mode, skip');
    return;
  }
  if (options.mainWindow !== undefined) {
    mainWindowRef = options.mainWindow;
  }

  autoUpdater.autoDownload = false;       // 由用户在弹窗中确认后再下载
  autoUpdater.autoInstallOnAppQuit = true; // 选"稍后"的用户退出时自动安装
  autoUpdater.logger = console;

  autoUpdater.on('update-available', (info) => { promptUpdateAvailable(info).catch(() => {}); });
  autoUpdater.on('update-not-available', () => { sendToRenderer('update-not-available', {}); });
  autoUpdater.on('download-progress', (p) => {
    sendToRenderer('update-download-progress', {
      percent: p && p.percent ? Math.round(p.percent) : 0,
    });
  });
  autoUpdater.on('update-downloaded', () => { promptUpdateDownloaded().catch(() => {}); });
  autoUpdater.on('error', (err) => {
    console.warn('[auto-updater] error:', err && err.message ? err.message : err);
  });

  setTimeout(() => { checkNow(); }, FIRST_CHECK_DELAY_MS);
  setInterval(() => { checkNow(); }, CHECK_INTERVAL_MS);
}

module.exports = { initAutoUpdater, checkNow };

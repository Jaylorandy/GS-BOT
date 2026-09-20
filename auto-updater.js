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

// 更新状态统一走一个 channel：{ status, version?, percent?, message? }
// status: 'available' | 'downloading' | 'downloaded' | 'latest' | 'error'
// 之前是 4 个独立 channel，前端一个都没监听 —— 下载 480MB 期间界面毫无反馈。
function sendUpdateStatus(payload) {
  sendToRenderer('update-status', payload);
}

// Windows 任务栏进度条：用户在系统层面也能看到下载进度
function setTaskbarProgress(percent) {
  try {
    const win = mainWindowRef || BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      const value = typeof percent === 'number' && percent >= 0 ? Math.min(percent / 100, 1) : -1;
      win.setProgressBar(value);
    }
  } catch (err) {
    console.warn('[auto-updater] setProgressBar failed:', err.message);
  }
}

async function promptUpdateAvailable(info) {
  const version = info && info.version ? info.version : '';
  sendUpdateStatus({ status: 'available', version });
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
    // 立刻进入下载态：让界面在第一个 progress 事件到达前就有反馈
    sendUpdateStatus({ status: 'downloading', version, percent: 0 });
    setTaskbarProgress(0);
    autoUpdater.downloadUpdate().catch((err) => {
      console.warn('[auto-updater] downloadUpdate failed:', err.message);
      setTaskbarProgress(-1);
      sendUpdateStatus({ status: 'error', version, message: String(err && err.message ? err.message : err) });
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

async function promptUpdateDownloaded(info) {
  const version = info && info.version ? info.version : '';
  setTaskbarProgress(-1); // 下载结束，清掉任务栏进度
  sendUpdateStatus({ status: 'downloaded', version });
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

// ── 手动"检查更新"──────────────────────────────────────────────
// The background timer only surfaces a dialog when an update exists, so a user
// who wants to know "am I on the latest build?" had no button to press. This
// path always answers, including "already up to date".
let manualPending = null; // { resolve, timer }

function settleManual(result) {
  if (!manualPending) return;
  clearTimeout(manualPending.timer);
  const { resolve } = manualPending;
  manualPending = null;
  resolve(result);
}

async function manualCheck() {
  const current = app.getVersion();
  if (!app.isPackaged) {
    await dialog.showMessageBox({
      type: 'info',
      title: '检查更新',
      message: '当前是开发版本',
      detail: '自动更新只在安装版中生效，请使用安装包版本。',
      buttons: ['好的'],
      noLink: true,
    });
    return { status: 'dev', version: current };
  }
  if (manualPending) {
    return { status: 'busy', version: current };
  }

  console.log('[auto-updater] manual check requested');
  const result = await new Promise((resolve) => {
    manualPending = {
      resolve,
      timer: setTimeout(() => { settleManual({ status: 'error', version: current }); }, 30000),
    };
    autoUpdater.checkForUpdates().catch((err) => {
      console.warn('[auto-updater] manual checkForUpdates failed:', err.message);
      settleManual({ status: 'error', version: current, message: err.message });
    });
  });

  if (result.status === 'latest') {
    await dialog.showMessageBox({
      type: 'info',
      title: '检查更新',
      message: `已是最新版本（v${current}）`,
      detail: '当前没有可用的更新。',
      buttons: ['好的'],
      noLink: true,
    });
  } else if (result.status === 'error') {
    await dialog.showMessageBox({
      type: 'warning',
      title: '检查更新失败',
      message: '无法连接到更新服务器',
      detail: '请检查网络后重试，或到 GitHub Releases 页面手动下载最新版本。',
      buttons: ['好的'],
      noLink: true,
    });
  }
  // 'available' → the update-available handler already showed the download prompt.
  return result;
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

  autoUpdater.on('update-available', (info) => {
    promptUpdateAvailable(info).catch(() => {});
    settleManual({ status: 'available', version: (info && info.version) || '', current: app.getVersion() });
  });
  autoUpdater.on('update-not-available', () => {
    sendUpdateStatus({ status: 'latest', version: app.getVersion() });
    settleManual({ status: 'latest', version: app.getVersion() });
  });
  autoUpdater.on('download-progress', (p) => {
    const percent = p && typeof p.percent === 'number' ? Math.round(p.percent) : 0;
    setTaskbarProgress(percent);
    sendUpdateStatus({
      status: 'downloading',
      percent,
      transferred: p && p.transferred,
      total: p && p.total,
      bytesPerSecond: p && p.bytesPerSecond,
    });
  });
  autoUpdater.on('update-downloaded', (info) => { promptUpdateDownloaded(info).catch(() => {}); });
  autoUpdater.on('error', (err) => {
    console.warn('[auto-updater] error:', err && err.message ? err.message : err);
  });

  setTimeout(() => { checkNow(); }, FIRST_CHECK_DELAY_MS);
  setInterval(() => { checkNow(); }, CHECK_INTERVAL_MS);
}

module.exports = { initAutoUpdater, checkNow, manualCheck };

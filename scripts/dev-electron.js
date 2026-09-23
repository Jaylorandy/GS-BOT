/**
 * GS Bot dev 启动器 —— 启动 vite :5173 的 Electron 开发窗口。
 *
 * 用法（必须用后台任务方式跑，见下方说明）：
 *   Bash(run_in_background=true):
 *     cd "E:/GS Bot-app" && node scripts/dev-electron.js
 *
 * 前置条件：vite dev server 已在 5173 运行
 *   node node_modules/vite/bin/vite.js --port 5173 --strictPort
 *
 * ── 为什么要这么绕（2026-09-22 实测）──────────────────────────
 * 1) ELECTRON_RUN_AS_NODE 必须删除：WorkBuddy CLI 自身跑在该变量下，子进程会
 *    继承 → electron 变身 node 直接秒退、零输出。
 * 2) 不能前台 spawn 后退出脚本：父进程一退出，Windows Job Object 会把 electron
 *    连同整棵进程树一起杀掉（实测 spawn+detached+unref、PowerShell Start-Process
 *    三种方式全部被连坐，窗口起来 1 分钟后消失）。
 * 3) schtasks 被 WorkBuddy 安全策略黑名单拦截，不可用。
 * 4) 唯一可靠方式：让本脚本自身常驻（setInterval 保活），并把 electron 作为它的
 *    子进程 —— 由 Bash 工具的 run_in_background 托管，不受单条命令生命周期影响。
 *    stdio 直接指向日志文件 fd（不用 pipe），避免父进程异常退出时 EPIPE。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const logPath = path.join(root, 'scripts', 'dev-electron.log');
const electronExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');

if (!fs.existsSync(electronExe)) {
  console.error('[dev] electron.exe not found: ' + electronExe);
  process.exit(1);
}

const fd = fs.openSync(logPath, 'w');
const write = (s) => fs.writeSync(fd, s + '\n');

write('dev-launch at ' + new Date().toISOString());

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;

const child = spawn(electronExe, ['.', '--no-sandbox'], {
  cwd: root,
  env,
  stdio: ['ignore', fd, fd],
});

write('spawned electron PID=' + child.pid + ' (log: ' + logPath + ')');

child.on('exit', (code, sig) => {
  write('EXIT code=' + code + ' signal=' + sig + ' at ' + new Date().toISOString());
});

// 保活：父进程不退出，electron 才能活过单条命令。
setInterval(() => {
  if (child.exitCode !== null) {
    write('CHILD_EXITED code=' + child.exitCode + ' at ' + new Date().toISOString());
  }
}, 30000);

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

function showFatalStartupError(error) {
  const root = document.getElementById('root');
  if (!root) {
    return;
  }

  const message = error?.stack || error?.message || String(error || 'Unknown startup error');
  root.innerHTML = `
    <div style="min-height:100vh;padding:32px;font-family:Arial,sans-serif;background:#f7f3ea;color:#241f19;">
      <div style="max-width:760px;margin:10vh auto;padding:24px;border:1px solid #d8cbbb;border-radius:18px;background:#fffaf1;box-shadow:0 20px 60px rgba(70,48,24,.12);">
        <h1 style="margin:0 0 12px;font-size:24px;">GS Bot failed to start</h1>
        <p style="margin:0 0 16px;line-height:1.6;">The app hit a renderer error while opening. Please send this message back for diagnosis.</p>
        <pre style="white-space:pre-wrap;overflow:auto;max-height:45vh;padding:14px;border-radius:12px;background:#241f19;color:#fff4df;font-size:12px;">${message.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))}</pre>
      </div>
    </div>
  `;
}

window.addEventListener('error', (event) => {
  showFatalStartupError(event.error || event.message);
});

// 未处理的 Promise 拒绝：仅启动阶段（应用尚未渲染成功）视为致命；
// 运行期的零散 rejection 只记 console，不能把整个 UI 炸成错误屏
//（实例：View Transition 被窗口遮挡中止 → InvalidStateError → 全屏崩溃）。
// 注意「已渲染」判定不能依赖 rAF —— 窗口被遮挡时 rAF 暂停，永远不触发；
// 用 root 是否已有子节点（React 真实提交）来判定。
window.addEventListener('unhandledrejection', (event) => {
  console.error('[GS Bot] Unhandled rejection:', event.reason);
  const root = document.getElementById('root');
  const mounted = appRendered || Boolean(root && root.childElementCount > 0);
  if (!mounted) {
    showFatalStartupError(event.reason || 'Unhandled promise rejection');
  }
});

let appRendered = false;
try {
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
  // React render() 异步提交：两帧后补充标记（正常可见窗口的快速路径）
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      appRendered = true;
    });
  });
} catch (error) {
  showFatalStartupError(error);
}

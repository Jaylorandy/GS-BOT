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

window.addEventListener('unhandledrejection', (event) => {
  showFatalStartupError(event.reason || 'Unhandled promise rejection');
});

try {
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
} catch (error) {
  showFatalStartupError(error);
}

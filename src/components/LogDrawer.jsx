import React, { useEffect, useRef } from 'react';
import { useI18n } from '../utils/i18n';
import './LogDrawer.css';

export default function LogDrawer({ open, logs, onClose, accentRgb }) {
  const { tx } = useI18n();
  const endRef = useRef(null);

  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs, open]);

  return (
    <>
      {open && <div className="log-drawer-overlay" onClick={onClose} />}
      <aside className={`log-drawer ${open ? 'open' : ''}`} style={{ '--accent-rgb': accentRgb || '168, 199, 250' }}>
        <header className="log-drawer__head">
          <h3 className="log-drawer__title">{tx('Activity Log', '运行日志')}</h3>
          <button type="button" className="log-drawer__close" onClick={onClose}>✕</button>
        </header>
        <div className="log-drawer__body">
          {logs.length === 0 ? (
            <p className="log-drawer__empty">{tx('No logs yet. Run a task to see activity.', '暂无日志。运行任务后此处将显示活动记录。')}</p>
          ) : (
            logs.map((entry, i) => (
              <div key={i} className={`log-drawer__entry log-drawer__entry--${entry.type || 'info'}`}>
                <span className="log-drawer__time">{entry.time}</span>
                <span className="log-drawer__msg">{entry.message}</span>
              </div>
            ))
          )}
          <div ref={endRef} />
        </div>
      </aside>
    </>
  );
}

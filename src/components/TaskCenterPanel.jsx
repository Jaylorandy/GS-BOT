import React, { useMemo } from 'react';
import { useI18n } from '../utils/i18n';

function formatDateTime(value = '', language = 'en') {
  if (!value) {
    return language === 'zh' ? '暂无' : 'N/A';
  }

  try {
    return new Date(value).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-US');
  } catch {
    return value;
  }
}

function formatBytes(value = 0) {
  const size = Number(value) || 0;
  if (size <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB'];
  let current = size;
  let index = 0;
  while (current >= 1024 && index < units.length - 1) {
    current /= 1024;
    index += 1;
  }
  return `${current.toFixed(current >= 100 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function getTaskTone(status = '') {
  if (status === 'completed') {
    return 'success';
  }
  if (status === 'failed') {
    return 'error';
  }
  if (status === 'cancelled') {
    return 'warning';
  }
  return 'info';
}

function getStatusLabel(status = '', tx) {
  if (status === 'completed') {
    return tx('Done', '完成');
  }
  if (status === 'failed') {
    return tx('Failed', '失败');
  }
  if (status === 'cancelled') {
    return tx('Cancelled', '已取消');
  }
  return tx('Running', '运行中');
}

function getCacheModeLabel(value = '', tx) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    return '';
  }
  if (normalized === 'force-refresh') {
    return tx('Forced refresh', '强制重跑');
  }
  if (normalized === 'use-cache') {
    return tx('Use cache', '使用缓存');
  }
  if (normalized === 'live-run') {
    return tx('Live run', '实时运行');
  }
  return value;
}

function getPathLeaf(value = '') {
  return String(value || '')
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .filter(Boolean)
    .pop() || '';
}

export default function TaskCenterPanel({
  open = false,
  tasks = [],
  history = [],
  cacheSummary = null,
  cacheBusy = false,
  clearingNamespace = '',
  onClose,
  onRefresh,
  onClearNamespace,
  onClearHistory,
  onClearAll,
}) {
  const { language, tx } = useI18n();
  const visibleTasks = useMemo(() => Array.isArray(tasks) ? tasks : [], [tasks]);
  const visibleHistory = useMemo(() => Array.isArray(history) ? history.slice(0, 8) : [], [history]);
  const visibleCaches = useMemo(() => Array.isArray(cacheSummary?.namespaces) ? cacheSummary.namespaces : [], [cacheSummary]);

  return (
    <aside className={`task-center-panel ${open ? 'open' : ''}`} aria-hidden={!open}>
      <div className="task-center-scrim" onClick={onClose} />
      <div className="task-center-sheet">
        <header className="task-center-header">
          <div>
            <span className="task-center-kicker">{tx('Mac Workspace', 'Mac 工作台')}</span>
            <h3>{tx('Tasks & Cache', '任务与缓存')}</h3>
            <p>{tx('Track what is running and control cached OCR / slide preparation data.', '查看当前任务，并控制 OCR 与 PPT 预处理缓存。')}</p>
          </div>
          <div className="task-center-header-actions">
            <button
              type="button"
              className="task-center-button danger"
              disabled={cacheBusy || clearingNamespace === '__all__'}
              onClick={onClearAll}
            >
              {clearingNamespace === '__all__'
                ? tx('Cleaning…', '清理中…')
                : tx('Clean All', '一键清理')}
            </button>
            <button type="button" className="task-center-button secondary" onClick={onRefresh}>
              {tx('Refresh', '刷新')}
            </button>
            <button type="button" className="task-center-button ghost" onClick={onClose}>
              {tx('Close', '关闭')}
            </button>
          </div>
        </header>

        <section className="task-center-section">
          <div className="task-center-section-head">
            <h4>{tx('Active Tasks', '进行中的任务')}</h4>
            <span>{visibleTasks.length}</span>
          </div>
          <div className="task-center-card-list">
            {visibleTasks.length ? visibleTasks.map((task) => (
              <article key={task.id} className={`task-center-card tone-${getTaskTone(task.status)}`}>
                <div className="task-center-card-topline" />
                <div className="task-center-card-row">
                  <strong>{task.label || task.taskType}</strong>
                  <span className={`task-center-pill tone-${getTaskTone(task.status)}`}>
                    {getStatusLabel(task.status, tx)}
                  </span>
                </div>
                <div className="task-center-card-meta">
                  <span>{tx('Started', '开始')} · {formatDateTime(task.startedAt, language)}</span>
                </div>
                {task.summary ? <div className="task-center-card-summary">{task.summary}</div> : null}
                {task.cacheMode ? (
                  <div className="task-center-chip-row">
                    <span className="task-center-chip">{getCacheModeLabel(task.cacheMode, tx)}</span>
                  </div>
                ) : null}
                {(task.inputPath || task.outputPath) ? (
                  <div className="task-center-path-grid">
                    {task.inputPath ? (
                      <div className="task-center-path-block">
                        <span>{tx('Input', '输入')}</span>
                        <code title={task.inputPath}>{getPathLeaf(task.inputPath) || task.inputPath}</code>
                      </div>
                    ) : null}
                    {task.outputPath ? (
                      <div className="task-center-path-block">
                        <span>{tx('Output', '输出')}</span>
                        <code title={task.outputPath}>{getPathLeaf(task.outputPath) || task.outputPath}</code>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </article>
            )) : (
              <div className="task-center-empty">
                {tx('No active tasks right now.', '当前没有正在运行的任务。')}
              </div>
            )}
          </div>
        </section>

        <section className="task-center-section">
          <div className="task-center-section-head">
            <h4>{tx('Cache Control', '缓存控制')}</h4>
            <span>{cacheBusy ? tx('Loading…', '加载中…') : visibleCaches.length}</span>
          </div>
          <div className="task-center-card-list">
            {visibleCaches.map((entry) => (
              <article key={entry.namespace} className="task-center-card">
                <div className="task-center-card-row">
                  <strong>{entry.namespace}</strong>
                  <button
                    type="button"
                    className="task-center-button secondary small"
                    disabled={cacheBusy || clearingNamespace === entry.namespace || clearingNamespace === '__all__'}
                    onClick={() => onClearNamespace?.(entry.namespace)}
                  >
                    {clearingNamespace === entry.namespace
                      ? tx('Clearing…', '清理中…')
                      : tx('Clear', '清理')}
                  </button>
                </div>
                <div className="task-center-cache-grid">
                  <span>{tx('Files', '文件')} · {entry.fileCount || 0}</span>
                  <span>{tx('Size', '大小')} · {formatBytes(entry.totalBytes)}</span>
                  <span>{tx('Updated', '更新时间')} · {formatDateTime(entry.lastModifiedAt, language)}</span>
                </div>
                {entry.dirPath ? <code>{entry.dirPath}</code> : null}
              </article>
            ))}
            {!visibleCaches.length ? (
              <div className="task-center-empty">
                {tx('No cache summary available yet.', '暂时还没有缓存摘要。')}
              </div>
            ) : null}
          </div>
        </section>

        <section className="task-center-section">
          <div className="task-center-section-head">
            <h4>{tx('Recent History', '最近历史')}</h4>
            <button
              type="button"
              className="task-center-button ghost small"
              disabled={cacheBusy || !visibleHistory.length || clearingNamespace === '__all__'}
              onClick={onClearHistory}
            >
              {tx('Clear History', '清空历史')}
            </button>
          </div>
          <div className="task-center-history-list">
            {visibleHistory.length ? visibleHistory.map((task) => (
              <div key={task.id + task.updatedAt} className="task-center-history-row">
                <div className="task-center-history-main">
                  <strong>{task.label || task.taskType}</strong>
                  <p>{formatDateTime(task.updatedAt || task.endedAt, language)}</p>
                  {task.summary ? <p className="task-center-history-summary">{task.summary}</p> : null}
                  {(task.inputPath || task.outputPath) ? (
                    <div className="task-center-history-paths">
                      {task.inputPath ? <span>{tx('Input', '输入')} · {getPathLeaf(task.inputPath) || task.inputPath}</span> : null}
                      {task.outputPath ? <span>{tx('Output', '输出')} · {getPathLeaf(task.outputPath) || task.outputPath}</span> : null}
                    </div>
                  ) : null}
                  {task.error ? <p className="task-center-history-error">{task.error}</p> : null}
                </div>
                <div className="task-center-history-side">
                  {task.cacheMode ? <span className="task-center-chip subtle">{getCacheModeLabel(task.cacheMode, tx)}</span> : null}
                  <span className={`task-center-pill tone-${getTaskTone(task.status)}`}>
                    {getStatusLabel(task.status, tx)}
                  </span>
                </div>
              </div>
            )) : (
              <div className="task-center-empty">
                {tx('Task history will appear here after you run a workflow.', '运行过工作流后，这里会显示最近任务记录。')}
              </div>
            )}
          </div>
        </section>
      </div>
    </aside>
  );
}

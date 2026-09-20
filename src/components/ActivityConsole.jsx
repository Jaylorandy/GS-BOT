import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './ActivityConsole.css';

function normalizeLogEntry(log) {
  if (typeof log === 'string') {
    const match = log.match(/^\[(.*?)\]\s*(.*)$/);
    if (match) {
      return {
        time: match[1],
        message: match[2],
        type: 'info',
      };
    }

    return {
      time: '',
      message: log,
      type: 'info',
    };
  }

  return {
    time: log?.time || '',
    message: log?.message || log?.msg || '',
    type: log?.type || 'info',
  };
}

function getProgressMergeKey(entry) {
  const message = String(entry?.message || '').trim();
  if (!message) {
    return '';
  }

  const stripped = message
    .replace(/\s*\(\d{1,3}%\)\s*$/i, '')
    .replace(/\s+\d{1,3}%\s*$/i, '')
    .trim();

  if (stripped !== message) {
    return `${entry?.type || 'info'}::${stripped}`;
  }

  if (/^Label OCR:\s+OCR\s+/i.test(message)) {
    return `${entry?.type || 'info'}::${message.replace(/\s*\([^)]*\)\s*$/i, '').trim()}`;
  }

  return '';
}

function compactProgressLogs(entries = []) {
  const result = [];

  entries.forEach((entry) => {
    const mergeKey = getProgressMergeKey(entry);
    const previous = result[result.length - 1];
    if (mergeKey && previous?.__mergeKey === mergeKey) {
      result[result.length - 1] = {
        ...entry,
        __mergeKey: mergeKey,
        __count: (previous.__count || 1) + 1,
      };
      return;
    }

    const messageKey = `${entry?.type || 'info'}::${String(entry?.message || '').trim()}`;
    if (previous && !previous.__mergeKey && previous.__messageKey === messageKey) {
      result[result.length - 1] = {
        ...entry,
        __messageKey: messageKey,
        __count: (previous.__count || 1) + 1,
      };
      return;
    }

    result.push({
      ...entry,
      __mergeKey: mergeKey,
      __messageKey: messageKey,
      __count: 1,
    });
  });

  return result.map(({ __mergeKey, __messageKey, __count, ...entry }) => ({
    ...entry,
    count: __count > 1 ? __count : undefined,
  }));
}

function renderEntry(entry, index, variant) {
  return (
    <div
      key={`${entry.time || 'log'}-${index}-${variant}`}
      className={`activity-log-entry activity-log-${entry.type || 'info'} ${variant}`}
    >
      {entry.time ? <span className="activity-log-time">{entry.time}</span> : null}
      <span className="activity-log-message">{entry.message}</span>
      {entry.count && entry.count > 1 ? (
        <span className="activity-log-count">×{entry.count}</span>
      ) : null}
    </div>
  );
}

export default function ActivityConsole({
  title = 'Console',
  layout = 'full',
  logs = [],
  onClear,
  onCancel,
  progress = 0,
  isActive = false,
  isCancelling = false,
  progressLabel = 'In progress',
  progressDetail = '',
  compactCount = 10,
  emptyState = null,
  cancelLabel = 'Cancel',
  completionState = 'idle',
  completionTitle = '',
  completionMessage = '',
  completionMeta = [],
  completionActions = [],
  completionIssues = [],
  isVisible = true,
  showDockStatus = true,
  showCompletionCard = true,
}) {
  const [showFullLog, setShowFullLog] = useState(false);
  const [showCelebration, setShowCelebration] = useState(false);
  const [copyState, setCopyState] = useState('idle');
  const previousCompletionSignatureRef = useRef('');
  const copyResetRef = useRef(0);
  const normalizedLogs = useMemo(
    () => compactProgressLogs(logs.map(normalizeLogEntry)),
    [logs],
  );
  const previewLogs = normalizedLogs.slice(-compactCount);
  const hiddenCount = Math.max(0, normalizedLogs.length - previewLogs.length);
  const safeProgress = Math.max(0, Math.min(100, Number(progress) || 0));
  const normalizedCompletionMeta = useMemo(
    () => (Array.isArray(completionMeta) ? completionMeta.filter(Boolean).slice(0, 4) : []),
    [completionMeta],
  );
  const normalizedCompletionActions = useMemo(
    () => (Array.isArray(completionActions) ? completionActions.filter((item) => item?.label && typeof item?.onClick === 'function') : []),
    [completionActions],
  );
  const normalizedCompletionIssues = useMemo(
    () => (Array.isArray(completionIssues)
      ? completionIssues
        .filter((section) => section?.title && Array.isArray(section?.items) && section.items.length > 0)
        .map((section) => ({
          ...section,
          items: [...new Set(section.items.map((item) => String(item || '').trim()).filter(Boolean))],
        }))
      : []),
    [completionIssues],
  );
  const showCompletion = showCompletionCard && completionState === 'success' && !isActive;
  const completionSignature = `${completionState}|${completionTitle}|${completionMessage}|${normalizedCompletionMeta.join('|')}`;
  const isDockLayout = layout === 'dock';
  const showProgress = !showCompletion && (isActive || safeProgress > 0);
  const logText = useMemo(
    () => normalizedLogs
      .map((entry) => `${entry.time ? `[${entry.time}] ` : ''}${entry.message}`)
      .join('\n'),
    [normalizedLogs],
  );

  useEffect(() => {
    if (!isVisible && showFullLog) {
      setShowFullLog(false);
    }
  }, [isVisible, showFullLog]);

  useEffect(() => {
    if (showCompletion && completionSignature !== previousCompletionSignatureRef.current) {
      setShowCelebration(true);
      const timeoutId = window.setTimeout(() => setShowCelebration(false), 2400);
      previousCompletionSignatureRef.current = completionSignature;
      return () => window.clearTimeout(timeoutId);
    }

    if (!showCompletion) {
      setShowCelebration(false);
      previousCompletionSignatureRef.current = '';
    }

    return undefined;
  }, [showCompletion, completionSignature]);

  const handleCopyLogs = async () => {
    if (!logText) {
      return;
    }

    try {
      await navigator.clipboard.writeText(logText);
      setCopyState('copied');
      window.clearTimeout(copyResetRef.current);
      copyResetRef.current = window.setTimeout(() => setCopyState('idle'), 1600);
    } catch {
      setCopyState('failed');
      window.clearTimeout(copyResetRef.current);
      copyResetRef.current = window.setTimeout(() => setCopyState('idle'), 1600);
    }
  };

  const dockContent = (
    <div className={`activity-console ${showCompletion ? 'is-complete' : ''} ${isDockLayout ? 'is-dock' : ''}`}>
      {isDockLayout ? (
        <div className="activity-console-dockbar minimal">
          <button
            type="button"
            className={`activity-console-icon-btn document ${showCompletion ? 'is-complete' : ''} ${isActive ? 'is-active' : ''}`.trim()}
            onClick={() => setShowFullLog(true)}
            title="Open log"
            aria-label="Open log"
          >
            <span className="activity-console-doc-icon" aria-hidden="true">
              <span className="page" />
              <span className="fold" />
              <span className="line line-1" />
              <span className="line line-2" />
              <span className="line line-3" />
            </span>
            {normalizedLogs.length > 0 ? (
              <span className="activity-console-icon-count">{normalizedLogs.length}</span>
            ) : null}
          </button>
        </div>
      ) : (
        <>
          <div className="activity-console-header">
            <div className="activity-console-heading">
              <h3>{title}</h3>
              {hiddenCount > 0 ? (
                <span className="activity-console-summary">
                  {previewLogs.length} / {normalizedLogs.length}
                </span>
              ) : null}
            </div>

            <div className="activity-console-actions">
              {isActive && onCancel ? (
                <button
                  type="button"
                  className="activity-console-btn danger"
                  onClick={onCancel}
                  disabled={isCancelling}
                >
                  {isCancelling ? 'Cancelling...' : cancelLabel}
                </button>
              ) : null}
              {normalizedLogs.length > 0 ? (
                <button
                  type="button"
                  className="activity-console-btn"
                  onClick={() => setShowFullLog(true)}
                >
                  Full Log
                </button>
              ) : null}
              {normalizedLogs.length > 0 && onClear ? (
                <button
                  type="button"
                  className="activity-console-btn secondary"
                  onClick={onClear}
                >
                  Clear
                </button>
              ) : null}
            </div>
          </div>

          {showProgress ? (
            <div className="activity-progress">
              <div className="activity-progress-meta">
                <span className="activity-progress-label">{progressLabel}</span>
                <span className="activity-progress-value">{Math.round(safeProgress)}%</span>
              </div>

              <div className="activity-progress-track">
                <div
                  className={`activity-progress-fill ${isActive ? 'active' : ''} ${showCompletion ? 'success' : ''}`}
                  style={{ width: `${safeProgress}%` }}
                />
              </div>

              {progressDetail ? (
                <div className="activity-progress-detail">{progressDetail}</div>
              ) : null}
            </div>
          ) : null}

          {showCompletion ? (
            <div className={`activity-completion-card ${showCelebration ? 'celebrate' : ''}`}>
              <span className="activity-completion-spark spark-a" aria-hidden="true" />
              <span className="activity-completion-spark spark-b" aria-hidden="true" />
              <span className="activity-completion-spark spark-c" aria-hidden="true" />

              <div className="activity-completion-header">
                <span className="activity-completion-pill">Complete</span>
                <div className="activity-completion-copy">
                  <strong>{completionTitle || 'Task complete'}</strong>
                  {completionMessage ? <p>{completionMessage}</p> : null}
                </div>
              </div>

              {normalizedCompletionMeta.length > 0 ? (
                <div className="activity-completion-meta">
                  {normalizedCompletionMeta.map((item) => (
                    <span key={item} className="activity-completion-chip">
                      {item}
                    </span>
                  ))}
                </div>
              ) : null}

              {normalizedCompletionIssues.length > 0 ? (
                <div className="activity-completion-issues">
                  {normalizedCompletionIssues.map((section) => {
                    const visibleItems = section.items.slice(0, 8);
                    const hiddenIssueCount = Math.max(0, section.items.length - visibleItems.length);
                    return (
                      <div key={section.key || section.title} className="activity-completion-issue-group">
                        <div className="activity-completion-issue-header">
                          <strong>{section.title}</strong>
                          <span>{section.items.length}</span>
                        </div>
                        <div className="activity-completion-issue-items">
                          {visibleItems.map((item) => (
                            <span key={`${section.key || section.title}-${item}`} className="activity-completion-issue-chip">
                              {item}
                            </span>
                          ))}
                          {hiddenIssueCount > 0 ? (
                            <span className="activity-completion-issue-chip muted">
                              +{hiddenIssueCount} more
                            </span>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : null}

              {normalizedCompletionActions.length > 0 ? (
                <div className="activity-completion-actions">
                  {normalizedCompletionActions.map((action) => (
                    <button
                      key={action.label}
                      type="button"
                      className={`activity-console-btn ${action.variant || ''}`.trim()}
                      onClick={action.onClick}
                      disabled={action.disabled}
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="activity-console-body">
            {normalizedLogs.length === 0 ? (
              emptyState || <div className="activity-log-empty">No log entries yet.</div>
            ) : (
              previewLogs.map((entry, index) => renderEntry(entry, index, 'preview'))
            )}
          </div>
        </>
      )}
    </div>
  );

  const dockStatusContent = isDockLayout && showDockStatus && (showProgress || showCompletion) ? (
    <div className="activity-console-dock-status" aria-live="polite">
      {showProgress ? (
        <div className="activity-progress dock-status">
          <div className="activity-progress-meta">
            <span className="activity-progress-label">{progressLabel}</span>
            <span className="activity-progress-value">{Math.round(safeProgress)}%</span>
          </div>

          <div className="activity-progress-track">
            <div
              className={`activity-progress-fill ${isActive ? 'active' : ''} ${showCompletion ? 'success' : ''}`}
              style={{ width: `${safeProgress}%` }}
            />
          </div>

          {progressDetail ? (
            <div className="activity-progress-detail">{progressDetail}</div>
          ) : null}

          {isActive && onCancel ? (
            <div className="activity-console-actions dock-status">
              <button
                type="button"
                className="activity-console-btn danger"
                onClick={onCancel}
                disabled={isCancelling}
              >
                {isCancelling ? 'Cancelling...' : cancelLabel}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {showCompletion ? (
        <div className={`activity-completion-card dock-status ${showCelebration ? 'celebrate' : ''}`}>
          <span className="activity-completion-spark spark-a" aria-hidden="true" />
          <span className="activity-completion-spark spark-b" aria-hidden="true" />
          <span className="activity-completion-spark spark-c" aria-hidden="true" />

          <div className="activity-completion-header">
            <span className="activity-completion-pill">Complete</span>
            <div className="activity-completion-copy">
              <strong>{completionTitle || 'Task complete'}</strong>
              {completionMessage ? <p>{completionMessage}</p> : null}
            </div>
          </div>

          {normalizedCompletionMeta.length > 0 ? (
            <div className="activity-completion-meta">
              {normalizedCompletionMeta.map((item) => (
                <span key={item} className="activity-completion-chip">
                  {item}
                </span>
              ))}
            </div>
          ) : null}

          {normalizedCompletionIssues.length > 0 ? (
            <div className="activity-completion-issues">
              {normalizedCompletionIssues.map((section) => {
                const visibleItems = section.items.slice(0, 8);
                const hiddenItemCount = Math.max(0, section.items.length - visibleItems.length);
                return (
                  <div key={section.key || section.title} className="activity-completion-issue-group">
                    <div className="activity-completion-issue-header">
                      <strong>{section.title}</strong>
                      <span>{section.items.length}</span>
                    </div>
                    <div className="activity-completion-issue-items">
                      {visibleItems.map((item) => (
                        <span key={`${section.key || section.title}-${item}`} className="activity-completion-issue-chip">
                          {item}
                        </span>
                      ))}
                      {hiddenItemCount > 0 ? (
                        <span className="activity-completion-issue-chip muted">
                          +{hiddenItemCount} more
                        </span>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : null}

          {normalizedCompletionActions.length > 0 ? (
            <div className="activity-completion-actions">
              {normalizedCompletionActions.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  className={`activity-console-btn ${action.variant || ''}`.trim()}
                  onClick={action.onClick}
                  disabled={action.disabled}
                >
                  {action.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  ) : null;

  const modalContent = showFullLog ? (
    <div
      className="activity-log-modal-overlay"
      onClick={() => setShowFullLog(false)}
    >
      <div
        className="activity-log-modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="activity-log-modal-header">
          <div>
            <h3>{title}</h3>
            <span>{normalizedLogs.length} entries</span>
          </div>
          <div className="activity-console-actions">
            {normalizedLogs.length > 0 ? (
              <button
                type="button"
                className="activity-console-btn"
                onClick={handleCopyLogs}
              >
                {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Retry copy' : 'Copy'}
              </button>
            ) : null}
            {onClear ? (
              <button
                type="button"
                className="activity-console-btn secondary"
                onClick={onClear}
              >
                Clear
              </button>
            ) : null}
            <button
              type="button"
              className="activity-console-btn"
              onClick={() => setShowFullLog(false)}
            >
              Close
            </button>
          </div>
        </div>

        <div className="activity-log-modal-body">
          {showProgress ? (
            <div className="activity-progress modal">
              <div className="activity-progress-meta">
                <span className="activity-progress-label">{progressLabel}</span>
                <span className="activity-progress-value">{Math.round(safeProgress)}%</span>
              </div>

              <div className="activity-progress-track">
                <div
                  className={`activity-progress-fill ${isActive ? 'active' : ''} ${showCompletion ? 'success' : ''}`}
                  style={{ width: `${safeProgress}%` }}
                />
              </div>

              {progressDetail ? (
                <div className="activity-progress-detail">{progressDetail}</div>
              ) : null}
            </div>
          ) : null}

          {showCompletion ? (
            <div className={`activity-completion-card modal ${showCelebration ? 'celebrate' : ''}`}>
              <span className="activity-completion-spark spark-a" aria-hidden="true" />
              <span className="activity-completion-spark spark-b" aria-hidden="true" />
              <span className="activity-completion-spark spark-c" aria-hidden="true" />

              <div className="activity-completion-header">
                <span className="activity-completion-pill">Complete</span>
                <div className="activity-completion-copy">
                  <strong>{completionTitle || 'Task complete'}</strong>
                  {completionMessage ? <p>{completionMessage}</p> : null}
                </div>
              </div>

              {normalizedCompletionMeta.length > 0 ? (
                <div className="activity-completion-meta">
                  {normalizedCompletionMeta.map((item) => (
                    <span key={item} className="activity-completion-chip">
                      {item}
                    </span>
                  ))}
                </div>
              ) : null}

              {normalizedCompletionIssues.length > 0 ? (
                <div className="activity-completion-issues">
                  {normalizedCompletionIssues.map((section) => {
                    const visibleItems = section.items.slice(0, 8);
                    const hiddenItemCount = Math.max(0, section.items.length - visibleItems.length);
                    return (
                      <div key={section.key || section.title} className="activity-completion-issue-group">
                        <div className="activity-completion-issue-header">
                          <strong>{section.title}</strong>
                          <span>{section.items.length}</span>
                        </div>
                        <div className="activity-completion-issue-items">
                          {visibleItems.map((item) => (
                            <span key={`${section.key || section.title}-${item}`} className="activity-completion-issue-chip">
                              {item}
                            </span>
                          ))}
                          {hiddenItemCount > 0 ? (
                            <span className="activity-completion-issue-chip muted">
                              +{hiddenItemCount} more
                            </span>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : null}

              {normalizedCompletionActions.length > 0 ? (
                <div className="activity-completion-actions">
                  {normalizedCompletionActions.map((action) => (
                    <button
                      key={action.label}
                      type="button"
                      className={`activity-console-btn ${action.variant || ''}`.trim()}
                      onClick={action.onClick}
                      disabled={action.disabled}
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {normalizedLogs.length === 0 ? (
            emptyState || <div className="activity-log-empty">No log entries yet.</div>
          ) : (
            normalizedLogs.map((entry, index) => renderEntry(entry, index, 'full'))
          )}
        </div>
      </div>
    </div>
  ) : null;

  const dockTarget = typeof document !== 'undefined' ? document.getElementById('workspace-log-anchor') : null;
  const overlayTarget = typeof document !== 'undefined' ? document.getElementById('workspace-overlay-root') : null;

  return (
    <>
      {isVisible && dockStatusContent}
      {isVisible ? (isDockLayout && dockTarget ? createPortal(dockContent, dockTarget) : dockContent) : null}
      {isVisible && modalContent ? (overlayTarget ? createPortal(modalContent, overlayTarget) : modalContent) : null}
    </>
  );
}

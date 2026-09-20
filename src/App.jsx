import React, { useEffect, useId, useRef, useState, useCallback } from 'react';
import SetupGuide from './components/SetupGuide';
import HelpManual from './components/HelpManual';
import LicenseGate from './components/LicenseGate';
import ModuleHome from './ModuleHome';
import LogDrawer from './components/LogDrawer';
import TaskCenterPanel from './components/TaskCenterPanel';
import { subscribeLLMConfigUpdate } from './utils/llmConfigSync';
import { LanguageProvider, useI18n } from './utils/i18n';
import './App.css';

function AppIcon({ name, className = '' }) {
  const sharedProps = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: '1.7',
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    className,
    'aria-hidden': 'true',
  };

  switch (name) {
    case 'scraper':
      return (
        <svg {...sharedProps}>
          <circle cx="12" cy="12" r="8.25" />
          <path d="M4.8 12h14.4" />
          <path d="M12 3.75c2.25 2.3 3.5 5.1 3.5 8.25S14.25 17.95 12 20.25" />
          <path d="M12 3.75c-2.25 2.3-3.5 5.1-3.5 8.25S9.75 17.95 12 20.25" />
        </svg>
      );
    case 'slides':
      return (
        <svg {...sharedProps}>
          <rect x="5.25" y="5.25" width="13.5" height="8.5" rx="2.2" />
          <path d="M8 18.75h8" />
          <path d="M12 13.75v5" />
        </svg>
      );
    case 'organizer':
      return (
        <svg {...sharedProps}>
          <rect x="4.5" y="4.5" width="6.5" height="6.5" rx="1.6" />
          <rect x="13" y="4.5" width="6.5" height="6.5" rx="1.6" />
          <rect x="4.5" y="13" width="6.5" height="6.5" rx="1.6" />
          <rect x="13" y="13" width="6.5" height="6.5" rx="1.6" />
        </svg>
      );
    case 'labelocr':
      return (
        <svg {...sharedProps}>
          <path d="M6.5 7.25h7.75l3.5 3.5-7.25 7.25-4-4Z" />
          <circle cx="13.45" cy="10.55" r="1.1" />
        </svg>
      );
    case 'pdfsqueezer':
      return (
        <svg {...sharedProps}>
          <path d="M8 4.5h6l4 4v10.25A1.75 1.75 0 0 1 16.25 20.5H8A1.75 1.75 0 0 1 6.25 18.75v-12.5A1.75 1.75 0 0 1 8 4.5Z" />
          <path d="M14 4.5v4h4" />
          <path d="M9.5 15.25H15" />
          <path d="m11.1 13.4-1.85 1.85 1.85 1.85" />
        </svg>
      );
    case 'bestseller':
      return (
        <svg {...sharedProps}>
          <path d="M3 6.5h18M5 6.5v13a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-13" />
          <path d="M9 11h6M9 14.5h4" />
          <path d="M9 3h6v3.5H9z" />
        </svg>
      );
    case 'tasks':
      return (
        <svg {...sharedProps}>
          <rect x="4" y="4" width="16" height="16" rx="2" />
          <path d="M8 9l2 2 6-6" />
          <path d="M8 16l2 2 6-6" />
        </svg>
      );
    case 'license':
      return (
        <svg {...sharedProps}>
          <path d="M12 2 4 6v6c0 5 3.5 8 8 10 4.5-2 8-5 8-10V6Z" />
          <path d="M9 12l2 2 4-4" />
        </svg>
      );
    case 'setup':
      return (
        <svg {...sharedProps}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
        </svg>
      );
    case 'update':
      return (
        <svg {...sharedProps}>
          <path d="M20.5 12a8.5 8.5 0 1 1-2.5-6" />
          <path d="M20.7 3.6v5h-5" />
        </svg>
      );
    case 'help':
      return (
        <svg {...sharedProps}>
          <circle cx="12" cy="12" r="10" />
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      );
    case 'folder':
      return (
        <svg {...sharedProps}>
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
        </svg>
      );
    case 'image':
      return (
        <svg {...sharedProps}>
          <rect x="3" y="4" width="18" height="16" rx="2.2" />
          <circle cx="8.8" cy="9.8" r="1.6" />
          <path d="m21 16-5-5L6 20" />
        </svg>
      );
    default:
      return (
        <svg {...sharedProps}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 3" />
        </svg>
      );
  }
}

function BrandLogo({ className }) {
  const gradientId = useId();
  const glowId = useId();
  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#7cc8ff" />
          <stop offset="35%" stopColor="#7c8cff" />
          <stop offset="70%" stopColor="#a855f7" />
          <stop offset="100%" stopColor="#f06292" />
        </linearGradient>
        <radialGradient id={glowId} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.15" />
          <stop offset="100%" stopColor="#0f1220" stopOpacity="0" />
        </radialGradient>
      </defs>
      {/* 4-pointed star (diamond / compass star) */}
      <path
        d="M50 5 L58 42 L95 50 L58 58 L50 95 L42 58 L5 50 L42 42 Z"
        fill={`url(#${gradientId})`}
      />
    </svg>
  );
}

function createTabItems(tx) {
  return [
    {
      id: 'scraper',
      icon: 'scraper',
      accentRgb: '142, 214, 255',
      accentInk: '#072033',
      label: tx('Scraper', '抓取器'),
      navMeta: tx('Capture', '抓取'),
      badge: 'Web',
      description: tx('Batch Zara, Bershka, or Stradivarius assets.', '批量抓取 Zara、Bershka 或 Stradivarius 资料。'),
    },
    {
      id: 'slides',
      icon: 'slides',
      accentRgb: '109, 214, 153',
      accentInk: '#082418',
      label: tx('Slides Maker', 'PPT 生成'),
      navMeta: tx('Decks', '演示文稿'),
      badge: 'PPT',
      description: tx('Build decks from folders.', '从文件夹生成演示文稿。'),
    },
    {
      id: 'bestseller',
      icon: 'bestseller',
      accentRgb: '240, 98, 146',
      accentInk: '#2a0a1a',
      label: tx('Bestseller Analysis', '热门款式分析'),
      navMeta: tx('Analyze', '分析'),
      badge: 'AI',
      description: tx('Scrape bestseller listings and generate an AI trend report.', '抓取畅销榜款式并生成 AI 趋势报告。'),
    },
    {
      id: 'organizer',
      icon: 'organizer',
      accentRgb: '255, 196, 106',
      accentInk: '#2a1700',
      label: tx('Image Organizer', '图片整理'),
      navMeta: tx('Arrange', '整理'),
      badge: 'IMG',
      description: tx('Rename garment or fabric photos from label tags.', '根据标签重命名服装图或面料图。'),
    },
    {
      id: 'labelocr',
      icon: 'labelocr',
      accentRgb: '244, 143, 177',
      accentInk: '#34101f',
      label: tx('Label OCR', '标签规则'),
      navMeta: tx('Rules', '规则'),
      badge: 'OCR',
      description: tx('Set shared OCR label tags for deck generation and image organization.', '统一设置 PPT 生成和图片整理共用的 OCR 标签规则。'),
    },
    {
      id: 'pdfsqueezer',
      icon: 'pdfsqueezer',
      accentRgb: '255, 158, 128',
      accentInk: '#351408',
      label: tx('PDF Squeezer', 'PDF压缩器'),
      navMeta: tx('Compress', '压缩'),
      badge: 'PDF',
      description: tx('Shrink one or more PDFs by recompressing embedded images.', '通过重压缩内嵌图片来缩小一个或多个 PDF。'),
    },
  ];
}

function createWorkspaceGroups(tx) {
  return [
    {
      label: tx('Create', '创作'),
      tabs: ['slides'],
    },
    {
      label: tx('Capture & Analyze', '抓取与分析'),
      tabs: ['scraper', 'bestseller'],
    },
    {
      label: tx('Data', '数据'),
      tabs: ['organizer', 'labelocr', 'pdfsqueezer'],
    },
  ];
}

function hasConfiguredSetup(config) {
  if (!config) return false;
  const hasLocalSetup = Boolean(config.local?.model);
  const hasCloudSetup = Boolean(config.cloud?.baseUrl && config.cloud?.model && config.cloud?.apiKey);
  switch (config.mode) {
    case 'cloud': return hasCloudSetup;
    case 'local':
    default: return hasLocalSetup;
  }
}

function shouldShowSetup(config) {
  if (!config) return true;
  if (config.onboardingCompleted || config.onboardingSkippedAt) return false;
  return !hasConfiguredSetup(config);
}

// 下载进度里的字节数转成人看的单位（1.2 GB / 480 MB）
function formatBytes(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = num;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

function AppContent() {
  const { language, setLanguage, tx } = useI18n();
  const TAB_ITEMS = createTabItems(tx);
  const ALL_TABS = TAB_ITEMS;
  const WORKSPACE_GROUPS = createWorkspaceGroups(tx);
  const [activeTab, setActiveTab] = useState('slides');
  const [theme] = useState('dark');
  const [appReady, setAppReady] = useState(false);
  const [licenseStatus, setLicenseStatus] = useState(null);
  const [showLicenseManager, setShowLicenseManager] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showTaskCenter, setShowTaskCenter] = useState(false);
  const [showLogDrawer, setShowLogDrawer] = useState(false);
  const [appVersion, setAppVersion] = useState('');
  const [updateBusy, setUpdateBusy] = useState(false);
  // 自动更新状态：主进程推送 available / downloading / downloaded / latest / error
  const [updateStatus, setUpdateStatus] = useState(null);
  const [updateBannerDismissed, setUpdateBannerDismissed] = useState(false);
  const [logs, setLogs] = useState([]);
  const [setupVariant, setSetupVariant] = useState('onboarding');
  const [setupConfig, setSetupConfig] = useState(null);
  const [setupDiagnostics, setSetupDiagnostics] = useState(null);
  const [taskCenterState, setTaskCenterState] = useState({ active: [], history: [] });
  const [cacheCenterState, setCacheCenterState] = useState({ namespaces: [], roots: null });
  const [cacheCenterBusy, setCacheCenterBusy] = useState(false);
  const [clearingNamespace, setClearingNamespace] = useState('');
  const shellRef = useRef(null);
  const platform = setupDiagnostics?.platform || 'unknown';
  const currentTab = ALL_TABS.find((tab) => tab.id === activeTab) ?? TAB_ITEMS[0];

  // 更新进度派生值：下载中显示百分比，下载完提示重启安装
  const updatePercent = updateStatus && typeof updateStatus.percent === 'number'
    ? Math.max(0, Math.min(100, Math.round(updateStatus.percent)))
    : 0;
  const updateDownloading = updateStatus?.status === 'downloading';
  const updateReady = updateStatus?.status === 'downloaded';
  const showUpdateBanner = !updateBannerDismissed && (updateDownloading || updateReady || updateStatus?.status === 'error');
  const updateSizeText = updateDownloading && updateStatus?.total
    ? `${formatBytes(updateStatus.transferred) || '0 B'} / ${formatBytes(updateStatus.total)}`
    : '';
  const updateSpeedText = updateDownloading && updateStatus?.bytesPerSecond
    ? `${formatBytes(updateStatus.bytesPerSecond)}/s`
    : '';

  const selectTab = (id) => {
    setActiveTab(id);
    setLogs([]);
  };

  const handleLog = useCallback((entry) => {
    setLogs(prev => [...prev.slice(-300), entry]);
  }, []);

  // 当前版本号，用于工具栏「检查更新」按钮的提示文字
  useEffect(() => {
    let cancelled = false;
    Promise.resolve(window.electronAPI?.getAppVersion?.())
      .then((info) => {
        if (!cancelled && info?.version) setAppVersion(info.version);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // 自动更新状态订阅：下载 480MB 期间让界面持续显示百分比，
  // 否则用户点完「立即下载」后界面上没有任何反馈。
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.onUpdateStatus) return undefined;
    api.onUpdateStatus((payload) => {
      if (!payload || typeof payload !== 'object') return;
      setUpdateStatus(payload);
      if (payload.status === 'downloading' || payload.status === 'available') {
        setUpdateBannerDismissed(false);
      }
      if (payload.status === 'downloading' && typeof payload.percent === 'number') {
        setUpdateBusy(false);
      }
    });
    return () => {
      try { api.removeUpdateListeners?.(); } catch { /* ignore */ }
    };
  }, []);

  // 手动检查更新：结果弹窗由主进程负责，这里只记录日志 + 按钮忙碌态
  const handleCheckUpdates = async () => {
    const api = window.electronAPI;
    if (!api?.checkForUpdates) {
      handleLog({ time: new Date().toLocaleTimeString(), message: tx('Update check is unavailable in this build.', '当前版本不支持检查更新。'), type: 'warning' });
      return;
    }
    setUpdateBusy(true);
    try {
      const result = await api.checkForUpdates();
      const status = result?.status || 'error';
      const messages = {
        available: tx(`New version ${result.version} found — confirm in the dialog to download.`, `发现新版本 ${result.version}，请在弹窗中确认下载。`),
        latest: tx(`Already on the latest version (v${result.version}).`, `已是最新版本（v${result.version}）。`),
        dev: tx('Update check only works in the packaged build.', '开发版本不支持自动更新，请在安装版中使用。'),
        busy: tx('An update check is already running.', '正在检查更新，请稍候。'),
        error: tx('Update check failed. Please try again later.', '检查更新失败，请稍后重试。'),
      };
      handleLog({
        time: new Date().toLocaleTimeString(),
        message: messages[status] || messages.error,
        type: status === 'error' ? 'error' : 'info',
      });
    } catch (error) {
      handleLog({ time: new Date().toLocaleTimeString(), message: tx(`Update check failed: ${error.message}`, `检查更新失败：${error.message}`), type: 'error' });
    } finally {
      setUpdateBusy(false);
    }
  };

  const refreshTaskCenter = async () => {
    try {
      const result = await window.electronAPI?.taskCenterList?.();
      if (result?.success) {
        setTaskCenterState({
          active: Array.isArray(result.active) ? result.active : [],
          history: Array.isArray(result.history) ? result.history : [],
        });
      }
    } catch {}
  };

  const refreshCacheCenter = async () => {
    setCacheCenterBusy(true);
    try {
      const result = await window.electronAPI?.cacheCenterSummary?.();
      if (result?.success) {
        setCacheCenterState({ namespaces: result.namespaces || [], roots: result.roots || null });
      }
    } finally {
      setCacheCenterBusy(false);
    }
  };

  const handleRefreshOpsCenter = async () => {
    await Promise.all([refreshTaskCenter(), refreshCacheCenter()]);
  };

  const handleClearCacheNamespace = async (namespace) => {
    if (!namespace) return;
    setClearingNamespace(namespace);
    try {
      await window.electronAPI?.cacheCenterClear?.(namespace);
      await refreshCacheCenter();
    } finally {
      setClearingNamespace('');
    }
  };

  const handleClearTaskHistory = async () => {
    setCacheCenterBusy(true);
    try {
      const result = await window.electronAPI?.taskCenterClearHistory?.();
      if (result?.success) {
        setTaskCenterState({
          active: Array.isArray(result.active) ? result.active : [],
          history: Array.isArray(result.history) ? result.history : [],
        });
      } else {
        await refreshTaskCenter();
      }
    } finally {
      setCacheCenterBusy(false);
    }
  };

  const handleClearAllOpsData = async () => {
    setClearingNamespace('__all__');
    setCacheCenterBusy(true);
    try {
      const result = await window.electronAPI?.cacheCenterClearAll?.();
      if (result?.success) {
        setTaskCenterState({
          active: Array.isArray(result.active) ? result.active : [],
          history: Array.isArray(result.history) ? result.history : [],
        });
      } else {
        await refreshTaskCenter();
      }
      await refreshCacheCenter();
    } finally {
      setClearingNamespace('');
      setCacheCenterBusy(false);
    }
  };

  useEffect(() => {
    document.documentElement.dataset.theme = 'dark';
    document.body.dataset.theme = 'dark';
  }, []);

  useEffect(() => {
    let cancelled = false;
    const initializeApp = async () => {
      try {
        if (window.electronAPI?.loadLLMConfig) {
          const [loadedConfig, systemStatus, nextLicenseStatus] = await Promise.all([
            window.electronAPI.loadLLMConfig(),
            window.electronAPI.getSystemStatus(),
            window.electronAPI.licenseGetStatus(),
          ]);
          if (cancelled) return;
          if (loadedConfig) setSetupConfig(loadedConfig);
          if (systemStatus) setSetupDiagnostics(systemStatus);
          if (nextLicenseStatus) setLicenseStatus(nextLicenseStatus);
          if (shouldShowSetup(loadedConfig)) {
            setSetupVariant('onboarding');
            setShowSetup(true);
          }
        } else {
          if (!cancelled) {
            setLicenseStatus({
              valid: false,
              reason: 'no-electron-api',
              message: 'Electron API is not available. Please restart the app.',
            });
          }
        }
      } catch (err) {
        console.error('App initialization error:', err);
        if (!cancelled) {
          setLicenseStatus({
            valid: false,
            reason: 'init-error',
            message: err?.message || 'Initialization failed.',
          });
        }
      } finally {
        if (!cancelled) setAppReady(true);
      }
    };
    initializeApp();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    window.electronAPI?.subscribeTaskCenter?.((payload) => {
      setTaskCenterState((prev) => {
        let { active = [], history = [] } = prev;
        active = [...active];
        history = [...history];
        const task = payload?.task;
        if (!task) return prev;
        const activeIndex = active.findIndex((entry) => entry.id === task.id);
        if (payload?.type === 'started') {
          if (activeIndex >= 0) active[activeIndex] = task;
          else active.unshift(task);
        } else if (payload?.type === 'update') {
          if (activeIndex >= 0) active[activeIndex] = task;
        } else if (payload?.type === 'finished') {
          if (activeIndex >= 0) active.splice(activeIndex, 1);
          const filteredHistory = history.filter((entry) => !(entry.id === task.id && entry.updatedAt === task.updatedAt));
          filteredHistory.unshift(task);
          return { active, history: filteredHistory.slice(0, 24) };
        }
        return { active, history };
      });
    });
    return () => { window.electronAPI?.removeTaskCenterListeners?.(); };
  }, []);

  useEffect(() => {
    return subscribeLLMConfigUpdate((nextConfig) => {
      setSetupConfig(nextConfig);
    });
  }, []);

  if (!appReady || !licenseStatus) {
    return (
      <div ref={shellRef} className="app-shell setup-shell" data-active-tab={activeTab} data-theme={theme} data-platform={platform}>
        <div className="app-background" aria-hidden="true">
          <span className="bg-orb bg-orb-a" />
          <span className="bg-orb bg-orb-b" />
        </div>
        <div className="app-startup-screen" aria-hidden="true" />
      </div>
    );
  }

  if (!licenseStatus.valid) {
    return (
      <div ref={shellRef} className="app-shell setup-shell" data-active-tab={activeTab} data-theme={theme} data-platform={platform}>
        <div className="app-background" aria-hidden="true">
          <span className="bg-orb bg-orb-a" />
          <span className="bg-orb bg-orb-b" />
        </div>
        <LicenseGate
          blocking
          status={licenseStatus}
          onActivated={(nextStatus) => { setLicenseStatus(nextStatus); setShowLicenseManager(false); }}
        />
      </div>
    );
  }

  if (showSetup && setupVariant === 'onboarding') {
    return (
      <div ref={shellRef} className="app-shell setup-shell" data-active-tab={activeTab} data-theme={theme} data-platform={platform}>
        <div className="app-background" aria-hidden="true">
          <span className="bg-orb bg-orb-a" />
          <span className="bg-orb bg-orb-b" />
        </div>
        <SetupGuide
          initialConfig={setupConfig}
          systemStatus={setupDiagnostics}
          variant={setupVariant}
          onComplete={(nextConfig) => { setSetupConfig(nextConfig); setShowSetup(false); }}
          onClose={() => setShowSetup(false)}
        />
      </div>
    );
  }

  return (
    <div ref={shellRef} className="app-shell" data-active-tab={activeTab} data-theme={theme} data-platform={platform}>
      <div className="app-background" aria-hidden="true">
        <span className="bg-orb bg-orb-a" />
        <span className="bg-orb bg-orb-b" />
      </div>

      <aside className="app-sidebar">
        <button
          type="button"
          className={`brand-panel ${activeTab === 'slides' ? 'active' : ''}`}
          onClick={() => selectTab('slides')}
        >
          <div className="brand-copy">
            <BrandLogo className="brand-logo-icon" />
            <h1 style={{ fontSize: '1.35rem' }}>GS Bot</h1>
          </div>
        </button>

        <div className="sidebar-group">
          <span className="sidebar-label">{tx('Workspaces', '工作区')}</span>
          {WORKSPACE_GROUPS.map((group) => (
            <div key={group.label} className="sidebar-subgroup">
              <span className="sidebar-section-title">{group.label}</span>
              <nav className="app-nav" aria-label={group.label}>
                {group.tabs.map((tabId) => {
                  const tab = TAB_ITEMS.find((item) => item.id === tabId);
                  if (!tab) return null;
                  return (
                    <button
                      key={tab.id}
                      className={`nav-button ${activeTab === tab.id ? 'active' : ''}`}
                      onClick={() => selectTab(tab.id)}
                      style={{
                        '--tab-accent-rgb': tab.accentRgb || '168, 199, 250',
                        '--tab-accent-ink': tab.accentInk || 'var(--accent-ink)',
                      }}
                    >
                      <span className="nav-icon-shell" aria-hidden="true">
                        <AppIcon name={tab.icon} className="nav-icon" />
                      </span>
                      <span className="nav-copy">
                        <span className="nav-title">{tab.label}</span>
                        <span className="nav-meta">{tab.navMeta}</span>
                      </span>
                    </button>
                  );
                })}
              </nav>
            </div>
          ))}
        </div>

        <div className="sidebar-footer-copyright">
          <p>Copyright © 2026</p>
          <p>Jaylor Andy. All rights reserved.</p>
        </div>
      </aside>

      <section className="app-workspace">
        <div className="workspace-toolbar-top">
          <div className="workspace-toolbar-cluster">
            <button type="button" className="workspace-tool-button" onClick={() => setShowLogDrawer(true)} aria-label={tx('Logs', '日志')} title={tx('Logs', '日志')}>
              <span className="workspace-tool-icon-shell" aria-hidden="true">
                <AppIcon name="tasks" className="workspace-tool-icon" />
              </span>
              <span className="workspace-tool-label">{tx('Logs', '日志')}</span>
            </button>
            <button type="button" className="workspace-tool-button" onClick={() => { setShowTaskCenter(true); handleRefreshOpsCenter(); }}>
              <span className="workspace-tool-icon-shell" aria-hidden="true">
                <AppIcon name="tasks" className="workspace-tool-icon" />
              </span>
              <span className="workspace-tool-label">{tx('Tasks', '任务')}</span>
            </button>
            <button type="button" className="workspace-tool-button" onClick={() => setShowLicenseManager(true)}>
              <span className="workspace-tool-icon-shell" aria-hidden="true">
                <AppIcon name="license" className="workspace-tool-icon" />
              </span>
              <span className="workspace-tool-label">{tx('License', '授权')}</span>
            </button>
            <button type="button" className="workspace-tool-button" onClick={() => { setSetupVariant('manage'); setShowSetup(true); }}>
              <span className="workspace-tool-icon-shell" aria-hidden="true">
                <AppIcon name="setup" className="workspace-tool-icon" />
              </span>
              <span className="workspace-tool-label">{tx('Setup', '设置')}</span>
            </button>
            <button
              type="button"
              className="workspace-tool-button"
              onClick={handleCheckUpdates}
              disabled={updateBusy || updateDownloading}
              title={appVersion ? tx(`Check for updates (current v${appVersion})`, `检查更新（当前 v${appVersion}）`) : tx('Check for updates', '检查更新')}
            >
              <span className="workspace-tool-icon-shell" aria-hidden="true">
                <AppIcon name="update" className="workspace-tool-icon" />
              </span>
              <span className="workspace-tool-label">
                {updateDownloading
                  ? tx(`Downloading ${updatePercent}%`, `下载中 ${updatePercent}%`)
                  : updateReady
                    ? tx('Restart to update', '重启更新')
                    : updateBusy
                      ? tx('Checking…', '检查中…')
                      : tx('Update', '更新')}
              </span>
            </button>
            <button type="button" className="workspace-tool-button" onClick={() => setShowHelp(true)}>
              <span className="workspace-tool-icon-shell" aria-hidden="true">
                <AppIcon name="help" className="workspace-tool-icon" />
              </span>
              <span className="workspace-tool-label">{tx('Help', '帮助')}</span>
            </button>
          </div>
          <div className="workspace-toolbar-cluster workspace-toolbar-cluster-toggle">
            <div className="theme-toggle workspace-theme-toggle" role="group" aria-label={tx('Language', '语言')}>
              <button type="button" className={`theme-button compact ${language === 'en' ? 'active' : ''}`} onClick={() => setLanguage('en')}>EN</button>
              <button type="button" className={`theme-button compact ${language === 'zh' ? 'active' : ''}`} onClick={() => setLanguage('zh')}>中</button>
            </div>
          </div>
        </div>

        {showUpdateBanner ? (
          <div className={`update-progress-banner${updateReady ? ' is-ready' : ''}${updateStatus?.status === 'error' ? ' is-error' : ''}`} role="status" aria-live="polite">
            <div className="update-progress-head">
              <span className="update-progress-title">
                {updateReady
                  ? tx(`Update v${updateStatus?.version || ''} is ready — restart to install.`, `新版本${updateStatus?.version ? ` v${updateStatus.version}` : ''}已下载完成，重启即可安装。`)
                  : updateDownloading
                    ? tx(`Downloading update${updateStatus?.version ? ` v${updateStatus.version}` : ''}…`, `正在下载更新${updateStatus?.version ? ` v${updateStatus.version}` : ''}…`)
                    : tx(`Update failed: ${updateStatus?.message || 'unknown error'}`, `更新失败：${updateStatus?.message || '未知错误'}`)}
              </span>
              <div className="update-progress-meta">
                {updateDownloading ? <span className="update-progress-percent">{updatePercent}%</span> : null}
                {updateDownloading && (updateSizeText || updateSpeedText) ? (
                  <span className="update-progress-detail">{[updateSizeText, updateSpeedText].filter(Boolean).join('  ·  ')}</span>
                ) : null}
                <button type="button" className="update-progress-dismiss" onClick={() => setUpdateBannerDismissed(true)} aria-label={tx('Hide', '隐藏')} title={tx('Hide', '隐藏')}>×</button>
              </div>
            </div>
            {updateDownloading ? (
              <div className="update-progress-track" aria-hidden="true">
                <div className="update-progress-fill" style={{ width: `${updatePercent}%` }} />
              </div>
            ) : null}
          </div>
        ) : null}

        <main className="app-main">
          <div className="workspace-canvas">
            <ModuleHome
              tab={currentTab}
              iconNode={<AppIcon name={currentTab.icon} className="module-home__icon" />}
              fabIconNode={<AppIcon name={currentTab.icon} className="module-home__fab-icon" />}
              onLogToggle={() => setShowLogDrawer(true)}
              onLog={handleLog}
              onNavigate={selectTab}
            />
          </div>
          <div id="workspace-overlay-root" className="workspace-overlay-root" />
        </main>
      </section>

      <LogDrawer
        open={showLogDrawer}
        logs={logs}
        onClose={() => setShowLogDrawer(false)}
        accentRgb={currentTab?.accentRgb}
      />

      {showLicenseManager && (
        <LicenseGate
          status={licenseStatus}
          onActivated={(nextStatus) => { setLicenseStatus(nextStatus); setShowLicenseManager(false); }}
          onCleared={(nextStatus) => { setLicenseStatus(nextStatus); setShowLicenseManager(false); }}
          onClose={() => setShowLicenseManager(false)}
        />
      )}

      {showSetup && setupVariant === 'manage' && (
        <SetupGuide
          initialConfig={setupConfig}
          systemStatus={setupDiagnostics}
          variant={setupVariant}
          overlay
          onComplete={(nextConfig) => { setSetupConfig(nextConfig); setShowSetup(false); }}
          onClose={() => setShowSetup(false)}
        />
      )}

      {showHelp && <HelpManual onClose={() => setShowHelp(false)} />}

      <TaskCenterPanel
        open={showTaskCenter}
        tasks={taskCenterState.active}
        history={taskCenterState.history}
        cacheSummary={cacheCenterState}
        cacheBusy={cacheCenterBusy}
        clearingNamespace={clearingNamespace}
        onClose={() => setShowTaskCenter(false)}
        onRefresh={handleRefreshOpsCenter}
        onClearNamespace={handleClearCacheNamespace}
        onClearHistory={handleClearTaskHistory}
        onClearAll={handleClearAllOpsData}
      />
    </div>
  );
}

export default function App() {
  return (
    <LanguageProvider>
      <AppContent />
    </LanguageProvider>
  );
}

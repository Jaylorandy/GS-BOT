import React, { useMemo, useState } from 'react';
import { useI18n } from '../utils/i18n';
import './LicenseGate.css';

function getReasonLabel(status, tx) {
  switch (status?.reason) {
    case 'valid':
      return tx('Active', '已激活');
    case 'expired':
      return tx('Expired', '已过期');
    case 'device-mismatch':
      return tx('Wrong device', '设备不匹配');
    case 'invalid-signature':
      return tx('Invalid code', '授权码无效');
    case 'invalid-product':
      return tx('Wrong product', '产品不匹配');
    case 'missing':
      return tx('Not activated', '未激活');
    default:
      return tx('Activation required', '需要激活');
  }
}

function getStatusMessage(status, tx) {
  if (!status) {
    return tx('No license information is available yet.', '还没有可用的授权信息。');
  }

  switch (status.reason) {
    case 'valid':
      return tx(
        `Licensed until ${new Date(status.license?.expiresAt).toLocaleDateString()}.`,
        `授权有效期至 ${new Date(status.license?.expiresAt).toLocaleDateString()}。`,
      );
    case 'expired':
      return tx('This license has expired. Enter a new license code to continue.', '此授权已过期。请输入新的授权码继续。');
    case 'device-mismatch':
      return tx('This license code belongs to another installation ID.', '该授权码属于另一台设备。');
    case 'invalid-signature':
    case 'invalid-product':
    case 'invalid-format':
      return tx('The license code could not be verified.', '授权码无法通过校验。');
    case 'missing':
    default:
      return tx('Activate GS Bot with a valid license code to continue.', '请使用有效授权码激活 GS Bot 后继续。');
  }
}

function LicenseGate({
  status,
  blocking = false,
  onActivated,
  onClose,
  onCleared,
}) {
  const { tx } = useI18n();
  const [licenseKey, setLicenseKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [copied, setCopied] = useState(false);

  const statusLabel = useMemo(() => getReasonLabel(status, tx), [status, tx]);
  const statusMessage = useMemo(() => getStatusMessage(status, tx), [status, tx]);

  const handleCopyInstallationId = async () => {
    if (!status?.installationId) {
      return;
    }
    try {
      await navigator.clipboard.writeText(status.installationId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  const handleActivate = async () => {
    if (!window.electronAPI?.licenseActivate || !licenseKey.trim()) {
      return;
    }

    setBusy(true);
    setFeedback('');
    try {
      const nextStatus = await window.electronAPI.licenseActivate({ licenseKey });
      if (nextStatus?.valid) {
        setFeedback('License activated.');
        setLicenseKey('');
        onActivated?.(nextStatus);
      } else {
        setFeedback(nextStatus?.message || 'Activation failed.');
      }
    } catch (error) {
      setFeedback(error.message || 'Activation failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleClear = async () => {
    if (!window.electronAPI?.licenseClear) {
      return;
    }

    setBusy(true);
    try {
      const nextStatus = await window.electronAPI.licenseClear();
      setFeedback('Stored license removed.');
      onCleared?.(nextStatus);
    } catch (error) {
      setFeedback(error.message || 'Could not clear the stored license.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`license-shell ${blocking ? 'blocking' : 'modal'}`}>
      <div className="license-card">
        <div className="license-header">
          <div>
            <span className="license-kicker">{tx('License', '授权')}</span>
            <h2>{blocking ? tx('Activate GS Bot', '激活 GS Bot') : tx('License Center', '授权中心')}</h2>
            <p>{statusMessage}</p>
          </div>
          <div className={`license-state license-${status?.valid ? 'valid' : 'invalid'}`}>
            {statusLabel}
          </div>
        </div>

        <div className="license-summary-grid">
          <div className="license-summary-card">
            <span className="license-summary-label">{tx('Installation ID', '安装 ID')}</span>
            <code>{status?.installationId || tx('Unavailable', '不可用')}</code>
            <button type="button" className="license-inline-button" onClick={handleCopyInstallationId}>
              {copied ? tx('Copied', '已复制') : tx('Copy', '复制')}
            </button>
          </div>
          <div className="license-summary-card">
            <span className="license-summary-label">{tx('Customer', '客户')}</span>
            <strong>{status?.license?.customerName || tx('Unassigned', '未分配')}</strong>
            <span className="license-summary-meta">{status?.license?.email || tx('No email attached', '未附带邮箱')}</span>
          </div>
          <div className="license-summary-card">
            <span className="license-summary-label">{tx('Expires', '到期时间')}</span>
            <strong>{status?.license?.expiresAt ? new Date(status.license.expiresAt).toLocaleDateString() : '—'}</strong>
            <span className="license-summary-meta">
              {status?.valid ? tx(`${status.daysRemaining || 0} day(s) remaining`, `剩余 ${status.daysRemaining || 0} 天`) : tx('One year per license by default', '默认每个授权一年')}
            </span>
          </div>
        </div>

        <div className="license-note">
          {tx('Share the installation ID with your admin only if you want to generate a device-bound license.', '仅当你想生成绑定设备的授权时，才需要把安装 ID 发给管理员。')}
        </div>

        <div className="license-form">
          <label htmlFor="license-key-input">{tx('License code', '授权码')}</label>
          <textarea
            id="license-key-input"
            value={licenseKey}
            onChange={(event) => setLicenseKey(event.target.value)}
            placeholder={tx('Paste the GSBOT1 license code here', '在这里粘贴 GSBOT1 授权码')}
            rows={5}
            spellCheck={false}
          />
        </div>

        {feedback && <div className="license-feedback">{feedback}</div>}

        <div className="license-actions">
          <button
            type="button"
            className="license-primary-button"
            onClick={handleActivate}
            disabled={busy || !licenseKey.trim()}
          >
            {busy ? tx('Activating...', '激活中...') : tx('Activate license', '激活授权')}
          </button>
          {!blocking && (
            <>
              <button
                type="button"
                className="license-secondary-button"
                onClick={handleClear}
                disabled={busy}
              >
                {tx('Clear stored license', '清除已存授权')}
              </button>
              <button
                type="button"
                className="license-secondary-button"
                onClick={onClose}
                disabled={busy}
              >
                {tx('Close', '关闭')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default LicenseGate;

import React, { useEffect, useState } from 'react';
import LabelOcrSettings from './LabelOcrSettings';
import {
  loadSharedLabelOcrProfile,
  resetSharedLabelOcrProfile,
  saveSharedLabelOcrProfile,
  subscribeSharedLabelOcrProfile,
} from '../utils/labelOcrProfileStore';
import { useI18n } from '../utils/i18n';
import './LabelOcrWorkspace.css';

export default function LabelOcrWorkspace() {
  const { tx } = useI18n();
  const [profile, setProfile] = useState(() => loadSharedLabelOcrProfile());

  useEffect(() => (
    subscribeSharedLabelOcrProfile((nextProfile) => {
      setProfile(nextProfile);
    })
  ), []);

  const handleProfileChange = (nextProfile) => {
    setProfile(saveSharedLabelOcrProfile(nextProfile));
  };

  const handleReset = () => {
    setProfile(resetSharedLabelOcrProfile());
  };

  return (
    <div className="label-ocr-workspace">
      <div className="label-ocr-layout">
        <section className="label-ocr-surface label-ocr-editor-card">
          <div className="label-ocr-toolbar">
            <div>
              <span className="label-ocr-eyebrow">{tx('Label OCR', '标签 OCR')}</span>
              <h3>{tx('OCR Label Rules', 'OCR 标签规则')}</h3>
            </div>
            <button type="button" className="secondary-button label-ocr-reset-btn" onClick={handleReset}>
              {tx('Reset to defaults', '恢复默认标签')}
            </button>
          </div>

          <LabelOcrSettings
            value={profile}
            onChange={handleProfileChange}
            tx={tx}
            showHelpText={false}
            compact
          />
        </section>
      </div>
    </div>
  );
}

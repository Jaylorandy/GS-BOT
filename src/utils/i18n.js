import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

const LANGUAGE_STORAGE_KEY = 'gsbot-ui-language';

const I18nContext = createContext({
  language: 'en',
  setLanguage: () => {},
  tx: (enText, zhText) => enText,
});

function getInitialLanguage() {
  if (typeof window === 'undefined') {
    return 'en';
  }

  try {
    const saved = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (saved === 'zh' || saved === 'en') {
      return saved;
    }
  } catch {}

  return 'en';
}

export function LanguageProvider({ children }) {
  const [language, setLanguage] = useState(getInitialLanguage);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    } catch {}

    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
    document.body.dataset.language = language;
  }, [language]);

  const value = useMemo(() => ({
    language,
    setLanguage,
    tx: (enText, zhText) => (language === 'zh' ? zhText : enText),
  }), [language]);

  return (
    <I18nContext.Provider value={value}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}


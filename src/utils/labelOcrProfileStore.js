import { createLabelOcrProfileDraft } from './labelOcrProfile';

const LABEL_OCR_PROFILE_STORAGE_KEY = 'gsbot-label-ocr-active-profile-v1';
const LABEL_OCR_PROFILE_UPDATED_EVENT = 'gsbot:label-ocr-profile-updated';

export function loadSharedLabelOcrProfile() {
  if (typeof window === 'undefined') {
    return createLabelOcrProfileDraft();
  }

  try {
    const raw = window.localStorage.getItem(LABEL_OCR_PROFILE_STORAGE_KEY);
    if (!raw) {
      return createLabelOcrProfileDraft();
    }

    return createLabelOcrProfileDraft(JSON.parse(raw));
  } catch {
    return createLabelOcrProfileDraft();
  }
}

export function saveSharedLabelOcrProfile(profile = {}) {
  const nextProfile = createLabelOcrProfileDraft(profile);

  if (typeof window === 'undefined') {
    return nextProfile;
  }

  window.localStorage.setItem(
    LABEL_OCR_PROFILE_STORAGE_KEY,
    JSON.stringify(nextProfile),
  );
  window.dispatchEvent(
    new CustomEvent(LABEL_OCR_PROFILE_UPDATED_EVENT, {
      detail: nextProfile,
    }),
  );

  return nextProfile;
}

export function resetSharedLabelOcrProfile() {
  return saveSharedLabelOcrProfile(createLabelOcrProfileDraft());
}

export function subscribeSharedLabelOcrProfile(callback) {
  if (typeof window === 'undefined' || typeof callback !== 'function') {
    return () => {};
  }

  const handler = (event) => {
    callback(createLabelOcrProfileDraft(event?.detail || {}));
  };

  window.addEventListener(LABEL_OCR_PROFILE_UPDATED_EVENT, handler);
  return () => window.removeEventListener(LABEL_OCR_PROFILE_UPDATED_EVENT, handler);
}

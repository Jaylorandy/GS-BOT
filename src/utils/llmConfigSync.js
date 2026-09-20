const LLM_CONFIG_UPDATED_EVENT = 'gsbot:llm-config-updated';

export function dispatchLLMConfigUpdate(config) {
  if (typeof window === 'undefined') {
    return;
  }

  window.dispatchEvent(
    new CustomEvent(LLM_CONFIG_UPDATED_EVENT, {
      detail: config,
    }),
  );
}

export function subscribeLLMConfigUpdate(callback) {
  if (typeof window === 'undefined' || typeof callback !== 'function') {
    return () => {};
  }

  const handler = (event) => {
    if (event?.detail) {
      callback(event.detail);
    }
  };

  window.addEventListener(LLM_CONFIG_UPDATED_EVENT, handler);
  return () => window.removeEventListener(LLM_CONFIG_UPDATED_EVENT, handler);
}

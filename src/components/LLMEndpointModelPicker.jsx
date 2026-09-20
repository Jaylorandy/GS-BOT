import React, { useCallback, useEffect, useState } from 'react';
import './LLMEndpointModelPicker.css';

// 从保存的 LLM 配置中解析 API 云端当前激活的预设（GLM/DeepSeek/…）
export function getActiveApiCloudPreset(cfg) {
  const apiCloud = cfg?.apiCloud || {};
  const preset = (apiCloud.presets || []).find((p) => p.id === apiCloud.activePresetId) || apiCloud.presets?.[0];
  return preset || null;
}

// 某端点下默认选中的模型（取已保存配置）
export function defaultModelFor(mode, cfg) {
  if (mode === 'cloud') return cfg?.cloud?.model || '';
  if (mode === 'apiCloud') return getActiveApiCloudPreset(cfg)?.model || '';
  if (mode === 'local') return cfg?.local?.model || '';
  return '';
}

// 已保存配置中的候选模型列表（离线兜底）
export function savedModelListFor(mode, cfg) {
  const uniq = (list) => Array.from(new Set((list || []).filter(Boolean)));
  if (mode === 'cloud') {
    return uniq([...(cfg?.cloud?.availableModels || []), cfg?.cloud?.model]);
  }
  if (mode === 'apiCloud') {
    const preset = getActiveApiCloudPreset(cfg);
    return uniq([...(preset?.availableModels || []), ...(preset?.fallbackModels || []), preset?.model]);
  }
  if (mode === 'local') {
    return uniq([...(cfg?.local?.installedModels || []), ...(cfg?.local?.availableModels || []), cfg?.local?.model]);
  }
  return [];
}

// 根据端点和所选模型解析实际连接参数
export function pickLlmEndpoint(mode, cfg, model = '') {
  if (mode === 'cloud') {
    return { baseUrl: cfg?.cloud?.baseUrl || '', model: model || cfg?.cloud?.model || '', apiKey: cfg?.cloud?.apiKey || '' };
  }
  if (mode === 'apiCloud') {
    const preset = getActiveApiCloudPreset(cfg);
    return { baseUrl: preset?.baseUrl || '', model: model || preset?.model || '', apiKey: preset?.apiKey || '' };
  }
  if (mode === 'local') {
    return { baseUrl: cfg?.local?.baseUrl || 'http://localhost:11434', model: model || cfg?.local?.model || '', apiKey: '' };
  }
  return {};
}

/**
 * 端点 + 具体模型名称选择器。
 *
 * props:
 *  - llmConfig: 已加载的保存配置（window.electronAPI.loadLLMConfig() 的结果）
 *  - mode: 'default' | 'local' | 'cloud' | 'apiCloud'
 *  - onModeChange(mode)
 *  - model: 当前选中的模型名称
 *  - onModelChange(model)
 *  - disabled: 任务运行中禁用
 *  - showDefaultOption: 是否显示「使用已保存设置」选项（默认 true）
 *  - labels: { endpointLabel, modelLabel } 可覆盖字段文案
 */
export default function LLMEndpointModelPicker({
  llmConfig,
  mode,
  onModeChange,
  model,
  onModelChange,
  disabled = false,
  showDefaultOption = true,
  labels = {},
}) {
  const { tx } = { tx: (en, zh) => zh }; // 组件默认中文；父组件传入的文案优先
  const [modelOptions, setModelOptions] = useState([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  const fetchModels = useCallback(async (targetMode = mode, cfg = llmConfig) => {
    if (targetMode === 'default' || !window.electronAPI?.testLLMConnection) {
      setModelOptions([]);
      return;
    }
    const endpoint = pickLlmEndpoint(targetMode, cfg);
    if (!endpoint.baseUrl) {
      setModelOptions(savedModelListFor(targetMode, cfg));
      return;
    }
    setModelsLoading(true);
    try {
      const test = await window.electronAPI.testLLMConnection(endpoint);
      if (test?.success && Array.isArray(test.models) && test.models.length > 0) {
        setModelOptions(test.models);
      } else {
        setModelOptions(savedModelListFor(targetMode, cfg));
      }
    } catch {
      setModelOptions(savedModelListFor(targetMode, cfg));
    } finally {
      setModelsLoading(false);
    }
  }, [mode, llmConfig]);

  // 端点切换 / 配置加载完成时：重置为该端点默认模型并拉取模型列表
  useEffect(() => {
    if (mode === 'default' || !llmConfig) {
      setModelOptions([]);
      return;
    }
    const def = defaultModelFor(mode, llmConfig);
    if (!model) onModelChange?.(def);
    setModelOptions(savedModelListFor(mode, llmConfig));
    fetchModels(mode, llmConfig);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, llmConfig]);

  const endpointLabel = labels.endpointLabel || 'AI Endpoint';
  const modelLabel = labels.modelLabel || 'Model';

  return (
    <div className="llemp-picker">
      <div className="llemp-row">
        <label>{endpointLabel}</label>
        <select
          className="llemp-select"
          value={mode}
          onChange={(e) => onModeChange?.(e.target.value)}
          disabled={disabled}
        >
          {showDefaultOption && (
            <option value="default">{tx('Use saved setting', '使用已保存设置')}</option>
          )}
          <option value="apiCloud">{tx('API Cloud (GLM/DeepSeek…)', 'API 云端（GLM/DeepSeek…）')}</option>
          <option value="cloud">{tx('Ollama Cloud', 'Ollama 云端')}</option>
          <option value="local">{tx('Local Ollama', '本地 Ollama')}</option>
        </select>
      </div>
      {mode !== 'default' && (
        <div className="llemp-row">
          <label>{modelLabel}</label>
          <div className="llemp-model-group">
            <select
              className="llemp-select"
              value={model}
              onChange={(e) => onModelChange?.(e.target.value)}
              disabled={disabled || modelsLoading || modelOptions.length === 0}
            >
              {modelOptions.length === 0 && (
                <option value="">
                  {modelsLoading ? tx('Loading models…', '正在获取模型列表…') : tx('No models found', '未找到模型')}
                </option>
              )}
              {model && !modelOptions.includes(model) && (
                <option value={model}>{model}</option>
              )}
              {modelOptions.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <button
              type="button"
              className="llemp-refresh"
              onClick={() => fetchModels()}
              disabled={disabled || modelsLoading}
              title={tx('Refresh model list from endpoint', '从端点刷新模型列表')}
            >
              {modelsLoading ? '…' : '⟳'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

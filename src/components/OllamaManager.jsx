import React, { useState, useEffect } from 'react';
import './OllamaManager.css';

function OllamaManager({ onModelSelect, onClose }) {
  window.electronAPI?.debugLog?.('[OllamaManager] Component rendering');
  window.electronAPI?.debugLog?.('[OllamaManager] window.electronAPI: ' + JSON.stringify(Object.keys(window.electronAPI || {})));
  
  const [installed, setInstalled] = useState(null);
  const [installedModels, setInstalledModels] = useState([]);
  const [availableModels] = useState([
    { id: 'llama3', name: 'Llama 3', size: '4.7 GB', desc: 'Meta最新开源大模型，通用能力强' },
    { id: 'llama3.1', name: 'Llama 3.1', size: '4.7 GB', desc: 'Llama 3升级版，多语言支持更好' },
    { id: 'mistral', name: 'Mistral', size: '4.1 GB', desc: '法国Mistral AI，推理能力强' },
    { id: 'mixtral', name: 'Mixtral 8x7B', size: '26 GB', desc: 'MoE架构，性能接近GPT-3.5' },
    { id: 'phi3', name: 'Phi-3', size: '2.3 GB', desc: '微软出品，小模型高性能' },
    { id: 'gemma', name: 'Gemma', size: '2.5 GB', desc: 'Google开源模型' },
    { id: 'qwen2', name: 'Qwen 2', size: '4.4 GB', desc: '阿里通义千问，中文优化好' },
    { id: 'yi', name: 'Yi', size: '4.4 GB', desc: '零一万物，中文能力强' },
  ]);
  const [serverStatus, setServerStatus] = useState('stopped');
  const [downloading, setDownloading] = useState(null);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadStatus, setDownloadStatus] = useState('');
  const [logs, setLogs] = useState([]);

  useEffect(() => {
    checkStatus();
    const interval = setInterval(checkStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  const addLog = (msg, type = 'info') => {
    setLogs(prev => [...prev.slice(-50), { time: new Date().toLocaleTimeString(), msg, type }]);
  };

  const checkStatus = async () => {
    console.log('[OllamaManager] checkStatus called');
    console.log('[OllamaManager] window.electronAPI:', window.electronAPI);
    console.log('[OllamaManager] checkOllamaStatus:', window.electronAPI?.checkOllamaStatus);
    
    if (!window.electronAPI?.checkOllamaStatus) {
      console.log('[OllamaManager] checkOllamaStatus not available');
      setInstalled(false);
      return;
    }
    
    try {
      console.log('[OllamaManager] calling checkOllamaStatus...');
      const status = await window.electronAPI.checkOllamaStatus();
      console.log('[OllamaManager] status:', JSON.stringify(status));
      setInstalled(status.installed);
      setInstalledModels(status.models || []);
      setServerStatus(status.running ? 'running' : 'stopped');
    } catch (e) {
      console.error('[OllamaManager] checkOllamaStatus error:', e);
      setInstalled(false);
    }
  };

  const handleInstallOllama = async () => {
    addLog('Installing Ollama...', 'info');
    const result = await window.electronAPI.installOllama();
    if (result.success) {
      addLog('Ollama installed successfully', 'success');
      checkStatus();
    } else {
      addLog(`Install failed: ${result.error}`, 'error');
    }
  };

  const handleStartServer = async () => {
    addLog('Starting Ollama server...', 'info');
    setServerStatus('starting');
    const result = await window.electronAPI.startOllamaServer();
    if (result.success) {
      setServerStatus('running');
      addLog('Ollama server started', 'success');
    } else {
      setServerStatus('stopped');
      addLog(`Start failed: ${result.error}`, 'error');
    }
  };

  const handleStopServer = async () => {
    addLog('Stopping Ollama server...', 'info');
    await window.electronAPI.stopOllamaServer();
    setServerStatus('stopped');
    addLog('Ollama server stopped', 'info');
  };

  const handleDownload = async (model) => {
    if (downloading) return;
    
    setDownloading(model.id);
    setDownloadProgress(0);
    setDownloadStatus('Preparing download...');
    addLog(`Downloading ${model.name}...`, 'info');

    await window.electronAPI.pullOllamaModel(model.id, (progress, status) => {
      setDownloadProgress(progress);
      setDownloadStatus(status);
    });

    setDownloading(null);
    setDownloadProgress(0);
    setDownloadStatus('');
    addLog(`${model.name} downloaded successfully`, 'success');
    checkStatus();
  };

  const handleSelectModel = (modelName) => {
    onModelSelect?.(modelName);
    onClose?.();
  };

  const handleRemoveModel = async (modelName) => {
    addLog(`Removing ${modelName}...`, 'info');
    await window.electronAPI.removeOllamaModel(modelName);
    addLog(`${modelName} removed`, 'success');
    checkStatus();
  };

  if (installed === null) {
    return (
      <div className="ollama-manager">
        <div className="manager-header">
          <h3>Ollama Model Manager</h3>
          <button className="close-btn" onClick={onClose}>×</button>
        </div>
        <div className="manager-loading">Checking Ollama status...</div>
      </div>
    );
  }

  return (
    <div className="ollama-manager">
      <div className="manager-header">
        <h3>Ollama Model Manager</h3>
        <button className="close-btn" onClick={onClose}>×</button>
      </div>

      <div className="manager-content">
        {/* Status Section */}
        <div className="status-section">
          <div className="status-row">
            <span className="status-label">Ollama:</span>
            <span className={`status-badge ${installed ? 'installed' : 'not-installed'}`}>
              {installed ? 'Installed' : 'Not Installed'}
            </span>
            {!installed && (
              <button className="action-btn small" onClick={handleInstallOllama}>
                Install
              </button>
            )}
          </div>
          
          {installed && (
            <div className="status-row">
              <span className="status-label">Server:</span>
              <span className={`status-badge ${serverStatus}`}>
                {serverStatus === 'running' ? 'Running' : serverStatus === 'starting' ? 'Starting...' : 'Stopped'}
              </span>
              {serverStatus === 'stopped' && (
                <button className="action-btn small" onClick={handleStartServer}>
                  Start
                </button>
              )}
              {serverStatus === 'running' && (
                <button className="action-btn small danger" onClick={handleStopServer}>
                  Stop
                </button>
              )}
            </div>
          )}
        </div>

        {/* Download Progress */}
        {downloading && (
          <div className="download-progress">
            <div className="progress-header">
              <span>Downloading {availableModels.find(m => m.id === downloading)?.name}</span>
              <span>{downloadProgress}%</span>
            </div>
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${downloadProgress}%` }} />
            </div>
            <div className="progress-status">{downloadStatus}</div>
          </div>
        )}

        {/* Installed Models */}
        {installed && installedModels.length > 0 && (
          <div className="models-section">
            <h4>Installed Models ({installedModels.length})</h4>
            <div className="model-list installed">
              {installedModels.map(model => (
                <div key={model} className="model-card installed">
                  <div className="model-info">
                    <span className="model-name">{model}</span>
                    <span className="model-status">Ready</span>
                  </div>
                  <div className="model-actions">
                    <button 
                      className="action-btn primary"
                      onClick={() => handleSelectModel(model)}
                      disabled={serverStatus !== 'running'}
                    >
                      Use
                    </button>
                    <button 
                      className="action-btn danger small"
                      onClick={() => handleRemoveModel(model)}
                    >
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Available Models */}
        {installed && serverStatus === 'running' && (
          <div className="models-section">
            <h4>Available Models</h4>
            <div className="model-list available">
              {availableModels
                .filter(m => !installedModels.includes(m.id) && !installedModels.includes(`${m.id}:latest`))
                .map(model => (
                  <div key={model.id} className="model-card">
                    <div className="model-info">
                      <span className="model-name">{model.name}</span>
                      <span className="model-size">{model.size}</span>
                      <span className="model-desc">{model.desc}</span>
                    </div>
                    <button 
                      className="action-btn"
                      onClick={() => handleDownload(model)}
                      disabled={downloading !== null}
                    >
                      {downloading === model.id ? 'Downloading...' : 'Download'}
                    </button>
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* Logs */}
        <div className="logs-section">
          <h4>Logs</h4>
          <div className="logs-content">
            {logs.map((log, i) => (
              <div key={i} className={`log-line ${log.type}`}>
                <span className="log-time">{log.time}</span>
                <span className="log-msg">{log.msg}</span>
              </div>
            ))}
            {logs.length === 0 && <div className="log-empty">No logs yet</div>}
          </div>
        </div>
      </div>
    </div>
  );
}

export default OllamaManager;

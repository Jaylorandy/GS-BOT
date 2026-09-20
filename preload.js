const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Zara Scraper APIs
  selectDir: () => ipcRenderer.invoke('select-dir'),
  selectFile: (opts) => ipcRenderer.invoke('select-file', opts),

  startTask: (config) => ipcRenderer.invoke('start-task', config),
  annotateExcel: (config) => ipcRenderer.invoke('annotate-excel', config),
  previewExcel: (config) => ipcRenderer.invoke('preview-excel', config),
  cancelTask: (taskType) => ipcRenderer.invoke('cancel-task', taskType),
  taskCenterList: () => ipcRenderer.invoke('task-center-list'),
  taskCenterClearHistory: () => ipcRenderer.invoke('task-center-clear-history'),
  onTaskCenterUpdate: (callback) => ipcRenderer.on('task-center-update', (_event, value) => callback(value)),
  removeTaskCenterListeners: () => {
    ipcRenderer.removeAllListeners('task-center-update');
  },
  cacheCenterSummary: () => ipcRenderer.invoke('cache-center-summary'),
  cacheCenterClear: (namespace) => ipcRenderer.invoke('cache-center-clear', namespace),
  cacheCenterClearAll: () => ipcRenderer.invoke('cache-center-clear-all'),
  onLog: (callback) => ipcRenderer.on('log', (_event, value) => callback(value)),
  onProgress: (callback) => ipcRenderer.on('progress', (_event, value) => callback(value)),
  onScraperPreview: (callback) => ipcRenderer.on('scraper-preview', (_event, value) => callback(value)),
  removeListeners: () => {
    ipcRenderer.removeAllListeners('log');
    ipcRenderer.removeAllListeners('progress');
    ipcRenderer.removeAllListeners('scraper-preview');
  },
  
  // Slides Maker APIs - 文件系统访问
  readDir: (dirPath) => ipcRenderer.invoke('read-dir', dirPath),
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  saveOrganizeInfo: (payload) => ipcRenderer.invoke('save-organize-info', payload),
  applyOrganizeReviewResults: (payload) => ipcRenderer.invoke('apply-organize-review-results', payload),
  exportOrganizeExcel: (payload) => ipcRenderer.invoke('export-organize-excel', payload),
  saveFile: (options) => ipcRenderer.invoke('save-file-dialog', options),
  generatePPT: (config) => ipcRenderer.invoke('generate-ppt', config),
  organizeStyleImages: (config) => ipcRenderer.invoke('organize-style-images', config),
  selectPdfFiles: () => ipcRenderer.invoke('select-pdf-files'),
  selectPdfFolders: () => ipcRenderer.invoke('select-pdf-folders'),
  selectPdfSources: () => ipcRenderer.invoke('select-pdf-sources'),
  resolvePdfSources: (inputPaths) => ipcRenderer.invoke('resolve-pdf-sources', inputPaths),
  squeezePDFs: (config) => ipcRenderer.invoke('squeeze-pdfs', config),
  saveSqueezedPDFs: (payload) => ipcRenderer.invoke('save-squeezed-pdfs', payload),
  getPathForDroppedFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  
  // Slides Maker 日志
  onSlidesLog: (callback) => ipcRenderer.on('slides-log', (_event, value) => callback(value)),
  onSlidesProgress: (callback) => ipcRenderer.on('slides-progress', (_event, value) => callback(value)),
  onSlidesPreview: (callback) => ipcRenderer.on('slides-progress-preview', (_event, value) => callback(value)),
  removeSlidesListeners: () => {
    ipcRenderer.removeAllListeners('slides-log');
    ipcRenderer.removeAllListeners('slides-progress');
    ipcRenderer.removeAllListeners('slides-progress-preview');
  },

  // Bestseller Analysis
  bestsellerScrape: (config) => ipcRenderer.invoke('bestseller-scrape', config),
  bestsellerAnalyze: (config) => ipcRenderer.invoke('bestseller-analyze', config),
  onBestsellerLog: (callback) => ipcRenderer.on('bestseller-log', (_event, value) => callback(value)),
  onBestsellerProgress: (callback) => ipcRenderer.on('bestseller-progress', (_event, value) => callback(value)),
  removeBestsellerListeners: () => {
    ipcRenderer.removeAllListeners('bestseller-log');
    ipcRenderer.removeAllListeners('bestseller-progress');
  },
  onPdfSqueezerLog: (callback) => ipcRenderer.on('pdf-squeezer-log', (_event, value) => callback(value)),
  onPdfSqueezerProgress: (callback) => ipcRenderer.on('pdf-squeezer-progress', (_event, value) => callback(value)),
  onPdfSqueezerItem: (callback) => ipcRenderer.on('pdf-squeezer-item', (_event, value) => callback(value)),
  removePdfSqueezerListeners: () => {
    ipcRenderer.removeAllListeners('pdf-squeezer-log');
    ipcRenderer.removeAllListeners('pdf-squeezer-progress');
    ipcRenderer.removeAllListeners('pdf-squeezer-item');
  },

  // Product Analysis APIs
  analyzeProducts: (config) => ipcRenderer.invoke('analyze-products', config),
  testLLMConnection: (config) => ipcRenderer.invoke('test-llm-connection', config),
  testCloudNativeWebSearch: (config) => ipcRenderer.invoke('test-cloud-native-web-search', config),
  selectAnalysisFile: () => ipcRenderer.invoke('select-analysis-file'),
  onAnalysisLog: (callback) => ipcRenderer.on('analysis-log', (_event, value) => callback(value)),
  onAnalysisProgress: (callback) => ipcRenderer.on('analysis-progress', (_event, value) => callback(value)),
  removeAnalysisListeners: () => {
    ipcRenderer.removeAllListeners('analysis-log');
    ipcRenderer.removeAllListeners('analysis-progress');
  },

  
  // Ollama Manager
  checkOllamaStatus: () => ipcRenderer.invoke('check-ollama-status'),
  installOllama: () => ipcRenderer.invoke('install-ollama'),
  startOllamaServer: () => ipcRenderer.invoke('start-ollama-server'),
  stopOllamaServer: () => ipcRenderer.invoke('stop-ollama-server'),
  pullOllamaModel: (modelName, callback) => {
    const channel = `pull-progress-${Date.now()}`;
    ipcRenderer.on(channel, (_event, data) => callback(data.progress, data.status));
    ipcRenderer.invoke('pull-ollama-model', { modelName, channel });
    return () => ipcRenderer.removeAllListeners(channel);
  },
  installPaddleOcrVlRuntime: (callback) => {
    const channel = `paddlevl-install-progress-${Date.now()}`;
    ipcRenderer.on(channel, (_event, data) => callback(data));
    return ipcRenderer
      .invoke('install-paddleocr-vl-runtime', { channel })
      .finally(() => ipcRenderer.removeAllListeners(channel));
  },
  removeOllamaModel: (modelName) => ipcRenderer.invoke('remove-ollama-model', modelName),

  // OCR Model Store
  ocrSyncCatalog: () => ipcRenderer.invoke('ocr-sync-catalog'),
  ocrListCatalog: () => ipcRenderer.invoke('ocr-list-catalog'),
  ocrGetModelStatus: (modelId) => ipcRenderer.invoke('ocr-get-model-status', modelId),
  ocrDownloadModel: async (modelId, callback) => {
    const channel = `ocr-model-download-${Date.now()}`;
    ipcRenderer.on(channel, (_event, data) => callback(data));
    try {
      const result = await ipcRenderer.invoke('ocr-download-model', { modelId, channel });
      return { ...result, cleanup: () => ipcRenderer.removeAllListeners(channel) };
    } catch (err) {
      ipcRenderer.removeAllListeners(channel);
      throw err;
    }
  },
  ocrDeleteModel: (modelId) => ipcRenderer.invoke('ocr-delete-model', modelId),
  ocrDetectAvailableEngines: () => ipcRenderer.invoke('ocr-detect-available-engines'),

  // Debug
  debugLog: (msg) => ipcRenderer.send('debug-log', msg),

  // LLM Configuration APIs
  loadLLMConfig: () => ipcRenderer.invoke('load-llm-config'),
  saveLLMConfig: (config) => ipcRenderer.invoke('save-llm-config', config),
  getActiveLLMConfig: () => ipcRenderer.invoke('get-active-llm-config'),
  testApiCloudConnection: (config) => ipcRenderer.invoke('test-api-cloud-connection', config),
  listLLMModels: (options) => ipcRenderer.invoke('list-llm-models', options),
  getSystemStatus: () => ipcRenderer.invoke('get-system-status'),
  licenseGetStatus: () => ipcRenderer.invoke('license-get-status'),
  licenseActivate: (payload) => ipcRenderer.invoke('license-activate', payload),
  licenseClear: () => ipcRenderer.invoke('license-clear'),
  openExternalUrl: (url) => ipcRenderer.invoke('open-external-url', url),
  openLocalPath: (targetPath) => ipcRenderer.invoke('open-local-path', targetPath),
  revealLocalPath: (targetPath) => ipcRenderer.invoke('reveal-local-path', targetPath),

  // Chat Studio
  selectChatAttachments: () => ipcRenderer.invoke('select-chat-attachments'),
  selectSkillPackage: () => ipcRenderer.invoke('select-skill-package'),
  chatListSkills: () => ipcRenderer.invoke('chat-list-skills'),
  chatInstallSkill: (payload) => ipcRenderer.invoke('chat-install-skill', payload),
  chatSendMessage: (payload) => ipcRenderer.invoke('chat-send-message', payload),
  chatExportMessage: (payload) => ipcRenderer.invoke('chat-export-message', payload),

  // Local RAG / Knowledge Base
  selectRagFolder: () => ipcRenderer.invoke('select-rag-folder'),
  selectRagFiles: () => ipcRenderer.invoke('select-rag-files'),
  ragListCollections: () => ipcRenderer.invoke('rag-list-collections'),
  ragGetCollection: (collectionId) => ipcRenderer.invoke('rag-get-collection', collectionId),
  ragCreateCollection: (payload) => ipcRenderer.invoke('rag-create-collection', payload),
  ragDeleteCollection: (collectionId) => ipcRenderer.invoke('rag-delete-collection', collectionId),
  ragBindFolder: (payload) => ipcRenderer.invoke('rag-bind-folder', payload),
  ragImportFiles: (payload) => ipcRenderer.invoke('rag-import-files', payload),
  ragRemoveSource: (payload) => ipcRenderer.invoke('rag-remove-source', payload),
  ragSaveSettings: (payload) => ipcRenderer.invoke('rag-save-settings', payload),
  ragSyncCollection: (payload) => ipcRenderer.invoke('rag-sync-collection', payload),
  ragProbeModel: (payload) => ipcRenderer.invoke('rag-probe-model', payload),
  onRagLog: (callback) => ipcRenderer.on('rag-log', (_event, value) => callback(value)),
  onRagProgress: (callback) => ipcRenderer.on('rag-progress', (_event, value) => callback(value)),
  removeRagListeners: () => {
    ipcRenderer.removeAllListeners('rag-log');
    ipcRenderer.removeAllListeners('rag-progress');
  },

  // Firecrawl Configuration
  firecrawlGetConfig: () => ipcRenderer.invoke('firecrawl-get-config'),
  firecrawlSaveConfig: (apiKey) => ipcRenderer.invoke('firecrawl-save-config', apiKey),
  firecrawlGetMode: () => ipcRenderer.invoke('firecrawl-get-mode'),
  firecrawlSetMode: (mode) => ipcRenderer.invoke('firecrawl-set-mode', mode),

  // PaddleOCR API Configuration
  paddleOcrGetConfig: () => ipcRenderer.invoke('paddleOcrGetConfig'),
  paddleOcrSaveConfig: (token, options) => ipcRenderer.invoke('paddleOcrSaveConfig', token, options),
  paddleOcrTestConnection: (token) => ipcRenderer.invoke('paddleOcrTestConnection', token),
});

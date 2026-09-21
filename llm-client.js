/**
 * Ollama / OpenAI-compatible LLM Client
 * 支持 Ollama 本地模型 和 任何 OpenAI 兼容 API
 */

const http = require('http');
const https = require('https');

// Use Electron's net module when available (Chromium network stack = better Windows compatibility)
let electronNet = null;
try {
  electronNet = require('electron').net;
} catch (e) {
  // not in electron
}

function flattenContent(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (part?.text) {
          return part.text;
        }
        if (part?.type === 'image_url') {
          return '[image]';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  if (content && typeof content === 'object') {
    return content.text || content.content || '';
  }

  return '';
}

function extractChatCompletionText(data) {
  const message = data?.choices?.[0]?.message;
  const content = message?.content;

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        return part?.text || part?.content || '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  return '';
}

function extractResponsesText(data) {
  if (typeof data?.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }

  const blocks = Array.isArray(data?.output) ? data.output : [];
  const texts = [];

  for (const block of blocks) {
    if (typeof block?.text === 'string' && block.text.trim()) {
      texts.push(block.text.trim());
      continue;
    }

    if (Array.isArray(block?.content)) {
      for (const part of block.content) {
        if (typeof part?.text === 'string' && part.text.trim()) {
          texts.push(part.text.trim());
          continue;
        }

        if (typeof part?.content === 'string' && part.content.trim()) {
          texts.push(part.content.trim());
        }
      }
    }
  }

  return texts.join('\n').trim();
}

function messagesToPrompt(messages = []) {
  return messages
    .map((message) => {
      const role = message?.role || 'user';
      const content = flattenContent(message?.content);
      if (!content) {
        return '';
      }
      return `${role.toUpperCase()}: ${content}`;
    })
    .filter(Boolean)
    .join('\n\n');
}

function normalizeToolArguments(input) {
  if (!input) {
    return {};
  }

  if (typeof input === 'object') {
    return input;
  }

  if (typeof input === 'string') {
    try {
      return JSON.parse(input);
    } catch {
      return {};
    }
  }

  return {};
}

// ── Vision (image-reading) capability detection ───────────────────────────
// Name-based by necessity: Ollama's /api/tags and OpenAI's /v1/models do not
// report modality, and probing /api/show once per model is too slow for a
// dropdown refresh. These patterns cover the naming conventions of the
// multimodal families people actually run locally or via GLM/Ollama cloud.
//
// Why it matters: a text-only model (glm-4.7, qwen2.5-coder, …) does not error
// out on the image path — it silently produces plausible prose about a garment
// it never saw. The picker uses this to steer users toward vision models.
const VISION_MODEL_PATTERNS = [
  /glm[-_.]?\d+(?:\.\d+)?v/,        // GLM 视觉系: glm-4v, glm-4v-plus, glm-4.5v, glm-4.6v
  /glm[-_.]?5\.\d[-_.]?flash/,      // GLM 5.x flash 系自带视觉（2026-09-21 逐个实测）：glm-5.3-flash, glm-5.3-flashx。
                                    // ⚠️ glm-5.3 不带 flash 是纯文本（400 code 1210），别放宽成 /glm.*5\.3/
  /vision/,                          // llama3.2-vision, phi-3-vision, gpt-4-vision
  /(?:^|[-_.\d])vl(?![a-z])/,        // qwen2.5-vl, qwen2.5vl, qwen3-vl
  /llava|bakllava/,                  // llava, llava-llama3, bakllava
  /moondream/,
  /minicpm[-_.]?v/,
  /internvl/,
  /pixtral/,
  /smolvlm/,
  /cogvlm/,
  /molmo/,
  /fuyu/,
  /xcomposer/,
  /(?:^|[-_.])yi[-_.]?vl/,
  /deepseek[-_.]?vl/,
  /step[-_.]?1v/,
  /omni/,                            // qwen2.5-omni, qwen3-omni
  /gemma[-_.]?[3-9]/,                // gemma3 (4b+) and newer gemma generations ship a vision encoder
  /llama[-_.]?4/,                    // llama4 is natively multimodal
  /mistral[-_.]?small[-_.]?3[._-]?1/,
  /\b(?:gpt[-_.]?4o|gpt[-_.]?4\.1|gpt[-_.]?4v|gpt[-_.]?5|o3|o4)\b/,
  /claude[-_.]?[345]/,
  /gemini/,
];

function modelSupportsVision(modelName = '') {
  const name = String(modelName || '').trim().toLowerCase();
  if (!name) return false;
  return VISION_MODEL_PATTERNS.some((re) => re.test(name));
}

// ── Real capability probing (Ollama /api/show) ─────────────
// Ollama (local and cloud) reports true per-model capabilities:
//   POST /api/show {"model":"gemma4:31b"} → { capabilities: ["completion","vision",…] }
// Name heuristics misjudge modern families (glm-5.3-flash, kimi-k3, qwen3.5
// are vision-capable without any vision-ish token in the name), so the model
// dropdown and the vision pre-flight prefer the endpoint's real answer and
// fall back to the name heuristic only when /api/show fails.
const _visionProbeCache = new Map(); // `${baseUrl}|${model}` → true/false

async function probeOllamaVision(baseUrl, apiKey, modelName, timeoutMs = 8000) {
  const model = String(modelName || '').trim();
  const base = String(baseUrl || '').trim();
  // Only Ollama-shaped endpoints answer /api/show with capabilities. Other
  // APIs (GLM, DeepSeek…) return an error body that would parse into an
  // empty capability list and be misread as "text-only" — never probe them.
  if (!model || !base || !isOllamaLikeEndpoint(base)) return null;
  const cacheKey = `${base}|${model}`;
  if (_visionProbeCache.has(cacheKey)) return _visionProbeCache.get(cacheKey);
  try {
    const probe = new LLMClient({ baseUrl: base, model, apiKey: apiKey || '', timeoutMs });
    const data = await probe._requestJson(
      'POST',
      '/api/show',
      { model, name: model },
      apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
    );
    const caps = Array.isArray(data.capabilities)
      ? data.capabilities.map((c) => String(c).toLowerCase())
      : [];
    const hasVision = caps.includes('vision');
    _visionProbeCache.set(cacheKey, hasVision);
    return hasVision;
  } catch {
    // Do not cache failures — the endpoint may be an old Ollama without
    // capability reporting, temporarily offline, or rate-limiting.
    return null;
  }
}

// Probe a list of models in bounded batches (default 5 at a time) so a 20-model
// Ollama cloud list does not fire 20 simultaneous /api/show requests and get
// rate-limited. Returns Map name → true/false/null. Cached per endpoint+model,
// so repeat calls are free.
async function probeVisionForModels(baseUrl, apiKey, models = [], concurrency = 5) {
  const list = Array.from(new Set((models || []).filter(Boolean).map((m) => String(m))));
  const size = Math.max(1, Number(concurrency) || 5);
  const result = new Map();
  for (let i = 0; i < list.length; i += size) {
    const batch = list.slice(i, i + size);
    const entries = await Promise.all(
      batch.map((m) => probeOllamaVision(baseUrl, apiKey, m).then((v) => [m, v]))
    );
    entries.forEach(([m, v]) => result.set(m, v));
  }
  return result;
}

// Probe first, name heuristic as fallback.
async function resolveVisionSupport({ baseUrl, apiKey, model }) {
  const probed = await probeOllamaVision(baseUrl, apiKey, model);
  if (probed !== null) return probed;
  return modelSupportsVision(model);
}

// Only Ollama-shaped endpoints (local Ollama / ollama.com cloud) expose
// /api/show capabilities. OpenAI-compatible APIs (GLM, DeepSeek…) would just
// 404, so callers skip probing for them.
function isOllamaLikeEndpoint(baseUrl = '') {
  const u = String(baseUrl || '').trim().toLowerCase();
  if (!u) return false;
  if (u.includes('ollama.com')) return true;
  if (/(^|\/\/|[^.\w])(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/.test(u)) return true;
  if (u.includes(':11434')) return true;
  return false;
}

// ── Default model picking ──────────────────────────────────
// Feature wizards only carry a single "AI on/off" switch; the concrete model is
// whatever the settings page has configured. When that is empty, these helpers
// pick a sensible default from the models the endpoint actually serves:
//   * cloud / apiCloud (GLM etc.): the highest-versioned "flash" model, falling
//     back to the highest-versioned model overall. "glm-5.3-flash" beats
//     "glm-4.7-flash"; non-flash text models are never preferred over a flash.
//   * local: whatever is installed — first entry wins ("有哪个用哪个").
function _versionKey(name) {
  const str = String(name || '');
  // For tagged models ("qwen3-vl:235b") the tag carries the meaningful size —
  // prefer it over the small version number in the base name.
  const tag = str.includes(':') ? str.slice(str.lastIndexOf(':') + 1) : '';
  const match = (tag || str).match(/(\d+(?:\.\d+)*)/);
  return match ? match[1].split('.').map((n) => parseInt(n, 10) || 0) : [];
}

function _pickHighestVersion(list) {
  return [...list].sort((a, b) => {
    const va = _versionKey(a);
    const vb = _versionKey(b);
    const len = Math.max(va.length, vb.length);
    for (let i = 0; i < len; i += 1) {
      const diff = (va[i] || 0) - (vb[i] || 0);
      if (diff) return diff;
    }
    return String(a).localeCompare(String(b));
  }).pop() || '';
}

function pickDefaultModel(mode, models = []) {
  const list = Array.from(new Set((models || []).filter(Boolean).map((m) => String(m))));
  if (!list.length) return '';
  if (mode === 'cloud' || mode === 'apiCloud') {
    // Ollama 云端免费额度目前只覆盖 gemma4:31b（2026-09-21 逐个实测，其余全 402），
    // 默认优先锁它；列表里没有再退回「最高版本带 flash」的老规则。
    if (mode === 'cloud') {
      const free = list.find((m) => /^gemma4:31b$/i.test(m.trim()));
      if (free) return free;
    }
    const flash = list.filter((m) => /flash/i.test(m));
    return flash.length ? _pickHighestVersion(flash) : _pickHighestVersion(list);
  }
  return list[0];
}

class LLMClient {
  constructor(options = {}) {
    this.baseUrl = this._fixCommonUrlMistakes(options.baseUrl || 'http://localhost:11434');
    this.model = options.model || 'llama3';
    this.apiKey = options.apiKey || '';
    this.provider = this._normalizeProvider(options.provider);
    this.timeout = options.timeout || options.timeoutMs || 600000; // 默认10分钟
  }
  _fixCommonUrlMistakes(url) {
    const raw = String(url || '').trim();
    if (!raw) return raw;

    try {
      const parsed = new URL(raw);
      const host = String(parsed.hostname || '').toLowerCase();

      // ollama.com 是正确的 Ollama Cloud API 地址，不要修改
      if (host === 'ollama.com' || host === 'www.ollama.com') {
        return raw; // 保持原样
      }

      // 常见错误: api.ollama.com 不存在，修正为 ollama.com
      if (host === 'api.ollama.com') {
        console.warn('[LLMClient] api.ollama.com does not exist — auto-correcting to ollama.com');
        return `${parsed.protocol}//ollama.com${parsed.port ? ':' + parsed.port : ''}${parsed.pathname}`;
      }

      // OpenAI 官方 API: 如果用户填了 openai.com 但没带 /v1，自动补全
      if (host === 'api.openai.com' && !parsed.pathname.includes('/v1')) {
        const corrected = `${parsed.protocol}//${parsed.host}/v1`;
        console.warn(`[LLMClient] Auto-appended /v1 to ${raw} → ${corrected}`);
        return corrected;
      }
    } catch {
      // 不是合法URL，原样返回让后续逻辑处理
    }

    return raw;
  }

  _normalizeProvider(provider = 'auto') {
    const normalized = String(provider || 'auto').trim().toLowerCase();

    if (normalized === 'ollama') {
      return 'ollama';
    }

    if (normalized === 'cloud' || normalized === 'openai' || normalized === 'openai-compatible') {
      return 'openai';
    }

    return 'auto';
  }

  _looksLikeLocalOllamaBaseUrl() {
    try {
      const parsed = new URL(this.baseUrl);
      const hostname = String(parsed.hostname || '').toLowerCase();
      const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
      return (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') && port === '11434';
    } catch {
      return false;
    }
  }

  // Ollama Cloud (https://ollama.com) uses the native Ollama API (/api/chat,
  // /api/generate), NOT the OpenAI-compatible /v1/chat/completions surface.
  _isOllamaCloudBaseUrl() {
    try {
      const parsed = new URL(this.baseUrl);
      const hostname = String(parsed.hostname || '').toLowerCase();
      return hostname === 'ollama.com' || hostname === 'www.ollama.com';
    } catch {
      return false;
    }
  }

  _formatConnectionHint(errorMessage = '') {
    const rawMessage = String(errorMessage || '').trim();
    const message = rawMessage.replace(/^Network error:\s*/i, '');
    const baseUrl = String(this.baseUrl || '');

    // 如果消息为空，提供默认诊断信息
    if (!message) {
      return `Connection error (empty response). Check that the service is running and reachable at ${baseUrl || '(unknown URL)'}. Verify the base URL, port, and network connectivity.`;
    }

    try {
      const parsed = new URL(baseUrl);
      const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');

      if (port === '1134') {
        return `Network error: ${message}. The Ollama default port is usually 11434, not 1134. Try ${parsed.protocol}//${parsed.hostname}:11434`;
      }

      if (/ETIMEDOUT|ECONNREFUSED|fetch failed|socket hang up|Network error/i.test(message)) {
        return `Network error: ${message}. Check that Ollama is running and reachable at ${baseUrl}. If this is a remote Ollama server, confirm the machine IP, port 11434, and firewall settings.`;
      }
    } catch {
      if (/ETIMEDOUT|ECONNREFUSED|fetch failed|socket hang up|Network error/i.test(message)) {
        return `Network error: ${message}. Check the Ollama URL format. A common local address is http://localhost:11434`;
      }
    }

    return message;
  }

  /**
   * 测试连接
   */
  async testConnection() {
    const attemptOllamaFirst = this.provider === 'ollama'
      || (this.provider === 'auto' && (this._looksLikeLocalOllamaBaseUrl() || this._isOllamaCloudBaseUrl()));
    const authHeaders = this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {};
    const attempts = attemptOllamaFirst
      ? [
        async () => {
          const response = await this._request('GET', '/api/tags', null, authHeaders);
          const data = JSON.parse(response);
          return { success: true, models: (data.models || []).map((m) => m.name || m.model) };
        },
        async () => {
          const response = await this._request('GET', 'models', null, authHeaders);
          const data = JSON.parse(response);
          return { success: true, models: (data.data || []).map((m) => m.id) };
        },
      ]
      : [
        async () => {
          const response = await this._request('GET', 'models', null, authHeaders);
          const data = JSON.parse(response);
          return { success: true, models: (data.data || []).map((m) => m.id) };
        },
        async () => {
          const response = await this._request('GET', '/api/tags', null, authHeaders);
          const data = JSON.parse(response);
          return { success: true, models: (data.models || []).map((m) => m.name || m.model) };
        },
      ];

    const errors = [];
    try {
      for (const attempt of attempts) {
        try {
          return await attempt();
        } catch (error) {
          errors.push(error);
        }
      }
    } catch (error) {
      errors.push(error);
    }

    const lastError = errors[errors.length - 1];
    if (lastError) {
      console.error('[LLMClient] Connection test failed:', lastError.message);
    }
    return { success: false, error: this._formatConnectionHint(lastError?.message || 'Connection failed.') };
  }

  /**
   * 获取可用模型列表
   */
  _describeHttpError(statusCode, body) {
    const raw = `HTTP ${statusCode}: ${String(body || '').substring(0, 200)}`;
    const text = String(body || '');
    const isOllamaHost = /ollama\.com/i.test(String(this.baseUrl || ''));
    // Ollama 云端 402 = 免费额度不含该模型（2026-09-21 实测）。
    // 401 + {"error":"Unauthorized"} 在 key 本身有效时也可能就是同一道付费墙。
    if (statusCode === 402 || /not included in your free usage/i.test(text)) {
      return `付费模型：当前 Ollama 账号的免费额度不包含该模型，请到 ollama.com/settings 购买用量，或 ollama.com/upgrade 升级付费以解锁（原始错误: ${text.substring(0, 140)}）`;
    }
    if (isOllamaHost && statusCode === 401 && /unauthorized/i.test(text)) {
      return `Ollama 云端拒绝访问（401）：API Key 可能失效；若 Key 有效，则是免费额度不包含该模型 —— 请到 ollama.com/settings 购买用量或 ollama.com/upgrade 升级付费以解锁，或在设置里改用免费模型（如 gemma4:31b）（原始错误: ${text.substring(0, 140)}）`;
    }
    return raw;
  }

  supportsVision() {
    return modelSupportsVision(this.model);
  }

  /**
   * Ask the endpoint for this model's real vision capability (Ollama
   * /api/show). Returns true/false, or null when the endpoint cannot answer
   * (caller falls back to supportsVision()'s name heuristic).
   */
  probeVision() {
    return probeOllamaVision(this.baseUrl, this.apiKey, this.model);
  }

  supportsTools() {
    const m = (this.model || '').toLowerCase();
    if (!m) {
      return false;
    }

    const isQwenVl = m.includes('qwen') && m.includes('-vl');
    const isGlmVision = m.includes('glm-4v') || /glm[-_.]?\d+(\.\d+)?v\b/.test(m);
    const isVisionFirstModel =
      m.includes('vision')
      || m.includes('llava')
      || m.includes('minicpm')
      || isQwenVl
      || isGlmVision
      || m.includes('moondream');

    if (isVisionFirstModel) {
      return false;
    }

    return /(qwen|llama|mistral|deepseek|gemma|glm|devstral|ministral|nemotron|cogito|minimax|gpt-oss|kimi)/.test(m);
  }

  async listModels() {
    const result = await this.testConnection();
    return result.success ? result.models : [];
  }

  isOllamaLike() {
    if (this.provider === 'ollama') {
      return true;
    }

    if (this.provider === 'openai') {
      return false;
    }

    // Ollama Cloud serves the native Ollama API — treat it as Ollama-like so
    // generate()/chat() use /api/generate and /api/chat instead of the
    // non-existent OpenAI-compatible chat/completions path.
    if (this._isOllamaCloudBaseUrl()) {
      return true;
    }

    return this._looksLikeLocalOllamaBaseUrl();
  }

  async _requestJson(method, path, body = null, extraHeaders = {}) {
    const response = await this._request(method, path, body, extraHeaders);
    return JSON.parse(response);
  }

  async _chatOpenAICompatible(messages, options = {}, extraBody = {}) {
    const body = {
      model: options.model || this.model,
      messages,
      temperature: options.temperature || 0.7,
      max_tokens: options.maxTokens || 1024,
      stream: true,
      ...extraBody,
    };

    // ── 思考链控制：关闭 Qwen3/GLM 等推理模型的内部思考以降低开销 ──
    const modelName = String(body.model || '').toLowerCase();
    if (modelName.includes('qwen3') || modelName.includes('qwen-3')) {
      // Qwen3: enable_thinking: false
      body.enable_thinking = false;
    } else if (modelName.includes('glm-4') || modelName.includes('glm4') || modelName.includes('glm-4.6v')) {
      // GLM-4 系列: thinking.type: "disabled"
      body.thinking = { type: 'disabled' };
    } else if (modelName.includes('deepseek-r1') || modelName.includes('deepseek-reasoning')) {
      // DeepSeek-R1: 不支持关闭思考链，但可以限制思考 token
      // 不做特殊处理，让模型自行决定
    }

    const headers = { 'Content-Type': 'application/json' };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const data = await this._requestJson('POST', 'chat/completions', body, headers);
    return extractChatCompletionText(data);
  }

  async chatRaw(messages, options = {}) {
    if (this.isOllamaLike()) {
      const body = {
        model: options.model || this.model,
        messages,
        stream: false,
        options: {
          temperature: options.temperature || 0.7,
          num_predict: options.maxTokens || 1024,
          think: Boolean(options.think),
        },
      };

      if (Array.isArray(options.tools) && options.tools.length > 0) {
        body.tools = options.tools;
      }

      const headers = {};
      if (this.apiKey) {
        headers.Authorization = `Bearer ${this.apiKey}`;
      }

      return this._requestJson('POST', '/api/chat', body, headers);
    }

    const body = {
      model: options.model || this.model,
      messages,
      temperature: options.temperature || 0.7,
      max_tokens: options.maxTokens || 1024,
      stream: false,
    };

    if (Array.isArray(options.tools) && options.tools.length > 0) {
      body.tools = options.tools;
      body.tool_choice = options.toolChoice || 'auto';
    }

    const headers = { 'Content-Type': 'application/json' };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    return this._requestJson('POST', 'chat/completions', body, headers);
  }

  async webSearch(query, options = {}) {
    const normalizedQuery = String(query || '').trim();
    if (!normalizedQuery) {
      return { results: [] };
    }

    return this._requestJson(
      'POST',
      '/api/web_search',
      {
        query: normalizedQuery,
        max_results: Math.max(1, Math.min(Number(options.maxResults) || 5, 10)),
      },
      {
        'Content-Type': 'application/json',
        Authorization: this.apiKey ? `Bearer ${this.apiKey}` : undefined,
      },
    );
  }

  async webFetch(url) {
    const normalizedUrl = String(url || '').trim();
    if (!normalizedUrl) {
      return { title: '', content: '', links: [] };
    }

    return this._requestJson(
      'POST',
      '/api/web_fetch',
      { url: normalizedUrl },
      {
        'Content-Type': 'application/json',
        Authorization: this.apiKey ? `Bearer ${this.apiKey}` : undefined,
      },
    );
  }

  async runWebToolAgent(prompt, options = {}) {
    if (!this._looksLikeLocalOllamaBaseUrl()) {
      return { success: false, reason: 'not-local-ollama-runtime' };
    }

    const searchClient = options.searchClient;
    if (!searchClient) {
      return { success: false, reason: 'missing-search-client' };
    }

    const messages = [
      {
        role: 'system',
        content: options.systemInstruction || [
          'You are a research assistant running inside GS Bot.',
          'Use the provided web_search and web_fetch tools when current information would improve the answer.',
          'Search first, fetch the most relevant pages, then produce a concise factual research digest.',
          'Do not invent sources and do not claim to have used tools if no tool call succeeded.',
        ].join(' '),
      },
      {
        role: 'user',
        content: String(prompt || '').trim(),
      },
    ];

    const tools = [
      {
        type: 'function',
        function: {
          name: 'web_search',
          description: 'Search the web for current information.',
          parameters: {
            type: 'object',
            required: ['query'],
            properties: {
              query: { type: 'string', description: 'Search query.' },
              max_results: { type: 'integer', description: 'Maximum results to return.' },
            },
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'web_fetch',
          description: 'Fetch a web page and return its main content.',
          parameters: {
            type: 'object',
            required: ['url'],
            properties: {
              url: { type: 'string', description: 'Absolute URL to fetch.' },
            },
          },
        },
      },
    ];

    const usedTools = [];
    const maxIterations = Math.max(1, Math.min(Number(options.maxIterations) || 4, 6));
    const maxToolPayloadChars = Math.max(1200, Math.min(Number(options.maxToolPayloadChars) || 9000, 16000));

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      const response = await this.chatRaw(messages, {
        model: options.model || this.model,
        temperature: options.temperature ?? 0.2,
        maxTokens: options.maxTokens || 1200,
        think: false,
        tools,
        toolChoice: 'auto',
      });

      const assistantMessage = response?.message || response?.choices?.[0]?.message || null;
      if (!assistantMessage) {
        return { success: false, reason: 'empty-agent-response', usedTools };
      }

      messages.push(assistantMessage);

      const toolCalls = Array.isArray(assistantMessage.tool_calls) ? assistantMessage.tool_calls : [];
      if (toolCalls.length === 0) {
        return {
          success: true,
          text: flattenContent(assistantMessage.content || ''),
          usedTools,
          iterations: iteration + 1,
        };
      }

      for (const call of toolCalls.slice(0, 4)) {
        const toolName = call?.function?.name;
        const args = normalizeToolArguments(call?.function?.arguments);

        try {
          if (toolName === 'web_search') {
            const result = await searchClient.webSearch(args.query || '', {
              maxResults: args.max_results || 5,
            });
            usedTools.push('ollama-cloud-web_search');
            messages.push({
              role: 'tool',
              tool_name: 'web_search',
              content: JSON.stringify(result).slice(0, maxToolPayloadChars),
            });
            continue;
          }

          if (toolName === 'web_fetch') {
            const result = await searchClient.webFetch(args.url || '');
            usedTools.push('ollama-cloud-web_fetch');
            messages.push({
              role: 'tool',
              tool_name: 'web_fetch',
              content: JSON.stringify(result).slice(0, maxToolPayloadChars),
            });
            continue;
          }

          messages.push({
            role: 'tool',
            tool_name: toolName || 'unknown_tool',
            content: `Tool ${toolName || 'unknown'} is unavailable.`,
          });
        } catch (error) {
          messages.push({
            role: 'tool',
            tool_name: toolName || 'unknown_tool',
            content: `Tool ${toolName || 'unknown'} failed: ${error.message}`,
          });
        }
      }
    }

    return {
      success: false,
      reason: 'max-iterations-reached',
      usedTools,
    };
  }

  async researchWithNativeWeb(promptOrMessages, options = {}) {
    if (this._looksLikeLocalOllamaBaseUrl()) {
      return { success: false, reason: 'not-supported-on-local-runtime' };
    }

    const prompt = Array.isArray(promptOrMessages)
      ? messagesToPrompt(promptOrMessages)
      : String(promptOrMessages || '').trim();

    if (!prompt) {
      return { success: false, reason: 'empty-prompt' };
    }

    const model = options.model || this.model;
    const temperature = options.temperature ?? 0.2;
    const maxTokens = options.maxTokens || 1200;
    const systemInstruction = options.systemInstruction || [
      'Use the provider native web search capability if it is available.',
      'Create a compact but information-dense research brief using current web information.',
      'Include: fresh findings, source names, notable numbers or facts, and any gaps that still remain.',
      'Do not write a final polished report; provide a factual research digest for a downstream report generator.',
    ].join(' ');

    const headers = { 'Content-Type': 'application/json' };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const attempts = [
      async () => {
        const data = await this._requestJson(
          'POST',
          'responses',
          {
            model,
            input: [
              {
                role: 'system',
                content: [{ type: 'input_text', text: systemInstruction }],
              },
              {
                role: 'user',
                content: [{ type: 'input_text', text: prompt }],
              },
            ],
            tools: [{ type: 'web_search_preview' }],
            temperature,
            max_output_tokens: maxTokens,
          },
          headers,
        );

        const text = extractResponsesText(data);
        if (!text) {
          throw new Error('Native web search returned an empty response.');
        }

        return {
          success: true,
          text,
          method: 'responses:web_search_preview',
        };
      },
      async () => {
        const text = await this._chatOpenAICompatible(
          [
            { role: 'system', content: systemInstruction },
            { role: 'user', content: prompt },
          ],
          { temperature, maxTokens },
          {
            tools: [{ type: 'web_search_preview' }],
            tool_choice: 'auto',
          },
        );

        if (!text) {
          throw new Error('Native web search returned an empty response.');
        }

        return {
          success: true,
          text,
          method: 'chat:web_search_preview',
        };
      },
      async () => {
        const text = await this._chatOpenAICompatible(
          [
            { role: 'system', content: systemInstruction },
            { role: 'user', content: prompt },
          ],
          { temperature, maxTokens },
          {
            tools: [{ type: 'web_search' }],
            tool_choice: 'auto',
          },
        );

        if (!text) {
          throw new Error('Native web search returned an empty response.');
        }

        return {
          success: true,
          text,
          method: 'chat:web_search',
        };
      },
    ];

    const errors = [];
    for (const attempt of attempts) {
      try {
        return await attempt();
      } catch (error) {
        errors.push(error.message || String(error));
      }
    }

    return {
      success: false,
      reason: 'native-web-search-unavailable',
      error: errors[errors.length - 1] || 'Native web search is unavailable.',
      attempts: errors,
    };
  }

  /**
   * 生成文本（Ollama /api/generate）
   */
  async generate(prompt, options = {}) {
    if (!this.isOllamaLike()) {
      try {
        return await this.chat([{ role: 'user', content: prompt }], options);
      } catch (error) {
        if (this.provider === 'auto' && !this.apiKey) {
          console.error('[LLM] OpenAI-compatible generate fallback:', error.message);
        } else {
          throw error;
        }
      }
    }

    const body = {
      model: options.model || this.model,
      prompt: prompt,
      stream: false,
      options: {
        temperature: options.temperature || 0.7,
        num_predict: options.maxTokens || 1024,
        think: false,
      }
    };

    try {
      const response = await this._request('POST', '/api/generate', body);
      const data = JSON.parse(response);
      return data.response || '';
    } catch (err) {
      console.error('[LLM] Ollama /api/generate error:', err.message);
      // Fallback 1: Ollama /api/chat
      try {
        return await this.chat([{ role: 'user', content: prompt }], options);
      } catch (chatErr) {
        console.error('[LLM] Ollama /api/chat fallback error:', chatErr.message);
        // Fallback 2: OpenAI-compatible chat/completions (for cloud or proxy setups)
        try {
          return await this._chatOpenAICompatible(
            [{ role: 'user', content: prompt }],
            options
          );
        } catch (openaiErr) {
          console.error('[LLM] OpenAI-compatible fallback error:', openaiErr.message);
          throw chatErr;
        }
      }
    }
  }

  async generateWithImages(prompt, images = [], options = {}) {
    if (!images || images.length === 0) return this.generate(prompt, options);

    const imagePayload = images.map(img => img.data || img);
    const errors = [];

    const formatError = (err, prefix) => {
      let msg = '';
      if (err?.message) {
        msg = err.message;
      } else if (typeof err === 'string') {
        msg = err;
      } else if (err) {
        try {
          msg = JSON.stringify(err);
        } catch {
          msg = String(err);
        }
      }
      if (!msg) msg = 'Unknown error (no message)';
      return `${prefix}: ${msg}`;
    };

    // Strategy 1: Ollama /api/generate format (images as separate field)
    try {
      const body = {
        model: options.model || this.model,
        prompt: prompt,
        stream: false,
        images: imagePayload,
        options: {
          temperature: options.temperature || 0.7,
          num_predict: options.maxTokens || 1024,
          think: false,
        }
      };
      const response = await this._request('POST', '/api/generate', body);
      const data = JSON.parse(response);
      if (data.response) return data.response;
    } catch (err) {
      const errMsg = formatError(err, 'Ollama /api/generate');
      errors.push(errMsg);
      console.log('[LLM] Ollama /api/generate failed:', errMsg);
    }

    // Strategy 2: OpenAI-compatible multimodal (content array with image_url)
    try {
      const content = [{ type: 'text', text: prompt }];
      for (const img of images) {
        const data = img.data || img;
        const mime = img.mime || 'image/jpeg';
        content.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } });
      }
      const result = await this.chat([{ role: 'user', content }], options);
      if (result) return result;
    } catch (err) {
      const errMsg = formatError(err, 'OpenAI multimodal');
      errors.push(errMsg);
      console.log('[LLM] OpenAI multimodal failed:', errMsg);
    }

    // Strategy 3: Ollama /api/chat format with images array
    try {
      const body = {
        model: options.model || this.model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        images: imagePayload,
        options: {
          temperature: options.temperature || 0.7,
          num_predict: options.maxTokens || 1024,
          think: false,
        }
      };
      const response = await this._request('POST', '/api/chat', body);
      const data = JSON.parse(response);
      if (data.message?.content) return data.message.content;
    } catch (err) {
      const errMsg = formatError(err, 'Ollama /api/chat');
      errors.push(errMsg);
      console.log('[LLM] Ollama /api/chat failed:', errMsg);
    }

    // Strategy 4: Plain text chat (last resort)
    try {
      console.log('[LLM] Falling back to plain text chat (no images)');
      return await this.chat([{ role: 'user', content: prompt }], options);
    } catch (err) {
      const errMsg = formatError(err, 'Plain text');
      errors.push(errMsg);
      console.log('[LLM] Plain text failed:', errMsg);
    }

    throw new Error(`All image generation strategies failed:\n${errors.map((e, i) => `  ${i + 1}. ${e}`).join('\n')}`);
  }

  async chatWithImages(prompt, images = [], options = {}) {
    if (!images || images.length === 0) {
      return await this.chat([{ role: 'user', content: prompt }], options);
    }
    const content = [{ type: 'text', text: prompt }];
    for (const img of images) {
      const data = img.data || img;
      const mime = img.mime || 'image/jpeg';
      content.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } });
    }
    return await this.chat([{ role: 'user', content }], options);
  }

  /**
   * Chat 对话（兼容 Ollama 和 OpenAI）
   */
  async chat(messages, options = {}) {
    // 检测是否是 Ollama（通过 baseUrl 判断）
    const isOllama = this.isOllamaLike();

    if (isOllama) {
      // Ollama API 格式
      const body = {
        model: options.model || this.model,
        messages: messages,
        stream: false,
        options: {
          temperature: options.temperature || 0.7,
          num_predict: options.maxTokens || 1024,
        think: false,
        }
      };

      const headers = {};
      if (this.apiKey) {
        headers.Authorization = `Bearer ${this.apiKey}`;
      }

      try {
        const response = await this._request('POST', '/api/chat', body, headers);
        const data = JSON.parse(response);
        return data.message?.content || '';
      } catch (error) {
        console.error('[LLM] Ollama chat error:', error.message);
        throw error;
      }
    } else {
      return this._chatOpenAICompatible(messages, options, options.extraBody || {});
    }
  }

  /**
   * 为产品分析报告的特定章节生成AI分析文字
   */
  async analyzeSection(sectionName, data, context) {
    const prompts = {
      'overview': `You are a fashion industry analyst. Based on this product collection data, write a concise executive summary (3-4 sentences) covering the overall collection positioning, target market, and key characteristics.

Collection: ${context.title || 'Product Collection'}
Total products: ${data.total}
Categories: ${data.categories}
Top materials: ${data.topMaterials}
Price range: ${data.priceRange}

Write in a professional, analytical tone. Be specific with numbers.`,

      'category': `You are a fashion merchandising analyst. Analyze this category distribution and provide insights (3-4 sentences) about the collection's category strategy, any gaps, and recommendations.

Category breakdown:
${data.distribution}

Total products: ${data.total}

Focus on what the distribution reveals about the brand's strategy and target customer.`,

      'material': `You are a textile and materials expert in fashion. Analyze this material composition data and provide insights (3-4 sentences) about material choices, sustainability implications, and quality positioning.

Materials used:
${data.distribution}

Discuss material trends, sustainability, and how the choices reflect the brand's positioning.`,

      'features': `You are a fashion design analyst. Based on these design features, write a brief analysis (3-4 sentences) about the design direction, key trends, and aesthetic identity of this collection.

Top design features:
${data.distribution}

Identify the dominant design language and any notable trends.`,

      'price': `You are a retail pricing strategist. Analyze this price distribution and provide insights (3-4 sentences) about the pricing strategy, market positioning, and value proposition.

Price segments:
${data.distribution}

Total products: ${data.total}

Discuss what the pricing tells us about the target market and competitive positioning.`,

      'style': `You are a fashion trend analyst. Based on the style and fit distribution, write a brief analysis (3-4 sentences) about the collection's style direction and target customer profile.

Style distribution:
${data.styleDistribution}

Fit distribution:
${data.fitDistribution}

Identify the primary style direction and customer persona.`,

      'summary': `You are a senior fashion industry consultant. Write a comprehensive summary and recommendations section (5-7 sentences) for this product collection analysis report.

Key data:
- Total products: ${data.total}
- Categories: ${data.categories}
- Dominant material: ${data.topMaterial}
- Price positioning: ${data.pricePosition}
- Style direction: ${data.styleDirection}
- Top features: ${data.topFeatures}

Include: key strengths, potential gaps, market opportunities, and 2-3 actionable recommendations. Be specific and data-driven.`,
    };

    const prompt = prompts[sectionName];
    if (!prompt) return '';

    try {
      const result = await this.generate(prompt, { temperature: 0.7, maxTokens: 512 });
      return result.trim();
    } catch (error) {
      console.error(`LLM analysis failed for ${sectionName}:`, error.message);
      return '';
    }
  }

  /**
   * HTTP 请求 — 优先使用 Electron net（Chromium 网络栈，Windows 兼容性更好）
   */
  _request(method, path, body = null, extraHeaders = {}, redirectCount = 0) {
    return new Promise((resolve, reject) => {
      let url;
      const p = String(path || '');
      if (/^https?:\/\//i.test(p)) {
        url = new URL(p);
      } else if (p.startsWith('/')) {
        const base = new URL(this.baseUrl);
        url = new URL(p, `${base.protocol}//${base.host}`);
      } else {
        const baseStr = this.baseUrl.endsWith('/') ? this.baseUrl : this.baseUrl + '/';
        url = new URL(p, baseStr);
      }

      const headers = {
        'Content-Type': 'application/json',
        ...extraHeaders,
      };
      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }
      console.log(`[LLM] Request: method=${method} url=${url.toString()} apiKey=${this.apiKey ? `set(${this.apiKey.length}chars)` : 'NOT SET'} Authorization=${headers['Authorization'] ? `set(${headers['Authorization'].slice(0,15)}...)` : 'NOT SET'} useElectronNet=${Boolean(electronNet)}`);

      // ── Response handler (shared between net and http) ──────────────────
      const handleResponse = (res) => {
        const contentType = String(res.headers['content-type'] || '');

        // Handle redirects
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          if (redirectCount >= 5) {
            reject(new Error(`HTTP ${res.statusCode}: too many redirects`));
            return;
          }
          res.resume();
          const redirectUrl = new URL(res.headers.location, url).toString();
          const nextMethod = res.statusCode === 303 ? 'GET' : method;
          const nextBody = res.statusCode === 303 ? null : body;
          this._request(nextMethod, redirectUrl, nextBody, extraHeaders, redirectCount + 1)
            .then(resolve)
            .catch(reject);
          return;
        }

        // SSE streaming
        if (contentType.includes('text/event-stream') && res.statusCode >= 200 && res.statusCode < 300) {
          let accumulatedContent = '';
          let accumulatedToolCalls = [];
          let buffer = '';
          let modelName = '';
          let finishReason = null;

          res.on('data', chunk => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed || !trimmed.startsWith('data:')) continue;
              const dataStr = trimmed.slice(5).trim();
              if (dataStr === '[DONE]') continue;
              try {
                const evt = JSON.parse(dataStr);
                if (evt.model) modelName = evt.model;
                const choice = evt.choices && evt.choices[0];
                if (choice) {
                  const delta = choice.delta;
                  if (delta) {
                    if (typeof delta.content === 'string') accumulatedContent += delta.content;
                    if (Array.isArray(delta.tool_calls)) {
                      for (const tc of delta.tool_calls) {
                        const idx = tc.index || 0;
                        if (!accumulatedToolCalls[idx]) {
                          accumulatedToolCalls[idx] = { id: tc.id || '', type: 'function', function: { name: '', arguments: '' } };
                        }
                        if (tc.function && tc.function.name) accumulatedToolCalls[idx].function.name += tc.function.name;
                        if (tc.function && tc.function.arguments) accumulatedToolCalls[idx].function.arguments += tc.function.arguments;
                      }
                    }
                  }
                  if (choice.finish_reason) finishReason = choice.finish_reason;
                }
              } catch { /* ignore malformed SSE lines */ }
            }
          });

          res.on('end', () => {
            const remaining = buffer.trim();
            if (remaining.startsWith('data:')) {
              const dataStr = remaining.slice(5).trim();
              if (dataStr && dataStr !== '[DONE]') {
                try {
                  const evt = JSON.parse(dataStr);
                  const choice = evt.choices && evt.choices[0];
                  if (choice && choice.delta && typeof choice.delta.content === 'string') {
                    accumulatedContent += choice.delta.content;
                  }
                } catch { /* ignore */ }
              }
            }
            const message = { role: 'assistant', content: accumulatedContent };
            const validToolCalls = accumulatedToolCalls.filter(Boolean);
            if (validToolCalls.length > 0) message.tool_calls = validToolCalls;
            const fakeResponse = {
              id: 'stream-reconstructed',
              object: 'chat.completion',
              model: modelName || this.model,
              choices: [{ index: 0, message, finish_reason: finishReason || 'stop' }],
              usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            };
            resolve(JSON.stringify(fakeResponse));
          });

          res.on('error', (err) => reject(new Error(this._formatConnectionHint(err.message))));
          return;
        }

        // Standard non-streaming
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            reject(new Error(this._describeHttpError(res.statusCode, data)));
          }
        });
      };

      // ── Dispatch: Electron net vs Node http/https ───────────────────────
      if (electronNet) {
        const options = {
          method,
          url: url.toString(),
          headers,
        };
        const req = electronNet.request(options);
        let timedOut = false;
        const timeoutTimer = setTimeout(() => {
          timedOut = true;
          try { req.abort && req.abort(); } catch (_) {}
          reject(new Error(this._formatConnectionHint(`Request timeout after ${this.timeout}ms`)));
        }, this.timeout);
        req.on('response', (res) => {
          if (timedOut) return;
          clearTimeout(timeoutTimer);
          handleResponse(res);
        });
        req.on('error', (err) => {
          if (timedOut) return;
          clearTimeout(timeoutTimer);
          reject(new Error(this._formatConnectionHint(err.message)));
        });
        if (body) req.write(JSON.stringify(body));
        req.end();
      } else {
        const isHttps = url.protocol === 'https:';
        const lib = isHttps ? https : http;
        const options = {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + url.search,
          method,
          headers,
          timeout: this.timeout,
        };
        const req = lib.request(options, handleResponse);
        req.on('error', (err) => reject(new Error(this._formatConnectionHint(err.message))));
        req.on('timeout', () => {
          req.destroy();
          reject(new Error(this._formatConnectionHint(`Request timeout after ${this.timeout}ms`)));
        });
        if (body) req.write(JSON.stringify(body));
        req.end();
      }
    });
  }
}

module.exports = LLMClient;
module.exports.modelSupportsVision = modelSupportsVision;
module.exports.pickDefaultModel = pickDefaultModel;
module.exports.probeOllamaVision = probeOllamaVision;
module.exports.probeVisionForModels = probeVisionForModels;
module.exports.resolveVisionSupport = resolveVisionSupport;
module.exports.isOllamaLikeEndpoint = isOllamaLikeEndpoint;

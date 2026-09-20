/**
 * Ollama Manager - 本地模型管理
 */

const { spawn, exec, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const OLLAMA_API_URL = 'http://127.0.0.1:11434';

// ── 找到 ollama 可执行文件 ──────────────────────
function findOllama() {
  const candidates = process.platform === 'win32'
    ? [
        path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe'),
        path.join(process.env.LOCALAPPDATA || '', 'Ollama', 'ollama.exe'),
        path.join(process.env.PROGRAMFILES || '', 'Ollama', 'ollama.exe'),
        path.join(process.env['PROGRAMFILES(X86)'] || '', 'Ollama', 'ollama.exe'),
      ]
    : [
        '/usr/local/bin/ollama',
        '/opt/homebrew/bin/ollama',
        path.join(os.homedir(), '.ollama', 'bin', 'ollama'),
        '/usr/bin/ollama',
      ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  // 最后尝试 PATH
  try {
    const lookupCommand = process.platform === 'win32' ? 'where.exe ollama' : 'which ollama';
    const result = execSync(lookupCommand, { encoding: 'utf8', timeout: 5000 });
    const found = result
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (found && fs.existsSync(found)) return found;
  } catch {}
  return null;
}

// ── 检查是否已安装 ─────────────────────────────
function checkOllamaInstalled() {
  return Promise.resolve(findOllama() !== null);
}

// ── 检查服务是否运行（用HTTP请求，不依赖curl）──
function checkServerRunning() {
  return new Promise((resolve) => {
    const req = http.get(`${OLLAMA_API_URL}/api/tags`, { timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(true));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function stripTerminalNoise(text = '') {
  return String(text || '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, '')
    .replace(/\r/g, '')
    .trim();
}

function fetchInstalledModelsFromApi() {
  return new Promise((resolve) => {
    const req = http.get(`${OLLAMA_API_URL}/api/tags`, { timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk.toString();
      });
      res.on('end', () => {
        try {
          const payload = JSON.parse(data);
          const models = Array.isArray(payload?.models)
            ? payload.models
                .map((item) => item?.model || item?.name || '')
                .map((name) => String(name || '').trim())
                .filter(Boolean)
            : [];
          resolve(models);
        } catch {
          resolve([]);
        }
      });
    });

    req.on('error', () => resolve([]));
    req.on('timeout', () => {
      req.destroy();
      resolve([]);
    });
  });
}

function resolveModelAlias(modelName, installedModels = []) {
  const wanted = String(modelName || '').trim().toLowerCase();
  if (!wanted || installedModels.length === 0) {
    return modelName;
  }

  const exact = installedModels.find((name) => String(name || '').trim().toLowerCase() === wanted);
  if (exact) {
    return exact;
  }

  const prefix = installedModels.find((name) => String(name || '').trim().toLowerCase().startsWith(`${wanted}-`));
  if (prefix) {
    return prefix;
  }

  const wantedFamily = wanted.split(':')[0];
  const familyMatches = installedModels.filter((name) => String(name || '').trim().toLowerCase().startsWith(`${wantedFamily}:`));

  if (familyMatches.length === 1) {
    return familyMatches[0];
  }

  const basePrefix = installedModels.find((name) => {
    const normalized = String(name || '').trim().toLowerCase();
    return normalized.startsWith(wanted) || wanted.startsWith(normalized);
  });

  return basePrefix || modelName;
}

// ── 获取已安装的模型列表 ────────────────────────
async function getInstalledModels() {
  const apiModels = await fetchInstalledModelsFromApi();
  if (apiModels.length > 0) {
    return apiModels;
  }

  return new Promise((resolve) => {
    const ollamaPath = findOllama();
    if (!ollamaPath) { resolve([]); return; }

    const proc = spawn(ollamaPath, ['list']);
    let output = '';
    proc.stdout.on('data', d => output += d.toString());
    proc.stderr.on('data', () => {});
    proc.on('error', () => resolve([]));
    proc.on('close', (code) => {
      if (code !== 0) { resolve([]); return; }
      const models = output.split('\n')
        .slice(1)
        .filter(l => l.trim())
        .map(l => l.trim().split(/\s+/)[0])
        .filter(Boolean);
      resolve(models);
    });
  });
}

// ── 下载模型 ───────────────────────────────────
function pullModel(modelName, onProgress, onComplete, onError) {
  const ollamaPath = findOllama();
  if (!ollamaPath) { onError?.('Ollama not found'); return null; }

  const proc = spawn(ollamaPath, ['pull', modelName]);
  let lastPercent = 0;

  proc.stdout.on('data', (data) => {
    const text = data.toString();
    // 匹配百分比
    const pctMatch = text.match(/(\d+)%/);
    if (pctMatch) {
      lastPercent = parseInt(pctMatch[1]);
      onProgress?.(lastPercent, text.trim());
    } else if (text.trim()) {
      onProgress?.(lastPercent, text.trim());
    }
  });

  proc.stderr.on('data', (data) => {
    const text = data.toString();
    // ollama pull 的进度信息有时走 stderr
    const pctMatch = text.match(/(\d+)%/);
    if (pctMatch) {
      lastPercent = parseInt(pctMatch[1]);
      onProgress?.(lastPercent, text.trim());
    } else if (text.trim()) {
      onProgress?.(lastPercent, text.trim());
    }
  });

  proc.on('error', (err) => onError?.(err.message));
  proc.on('close', (code) => {
    if (code === 0) onComplete?.();
    else onError?.(`Exit code ${code}`);
  });

  return proc;
}

// ── 启动服务 ───────────────────────────────────
async function startOllamaServer(onReady, onError) {
  // 先检查是否已经在运行
  const running = await checkServerRunning();
  if (running) {
    onReady?.();
    return { success: true, alreadyRunning: true };
  }

  const ollamaPath = findOllama();
  if (!ollamaPath) {
    const error = 'Ollama not found';
    onError?.(error);
    return { success: false, alreadyRunning: false, error };
  }

  const proc = spawn(ollamaPath, ['serve'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  proc.unref();

  return await new Promise((resolve) => {
    let settled = false;

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(checkInterval);
      clearTimeout(timeoutId);
      resolve(result);
    };

    const checkInterval = setInterval(async () => {
      if (await checkServerRunning()) {
        onReady?.();
        finish({ success: true, process: proc, alreadyRunning: false });
      }
    }, 1000);

    const timeoutId = setTimeout(() => {
      const error = 'Timeout starting Ollama server';
      onError?.(error);
      finish({ success: false, alreadyRunning: false, error });
    }, 30000);

    proc.on('error', (error) => {
      const message = error.message || 'Failed to start Ollama server';
      onError?.(message);
      finish({ success: false, alreadyRunning: false, error: message });
    });
  });
}

// ── 停止服务 ───────────────────────────────────
function stopOllamaServer() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      const ollamaPath = findOllama();
      const processNames = new Set(['ollama.exe']);
      if (ollamaPath) {
        processNames.add(path.basename(ollamaPath));
      }

      let remaining = processNames.size;
      for (const name of processNames) {
        exec(`taskkill /IM "${name}" /F /T`, () => {
          remaining -= 1;
          if (remaining === 0) {
            resolve(true);
          }
        });
      }
      return;
    }

    exec('pkill -f "ollama serve"', () => resolve(true));
  });
}

// ── 删除模型 ───────────────────────────────────
async function removeModel(modelName) {
  const installedModels = await getInstalledModels();
  const resolvedModelName = resolveModelAlias(modelName, installedModels);

  return new Promise((resolve) => {
    const ollamaPath = findOllama();
    if (!ollamaPath) {
      resolve({ success: false, error: 'Ollama not found' });
      return;
    }

    const proc = spawn(ollamaPath, ['rm', resolvedModelName]);
    let stderr = '';

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    proc.on('error', (error) => resolve({ success: false, error: error.message }));
    proc.on('close', (code) => resolve({
      success: code === 0,
      removed: code === 0 ? resolvedModelName : '',
      error: code === 0 ? '' : (stripTerminalNoise(stderr) || `Exit code ${code}`),
    }));
  });
}

// ── 生图：通过 Ollama HTTP API 生成图片 ──────────
// Uses POST /api/generate which returns base64 image data in JSON.
// The old CLI approach (`ollama run`) hangs forever for image models
// because the CLI stays in interactive mode and never prints
// "Image saved to:" — it never exits on its own.
// imagePaths (optional) are read as base64 and passed via the API
// "images" array for image-to-image generation.
// Returns a handle with .kill() for cancellation.
function runImageModel({ model, prompt, cwd, width, height, imagePaths = [], onLog, onDone, onError }) {
  const outputDir = cwd || os.tmpdir();
  try { fs.mkdirSync(outputDir, { recursive: true }); } catch {}

  // Read reference images as base64 (API expects raw base64, no data: prefix)
  const images = (imagePaths || [])
    .filter((p) => p && fs.existsSync(p))
    .map((p) => {
      try { return fs.readFileSync(p).toString('base64'); } catch { return null; }
    })
    .filter(Boolean);

  const bodyObj = {
    model: String(model || '').trim(),
    prompt: String(prompt || '').trim(),
    stream: false,
  };

  // Image generation parameters (experimental Ollama API)
  if (width && Number.isInteger(width) && width > 0) bodyObj.width = width;
  if (height && Number.isInteger(height) && height > 0) bodyObj.height = height;

  // Reference images — only effective for multimodal vision models (e.g. llava).
  // Image generation models (z-image-turbo) currently do NOT support img2img via
  // this field, but we include it for future API compatibility.
  if (images.length > 0) bodyObj.images = images;

  const body = JSON.stringify(bodyObj);

  let aborted = false;
  let heartbeatTimer = null;
  let elapsed = 0;

  const req = http.request(`${OLLAMA_API_URL}/api/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
    timeout: 600000, // 10 min hard limit
  }, (res) => {
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      if (aborted) return;
      try {
        const json = JSON.parse(data);
        if (json.error) {
          onError?.(String(json.error));
          return;
        }
        if (!json.image) {
          onError?.('Generation finished but no image data was returned by the model.');
          return;
        }
        const buf = Buffer.from(json.image, 'base64');
        const filename = `gsbot_${Date.now()}.png`;
        const outputPath = path.join(outputDir, filename);
        fs.writeFileSync(outputPath, buf);
        onLog?.(`Saved: ${outputPath}`);
        onDone?.({ success: true, outputPath });
      } catch (err) {
        onError?.(`Failed to parse model response: ${err.message}`);
      }
    });
  });

  req.on('error', (err) => {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (!aborted) onError?.(err.message);
  });

  req.on('timeout', () => {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    if (!aborted) {
      aborted = true;
      req.destroy();
      onError?.('Image generation timed out (10 minutes).');
    }
  });

  // Heartbeat with estimated progress percentage
  // z-image-turbo typically completes in ~95s; use 120s as baseline estimate
  const ESTIMATED_TOTAL_SECS = 120;
  heartbeatTimer = setInterval(() => {
    if (!aborted) {
      elapsed += 15;
      const pct = Math.min(95, Math.round((elapsed / ESTIMATED_TOTAL_SECS) * 100));
      onLog?.(`Generating... ${elapsed}s (~${pct}%)`);
    }
  }, 15000);

  req.write(body);
  req.end();

  // Return a handle with .kill() compatible with the old spawn-based interface
  return {
    kill: () => {
      aborted = true;
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      try { req.destroy(); } catch {}
    },
  };
}

module.exports = {
  findOllama,
  checkOllamaInstalled,
  checkServerRunning,
  getInstalledModels,
  pullModel,
  startOllamaServer,
  stopOllamaServer,
  removeModel,
  runImageModel,
};

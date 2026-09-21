/**
 * Renderer-side vision-capability classifier.
 *
 * ⚠️ Keep in sync with `VISION_MODEL_PATTERNS` in `llm-client.js` (main
 * process). The main process cannot import ESM renderer code and the renderer
 * cannot import llm-client (node built-ins), so the list is duplicated by
 * design — update BOTH when adding a pattern.
 */

const VISION_MODEL_PATTERNS = [
  /glm[-_.]?\d+(?:\.\d+)?v/,        // GLM 视觉系: glm-4v, glm-4v-plus, glm-4.5v, glm-4.6v
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
  /gemma[-_.]?3/,                    // gemma3 (4b+) ships a vision encoder
  /llama[-_.]?4/,                    // llama4 is natively multimodal
  /mistral[-_.]?small[-_.]?3[._-]?1/,
  /\b(?:gpt[-_.]?4o|gpt[-_.]?4\.1|gpt[-_.]?4v|gpt[-_.]?5|o3|o4)\b/,
  /claude[-_.]?[345]/,
  /gemini/,
];

export function modelSupportsVision(modelName = '') {
  const name = String(modelName || '').trim().toLowerCase();
  if (!name) return false;
  return VISION_MODEL_PATTERNS.some((re) => re.test(name));
}

/**
 * Split a model list into vision-first groups (each sorted alphabetically),
 * matching the ordering the main process annotates onto IPC results.
 */
export function splitModelsByVision(models = []) {
  const list = Array.from(new Set((models || []).filter(Boolean).map((m) => String(m))));
  const byName = (a, b) => a.localeCompare(b);
  return {
    visionModels: list.filter((m) => modelSupportsVision(m)).sort(byName),
    otherModels: list.filter((m) => !modelSupportsVision(m)).sort(byName),
  };
}

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

/**
 * Default model pick. ⚠️ Keep in sync with `pickDefaultModel` in
 * `llm-client.js` (main process):
 *   * cloud / apiCloud (GLM etc.): highest-versioned "flash" model, falling
 *     back to the highest-versioned model overall;
 *   * local: first available model.
 */
export function pickDefaultModel(mode, models = []) {
  const list = Array.from(new Set((models || []).filter(Boolean).map((m) => String(m))));
  if (!list.length) return '';
  if (mode === 'cloud' || mode === 'apiCloud') {
    const flash = list.filter((m) => /flash/i.test(m));
    return flash.length ? _pickHighestVersion(flash) : _pickHighestVersion(list);
  }
  return list[0];
}

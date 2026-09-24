const fs = require('fs');
const path = require('path');

const LLMClient = require('./llm-client');
const llmConfigManager = require('./llm-config');

const DEFAULT_CONFIG = {
  enabled: true,
  mode: 'dual-model',
  baseUrl: 'http://localhost:11434',
  garmentModel: 'moondream:1.8b',
  fabricModel: 'gr3-fabric',
  apiKey: '',
};

function resolveApparelVisionConfig(override = {}) {
  const shared = llmConfigManager.mergeWithDefaults(llmConfigManager.loadConfig());
  return {
    ...DEFAULT_CONFIG,
    ...(shared.apparelVision || {}),
    ...(override || {}),
  };
}

function imagePayloadsFromPaths(paths = [], maxImages = 4) {
  return [...new Set((paths || []).filter(Boolean))]
    .slice(0, maxImages)
    .map((imagePath) => {
      try {
        const buffer = fs.readFileSync(imagePath);
        const ext = path.extname(imagePath).toLowerCase();
        const mime = ext === '.png'
          ? 'image/png'
          : ext === '.webp'
            ? 'image/webp'
            : 'image/jpeg';
        return {
          path: imagePath,
          mime,
          data: buffer.toString('base64'),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function extractJsonCandidate(text = '') {
  const raw = String(text || '').trim();
  if (!raw) {
    return null;
  }

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() || raw;
  const objectStart = candidate.indexOf('{');
  const objectEnd = candidate.lastIndexOf('}');
  if (objectStart === -1 || objectEnd <= objectStart) {
    return null;
  }
  return candidate.slice(objectStart, objectEnd + 1);
}

function parseJsonSafe(text = '') {
  const candidate = extractJsonCandidate(text);
  if (!candidate) {
    return null;
  }

  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
  }
  if (typeof value === 'string') {
    return [...new Set(value.split(/[,;\n]/).map((item) => item.trim()).filter(Boolean))];
  }
  return [];
}

function normalizeVisionFitLabel(value = '') {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';

  const rules = [
    ['Skinny', /\bskinny\b/],
    ['Slim', /\bslim\b/],
    ['Baggy', /\bbaggy\b/],
    ['Bootcut', /\bboot[\s-]?cut\b/],
    ['Flare', /\bflare|flared\b/],
    ['Barrel', /\bbarrel\b/],
    ['Balloon', /\bballoon\b/],
    ['Wide Leg', /\bwide[\s-]?leg|super wide|ultra wide\b/],
    ['Straight', /\bstraight|straight[\s-]?leg\b/],
    ['Tapered', /\btaper|tapered|slim taper|relaxed taper\b/],
    ['Relaxed', /\brelaxed\b/],
    ['Loose', /\bloose|baggy|easy fit\b/],
    ['Jogger', /\bjogger\b/],
    ['Boyfriend', /\bboyfriend\b/],
    ['Mom', /\bmom\b/],
    ['Dad', /\bdad\b/],
    ['Carrot', /\bcarrot\b/],
    ['Regular', /\bregular|classic\b/],
    ['Cropped', /\bcropped|crop\b/],
    ['Oversized', /\boversized|oversize\b/],
    ['Boxy', /\bboxy\b/],
  ];

  for (const [label, pattern] of rules) {
    if (pattern.test(text)) {
      return label;
    }
  }

  return String(value || '').trim();
}

function buildMergedDescription(garment = {}, fabric = {}) {
  const garmentDescription = String(garment.description || '').trim();
  const fabricDescription = String(fabric.description || '').trim();
  const detailBits = normalizeStringList(garment.details || garment.keyDetails).slice(0, 5);
  const textileBits = normalizeStringList(fabric.textileSignals || fabric.surfaceSignals || fabric.finishSignals).slice(0, 4);

  const parts = [];
  if (garmentDescription) {
    parts.push(garmentDescription);
  }
  if (fabricDescription && fabricDescription !== garmentDescription) {
    parts.push(fabricDescription);
  }
  if (!garmentDescription && detailBits.length > 0) {
    parts.push(detailBits.join(', '));
  }
  if (textileBits.length > 0) {
    parts.push(`Fabric cues: ${textileBits.join(', ')}`);
  }

  return parts.join(' ').trim();
}

function mergeApparelVisionResults(garment = {}, fabric = {}) {
  const category = String(garment.category || garment.garmentCategory || '').trim();
  const fit = normalizeVisionFitLabel(garment.fit || garment.silhouette || '');
  const productName = String(garment.productName || garment.name || '').trim();
  const details = normalizeStringList(garment.details || garment.keyDetails || garment.designDetails || garment.constructionDetails);
  const textileSignals = normalizeStringList(fabric.textileSignals || fabric.surfaceSignals || fabric.finishSignals || fabric.materialDetails);
  const fabricAppearance = String(fabric.fabricAppearance || fabric.materialRead || '').trim();

  return {
    category,
    fit,
    productName,
    details,
    textileSignals,
    fabricAppearance,
    description: buildMergedDescription(garment, fabric),
  };
}

async function runModelPass(client, prompt, payloads, options = {}) {
  const raw = await client.generateWithImages(prompt, payloads, {
    temperature: 0.1,
    maxTokens: options.maxTokens || 700,
  });
  return {
    raw,
    parsed: parseJsonSafe(raw),
  };
}

async function describeApparelImages(imagePaths = [], options = {}) {
  const emitLog = options.emitLog || (() => {});
  const config = resolveApparelVisionConfig(options.config);
  const payloads = imagePayloadsFromPaths(imagePaths, options.maxImages || 4);

  if (!config.enabled || payloads.length === 0) {
    return null;
  }

  const baseUrl = String(config.baseUrl || '').trim();
  if (!baseUrl) {
    emitLog('Apparel vision skipped: no local endpoint configured.', 'warning');
    return null;
  }

  const garmentClient = new LLMClient({
    baseUrl,
    model: config.garmentModel,
    apiKey: config.apiKey || '',
  });
  const fabricClient = new LLMClient({
    baseUrl,
    model: config.fabricModel,
    apiKey: config.apiKey || '',
  });

  const contextText = String(options.contextText || '').trim();
  const garmentPrompt = `You are a specialist apparel vision model. Review the garment images and return JSON only.

Focus on:
- garment category
- fit / silhouette
- visible design and construction details
- a complete English product name
- commercially useful short description

Naming rule (IMPORTANT):
- Build "productName" with the retailer six-part formula, one line, no commas:
  Gender + Fit + Length + Sleeve + Category + Closure
- Example: "Men's Regular-Fit Long-Sleeve Hooded Sweatshirt".
- Use English Title Case. OMIT any segment you cannot support visually — never invent one.
- "Closure" means Zip-Up / Button-Up / Pullover / Drawstring, and only when clearly visible.

Important fit guidance:
- For pants, jeans, trousers, and shorts, identify the most specific visible fit or leg shape you can support.
- Prefer detailed bottoms fit terms such as Skinny, Slim, Baggy, Straight, Tapered, Wide Leg, Barrel, Balloon, Bootcut, Flare, Relaxed, Loose, Jogger, Boyfriend, Mom, Dad, or Carrot.
- Use only one best-fit label in the "fit" field.
- If the fit is not visually supportable, leave "fit" empty instead of guessing.

Rules:
- ignore tiny hangtags and care labels attached to the garment
- do not count repeated views as new styles
- only describe what is visually evident
- be specific about visible design details such as pocket type, waistband, pleats, darts, seams, paneling, closures, hems, cuffs, yokes, topstitching, cargo details, utility details, or trim when they are visible

Return:
{
  "category": "",
  "fit": "",
  "productName": "",
  "details": ["", ""],
  "description": ""
}

Context:
${contextText || 'No extra context provided.'}`;

  const fabricPrompt = `You are a specialist fabric-reading vision model for apparel imagery. Review the same garment images and return JSON only.

Focus on:
- fabric appearance
- weave / knit / denim / twill / brushed / washed / coated / technical surface clues
- finish and texture signals
- visible material behavior such as drape, crispness, softness, rigidity, weight impression, stretch impression, shine, slub, brushing, coating, fading, whiskering, or distressing
- a short fabric-oriented note

Rules:
- do not invent fiber composition percentages
- treat the output as visual fabric cues, not confirmed lab composition
- be as specific as possible about surface, wash, texture, and finish when they are visually evident

Return:
{
  "fabricAppearance": "",
  "textileSignals": ["", ""],
  "description": ""
}

Context:
${contextText || 'No extra context provided.'}`;

  const result = {
    garment: null,
    fabric: null,
    merged: null,
  };

  try {
    emitLog(`Apparel vision: reading garment structure with ${config.garmentModel}.`, 'info');
    const garmentPass = await runModelPass(garmentClient, garmentPrompt, payloads, { maxTokens: 650 });
    result.garment = garmentPass.parsed || {
      description: String(garmentPass.raw || '').trim(),
    };
  } catch (error) {
    emitLog(`Apparel vision garment pass failed: ${error.message}`, 'warning');
  }

  try {
    emitLog(`Apparel vision: reading fabric cues with ${config.fabricModel}.`, 'info');
    const fabricPass = await runModelPass(fabricClient, fabricPrompt, payloads, { maxTokens: 550 });
    result.fabric = fabricPass.parsed || {
      description: String(fabricPass.raw || '').trim(),
    };
  } catch (error) {
    emitLog(`Apparel vision fabric pass failed: ${error.message}`, 'warning');
  }

  if (!result.garment && !result.fabric) {
    return null;
  }

  result.merged = mergeApparelVisionResults(result.garment || {}, result.fabric || {});
  return result;
}

function buildApparelVisionSummary(visionResult = null) {
  if (!visionResult?.merged) {
    return '';
  }

  const merged = visionResult.merged;
  const lines = [];
  if (merged.productName) {
    lines.push(`Suggested product name: ${merged.productName}`);
  }
  if (merged.category) {
    lines.push(`Garment category: ${merged.category}`);
  }
  if (merged.fit) {
    lines.push(`Fit / silhouette: ${merged.fit}`);
  }
  if (merged.details?.length) {
    lines.push(`Visible garment design details: ${merged.details.join(', ')}`);
  }
  if (merged.fabricAppearance) {
    lines.push(`Fabric appearance: ${merged.fabricAppearance}`);
  }
  if (merged.textileSignals?.length) {
    lines.push(`Detailed textile cues: ${merged.textileSignals.join(', ')}`);
  }
  if (merged.description) {
    lines.push(`Merged apparel note: ${merged.description}`);
  }
  return lines.join('\n');
}

module.exports = {
  buildApparelVisionSummary,
  describeApparelImages,
  resolveApparelVisionConfig,
};

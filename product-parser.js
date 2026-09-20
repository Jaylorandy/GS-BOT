/**
 * Product Analysis - 文档解析器
 * 从PDF/PPT/文件夹中提取产品数据
 */

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const pdfParse = require('pdf-parse');
const runtimeResolver = require('./runtime-resolver');
const { recognizeImageBuffer } = require('./rag-service');
const {
  extractPdfDocumentContext,
  buildPdfEmbeddedImageContext,
  buildPptxImageContext,
  buildFolderImageContext,
  renderPdfPagesWithFitz,
} = require('./product-analysis-visual-context');

function getPythonRuntime() {
  return runtimeResolver.findPythonRuntime();
}

// ── 材料词表（补全常见零售品牌面料缩写与术语） ───────
const MATERIAL_RULES = [
  { label: 'Cotton', patterns: [/\bcotton\b/i, /\bctn\b/i, /\bco\b/i, /\b\d{1,3}%\s*c\b/i] },
  { label: 'Recycled Cotton', patterns: [/\brecycled\s*c(?:otton)?\b/i, /\brcs\s+recycled\s+cotton\b/i] },
  { label: 'BCI Cotton', patterns: [/\bbci\s*c(?:otton)?\b/i, /\bbetter\s+cotton\b/i] },
  { label: 'Organic Cotton', patterns: [/\borganic\s+cotton\b/i, /\bocs\s+organic\s+cotton\b/i, /\bocs\s+cotton\b/i] },
  { label: 'Polyester', patterns: [/\bpolyester\b/i, /\bpoly\b/i, /\bpes\b/i, /\bpet\b/i, /\bpl\b/i, /\b\d{1,3}%\s*p\b/i] },
  { label: 'Recycled Polyester', patterns: [/\brecycled\s+poly(?:ester)?\b/i, /\brcs\s+recycled\s+poly(?:ester)?\b/i] },
  { label: 'Viscose', patterns: [/\bviscose\b/i, /\bvis\b/i, /\bcv\b/i, /\becovero\b/i] },
  { label: 'Rayon', patterns: [/\brayon\b/i, /\b\d{1,3}%\s*r\b/i] },
  { label: 'Lyocell', patterns: [/\blyocell\b/i, /\bcly\b/i] },
  { label: 'Tencel', patterns: [/\btencel\b/i, /\btel\b/i, /\b\d{1,3}%\s*t\b/i] },
  { label: 'Linen', patterns: [/\blinen\b/i, /\blinenw\b/i, /\bli\b/i, /\b\d{1,3}%\s*l\b/i] },
  { label: 'Elastane', patterns: [/\belastane\b/i, /\bela\b/i, /\bea\b/i] },
  { label: 'Spandex', patterns: [/\bspandex\b/i, /\bsp\b/i] },
  { label: 'Polyamide', patterns: [/\bpolyamide\b/i, /\bpa\b/i] },
  { label: 'Nylon', patterns: [/\bnylon\b/i] },
  { label: 'Wool', patterns: [/\bwool\b/i] },
  { label: 'Acrylic', patterns: [/\bacrylic\b/i] },
  { label: 'Modal', patterns: [/\bmodal\b/i] },
  { label: 'Cupro', patterns: [/\bcupro\b/i] },
  { label: 'Acetate', patterns: [/\bacetate\b/i] },
  { label: 'Ramie', patterns: [/\bramie\b/i] },
  { label: 'Leather', patterns: [/\bleather\b/i] },
  { label: 'Suede', patterns: [/\bsuede\b/i] },
  { label: 'Denim', patterns: [/\bdenim\b/i] },
  { label: 'Corduroy', patterns: [/\bcorduroy\b/i, /\bcord\b/i] },
  { label: 'Twill', patterns: [/\btwill\b/i] },
  { label: 'Flannel', patterns: [/\bflannel\b/i] },
  { label: 'Hemp', patterns: [/\bhemp\b/i] },
  { label: 'Cashmere', patterns: [/\bcashmere\b/i] },
  { label: 'Merino Wool', patterns: [/\bmerino\b/i] },
  { label: 'Polyurethane', patterns: [/\bpu\b/i, /\bpolyurethane\b/i] },
];

// ── 品类词表（尽量贴近 Zara / H&M / Bershka / Levi's / Lee / A&F / Reserved / M&S / Denham 术语） ─────
const CATEGORY_RULES = [
  { label: 'Denim', keywords: ['men’s denim', "men's denim", 'womens denim', "women's denim", 'denim collection', 'denim line', 'jeanswear', 'rigid denim', 'stretch denim', 'denim'] },
  { label: 'Jeans', keywords: ['jean', 'jeans', 'straight leg jean', 'wide leg jean', 'bootcut jean', 'flare jean', 'skinny jean', 'relaxed jean', 'mom jean', 'dad jean', 'five-pocket jean', 'carpenter jean', 'barrel jean', 'baggy jean'] },
  { label: 'Chino Pants', keywords: ['chino', 'chinos'] },
  { label: 'Cargo Pants', keywords: ['cargo pant', 'cargo pants', 'cargo trouser', 'cargo', 'utility pant', 'parachute pant'] },
  { label: 'Joggers', keywords: ['jogger', 'joggers', 'jogging pant', 'balloon jogger', 'track pant', 'trackpant'] },
  { label: 'Tailored Pants', keywords: ['tailored pant', 'tailored trouser', 'pleated trouser', 'dress pant', 'formal trouser', 'wide trouser', 'smart trouser'] },
  { label: 'Shorts', keywords: ['short', 'shorts', 'bermuda'] },
  { label: 'Overshirts', keywords: ['overshirt', 'shacket', 'shirt jacket', 'workshirt jacket'] },
  { label: 'Shirts', keywords: ['shirt', 'blouse', 'oxford', 'popover shirt', 'flannel shirt', 'western shirt', 'camp collar shirt', 'bowling shirt', 'poplin shirt'] },
  { label: 'T-Shirts', keywords: ['t-shirt', 'tshirt', 'tee', 'graphic tee', 'printed tee'] },
  { label: 'Polos', keywords: ['polo', 'polo shirt', 'rugby shirt', 'knit polo'] },
  { label: 'Knitwear', keywords: ['knitwear', 'sweater', 'jumper', 'pullover', 'cardigan', 'crewneck knit', 'funnel neck knit', 'roll neck', 'half zip knit'] },
  { label: 'Hoodies & Sweatshirts', keywords: ['hoodie', 'sweatshirt', 'crewneck sweatshirt', 'zip hoodie', 'quarter zip sweatshirt'] },
  { label: 'Blazers', keywords: ['blazer', 'tailored blazer', 'double-breasted blazer', 'oversized blazer', 'single-breasted blazer'] },
  { label: 'Jackets', keywords: ['jacket', 'denim jacket', 'trucker', 'workwear jacket', 'worker jacket', 'biker jacket', 'coach jacket', 'field jacket', 'overshirt jacket'] },
  { label: 'Outerwear', keywords: ['coat', 'parka', 'bomber', 'windbreaker', 'puffer', 'trench', 'anorak', 'outerwear', 'mac coat', 'quilted jacket'] },
  { label: 'Waistcoats & Vests', keywords: ['waistcoat', 'vest', 'gilet'] },
  { label: 'Dresses', keywords: ['dress', 'shirt dress', 'slip dress', 'maxi dress', 'mini dress'] },
  { label: 'Skirts', keywords: ['skirt', 'mini skirt', 'midi skirt', 'maxi skirt'] },
  { label: 'Jumpsuits', keywords: ['jumpsuit', 'romper', 'playsuit', 'boilersuit'] },
  { label: 'Tops', keywords: ['top', 'tank', 'camisole', 'corset', 'bodysuit', 'halter top', 'vest top', 'rib top'] },
  { label: 'Woven', keywords: ['men’s woven', "men's woven", 'mens woven', 'womens woven', "women's woven", "womens woven", 'woven collection', 'woven shirt', 'woven top', 'woven', 'woven pant', 'woven trouser'] },
  { label: 'Accessories', keywords: ['bag', 'belt', 'scarf', 'hat', 'cap', 'glove', 'sock', 'tie', 'watch', 'sunglasses'] },
  { label: 'Footwear', keywords: ['shoe', 'boot', 'sneaker', 'trainer', 'sandal', 'loafer', 'heel', 'flat', 'slipper'] },
  { label: 'Underwear', keywords: ['bra', 'brief', 'boxer', 'panty', 'lingerie', 'underwear'] },
];

const CATEGORY_KEYWORDS = CATEGORY_RULES.flatMap(({ keywords }) => keywords);

const CATEGORY_SIGNAL_RULES = [
  {
    label: 'Shirts',
    patterns: [
      /\bshirt\b/i, /\bshirting\b/i, /\bpopover\b/i, /\bwestern\b/i, /\bcamp collar\b/i,
      /\bbutton-?down\b/i, /\bplacket\b/i, /\bcuff\b/i, /\byoke\b/i, /\bchest pocket\b/i,
      /\boxford\b/i, /\bflannel shirt\b/i,
    ],
  },
  {
    label: 'Overshirts',
    patterns: [/\bovershirt\b/i, /\bshacket\b/i, /\bshirt jacket\b/i, /\bworkshirt\b/i],
  },
  {
    label: 'Jackets',
    patterns: [
      /\bjacket\b/i, /\btrucker\b/i, /\bbomber\b/i, /\bcoach jacket\b/i, /\bfield jacket\b/i,
      /\bworker jacket\b/i, /\bzip front\b/i, /\bshank button\b/i, /\bfront closure\b/i,
    ],
  },
  {
    label: 'Outerwear',
    patterns: [/\bouterwear\b/i, /\bcoat\b/i, /\bparka\b/i, /\banorak\b/i, /\bpuffer\b/i, /\btrench\b/i],
  },
  {
    label: 'Waistcoats & Vests',
    patterns: [/\bwaistcoat\b/i, /\bgilet\b/i, /\bvest\b/i, /\bsleeveless\b/i],
  },
  {
    label: 'Jeans',
    patterns: [
      /\bjeans?\b/i, /\bfive-pocket\b/i, /\b5-pocket\b/i, /\bdenim pant\b/i, /\brigid denim\b/i,
      /\bcomfort stretch denim\b/i,
    ],
  },
  {
    label: 'Cargo Pants',
    patterns: [/\bcargo\b/i, /\butility pocket\b/i, /\bparachute pant\b/i, /\bcarpenter\b/i],
  },
  {
    label: 'Joggers',
    patterns: [/\bjogger\b/i, /\btrack pant\b/i, /\belasticated waist\b/i, /\bcuffed hem\b/i],
  },
  {
    label: 'Tailored Pants',
    patterns: [
      /\btrouser\b/i, /\bpants?\b/i, /\bpleated front\b/i, /\bdrawstring waist\b/i,
      /\bwaistband\b/i, /\bleg opening\b/i, /\brise\b/i,
    ],
  },
  {
    label: 'Shorts',
    patterns: [/\bshorts?\b/i, /\bbermuda\b/i],
  },
];

const BROAD_COLLECTION_CATEGORY_LABELS = new Set(['Denim', 'Woven']);

// ── 版型词表 ────────────────────────────────
const FIT_RULES = [
  { label: 'Slim', keywords: ['slim fit', 'slim'] },
  { label: 'Regular', keywords: ['regular fit', 'regular'] },
  { label: 'Relaxed', keywords: ['relaxed fit', 'relaxed'] },
  { label: 'Oversized', keywords: ['oversized', 'oversize'] },
  { label: 'Baggy', keywords: ['baggy fit', 'baggy'] },
  { label: 'Loose', keywords: ['loose fit', 'loose', 'easy fit'] },
  { label: 'Skinny', keywords: ['skinny fit', 'skinny'] },
  { label: 'Straight', keywords: ['straight fit', 'straight leg', 'straight', 'regular straight'] },
  { label: 'Wide Leg', keywords: ['wide leg', 'wide-fit', 'wide fit'] },
  { label: 'Bootcut', keywords: ['bootcut', 'boot cut'] },
  { label: 'Flare', keywords: ['flare fit', 'flared', 'flare'] },
  { label: 'Tapered', keywords: ['tapered', 'taper', 'slim tapered', 'relaxed tapered', 'taper fit'] },
  { label: 'Cropped', keywords: ['cropped', 'crop fit'] },
  { label: 'Boxy', keywords: ['boxy'] },
  { label: 'Balloon', keywords: ['balloon fit', 'balloon'] },
  { label: 'Barrel', keywords: ['barrel fit', 'barrel', 'barrel leg'] },
  { label: 'Jogger', keywords: ['jogger', 'jogging'] },
  { label: 'Boyfriend', keywords: ['boyfriend'] },
  { label: 'Mom', keywords: ['mom fit', 'mom jean'] },
  { label: 'Dad', keywords: ['dad fit', 'dad jean'] },
  { label: 'Carrot', keywords: ['carrot fit', 'carrot'] },
  { label: 'Super Wide', keywords: ['super wide', 'ultra wide'] },
];

// ── 设计特征关键词库 ────────────────────────────
const FEATURE_KEYWORDS = [
  'collar', 'lapel', 'button', 'zip', 'zipper', 'pocket', 'cuff',
  'hem', 'pleat', 'ruffle', 'ruched', 'gathered', 'draped',
  'embroidered', 'printed', 'striped', 'checked', 'floral',
  'ribbed', 'textured', 'distressed', 'raw edge', 'turn-up',
  'drawstring', 'elastic', 'belt', 'tie', 'wrap', 'asymmetric',
  'v-neck', 'round neck', 'crew neck', 'high neck', 'mock neck',
  'hood', 'hooded', 'sleeveless', 'long sleeve', 'short sleeve',
  'patch pocket', 'welt pocket', 'cargo pocket', 'coin pocket',
  'five-pocket', 'topstitch', 'contrast stitch', 'yoke', 'placket',
  'snap button', 'metal shank', 'front closure', 'back closure',
  'elasticated waist', 'paperbag waist', 'frayed hem', 'raw hem',
  'washed', 'stonewash', 'rinse wash', 'brushed', 'coated', 'quilted'
];

const OCR_NOISE_KEYWORDS = [
  'COTTON', 'LINEN', 'NYLON', 'POLY', 'POLYESTER', 'VISCOSE', 'LYOCELL', 'MODAL',
  'SPANDEX', 'ELASTANE', 'COMPOSITION', 'CONTENT', 'WIDTH', 'WEIGHT', 'CUTTABLE',
  'FABRIC', 'ARTICLE', 'SUPPLIER', 'GSM', 'BW', 'BVW', 'OZ', 'PAGE', 'IMAGE',
  'JPG', 'JPEG', 'PNG', 'WEBP', 'HTTP', 'HTTPS', 'WWW',
];

// ── 风格关键词库 ────────────────────────────────
const STYLE_MAP = {
  'Casual': ['casual', 'relaxed', 'everyday', 'basic', 'simple'],
  'Formal': ['formal', 'tailored', 'suit', 'blazer', 'dress shirt'],
  'Streetwear': ['street', 'urban', 'graphic', 'oversized', 'hoodie', 'cargo'],
  'Minimalist': ['minimal', 'clean', 'simple', 'basic', 'plain'],
  'Functional': ['functional', 'technical', 'utility', 'cargo', 'waterproof'],
  'Bohemian': ['boho', 'floral', 'embroidered', 'flowing', 'ruffle'],
  'Sporty': ['sport', 'athletic', 'jogger', 'track', 'active'],
  'Workwear': ['workwear', 'worker', 'trucker', 'carpenter', 'utility pocket'],
  'Vintage': ['vintage', 'retro', 'stonewashed', 'washed-down', 'faded'],
  'Preppy': ['preppy', 'oxford shirt', 'rugby shirt', 'cable knit'],
};

// ── 价格段判断 ──────────────────────────────────
function classifyPrice(priceStr) {
  if (!priceStr) return 'Unknown';
  const num = parseFloat(priceStr.replace(/[^0-9.]/g, ''));
  if (isNaN(num)) return 'Unknown';
  if (num < 30) return 'Budget';
  if (num < 60) return 'Mid-Range';
  if (num < 100) return 'Premium';
  return 'High-End';
}

function uniq(items = []) {
  return [...new Set(items.filter(Boolean))];
}

function normalizeMaterialLabel(label = '') {
  const text = String(label || '').trim();
  return text
    .split(/\s+/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

// ── 从文本中提取材料 ────────────────────────────
function extractMaterials(text) {
  if (!text) return [];
  const source = String(text || '');
  const normalized = source
    .replace(/M²/gi, 'M2')
    .replace(/[|]/g, ' ')
    .replace(/\s+/g, ' ')
    .toUpperCase();

  return uniq(MATERIAL_RULES
    .filter((rule) => rule.patterns.some((pattern) => pattern.test(normalized)))
    .map((rule) => normalizeMaterialLabel(rule.label)));
}

// ── 组合面料文本 ───────────────────────────────
function buildCompositionText(composition) {
  if (!composition) return '';
  if (typeof composition === 'string') return composition.trim();
  if (typeof composition === 'object') {
    const parts = [];
    if (composition.outerShell) parts.push(`Outer: ${composition.outerShell}`);
    if (composition.lining) parts.push(`Lining: ${composition.lining}`);
    if (composition.other) parts.push(`Other: ${composition.other}`);
    return parts.join('; ');
  }
  return String(composition).trim();
}

// ── 从文本中提取面料成分描述 ────────────────────
function extractCompositionText(text) {
  if (!text) return '';
  const matches = [...text.matchAll(/\b\d{1,3}%\s*[A-Za-z][A-Za-z\s/-]*/g)];
  if (matches.length > 0) {
    return [...new Set(matches.map(m => m[0].replace(/\s+/g, ' ').trim()))].join(', ');
  }
  const outer = text.match(/outer\s*[:\-]\s*([^;.\n]+)/i);
  const lining = text.match(/lining\s*[:\-]\s*([^;.\n]+)/i);
  if (outer || lining) {
    const parts = [];
    if (outer) parts.push(`Outer: ${outer[1].trim()}`);
    if (lining) parts.push(`Lining: ${lining[1].trim()}`);
    return parts.join('; ');
  }
  return '';
}

function looksLikeBrandLine(line) {
  return /^[A-Za-z][A-Za-z&\.\s]+$/.test(line) && !/\d/.test(line);
}

function extractBrandAndStyle(line) {
  const m1 = line.match(/^([A-Za-z][A-Za-z&\.\s]+?)(\d[\w./-]*)$/);
  if (m1) {
    return { brand: m1[1].trim(), style: m1[2].trim() };
  }
  const m2 = line.match(/^([A-Za-z][A-Za-z&\.\s]+?)\s+([A-Za-z0-9][A-Za-z0-9./-]*)$/);
  if (m2 && /\d/.test(m2[2])) {
    return { brand: m2[1].trim(), style: m2[2].trim() };
  }
  return null;
}

function cleanStyleToken(token) {
  return String(token || '')
    .trim()
    .replace(/^[^\w]+/, '')
    .replace(/[^\w%./-]+$/, '');
}

function isMeasurementToken(token) {
  const value = cleanStyleToken(token).toUpperCase();
  if (!value) return false;

  if (/^\d{1,3}%[A-Z]+$/.test(value)) return true;
  if (/^\d{1,3}%$/.test(value)) return true;
  if (/^\d+(\.\d+)?(GSM|G\/M2|OZ\/YD2?|OZ|CM|MM|IN)$/.test(value)) return true;
  if (/^(BW|BVW)$/.test(value)) return true;

  return false;
}

function isDocumentHeadingLine(line) {
  const text = String(line || '').trim();
  if (!text) return false;

  if (/meeting notes/i.test(text)) return true;
  if (/men[’'`s]{0,2}\s+(denim|woven|knit|outerwear|tops?|bottoms?)/i.test(text)) return true;
  if (/women[’'`s]{0,2}\s+(denim|woven|knit|outerwear|tops?|bottoms?)/i.test(text)) return true;
  if (isCoverLike(text)) return true;

  return false;
}

function isLikelyStyleToken(token) {
  const value = cleanStyleToken(token);
  if (!value) return false;

  if (/^\d{4}\/\d{3}\/\d{3}$/.test(value)) return true;
  if (/^\d{9,10}$/.test(value)) return true;
  if (/^\d+(st|nd|rd|th)$/i.test(value)) return false;

  if (!/\d/.test(value)) return false;
  if (isMeasurementToken(value)) return false;
  if (value.length < 4 || value.length > 28) return false;

  const hasLetters = /[A-Za-z]/.test(value);
  const hasSeparators = /[-/]/.test(value);

  if (hasLetters) return true;
  if (hasSeparators && /\d/.test(value)) return true;

  return false;
}

function extractStyleTokenMatches(text) {
  const source = String(text || '');
  const patterns = [
    /\b\d{4}\/\d{3}\/\d{3}\b/g,
    /\b\d{9,10}\b/g,
    /\b[A-Za-z0-9][A-Za-z0-9./-]{3,27}\b/g,
  ];
  const matches = [];
  const seen = new Set();

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source))) {
      const token = cleanStyleToken(match[0]);
      if (!token || !isLikelyStyleToken(token)) {
        continue;
      }
      const signature = `${match.index}:${token.toLowerCase()}`;
      if (seen.has(signature)) {
        continue;
      }
      seen.add(signature);
      matches.push({ token, index: match.index });
    }
  }

  return matches.sort((left, right) => left.index - right.index);
}

function extractStyleToken(line) {
  return extractStyleTokenMatches(line)[0]?.token || null;
}

function extractStyleTokensFromText(text) {
  return [...new Set(extractStyleTokenMatches(text).map((match) => match.token))];
}

function splitNormalizedLines(text = '') {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => normalizePdfLikeLine(line))
    .filter(Boolean);
}

function inferBrandFromText(text) {
  if (!text) return '';
  const m = text.match(/^([A-Za-z][A-Za-z&\.\s]+?)(?:\s+|)(\d[\w./-]*)/);
  if (m) return m[1].trim();
  return '';
}

function normalizeCodeToken(value) {
  return String(value || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function isDerivativeOfExistingCode(candidateCode = '', existingCodes = []) {
  const normalizedCandidate = normalizeCodeToken(candidateCode);
  if (!normalizedCandidate) {
    return false;
  }

  return existingCodes.some((existingCode) => {
    const normalizedExisting = normalizeCodeToken(existingCode);
    if (!normalizedExisting || normalizedExisting === normalizedCandidate) {
      return false;
    }

    const remainder = normalizedCandidate.startsWith(normalizedExisting)
      ? normalizedCandidate.slice(normalizedExisting.length)
      : '';

    return Boolean(remainder) && remainder.length <= 4;
  });
}

function looksLikeOcrNoiseCode(token = '') {
  const value = String(token || '').trim().toUpperCase();
  if (!value) return true;
  if (/\.(JPG|JPEG|PNG|WEBP|GIF|BMP|TIF|TIFF)$/i.test(value)) return true;
  if (/^PAGE[-_]/i.test(value)) return true;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return true;
  if (/[.@]/.test(value) && !/^\d{4}\/\d{3}\/\d{3}$/.test(value)) return true;
  if (/https?:|www\./i.test(value)) return true;
  if (value.length > 24) return true;
  if (OCR_NOISE_KEYWORDS.some((keyword) => value.includes(keyword))) return true;
  return false;
}

function looksLikeFabricInfoText(text = '') {
  const normalized = String(text || '').toUpperCase();
  if (!normalized) return false;

  const fieldHits = ['COMPOSITION', 'CONTENT', 'CONT', 'WIDTH', 'WEIGHT', 'CUTTABLE', 'FABRIC', 'ARTICLE', 'SUPPLIER', 'SPEC', 'CONTACT', 'DATE', 'EMAIL']
    .filter((keyword) => normalized.includes(keyword))
    .length;
  const materialHits = ['COTTON', 'LINEN', 'NYLON', 'POLY', 'VISCOSE', 'LYOCELL', 'MODAL', 'SPANDEX', 'ELASTANE']
    .filter((keyword) => normalized.includes(keyword))
    .length;
  const measurementHits = ['GSM', 'BW', 'BVW', 'OZ', 'G/M2']
    .filter((keyword) => normalized.includes(keyword))
    .length;
  const percentHits = (normalized.match(/\d{1,3}(?:\.\d+)?%/g) || []).length;
  const hasContactDetails = /@|(?:\+?86)?1[3-9]\d{9}/.test(normalized);

  return fieldHits >= 2 || hasContactDetails || (materialHits >= 1 && (measurementHits >= 1 || percentHits >= 2));
}

function looksLikeStrongSupplementalCode(token = '') {
  const value = String(token || '').trim().toUpperCase();
  if (!value) return false;
  if (looksLikeOcrNoiseCode(value)) return false;

  const digitCount = (value.match(/\d/g) || []).length;
  const letterCount = (value.match(/[A-Z]/g) || []).length;
  const hasSeparator = /[-/]/.test(value);
  const trailingAlphaRun = (value.match(/[A-Z]+$/) || [''])[0].length;
  const longestAlphaRun = Math.max(...((value.match(/[A-Z]+/g) || ['']).map((part) => part.length)));

  if (digitCount < 2) return false;
  if (!hasSeparator) {
    if (letterCount < 1 || letterCount > 7) return false;
    if (trailingAlphaRun > 3) return false;
    if (longestAlphaRun > 4) return false;
  } else {
    if (letterCount < 1) return false;
    if (trailingAlphaRun > 4) return false;
  }

  return true;
}

function filterSupplementalProducts(products = [], existingProducts = []) {
  const existingCodes = (Array.isArray(existingProducts) ? existingProducts : [])
    .map((item) => String(item?.code || '').trim())
    .filter(Boolean);

  return (Array.isArray(products) ? products : []).filter((product) => {
    const code = String(product?.code || '').trim();
    if (!code) return false;
    if (looksLikeOcrNoiseCode(code)) return false;
    if (!looksLikeStrongSupplementalCode(code)) return false;
    if (isDerivativeOfExistingCode(code, existingCodes)) return false;
    return true;
  });
}

function isHiddenFile(name) {
  return !name || name.startsWith('.');
}

function scoreDecodedText(text) {
  if (!text) return -Infinity;
  const replacementChars = (text.match(/\uFFFD/g) || []).length;
  const controlChars = (text.match(/[\u0000-\u0008\u000B-\u001F]/g) || []).length;
  const visibleChars = (text.match(/[\p{L}\p{N}\p{P}\p{Zs}]/gu) || []).length;
  return visibleChars - (replacementChars * 30) - (controlChars * 12);
}

function decodeTextBuffer(buffer) {
  const candidates = [
    buffer.toString('utf8'),
    buffer.toString('latin1'),
  ].map((text) => text.replace(/^\uFEFF/, ''));

  if (buffer.includes(0)) {
    candidates.push(buffer.toString('utf16le').replace(/^\uFEFF/, ''));
  }

  return candidates
    .map((text) => ({ text, score: scoreDecodedText(text) }))
    .sort((left, right) => right.score - left.score)[0]?.text || '';
}

function stripRtfToText(rtfText) {
  let text = String(rtfText || '');
  if (!text) {
    return '';
  }

  text = text
    .replace(/\r\n/g, '\n')
    .replace(/\\par[d]?(?=[\\\s{}])/gi, '\n')
    .replace(/\\line(?=[\\\s{}])/gi, '\n')
    .replace(/\\tab(?=[\\\s{}])/gi, '\t')
    .replace(/\\'[0-9a-fA-F]{2}/g, (match) => {
      try {
        return Buffer.from(match.slice(2), 'hex').toString('latin1');
      } catch {
        return ' ';
      }
    })
    .replace(/\\u(-?\d+)\??/g, (_match, codePoint) => {
      const value = Number(codePoint);
      if (!Number.isFinite(value)) {
        return ' ';
      }
      const normalized = value < 0 ? value + 65536 : value;
      try {
        return String.fromCodePoint(normalized);
      } catch {
        return ' ';
      }
    })
    .replace(/\\[a-z]+-?\d* ?/gi, ' ')
    .replace(/\\\*/g, ' ')
    .replace(/\\\\/g, '\\')
    .replace(/\\~/g, ' ')
    .replace(/[{}]/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  return text;
}

function readTextFileWithFallback(filePath) {
  const buffer = fs.readFileSync(filePath);
  const decoded = decodeTextBuffer(buffer);

  if (filePath.toLowerCase().endsWith('.rtf')) {
    return stripRtfToText(decoded);
  }

  return decoded;
}

function getFolderFileGroups(folderPath, folderName) {
  const entries = fs.readdirSync(folderPath).filter((entry) => !isHiddenFile(entry));
  const imageFiles = entries
    .filter((entry) => /\.(jpg|jpeg|png|webp)$/i.test(entry))
    .map((entry) => path.join(folderPath, entry));

  const folderBase = String(folderName || '').toLowerCase();
  const infoFiles = entries
    .filter((entry) => /\.(json|txt|rtf)$/i.test(entry))
    .filter((entry) => !/^thumbs\.db$/i.test(entry))
    .filter((entry) => {
      if (!entry.toLowerCase().endsWith('.json')) {
        return true;
      }
      const lower = entry.toLowerCase();
      return lower === `${folderBase}_info.json`
        || lower === `${folderBase}.json`
        || lower === 'info.json'
        || lower.endsWith('_info.json');
    })
    .map((entry) => path.join(folderPath, entry));

  const preferredInfoFiles = infoFiles
    .map((filePath) => {
      const base = path.basename(filePath).toLowerCase();
      const folderBase = String(folderName || '').toLowerCase();
      let score = 0;

      if (base === `${folderBase}_info.json`) score += 90;
      else if (base === `${folderBase}.json`) score += 80;
      else if (base === `${folderBase}_info.txt`) score += 70;
      else if (base === `${folderBase}.txt`) score += 60;
      else if (base === `${folderBase}_info.rtf`) score += 55;
      else if (base === `${folderBase}.rtf`) score += 50;
      else if (base === 'info.json') score += 45;
      else if (base === 'info.txt') score += 40;
      else if (base === 'info.rtf') score += 35;
      else if (base.endsWith('_info.json')) score += 30;
      else if (base.endsWith('_info.txt')) score += 25;
      else if (base.endsWith('_info.rtf')) score += 20;
      else score += 10;

      try {
        score += Math.min(15, Math.floor(fs.statSync(filePath).size / 1024));
      } catch {
        score += 0;
      }

      return { filePath, score };
    })
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.filePath);

  return { imageFiles, infoFiles: preferredInfoFiles };
}

function folderLooksLikeProductSource(folderPath, folderName) {
  const { imageFiles, infoFiles } = getFolderFileGroups(folderPath, folderName);
  return imageFiles.length > 0 || infoFiles.length > 0;
}

function collectProductFolders(rootPath, maxDepth = 3, depth = 0, found = []) {
  const folderName = path.basename(rootPath);
  if (folderLooksLikeProductSource(rootPath, folderName)) {
    found.push(rootPath);
    return found;
  }

  if (depth >= maxDepth) {
    return found;
  }

  for (const entry of fs.readdirSync(rootPath).filter((item) => !isHiddenFile(item))) {
    const entryPath = path.join(rootPath, entry);
    let stat;
    try {
      stat = fs.statSync(entryPath);
    } catch {
      continue;
    }

    if (!stat.isDirectory()) {
      continue;
    }

    collectProductFolders(entryPath, maxDepth, depth + 1, found);
  }

  return found;
}

// ── 从名称/描述推断品类 ─────────────────────────
function inferCategory(name, description) {
  const joined = `${name || ''} ${description || ''}`.toLowerCase();
  for (const rule of CATEGORY_SIGNAL_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(joined))) {
      return rule.label;
    }
  }

  for (const rule of CATEGORY_RULES) {
    if (BROAD_COLLECTION_CATEGORY_LABELS.has(rule.label)) continue;
    if (rule.keywords.some((keyword) => joined.includes(keyword))) {
      return rule.label;
    }
  }

  if (/\bmens woven\b|\bmen's woven\b|\bwomens woven\b|\bwomen's woven\b|\bwoven\b/i.test(joined)) {
    if (/\bcoat\b|\bparka\b|\banorak\b|\bpuffer\b|\btrench\b|\bouterwear\b/i.test(joined)) return 'Outerwear';
    if (/\bvest\b|\bwaistcoat\b|\bgilet\b|\bsleeveless\b/i.test(joined)) return 'Waistcoats & Vests';
    if (/\bovershirt\b|\bshacket\b|\bshirt jacket\b/i.test(joined)) return 'Overshirts';
    if (/\bjacket\b|\btrucker\b|\bbomber\b|\bzip front\b/i.test(joined)) return 'Jackets';
    if (/\bshirt\b|\bplacket\b|\bcollar\b|\bcuff\b|\byoke\b|\bboxford\b/i.test(joined)) return 'Shirts';
    if (/\btop\b|\bblouse\b|\btank\b|\bcamisole\b|\bbodysuit\b/i.test(joined)) return 'Tops';
    if (/\bcargo\b|\butility pocket\b|\bcarpenter\b/i.test(joined)) return 'Cargo Pants';
    if (/\bjogger\b|\belasticated waist\b|\bcuffed hem\b/i.test(joined)) return 'Joggers';
    if (/\bshorts?\b|\bbermuda\b/i.test(joined)) return 'Shorts';
    if (/\bskirt\b/i.test(joined)) return 'Skirts';
    if (/\bdress\b/i.test(joined)) return 'Dresses';
    if (/\btrouser\b|\bpants?\b|\bpleated front\b|\bdrawstring waist\b/i.test(joined)) return 'Tailored Pants';
    if (/\bmens woven\b|\bmen's woven\b/i.test(joined)) return 'Shirts';
    if (/\bwomens woven\b|\bwomen's woven\b/i.test(joined)) return 'Tops';
    if (/\bwoven shirt\b/i.test(joined)) return 'Shirts';
    if (/\bwoven top\b/i.test(joined)) return 'Tops';
    return 'Other';
  }

  if (/\bmens denim\b|\bmen's denim\b|\bwomens denim\b|\bwomen's denim\b|\bdenim\b/i.test(joined)) {
    if (/\bjacket\b|\btrucker\b/i.test(joined)) return 'Jackets';
    if (/\bovershirt\b|\bshacket\b/i.test(joined)) return 'Overshirts';
    if (/\bshirt\b/i.test(joined)) return 'Shirts';
    if (/\bshorts?\b|\bbermuda\b/i.test(joined)) return 'Shorts';
    if (/\bskirt\b/i.test(joined)) return 'Skirts';
    if (/\bwaistcoat\b|\bvest\b|\bgilet\b/i.test(joined)) return 'Waistcoats & Vests';
    return 'Jeans';
  }

  return 'Other';
}

function inferCategoryHierarchy(name, description) {
  const category = inferCategory(name, description);
  const joined = `${name || ''} ${description || ''}`.toLowerCase();

  const mapPrimaryCategory = (value) => {
    switch (value) {
      case 'Blazers':
      case 'Jackets':
      case 'Outerwear':
      case 'Overshirts':
      case 'Waistcoats & Vests':
        return 'Outerwear';
      case 'Shirts':
      case 'T-Shirts':
      case 'Polos':
      case 'Knitwear':
      case 'Hoodies & Sweatshirts':
      case 'Tops':
        return 'Tops';
      case 'Jeans':
      case 'Chino Pants':
      case 'Cargo Pants':
      case 'Joggers':
      case 'Tailored Pants':
      case 'Shorts':
      case 'Skirts':
        return 'Bottoms';
      case 'Dresses':
      case 'Jumpsuits':
        return 'One-Piece';
      case 'Accessories':
      case 'Footwear':
      case 'Underwear':
        return value;
      default:
        return category === 'Other' ? 'Other' : category;
    }
  };

  let subcategory = category;

  if (category === 'Jackets') {
    if (/\btrucker\b/i.test(joined)) subcategory = 'Trucker Jacket';
    else if (/\bbomber\b/i.test(joined)) subcategory = 'Bomber Jacket';
    else if (/\bcoach jacket\b/i.test(joined)) subcategory = 'Coach Jacket';
    else if (/\bfield jacket\b/i.test(joined)) subcategory = 'Field Jacket';
    else if (/\bworker jacket\b|\bworkwear jacket\b/i.test(joined)) subcategory = 'Worker Jacket';
    else if (/\bdenim jacket\b/i.test(joined)) subcategory = 'Denim Jacket';
  } else if (category === 'Outerwear') {
    if (/\bparka\b/i.test(joined)) subcategory = 'Parka';
    else if (/\bpuffer\b/i.test(joined)) subcategory = 'Puffer';
    else if (/\btrench\b/i.test(joined)) subcategory = 'Trench Coat';
    else if (/\banorak\b/i.test(joined)) subcategory = 'Anorak';
    else if (/\bcoat\b/i.test(joined)) subcategory = 'Coat';
  } else if (category === 'Shirts') {
    if (/\boxford\b/i.test(joined)) subcategory = 'Oxford Shirt';
    else if (/\bflannel\b/i.test(joined)) subcategory = 'Flannel Shirt';
    else if (/\bwestern\b/i.test(joined)) subcategory = 'Western Shirt';
    else if (/\bcamp collar\b|\bbowling shirt\b/i.test(joined)) subcategory = 'Camp Collar Shirt';
    else if (/\bpoplin\b/i.test(joined)) subcategory = 'Poplin Shirt';
  } else if (category === 'T-Shirts') {
    if (/\bgraphic\b/i.test(joined)) subcategory = 'Graphic T-Shirt';
  } else if (category === 'Polos') {
    if (/\brugby\b/i.test(joined)) subcategory = 'Rugby Shirt';
    else if (/\bknit polo\b/i.test(joined)) subcategory = 'Knit Polo';
  } else if (category === 'Knitwear') {
    if (/\bcardigan\b/i.test(joined)) subcategory = 'Cardigan';
    else if (/\bhalf zip\b/i.test(joined)) subcategory = 'Half-Zip Knit';
    else if (/\broll neck\b|\bturtleneck\b/i.test(joined)) subcategory = 'Roll-Neck Knit';
    else if (/\bcrewneck\b/i.test(joined)) subcategory = 'Crewneck Knit';
  } else if (category === 'Hoodies & Sweatshirts') {
    if (/\bzip hoodie\b/i.test(joined)) subcategory = 'Zip Hoodie';
    else if (/\bhoodie\b/i.test(joined)) subcategory = 'Hoodie';
    else if (/\bsweatshirt\b/i.test(joined)) subcategory = 'Sweatshirt';
  } else if (category === 'Jeans') {
    if (/\bbootcut\b/i.test(joined)) subcategory = 'Bootcut Jeans';
    else if (/\bflare\b/i.test(joined)) subcategory = 'Flare Jeans';
    else if (/\bbarrel\b/i.test(joined)) subcategory = 'Barrel Jeans';
    else if (/\bbaggy\b/i.test(joined)) subcategory = 'Baggy Jeans';
    else if (/\bstraight\b/i.test(joined)) subcategory = 'Straight Jeans';
    else if (/\bskinny\b/i.test(joined)) subcategory = 'Skinny Jeans';
    else if (/\brelaxed\b/i.test(joined)) subcategory = 'Relaxed Jeans';
    else if (/\bmom\b/i.test(joined)) subcategory = 'Mom Jeans';
    else if (/\bdad\b/i.test(joined)) subcategory = 'Dad Jeans';
  } else if (category === 'Cargo Pants') {
    if (/\bparachute\b/i.test(joined)) subcategory = 'Parachute Pants';
    else if (/\bcarpenter\b/i.test(joined)) subcategory = 'Carpenter Pants';
  } else if (category === 'Tailored Pants') {
    if (/\bpleated\b/i.test(joined)) subcategory = 'Pleated Trousers';
    else if (/\bdrawstring\b/i.test(joined)) subcategory = 'Drawstring Trousers';
    else if (/\bwide\b/i.test(joined)) subcategory = 'Wide-Leg Trousers';
  } else if (category === 'Shorts') {
    if (/\bbermuda\b/i.test(joined)) subcategory = 'Bermuda Shorts';
    else if (/\bjort\b/i.test(joined)) subcategory = 'Jorts';
  } else if (category === 'Waistcoats & Vests') {
    if (/\bgilet\b/i.test(joined)) subcategory = 'Gilet';
    else if (/\bwaistcoat\b/i.test(joined)) subcategory = 'Waistcoat';
    else if (/\bvest\b/i.test(joined)) subcategory = 'Vest';
  }

  return {
    primaryCategory: mapPrimaryCategory(category),
    subcategory: subcategory || category || 'Other',
    category: subcategory || category || 'Other',
  };
}

// ── 从名称/描述推断版型 ─────────────────────────
function inferFit(name, description) {
  const text = `${name || ''} ${description || ''}`.toLowerCase();
  for (const rule of FIT_RULES) {
    if (rule.keywords.some((keyword) => text.includes(keyword))) {
      return rule.label;
    }
  }
  return '';
}

// ── 从描述提取设计特征 ──────────────────────────
function extractFeatures(name, description) {
  const text = `${name} ${description || ''}`.toLowerCase();
  return FEATURE_KEYWORDS.filter(f => text.includes(f))
    .map(f => f.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '));
}

function containsCategoryKeyword(text) {
  const lower = (text || '').toLowerCase();
  return CATEGORY_KEYWORDS.some(kw => lower.includes(kw));
}

function detectCollectionSection(text = '') {
  const normalized = String(text || '')
    .replace(/[’']/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  if (!normalized) return '';

  const sectionHints = [
    ['Mens Denim', ["men's denim", 'mens denim', 'denim']],
    ['Mens Woven', ["men's woven", 'mens woven', 'woven']],
    ['Womens Denim', ["women's denim", 'womens denim']],
    ['Womens Woven', ["women's woven", 'womens woven']],
    ['Outerwear', ['outerwear']],
    ['Knitwear', ['knitwear']],
    ['Shirting', ['shirting']],
  ];

  for (const [label, keywords] of sectionHints) {
    if (keywords.some((keyword) => normalized.includes(keyword))) {
      return label;
    }
  }

  return '';
}

function buildPdfSectionMap(pages = []) {
  const sectionMap = new Map();
  let activeSection = '';

  for (const page of pages) {
    const pageNumber = Number(page?.number) || 0;
    const pageText = String(page?.text || '');
    const detected = detectCollectionSection(pageText);
    if (detected) {
      activeSection = detected;
    }
    if (pageNumber > 0) {
      sectionMap.set(pageNumber, activeSection);
    }
  }

  return sectionMap;
}

function isCoverLike(text) {
  const t = (text || '').toLowerCase();
  return /lookbook|collection|analysis|report|catalog|table of contents|menswear|womenswear|season|ss\b|fw\b|aw\b|zara\b/.test(t);
}

function looksLikeMaterialOnlyName(text = '') {
  const cleaned = normalizePdfLikeLine(String(text || ''));
  if (!cleaned) return false;

  if (looksLikeFabricInfoText(cleaned)) return true;

  const lower = cleaned.toLowerCase();
  const words = lower.split(/\s+/).filter(Boolean);
  if (words.length === 0) return false;

  const materialWordCount = words.filter((word) =>
    /^(cotton|polyester|viscose|lyocell|tencel|linen|nylon|polyamide|spandex|elastane|rayon|modal|denim|wool|acrylic|ramie|acetate|cupro|shell|lining|outer|blend|woven|knit|composition|content|gsm|oz|weight|width|cuttable|recycled|organic|bci|stretch)$/.test(word)
  ).length;
  const percentCount = (cleaned.match(/\d{1,3}(?:\.\d+)?%/g) || []).length;
  const categoryHint = containsCategoryKeyword(cleaned);

  if (percentCount >= 1 && materialWordCount >= Math.max(1, Math.floor(words.length / 2))) {
    return true;
  }

  if (!categoryHint && materialWordCount === words.length && words.length <= 8) {
    return true;
  }

  return false;
}

function pickBestName(lines) {
  let best = '';
  let bestScore = -999;
  for (const line of lines) {
    let cleaned = sanitizeProductName(line);
    if (!cleaned) continue;
    if (!/[A-Za-z\u4e00-\u9fff]/.test(cleaned)) continue;
    if (isCoverLike(cleaned)) continue;
    if (looksLikeMaterialOnlyName(cleaned)) continue;
    if (/^\$/.test(cleaned)) continue;
    let score = 0;
    if (cleaned.length >= 6 && cleaned.length <= 80) score += 2;
    if (containsCategoryKeyword(cleaned)) score += 3;
    if (looksLikeFabricInfoText(cleaned)) score -= 5;
    if (/%|cotton|polyester|viscose|nylon|wool|linen|silk|spandex|elastane|composition|lining|outer|shell/i.test(cleaned)) score -= 2;
    if (/color|ref|style|price|size|cm|mm/i.test(cleaned)) score -= 1;
    if (score > bestScore) {
      bestScore = score;
      best = cleaned;
    }
  }
  return best;
}

function sanitizeProductName(value = '') {
  let cleaned = normalizePdfLikeLine(String(value || ''));
  if (!cleaned) {
    return '';
  }

  cleaned = cleaned
    .replace(/\b\d{4}\/\d{3}\/\d{3}\b/g, ' ')
    .replace(/\b\d{9,10}\b/g, ' ')
    .replace(/\$\s*[\d,.]+/g, ' ')
    .replace(/\b(?:composition|content|fabric|material|materials|width|weight|cuttable|supplier|article|spec|contact)\b[:\s-]*/gi, ' ')
    .replace(/\b\d{1,3}(?:\.\d+)?%\s*[A-Za-z][A-Za-z\s/-]*/g, ' ')
    .replace(/\b\d+(?:\.\d+)?\s*(?:GSM|G\/M2|OZ\/YD2?|OZ|CM|MM|IN)\b/gi, ' ')
    .replace(/\b(?:BW|BVW)\b/gi, ' ')
    .replace(/\s*[|;,:]+\s*/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  if (!cleaned) {
    return '';
  }

  const words = cleaned.split(/\s+/).filter(Boolean);
  const materialishWords = words.filter((word) =>
    /(cotton|polyester|viscose|lyocell|tencel|linen|nylon|polyamide|spandex|elastane|rayon|modal|denim|oz|gsm|shell|lining)/i.test(word)
  ).length;
  const percentCount = (cleaned.match(/\d{1,3}(?:\.\d+)?%/g) || []).length;

  if (percentCount >= 2) {
    return '';
  }
  if (words.length > 0 && materialishWords / words.length >= 0.5 && !containsCategoryKeyword(cleaned)) {
    return '';
  }
  if (looksLikeMaterialOnlyName(cleaned)) {
    return '';
  }

  return cleaned;
}

// ── 推断风格 ────────────────────────────────────
function inferStyle(name, description, features) {
  const text = `${name} ${description || ''} ${features.join(' ')}`.toLowerCase();
  for (const [style, keywords] of Object.entries(STYLE_MAP)) {
    if (keywords.some(kw => text.includes(kw))) return style;
  }
  return 'Casual';
}

function extractWeightSpec(text = '') {
  const match = String(text || '').match(/\b\d+(?:\.\d+)?\s*(?:GSM|G\/M2|OZ\/YD2?|OZ)\b/i);
  return match ? match[0].replace(/\s+/g, ' ').trim() : '';
}

function extractFinishSpec(text = '') {
  const source = String(text || '');
  const normalized = source.replace(/\s+/g, ' ').trim();
  if (/\bprinting\b/i.test(normalized)) {
    return 'printed finish';
  }
  const washMatch = normalized.match(/\b(?:BW|BVW)\b/i);
  return washMatch ? `${washMatch[0].toUpperCase()} finish` : '';
}

function inferSourceProfileFromText(text = '', products = []) {
  const source = String(text || '');
  const normalized = source.toLowerCase();
  const safeProducts = Array.isArray(products) ? products : [];

  const compositionHeavyCount = safeProducts.filter((product) => {
    const composition = String(product?.compositionText || '').trim();
    return Boolean(composition) || looksLikeFabricInfoText(product?.description || '');
  }).length;

  const codeNameCount = safeProducts.filter((product) => {
    const name = String(product?.name || '').trim();
    const code = String(product?.code || '').trim();
    return Boolean(name && code && normalizeCodeToken(name) === normalizeCodeToken(code));
  }).length;

  if (/meeting notes/i.test(normalized)) {
    return 'fabric-review';
  }

  if (/fabric|composition|gsm|oz\/yd2|cuttable|supplier/i.test(source) && safeProducts.length > 0) {
    if (compositionHeavyCount / safeProducts.length >= 0.55) {
      return 'fabric-review';
    }
  }

  if (safeProducts.length > 0 && compositionHeavyCount / safeProducts.length >= 0.7 && codeNameCount / safeProducts.length >= 0.55) {
    return 'fabric-review';
  }

  return 'apparel';
}

function buildProductDescription(raw = {}, options = {}) {
  const rawText = String(raw.rawText || '').replace(/\s+/g, ' ').trim();
  const compositionText = extractCompositionText(rawText);
  const weight = extractWeightSpec(rawText);
  const finish = extractFinishSpec(rawText);
  const category = String(raw.category || '').trim();
  const trimmed = rawText.substring(0, 200);
  if (trimmed) return trimmed;

  const parts = [];
  if (category && category !== 'Other') parts.push(category);
  if (compositionText) {
    parts.push(`with ${compositionText}`);
  } else if (Array.isArray(raw.materials) && raw.materials.filter(Boolean).length > 0) {
    parts.push(`with ${raw.materials.filter(Boolean).join(', ')}`);
  }
  if (weight) parts.push(weight);
  if (finish) parts.push(finish);
  return parts.join(', ').replace(/\s+,/g, ',').trim();
}

// ── 从Scraper的info.json解析产品 ────────────────
function parseFromInfoJson(info) {
  const name = sanitizeProductName(info.name || '') || info.name || '';
  const desc = info.description || '';
  const compositionText = buildCompositionText(info.composition);
  const brand = info.brand || info.brandName || info.store || info.label || '';
  
  // 解析面料
  let materials = [];
  if (info.composition) {
    if (typeof info.composition === 'object') {
      const compText = [
        info.composition.outerShell || '',
        info.composition.lining || '',
        info.composition.other || ''
      ].join(' ');
      materials = extractMaterials(compText);
    } else {
      materials = extractMaterials(String(info.composition));
    }
  }
  if (materials.length === 0) materials = extractMaterials(desc);
  if (materials.length === 0) materials = ['Unknown'];

  const category = inferCategory(name, desc);
  const fit = inferFit(name, desc);
  const features = extractFeatures(name, desc);
  const style = inferStyle(name, desc, features);
  const price = classifyPrice(info.price);

  return {
    code: info.styleNumber || '',
    name: name,
    brand: brand,
    category,
    fit,
    materials: [...new Set(materials.map(m => m.charAt(0).toUpperCase() + m.slice(1)))],
    price,
    priceValue: info.price || '',
    features: features.length > 0 ? features : ['Standard Design'],
    style,
    attributes: [style, category === 'Outerwear' ? 'Layering' : 'Versatile'],
    description: desc,
    compositionText,
  };
}

// ── 从PDF提取文本 ───────────────────────────────
async function parsePDF(filePath) {
  const buffer = fs.readFileSync(filePath);
  const data = await pdfParse(buffer);
  return data.text;
}

function normalizePdfLikeLine(text = '') {
  let normalized = String(text || '').replace(/\s+/g, ' ').trim();

  normalized = normalized.replace(
    /\b(?:[A-Za-z0-9%/.'&+-]\s+){3,}[A-Za-z0-9%/.'&+-]\b/g,
    (match) => {
      if (/\d/.test(match) || /%|OZ|GSM|YD|BW|ELA|LYOCELL|POLY|LINEN|VIS|SP/i.test(match)) {
        return match.replace(/\s+/g, '');
      }
      return match;
    },
  );

  normalized = normalized.replace(/\b(\d+)\s*%\s*([A-Za-z]+)/g, '$1%$2');
  return normalized.trim();
}

function buildPdfPageFromTextContent(pageData, pageNumber) {
  return pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false }).then((content) => {
    const rows = [];

    for (const item of content.items || []) {
      const value = String(item?.str || '');
      if (!value.trim()) {
        continue;
      }

      const x = Number(item?.transform?.[4] || 0);
      const y = Number(item?.transform?.[5] || 0);
      const width = Number(item?.width || 0);
      const height = Number(item?.height || 0);

      let row = rows.find((candidate) => Math.abs(candidate.y - y) <= Math.max(2, height * 0.45));
      if (!row) {
        row = { y, items: [] };
        rows.push(row);
      }
      row.items.push({ value, x, width, height });
    }

    const lines = rows
      .sort((left, right) => right.y - left.y)
      .map((row) => {
        const ordered = row.items.sort((left, right) => left.x - right.x);
        let built = '';
        let previousEnd = null;

        for (const token of ordered) {
          if (previousEnd !== null) {
            const gap = token.x - previousEnd;
            const threshold = Math.max(2, token.height * 0.28);
            if (gap > threshold) {
              built += ' ';
            }
          }
          built += token.value;
          previousEnd = token.x + token.width;
        }

        return normalizePdfLikeLine(built);
      })
      .filter(Boolean);

    return {
      number: pageNumber,
      text: lines.join('\n'),
      lines,
    };
  });
}

async function parsePdfDocument(filePath, options = {}) {
  try {
    return await extractPdfDocumentContext(filePath, {
      persistKey: filePath,
      emitLog: options.emitLog,
    });
  } catch (error) {
    // Fall back to text-layer parsing when fitz extraction is unavailable.
  }

  const buffer = fs.readFileSync(filePath);
  const pages = [];
  const data = await pdfParse(buffer, {
    pagerender: (pageData) => buildPdfPageFromTextContent(pageData, pages.length + 1).then((page) => {
      pages.push(page);
      return page.text;
    }),
  });

  const normalizedPages = pages.length > 0
    ? pages
    : [{
        number: 1,
        text: normalizePdfLikeLine(data?.text || ''),
        lines: String(data?.text || '')
          .split(/\r?\n/)
          .map((line) => normalizePdfLikeLine(line))
          .filter(Boolean),
      }];

  return {
    text: normalizedPages.map((page) => page.text).filter(Boolean).join('\n\n'),
    pageCount: Number(data?.numpages) || normalizedPages.length || 0,
    pages: normalizedPages,
  };
}

async function renderPdfPagesForOcr(filePath, pageNumbers = [], options = {}) {
  if (!Array.isArray(pageNumbers) || pageNumbers.length === 0) {
    return [];
  }

  const ensureActive = options.ensureActive || (() => {});
  const emitLog = options.emitLog || (() => {});
  const totalPages = pageNumbers.length;
  for (let pageIndex = 0; pageIndex < pageNumbers.length; pageIndex += 1) {
    emitLog(`Rendering PDF page ${pageNumbers[pageIndex]} (${pageIndex + 1}/${totalPages}) for OCR fallback...`, 'info');
  }
  ensureActive();
  return renderPdfPagesWithFitz(filePath, pageNumbers, {
    persistKey: `${filePath}::ocr-fallback`,
    renderScale: 2,
    emitLog,
  });
}

function getWeakPdfPageNumbers(document, products = []) {
  const pageCount = Number(document?.pageCount || 0);
  if (pageCount <= 0) {
    return [];
  }

  const pages = Array.isArray(document?.pages) ? document.pages : [];
  const signalPages = pages
    .filter((page) => {
      const text = String(page?.text || '').trim();
      return extractStyleTokensFromText(text).length > 0;
    })
    .map((page) => Number(page?.number) || 0)
    .filter((value) => value > 0);
  const firstSignalPage = signalPages[0] || 0;
  const lastSignalPage = signalPages[signalPages.length - 1] || 0;
  const weakPages = pages
    .filter((page) => {
      const text = String(page?.text || '').trim();
      const pageNumber = Number(page?.number) || 0;
      const imageCount = Number(page?.imageCount || 0);

      if (!text) {
        if (firstSignalPage > 0 && lastSignalPage > 0 && (pageNumber < firstSignalPage || pageNumber > lastSignalPage)) {
          return false;
        }
        if (imageCount > 0 && imageCount > 6) {
          return false;
        }
        return true;
      }

      return false;
    })
    .map((page) => page.number)
    .filter((value) => Number.isFinite(value) && value > 0);

  return [...new Set(weakPages)].sort((left, right) => left - right);
}

function buildPdfProcessingPlan(document, products = []) {
  const pages = Array.isArray(document?.pages) ? document.pages : [];
  const pageCount = Number(document?.pageCount) || pages.length || 0;
  const signalPages = pages
    .filter((page) => extractStyleTokensFromText(String(page?.text || '').trim()).length > 0)
    .map((page) => Number(page?.number) || 0)
    .filter((value) => value > 0);
  const firstSignalPage = signalPages[0] || 0;
  const lastSignalPage = signalPages[signalPages.length - 1] || 0;

  const productLikePageNumbers = pages
    .filter((page) => {
      const pageNumber = Number(page?.number) || 0;
      const text = String(page?.text || '').trim();
      const imageCount = Number(page?.imageCount || 0);
      const hasStyleTokens = extractStyleTokensFromText(text).length > 0;

      if (hasStyleTokens) {
        return true;
      }

      if (imageCount <= 0 || imageCount > 6) {
        return false;
      }

      if (!firstSignalPage || !lastSignalPage) {
        return true;
      }

      return pageNumber >= Math.max(1, firstSignalPage - 1) && pageNumber <= (lastSignalPage + 1);
    })
    .map((page) => Number(page?.number) || 0)
    .filter((value) => value > 0);

  const productLikeSet = new Set(productLikePageNumbers);
  const weakPageNumbers = getWeakPdfPageNumbers(document, products)
    .filter((pageNumber) => productLikeSet.has(pageNumber));
  const textPageCount = pages.filter((page) => String(page?.text || '').trim()).length;
  const maxImagesPerPage = 4;
  const maxEmbeddedImages = Math.min(120, Math.max(productLikePageNumbers.length * maxImagesPerPage, 12));

  return {
    pageCount,
    textPageCount,
    productLikePageNumbers,
    weakPageNumbers,
    maxImagesPerPage,
    maxEmbeddedImages,
  };
}

function buildFallbackProductFromCode(code, text = '') {
  const joined = String(text || '').trim();
  return finalizeProduct({
    code,
    brand: inferBrandFromText(joined),
    rawText: joined || code,
    lines: joined ? [joined] : [code],
  }) || {
    code,
    brand: inferBrandFromText(joined) || '',
    name: joined || code,
    category: inferCategory(joined || code, joined),
    fit: inferFit(joined || code, joined),
    materials: extractMaterials(joined).map((item) => item.charAt(0).toUpperCase() + item.slice(1)),
    price: classifyPrice(joined),
    priceValue: '',
    features: extractFeatures(joined || code, joined),
    style: inferStyle(joined || code, joined, extractFeatures(joined || code, joined)),
    attributes: ['Versatile'],
    description: joined.slice(0, 200),
    compositionText: extractCompositionText(joined),
  };
}

async function extractPdfProductsFromPageOcr(filePath, pageNumbers, options = {}) {
  const ensureActive = options.ensureActive || (() => {});
  const emitLog = options.emitLog || (() => {});
  const existingProducts = Array.isArray(options.existingProducts) ? options.existingProducts : [];
  const pageImages = await renderPdfPagesForOcr(filePath, pageNumbers, { ensureActive, emitLog });
  const ocrProducts = [];
  const pageTexts = [];
  const imagePaths = [];

  for (let index = 0; index < pageImages.length; index += 1) {
    ensureActive();
    const pageImage = pageImages[index];
    emitLog(`Running OCR on PDF page ${index + 1}/${pageImages.length}...`, 'info');
    try {
      const tempRoot = path.join(require('os').tmpdir(), 'gsbot-product-analysis', 'pdf-pages', path.basename(filePath, path.extname(filePath)));
      fs.mkdirSync(tempRoot, { recursive: true });
      const tempPath = path.join(tempRoot, `page-${String(pageImage.pageNumber || (index + 1)).padStart(3, '0')}.png`);
      fs.writeFileSync(tempPath, pageImage.buffer);
      imagePaths.push(tempPath);
    } catch {
      // Ignore temporary preview persistence errors.
    }
    let text = '';
    try {
      text = await recognizeImageBuffer(pageImage.buffer, {
        languages: ['eng'],
        cacheNamespace: 'product-analysis-pdf-pages',
        ocrEngine: options.ocrEngine,
        ocrFallbackEngine: options.ocrFallbackEngine,
      });
    } catch (error) {
      emitLog(`Skipping OCR for ${pageImage.name}: ${error.message}`, 'warning');
      continue;
    }

    const normalizedText = String(text || '').trim();
    if (!normalizedText) {
      continue;
    }

    pageTexts.push(`Page ${pageImage.pageNumber || (index + 1)}\n${normalizedText}`);
    if (looksLikeFabricInfoText(normalizedText)) {
      continue;
    }
    const lines = normalizedText
      .split(/\r?\n/)
      .map((line) => normalizePdfLikeLine(line))
      .filter(Boolean);
    const parsedProducts = filterSupplementalProducts(parseProductsFromText(lines), existingProducts);
    ocrProducts.push(...parsedProducts);
    const fallbackCodes = extractStyleTokensFromText(normalizedText)
      .filter((code) => !looksLikeOcrNoiseCode(code))
      .filter((code) => looksLikeStrongSupplementalCode(code))
      .filter((code) => !isDerivativeOfExistingCode(code, existingProducts.map((item) => item.code)));
    for (const code of fallbackCodes) {
      ocrProducts.push(buildFallbackProductFromCode(code, normalizedText));
    }
  }

  return {
    text: pageTexts.join('\n\n'),
    products: dedupeProductsByCode(ocrProducts),
    imagePaths,
  };
}

function buildProductsFromSupplementalText(text = '') {
  const lines = splitNormalizedLines(text);
  if (lines.length === 0) {
    return [];
  }

  const products = [...parseProductsFromText(lines)];
  const joined = lines.join('\n');
  for (const code of extractStyleTokensFromText(joined)) {
    products.push(buildFallbackProductFromCode(code, joined));
  }

  return dedupeProductsByCode(products);
}

function appendSourceContext(sourceText, extraHeading, extraText) {
  if (!String(extraText || '').trim()) {
    return sourceText || '';
  }
  return [sourceText, `${extraHeading}\n${String(extraText).trim()}`].filter(Boolean).join('\n\n');
}

function selectFolderImagesForOcr(products = [], options = {}) {
  const maxPerProduct = Number.isFinite(options.maxPerProduct) ? options.maxPerProduct : 3;
  const maxTotal = Number.isFinite(options.maxTotal) ? options.maxTotal : 120;
  const preferredMarkers = ['_x01', '_x', '_f', '_b', 'front', 'back', 'detail', 'look'];
  const selected = [];

  for (const product of products) {
    const imagePaths = Array.isArray(product?.imagePaths) ? product.imagePaths : [];
    if (imagePaths.length === 0) {
      continue;
    }

    const sorted = [...imagePaths].sort((left, right) => {
      const leftLower = path.basename(left).toLowerCase();
      const rightLower = path.basename(right).toLowerCase();
      const leftScore = preferredMarkers.findIndex((marker) => leftLower.includes(marker));
      const rightScore = preferredMarkers.findIndex((marker) => rightLower.includes(marker));
      const normalizedLeft = leftScore === -1 ? preferredMarkers.length : leftScore;
      const normalizedRight = rightScore === -1 ? preferredMarkers.length : rightScore;
      if (normalizedLeft !== normalizedRight) {
        return normalizedLeft - normalizedRight;
      }
      return leftLower.localeCompare(rightLower);
    });

    selected.push(...sorted.slice(0, maxPerProduct));
    if (selected.length >= maxTotal) {
      break;
    }
  }

  return [...new Set(selected)].slice(0, maxTotal);
}

function assignPdfImagesToProducts(products = [], imageRecords = [], pageContexts = []) {
  const safeProducts = Array.isArray(products) ? products.map((product) => ({
    ...product,
    imagePaths: Array.isArray(product?.imagePaths) ? [...product.imagePaths] : [],
  })) : [];
  const safeImageRecords = Array.isArray(imageRecords) ? imageRecords.filter((record) => Number(record?.pageNumber) > 0 && record?.path) : [];
  if (safeProducts.length === 0 || safeImageRecords.length === 0) {
    return safeProducts;
  }

  const imagesByPage = new Map();
  for (const record of safeImageRecords) {
    const pageNumber = Number(record.pageNumber) || 0;
    if (!imagesByPage.has(pageNumber)) {
      imagesByPage.set(pageNumber, []);
    }
    imagesByPage.get(pageNumber).push(record.path);
  }
  const imageRecordsByPage = new Map();
  for (const record of safeImageRecords) {
    const pageNumber = Number(record.pageNumber) || 0;
    if (!imageRecordsByPage.has(pageNumber)) {
      imageRecordsByPage.set(pageNumber, []);
    }
    imageRecordsByPage.get(pageNumber).push(record);
  }
  const pageContextMap = new Map(
    (Array.isArray(pageContexts) ? pageContexts : [])
      .filter((page) => Number(page?.number) > 0)
      .map((page) => [Number(page.number), page]),
  );

  const bboxCenter = (bbox = {}) => ({
    x: (Number(bbox.x0) + Number(bbox.x1)) / 2,
    y: (Number(bbox.y0) + Number(bbox.y1)) / 2,
  });

  const buildProductMatchText = (product = {}) => [
    String(product.code || '').trim(),
    String(product.name || '').trim(),
    String(product.description || '').trim(),
  ].filter(Boolean).join(' ').toLowerCase();

  const scoreTextBlockForProduct = (block = {}, product = {}) => {
    const text = String(block?.text || '').trim().toLowerCase();
    if (!text) return -1;
    const code = String(product.code || '').trim().toLowerCase();
    const name = String(product.name || '').trim().toLowerCase();
    let score = 0;
    if (code && text.includes(code)) score += 10;
    if (name && name !== 'unknown product') {
      const words = name.split(/\s+/).filter((part) => part.length >= 4);
      score += words.filter((word) => text.includes(word)).length * 2;
    }
    return score;
  };

  const usedImages = new Set();
  const productsByPage = new Map();
  for (const product of safeProducts) {
    const pageNumber = Number(product?.sourcePageNumber) || 0;
    if (!pageNumber) {
      continue;
    }
    if (!productsByPage.has(pageNumber)) {
      productsByPage.set(pageNumber, []);
    }
    productsByPage.get(pageNumber).push(product);
  }

  for (const [pageNumber, pageProducts] of productsByPage.entries()) {
    const pageContext = pageContextMap.get(pageNumber);
    const pageTextBlocks = Array.isArray(pageContext?.textBlocks) ? pageContext.textBlocks.filter((block) => block?.bbox) : [];
    const pageImageRecords = (imageRecordsByPage.get(pageNumber) || []).filter((record) => Array.isArray(record?.bboxes) && record.bboxes.length > 0);

    if (pageProducts.length > 1 && pageTextBlocks.length > 0 && pageImageRecords.length > 0) {
      for (const product of pageProducts) {
        const rankedBlocks = [...pageTextBlocks]
          .map((block) => ({ block, score: scoreTextBlockForProduct(block, product) }))
          .filter((entry) => entry.score > 0)
          .sort((left, right) => right.score - left.score);
        const bestBlock = rankedBlocks[0]?.block || null;
        if (!bestBlock?.bbox) {
          continue;
        }

        const blockCenter = bboxCenter(bestBlock.bbox);
        const rankedImages = pageImageRecords
          .map((record) => {
            const firstBox = record.bboxes[0];
            const imageCenter = bboxCenter(firstBox);
            const distance = Math.hypot(blockCenter.x - imageCenter.x, blockCenter.y - imageCenter.y);
            return {
              path: record.path,
              distance,
            };
          })
          .filter((entry) => !usedImages.has(entry.path))
          .sort((left, right) => left.distance - right.distance);

        const assigned = rankedImages.slice(0, 2).map((entry) => entry.path);
        if (assigned.length > 0) {
          product.imagePaths = [...new Set([...(product.imagePaths || []), ...assigned])];
          assigned.forEach((imagePath) => usedImages.add(imagePath));
        }
      }
    }

    const exactImages = (imagesByPage.get(pageNumber) || []).filter((imagePath) => !usedImages.has(imagePath));
    if (pageProducts.length === 1) {
      const singleAssigned = exactImages.length > 0
        ? exactImages.slice(0, 3)
        : [
            ...((imagesByPage.get(pageNumber - 1) || []).filter((imagePath) => !usedImages.has(imagePath))),
            ...((imagesByPage.get(pageNumber + 1) || []).filter((imagePath) => !usedImages.has(imagePath))),
          ].slice(0, 3);
      if (singleAssigned.length > 0) {
        pageProducts[0].imagePaths = [...new Set([...(pageProducts[0].imagePaths || []), ...singleAssigned])];
        singleAssigned.forEach((imagePath) => usedImages.add(imagePath));
      }
      continue;
    }

    if (exactImages.length > 0) {
      const imagesPerProduct = Math.max(1, Math.ceil(exactImages.length / pageProducts.length));
      pageProducts.forEach((product, index) => {
        const start = index * imagesPerProduct;
        const assigned = exactImages.slice(start, start + imagesPerProduct).slice(0, 3);
        if (assigned.length > 0) {
          product.imagePaths = [...new Set([...(product.imagePaths || []), ...assigned])];
          assigned.forEach((imagePath) => usedImages.add(imagePath));
        }
      });
      continue;
    }

    pageProducts.forEach((product) => {
      const nearbyAssigned = [
        ...((imagesByPage.get(pageNumber - 1) || []).filter((imagePath) => !usedImages.has(imagePath))),
        ...((imagesByPage.get(pageNumber + 1) || []).filter((imagePath) => !usedImages.has(imagePath))),
      ].slice(0, 2);
      if (nearbyAssigned.length > 0) {
        product.imagePaths = [...new Set([...(product.imagePaths || []), ...nearbyAssigned])];
        nearbyAssigned.forEach((imagePath) => usedImages.add(imagePath));
      }
    });
  }

  return safeProducts;
}

function assignPptxImagesToProducts(products = [], imageRecords = []) {
  const safeProducts = Array.isArray(products) ? products.map((product) => ({
    ...product,
    imagePaths: Array.isArray(product?.imagePaths) ? [...product.imagePaths] : [],
  })) : [];
  const orderedImages = Array.isArray(imageRecords)
    ? imageRecords.map((record) => record?.path).filter(Boolean)
    : [];

  if (safeProducts.length === 0 || orderedImages.length === 0) {
    return safeProducts;
  }

  let cursor = 0;
  for (const product of safeProducts) {
    if (product.imagePaths.length > 0) {
      continue;
    }
    const assigned = orderedImages.slice(cursor, cursor + 2);
    if (assigned.length > 0) {
      product.imagePaths = assigned;
      cursor += assigned.length;
    }
  }

  return safeProducts;
}

// ── 从PPT提取文本（通过Python） ─────────────────
async function parsePPT(filePath) {
  return new Promise((resolve, reject) => {
    const pythonRuntime = getPythonRuntime();
    if (!pythonRuntime) {
      resolve([]);
      return;
    }

    const pyScript = `
import json
import sys
from pptx import Presentation

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

prs = Presentation(sys.argv[1])
texts = []
for slide in prs.slides:
    for shape in slide.shapes:
        if not shape.has_text_frame:
            continue
        for para in shape.text_frame.paragraphs:
            t = para.text.strip()
            if t:
                texts.append(t)
print(json.dumps(texts, ensure_ascii=False))
`;
    const proc = spawn(
      pythonRuntime.command,
      [...pythonRuntime.args, '-c', pyScript, filePath],
      {
        windowsHide: true,
        env: runtimeResolver.getPythonSpawnEnv(pythonRuntime),
      },
    );
    let out = '';
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => console.error(d.toString()));
    proc.on('close', code => {
      if (code === 0) {
        try { resolve(JSON.parse(out)); } catch { resolve([]); }
      } else { resolve([]); }
    });
    proc.on('error', () => resolve([]));
  });
}

function extractJsonCandidate(text) {
  if (!text) return null;
  let cleaned = String(text).trim();
  cleaned = cleaned.replace(/^\uFEFF/, '');
  const assignmentMatch = cleaned.match(/(?:module\.exports|export\s+default|const\s+\w+|let\s+\w+|var\s+\w+)\s*=\s*([\s\S]+)/);
  if (assignmentMatch && assignmentMatch[1]) {
    cleaned = assignmentMatch[1].trim();
  }
  cleaned = cleaned.replace(/;\s*$/, '').trim();
  if (cleaned.startsWith('(') && cleaned.endsWith(')')) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  const firstBrace = cleaned.indexOf('{');
  const firstBracket = cleaned.indexOf('[');
  if (firstBrace === -1 && firstBracket === -1) return null;
  let start;
  let end;
  if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) {
    start = firstBracket;
    end = cleaned.lastIndexOf(']');
  } else {
    start = firstBrace;
    end = cleaned.lastIndexOf('}');
  }
  if (end <= start) return null;
  return cleaned.slice(start, end + 1).trim();
}

function parseJsonFileSafe(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    const candidate = extractJsonCandidate(raw);
    if (candidate) {
      try {
        return JSON.parse(candidate);
      } catch {
        // fall through
      }
    }
    const name = path.basename(filePath);
    throw new Error(`Invalid JSON in ${name}: ${error.message}`);
  }
}

// ── 从纯文本智能解析产品列表 ────────────────────
function parseProductsFromText(textLines, options = {}) {
  const products = [];
  const collectionSection = String(options.collectionSection || '').trim();
  const sourcePageNumber = Number(options.sourcePageNumber) || 0;
  
  // 尝试识别款号模式
  let currentProduct = null;
  let pendingBrand = null;
  
  for (const rawLine of textLines) {
    const line = rawLine.replace(/\s+/g, ' ').trim();
    if (!line) continue;

    if (isDocumentHeadingLine(line)) {
      if (currentProduct && currentProduct.code) {
        const finalized = finalizeProduct(currentProduct);
        if (finalized) products.push(finalized);
        currentProduct = null;
      }
      pendingBrand = null;
      continue;
    }

    const brandStyle = extractBrandAndStyle(line);
    if (brandStyle) {
      if (currentProduct && currentProduct.code) {
        const finalized = finalizeProduct(currentProduct);
        if (finalized) products.push(finalized);
      }
      currentProduct = {
        code: brandStyle.style,
        brand: brandStyle.brand,
        rawText: line,
        lines: [line],
        collectionSection,
        sourcePageNumber,
      };
      pendingBrand = null;
      continue;
    }

    if (looksLikeBrandLine(line)) {
      if (pendingBrand && line.length <= 4) {
        pendingBrand = `${pendingBrand} ${line}`;
      } else {
        pendingBrand = line;
      }
      continue;
    }

    const styleMatches = extractStyleTokenMatches(line);

    if (styleMatches.length > 1) {
      if (currentProduct && currentProduct.code) {
        const finalized = finalizeProduct(currentProduct);
        if (finalized) products.push(finalized);
      }
      const brand = pendingBrand || inferBrandFromText(line) || '';
      for (let index = 0; index < styleMatches.length; index += 1) {
        const currentMatch = styleMatches[index];
        const nextMatch = styleMatches[index + 1];
        const segment = line.slice(currentMatch.index, nextMatch ? nextMatch.index : line.length).trim();
        const segmentedProduct = finalizeProduct({
          code: currentMatch.token,
          brand,
          rawText: segment,
          lines: [segment],
          collectionSection,
          sourcePageNumber,
        });
        if (segmentedProduct) {
          products.push(segmentedProduct);
        }
      }
      currentProduct = null;
      pendingBrand = null;
    } else if (styleMatches.length === 1) {
      const styleToken = styleMatches[0].token;
      if (currentProduct && currentProduct.code) {
        const finalized = finalizeProduct(currentProduct);
        if (finalized) products.push(finalized);
      }
      const brand = pendingBrand || inferBrandFromText(line) || '';
      currentProduct = {
        code: styleToken,
        brand,
        rawText: line,
        lines: [line],
        collectionSection,
        sourcePageNumber,
      };
      pendingBrand = null;
    } else if (currentProduct) {
      currentProduct.lines.push(line);
      currentProduct.rawText += ' ' + line;
    }
  }
  
  // 保存最后一个
  if (currentProduct && currentProduct.code) {
    const finalized = finalizeProduct(currentProduct);
    if (finalized) products.push(finalized);
  }

  return dedupeProductsByCode(products);
}

function finalizeProduct(raw) {
  const text = raw.rawText;
  const lines = raw.lines;
  const collectionSection = String(raw.collectionSection || '').trim();
  const contextText = [collectionSection, text].filter(Boolean).join(' ');
  const sourceProfile = inferSourceProfileFromText(contextText);
  
  // 尝试提取名称（通常在款号后面或下一行）
  let name = pickBestName(lines);
  if (!name) {
    for (const line of lines) {
      const cleaned = sanitizeProductName(line);
      const hasLetter = /[A-Za-z\u4e00-\u9fff]/.test(cleaned);
      if (cleaned.length > 3 && cleaned.length < 80 && hasLetter && !/^\$/.test(cleaned)) {
        name = cleaned;
        break;
      }
    }
  }
  
  // 提取价格
  const priceMatch = text.match(/\$\s*[\d,.]+/);
  const price = priceMatch ? priceMatch[0] : '';
  
  const materials = extractMaterials(contextText);
  const category = inferCategory(name || contextText, contextText);
  const fit = inferFit(name || contextText, contextText);
  const features = extractFeatures(name || contextText, contextText);
  const style = inferStyle(name || contextText, contextText, features);
  
  const product = {
    code: raw.code,
    brand: raw.brand || inferBrandFromText(text) || '',
    name: sanitizeProductName(name) || 'Unknown Product',
    category,
    fit,
    materials: materials.length > 0 ? [...new Set(materials.map(m => m.charAt(0).toUpperCase() + m.slice(1)))] : ['Unknown'],
    price: classifyPrice(price),
    priceValue: price,
    features: features.length > 0 ? features : ['Standard Design'],
    style,
    attributes: [style, 'Versatile'],
    description: '',
    compositionText: extractCompositionText(text),
    collectionSection,
    sourceProfile,
    sourcePageNumber: Number(raw.sourcePageNumber) || 0,
  };

  product.description = buildProductDescription(product, { ...raw, rawText: text, sourceProfile });

  const hasLetters = /[A-Za-z\u4e00-\u9fff]/.test(text || '');
  const hasMeaningfulName = product.name && product.name !== 'Unknown Product' && !isCoverLike(product.name);
  const hasCategoryHint = containsCategoryKeyword(text);
  const hasMaterial = Array.isArray(product.materials) && product.materials.some(m => m && m !== 'Unknown');
  const hasPrice = !!product.priceValue;

  if (!hasLetters || (!hasMeaningfulName && !hasCategoryHint && !hasMaterial && !hasPrice)) {
    return null;
  }

  return product;
}

function mergeProducts(primary, incoming) {
  const merged = { ...primary };
  if (!merged.name || merged.name === 'Unknown Product' || (incoming.name && incoming.name.length > merged.name.length)) {
    merged.name = sanitizeProductName(incoming.name) || incoming.name;
  }
  if (!merged.brand && incoming.brand) merged.brand = incoming.brand;
  if ((merged.category === 'Other' || !merged.category) && incoming.category) merged.category = incoming.category;
  if (!merged.fit && incoming.fit) merged.fit = incoming.fit;
  if (!merged.style && incoming.style) merged.style = incoming.style;

  const materials = [...new Set([...(merged.materials || []), ...(incoming.materials || [])])];
  const filteredMaterials = materials.filter(m => m && m !== 'Unknown');
  merged.materials = filteredMaterials.length > 0 ? filteredMaterials : materials;

  const features = [...new Set([...(merged.features || []), ...(incoming.features || [])])];
  merged.features = features.length > 0 ? features : merged.features;

  if (!merged.priceValue && incoming.priceValue) merged.priceValue = incoming.priceValue;
  if (merged.price === 'Unknown' && incoming.price) merged.price = incoming.price;
  if (!merged.compositionText && incoming.compositionText) merged.compositionText = incoming.compositionText;
  if (!merged.collectionSection && incoming.collectionSection) merged.collectionSection = incoming.collectionSection;

  if ((incoming.description || '').length > (merged.description || '').length) {
    merged.description = incoming.description;
  }
  return merged;
}

function dedupeProductsByCode(products) {
  const map = new Map();
  for (const p of products) {
    const code = String(p.code || '').trim();
    if (!code) continue;
    if (!map.has(code)) {
      map.set(code, p);
    } else {
      map.set(code, mergeProducts(map.get(code), p));
    }
  }
  return Array.from(map.values());
}

function flattenInfoValue(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value).trim();
  }
  if (Array.isArray(value)) {
    return value.map((item) => flattenInfoValue(item)).filter(Boolean).join(', ');
  }
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([key, item]) => {
        const flattened = flattenInfoValue(item);
        return flattened ? `${key}: ${flattened}` : '';
      })
      .filter(Boolean)
      .join('; ');
  }
  return '';
}

function buildFolderContextBlock(folderName, info, product, imageFiles = []) {
  const lines = [
    `Folder: ${folderName}`,
    `Style number: ${product.code || info.styleNumber || ''}`,
    `Name: ${product.name || info.name || ''}`,
    `Brand: ${product.brand || info.brand || info.brandName || ''}`,
    `Category: ${product.category || ''}`,
    `Fit: ${product.fit || ''}`,
    `Price: ${product.priceValue || info.price || ''}`,
    `Materials: ${Array.isArray(product.materials) ? product.materials.join(', ') : ''}`,
    `Composition: ${product.compositionText || buildCompositionText(info.composition) || ''}`,
    `Description: ${product.description || info.description || ''}`,
  ];

  const importantFields = [
    ['Color', info.color],
    ['Colors', info.colors],
    ['Features', info.features],
    ['Details', info.details],
    ['Attributes', info.attributes],
    ['Occasion', info.occasion],
    ['Care', info.care],
  ];

  for (const [label, value] of importantFields) {
    const flattened = flattenInfoValue(value);
    if (flattened) {
      lines.push(`${label}: ${flattened}`);
    }
  }

  if (imageFiles.length > 0) {
    lines.push(`Images: ${imageFiles.map((filePath) => path.basename(filePath)).join(', ')}`);
  }

  const rawJson = JSON.stringify(info, null, 2);
  if (rawJson) {
    lines.push(`Raw info:\n${rawJson}`);
  }

  return lines.filter(Boolean).join('\n');
}

function buildFolderTextContextBlock(folderName, product, sourceText, imageFiles = []) {
  const lines = [
    `Folder: ${folderName}`,
    `Style number: ${product.code || folderName || ''}`,
    `Name: ${product.name || ''}`,
    `Brand: ${product.brand || ''}`,
    `Category: ${product.category || ''}`,
    `Fit: ${product.fit || ''}`,
    `Price: ${product.priceValue || ''}`,
    `Materials: ${Array.isArray(product.materials) ? product.materials.join(', ') : ''}`,
    `Composition: ${product.compositionText || ''}`,
    `Description: ${product.description || ''}`,
  ];

  if (imageFiles.length > 0) {
    lines.push(`Images: ${imageFiles.map((filePath) => path.basename(filePath)).join(', ')}`);
  }

  if (sourceText) {
    lines.push(`Source text:\n${sourceText}`);
  }

  return lines.filter(Boolean).join('\n');
}

function buildFallbackProductFromText(text, folderName, brandHint = '') {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const joined = lines.join(' ');
  const featureList = extractFeatures(folderName, joined);
  const materials = extractMaterials(joined);
  const name = pickBestName(lines) || folderName || 'Unknown Product';

  return {
    code: extractStyleToken(joined) || folderName || '',
    brand: brandHint || inferBrandFromText(joined) || '',
    name,
    category: inferCategory(name, joined),
    fit: inferFit(name, joined),
    materials: materials.length > 0 ? [...new Set(materials.map((item) => item.charAt(0).toUpperCase() + item.slice(1)))] : ['Unknown'],
    price: classifyPrice(joined),
    priceValue: (joined.match(/\$\s*[\d,.]+/) || [])[0] || '',
    features: featureList.length > 0 ? featureList : ['Standard Design'],
    style: inferStyle(name, joined, featureList),
    attributes: ['Versatile'],
    description: joined.slice(0, 220),
    compositionText: extractCompositionText(joined),
  };
}

function pickFolderProduct(products, folderName, brandHint = '') {
  if (!Array.isArray(products) || products.length === 0) {
    return null;
  }

  const normalizedFolder = normalizeCodeToken(folderName);
  const normalizedBrand = normalizeCodeToken(brandHint);

  return [...products].sort((left, right) => {
    const leftCodeMatch = normalizeCodeToken(left.code) === normalizedFolder ? 1 : 0;
    const rightCodeMatch = normalizeCodeToken(right.code) === normalizedFolder ? 1 : 0;
    if (leftCodeMatch !== rightCodeMatch) {
      return rightCodeMatch - leftCodeMatch;
    }

    const leftBrandMatch = normalizedBrand && normalizeCodeToken(left.brand) === normalizedBrand ? 1 : 0;
    const rightBrandMatch = normalizedBrand && normalizeCodeToken(right.brand) === normalizedBrand ? 1 : 0;
    if (leftBrandMatch !== rightBrandMatch) {
      return rightBrandMatch - leftBrandMatch;
    }

    return String(right.description || '').length - String(left.description || '').length;
  })[0];
}

function isWeakFolderProduct(product, folderName) {
  if (!product) {
    return true;
  }

  const normalizedCode = normalizeCodeToken(product.code);
  const normalizedFolder = normalizeCodeToken(folderName);
  const name = String(product.name || '').trim();
  const brand = String(product.brand || '').trim();

  if (!name || name === 'Unknown Product') {
    return true;
  }
  if (looksLikeMaterialOnlyName(name)) {
    return true;
  }

  if (/^(color|colour)\s*[:|]/i.test(name)) {
    return true;
  }

  if (/tightenfactor\d*/i.test(name) || /tightenfactor\d*/i.test(brand)) {
    return true;
  }

  if (brand.length > 80) {
    return true;
  }

  if (normalizedCode.length <= 1) {
    return true;
  }

  if (normalizedFolder && normalizedCode && normalizedCode === normalizedFolder) {
    return false;
  }

  return false;
}

function parseFromFolderWithContext(folderPath) {
  const products = [];
  const contextBlocks = [];
  const rootBrandHint = looksLikeBrandLine(path.basename(folderPath).replace(/[_-]/g, ' '))
    ? path.basename(folderPath).trim()
    : '';
  const productFolders = collectProductFolders(folderPath);

  for (const itemPath of productFolders) {
    const folderName = path.basename(itemPath);
    const parentBrandHint = looksLikeBrandLine(path.basename(path.dirname(itemPath)).replace(/[_-]/g, ' '))
      ? path.basename(path.dirname(itemPath)).trim()
      : rootBrandHint;
    const { imageFiles, infoFiles } = getFolderFileGroups(itemPath, folderName);

    if (infoFiles.length === 0 && imageFiles.length === 0) {
      continue;
    }

    try {
      const primaryInfoFile = infoFiles[0] || '';

      if (primaryInfoFile.toLowerCase().endsWith('.json')) {
        const info = parseJsonFileSafe(primaryInfoFile);
        const rawProduct = Array.isArray(info) ? info[0] : info;
        const product = parseFromInfoJson(rawProduct);
        product.imagePaths = imageFiles;
        product.sourceFolder = itemPath;
        product.code = product.code || folderName;
        product.brand = product.brand || parentBrandHint || '';
        products.push(product);
        contextBlocks.push(buildFolderContextBlock(folderName, rawProduct, product, imageFiles));
        continue;
      }

      if (primaryInfoFile) {
        const sourceText = readTextFileWithFallback(primaryInfoFile);
        const sourceLines = sourceText
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        const parsedProducts = dedupeProductsByCode(parseProductsFromText(sourceLines));
        const fallbackProduct = buildFallbackProductFromText(sourceText, folderName, parentBrandHint);
        const candidateProduct = pickFolderProduct(parsedProducts, folderName, parentBrandHint);
        const product = isWeakFolderProduct(candidateProduct, folderName)
          ? fallbackProduct
          : candidateProduct;
        product.imagePaths = imageFiles;
        product.sourceFolder = itemPath;
        product.code = product.code || folderName;
        product.brand = product.brand || parentBrandHint || '';
        products.push(product);
        contextBlocks.push(buildFolderTextContextBlock(folderName, product, sourceText, imageFiles));
        continue;
      }

      const product = buildFallbackProductFromText(folderName, folderName, parentBrandHint);
      product.imagePaths = imageFiles;
      product.sourceFolder = itemPath;
      products.push(product);
      contextBlocks.push(buildFolderTextContextBlock(folderName, product, '', imageFiles));
    } catch (e) {
      console.error(`Error parsing ${folderName}:`, e.message);
    }
  }

  const sourceText = contextBlocks.join('\n\n---\n\n');
  const sourceLines = sourceText
    ? sourceText.split('\n').map((line) => line.trim()).filter(Boolean)
    : [];

  return { products, sourceText, sourceLines };
}

// ── 从Scraper输出文件夹解析 ─────────────────────
function parseFromFolder(folderPath) {
  return parseFromFolderWithContext(folderPath).products;
}

// ── 主入口：解析任意来源 ────────────────────────
async function parseProducts(sourcePath) {
  const parsed = await parseProductsWithContext(sourcePath);
  return parsed.products;
}

// ── 解析并返回上下文（文本/图片） ─────────────────
async function parseProductsWithContext(sourcePath, options = {}) {
  const ensureActive = options.ensureActive || (() => {});
  const emitLog = options.emitLog || (() => {});
  const ext = path.extname(sourcePath).toLowerCase();
  const stat = fs.statSync(sourcePath);

  if (stat.isDirectory()) {
    const parsed = parseFromFolderWithContext(sourcePath);
    let products = parsed.products;
    let sourceText = parsed.sourceText;
    let sourceLines = parsed.sourceLines;
    let imagePaths = [];
    let imageRecords = [];
    let ocrText = '';

    const selectedImagePaths = selectFolderImagesForOcr(products);
    if (selectedImagePaths.length > 0) {
      const folderImageContext = await buildFolderImageContext(selectedImagePaths, {
        ensureActive,
        emitLog,
        maxImages: selectedImagePaths.length,
        persistKey: sourcePath,
        ocrMode: 'explicit-labels',
        ocrEngine: options.ocrEngine,
        ocrFallbackEngine: options.ocrFallbackEngine,
      });
      imagePaths = [...new Set(folderImageContext.imagePaths || selectedImagePaths)];
      imageRecords = Array.isArray(folderImageContext.imageRecords) ? folderImageContext.imageRecords : [];
      ocrText = folderImageContext.ocrText || '';
      if (ocrText) {
        sourceText = appendSourceContext(sourceText, 'Folder label image OCR', ocrText);
        sourceLines = splitNormalizedLines(sourceText);
        emitLog('Recovered OCR context from explicit label image(s) in the folder source.', 'success');
      }
    }

    return {
      products,
      sourceType: 'folder',
      sourceText,
      sourceLines,
      imagePaths,
      imageRecords,
      ocrText,
      multimodalAugmented: Boolean(ocrText || imagePaths.length > 0),
      sourceProfile: inferSourceProfileFromText(sourceText, products),
    };
  }

  if (ext === '.pdf') {
    const document = await parsePdfDocument(sourcePath, { emitLog });
    ensureActive();
    const pageSectionMap = buildPdfSectionMap(Array.isArray(document.pages) ? document.pages : []);
    const pageProducts = Array.isArray(document.pages)
      ? document.pages.flatMap((page) => parseProductsFromText(page.lines || [], {
          collectionSection: pageSectionMap.get(Number(page?.number) || 0) || '',
          sourcePageNumber: Number(page?.number) || 0,
        }))
      : [];
    const lines = document.text.split('\n').map((line) => normalizePdfLikeLine(line)).filter((line) => line.length > 0);
    let products = dedupeProductsByCode([...pageProducts, ...parseProductsFromText(lines)]);
    const processingPlan = buildPdfProcessingPlan(document, products);
    let sourceText = document.text;
    let sourceLines = lines;
    let imagePaths = [];
    let imageRecords = [];
    let ocrText = '';

    emitLog(
      `PDF preflight: ${processingPlan.pageCount} page(s), ${processingPlan.textPageCount} with text, ${processingPlan.productLikePageNumbers.length} product-like page(s), ${processingPlan.weakPageNumbers.length} OCR fallback page(s).`,
      'info',
    );

    if (processingPlan.productLikePageNumbers.length > 0) {
      const pdfImageContext = await buildPdfEmbeddedImageContext(sourcePath, {
        ensureActive,
        emitLog,
        maxImages: processingPlan.maxEmbeddedImages,
        maxImagesPerPage: processingPlan.maxImagesPerPage,
        pageNumbers: processingPlan.productLikePageNumbers,
        persistKey: sourcePath,
        ocrMode: 'none',
        ocrEngine: options.ocrEngine,
        ocrFallbackEngine: options.ocrFallbackEngine,
      });
      imagePaths = [...pdfImageContext.imagePaths];
      imageRecords = Array.isArray(pdfImageContext.imageRecords) ? pdfImageContext.imageRecords : [];
      if (pdfImageContext.ocrText) {
        ocrText = pdfImageContext.ocrText;
        sourceText = appendSourceContext(sourceText, 'PDF embedded image OCR', pdfImageContext.ocrText);
        sourceLines = splitNormalizedLines(sourceText);
        emitLog(`Recovered OCR context from ${pdfImageContext.imageCount} embedded PDF image(s).`, 'success');
      }
    }

    if (processingPlan.weakPageNumbers.length > 0) {
      emitLog(`PDF text layer looks incomplete on ${processingPlan.weakPageNumbers.length} page(s). Running OCR fallback on pages ${processingPlan.weakPageNumbers.join(', ')}...`, 'info');
      const fallback = await extractPdfProductsFromPageOcr(sourcePath, processingPlan.weakPageNumbers, {
        ensureActive,
        emitLog,
        existingProducts: products,
        ocrEngine: options.ocrEngine,
        ocrFallbackEngine: options.ocrFallbackEngine,
      });
      ensureActive();
      if (fallback.products.length > 0) {
        products = dedupeProductsByCode([...products, ...fallback.products]);
        imagePaths = [...new Set([...imagePaths, ...(fallback.imagePaths || [])])];
        if (fallback.text) {
          sourceText = [sourceText, 'PDF page OCR', fallback.text].filter(Boolean).join('\n\n');
          sourceLines = splitNormalizedLines(sourceText);
          ocrText = [ocrText, fallback.text].filter(Boolean).join('\n\n');
        }
        emitLog(`PDF OCR fallback recovered ${fallback.products.length} product candidates; ${products.length} total styles after merge.`, 'success');
      } else {
        emitLog('PDF OCR fallback did not recover additional styles.', 'info');
      }
    }

    products = assignPdfImagesToProducts(products, imageRecords, document.pages);

    return {
      products,
      sourceType: 'pdf',
      sourceText,
      sourceLines,
      imagePaths,
      imageRecords,
      pageContexts: Array.isArray(document.pages)
        ? document.pages.map((page) => ({
            number: Number(page?.number) || 0,
            text: String(page?.text || '').trim(),
            lines: Array.isArray(page?.lines)
              ? page.lines.map((line) => String(line || '').trim()).filter(Boolean)
              : [],
            imageCount: Number(page?.imageCount || 0),
          }))
        : [],
      ocrText,
      multimodalAugmented: Boolean(ocrText || imagePaths.length > 0),
      sourceProfile: inferSourceProfileFromText(sourceText, products),
    };
  }

  if (ext === '.pptx') {
    const lines = await parsePPT(sourcePath);
    let products = parseProductsFromText(lines);
    let sourceText = lines.join('\n');
    let sourceLines = lines;
    let imagePaths = [];
    let imageRecords = [];
    let ocrText = '';

    const pptxImageContext = await buildPptxImageContext(sourcePath, {
      ensureActive,
      emitLog,
      maxImages: 120,
      persistKey: sourcePath,
      ocrMode: 'none',
      ocrEngine: options.ocrEngine,
      ocrFallbackEngine: options.ocrFallbackEngine,
    });
    imagePaths = [...pptxImageContext.imagePaths];
    imageRecords = Array.isArray(pptxImageContext.imageRecords) ? pptxImageContext.imageRecords : [];
    if (pptxImageContext.ocrText) {
      ocrText = pptxImageContext.ocrText;
      sourceText = appendSourceContext(sourceText, 'PPTX image OCR', pptxImageContext.ocrText);
      sourceLines = splitNormalizedLines(sourceText);
      emitLog(`Recovered OCR context from ${pptxImageContext.imageCount} PPTX image(s).`, 'success');
    }

    products = assignPptxImagesToProducts(products, imageRecords);

    return {
      products,
      sourceType: 'pptx',
      sourceText,
      sourceLines,
      imagePaths,
      imageRecords,
      ocrText,
      multimodalAugmented: Boolean(ocrText || imagePaths.length > 0),
      sourceProfile: inferSourceProfileFromText(sourceText, products),
    };
  }

  if (ext === '.json') {
    const data = parseJsonFileSafe(sourcePath);
    if (Array.isArray(data)) {
      return {
        products: data.map((item) => parseFromInfoJson(item)),
        sourceType: 'json',
        sourceText: '',
        sourceLines: [],
        imagePaths: [],
        ocrText: '',
        multimodalAugmented: false,
        sourceProfile: 'apparel',
      };
    }
    return {
      products: [parseFromInfoJson(data)],
      sourceType: 'json',
      sourceText: '',
      sourceLines: [],
      imagePaths: [],
      ocrText: '',
      multimodalAugmented: false,
      sourceProfile: 'apparel',
    };
  }

  return {
    products: [],
    sourceType: 'unknown',
    sourceText: '',
    sourceLines: [],
    imagePaths: [],
    ocrText: '',
    multimodalAugmented: false,
    sourceProfile: 'apparel',
  };
}

module.exports = {
  parseProducts,
  parseProductsWithContext,
  parseFromFolder,
  parseFromInfoJson,
  classifyPrice,
  extractMaterials,
  inferCategory,
  inferCategoryHierarchy,
  inferFit,
  extractFeatures,
  inferStyle,
  inferSourceProfileFromText,
  buildCompositionText,
  extractCompositionText,
  sanitizeProductName,
  extractStyleTokensFromText,
  stripRtfToText,
  appendSourceContext,
};

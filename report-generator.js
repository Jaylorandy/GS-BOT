/**
 * Product Analysis Report Generator v4
 * ZARA Menswear / Womenswear templates
 * Hybrid AI + script analysis with optional vision inputs
 */

const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, HeadingLevel, BorderStyle, WidthType,
  ShadingType, VerticalAlign, PageNumber } = require('docx');
const fs = require('fs');
const path = require('path');
const LLMClient = require('./llm-client');
const { buildApparelVisionSummary, describeApparelImages } = require('./apparel-vision-service');
const { readFileOperationCache, writeFileOperationCache } = require('./processing-cache');
const productParser = require('./product-parser');

let sharp = null;
try {
  sharp = require('sharp');
} catch {
  sharp = null;
}

// ── 样式常量 ────────────────────────────────────
const BRAND_COLOR = "2C5F7C";
const LIGHT_BG = "F5F8FA";
const TB = { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" };
const CB = { top: TB, bottom: TB, left: TB, right: TB };
const FONT = "Arial";

// ── 工具函数 ────────────────────────────────────
function hCell(text, w) {
  return new TableCell({
    borders: CB, width: { size: w, type: WidthType.DXA },
    shading: { fill: BRAND_COLOR, type: ShadingType.CLEAR },
    verticalAlign: VerticalAlign.CENTER,
    children: [new Paragraph({ alignment: AlignmentType.CENTER,
      children: [new TextRun({ text, bold: true, color: "FFFFFF", size: 22, font: FONT })] })]
  });
}

function dCell(text, w, align = AlignmentType.LEFT) {
  return new TableCell({
    borders: CB, width: { size: w, type: WidthType.DXA },
    children: [new Paragraph({ alignment: align,
      children: [new TextRun({ text: String(text || ''), size: 20, font: FONT })] })]
  });
}

function h1(text) {
  return new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 400, after: 200 },
    children: [new TextRun({ text, font: FONT })] });
}

function h2(text) {
  return new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 300, after: 150 },
    children: [new TextRun({ text, font: FONT })] });
}

function body(text, opts = {}) {
  return new Paragraph({ spacing: { after: 200 }, ...(opts.indent ? { indent: { left: opts.indent } } : {}),
    children: [new TextRun({ text, size: 22, font: FONT, bold: opts.bold || false, italics: opts.italic || false, color: opts.color || "333333" })] });
}

function bullet(text) {
  return new Paragraph({ spacing: { after: 100 }, bullet: { level: 0 },
    children: [new TextRun({ text, size: 22, font: FONT })] });
}

function numberedItem(index, text) {
  return new Paragraph({ spacing: { after: 120 },
    children: [new TextRun({ text: `${index}. ${text}`, size: 22, font: FONT })] });
}

function clusterParagraph(index, title, description) {
  return new Paragraph({ spacing: { after: 140 },
    children: [
      new TextRun({ text: `${index}. ${title}`, bold: true, size: 22, font: FONT }),
      new TextRun({ text: ` ${description}`, size: 22, font: FONT })
    ]
  });
}

function spacer() { return new Paragraph({ spacing: { after: 120 }, children: [] }); }

function smallText(text, align = AlignmentType.LEFT) {
  return new Paragraph({ alignment: align, spacing: { after: 120 },
    children: [new TextRun({ text, size: 18, font: FONT, color: '666666' })] });
}

function pageBreak() {
  return new Paragraph({ children: [], pageBreakBefore: true });
}


function centeredText(text, size, color = "666666", bold = false) {
  return new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 60 },
    children: [new TextRun({ text, size, bold, font: FONT, color })] });
}

function countByList(items) {
  const m = {};
  for (const v of items) {
    const key = v || 'Unknown';
    m[key] = (m[key] || 0) + 1;
  }
  return Object.entries(m).sort((a, b) => b[1] - a[1]);
}

function countBy(products, key) {
  const m = {};
  for (const p of products) {
    const v = Array.isArray(p[key]) ? p[key].join(', ') : (p[key] || 'Unknown');
    m[v] = (m[v] || 0) + 1;
  }
  return Object.entries(m).sort((a, b) => b[1] - a[1]);
}

function countArr(products, key) {
  const m = {};
  for (const p of products) {
    const arr = Array.isArray(p[key]) ? p[key] : [p[key]];
    for (const v of arr) { if (v) m[v] = (m[v] || 0) + 1; }
  }
  return Object.entries(m).sort((a, b) => b[1] - a[1]);
}

function pct(c, t) { return t > 0 ? `${Math.round(c / t * 100)}%` : '0%'; }

function inferBrandLineFromSource(options = {}, sourcePath = '', sourceText = '') {
  if (options.brandName && options.brandName.trim()) {
    return options.brandName.trim();
  }

  const sourceName = path.basename(String(sourcePath || ''), path.extname(String(sourcePath || '')));
  const haystack = `${sourceName} ${String(sourceText || '').slice(0, 1500)}`
    .replace(/[’]/g, "'")
    .trim();
  const knownBrands = [
    "ZARA",
    "COLIN'S",
    'H&M',
    'BERSHKA',
    "LEVI'S",
    'LEE',
    'DENHAM',
    'RESERVED',
    'M&S',
    'ABERCROMBIE & FITCH',
  ];

  for (const brand of knownBrands) {
    const pattern = new RegExp(brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    if (pattern.test(haystack)) {
      return brand;
    }
  }

  const cleaned = sourceName
    .replace(/\b(product|analysis|report|meeting|notes|lookbook|collection|menswear|womenswear|ss|fw|aw)\b/gi, ' ')
    .replace(/\b20\d{2}\b/g, ' ')
    .replace(/[._-]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return cleaned || 'Apparel Collection';
}

// ── 模版与解析 ─────────────────────────────────
function normalizeTemplate(input) {
  const v = String(input || '').toLowerCase();
  if (v.includes('adaptive') || v.includes('flexible') || v.includes('dynamic')) return 'adaptive';
  if (v.includes('single') || v.includes('one')) return 'single-brand';
  if (v.includes('multi') || v.includes('multi-brand') || v.includes('best seller') || v.includes('best-seller') || v.includes('by brand') || v.includes('brand analysis')) return 'multi-brand';
  if (v.includes('men')) return 'single-brand'; // Merge men/women into single-brand
  if (v.includes('women')) return 'single-brand';
  return 'auto';
}

function inferTemplateType(options, products, sourceText, sourcePath) {
  const explicit = normalizeTemplate(options.template || '');
  if (explicit === 'adaptive' || explicit === 'single-brand' || explicit === 'multi-brand') return explicit;

  const hay = `${options.title || ''} ${sourceText || ''} ${sourcePath || ''}`.toLowerCase();
  if (hay.includes('best seller') || hay.includes('by brand') || hay.includes('key trends') || hay.includes('brand analysis')) return 'multi-brand';
  if (hay.includes('single') || hay.includes('one brand')) return 'adaptive';
  if (hay.includes('menswear') || hay.includes('women') || hay.includes('men')) return 'single-brand';

  const brandCount = new Set(products.map(p => (p.brand || '').trim()).filter(Boolean)).size;
  if (brandCount > 1) return 'multi-brand';

  // Default to a flexible apparel report instead of a rigid single-brand template.
  return 'adaptive';
}


function inferCollectionLabel(options, sourceText) {
  if (options.collectionLabel && options.collectionLabel.trim()) return options.collectionLabel.trim();
  const text = `${options.title || ''} ${sourceText || ''}`;
  const match = text.match(/\b(SS|FW|AW|Spring|Summer|Fall|Autumn|Winter)\s*20\d{2}\b/i);
  if (match) {
    const raw = match[0].replace(/\s+/g, ' ').trim();
    if (/spring|summer/i.test(raw)) return `SS ${raw.match(/20\d{2}/)[0]}`;
    if (/fall|autumn|winter/i.test(raw)) return `FW ${raw.match(/20\d{2}/)[0]}`;
    return raw.toUpperCase().replace('AW', 'FW');
  }
  const yearMatch = text.match(/\b20\d{2}\b/);
  if (yearMatch) return yearMatch[0];
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const season = (month >= 3 && month <= 8) ? 'SS' : 'FW';
  return `${season} ${year}`;
}

function categorizeForTemplate(product, template) {
  if (product?.subcategory) {
    return product.subcategory;
  }
  const name = (product.name || '').toLowerCase();
  const category = (product.category || '').toLowerCase();

  // Single-brand template - unified categorization for both men and women
  if (template === 'adaptive' || template === 'single-brand' || template === 'menswear' || template === 'womenswear') {
    if (product.category && product.category !== 'Other') return product.category;
    // Outerwear
    if (name.includes('jacket') || name.includes('coat') || name.includes('parka') || name.includes('blazer') || name.includes('windbreaker') || name.includes('bomber')) return 'Outerwear';
    // Tops
    if (name.includes('shirt') || name.includes('blouse') || name.includes('top') || name.includes('polo') || name.includes('t-shirt') || name.includes('tshirt') || name.includes('tee') || name.includes('sweater') || name.includes('cardigan') || name.includes('hoodie') || name.includes(' sweatshirt')) return 'Tops';
    // Dresses
    if (name.includes('dress') || name.includes('jumpsuit') || name.includes('playsuit') || name.includes('overall')) return 'Dresses';
    // Bottoms
    if (name.includes('pant') || name.includes('trouser') || name.includes('jean') || name.includes('denim') || name.includes('chino') || name.includes('short') || name.includes('skirt')) return 'Bottoms';
    // Accessories
    if (name.includes('bag') || name.includes('hat') || name.includes('scarf') || name.includes('belt') || name.includes('glove') || name.includes('cap') || name.includes('sneaker') || name.includes('shoe') || name.includes('boot') || name.includes('heel') || name.includes('sandal')) return 'Accessories';
    // Underwear/Lounge
    if (name.includes('underwear') || name.includes('bra') || name.includes('brief') || name.includes('boxer') || name.includes('panty') || name.includes('sock') || name.includes('pajama') || name.includes('night') || name.includes('lingerie')) return 'Underwear & Lounge';
    if (category.includes('outer')) return 'Outerwear';
    if (category.includes('bottom')) return 'Bottoms';
    if (category.includes('top')) return 'Tops';
    if (category.includes('accessory')) return 'Accessories';
    return product.category || 'Other';
  }

  if (template === 'menswear') {
    if (name.includes('overshirt')) return 'Overshirts';
    if (name.includes('shirt')) return 'Shirts';
    if (name.includes('jacket') || name.includes('coat') || name.includes('parka') || name.includes('blazer')) return 'Jackets';
    if (name.includes('chino')) return 'Chino Pants';
    if (name.includes('jogger') || name.includes('technical') || name.includes('cargo') || name.includes('track')) return 'Jogger & Technical Pants';
    if (name.includes('jean')) return 'Jeans';
    if (category.includes('outer')) return 'Jackets';
    if (category.includes('bottom')) return 'Pants';
    if (category.includes('top')) return 'Shirts';
    return product.category || 'Other';
  }

  if (name.includes('blazer') || name.includes('jacket') || name.includes('coat')) return 'Blazer / Outerwear';
  if (name.includes('jean') || name.includes('denim')) return 'Jeans (Denim)';
  if (name.includes('shirt') || name.includes('top') || name.includes('blouse')) return 'Shirt / Top';
  if (name.includes('dress')) return 'Dress';
  return product.category || 'Other';
}

function getPrimaryCategory(product) {
  return String(product?.primaryCategory || '').trim()
    || String(product?.category || '').trim()
    || 'Other';
}

function getSubcategory(product) {
  return String(product?.subcategory || '').trim()
    || String(product?.category || '').trim()
    || 'Other';
}

function wearGroup(category) {
  const c = String(category || '').toLowerCase();
  if (/(pant|jean|short|skirt)/.test(c)) return 'Bottom Wear';
  return 'Top Wear';
}

function normalizeMensFit(product) {
  const text = `${product.fit || ''} ${product.name || ''}`.toLowerCase();
  if (/relaxed|oversized/.test(text)) return 'Relaxed Fit';
  if (/regular|standard/.test(text)) return 'Regular Fit';
  if (/cropped/.test(text)) return 'Cropped Fit';
  if (/skinny|slim/.test(text)) return 'Skinny / Slim Fit';
  if (/wide|barrel/.test(text)) return 'Wide / Barrel Fit';
  if (/jogger|balloon/.test(text)) return 'Jogger / Balloon Fit';
  if (/boxy|straight|flare/.test(text)) return 'Boxy / Straight / Flare';
  return 'Fit not specified';
}

function fitLabelForListing(product, template) {
  const raw = (product.fit || '').trim();
  if (raw) return raw.replace(/\bFit\b/i, '').trim() || raw;
  if (template === 'womenswear') return inferWomensFitType(product);
  return normalizeMensFit(product).replace(/ Fit$/, '');
}

function inferWomensFitType(product) {
  const text = `${product.name || ''} ${product.fit || ''}`.toLowerCase();
  if (text.includes('oversized')) return 'Oversized';
  if (text.includes('bootcut')) return 'Bootcut Mid-Rise';
  if (text.includes('wide leg') || text.includes('wide')) return 'Loose Wide Leg';
  if (text.includes('straight')) return 'Mid-Rise Straight';
  if (text.includes('short') || text.includes('cropped')) return 'Short / Cropped';
  if (text.includes('mid-rise')) return 'Mid-Rise';
  return (product.fit || 'Regular').replace(/\bFit\b/i, '').trim();
}

function inferSilhouetteCharacter(product) {
  const text = `${product.name || ''} ${product.fit || ''}`.toLowerCase();
  if (text.includes('blazer')) return 'Volume-driven, power dressing';
  if (text.includes('bootcut')) return 'Retro-inspired, refined';
  if (text.includes('wide leg') || text.includes('wide')) return 'Maximum volume and ease';
  if (text.includes('straight')) return 'Structured, youthful';
  if (text.includes('short') || text.includes('cropped')) return 'Warm-weather, relaxed proportion';
  return 'Versatile silhouette';
}

function inferStyleAttributes(product) {
  const text = `${product.name || ''} ${product.description || ''} ${(product.features || []).join(' ')} ${(product.materials || []).join(' ')}`.toLowerCase();
  const attrs = [];
  if (/technical|functional|utility|performance|coating|waterproof/.test(text)) attrs.push('Functional / Technical');
  if (/casual|relaxed|comfortable|easy|basic|everyday/.test(text)) attrs.push('Casual / Comfortable');
  if (/vintage|heritage|denim|flannel|houndstooth|plaid|checked/.test(text)) attrs.push('Vintage / Heritage');
  if (/urban|modern|clean|minimal/.test(text)) attrs.push('Urban / Modern');
  if (/premium|refined|wool|viscose|linen|suede/.test(text)) attrs.push('Premium / Refined');
  if (/street|graphic|oversized|distressed/.test(text)) attrs.push('Streetwear / Individual');
  return attrs.length > 0 ? attrs : ['Casual / Comfortable'];
}

function inferSubBrand(product) {
  const name = (product.name || '').toUpperCase();
  if (name.includes('TRF')) return 'TRF (Trafaluc)';
  if (name.includes('ZW')) return 'ZW Collection';
  if (name.includes('Z1975')) return 'Z1975';
  return 'ZARA (main)';
}

function defaultSubBrandPositioning(subBrand) {
  if (subBrand.includes('TRF')) return 'Younger demographic, trend-forward, street-influenced';
  if (subBrand.includes('ZW')) return 'Premium denim tier, craftsmanship, semi-formal';
  if (subBrand.includes('Z1975')) return 'Heritage line, timeless silhouette, sustainable innovation';
  return 'Core brand, versatile, cross-occasion';
}

function formatComposition(product) {
  if (product.compositionText && product.compositionText.trim()) return product.compositionText.trim();
  if (Array.isArray(product.materials) && product.materials.length > 0) return product.materials.join(', ');
  return product.materials || product.description || 'N/A';
}

function extractSpecialFinishes(products) {
  const text = products.map(p => `${p.name || ''} ${p.description || ''} ${p.compositionText || ''}`).join(' ').toLowerCase();
  const items = [];
  if (/non-iron|easy care/.test(text)) items.push('Easy Care / Non-Iron finishes for wrinkle resistance');
  if (/washed|vintage/.test(text)) items.push('Washed effects for vintage aesthetics');
  if (/brushed/.test(text)) items.push('Brushed interiors for comfort');
  if (/polyurethane|coating/.test(text)) items.push('Polyurethane coating for weather protection');
  if (/embroider/.test(text)) items.push('Embroidered detailing to elevate surface texture');
  return items;
}

function extractSustainabilityHighlights(products) {
  const text = products.map(p => `${p.name || ''} ${p.description || ''} ${p.compositionText || ''}`).join(' ').toLowerCase();
  const items = [];
  if (text.includes('rcs')) items.push('RCS-certified recycled materials appear in the collection');
  if (text.includes('ocs') || text.includes('organic')) items.push('Organic cotton or OCS references indicate improved material sourcing');
  if (text.includes('recycled')) items.push('Recycled fibers are used to reduce material impact');
  if (text.includes('lyocell')) items.push('Lyocell blends add a sustainable, fluid drape option');
  return items;
}

function describeFitCharacteristics(fitType = '') {
  const normalized = String(fitType || '').toLowerCase();
  if (!normalized) return 'Balanced everyday proportion';
  if (normalized.includes('slim')) return 'Closer-to-body silhouette with a sharper retail profile';
  if (normalized.includes('regular')) return 'Balanced classic commercial fit with easy wearability';
  if (normalized.includes('relaxed')) return 'Roomier silhouette emphasizing comfort and casual ease';
  if (normalized.includes('oversized')) return 'Fashion-forward volume with dropped, expanded proportions';
  if (normalized.includes('loose')) return 'Generous ease through body or leg for directional casual styling';
  if (normalized.includes('straight')) return 'Clean, even line that keeps the silhouette versatile';
  if (normalized.includes('wide')) return 'Expanded leg or body volume creating a modern directional shape';
  if (normalized.includes('bootcut')) return 'Leg opening widens below the knee for a retro denim cue';
  if (normalized.includes('flare')) return 'Noticeable hem spread with a more expressive silhouette';
  if (normalized.includes('taper')) return 'Shape narrows toward the hem for a controlled profile';
  if (normalized.includes('cropped')) return 'Shorter length shifts proportion toward a lighter, fashion-led look';
  if (normalized.includes('barrel')) return 'Curved volume through the leg creates a sculpted contemporary silhouette';
  if (normalized.includes('balloon')) return 'Rounded volume and compressed hem emphasize trend-led proportion';
  if (normalized.includes('jogger')) return 'Ease and sport utility reinforced by a gathered hem or waistband';
  if (normalized.includes('mom')) return 'Vintage-inspired rise and seat with a softened tapered leg';
  if (normalized.includes('dad')) return 'Relaxed top block with heritage denim proportions';
  if (normalized.includes('boyfriend')) return 'Borrowed-from-menswear ease with relaxed casual attitude';
  return 'Balanced everyday proportion';
}

function buildFitDistributionRows(insights, safeStats, safeProducts = [], template = 'single-brand') {
  if (Array.isArray(insights?.fitDistribution) && insights.fitDistribution.length > 0) {
    return insights.fitDistribution.map((item) => ({
      fitType: item.fitType || item.product || 'Fit not specified',
      count: Number(item.count) || 0,
      characteristics: item.characteristics || item.silhouetteCharacter || describeFitCharacteristics(item.fitType || item.product || ''),
    }));
  }

  const fallback = Array.isArray(safeStats?.fitDist) ? safeStats.fitDist : [];
  if (fallback.length > 0) {
    return fallback.map(([fitType, count]) => ({
      fitType,
      count,
      characteristics: describeFitCharacteristics(fitType),
    }));
  }

  if (Array.isArray(safeProducts) && safeProducts.length > 0) {
    const grouped = countByList(safeProducts.map((product) => {
      if (template === 'womenswear') {
        return inferWomensFitType(product);
      }
      return normalizeMensFit(product);
    }));

    return grouped.map(([fitType, count]) => ({
      fitType,
      count,
      characteristics: describeFitCharacteristics(fitType),
    }));
  }

  return [];
}

function isStretchProduct(product) {
  const text = `${product.name || ''} ${product.description || ''} ${product.compositionText || ''} ${(product.materials || []).join(' ')}`.toLowerCase();
  return /spandex|elastane|stretch|\bsp\b|\bel\b/.test(text);
}

function isHighWaist(product) {
  const text = `${product.name || ''} ${product.description || ''}`.toLowerCase();
  return /high[-\s]?waist|high[-\s]?rise|mid[-\s]?rise/.test(text);
}

function isRecycledMaterial(product) {
  const text = `${product.name || ''} ${product.description || ''} ${product.compositionText || ''}`.toLowerCase();
  return /recycled|rcs|rpet|rco|recycle/.test(text);
}

function isFunctionalFeature(product) {
  const text = `${product.name || ''} ${product.description || ''}`.toLowerCase();
  return /upf|water|repellent|utility|multi-pocket|zipper|windproof|outdoor|climbing/.test(text);
}

function isVintageTrend(product) {
  const text = `${product.name || ''} ${product.description || ''}`.toLowerCase();
  return /vintage|y2k|flare|distress|wash|whisker|retro/.test(text);
}

function buildMultiBrandStats(products, options = {}) {
  const total = Number.isFinite(options.totalOverride) && options.totalOverride > 0
    ? options.totalOverride
    : products.length;
  const brandDist = countByList(products.map(p => p.brand || 'Unknown'));
  const categoryDist = countByList(products.map(p => p.category || 'Unknown'));
  const stretchCount = products.filter(isStretchProduct).length;
  const highWaistCount = products.filter(isHighWaist).length;
  const recycledCount = products.filter(isRecycledMaterial).length;
  const functionalCount = products.filter(isFunctionalFeature).length;
  const vintageCount = products.filter(isVintageTrend).length;
  const stretchPct = pct(stretchCount, total);
  return {
    total,
    brandDist,
    categoryDist,
    stretchCount,
    stretchPct,
    highWaistCount,
    recycledCount,
    functionalCount,
    vintageCount,
  };
}

function deriveTrendInsights(products, stats) {
  const safeStats = stats || { stretchCount: 0, stretchPct: '0%', highWaistCount: 0, recycledCount: 0, functionalCount: 0, vintageCount: 0 };
  const trends = [];
  if (safeStats.stretchCount > 0) {
    trends.push({
      title: 'Stretch Fabric Ubiquity',
      description: `Stretch materials appear in ${safeStats.stretchPct} of products, highlighting comfort and mobility as the dominant value proposition.`
    });
  }
  if (safeStats.highWaistCount > 0) {
    trends.push({
      title: 'High-Waist as the New Standard',
      description: 'High-rise silhouettes dominate womenswear bottoms, reinforcing high-waist as the default fit expectation.'
    });
  }
  if (safeStats.recycledCount > 0) {
    trends.push({
      title: 'Sustainability Goes Mainstream',
      description: 'Recycled fibers and sustainability claims show up across multiple brands, moving eco-materials into core assortments.'
    });
  }
  if (safeStats.functionalCount > 0) {
    trends.push({
      title: 'Outdoor-to-Everyday Convergence',
      description: 'Utility-driven details like water repellency, UPF protection, and multi-pocket storage are appearing in everyday casual wear.'
    });
  }
  if (safeStats.vintageCount > 0) {
    trends.push({
      title: 'Vintage Revival & Y2K Nostalgia',
      description: 'Retro washes, flare silhouettes, and heritage styling continue to drive strong demand, especially in denim.'
    });
  }
  while (trends.length < 5) {
    trends.push({
      title: 'Category Concentration',
      description: 'Best sellers remain concentrated in core categories, emphasizing proven silhouettes over experimental design.'
    });
  }
  return trends.slice(0, 5);
}

function defaultBrandDescriptor(brandProducts) {
  const cat = countByList(brandProducts.map(p => p.category || 'Unknown'))[0];
  if (!cat) return 'Focused assortment';
  return `${cat[0]} Focus`;
}

function defaultBrandHighlights(brandProducts) {
  const highlights = [];
  if (brandProducts.some(isStretchProduct)) highlights.push('Stretch fabrics support comfort and mobility positioning');
  if (brandProducts.some(isRecycledMaterial)) highlights.push('Recycled materials reinforce sustainability messaging');
  const topCategory = countByList(brandProducts.map(p => p.category || 'Unknown'))[0]?.[0];
  if (topCategory) highlights.push(`Category emphasis on ${topCategory} styles`);
  return highlights.slice(0, 4);
}

function defaultCategoryBullets(category, products) {
  const name = category.toLowerCase();
  const bullets = [];
  if (name.includes('denim') || name.includes('jean')) {
    bullets.push('High-waist designs remain the dominant silhouette in this category');
    bullets.push('Stretch blends are the top selling feature for comfort');
    bullets.push('Flare and straight-leg shapes lead core demand');
    bullets.push('Vintage washes and distressed finishes remain popular');
  } else if (name.includes('shirt') || name.includes('flannel')) {
    bullets.push('Flannel and woven textures reinforce heritage appeal');
    bullets.push('Cotton and cotton-blend fabrics dominate construction');
    bullets.push('Functional details like UPF and utility pockets add value');
  } else if (name.includes('functional') || name.includes('utility') || name.includes('canvas')) {
    bullets.push('Stretch canvas blends deliver durability with mobility');
    bullets.push('Utility pockets and reinforced stitching are standard');
    bullets.push('Relaxed fits outperform slim profiles for this category');
  } else if (name.includes('outerwear') || name.includes('vest')) {
    bullets.push('Lightweight warmth and layering versatility drive demand');
    bullets.push('Water-repellent or windproof fabrics elevate functionality');
    bullets.push('Secure closures and pocket storage remain essential');
  } else if (name.includes('t-shirt') || name.includes('basic')) {
    bullets.push('Softening treatments and durable blends differentiate basics');
    bullets.push('Classic fits remain the safest volume drivers');
  } else {
    bullets.push('Core silhouettes and reliable materials define performance');
  }
  return bullets.slice(0, 6);
}

function selectImagesForLLM(products, maxImages = 12) {
  const picks = [];
  const preferred = ['_X01', '_X', '_F', '_B'];
  for (const p of products) {
    if (!p.imagePaths || p.imagePaths.length === 0) continue;
    let chosen = null;
    for (const suf of preferred) {
      chosen = p.imagePaths.find(img => img.includes(suf));
      if (chosen) break;
    }
    if (!chosen) chosen = p.imagePaths[0];
    if (chosen && !picks.includes(chosen)) picks.push(chosen);
    if (picks.length >= maxImages) break;
  }
  return picks.slice(0, maxImages);
}

function imagePayloadsFromPaths(paths, maxImages = 8) {
  const payloads = [];
  for (const p of paths.slice(0, maxImages)) {
    try {
      const stat = fs.statSync(p);
      if (stat.size > 2.5 * 1024 * 1024) continue; // skip very large
      const ext = path.extname(p).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : (ext === '.webp' ? 'image/webp' : 'image/jpeg');
      const data = fs.readFileSync(p).toString('base64');
      payloads.push({ data, mime });
    } catch {
      continue;
    }
  }
  return payloads;
}

function uniq(items = []) {
  return [...new Set(items.filter(Boolean))];
}

const APPAREL_TERM_REFERENCE = {
  categoryGuides: [
    'Denim / Jeans: five-pocket denim, rigid denim, comfort-stretch denim, straight leg, tapered, bootcut, flare, barrel, carpenter, workwear denim, trucker jacket.',
    'Woven: poplin shirt, oxford shirt, camp-collar shirt, western shirt, tailored trouser, pleated trouser, chino, utility woven bottom, lightweight woven outer layer.',
    'Overshirts / Shirts: overshirt, shacket, shirt-jacket, brushed overshirt, patch-pocket shirt, flannel shirt, twill shirt, bowling shirt.',
    'Jackets / Outerwear: bomber, coach jacket, worker jacket, field jacket, puffer, trench, mac coat, quilted outerwear, technical shell.',
    'Knitwear / Sweat: crewneck knit, funnel-neck knit, half-zip knit, cardigan, sweatshirt, hoodie, zip hoodie, fleece-backed sweat.',
    'Womenswear Tops / Dresses / Skirts: ribbed top, camisole, halter top, corset top, bodysuit, mini dress, midi dress, slip dress, maxi skirt, tailored skirt.',
  ],
  fitGuides: [
    'Slim: clean close-to-body fit, often used for shirts, polos, denim and tailored trousers.',
    'Regular: classic commercial fit with balanced ease.',
    'Relaxed / Loose: easier silhouette with more room through body or leg.',
    'Oversized / Boxy: fashion-forward volume, dropped shoulder, wider body.',
    'Straight / Tapered: straight leg for uniform width; tapered narrows toward hem.',
    'Wide Leg / Barrel / Balloon: directional silhouette with fuller leg volume.',
    'Bootcut / Flare: hem opens out below knee; often used in denim language.',
    'Mom / Dad / Boyfriend: vintage-inspired denim fits with relaxed top block or leg.',
  ],
  materialGuides: [
    'Cotton family: cotton, recycled cotton, better cotton / BCI cotton, organic cotton.',
    'Cellulosics: viscose, rayon, lyocell, Tencel, modal, cupro.',
    'Performance / synthetics: polyester, recycled polyester, nylon, polyamide, polyurethane coating.',
    'Natural texture: linen, hemp, ramie, wool, cashmere.',
    'Stretch language: elastane, spandex, comfort stretch, rigid vs stretch denim.',
  ],
  washFinishGuides: [
    'Wash / finish terms: rinse wash, stonewash, faded wash, tinted wash, vintage wash, coated finish, brushed handfeel, peached surface, garment-dyed, enzyme wash.',
    'Fabric appearance terms: twill, corduroy, flannel, herringbone, textured weave, slub, brushed check, selvedge denim.',
  ],
  constructionGuides: [
    'Construction / detail terms: patch pocket, welt pocket, cargo pocket, coin pocket, placket, yoke, topstitch, contrast stitch, bartack, shank button, snap closure, elasticated waist, drawcord, pleated front, cuffed hem.',
  ],
};

function buildApparelReferenceBlock() {
  const lines = ['Professional apparel terminology reference:'];
  const sections = [
    ['Category cues', APPAREL_TERM_REFERENCE.categoryGuides],
    ['Fit cues', APPAREL_TERM_REFERENCE.fitGuides],
    ['Material cues', APPAREL_TERM_REFERENCE.materialGuides],
    ['Wash and finish cues', APPAREL_TERM_REFERENCE.washFinishGuides],
    ['Construction cues', APPAREL_TERM_REFERENCE.constructionGuides],
  ];

  for (const [title, items] of sections) {
    lines.push(`- ${title}:`);
    for (const item of items) {
      lines.push(`  - ${item}`);
    }
  }

  return lines.join('\n');
}

function buildFashionDomainInstructions() {
  return [
    'Domain assumptions:',
    '- All sources belong to apparel / fashion products unless the source clearly proves otherwise.',
    '- Focus on garment-level analysis: category, silhouette, fit, length, rise, leg shape, neckline, collar, sleeve, pocket, closure, seam or panel construction, wash, print, trim, texture, and likely fabric behavior.',
    '- Ignore tiny on-garment hangtags, care tags, or small attached tickets when identifying styles unless there is a separate close-up label image.',
    '- Use cautious language for fabric judgments from images: say "appears to be", "visually suggests", or "surface looks like" instead of asserting hidden composition.',
    '- If multiple pages or images appear to show the same style in different views, treat them as one style rather than separate products.',
    '- Prefer style-level consolidation over page-level counting.',
    '- Use apparel terminology common in Zara, H&M, Bershka, Levi\'s, Lee, Abercrombie & Fitch, Reserved, M&S, and Denham style collections when it matches the evidence.',
    '- Prefer specific categories over "Other" whenever the source suggests a real apparel family such as Denim, Jeans, Woven, Overshirts, Shirts, T-Shirts, Polos, Blazers, Jackets, Outerwear, Chino Pants, Cargo Pants, Joggers, Shorts, Dresses, Skirts, Knitwear, Hoodies & Sweatshirts, Accessories, or Footwear.',
    '- Prefer specific fit language over generic wording when supported by the source or visuals: slim, regular, relaxed, oversized, loose, straight, wide leg, bootcut, flare, tapered, cropped, boxy, barrel, balloon, mom, dad, boyfriend, or jogger.',
    '- Recognize retail garment terms and construction cues such as overshirt, shacket, trucker jacket, western shirt, five-pocket denim, carpenter, utility pocket, elasticated waist, drawstring waist, pleated front, double waist, garment-dyed, stonewashed, rinsed, coated, brushed, textured, herringbone, twill, flannel, corduroy, selvedge, rigid denim, comfort stretch, and technical fabric.',
    buildApparelReferenceBlock(),
  ].join('\\n');
}

function hammingDistance(left, right) {
  const length = Math.min(left.length, right.length);
  let distance = Math.abs(left.length - right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) {
      distance += 1;
    }
  }
  return distance;
}

function createDisjointSet(size) {
  const parent = Array.from({ length: size }, (_, index) => index);

  const find = (value) => {
    if (parent[value] !== value) {
      parent[value] = find(parent[value]);
    }
    return parent[value];
  };

  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) {
      parent[rightRoot] = leftRoot;
    }
  };

  return { find, union };
}

async function buildVisualSignature(imagePath) {
  if (!sharp || !imagePath || !fs.existsSync(imagePath)) {
    return null;
  }

  const cacheOptions = {
    mode: 'visual-signature',
    version: 1,
  };
  const cachedSignature = readFileOperationCache(
    'visual-signatures',
    imagePath,
    cacheOptions,
    { version: 1 },
  );
  if (cachedSignature) {
    return cachedSignature;
  }

  const pipeline = sharp(imagePath, { failOn: 'none', limitInputPixels: false }).rotate().toColorspace('srgb').removeAlpha();
  const metadata = await pipeline.metadata();
  const monoBuffer = await pipeline.clone().resize(16, 16, { fit: 'cover' }).grayscale().raw().toBuffer();
  const colorBuffer = await pipeline.clone().resize(8, 8, { fit: 'cover' }).raw().toBuffer();

  if (!monoBuffer.length || !colorBuffer.length) {
    return null;
  }

  const monoAverage = monoBuffer.reduce((sum, value) => sum + value, 0) / monoBuffer.length;
  const hash = Array.from(monoBuffer, (value) => (value >= monoAverage ? '1' : '0')).join('');

  let red = 0;
  let green = 0;
  let blue = 0;
  for (let index = 0; index < colorBuffer.length; index += 3) {
    red += colorBuffer[index] || 0;
    green += colorBuffer[index + 1] || 0;
    blue += colorBuffer[index + 2] || 0;
  }
  const pixelCount = Math.max(1, Math.floor(colorBuffer.length / 3));

  let edgeScore = 0;
  for (let row = 0; row < 16; row += 1) {
    for (let col = 1; col < 16; col += 1) {
      const current = monoBuffer[(row * 16) + col];
      const previous = monoBuffer[(row * 16) + col - 1];
      edgeScore += Math.abs(current - previous);
    }
  }

  const signature = {
    imagePath,
    fileName: path.basename(imagePath),
    hash,
    aspectRatio: Number(metadata?.width || 1) / Math.max(1, Number(metadata?.height || 1)),
    brightness: monoAverage,
    meanColor: [red / pixelCount, green / pixelCount, blue / pixelCount],
    edgeScore: edgeScore / 240,
  };

  writeFileOperationCache(
    'visual-signatures',
    imagePath,
    cacheOptions,
    signature,
    { version: 1 },
  );
  return signature;
}

function computeVisualSimilarity(left, right) {
  if (!left || !right) {
    return 0;
  }

  const hashDistance = hammingDistance(left.hash, right.hash) / Math.max(1, left.hash.length);
  const aspectDistance = Math.abs(left.aspectRatio - right.aspectRatio) / Math.max(1, left.aspectRatio, right.aspectRatio);
  const brightnessDistance = Math.abs(left.brightness - right.brightness) / 255;
  const colorDistance = Math.sqrt(
    Math.pow(left.meanColor[0] - right.meanColor[0], 2)
      + Math.pow(left.meanColor[1] - right.meanColor[1], 2)
      + Math.pow(left.meanColor[2] - right.meanColor[2], 2),
  ) / 442;
  const edgeDistance = Math.abs(left.edgeScore - right.edgeScore) / 255;

  return 1 - (
    (hashDistance * 0.48)
    + (aspectDistance * 0.12)
    + (brightnessDistance * 0.1)
    + (colorDistance * 0.2)
    + (edgeDistance * 0.1)
  );
}

function groupDisjointSet(items, disjointSet) {
  const grouped = new Map();
  for (let index = 0; index < items.length; index += 1) {
    const root = disjointSet.find(index);
    if (!grouped.has(root)) {
      grouped.set(root, []);
    }
    grouped.get(root).push(items[index]);
  }
  return Array.from(grouped.values()).sort((left, right) => right.length - left.length);
}

async function buildVisualGroupingHints(imagePaths = [], emitLog = () => {}, options = {}) {
  const candidates = uniq((imagePaths || []).filter(Boolean)).slice(0, options.maxImages || 120);
  if (!sharp || candidates.length <= 1) {
    return {
      representativeImages: candidates,
      duplicateGroups: [],
      similarStyleGroups: [],
      summaryText: '',
    };
  }

  const signatures = [];
  for (const imagePath of candidates) {
    try {
      const signature = await buildVisualSignature(imagePath);
      if (signature) {
        signatures.push(signature);
      }
    } catch {
      // Skip unreadable images and keep moving.
    }
  }

  if (signatures.length <= 1) {
    return {
      representativeImages: signatures.map((item) => item.imagePath),
      duplicateGroups: [],
      similarStyleGroups: [],
      summaryText: '',
    };
  }

  const duplicateSet = createDisjointSet(signatures.length);
  const similarSet = createDisjointSet(signatures.length);

  for (let left = 0; left < signatures.length; left += 1) {
    for (let right = left + 1; right < signatures.length; right += 1) {
      const similarity = computeVisualSimilarity(signatures[left], signatures[right]);
      const colorDistance = Math.sqrt(
        Math.pow(signatures[left].meanColor[0] - signatures[right].meanColor[0], 2)
          + Math.pow(signatures[left].meanColor[1] - signatures[right].meanColor[1], 2)
          + Math.pow(signatures[left].meanColor[2] - signatures[right].meanColor[2], 2),
      ) / 442;

      if (similarity >= 0.96 || (similarity >= 0.93 && colorDistance <= 0.035)) {
        duplicateSet.union(left, right);
        similarSet.union(left, right);
        continue;
      }

      if (similarity >= 0.885 && colorDistance <= 0.14) {
        similarSet.union(left, right);
      }
    }
  }

  const duplicateGroups = groupDisjointSet(signatures, duplicateSet).filter((group) => group.length > 1);
  const similarStyleGroups = groupDisjointSet(signatures, similarSet)
    .filter((group) => group.length > 1)
    .filter((group) => !duplicateGroups.some((dup) => dup.length === group.length && dup.every((item) => group.includes(item))));

  const representativeImages = [];
  const seenDuplicateRoots = new Set();
  for (let index = 0; index < signatures.length; index += 1) {
    const signature = signatures[index];
    const duplicateRoot = duplicateSet.find(index);
    const duplicateGroup = duplicateGroups.find((group) => group.some((item) => item.imagePath === signature.imagePath));
    if (!duplicateGroup) {
      representativeImages.push(signature.imagePath);
      continue;
    }
    if (!seenDuplicateRoots.has(duplicateRoot)) {
      representativeImages.push(signature.imagePath);
      seenDuplicateRoots.add(duplicateRoot);
    }
  }

  const summaryParts = [];
  if (duplicateGroups.length > 0) {
    summaryParts.push(
      `Local visual clustering found ${duplicateGroups.length} exact or near-duplicate image group(s): ${
        duplicateGroups
          .slice(0, 8)
          .map((group) => group.map((item) => item.fileName).join(' / '))
          .join('; ')
      }.`,
    );
  }
  if (similarStyleGroups.length > 0) {
    summaryParts.push(
      `Potential same-style groups across different pages or views: ${
        similarStyleGroups
          .slice(0, 8)
          .map((group) => group.map((item) => item.fileName).join(' / '))
          .join('; ')
      }.`,
    );
  }

  if (duplicateGroups.length > 0 || similarStyleGroups.length > 0) {
    emitLog(
      `Visual clustering reduced ${signatures.length} image(s) to ${representativeImages.length} representative image(s).`,
      'info',
    );
  }

  return {
    representativeImages,
    duplicateGroups,
    similarStyleGroups,
    summaryText: summaryParts.join('\n'),
  };
}

function collectParsedImageRecords(parsed = {}) {
  if (Array.isArray(parsed?.imageRecords) && parsed.imageRecords.length > 0) {
    return parsed.imageRecords
      .filter((record) => record && record.path)
      .map((record) => ({
        name: String(record.name || path.basename(record.path)).trim(),
        path: String(record.path || '').trim(),
        pageNumber: Number(record.pageNumber) || 0,
        explicitLabel: Boolean(record.explicitLabel),
      }));
  }

  return (Array.isArray(parsed?.imagePaths) ? parsed.imagePaths : [])
    .filter(Boolean)
    .map((imagePath) => ({
      name: path.basename(imagePath),
      path: imagePath,
      pageNumber: 0,
      explicitLabel: false,
    }));
}

function isPdfProductLikePage(page = {}) {
  const imageCount = Number(page?.imageCount) || 0;
  return imageCount > 0 && imageCount <= 6;
}

function filterVisualRecordsForCounting(parsed = {}, emitLog = () => {}) {
  const sourceType = String(parsed?.sourceType || '').toLowerCase();
  const allRecords = collectParsedImageRecords(parsed);
  if (allRecords.length === 0) {
    return {
      records: [],
      imagePaths: [],
      filteredCount: 0,
      productPageCount: 0,
    };
  }

  let records = allRecords.filter((record) => !record.explicitLabel);
  let productPageCount = 0;

  if (sourceType === 'pdf') {
    const productPageNumbers = new Set(
      (Array.isArray(parsed?.pageContexts) ? parsed.pageContexts : [])
        .filter(isPdfProductLikePage)
        .map((page) => Number(page?.number) || 0)
        .filter((value) => value > 0),
    );
    productPageCount = productPageNumbers.size;

    if (productPageNumbers.size > 0) {
      records = records.filter((record) => {
        const pageNumber = Number(record.pageNumber) || 0;
        return pageNumber <= 0 || productPageNumbers.has(pageNumber);
      });
    }
  }

  const imagePaths = uniq(records.map((record) => record.path).filter(Boolean));
  const filteredCount = Math.max(0, allRecords.length - records.length);

  if (filteredCount > 0) {
    const scopeText = sourceType === 'pdf' && productPageCount > 0
      ? ` across ${productPageCount} product-like PDF page(s)`
      : '';
    emitLog(
      `Filtered visual candidates from ${allRecords.length} to ${imagePaths.length} image(s)${scopeText} before style counting.`,
      'info',
    );
  }

  return {
    records,
    imagePaths,
    filteredCount,
    productPageCount,
  };
}

function estimatePdfStyleCountFromPages(parsed = {}) {
  const pageContexts = Array.isArray(parsed?.pageContexts) ? parsed.pageContexts : [];
  const productPages = pageContexts.filter(isPdfProductLikePage);
  if (productPages.length === 0) {
    return {
      styleCount: 0,
      productPageCount: 0,
    };
  }

  let styleCount = 0;
  for (const page of productPages) {
    const imageCount = Number(page?.imageCount) || 0;
    const text = String(page?.text || '').trim();

    if (text) {
      styleCount += 1;
      continue;
    }

    if (imageCount >= 5) {
      // Image-only collage pages usually contain extra decorative elements,
      // so treat the surplus above two non-product assets as style tiles.
      styleCount += Math.max(1, imageCount - 2);
      continue;
    }

    styleCount += 1;
  }

  return {
    styleCount,
    productPageCount: productPages.length,
  };
}

function buildVisualPlaceholderProducts(representativeImages = [], totalCount = representativeImages.length) {
  const candidates = representativeImages.filter(Boolean);
  if (candidates.length === 0 || totalCount <= 0) {
    return [];
  }

  return Array.from({ length: totalCount }, (_, index) => {
    const imagePath = candidates[Math.min(index, candidates.length - 1)];
    return {
      code: `VISUAL-${String(index + 1).padStart(3, '0')}`,
      name: `Visual Style ${index + 1}`,
      category: 'Other',
      fit: '',
      materials: [],
      compositionText: '',
      priceValue: '',
      brand: '',
      description: 'Counted as a visually distinct garment style from the source images.',
      imagePaths: [imagePath],
    };
  });
}

async function buildVisualStyleCoverage(parsed = {}, products = [], emitLog = () => {}) {
  const filtered = filterVisualRecordsForCounting(parsed, emitLog);
  if (filtered.imagePaths.length === 0) {
    return {
      imagePaths: [],
      grouping: {
        representativeImages: [],
        duplicateGroups: [],
        similarStyleGroups: [],
        summaryText: '',
      },
      representativeCount: 0,
      totalOverride: null,
      summaryText: '',
      syntheticProducts: [],
    };
  }

  const grouping = await buildVisualGroupingHints(filtered.imagePaths, emitLog, { maxImages: 120 });
  const representativeCount = Array.isArray(grouping?.representativeImages) ? grouping.representativeImages.length : 0;
  const pdfPageEstimate = String(parsed?.sourceType || '').toLowerCase() === 'pdf'
    ? estimatePdfStyleCountFromPages(parsed)
    : { styleCount: 0, productPageCount: 0 };
  const candidateVisualCount = Math.max(representativeCount, pdfPageEstimate.styleCount || 0);
  const parsedCount = Array.isArray(products) ? products.length : 0;

  let totalOverride = null;
  if (candidateVisualCount > 0) {
    if (parsedCount === 0) {
      if (candidateVisualCount <= 60) {
        totalOverride = candidateVisualCount;
      }
    } else if (candidateVisualCount > parsedCount) {
      const upperBound = Math.max(parsedCount + 12, Math.ceil(parsedCount * 1.5));
      if (candidateVisualCount <= upperBound) {
        totalOverride = candidateVisualCount;
      }
    }
  }

  const summaryParts = [];
  if (candidateVisualCount > 0) {
    summaryParts.push(
      `Local visual review found ${candidateVisualCount} distinct garment-style candidate(s) after deduplicating ${filtered.imagePaths.length} candidate image(s).`,
    );
  }
  if (pdfPageEstimate.styleCount > representativeCount) {
    summaryParts.push(
      `PDF page-level layout heuristics estimate ${pdfPageEstimate.styleCount} style slot(s) across ${pdfPageEstimate.productPageCount} product-like page(s), which was used to recover likely multi-style collage pages.`,
    );
  }
  if (grouping?.summaryText) {
    summaryParts.push(grouping.summaryText);
  }

  if (Number.isFinite(totalOverride) && totalOverride > 0 && totalOverride !== parsedCount) {
    emitLog(
      `Visual dedupe suggests ${totalOverride} distinct style candidate(s); using that count for report totals.`,
      'success',
    );
  } else if (candidateVisualCount > 0 && candidateVisualCount !== parsedCount && parsedCount > 0) {
    emitLog(
      `Visual review found ${candidateVisualCount} style candidate(s), but the gap from the parsed total ${parsedCount} looked too large to auto-apply.`,
      'info',
    );
  }

  return {
    imagePaths: filtered.imagePaths,
    grouping,
    representativeCount: candidateVisualCount,
    totalOverride,
    summaryText: summaryParts.join('\n'),
    syntheticProducts: parsedCount === 0
      ? buildVisualPlaceholderProducts(grouping?.representativeImages || [], candidateVisualCount)
      : [],
  };
}

function buildBatchGroupingSummary(batch, grouping) {
  if (!grouping) {
    return '';
  }

  const batchSet = new Set(batch);
  const relevantGroups = [...(grouping.duplicateGroups || []), ...(grouping.similarStyleGroups || [])]
    .map((group) => group.filter((item) => batchSet.has(item.imagePath)))
    .filter((group) => group.length > 1);

  if (relevantGroups.length === 0) {
    return '';
  }

  return relevantGroups
    .slice(0, 6)
    .map((group, index) => `Cluster ${index + 1}: ${group.map((item) => item.fileName).join(' / ')}`)
    .join('\n');
}

function splitTextIntoChunks(text, maxChars = 5000, maxChunks = 8) {
  const normalized = String(text || '').replace(/\r/g, '').trim();
  if (!normalized) {
    return [];
  }

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  const chunks = [];
  let current = '';

  const pushCurrent = () => {
    if (current.trim()) {
      chunks.push(current.trim());
      current = '';
    }
  };

  const appendPiece = (piece) => {
    if (!piece) return;

    if (piece.length <= maxChars) {
      if (!current) {
        current = piece;
        return;
      }

      if ((current.length + 2 + piece.length) <= maxChars) {
        current += `\n\n${piece}`;
        return;
      }

      pushCurrent();
      current = piece;
      return;
    }

    const lines = piece.split('\n').map((line) => line.trim()).filter(Boolean);
    if (lines.length > 1) {
      for (const line of lines) {
        appendPiece(line);
        if (chunks.length >= maxChunks) return;
      }
      return;
    }

    const sentencePieces = piece.match(/[^.!?\n]+[.!?]?/g) || [piece];
    if (sentencePieces.length > 1) {
      for (const sentence of sentencePieces.map((entry) => entry.trim()).filter(Boolean)) {
        appendPiece(sentence);
        if (chunks.length >= maxChunks) return;
      }
      return;
    }

    for (let start = 0; start < piece.length; start += maxChars) {
      const slice = piece.slice(start, start + maxChars).trim();
      if (slice) {
        pushCurrent();
        chunks.push(slice);
      }
      if (chunks.length >= maxChunks) return;
    }
  };

  for (const paragraph of paragraphs) {
    appendPiece(paragraph);
    if (chunks.length >= maxChunks) break;
  }

  if (chunks.length < maxChunks) {
    pushCurrent();
  }

  return chunks.slice(0, maxChunks);
}

function buildSourceSnippet(text, limit = 5000) {
  const normalized = String(text || '').trim();
  if (!normalized) {
    return '';
  }

  if (normalized.length <= limit) {
    return normalized;
  }

  const headLimit = Math.floor(limit * 0.6);
  const tailLimit = Math.max(0, limit - headLimit - 64);
  const head = normalized.slice(0, headLimit).trim();
  const tail = normalized.slice(normalized.length - tailLimit).trim();
  return `${head}\n\n[...additional source content indexed and analyzed...]\n\n${tail}`;
}

function extractJsonCandidate(text) {
  if (!text) return null;
  let cleaned = String(text).trim();
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) cleaned = fence[1].trim();
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
  cleaned = cleaned.slice(start, end + 1);
  cleaned = cleaned.replace(/^\uFEFF/, '');
  cleaned = cleaned.replace(/[""]/g, '"').replace(/['']/g, "'");
  cleaned = cleaned.replace(/,\s*([}\]])/g, '$1');
  return cleaned.trim();
}

function parseJsonSafe(text) {
  const jsonText = extractJsonCandidate(text);
  if (!jsonText) return null;
  try { return JSON.parse(jsonText); } catch { return null; }
}

async function attemptJsonRepair(llm, raw, template, emitLog) {
  if (!llm || !raw) return null;
  const snippet = String(raw).slice(0, 4000);
  
  // 尝试多种修复策略
  const repairStrategies = [
    // 策略1: 直接要求转换为JSON
    {
      prompt: `The following output should be valid JSON for the "${template}" report schema, but it is not valid JSON. Convert it to strict JSON only (no markdown, no comments, no extra text).

Raw output:
${snippet}
`,
      maxTokens: 1500
    },
    // 策略2: 要求提取关键字段并重新生成
    {
      prompt: `I need you to extract the key information from the following text and format it as valid JSON for a product analysis report. 

The JSON should have these fields:
- executiveSummary (string)
- keyFindings (array of strings)
- productOverview (string)
- materialAnalysis (string)
- keyMaterialTypes (array of objects with materialType, application, features)
- fitAnalysis (string)
- keyDesignFeatures (array of strings)
- styleClusters (array of objects with name, description)
- targetConsumerProfile (array of strings)
- strategicRecommendations (array of strings)
- conclusion (string)

Text to extract from:
${snippet}

Return ONLY valid JSON, no markdown, no explanations.`,
      maxTokens: 2000
    },
    // 策略3: 最简化的提取
    {
      prompt: `Extract information from this text and return as simple JSON with basic fields only:

Text:
${snippet.slice(0, 2000)}

Return JSON like:
{
  "executiveSummary": "...",
  "keyFindings": ["..."],
  "productOverview": "...",
  "materialAnalysis": "...",
  "keyMaterialTypes": [],
  "fitAnalysis": "...",
  "keyDesignFeatures": [],
  "styleClusters": [],
  "targetConsumerProfile": [],
  "strategicRecommendations": [],
  "conclusion": "..."
}`,
      maxTokens: 1500
    }
  ];
  
  for (let i = 0; i < repairStrategies.length; i++) {
    try {
      emitLog(`Attempting JSON repair (strategy ${i + 1}/${repairStrategies.length})...`, 'info');
      const strategy = repairStrategies[i];
      const fixed = await llm.generate(strategy.prompt, { temperature: 0, maxTokens: strategy.maxTokens });
      const parsed = parseJsonSafe(fixed);
      if (parsed) {
        emitLog('AI JSON repaired successfully.', 'success');
        return parsed;
      }
    } catch (e) {
      emitLog(`Repair strategy ${i + 1} failed: ${e.message}`, 'warning');
    }
  }
  
  emitLog('All JSON repair strategies failed.', 'error');
  return null;
}

function buildStats(products, template, options = {}) {
  const total = Number.isFinite(options.totalOverride) && options.totalOverride > 0
    ? options.totalOverride
    : products.length;
  const categoryDist = countByList(products.map(p => categorizeForTemplate(p, template)));
  const primaryCategoryDist = countByList(products.map((product) => getPrimaryCategory(product)));
  const subcategoryDist = countByList(products.map((product) => getSubcategory(product)));
  const materialDist = countArr(products, 'materials');
  // For single-brand template, use a simplified fit analysis
  const fitDist = (template === 'adaptive' || template === 'single-brand' || template === 'menswear') 
    ? countByList(products.map(p => normalizeMensFit(p))) 
    : [];
  const styleDist = countBy(products, 'style');
  const featureDist = countArr(products, 'features');
  const priceDist = countBy(products, 'price');
  return { total, categoryDist, primaryCategoryDist, subcategoryDist, materialDist, fitDist, styleDist, featureDist, priceDist };
}

function buildAiPrompt(template, meta, stats, products, sourceText) {
  const safeProducts = Array.isArray(products) ? products : [];
  const safeStats = stats || {
    total: safeProducts.length,
    brandDist: [],
    categoryDist: [],
    materialDist: [],
    fitDist: [],
    styleDist: [],
    featureDist: [],
  };
  const productData = safeProducts.map(p => ({
    code: p.code || '',
    name: p.name || '',
    brand: p.brand || '',
    category: categorizeForTemplate(p, template),
    fit: p.fit || '',
    materials: p.materials || [],
    composition: p.compositionText || '',
    description: (p.description || '').slice(0, 160),
    collectionSection: p.collectionSection || '',
  }));

  const base = {
    template,
    title: meta.reportTitle,
    collection: meta.collectionLabel,
    sourceProfile: meta.sourceProfile || 'apparel',
    totalProducts: safeStats.total || safeProducts.length,
    brands: safeStats.brandDist || [],
    categories: safeStats.categoryDist || [],
    primaryCategories: safeStats.primaryCategoryDist || [],
    subcategories: safeStats.subcategoryDist || [],
    materials: safeStats.materialDist || [],
    fits: safeStats.fitDist || [],
    styles: safeStats.styleDist || [],
    features: safeStats.featureDist || []
  };

  const domainInstructions = buildFashionDomainInstructions();
  const sourceProfile = meta.sourceProfile || 'apparel';

  if (template === 'multi-brand') {
    return `You are a retail analyst. Create a flexible Multi-Brand Best Seller Analysis Report.

${domainInstructions}

IMPORTANT: 
- Return ONLY valid JSON
- Only include fields where you have REAL data from the products
- ADD any additional insights from your analysis that are not in the template
- Do NOT force fields to be empty if you can derive insights

Structure (include ALL fields you can fill, add extra fields as needed):
{
  "executiveSummary": "2-3 paragraph executive summary covering total products, brands, categories, and key cross-cutting trends",
  "keyFindings": [
    "Key finding 1: Stretch fabric dominance (85%+ products)",
    "Key finding 2: High-waist designs in womenswear",
    "Key finding 3: Sustainability through recycled materials",
    "Key finding 4: Outdoor functionality crossover to casual",
    "Key finding 5: Vintage/Retro revival trends"
  ],
  
  "brandAnalysis": [
    {
      "brand": "Brand Name",
      "productCount": 0,
      "positioning": "Positioning description (e.g., Young Women's Denim, Men's Outdoor Functional)",
      "categories": "Categories covered",
      "highlights": ["Key highlight 1", "Key highlight 2", "Key highlight 3"]
    }
  ],
  
  "categoryAnalysis": [
    {
      "category": "Category Name (e.g., Denim, Shirts, Functional Pants)",
      "productCount": 0,
      "portfolioShare": "Percentage of portfolio",
      "insights": ["Insight 1", "Insight 2", "Insight 3"]
    }
  ],
  
  "productCatalog": [
    {
      "brand": "Brand",
      "style": "Style number",
      "name": "Product name",
      "category": "Category",
      "fabric": "Fabric composition"
    }
  ],
  
  "trendInsights": [
    {
      "title": "Trend 1: Stretch Fabric Ubiquity",
      "description": "Detailed description of the trend and its market impact"
    },
    {
      "title": "Trend 2: High-Waist as Standard",
      "description": "Detailed description of the trend"
    },
    {
      "title": "Trend 3: Sustainability Mainstream",
      "description": "Detailed description of the trend"
    },
    {
      "title": "Trend 4: Functional Crossover",
      "description": "Detailed description of the trend"
    },
    {
      "title": "Trend 5: Vintage Revival",
      "description": "Detailed description of the trend"
    }
  ]
}

IMPORTANT: Fill in ALL arrays with REAL data from the products. Calculate accurate counts.
- Do not count repeated pages, repeat views, or duplicate visual appearances of the same style as separate products.

Stats:
${JSON.stringify(base, null, 2)}

Products:
${JSON.stringify(productData, null, 2)}

Source text (for additional insights):
${buildSourceSnippet(sourceText || '', 14000)}

IMPORTANT: 
- Add extra fields beyond this template if you have valuable insights  
- Be flexible - missing data is OK, but don't leave insights out
- Write substantive content in each field
- Return valid JSON only`;
  }

  if (template === 'menswear') {
    return `You are a professional fashion product analyst. Create a flexible Menswear Product Analysis Report.

${domainInstructions}

IMPORTANT:
- Return ONLY valid JSON
- Only include fields where you have REAL data
- ADD extra insights from AI analysis
- Be flexible with the structure

Suggested structure (include what you can, add extra as needed):
{
  "executiveSummary": "",
  "keyFindings": [""],
  "productOverview": "",
  "materialAnalysis": "",
  "keyMaterialTypes": [{"materialType":"","application":"","features":""}],
  "specialFinishes": [""],
  "fitAnalysis": "",
  "keyDesignFeatures": [""],
  "styleAttributesDistribution": [{"attribute":"","frequency":0}],
  "styleClusters": [{"name":"","description":""}],
  "targetConsumerProfile": [""],
  "strategicRecommendations": [""],
  "conclusion": ""
}

Collection stats:
${JSON.stringify(base, null, 2)}

Products:
${JSON.stringify(productData, null, 2)}

Source text snippet (if any):
${buildSourceSnippet(sourceText || '', 10000)}
`;
  }

  // Flexible apparel report prompt
  if (template === 'adaptive' || template === 'single-brand') {
    return `You are a professional fashion product analyst. Create a flexible apparel product analysis report.

${domainInstructions}

IMPORTANT: 
- Return ONLY valid JSON
- Only include fields where you have REAL data from the products and source text
- ADD any extra insights from AI analysis that are NOT in this template
- Be flexible - if data is missing, don't force it, but add meaningful insights
- Use retail-ready apparel language and avoid collapsing real garments into "Other" when Jeans, Jackets, Overshirts, Shirts, Chino Pants, Cargo Pants, Joggers, Knitwear, Dresses, Skirts, Tops, Shorts, or similar categories are supportable.
- Treat composition abbreviations as real material evidence: C=cotton, L=linen, LYOCELL/TEL=tencel or lyocell, VIS=viscose, R=rayon when used in composition lines, POLY/P=polyester, ELA/SP=elastane or spandex, NY/PA=nylon or polyamide.
- If collection sections like MEN'S DENIM or MEN'S WOVEN appear, use them as context for the products that follow, but still classify the final result with apparel categories rather than fabric buckets.
- Do not force a rigid canned report template. Use the structure below as a guide, but adapt the emphasis to the actual assortment.
- Prefer specific garment families such as Shirts, Jackets, Waistcoats & Vests, Jeans, Tailored Pants, Cargo Pants, Joggers, Shorts, Knitwear, Dresses, Skirts, Tops, or Outerwear over broad buckets like Woven or Denim.
- If fit evidence is weak, say it is not clearly specified instead of forcing "Standard".

Suggested structure (include what you can, add extra fields as needed):
{
  "executiveSummary": "2-3 paragraph overview of the collection, key trends, and market positioning",
  "keyFindings": [
    "Total product count and category distribution",
    "Dominant materials and their sustainability angle",
    "Fit preferences and silhouette trends",
    "Style direction and aesthetic themes",
    "Target consumer profile"
  ],
  "assortmentOverview": "Detailed description of the collection scope, garment architecture, and positioning",
  "assortmentArchitecture": {
    "headline": "Short paragraph on how the assortment is built",
    "categoryBreakdown": [{"category": "", "count": 0, "share": ""}],
    "wearMix": [{"group": "Top Wear / Bottom Wear / Layering", "count": 0}]
  },
  
  "materialAnalysis": "Comprehensive analysis of material composition, sustainability focus, and functional properties",
  "keyMaterialTypes": [
    {"materialType": "Cotton", "application": "Primary applications", "features": "Key properties"},
    {"materialType": "Denim", "application": "Jeans, shirts, jackets", "features": "Durable, classic"},
    {"materialType": "Stretch Fabric", "application": "Pants, joggers", "features": "Comfort, flexibility"}
  ],
  "specialFinishes": ["Easy Care non-iron", "Washed effect", "Brushed interior", "Premium texture"],
  
  "fitAnalysis": "Detailed analysis of fit distribution and silhouette trends",
  "fitDistribution": [
    {"fitType": "Regular", "count": 0, "characteristics": "Classic comfort"},
    {"fitType": "Relaxed", "count": 0, "characteristics": "Loose, casual"},
    {"fitType": "Slim", "count": 0, "characteristics": "Tailored"},
    {"fitType": "Fit not specified", "count": 0, "characteristics": "Insufficient explicit fit evidence in source"}
  ],
  "garmentCategoryAnalysis": [
    {"category": "Shirts", "count": 0, "share": "", "insights": ["..."]},
    {"category": "Jackets", "count": 0, "share": "", "insights": ["..."]}
  ],
  "designLanguage": "Narrative summary of styling, construction, and commercial look-and-feel",
  
  "keyDesignFeatures": [
    "Lapel collars for versatile styling",
    "Patch and welt pockets for utility",
    "Elastic waists for comfort",
    "Zipper closures for modern appeal",
    "Pleat details for volume"
  ],
  
  "styleAttributesDistribution": [
    {"attribute": "Casual", "frequency": 0},
    {"attribute": "Functional", "frequency": 0},
    {"attribute": "Vintage", "frequency": 0},
    {"attribute": "Sporty", "frequency": 0},
    {"attribute": "Tailored", "frequency": 0}
  ],
  
  "styleClusters": [
    {"name": "Retro Revival", "description": "Vintage-inspired pieces with washed effects, flannel textures, and relaxed silhouettes"},
    {"name": "Tech-Inspired", "description": "Innovative technical fabrics with functional features for modern living"},
    {"name": "Comfort-First", "description": "Elastic waistbands, relaxed fits, and stretch fabrics for all-day wearability"},
    {"name": "Urban Sophistication", "description": "Tailored yet wearable pieces for modern city life"}
  ],
  
  "targetConsumerProfile": [
    "Urban professionals seeking versatile work-casual pieces",
    "Comfort-conscious consumers favoring relaxed fits",
    "Style-conscious individuals interested in trend-aware aesthetics",
    "Sustainability-minded buyers appreciating natural fibers"
  ],
  
  "strategicRecommendations": [
    "Expand technical/performance line with moisture-wicking features",
    "Highlight sustainability story in marketing communications",
    "Develop coordinated cross-category looks",
    "Consider seasonal color range expansion"
  ],
  
  "conclusion": "Comprehensive conclusion summarizing collection strengths and market positioning"
}

IMPORTANT: Fill in all arrays with REAL data from the products. Calculate accurate counts.

Collection stats:
${JSON.stringify(base, null, 2)}

Products:
${JSON.stringify(productData, null, 2)}

Source text (for additional insights):
${buildSourceSnippet(sourceText || '', 14000)}

REMEMBER: Return ONLY the complete JSON object with all fields you can support from evidence.
- Do not count repeated pages, repeat views, or duplicate visual appearances of the same style as separate products.`;
  }

  return `You are a professional fashion product analyst. Create a flexible Womenswear Product Analysis Report.

${domainInstructions}

IMPORTANT:
- Return ONLY valid JSON
- Only include fields where you have REAL data
- ADD extra insights from AI analysis
- Be flexible with the structure

Suggested structure (include what you can, add extra as needed):
{
  "executiveSummary": "",
  "keyFindings": [""],
  "productOverview": "",
  "materialAnalysis": "",
  "keyMaterialTypes": [{"materialType":"","application":"","features":""}],
  "sustainabilityHighlights": [""],
  "fitAnalysis": "",
  "fitDistribution": [{"fitType":"","product":"","silhouetteCharacter":""}],
  "keyDesignFeatures": [""],
  "subBrandStrategy": [{"subBrand":"","product":"","positioning":""}],
  "styleClusters": [{"name":"","description":""}],
  "targetConsumerProfile": [""],
  "strategicRecommendations": [""],
  "conclusion": ""
}

Collection stats:
${JSON.stringify(base, null, 2)}

Products:
${JSON.stringify(productData, null, 2)}

Source text snippet (if any):
${buildSourceSnippet(sourceText || '', 10000)}

- Do not count repeated pages, repeat views, or duplicate visual appearances of the same style as separate products.
`;
}

async function buildTextCoverageNotes(llm, sourceText, emitLog, options = {}) {
  const maxChunkChars = options.maxChunkChars || 5000;
  const maxChunks = options.maxChunks || 6;
  const chunks = splitTextIntoChunks(sourceText, maxChunkChars, maxChunks);

  if (chunks.length <= 1) {
    return '';
  }

  emitLog(`Reading ${chunks.length} text chunks for fuller coverage...`, 'info');

  const notes = [];
  const previousTimeout = llm.timeout;

  try {
    llm.timeout = options.timeoutMs || previousTimeout;

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      emitLog(`Analyzing text chunk ${index + 1}/${chunks.length}...`, 'info');

      const prompt = `You are reviewing one chunk of a fashion product source document.

${buildFashionDomainInstructions()}

Extract only concise factual notes from this chunk. Focus on:
- product names or style numbers
- materials and composition
- category and fit clues
- pricing, features, and sustainability details
- any notable collection, season, or positioning cues
- clues that multiple entries refer to the same style shown on different pages or in different views

Return short bullet points only. Do not invent missing data.

Chunk ${index + 1} of ${chunks.length}:
${chunk}`;

      const raw = await llm.generate(prompt, { temperature: 0.1, maxTokens: 700 });
      if (String(raw || '').trim()) {
        notes.push(`Chunk ${index + 1} notes:\n${String(raw).trim()}`);
      }
    }
  } catch (error) {
    emitLog(`Text chunk coverage reduced: ${error.message}`, 'warning');
  } finally {
    llm.timeout = previousTimeout;
  }

  return notes.join('\n\n');
}

async function buildImageCoverageNotes(llm, imagePaths, emitLog, options = {}) {
  const maxImages = options.maxImages || 12;
  const batchSize = options.batchSize || 4;
  const grouping = options.grouping || null;
  const groupedCandidates = grouping?.representativeImages?.length
    ? grouping.representativeImages
    : uniq((imagePaths || []).filter(Boolean));
  const candidates = groupedCandidates.slice(0, maxImages);

  if (candidates.length === 0) {
    return '';
  }

  const batches = [];
  for (let index = 0; index < candidates.length; index += batchSize) {
    batches.push(candidates.slice(index, index + batchSize));
  }

  emitLog(`Reviewing ${candidates.length} images across ${batches.length} batch(es)...`, 'info');

  const notes = [];
  const previousTimeout = llm.timeout;

  try {
    llm.timeout = options.timeoutMs || previousTimeout;

    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index];
      const payloads = imagePayloadsFromPaths(batch, batch.length);
      if (payloads.length === 0) {
        continue;
      }

      emitLog(`Analyzing image batch ${index + 1}/${batches.length}...`, 'info');

      const groupingHint = buildBatchGroupingSummary(batch, grouping);
      const prompt = `You are reviewing a batch of fashion product images.

${buildFashionDomainInstructions()}

Return concise bullet points covering only what is visually evident:
- garment categories and silhouettes
- fit and proportion
- colors, materials, surface texture, knit/woven character, wash, and finishes
- visible construction or design details such as collar, neckline, sleeve, pocket, closure, panel, seam, trim, hem, cuff, waistband, placket, and hardware
- styling direction, collection mood, or merchandising cues
- which images likely show the SAME style in different pages, angles, or detail shots

Rules:
- Do not guess hidden details.
- Ignore tiny hangtags, care labels, or small attached tickets on the garment unless there is a dedicated close-up label shot.
- If the same style appears more than once, explicitly say it is a repeat view of one style rather than a new product.
- If fabric can only be inferred visually, label it as an appearance clue instead of a confirmed composition.
${groupingHint ? `- Local visual grouping hints for this batch:\n${groupingHint}` : ''}`;

      const raw = await llm.generateWithImages(prompt, payloads, { temperature: 0.2, maxTokens: 700 });
      if (String(raw || '').trim()) {
        notes.push(`Image batch ${index + 1} notes:\n${String(raw).trim()}`);
      }
    }
  } catch (error) {
    emitLog(`Image batch coverage reduced: ${error.message}`, 'warning');
  } finally {
    llm.timeout = previousTimeout;
  }

  return notes.join('\n\n');
}

async function buildAiInsights(llm, template, meta, stats, products, sourceText, imagePaths, emitLog, emitProgress, options = {}) {
  if (!llm) return null;

  // 检查是否为本地 LLM（影响超时策略）
  const isLocalLLM = options.isLocalLLM !== false; // 默认为本地模式
  
  // 检查是否启用图片分析（默认禁用，因为视觉模型很慢）
  const enableVision = options.enableVision === true;
  
  const visionCapable = enableVision && (typeof llm.supportsVision === 'function' ? llm.supportsVision() : true);
  
  if (enableVision && visionCapable) {
    emitLog('Vision analysis enabled - this may take longer', 'info');
  } else if (enableVision && !visionCapable) {
    emitLog('Selected model does not support vision; using text-only analysis', 'info');
  } else {
    emitLog('Using text-only analysis (faster)', 'info');
  }

  // 根据本地/云端模式和是否启用视觉调整超时和尝试策略
  // 云端模式和本地模式都使用 5 分钟超时（用户要求）
  // 视觉模式：10 分钟
  const baseTimeout = enableVision ? 600000 : 300000; // 视觉10分钟，文本5分钟
  const visualGrouping = options.visualGrouping
    || (
      Array.isArray(imagePaths) && imagePaths.length > 1
        ? await buildVisualGroupingHints(imagePaths, emitLog, {
          maxImages: options.enableVision === true ? 64 : 48,
        })
        : {
          representativeImages: uniq((imagePaths || []).filter(Boolean)),
          duplicateGroups: [],
          similarStyleGroups: [],
          summaryText: '',
        }
    );
  const groupedImagePaths = visualGrouping.representativeImages || [];
  const textCoverageNotes = await buildTextCoverageNotes(
    llm,
    sourceText,
    emitLog,
    {
      maxChunkChars: isLocalLLM ? 6500 : 5000,
      maxChunks: isLocalLLM ? 6 : 8,
      timeoutMs: isLocalLLM ? 180000 : 240000,
    },
  );
  const imageCoverageNotes = visionCapable
    ? await buildImageCoverageNotes(
      llm,
      groupedImagePaths,
      emitLog,
      {
        maxImages: isLocalLLM ? 8 : 12,
        batchSize: 4,
        timeoutMs: enableVision ? 300000 : 180000,
        grouping: visualGrouping,
      },
    )
    : '';
  
  const attempts = [
    {
      name: enableVision ? 'vision' : 'text-full',
      maxTokens: enableVision ? 2500 : 4000,
      textSlice: enableVision ? 4000 : 9000,
      images: visionCapable ? imagePayloadsFromPaths(groupedImagePaths, isLocalLLM ? 4 : 6) : [],
      timeoutMs: baseTimeout,
    },
    {
      name: 'text-only',
      maxTokens: 3500,
      textSlice: 7000,
      images: [],
      timeoutMs: 300000, // 5分钟
      onlyOnTimeout: true,
    },
    {
      name: 'text-only-short',
      maxTokens: 2000,
      textSlice: 2000,
      images: [],
      timeoutMs: 180000, // 3分钟
      onlyOnTimeout: true,
    },
  ];

  emitLog(enableVision ? 'AI analyzing images and text...' : 'AI analyzing text data...', 'info');
  emitProgress && emitProgress(60);

  let lastTimeout = false;
  let lastError = null;
  
  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    if (attempt.onlyOnTimeout && !lastTimeout) continue;
    if (attempt.onlyOnTimeout && lastTimeout) {
      emitLog(`AI timed out, switching to ${attempt.name} mode...`, 'warning');
    } else if (i > 0) {
      emitLog(`AI retry (${i + 1}/${attempts.length}): ${attempt.name}`, 'info');
    }

    // 更新进度显示
    const progressBase = 60 + Math.floor((i / attempts.length) * 20);
    emitProgress && emitProgress(progressBase);

    const composedSourceContext = [
      buildSourceSnippet(sourceText || '', attempt.textSlice),
      textCoverageNotes ? `Extended text coverage notes:\n${textCoverageNotes}` : '',
      imageCoverageNotes ? `Extended image coverage notes:\n${imageCoverageNotes}` : '',
      options.apparelVisionSummary ? `Specialist apparel vision notes:\n${options.apparelVisionSummary}` : '',
      options.visualCoverageSummary ? `Visual style count guidance:\n${options.visualCoverageSummary}` : '',
      visualGrouping.summaryText ? `Local visual duplicate/style grouping:\n${visualGrouping.summaryText}` : '',
    ].filter(Boolean).join('\n\n');
    const prompt = buildAiPrompt(template, meta, stats, products, composedSourceContext);
    const prevTimeout = llm.timeout;
    if (attempt.timeoutMs) llm.timeout = attempt.timeoutMs;

    // 启动进度更新定时器
    let progressInterval = null;
    let elapsedSeconds = 0;
    
    try {
      // 定期更新进度，让用户知道 AI 正在工作
      progressInterval = setInterval(() => {
        elapsedSeconds += 1;
        const elapsed = formatElapsedTime(elapsedSeconds);
        const progressPercent = Math.min(progressBase + Math.floor((elapsedSeconds / 60) * 3), 85);
        emitProgress && emitProgress(progressPercent);
        
        // 每 10 秒更新一次日志
        if (elapsedSeconds % 10 === 0) {
          emitLog(`AI analyzing... (${elapsed} elapsed)`, 'info');
        }
      }, 1000);

      const isVisionRequest = attempt.images.length > 0;
      const raw = isVisionRequest
        ? await llm.generateWithImages(prompt, attempt.images, { temperature: 0.3, maxTokens: attempt.maxTokens })
        : await llm.generate(prompt, { temperature: 0.3, maxTokens: attempt.maxTokens });

      clearInterval(progressInterval);
      emitProgress && emitProgress(85);

      const rawPreview = String(raw).slice(0, 500);
      emitLog(`[DEBUG] AI raw response: ${rawPreview.replace(/\n/g, ' ')}`, 'info');

      const parsed = parseJsonSafe(raw);
      if (parsed) {
        emitLog('AI analysis completed successfully', 'success');
        return parsed;
      }

      const repaired = await attemptJsonRepair(llm, raw, template, emitLog);
      if (repaired) {
        emitLog('AI analysis completed (JSON repaired)', 'success');
        return repaired;
      }

      emitLog('AI response could not be parsed as JSON.', 'warning');
    } catch (e) {
      clearInterval(progressInterval);
      const msg = e && e.message ? e.message : 'Unknown error';
      lastError = msg;
      
      if (/timeout/i.test(msg)) {
        lastTimeout = true;
        emitLog(`AI request timed out after ${formatElapsedTime(elapsedSeconds)}`, 'warning');
      } else if (/ECONNREFUSED|ENOTFOUND/i.test(msg)) {
        emitLog(`AI connection failed: ${msg}. Please check if Ollama server is running.`, 'error');
        break; // 连接问题不需要重试
      } else {
        emitLog(`AI attempt failed: ${msg}`, 'warning');
      }
    } finally {
      llm.timeout = prevTimeout;
      if (progressInterval) clearInterval(progressInterval);
    }
  }

  emitLog(`AI analysis failed after ${attempts.length} attempts. Last error: ${lastError || 'Unknown'}`, 'error');
  return null;
}

// 格式化经过的时间
function formatElapsedTime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs}s`;
}

function normalizeAiProduct(item) {
  if (!item || typeof item !== 'object') return null;
  const rawCode = String(item.code || item.style || item.styleNumber || '').trim();
  const rawName = String(item.name || item.productName || '').trim();
  const description = String(item.description || '').trim();
  const code = (
    productParser.extractStyleTokensFromText([
      rawCode,
      rawName,
      description,
      String(item.compositionText || item.composition || '').trim(),
    ].filter(Boolean).join('\n'))[0]
    || rawCode
  ).trim();
  if (!code) return null;
  const name = productParser.sanitizeProductName(rawName) || rawName || 'Unknown Product';
  const rawCategory = String(item.category || '').trim();
  const inferredCategory = productParser.inferCategory(
    `${name} ${rawCategory}`,
    `${description} ${String(item.compositionText || item.composition || '').trim()}`,
  );
  const category = (!rawCategory || /^other$/i.test(rawCategory) || /^(woven|denim)$/i.test(rawCategory))
    ? (inferredCategory || rawCategory)
    : rawCategory;
  const hierarchy = productParser.inferCategoryHierarchy(
    `${name} ${rawCategory}`.trim(),
    `${description} ${String(item.compositionText || item.composition || '').trim()}`.trim(),
  );
  const fit = String(item.fit || '').trim() || productParser.inferFit(name, description);
  let materials = item.materials || item.material || [];
  if (typeof materials === 'string') {
    materials = materials.split(/[,;/|]/).map(s => s.trim()).filter(Boolean);
  }
  if (!Array.isArray(materials)) materials = [];
  let features = item.features || item.details || [];
  if (typeof features === 'string') {
    features = features.split(/[,;/|]/).map((s) => s.trim()).filter(Boolean);
  }
  if (!Array.isArray(features)) features = [];
  const compositionText = String(item.compositionText || item.composition || '').trim();
  if (materials.length === 0 && compositionText) {
    materials = productParser.extractMaterials(compositionText);
  }
  const priceValue = String(item.priceValue || item.price || '').trim();
  const brand = String(item.brand || '').trim();

  return {
    code,
    name,
    category: hierarchy?.category || category || 'Other',
    primaryCategory: String(item.primaryCategory || '').trim() || hierarchy?.primaryCategory || '',
    subcategory: String(item.subcategory || '').trim() || hierarchy?.subcategory || category || 'Other',
    fit,
    materials,
    features,
    compositionText,
    priceValue,
    brand,
    description,
  };
}

function dedupeAiProductsByCode(products) {
  const map = new Map();
  for (const p of products) {
    const code = String(p.code || '').trim();
    if (!code) continue;
    if (!map.has(code)) {
      map.set(code, p);
    } else {
      const existing = map.get(code);
      map.set(code, {
        ...existing,
        ...p,
        name: (p.name && p.name.length > existing.name.length) ? p.name : existing.name,
        materials: Array.from(new Set([...(existing.materials || []), ...(p.materials || [])])),
      });
    }
  }
  return Array.from(map.values());
}

function normalizeProductCode(code) {
  return String(code || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function mergeProductInventories(baseProducts = [], aiProducts = []) {
  const merged = new Map();

  const upsert = (product, source = 'base') => {
    if (!product || !product.code) {
      return;
    }

    const key = normalizeProductCode(product.code);
    if (!key) {
      return;
    }

    if (!merged.has(key)) {
      merged.set(key, { ...product });
      return;
    }

    const existing = merged.get(key);
    const next = {
      ...existing,
      ...product,
      code: existing.code || product.code,
      name: String(product.name || '').length > String(existing.name || '').length ? product.name : existing.name,
      brand: product.brand || existing.brand,
      category: product.category && product.category !== 'Other' ? product.category : existing.category,
      primaryCategory: product.primaryCategory || existing.primaryCategory,
      subcategory: product.subcategory || existing.subcategory,
      fit: product.fit && !/^fit not specified$/i.test(product.fit) ? product.fit : existing.fit,
      materials: Array.from(new Set([...(existing.materials || []), ...(product.materials || [])])).filter(Boolean),
      features: Array.from(new Set([...(existing.features || []), ...(product.features || [])])).filter(Boolean),
      description: String(product.description || '').length > String(existing.description || '').length ? product.description : existing.description,
      compositionText: String(product.compositionText || '').length > String(existing.compositionText || '').length ? product.compositionText : existing.compositionText,
      priceValue: product.priceValue || existing.priceValue,
      sourceFolder: existing.sourceFolder || product.sourceFolder,
      imagePaths: Array.from(new Set([...(existing.imagePaths || []), ...(product.imagePaths || [])])),
    };

    if (source === 'base' && product.attributes && !next.attributes) {
      next.attributes = product.attributes;
    }

    merged.set(key, next);
  };

  for (const product of baseProducts) {
    upsert(product, 'base');
  }

  for (const product of aiProducts) {
    upsert(product, 'ai');
  }

  return Array.from(merged.values());
}

async function extractProductsWithLLM(llm, sourceText, emitLog, isLocalLLM = true) {
  if (!llm) return [];
  
  const chunkSize = isLocalLLM ? 10000 : 7000;
  const maxChunks = isLocalLLM ? 6 : 8;
  const chunks = splitTextIntoChunks(sourceText, chunkSize, maxChunks);
  if (chunks.length === 0) return [];

  const buildPrompt = (textSlice, index, total) => `You are a data extraction engine for apparel product analysis. Extract ONLY real fashion product entries from the text below.

${buildFashionDomainInstructions()}

Return JSON ONLY as an array. Each item must include:
{
  "code": "style number (e.g. LC2259, GS12GD-LT24043-5, S27-84479, 1234/567/890 or 1234567890)",
  "name": "product name",
  "category": "prefer a specific apparel family such as Waistcoats & Vests, Blazers, Jackets, Outerwear, Overshirts, Shirts, T-Shirts, Polos, Tops, Jeans, Chino Pants, Cargo Pants, Joggers, Tailored Pants, Shorts, Dresses, Skirts, Knitwear, Hoodies & Sweatshirts, Accessories, Footwear or Underwear. Use 'Other' only if there is truly no category evidence. Do not use fabric buckets like Woven or Denim as the final category.",
  "fit": "use the most specific fit or silhouette term visible in the source or visual notes, such as Skinny, Slim, Baggy, Regular, Relaxed, Oversized, Loose, Straight, Wide Leg, Bootcut, Flare, Tapered, Cropped, Boxy, Barrel, Balloon, Jogger, Mom, Dad, Boyfriend or Carrot. Leave empty only if there is truly no fit evidence.",
  "materials": ["Cotton","Recycled Cotton","BCI Cotton","Organic Cotton","Polyester","Recycled Polyester","Viscose","Rayon","Lyocell","Tencel","Linen","Elastane","Spandex","Polyamide","Nylon", "..."] (array, may be empty),
  "compositionText": "optional composition string",
  "priceValue": "optional price string",
  "brand": "optional brand",
  "description": "short factual description that combines the original source wording with OCR/visual clues when available"
}

Rules:
- Only include lines that are actual products.
- Ignore cover pages, table of contents, headings, summaries, and report titles.
- Keep alphanumeric style numbers exactly as written whenever possible.
- If the source repeats the same style on different pages or views, keep it as one product entry instead of duplicating it.
- If a section heading says MEN'S DENIM, WOMEN'S DENIM, MEN'S WOVEN, WOMEN'S WOVEN, OUTERWEAR, or similar, use that as context for the products that follow, but still return an apparel category rather than a fabric bucket.
- Use specialist visual notes and structured product candidates to refine category granularity. Do not collapse all tops into Shirts if jacket, coat, vest, waistcoat, overshirt, blazer, polo, t-shirt, knitwear, or top is better supported.
- Preserve and merge compositionText and material clues from the source when they are already available.
- Do not hallucinate.
- Return JSON only, no markdown.

You are reading chunk ${index} of ${total}. Extract all real products visible in this chunk.

Text:
${textSlice}
`;

  const modeText = isLocalLLM ? 'local' : 'cloud';
  emitLog(`${modeText} LLM: extracting products from ${chunks.length} text chunk(s)...`, 'info');
  
  // 保存原始超时设置
  const originalTimeout = llm.timeout;
  const mergedProducts = [];
  
  try {
    llm.timeout = isLocalLLM ? originalTimeout : 300000;

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      if (chunks.length > 1) {
        emitLog(`Extracting products from chunk ${index + 1}/${chunks.length}...`, 'info');
      }

      const raw = await llm.generate(buildPrompt(chunk, index + 1, chunks.length), { temperature: 0.1, maxTokens: 1800 });
      let parsed = parseJsonSafe(raw);
      if (!parsed) {
        const repaired = await attemptJsonRepair(llm, raw, 'product-list', emitLog);
        parsed = repaired;
      }
      const list = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.products) ? parsed.products : []);
      const normalized = list.map(normalizeAiProduct).filter(Boolean);
      mergedProducts.push(...normalized);
    }

    return dedupeAiProductsByCode(mergedProducts);
  } finally {
    // 恢复原始超时设置
    llm.timeout = originalTimeout;
  }
}

function buildMultiBrandSections(data) {
  const { meta, stats, products, insights } = data;
  
  // Defensive: ensure stats and products exist
  const safeStats = stats || { total: 0, brandDist: [], categoryDist: [], stretchCount: 0, stretchPct: '0%', highWaistCount: 0, recycledCount: 0, functionalCount: 0, vintageCount: 0 };
  const safeProducts = Array.isArray(products) ? products : [];
  
  // Use safeStats and safeProducts throughout
  const total = safeStats.total;
  const brandCount = safeStats.brandDist?.length || 0;
  const categoryCount = safeStats.categoryDist?.length || 0;
  const stretchLabel = safeStats.stretchCount > 0 ? `${safeStats.stretchPct}+ Stretch Fabric` : 'Stretch Fabric';

  const sections = [];

  // Cover
  sections.push(smallText(meta.confidentialLine, AlignmentType.CENTER));
  sections.push(centeredText(meta.mainTitle, 56, BRAND_COLOR, true));
  sections.push(centeredText('Analysis Report', 32, '666666'));
  sections.push(centeredText(meta.subtitle, 20, '666666'));
  sections.push(centeredText(`${total} Products | ${brandCount} Brands | ${categoryCount} Categories`, 20, '666666'));
  if (meta.yearLine) {
    sections.push(centeredText(meta.yearLine, 22, '666666'));
  }

  // Table of Contents
  sections.push(pageBreak());
  sections.push(smallText(meta.preparedLine));
  sections.push(h1('TABLE OF CONTENTS'));
  const tocItems = [
    '01 Executive Summary  Overview of key findings',
    '02 Brand Analysis  Brand positioning and product characteristics',
    '03 Category Analysis  Category breakdown and insights',
    '04 Product Catalog  Complete product listing by brand',
    '05 Trend Insights  Cross-cutting trends for the year',
  ];
  tocItems.forEach(item => sections.push(smallText(item)));

  // Executive Summary
  sections.push(pageBreak());
  sections.push(smallText(meta.preparedLine));
  sections.push(h1('01 EXECUTIVE SUMMARY'));
  sections.push(body(`${total} Products | ${brandCount} Brands | ${categoryCount} Categories | ${stretchLabel}`, { bold: true }));
  const execSummary = insights?.executiveSummary ||
    `This report analyzes ${total} best-selling products across ${brandCount} brands, spanning ${categoryCount} key categories. The portfolio highlights strong demand for comfort-driven materials, sustainability-driven fibers, and functional design details that bridge outdoor and everyday wear.`;
  sections.push(body(execSummary));
  const keyFindings = insights?.keyFindings || [
    'Stretch fabrics remain the most consistent performance driver across categories',
    'High-waist silhouettes dominate womenswear bottoms',
    'Recycled materials are increasingly present across core brands',
    'Utility features are migrating into casual, everyday assortments',
    'Retro-inspired washes and silhouettes continue to resonate with consumers',
  ];
  keyFindings.forEach(k => sections.push(bullet(k)));

  // Brand Analysis
  sections.push(pageBreak());
  sections.push(smallText(meta.preparedLine));
  sections.push(h1('02 BRAND ANALYSIS'));
  const brandEntries = (insights?.brandAnalysis && insights.brandAnalysis.length > 0)
    ? insights.brandAnalysis
    : safeStats.brandDist.map(([brand, count]) => {
        const items = safeProducts.filter(p => (p.brand || 'Unknown') === brand);
        const categories = [...new Set(items.map(p => p.category || 'Unknown'))].join(', ');
        return {
          brand,
          productCount: count,
          positioning: defaultBrandDescriptor(items),
          categories,
          highlights: defaultBrandHighlights(items),
        };
      });

  brandEntries.forEach(entry => {
    const brand = entry.brand || 'Unknown';
    const productCount = entry.productCount || safeProducts.filter(p => (p.brand || 'Unknown') === brand).length;
    const positioning = entry.positioning || defaultBrandDescriptor(safeProducts.filter(p => (p.brand || 'Unknown') === brand));
    const categories = Array.isArray(entry.categories) ? entry.categories.join(', ') : (entry.categories || '');
    const highlights = entry.highlights || entry.points || entry.keyPoints || defaultBrandHighlights(safeProducts.filter(p => (p.brand || 'Unknown') === brand));

    sections.push(body(brand, { bold: true }));
    sections.push(body(`${productCount} products | ${positioning}`));
    if (categories) sections.push(body(`Categories: ${categories}`));
    if (Array.isArray(highlights)) {
      highlights.forEach(h => sections.push(bullet(h)));
    }
  });

  // Category Analysis
  sections.push(pageBreak());
  sections.push(smallText(meta.preparedLine));
  sections.push(h1('03 CATEGORY ANALYSIS'));
  const categoryEntries = (insights?.categoryAnalysis && insights.categoryAnalysis.length > 0)
    ? insights.categoryAnalysis
    : safeStats.categoryDist.map(([category, count]) => ({
        category,
        productCount: count,
        portfolioShare: pct(count, total),
        insights: defaultCategoryBullets(category, safeProducts.filter(p => (p.category || 'Unknown') === category)),
      }));

  categoryEntries.forEach(entry => {
    const category = entry.category || 'Category';
    const count = entry.productCount || safeProducts.filter(p => (p.category || 'Unknown') === category).length;
    const share = entry.portfolioShare || pct(count, total);
    const bullets = entry.insights || defaultCategoryBullets(category, safeProducts.filter(p => (p.category || 'Unknown') === category));

    sections.push(body(category, { bold: true }));
    sections.push(body(`~${count} products | ${share} of portfolio`));
    if (Array.isArray(bullets)) bullets.forEach(b => sections.push(bullet(b)));
  });

  // Product Catalog
  sections.push(pageBreak());
  sections.push(smallText(meta.preparedLine));
  sections.push(h1('04 PRODUCT CATALOG'));
  sections.push(body(`Complete listing of all ${total} best-selling products organized by brand.`));
  const catalogItems = (insights?.productCatalog && insights.productCatalog.length > 0)
    ? insights.productCatalog
    : products;

  sections.push(new Table({ columnWidths: [2000, 1600, 3200, 2200, 2600], rows: [
    new TableRow({ tableHeader: true, children: [
      hCell('Brand', 2000),
      hCell('Style #', 1600),
      hCell('Product Name', 3200),
      hCell('Category', 2200),
      hCell('Fabric', 2600),
    ] }),
    ...catalogItems.map(p => {
      const brand = p.brand || p.brandName || 'Unknown';
      const style = p.style || p.code || '';
      const name = p.name || p.productName || 'Product';
      const category = p.category || 'Category';
      const fabric = p.fabric || p.composition || p.compositionText || (Array.isArray(p.materials) ? p.materials.join(', ') : p.materials) || '';
      return new TableRow({ children: [
        dCell(brand, 2000),
        dCell(style, 1600),
        dCell(name, 3200),
        dCell(category, 2200),
        dCell(fabric, 2600),
      ] });
    }),
  ]}));

  // Trend Insights
  sections.push(pageBreak());
  sections.push(smallText(meta.preparedLine));
  sections.push(h1('05 TREND INSIGHTS'));
  sections.push(body('Five macro trends emerge from the best-seller portfolio, cutting across brands and categories:'));
  const trends = (insights?.trendInsights && insights.trendInsights.length > 0)
    ? insights.trendInsights
    : deriveTrendInsights(products, stats);
  trends.forEach((t, i) => sections.push(clusterParagraph(i + 1, t.title, t.description)));

  return sections;
}

function buildAdaptiveSections(data) {
  const { meta, stats, products, insights, showTextOnly } = data;
  const safeStats = stats || { total: 0, categoryDist: [], materialDist: [], fitDist: [], styleDist: [], featureDist: [], priceDist: [] };
  const safeProducts = Array.isArray(products) ? products : [];
  const total = safeStats.total || safeProducts.length;
  const topCategories = Array.isArray(safeStats.categoryDist) ? safeStats.categoryDist : [];
  const topMaterials = Array.isArray(safeStats.materialDist) ? safeStats.materialDist : [];
  const fitRows = buildFitDistributionRows(insights, safeStats, safeProducts, 'adaptive')
    .filter((row) => row?.fitType);
  const sections = [];

  const categoryEntries = (Array.isArray(insights?.garmentCategoryAnalysis) && insights.garmentCategoryAnalysis.length > 0)
    ? insights.garmentCategoryAnalysis
    : (Array.isArray(insights?.categoryAnalysis) && insights.categoryAnalysis.length > 0)
      ? insights.categoryAnalysis
      : topCategories.map(([category, count]) => ({
          category,
          count,
          share: pct(count, total),
          insights: defaultCategoryBullets(category, safeProducts.filter((product) => categorizeForTemplate(product, 'single-brand') === category)),
        }));

  const wearMixMap = {};
  safeProducts.forEach((product) => {
    const key = wearGroup(categorizeForTemplate(product, 'single-brand'));
    wearMixMap[key] = (wearMixMap[key] || 0) + 1;
  });
  const wearMix = Object.entries(wearMixMap).sort((left, right) => right[1] - left[1]);

  const keyFindings = Array.isArray(insights?.keyFindings) && insights.keyFindings.length > 0
    ? insights.keyFindings
    : [
        `Assortment covers ${total} styles across ${topCategories.length || 0} garment families, led by ${topCategories[0]?.[0] || 'core apparel categories'}.`,
        `Material story is led by ${topMaterials.slice(0, 3).map(([label]) => label).filter(Boolean).join(', ') || 'core natural and blended fabrics'}.`,
        fitRows.length > 0 && !fitRows.every((row) => /fit not specified/i.test(row.fitType))
          ? `Silhouette direction is anchored by ${fitRows[0]?.fitType || 'commercial fits'}, rather than a single generic standard block.`
          : 'Fit evidence is limited in the source, so the report focuses more on garment family, construction, and fabric direction than forced fit claims.',
        'Commercial read centers on wearable categories, material logic, and category architecture rather than only page-by-page listing.',
      ];

  const assortmentOverview = insights?.assortmentOverview
    || insights?.productOverview
    || `The collection is structured as a commercial apparel assortment rather than a flat list of pages. It combines clear garment families, material stories, and wearable silhouettes, with emphasis on what appears scalable in real retail terms.`;

  const architectureHeadline = insights?.assortmentArchitecture?.headline
    || `The assortment architecture is led by ${topCategories[0]?.[0] || 'core apparel'}, with ${wearMix.length > 0 ? wearMix[0][0].toLowerCase() : 'balanced top and bottom'} dominating the style mix.`;

  const materialAnalysis = insights?.materialAnalysis
    || `Material direction is led by ${topMaterials[0]?.[0] || 'core fabrics'}, with secondary emphasis on ${topMaterials.slice(1, 3).map(([label]) => label).join(' and ') || 'seasonal texture and comfort blends'}.`;

  const materialRows = (Array.isArray(insights?.keyMaterialTypes) && insights.keyMaterialTypes.length > 0
    ? insights.keyMaterialTypes
    : topMaterials.slice(0, 6).map(([materialType]) => ({
        materialType,
        application: `Used across ${categoryEntries.slice(0, 3).map((entry) => entry.category).filter(Boolean).join(', ') || 'core categories'}`,
        features: materialType === 'Cotton'
          ? 'Breathable, versatile, and commercially dependable'
          : materialType === 'Denim'
            ? 'Durable structure with heritage casual appeal'
            : materialType === 'Linen'
              ? 'Seasonal dryness, texture, and lightweight breathability'
              : 'Supports handle, drape, comfort, or technical performance',
      })));

  const designLanguage = insights?.designLanguage
    || `Design language is commercially grounded, focusing on wearable detailing, category-consistent construction, and materials that support a clear retail proposition instead of purely editorial novelty.`;

  const designFeatures = Array.isArray(insights?.keyDesignFeatures) && insights.keyDesignFeatures.length > 0
    ? insights.keyDesignFeatures
    : (Array.isArray(safeStats.featureDist) ? safeStats.featureDist.slice(0, 10).map(([feature]) => feature) : []).filter(Boolean);

  const styleClusters = Array.isArray(insights?.styleClusters) ? insights.styleClusters.filter(Boolean) : [];
  const targetConsumerProfile = Array.isArray(insights?.targetConsumerProfile) ? insights.targetConsumerProfile.filter(Boolean) : [];
  const recommendations = Array.isArray(insights?.strategicRecommendations) ? insights.strategicRecommendations.filter(Boolean) : [];

  sections.push(spacer(), spacer());
  sections.push(centeredText(meta.brandLine || 'APPAREL COLLECTION', 48, BRAND_COLOR, true));
  sections.push(centeredText('APPAREL PRODUCT ANALYSIS REPORT', 26, '666666'));
  sections.push(centeredText(meta.collectionLabel || '', 24, '666666'));
  sections.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 280 },
    children: [new TextRun({ text: `Generated: ${meta.generatedDate}`, size: 22, font: FONT, color: '999999' })],
  }));

  sections.push(pageBreak());
  sections.push(h1('Executive Summary'));
  sections.push(body(insights?.executiveSummary || `This report reviews ${total} apparel styles through garment family, fabric story, silhouette evidence, and commercial design language, with the goal of surfacing a retail-ready reading instead of a rigid page-by-page summary.`));
  keyFindings.forEach((finding) => sections.push(bullet(finding)));

  sections.push(h1('Assortment Architecture'));
  sections.push(body(assortmentOverview));
  sections.push(body(architectureHeadline, { bold: true }));

  if (categoryEntries.length > 0) {
    const categoryRows = [
      new TableRow({ tableHeader: true, children: [hCell('Garment Family', 3200), hCell('Count', 1200), hCell('Share', 1200), hCell('Read', 3600)] }),
      ...categoryEntries.slice(0, 12).map((entry) => {
        const count = Number(entry.count || entry.productCount) || 0;
        const share = entry.share || entry.portfolioShare || pct(count, total);
        const read = Array.isArray(entry.insights) ? entry.insights[0] : (entry.insights || 'Core category within the assortment.');
        return new TableRow({
          children: [
            dCell(entry.category || 'Category', 3200),
            dCell(String(count), 1200, AlignmentType.CENTER),
            dCell(share, 1200, AlignmentType.CENTER),
            dCell(read, 3600),
          ],
        });
      }),
    ];
    sections.push(new Table({ columnWidths: [3200, 1200, 1200, 3600], rows: categoryRows }));
  }

  if (wearMix.length > 0) {
    sections.push(h2('Wear Mix'));
    wearMix.forEach(([label, count]) => sections.push(bullet(`${label}: ${count} styles`)));
  }

  sections.push(h1('Material & Fabric Story'));
  sections.push(body(materialAnalysis));
  if (materialRows.length > 0) {
    const rows = [
      new TableRow({ tableHeader: true, children: [hCell('Material', 2400), hCell('Application', 3300), hCell('Commercial Read', 3300)] }),
      ...materialRows.slice(0, 8).map((row) => new TableRow({
        children: [
          dCell(row.materialType || '-', 2400),
          dCell(row.application || '-', 3300),
          dCell(row.features || '-', 3300),
        ],
      })),
    ];
    sections.push(new Table({ columnWidths: [2400, 3300, 3300], rows }));
  }
  if (Array.isArray(insights?.specialFinishes) && insights.specialFinishes.length > 0) {
    sections.push(h2('Surface / Finish Notes'));
    insights.specialFinishes.forEach((item) => sections.push(bullet(item)));
  }

  sections.push(h1('Silhouette & Fit'));
  sections.push(body(insights?.fitAnalysis || (fitRows.length > 0 && !fitRows.every((row) => /fit not specified/i.test(row.fitType))
    ? `The silhouette read is driven by ${fitRows[0]?.fitType || 'commercial everyday fits'}, with fit language used only where the source provides enough evidence.`
    : 'Explicit fit language is limited in the source, so silhouette conclusions are kept conservative and category-led rather than forcing generic “standard” labels.')));
  if (fitRows.length > 0) {
    const rows = [
      new TableRow({ tableHeader: true, children: [hCell('Fit / Silhouette', 2600), hCell('Count', 1200), hCell('Characteristics', 5200)] }),
      ...fitRows.slice(0, 8).map((row) => new TableRow({
        children: [
          dCell(row.fitType || '-', 2600),
          dCell(String(row.count || 0), 1200, AlignmentType.CENTER),
          dCell(row.characteristics || '-', 5200),
        ],
      })),
    ];
    sections.push(new Table({ columnWidths: [2600, 1200, 5200], rows }));
  }

  sections.push(h1('Design Language & Product Detail'));
  sections.push(body(designLanguage));
  if (designFeatures.length > 0) {
    designFeatures.slice(0, 12).forEach((item) => sections.push(bullet(item)));
  }

  if (styleClusters.length > 0) {
    sections.push(h1('Style Clusters'));
    styleClusters.forEach((cluster, index) => sections.push(clusterParagraph(index + 1, cluster.name || `Cluster ${index + 1}`, cluster.description || '')));
  }

  if (targetConsumerProfile.length > 0) {
    sections.push(h1('Target Consumer Profile'));
    targetConsumerProfile.forEach((item) => sections.push(bullet(item)));
  }

  if (recommendations.length > 0) {
    sections.push(h1('Strategic Recommendations'));
    recommendations.forEach((item, index) => sections.push(numberedItem(index + 1, item)));
  }

  sections.push(h1('Product Appendix'));
  const appendixRows = [
    new TableRow({ tableHeader: true, children: [
      hCell('Style #', 1600),
      hCell('Product Name', 3200),
      hCell('Category', 2200),
      hCell('Fit', 1500),
      hCell('Materials / Composition', 2500),
    ] }),
    ...safeProducts
      .slice()
      .sort((left, right) => String(left.code || '').localeCompare(String(right.code || '')))
      .map((product) => new TableRow({
        children: [
          dCell(product.code || '-', 1600),
          dCell(product.name || '-', 3200),
          dCell(categorizeForTemplate(product, 'single-brand'), 2200),
          dCell(fitLabelForListing(product, 'adaptive') || '-', 1500),
          dCell(formatComposition(product) || '-', 2500),
        ],
      })),
  ];
  sections.push(new Table({ columnWidths: [1600, 3200, 2200, 1500, 2500], rows: appendixRows }));

  if (!showTextOnly || insights?.conclusion) {
    sections.push(h1('Conclusion'));
    sections.push(body(insights?.conclusion || `The collection reads most clearly when organized by garment family, fabric logic, and silhouette evidence. This adaptive format is intended to stay closer to the actual apparel assortment instead of forcing every source into a rigid canned template.`));
  }

  return sections;
}

// ── Single Brand Template Sections ─────────────────────
function buildSingleBrandSections(data) {
  const { meta, stats, products, insights, showTextOnly } = data;
  // Defensive: ensure stats has required properties
  const safeStats = stats || { total: 0, categoryDist: [], materialDist: [], fitDist: [], styleDist: [], featureDist: [], priceDist: [] };
  // Defensive: ensure products is an array
  const safeProducts = Array.isArray(products) ? products : [];
  const total = safeStats.total;
  const sections = [];
  
  // Title Page
  sections.push(spacer(), spacer());
  sections.push(centeredText(meta.brandLine || 'SINGLE BRAND', 48, BRAND_COLOR, true));
  sections.push(centeredText('PRODUCT COLLECTION REPORT', 28, '666666'));
  sections.push(centeredText(meta.collectionLabel || '', 28, '666666'));
  sections.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 300 },
    children: [new TextRun({ text: `Generated: ${meta.generatedDate}`, size: 22, font: FONT, color: "999999" })] }));
  
  if (showTextOnly) {
    // Text-only report: Show product data and stats
    sections.push(spacer(), h1('Product Data'));
    
    // Product table
    const sortedProducts = [...safeProducts].sort((a, b) => String(a.code || '').localeCompare(String(b.code || '')));
    const productTableRows = [
      new TableRow({ tableHeader: true, children: [
        hCell('Code', 1500), hCell('Name', 3000), hCell('Category', 2000), hCell('Materials', 3000)
      ]})
    ];
    
    (sortedProducts || []).forEach(p => {
      productTableRows.push(new TableRow({
        children: [
          dCell(p.code || '-', 1500),
          dCell((p.name || '').slice(0, 50), 3000),
          dCell(categorizeForTemplate(p, 'single-brand'), 2000),
          dCell(formatComposition(p) || '-', 3000)
        ]
      }));
    });
    
    sections.push(new Table({ columnWidths: [1500, 3000, 2000, 3000], rows: productTableRows }));
    
    // Summary statistics
    sections.push(spacer(), h1('Summary Statistics'));
    sections.push(body(`Total Products: ${total}`, { bold: true }));
    sections.push(body(`Categories: ${safeStats.categoryDist?.length || 0}`, { bold: true }));
    sections.push(body(`Materials: ${safeStats.materialDist?.length || 0}`, { bold: true }));
    
    // Category distribution
    sections.push(spacer(), h2('Category Distribution'));
    const catRows = [
      new TableRow({ tableHeader: true, children: [hCell('Category', 5500), hCell('Count', 2500)] }),
    ];
    (safeStats.categoryDist || []).forEach(([k, v]) => {
      catRows.push(new TableRow({ children: [dCell(k, 5500), dCell(String(v), 2500, AlignmentType.CENTER)] }));
    });
    sections.push(new Table({ columnWidths: [5500, 2500], rows: catRows }));
    
    // Material distribution
    sections.push(spacer(), h2('Material Distribution'));
    const matRows = [
      new TableRow({ tableHeader: true, children: [hCell('Material', 5500), hCell('Count', 2500)] }),
    ];
    (safeStats.materialDist || []).slice(0, 20).forEach(([k, v]) => {
      matRows.push(new TableRow({ children: [dCell(k, 5500), dCell(String(v), 2500, AlignmentType.CENTER)] }));
    });
    sections.push(new Table({ columnWidths: [5500, 2500], rows: matRows }));

    const textOnlyFitRows = buildFitDistributionRows(null, safeStats, safeProducts, 'single-brand');
    if (textOnlyFitRows.length > 0) {
      sections.push(spacer(), h2('Fit Distribution'));
      sections.push(new Table({ columnWidths: [3500, 1800, 3000], rows: [
        new TableRow({ tableHeader: true, children: [
          hCell('Fit Type', 3500), hCell('Count', 1800), hCell('Characteristics', 3000)
        ] }),
        ...textOnlyFitRows.map((row) => new TableRow({ children: [
          dCell(row.fitType, 3500),
          dCell(String(row.count), 1800, AlignmentType.CENTER),
          dCell(row.characteristics, 3000),
        ] })),
      ] }));
    }
    
    // Add AI-generated table data if available (even without full AI analysis)
    if (insights?.keyMaterialTypes) {
      sections.push(spacer(), h2('Key Material Types (AI Extracted)'));
      const materialRows = [
        new TableRow({ tableHeader: true, children: [
          hCell('Material Type', 2500), hCell('Application', 3000), hCell('Features', 3000)
        ]})
      ];
      (insights.keyMaterialTypes || []).forEach(m => {
        materialRows.push(new TableRow({
          children: [
            dCell(m.materialType || '-', 2500),
            dCell(m.application || '-', 3000),
            dCell(m.features || '-', 3000)
          ]
        }));
      });
      sections.push(new Table({ columnWidths: [2500, 3000, 3000], rows: materialRows }));
    }
    
    sections.push(spacer(), body('Note: This is a text-only extraction report. Enable AI analysis for detailed insights.', { italic: true }));
    
  } else {
    // AI-enabled report - use full analysis
    sections.push(spacer(), spacer());
    sections.push(centeredText(meta.brandLine || 'SINGLE BRAND', 48, BRAND_COLOR, true));
    sections.push(centeredText('STYLE COLLECTION LOOKBOOK', 28, '666666'));
    sections.push(centeredText(meta.collectionLabel || '', 28, '666666'));
    sections.push(centeredText('Product Analysis Report', 28, '666666'));
    sections.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 300 },
      children: [new TextRun({ text: `Generated: ${meta.generatedDate}`, size: 22, font: FONT, color: "999999" })] }));

    // Executive Summary
    sections.push(h1('Executive Summary'));
    const execSummary = insights?.executiveSummary ||
      `This report analyzes the ${meta.collectionLabel} product collection from product features, material composition, style positioning, and market trends.`;
    sections.push(body(execSummary));
    sections.push(body('Key Findings:', { bold: true }));

    const topMaterial = safeStats.materialDist?.[0]?.[0] || 'Cotton';
    const topCategory = safeStats.categoryDist?.[0]?.[0] || 'Core Categories';
    const keyFindings = insights?.keyFindings || [
      `Total of ${total} product styles analyzed across ${safeStats.categoryDist?.length || 0} clothing categories`,
      `${topMaterial}-based fabrics dominate the collection`,
      `Category mix is led by ${topCategory}`,
    ];
    keyFindings.forEach(k => sections.push(bullet(k)));

    // Product Overview
    sections.push(h1('Product Overview'));
    const overview = insights?.productOverview ||
      `The ${meta.collectionLabel} collection encompasses ${total} items spanning core categories.`;
    sections.push(body(overview));
    sections.push(h2('Category Distribution'));
    const aiCatRows = [
      new TableRow({ tableHeader: true, children: [hCell('Category', 5500), hCell('Product Count', 2500)] }),
    ];
    (safeStats.categoryDist || []).forEach(([k, v]) => {
      aiCatRows.push(new TableRow({ children: [dCell(k, 5500), dCell(String(v), 2500, AlignmentType.CENTER)] }));
    });
    sections.push(new Table({ columnWidths: [5500, 2500], rows: aiCatRows }));
    sections.push(spacer());

    // Material Composition
    sections.push(h1('Material Composition Analysis'));
    const materialAnalysis = insights?.materialAnalysis || `The collection features a diverse range of materials led by ${topMaterial}.`;
    sections.push(body(materialAnalysis));
    
    if (insights?.keyMaterialTypes?.length > 0) {
      sections.push(h2('Key Material Types'));
      const matRows = [new TableRow({ tableHeader: true, children: [hCell('Material Type', 2500), hCell('Application', 3000), hCell('Features', 3000)] })];
      insights.keyMaterialTypes.forEach(m => {
        matRows.push(new TableRow({ children: [dCell(m.materialType || '-', 2500), dCell(m.application || '-', 3000), dCell(m.features || '-', 3000)] }));
      });
      sections.push(new Table({ columnWidths: [2500, 3000, 3000], rows: matRows }));
    }
    sections.push(spacer());

    const aiFitRows = buildFitDistributionRows(insights, safeStats, safeProducts, 'single-brand');
    if (aiFitRows.length > 0 || insights?.fitAnalysis) {
      sections.push(h1('Fit & Silhouette Analysis'));
      const fitAnalysis = insights?.fitAnalysis ||
        `The assortment leans on commercially wearable fits, with the dominant silhouette direction led by ${aiFitRows[0]?.fitType || safeStats.fitDist?.[0]?.[0] || 'Regular Fit'}.`;
      sections.push(body(fitAnalysis));
      if (aiFitRows.length > 0) {
        sections.push(h2('Fit Distribution'));
        sections.push(new Table({ columnWidths: [2800, 1600, 4100], rows: [
          new TableRow({ tableHeader: true, children: [
            hCell('Fit Type', 2800), hCell('Count', 1600), hCell('Characteristics', 4100)
          ] }),
          ...aiFitRows.map((row) => new TableRow({ children: [
            dCell(row.fitType, 2800),
            dCell(String(row.count), 1600, AlignmentType.CENTER),
            dCell(row.characteristics, 4100),
          ] })),
        ] }));
      }
      sections.push(spacer());
    }

    // Design Features
    if (insights?.keyDesignFeatures?.length > 0) {
      sections.push(h1('Key Design Features'));
      sections.push(body(insights.keyDesignFeatures.join('. ') + '.'));
      sections.push(spacer());
    }

    const styleAttrDist = (insights?.styleAttributesDistribution && insights.styleAttributesDistribution.length > 0)
      ? insights.styleAttributesDistribution.map((item) => [item.attribute, item.frequency])
      : countByList(safeProducts.flatMap(inferStyleAttributes));
    if (styleAttrDist.length > 0) {
      sections.push(h1('Style Attributes Distribution'));
      sections.push(new Table({ columnWidths: [5500, 2500], rows: [
        new TableRow({ tableHeader: true, children: [
          hCell('Style Attribute', 5500), hCell('Frequency', 2500)
        ] }),
        ...styleAttrDist.map(([label, count]) => new TableRow({ children: [
          dCell(label, 5500),
          dCell(String(count), 2500, AlignmentType.CENTER),
        ] })),
      ] }));
      sections.push(spacer());
    }

    // Style Clusters
    if (insights?.styleClusters?.length > 0) {
      sections.push(h1('Style Clusters'));
      insights.styleClusters.forEach((c, i) => {
        sections.push(clusterParagraph(i + 1, c.name || '', c.description || ''));
      });
      sections.push(spacer());
    }

    // Consumer Profile
    if (insights?.targetConsumerProfile?.length > 0) {
      sections.push(h1('Target Consumer Profile'));
      insights.targetConsumerProfile.forEach(p => sections.push(bullet(p)));
      sections.push(spacer());
    }

    // Recommendations
    if (insights?.strategicRecommendations?.length > 0) {
      sections.push(h1('Strategic Recommendations'));
      insights.strategicRecommendations.forEach(r => sections.push(bullet(r)));
      sections.push(spacer());
    }

    // Conclusion
    if (insights?.conclusion) {
      sections.push(h1('Conclusion'));
      sections.push(body(insights.conclusion));
    }

    if (safeProducts.length > 0) {
      sections.push(h1('Detailed Product Listings'));
      const sortedProducts = [...safeProducts].sort((a, b) => String(a.code || '').localeCompare(String(b.code || '')));
      sections.push(new Table({ columnWidths: [1800, 3000, 1600, 3100], rows: [
        new TableRow({ tableHeader: true, children: [
          hCell('Style #', 1800),
          hCell('Product Name', 3000),
          hCell('Fit', 1600),
          hCell('Composition', 3100),
        ] }),
        ...sortedProducts.map((product) => new TableRow({ children: [
          dCell(product.code || '-', 1800),
          dCell(product.name || '-', 3000),
          dCell(fitLabelForListing(product, 'single-brand'), 1600),
          dCell(formatComposition(product) || '-', 3100),
        ] })),
      ] }));
    }
  }

  return sections;
}

function buildMenswearSections(data) {
  const { meta, stats, products, insights } = data;
  const safeStats = stats || { total: 0, categoryDist: [], materialDist: [], fitDist: [], styleDist: [], featureDist: [], priceDist: [] };
  const safeProducts = Array.isArray(products) ? products : [];
  const total = safeStats.total;

  const sections = [];
  sections.push(spacer(), spacer());
  sections.push(centeredText(meta.brandLine, 48, BRAND_COLOR, true));
  sections.push(centeredText('STYLE COLLECTION LOOKBOOK', 28, '666666'));
  sections.push(centeredText(meta.collectionLabel, 28, '666666'));
  sections.push(centeredText('Product Analysis Report', 28, '666666'));
  sections.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 300 },
    children: [new TextRun({ text: `Generated: ${meta.generatedDate}`, size: 22, font: FONT, color: "999999" })] }));

  // Executive Summary
  sections.push(h1('Executive Summary'));
  const execSummary = insights?.executiveSummary ||
    `This report analyzes ZARA's ${meta.collectionLabel} menswear collection from product features, material composition, style positioning, and market trends. The collection demonstrates ZARA's ongoing commitment to versatility, sustainability, and functionality in contemporary menswear.`;
  sections.push(body(execSummary));
  sections.push(body('Key Findings:', { bold: true }));

  const topMaterial = safeStats.materialDist[0]?.[0] || 'Cotton';
  const topFit = safeStats.fitDist[0]?.[0] || 'Regular Fit';
  const topCategory = safeStats.categoryDist[0]?.[0] || 'Core Categories';
  const keyFindings = insights?.keyFindings || [
    `Total of ${total} product styles analyzed across ${safeStats.categoryDist.length} clothing categories`,
    `${topMaterial}-based fabrics dominate the collection`,
    `${topFit} and functional design elements are prominent across the assortment`,
    `Category mix is led by ${topCategory}, balancing style and practicality`,
  ];
  keyFindings.forEach(k => sections.push(bullet(k)));

  // Product Overview
  sections.push(h1('Product Overview'));
  const overview = insights?.productOverview ||
    `The ${meta.collectionLabel} collection encompasses ${total} menswear items spanning core categories, from everyday essentials to functional outerwear. Each piece balances contemporary aesthetics with practical functionality.`;
  sections.push(body(overview));
  sections.push(h2('Category Distribution'));
  sections.push(new Table({ columnWidths: [5500, 2500], rows: [
    new TableRow({ tableHeader: true, children: [hCell('Category', 5500), hCell('Product Count', 2500)] }),
    ...safeStats.categoryDist.map(([k, v]) => new TableRow({ children: [dCell(k, 5500), dCell(String(v), 2500, AlignmentType.CENTER)] })),
  ]}));
  sections.push(spacer());

  // Material Composition Analysis
  sections.push(h1('Material Composition Analysis'));
  const materialAnalysis = insights?.materialAnalysis ||
    `The collection features a diverse material palette anchored by ${topMaterial.toLowerCase()}, with investment in durability, comfort, and sustainability-driven fibers.`;
  sections.push(body(materialAnalysis));
  sections.push(h2('Key Material Types'));
  const keyMaterialTypes = (insights?.keyMaterialTypes || []).filter(m => m && m.materialType);
  const fallbackMaterialTypes = safeStats.materialDist.slice(0, 6).map(([m]) => ({
    materialType: m,
    application: 'Across core categories',
    features: 'Comfortable, durable'
  }));
  const materialRows = (keyMaterialTypes.length ? keyMaterialTypes : fallbackMaterialTypes).map(m =>
    new TableRow({ children: [dCell(m.materialType, 2500), dCell(m.application, 3500), dCell(m.features, 3500)] })
  );
  sections.push(new Table({ columnWidths: [2500, 3500, 3500], rows: [
    new TableRow({ tableHeader: true, children: [hCell('Material Type', 2500), hCell('Application', 3500), hCell('Features', 3500)] }),
    ...materialRows,
  ]}));

  const specialFinishes = (insights?.specialFinishes && insights.specialFinishes.length > 0)
    ? insights.specialFinishes
    : extractSpecialFinishes(safeProducts);
  if (specialFinishes && specialFinishes.length > 0) {
    sections.push(spacer());
    sections.push(body('Special Finishes:', { bold: true }));
    specialFinishes.forEach(s => sections.push(bullet(s)));
  }

  // Fit & Design Characteristics
  sections.push(h1('Fit & Design Characteristics'));
  const fitAnalysis = insights?.fitAnalysis ||
    `The collection balances various silhouettes to accommodate different body types and style preferences, with a decisive shift toward volume and ease.`;
  sections.push(body(fitAnalysis));
  sections.push(h2('Fit Distribution'));
  sections.push(new Table({ columnWidths: [4500, 2500, 2500], rows: [
    new TableRow({ tableHeader: true, children: [hCell('Fit Type', 4500), hCell('Count', 2500), hCell('Percentage', 2500)] }),
    ...safeStats.fitDist.map(([k, v]) => new TableRow({ children: [dCell(k, 4500), dCell(String(v), 2500, AlignmentType.CENTER), dCell(pct(v, total), 2500, AlignmentType.CENTER)] })),
  ]}));
  sections.push(spacer());

  sections.push(body('Key Design Features:', { bold: true }));
  const keyDesign = (insights?.keyDesignFeatures && insights.keyDesignFeatures.length > 0)
    ? insights.keyDesignFeatures
    : safeStats.featureDist.slice(0, 6).map(([k]) => k);
  keyDesign.forEach(f => sections.push(bullet(f)));

  // Style Positioning Analysis
  sections.push(h1('Style Positioning Analysis'));
  sections.push(h2('Style Attributes Distribution'));
  const styleAttrDist = (insights?.styleAttributesDistribution && insights.styleAttributesDistribution.length > 0)
    ? insights.styleAttributesDistribution.map(i => [i.attribute, i.frequency])
    : countByList(safeProducts.flatMap(inferStyleAttributes));
  sections.push(new Table({ columnWidths: [5500, 2500], rows: [
    new TableRow({ tableHeader: true, children: [hCell('Style Attribute', 5500), hCell('Frequency', 2500)] }),
    ...styleAttrDist.map(([k, v]) => new TableRow({ children: [dCell(k, 5500), dCell(String(v), 2500, AlignmentType.CENTER)] })),
  ]}));

  const styleClusters = (insights?.styleClusters && insights.styleClusters.length > 0)
    ? insights.styleClusters
    : [
        { name: 'Tech-Forward Innovation', description: 'Technical fabrics and functional detailing target the active urban consumer.' },
        { name: 'Heritage Revival', description: 'Classic patterns and denim references balance vintage aesthetics with modern fits.' },
        { name: 'Modern Essentials', description: 'Clean silhouettes and versatile pieces form the wardrobe foundation.' },
      ];
  sections.push(h2('Style Clusters'));
  styleClusters.forEach((c, i) => sections.push(clusterParagraph(i + 1, c.name, c.description)));

  // Detailed Product Listings
  sections.push(h1('Detailed Product Listings'));
  const grouped = { 'Top Wear': [], 'Bottom Wear': [] };
  for (const p of safeProducts) {
    const cat = categorizeForTemplate(p, 'menswear');
    const group = wearGroup(cat);
    grouped[group].push(p);
  }

  for (const groupName of ['Top Wear', 'Bottom Wear']) {
    if (grouped[groupName].length === 0) continue;
    sections.push(h2(groupName));
    sections.push(new Table({ columnWidths: [1600, 3400, 1500, 3400], rows: [
      new TableRow({ tableHeader: true, children: [
        hCell('Style No.', 1600), hCell('Product Name', 3400), hCell('Fit', 1500), hCell('Composition', 3400)
      ] }),
      ...grouped[groupName].map(p => new TableRow({ children: [
        dCell(p.code, 1600),
        dCell(p.name, 3400),
        dCell(fitLabelForListing(p, 'menswear'), 1500),
        dCell(formatComposition(p), 3400),
      ] })),
    ]}));
  }

  // Market Positioning & Recommendations
  sections.push(h1('Market Positioning & Recommendations'));
  sections.push(body('Target Consumer Profile:', { bold: true }));
  const targetProfile = (insights?.targetConsumerProfile && insights.targetConsumerProfile.length > 0)
    ? insights.targetConsumerProfile
    : [
        'Style-conscious men aged 20-40 seeking versatile, comfort-driven wardrobes',
        'Urban professionals who value both aesthetics and functionality',
        'Sustainability-aware consumers attracted to certified materials',
      ];
  targetProfile.forEach(t => sections.push(bullet(t)));

  sections.push(body('Strategic Recommendations:', { bold: true }));
  const recommendations = (insights?.strategicRecommendations && insights.strategicRecommendations.length > 0)
    ? insights.strategicRecommendations
    : [
        'Expand technical coordination sets to strengthen functional storylines',
        'Highlight sustainability-certified materials as flagship messaging',
        'Balance relaxed silhouettes with a limited range of slim fits to hedge trend shifts',
      ];
  recommendations.forEach((r, i) => sections.push(numberedItem(i + 1, r)));

  // Conclusion
  sections.push(h1('Conclusion'));
  const conclusion = insights?.conclusion ||
    `The ${meta.collectionLabel} menswear collection balances heritage aesthetics with technical innovation, supported by a strong focus on comfort and functional materials. Continued emphasis on sustainability and versatile silhouettes positions the line for broad market appeal.`;
  sections.push(body(conclusion));
  sections.push(body(`Report prepared based on ZARA Style Collection Lookbook ${meta.collectionLabel}`, { color: '666666' }));
  sections.push(body(`Generated: ${meta.generatedDate}`, { color: '666666' }));

  return sections;
}

function buildWomenswearSections(data) {
  const { meta, stats, products, insights } = data;
  const safeStats = stats || { total: 0, categoryDist: [], materialDist: [], fitDist: [], styleDist: [], featureDist: [], priceDist: [] };
  const safeProducts = Array.isArray(products) ? products : [];
  const total = safeStats.total;

  const sections = [];
  sections.push(spacer(), spacer());
  sections.push(centeredText(meta.brandLine, 48, BRAND_COLOR, true));
  sections.push(centeredText('STYLE COLLECTION LOOKBOOK', 28, '666666'));
  sections.push(centeredText(meta.collectionLabel, 28, '666666'));
  sections.push(centeredText('Product Analysis Report', 28, '666666'));
  sections.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 300 },
    children: [new TextRun({ text: `Generated: ${meta.generatedDate}`, size: 22, font: FONT, color: "999999" })] }));

  // Executive Summary
  sections.push(h1('Executive Summary'));
  const execSummary = insights?.executiveSummary ||
    `This report analyzes ZARA's ${meta.collectionLabel} womenswear collection from product features, material composition, style positioning, and market trends. The collection presents a focused assortment with clear category priorities and brand segmentation.`;
  sections.push(body(execSummary));
  sections.push(body('Key Findings:', { bold: true }));

  const topMaterial = safeStats.materialDist[0]?.[0] || 'Cotton';
  const topCategory = safeStats.categoryDist[0]?.[0] || 'Core Categories';
  const keyFindings = insights?.keyFindings || [
    `Total of ${total} product styles analyzed across ${safeStats.categoryDist.length} clothing categories`,
    `${topMaterial}-based fabrics appear across the collection`,
    `Category mix is led by ${topCategory}`,
  ];
  keyFindings.forEach(k => sections.push(bullet(k)));

  // Product Overview
  sections.push(h1('Product Overview'));
  const overview = insights?.productOverview ||
    `The ${meta.collectionLabel} collection presents a curated womenswear assortment emphasizing key denim and outerwear statements alongside versatile tops.`;
  sections.push(body(overview));
  sections.push(h2('Category Distribution'));
  sections.push(new Table({ columnWidths: [5500, 2500], rows: [
    new TableRow({ tableHeader: true, children: [hCell('Category', 5500), hCell('Product Count', 2500)] }),
    ...safeStats.categoryDist.map(([k, v]) => new TableRow({ children: [dCell(k, 5500), dCell(String(v), 2500, AlignmentType.CENTER)] })),
  ]}));
  sections.push(spacer());

  // Material Composition Analysis
  sections.push(h1('Material Composition Analysis'));
  const materialAnalysis = insights?.materialAnalysis ||
    `The collection leverages ${topMaterial.toLowerCase()} as a core material, while selective blends add structure, drape, and sustainability value.`;
  sections.push(body(materialAnalysis));
  sections.push(h2('Key Material Types'));
  const keyMaterialTypes = (insights?.keyMaterialTypes && insights.keyMaterialTypes.length > 0)
    ? insights.keyMaterialTypes
    : safeStats.materialDist.slice(0, 6).map(([m]) => ({
        materialType: m,
        application: 'Across core categories',
        features: 'Comfort and durability'
      }));
  sections.push(new Table({ columnWidths: [2500, 3500, 3500], rows: [
    new TableRow({ tableHeader: true, children: [hCell('Material Type', 2500), hCell('Application', 3500), hCell('Features', 3500)] }),
    ...keyMaterialTypes.map(m => new TableRow({ children: [dCell(m.materialType, 2500), dCell(m.application, 3500), dCell(m.features, 3500)] })),
  ]}));

  const sustainability = (insights?.sustainabilityHighlights && insights.sustainabilityHighlights.length > 0)
    ? insights.sustainabilityHighlights
    : extractSustainabilityHighlights(safeProducts);
  if (sustainability && sustainability.length > 0) {
    sections.push(spacer());
    sections.push(body('Sustainability Highlights:', { bold: true }));
    sustainability.forEach(s => sections.push(bullet(s)));
  }

  // Fit & Design Characteristics
  sections.push(h1('Fit & Design Characteristics'));
  const fitAnalysis = insights?.fitAnalysis ||
    `Each product occupies a unique fit position, ensuring wardrobe versatility across the compact assortment.`;
  sections.push(body(fitAnalysis));
  sections.push(h2('Fit Distribution'));
  const fitRows = (insights?.fitDistribution && insights.fitDistribution.length > 0)
    ? insights.fitDistribution
    :safeProducts.map(p => ({
        fitType: inferWomensFitType(p),
        product: p.name || 'Product',
        silhouetteCharacter: inferSilhouetteCharacter(p)
      }));
  sections.push(new Table({ columnWidths: [2800, 3400, 3200], rows: [
    new TableRow({ tableHeader: true, children: [hCell('Fit Type', 2800), hCell('Product', 3400), hCell('Silhouette Character', 3200)] }),
    ...fitRows.map(r => new TableRow({ children: [dCell(r.fitType, 2800), dCell(r.product, 3400), dCell(r.silhouetteCharacter, 3200)] })),
  ]}));

  sections.push(spacer());
  sections.push(body('Key Design Features:', { bold: true }));
  const keyDesign = (insights?.keyDesignFeatures && insights.keyDesignFeatures.length > 0)
    ? insights.keyDesignFeatures
    : safeStats.featureDist.slice(0, 6).map(([k]) => k);
  keyDesign.forEach(f => sections.push(bullet(f)));

  // Style Positioning Analysis
  sections.push(h1('Style Positioning Analysis'));
  sections.push(h2('Sub-Brand Strategy'));
  const subBrandRows = (insights?.subBrandStrategy && insights.subBrandStrategy.length > 0)
    ? insights.subBrandStrategy
    : Object.entries(safeProducts.reduce((acc, p) => {
        const sb = inferSubBrand(p);
        if (!acc[sb]) acc[sb] = p;
        return acc;
      }, {})).map(([sb, p]) => ({
        subBrand: sb,
        product: p.name || 'Product',
        positioning: defaultSubBrandPositioning(sb)
      }));
  sections.push(new Table({ columnWidths: [2600, 3400, 3400], rows: [
    new TableRow({ tableHeader: true, children: [hCell('Sub-Brand', 2600), hCell('Product', 3400), hCell('Target Positioning', 3400)] }),
    ...subBrandRows.map(r => new TableRow({ children: [dCell(r.subBrand, 2600), dCell(r.product, 3400), dCell(r.positioning, 3400)] })),
  ]}));

  const styleClusters = (insights?.styleClusters && insights.styleClusters.length > 0)
    ? insights.styleClusters
    : [
        { name: 'Power Dressing', description: 'Structured silhouettes and statement outerwear anchor the assortment.' },
        { name: 'Denim Authority', description: 'Multiple fits and washes reinforce core denim positioning.' },
        { name: 'Relaxed Heritage', description: 'Wide-leg and soft blends deliver comfort-forward styling.' },
      ];
  sections.push(h2('Style Clusters'));
  styleClusters.forEach((c, i) => sections.push(clusterParagraph(i + 1, c.name, c.description)));

  // Detailed Product Listings
  sections.push(h1('Detailed Product Listings'));
  sections.push(h2('Complete Collection'));
  sections.push(new Table({ columnWidths: [1800, 3800, 1400, 3000], rows: [
    new TableRow({ tableHeader: true, children: [
      hCell('Style No.', 1800), hCell('Product Name', 3800), hCell('Fit', 1400), hCell('Composition', 3000)
    ] }),
    ...safeProducts.map(p => new TableRow({ children: [
      dCell(p.code, 1800),
      dCell(p.name, 3800),
      dCell(fitLabelForListing(p, 'womenswear'), 1400),
      dCell(formatComposition(p), 3000),
    ] })),
  ]}));

  // Market Positioning & Recommendations
  sections.push(h1('Market Positioning & Recommendations'));
  sections.push(body('Target Consumer Profile:', { bold: true }));
  const targetProfile = (insights?.targetConsumerProfile && insights.targetConsumerProfile.length > 0)
    ? insights.targetConsumerProfile
    : [
        'Fashion-conscious women seeking versatile denim and statement outerwear',
        'Sub-brand-aware consumers navigating differentiated denim tiers',
        'Sustainability-minded shoppers attracted to certified materials',
      ];
  targetProfile.forEach(t => sections.push(bullet(t)));

  sections.push(body('Strategic Recommendations:', { bold: true }));
  const recommendations = (insights?.strategicRecommendations && insights.strategicRecommendations.length > 0)
    ? insights.strategicRecommendations
    : [
        'Expand sustainability certifications across the denim range',
        'Build complete outfit propositions to increase basket size',
        'Communicate sub-brand differentiation clearly in merchandising',
      ];
  recommendations.forEach((r, i) => sections.push(numberedItem(i + 1, r)));

  // Conclusion
  sections.push(h1('Conclusion'));
  const conclusion = insights?.conclusion ||
    `The ${meta.collectionLabel} womenswear collection presents a focused assortment that strengthens core denim positioning while introducing sustainability-driven materials and balanced silhouettes.`;
  sections.push(body(conclusion));
  sections.push(body(`Report prepared based on ZARA Style Collection Lookbook ${meta.collectionLabel}`, { color: '666666' }));
  sections.push(body(`Generated: ${meta.generatedDate}`, { color: '666666' }));

  return sections;
}

async function generateReportFromAnalysis(analysis, outputPath) {
  const { meta, template, products, stats, insights, isAiEnabled } = analysis;
  let sections;
  
  // Determine if we should show text-only content (no AI analysis)
  const showTextOnly = !isAiEnabled && !insights;
  
  if (template === 'multi-brand') {
    sections = buildMultiBrandSections({ meta, stats, products, insights });
  } else if (template === 'adaptive') {
    sections = buildAdaptiveSections({ meta, stats, products, insights, showTextOnly });
  } else if (template === 'single-brand') {
    sections = buildSingleBrandSections({ meta, stats, products, insights, showTextOnly });
  } else if (template === 'menswear') {
    sections = buildMenswearSections({ meta, stats, products, insights });
  } else {
    sections = buildWomenswearSections({ meta, stats, products, insights });
  }

  const doc = new Document({
    styles: {
      default: {
        heading1: { run: { font: FONT, size: 32, bold: true, color: BRAND_COLOR } },
        heading2: { run: { font: FONT, size: 26, bold: true, color: "444444" } },
      }
    },
    sections: [{
      headers: {
        default: new Header({ children: [
          new Paragraph({ alignment: AlignmentType.RIGHT,
            children: [new TextRun({ text: `${meta.reportTitle}`, size: 16, font: FONT, color: "999999" })] })
        ] })
      },
      footers: {
        default: new Footer({ children: [
          new Paragraph({ alignment: AlignmentType.CENTER, children: [
            new TextRun({ text: "Page ", size: 16, font: FONT, color: "999999" }),
            new TextRun({ children: [PageNumber.CURRENT], size: 16, font: FONT, color: "999999" }),
          ] })
        ] })
      },
      children: sections,
    }]
  });

  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);

  const safeStats = stats || {};
  const productCount = (typeof safeStats.total === 'number')
    ? safeStats.total
    : (Array.isArray(products) ? products.length : 0);
  const categoryCount = Array.isArray(safeStats.categoryDist) ? safeStats.categoryDist.length : 0;
  const materialCount = Array.isArray(safeStats.materialDist) ? safeStats.materialDist.length : 0;

  return {
    success: true,
    outputPath,
    productCount: productCount,
    categories: categoryCount,
    materials: materialCount,
    aiEnabled: !!insights,
    template,
    collectionLabel: meta.collectionLabel,
  };
}

// ── 对外入口：从源文件生成 ─────────────────────
/**
 * 检测是否为本地 Ollama 实例
 * 本地地址: localhost, 127.0.0.1, 0.0.0.0, ::1
 * 云端地址: 其他所有地址（包括 https://api.ollama.com, https://ollama.cloud 等）
 */
/**
 * 检测是否为本地 Ollama 实例
 * 本地地址包括:
 * - localhost, 127.0.0.1, 0.0.0.0, ::1
 * - 局域网 IP (10.x.x.x, 192.168.x.x, 172.16-31.x.x)
 * 云端地址: 其他所有公网地址
 */
function isLocalOllama(baseUrl) {
  if (!baseUrl) return true; // 默认认为是本地
  
  const urlStr = baseUrl.toLowerCase();
  
  // 检查常见本地地址模式（包括没有 http:// 的情况）
  const localPatterns = [
    'localhost',
    '127.0.0.1',
    '0.0.0.0',
    '::1',
    '.local',     // mDNS 本地域名
  ];
  
  // 检查是否包含本地模式
  for (const pattern of localPatterns) {
    if (urlStr.includes(pattern)) {
      return true;
    }
  }
  
  // 提取 hostname 进行 IP 段检测
  try {
    let hostname;
    if (urlStr.startsWith('http://') || urlStr.startsWith('https://')) {
      const url = new URL(baseUrl);
      hostname = url.hostname;
    } else {
      // 处理没有协议的情况，如 "192.168.1.100:11434" 或 "localhost:11434"
      const colonIndex = baseUrl.indexOf(':');
      hostname = colonIndex > -1 ? baseUrl.substring(0, colonIndex) : baseUrl;
    }
    
    // 检查是否为有效的 IP 地址
    const ipMatch = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipMatch) {
      const first = parseInt(ipMatch[1]);
      const second = parseInt(ipMatch[2]);
      
      // 192.168.x.x
      if (first === 192 && second === 168) return true;
      
      // 10.x.x.x
      if (first === 10) return true;
      
      // 172.16-31.x.x
      if (first === 172 && second >= 16 && second <= 31) return true;
      
      // 127.x.x.x (回环)
      if (first === 127) return true;
    }
    
    // 检查 .local 域名
    if (hostname.endsWith('.local')) return true;
    
  } catch (e) {
    // URL 解析失败，默认本地
    console.log('[isLocalOllama] URL解析失败，使用本地模式');
    return true;
  }
  
  // 不是已知的本地地址，判定为云端
  return false;
}

function hasReliableStructuredProducts(products = []) {
  if (!Array.isArray(products) || products.length === 0) {
    return false;
  }

  const strongProducts = products.filter((product) => {
    const code = String(product?.code || '').trim();
    const name = String(product?.name || '').trim();

    if (code) {
      return true;
    }

    return Boolean(name) && !/^unknown product$/i.test(name);
  });

  return strongProducts.length >= Math.max(1, Math.ceil(products.length * 0.6));
}

function shouldSkipRedundantAiExtraction(parsed, products = [], options = {}) {
  if (!hasReliableStructuredProducts(products)) {
    return false;
  }

  const extractionMode = options.isLocalExtraction === false ? 'cloud' : 'local';
  const sourceType = String(parsed?.sourceType || '').toLowerCase();
  if (extractionMode === 'cloud') {
    const enoughStructuredProducts = products.length >= 8;
    if (enoughStructuredProducts && ['pdf', 'folder', 'pptx'].includes(sourceType)) {
      return true;
    }
  }

  const hasVisualContext = Array.isArray(parsed?.imagePaths) && parsed.imagePaths.length > 0;
  const hasOcrContext = Boolean(String(parsed?.ocrText || '').trim()) || parsed?.multimodalAugmented === true;
  if (hasVisualContext || hasOcrContext) {
    return false;
  }

  const sourceText = String(parsed?.sourceText || '');
  const sourceLines = Array.isArray(parsed?.sourceLines) ? parsed.sourceLines : [];

  if (sourceType !== 'pdf') {
    return true;
  }

  const shortStructuredPdf =
    sourceText.length <= 5000 &&
    sourceLines.length <= 120 &&
    products.length >= 2;

  return shortStructuredPdf;
}

function buildCompactExtractionSource(products = [], sourceText = '', parsed = null, options = {}) {
  const compactProducts = (Array.isArray(products) ? products : [])
    .slice(0, 80)
    .map((product) => ({
      code: String(product?.code || '').trim(),
      name: String(product?.name || '').trim(),
      primaryCategory: String(product?.primaryCategory || '').trim(),
      subcategory: String(product?.subcategory || '').trim(),
      category: String(product?.category || '').trim(),
      fit: String(product?.fit || '').trim(),
      materials: Array.isArray(product?.materials) ? product.materials.filter(Boolean).slice(0, 6) : [],
      compositionText: String(product?.compositionText || '').trim(),
      description: String(product?.description || '').trim().slice(0, 220),
      collectionSection: String(product?.collectionSection || '').trim(),
    }))
    .filter((product) => product.code || product.name);

  const lines = Array.isArray(parsed?.sourceLines) ? parsed.sourceLines.slice(0, 120) : [];
  const imageCount = Array.isArray(parsed?.imagePaths) ? parsed.imagePaths.length : 0;

  return [
    'Structured product candidates extracted before AI refinement:',
    JSON.stringify(compactProducts, null, 2),
    '',
    `Source type: ${String(parsed?.sourceType || 'unknown')}`,
    `Image count available to the report pipeline: ${imageCount}`,
    '',
    options.apparelVisionSummary ? `Specialist apparel vision notes:\n${options.apparelVisionSummary}\n` : '',
    options.visualCoverageSummary ? `Visual style coverage notes:\n${options.visualCoverageSummary}\n` : '',
    'Refinement goals:',
    '- refine apparel category granularity such as vest, waistcoat, jacket, outerwear, overshirt, shirt, top, coat, or tailored bottom when supported',
    '- refine fit and silhouette, especially for pants and denim: skinny, slim, baggy, straight, tapered, wide leg, barrel, balloon, bootcut, flare, relaxed, loose, jogger, boyfriend, mom, dad, carrot',
    '- preserve and merge compositionText and material clues from the parsed products instead of dropping them',
    '',
    'Selected source text clues:',
    lines.length > 0 ? lines.join('\n') : buildSourceSnippet(sourceText || '', 3500),
  ].join('\n');
}

async function buildPerProductVisionSummaryMap(products = [], options = {}) {
  const emitLog = options.emitLog || (() => {});
  const config = options.apparelVision || null;
  const maxProducts = Number.isFinite(options.maxProducts) ? options.maxProducts : 12;
  const maxImagesPerProduct = Number.isFinite(options.maxImagesPerProduct) ? options.maxImagesPerProduct : 3;
  const contextText = String(options.contextText || '').trim();
  const summaryMap = new Map();

  if (!config || config.enabled === false) {
    return summaryMap;
  }

  const eligibleProducts = (Array.isArray(products) ? products : [])
    .filter((product) => Array.isArray(product?.imagePaths) && product.imagePaths.length > 0)
    .slice(0, maxProducts);

  for (const product of eligibleProducts) {
    const productCode = String(product?.code || '').trim();
    if (!productCode) {
      continue;
    }

    const imagePaths = [...new Set((product.imagePaths || []).filter(Boolean))].slice(0, maxImagesPerProduct);
    if (imagePaths.length === 0) {
      continue;
    }

    try {
      emitLog(`Building product-level vision notes for ${productCode}...`, 'info');
      const result = await describeApparelImages(imagePaths, {
        emitLog: () => {},
        config,
        contextText: [
          productCode ? `Product code: ${productCode}` : '',
          product?.name ? `Product name: ${product.name}` : '',
          product?.category ? `Current category: ${product.category}` : '',
          product?.fit ? `Current fit: ${product.fit}` : '',
          product?.description ? `Current description: ${product.description}` : '',
          contextText ? contextText.slice(0, 600) : '',
        ].filter(Boolean).join('\n'),
        maxImages: maxImagesPerProduct,
      });

      const summary = buildApparelVisionSummary(result);
      if (summary) {
        summaryMap.set(normalizeProductCode(productCode), summary);
      }
    } catch (error) {
      emitLog(`Product-level vision skipped for ${productCode}: ${error.message}`, 'warning');
    }
  }

  return summaryMap;
}

async function refineStructuredProductsWithLLM(llm, products = [], sourceText = '', parsed = null, emitLog = () => {}, options = {}) {
  if (!llm || !Array.isArray(products) || products.length === 0) {
    return [];
  }

  const batchSize = options.batchSize || 18;
  const batches = [];
  for (let index = 0; index < products.length; index += batchSize) {
    batches.push(products.slice(index, index + batchSize));
  }

  const originalTimeout = llm.timeout;
  const refined = [];
  const evidenceText = buildCompactExtractionSource(products, sourceText, parsed, {
    apparelVisionSummary: options.apparelVisionSummary,
    visualCoverageSummary: options.visualCoverageSummary,
  });

  try {
    llm.timeout = options.timeoutMs || originalTimeout;
    emitLog(`Refining ${products.length} parsed product(s) across ${batches.length} AI batch(es)...`, 'info');

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      const batch = batches[batchIndex];
      emitLog(`Refining product batch ${batchIndex + 1}/${batches.length}...`, 'info');

      const payload = batch.map((product) => ({
        code: String(product?.code || '').trim(),
        name: String(product?.name || '').trim(),
        primaryCategory: String(product?.primaryCategory || '').trim(),
        subcategory: String(product?.subcategory || '').trim(),
        category: String(product?.category || '').trim(),
        fit: String(product?.fit || '').trim(),
        materials: Array.isArray(product?.materials) ? product.materials.filter(Boolean).slice(0, 8) : [],
        compositionText: String(product?.compositionText || '').trim(),
        description: String(product?.description || '').trim().slice(0, 240),
        collectionSection: String(product?.collectionSection || '').trim(),
        features: Array.isArray(product?.features) ? product.features.filter(Boolean).slice(0, 10) : [],
        visualNotes: options.perProductVisionSummaryMap instanceof Map
          ? (options.perProductVisionSummaryMap.get(normalizeProductCode(product?.code || '')) || '')
          : '',
      }));

      const prompt = `You are refining an apparel product list that was already parsed from a fashion source.

${buildFashionDomainInstructions()}

Your task:
- keep the SAME products and SAME codes
- do NOT add new products
- do NOT delete products
- only improve fields when the source evidence supports it
- focus on category granularity, fit, materials, composition, and visible design detail

Return JSON ONLY as an array of objects. Each object must include:
{
  "code": "same product code",
  "name": "same or improved product name",
  "primaryCategory": "broad apparel family such as Tops, Bottoms, Outerwear, One-Piece, Accessories, Footwear or Underwear",
  "subcategory": "most specific apparel category supportable",
  "category": "most specific apparel category supportable",
  "fit": "most specific fit/silhouette supportable",
  "materials": ["..."],
  "compositionText": "merged composition string if supportable",
  "description": "concise factual product description",
  "features": ["visible or textual design/construction details"]
}

Strict rules:
- Do not collapse real garments into broad buckets when vest, waistcoat, jacket, coat, outerwear, overshirt, blazer, shirt, polo, knitwear, top, jeans, shorts, cargo pants, joggers, or tailored pants is supportable.
- Use "primaryCategory" for the broad family and "subcategory" for the detailed apparel type.
- Keep "category" aligned with "subcategory" unless there is truly no finer category evidence.
- For bottoms, prefer specific fit terms such as Skinny, Slim, Baggy, Straight, Tapered, Wide Leg, Barrel, Balloon, Bootcut, Flare, Relaxed, Loose, Jogger, Boyfriend, Mom, Dad, or Carrot when evidence exists.
- Merge text composition and apparel-vision cues instead of dropping them.
- Preserve any material evidence already present unless it is clearly wrong.
- Leave fit empty only if there is truly no evidence.
- If the evidence context contains batch-level or collection-level visual notes, do NOT apply those notes to every product automatically. Only use a visual cue when it clearly matches the specific product being refined.
- If a product object already includes its own "visualNotes", treat those as higher-priority evidence for that product than any shared batch note.
- Keep output valid JSON only.

Evidence context:
${evidenceText}

Products to refine in this batch:
${JSON.stringify(payload, null, 2)}`;

      const raw = await llm.generate(prompt, { temperature: 0.15, maxTokens: 2200 });
      let parsedJson = parseJsonSafe(raw);
      if (!parsedJson) {
        parsedJson = await attemptJsonRepair(llm, raw, 'product-refine', emitLog);
      }

      const list = Array.isArray(parsedJson)
        ? parsedJson
        : (parsedJson && Array.isArray(parsedJson.products) ? parsedJson.products : []);
      const normalized = list.map(normalizeAiProduct).filter(Boolean);
      refined.push(...normalized);
    }

    return refined;
  } finally {
    llm.timeout = originalTimeout;
  }
}

async function refineProductsIndividuallyWithLLM(llm, products = [], emitLog = () => {}, options = {}) {
  if (!llm || !Array.isArray(products) || products.length === 0) {
    return [];
  }

  const originalTimeout = llm.timeout;
  const refined = [];

  try {
    llm.timeout = options.timeoutMs || originalTimeout;
    emitLog(`Running per-product category refinement for ${products.length} item(s)...`, 'info');

    for (let index = 0; index < products.length; index += 1) {
      const product = products[index];
      const code = String(product?.code || '').trim();
      if (!code) {
        refined.push(product);
        continue;
      }

      emitLog(`Refining category for ${code} (${index + 1}/${products.length})...`, 'info');

      const payload = {
        code,
        name: String(product?.name || '').trim(),
        primaryCategory: String(product?.primaryCategory || '').trim(),
        subcategory: String(product?.subcategory || '').trim(),
        category: String(product?.category || '').trim(),
        fit: String(product?.fit || '').trim(),
        materials: Array.isArray(product?.materials) ? product.materials.filter(Boolean).slice(0, 8) : [],
        compositionText: String(product?.compositionText || '').trim(),
        description: String(product?.description || '').trim().slice(0, 260),
        features: Array.isArray(product?.features) ? product.features.filter(Boolean).slice(0, 12) : [],
        visualNotes: options.perProductVisionSummaryMap instanceof Map
          ? (options.perProductVisionSummaryMap.get(normalizeProductCode(code)) || '')
          : '',
      };

      const prompt = `You are classifying ONE apparel product into a fashion hierarchy.

${buildFashionDomainInstructions()}

Return JSON ONLY:
{
  "code": "${code}",
  "primaryCategory": "broad family such as Outerwear, Tops, Bottoms, One-Piece, Accessories, Footwear or Underwear",
  "subcategory": "most specific apparel type supportable",
  "category": "same as subcategory",
  "fit": "most specific fit if supportable, otherwise keep current fit or empty",
  "features": ["keep or improve visible construction details"],
  "description": "improved factual description"
}

Rules:
- classify this product individually, not as part of a collection group
- prefer specific subcategories such as Trucker Jacket, Oxford Shirt, Cargo Pants, Pleated Trousers, Straight Jeans, Waistcoat, Gilet, Hoodie, Sweatshirt, Bermuda Shorts, Jorts
- do not use fabric buckets like Denim or Woven as the final subcategory
- if evidence is weak, preserve the current fields instead of inventing
- keep valid JSON only

Product evidence:
${JSON.stringify(payload, null, 2)}`;

      const raw = await llm.generate(prompt, { temperature: 0.1, maxTokens: 700 });
      let parsedJson = parseJsonSafe(raw);
      if (!parsedJson) {
        parsedJson = await attemptJsonRepair(llm, raw, 'single-product-refine', emitLog);
      }

      const normalized = normalizeAiProduct(parsedJson || product);
      refined.push({
        ...product,
        ...(normalized || {}),
      });
    }

    return refined;
  } finally {
    llm.timeout = originalTimeout;
  }
}

async function generateReportFromSource(sourcePath, outputPath, options = {}) {
  const emitLog = options.emitLog || (() => {});
  const emitProgress = options.emitProgress || (() => {});
  const ensureActive = options.ensureActive || (() => {});
  const aiOnly = options.aiOnly !== false;

  ensureActive();
  emitLog('Parsing product data...', 'info');
  emitProgress(30);
  const parsed = await productParser.parseProductsWithContext(sourcePath, {
    ensureActive,
    emitLog,
    ocrEngine: options.ocrEngine,
    ocrFallbackEngine: options.ocrFallbackEngine,
  });
  ensureActive();
  let products = parsed.products || [];
  const parsedImagePaths = Array.isArray(parsed.imagePaths) ? parsed.imagePaths.filter(Boolean) : [];
  let analysisSourceText = parsed.sourceText || '';
  let specialistApparelVisionSummary = '';
  let perProductVisionSummaryMap = new Map();

  if (parsed.multimodalAugmented) {
    emitLog(
      `Multimodal source context ready: ${parsedImagePaths.length} image(s) and ${String(parsed.ocrText || '').trim() ? 'OCR-augmented text' : 'base text'} will be used for analysis.`,
      'success',
    );
  }

  const llmMode = options.llm?.mode || 'local';
  const shouldUseLocalApparelVision = options.apparelVision?.enabled !== false
    && parsedImagePaths.length > 0
    && llmMode !== 'cloud';
  const allowGlobalApparelVisionSummary = products.length === 0 || products.length <= 2;

  if (options.apparelVision?.enabled !== false && parsedImagePaths.length > 0 && llmMode === 'cloud') {
    emitLog('Cloud analysis selected: skipping local apparel vision models.', 'info');
  }

  if (shouldUseLocalApparelVision && !allowGlobalApparelVisionSummary) {
    emitLog(
      `Skipped shared apparel vision summary because this source contains ${products.length} parsed styles; one global visual summary can reduce per-product accuracy.`,
      'info',
    );
  }

  if (shouldUseLocalApparelVision && allowGlobalApparelVisionSummary) {
    const apparelVisionResult = await describeApparelImages(parsedImagePaths, {
      emitLog,
      config: options.apparelVision,
      contextText: analysisSourceText.slice(0, 3000),
      maxImages: options.enableVision === true ? 6 : 4,
    }).catch((error) => {
      emitLog(`Apparel vision skipped: ${error.message}`, 'warning');
      return null;
    });

    specialistApparelVisionSummary = buildApparelVisionSummary(apparelVisionResult);
    if (specialistApparelVisionSummary) {
      analysisSourceText = productParser.appendSourceContext(
        analysisSourceText,
        'Specialist apparel vision summary',
        specialistApparelVisionSummary,
      );
      parsed.sourceText = analysisSourceText;
      parsed.sourceLines = String(analysisSourceText || '')
        .split(/\r?\n/)
        .map((line) => String(line || '').trim())
        .filter(Boolean);
      emitLog('Added Moondream2 + Gr3_Fabric specialist apparel notes to the analysis context.', 'success');
    }
  }

  const shouldBuildPerProductVisionSummary = options.apparelVision?.enabled !== false
    && llmMode !== 'cloud'
    && Array.isArray(products)
    && products.some((product) => Array.isArray(product?.imagePaths) && product.imagePaths.length > 0);

  if (shouldBuildPerProductVisionSummary) {
    perProductVisionSummaryMap = await buildPerProductVisionSummaryMap(products, {
      emitLog,
      apparelVision: options.apparelVision,
      contextText: analysisSourceText,
      maxProducts: 12,
      maxImagesPerProduct: 3,
    });
    if (perProductVisionSummaryMap.size > 0) {
      emitLog(`Built product-level vision notes for ${perProductVisionSummaryMap.size} style(s).`, 'success');
    }
  }

  // 支持混合模式：提取和分析可以使用不同的 LLM
  const mode = options.llm?.mode || 'local';
  const extractionConfig = options.llm?.extraction;
  const analysisConfig = options.llm?.analysis || options.llm;
  
  // 调试日志
  if (mode === 'hybrid') {
    emitLog(`[DEBUG] extractionConfig: ${JSON.stringify(extractionConfig)}`, 'info');
    emitLog(`[DEBUG] analysisConfig: ${JSON.stringify(analysisConfig)}`, 'info');
  }
  
  // 创建提取阶段的 LLM 客户端
  let extractionLLM = null;
  let isLocalExtraction = true;
  
  // 创建分析阶段的 LLM 客户端
  let analysisLLM = null;
  let isLocalAnalysis = true;
  
  if (options.llm?.enabled) {
    // 混合模式：分别配置提取和分析
    if (mode === 'hybrid' && extractionConfig) {
      // 提取阶段
      isLocalExtraction = isLocalOllama(extractionConfig.baseUrl);
      extractionLLM = new LLMClient({
        baseUrl: extractionConfig.baseUrl,
        model: extractionConfig.model,
        apiKey: extractionConfig.apiKey || '',
      });
      
      // 分析阶段
      isLocalAnalysis = isLocalOllama(analysisConfig.baseUrl);
      analysisLLM = new LLMClient({
        baseUrl: analysisConfig.baseUrl,
        model: analysisConfig.model,
        apiKey: analysisConfig.apiKey || '',
      });
      
      emitLog(`Hybrid mode: extraction=${isLocalExtraction ? 'local' : 'cloud'}, analysis=${isLocalAnalysis ? 'local' : 'cloud'}`, 'info');
    } else {
      // 单一模式：提取和分析使用同一个 LLM
      const baseUrl = options.llm.baseUrl || 'http://localhost:11434';
      isLocalExtraction = isLocalOllama(baseUrl);
      isLocalAnalysis = isLocalExtraction;
      
      // 调试日志
      console.log(`[LLM] URL: ${baseUrl}, isLocal: ${isLocalExtraction}`);
      emitLog(`[DEBUG] URL检测: ${baseUrl} -> ${isLocalExtraction ? '本地' : '云端'}`, 'info');
      
      extractionLLM = new LLMClient({
        baseUrl: baseUrl,
        model: options.llm.model || 'llama3',
        apiKey: options.llm.apiKey || '',
      });
      analysisLLM = extractionLLM;
    }
    
    // 测试连接
    const extractionTest = await extractionLLM.testConnection();
    ensureActive();
    const analysisTest = mode === 'hybrid' ? await analysisLLM.testConnection() : extractionTest;
    ensureActive();
    
    if (!extractionTest.success || !analysisTest.success) {
      if (aiOnly) {
        throw new Error('AI analysis is required, but LLM connection failed.');
      }
      emitLog('LLM connection failed, generating text-only report', 'warning');
      extractionLLM = null;
      analysisLLM = null;
    } else {
      emitLog(`LLM connected: extraction=${extractionTest.models?.length || 0} models, analysis=${analysisTest.models?.length || 0} models`, 'success');
    }
  } else if (aiOnly) {
    throw new Error('AI analysis is required. Please enable AI analysis.');
  }

  const visualCoverage = await buildVisualStyleCoverage(parsed, products, emitLog);
  const totalOverride = Number.isFinite(visualCoverage?.totalOverride) && visualCoverage.totalOverride > 0
    ? visualCoverage.totalOverride
    : null;

  // AI-only extraction for text sources
  // 混合模式下使用配置的提取端点
  const shouldSkipAiExtraction = shouldSkipRedundantAiExtraction(parsed, products, { isLocalExtraction });

  if (aiOnly && extractionLLM && analysisSourceText && analysisSourceText.trim()) {
    if (shouldSkipAiExtraction) {
      emitLog(
        `Structured ${parsed.sourceType || 'source'} content detected. Skipping full-document AI extraction and refining the parsed products instead.`,
        'info',
      );
      const refinedProducts = await refineStructuredProductsWithLLM(
        extractionLLM,
        products,
        analysisSourceText,
        parsed,
        emitLog,
        {
          timeoutMs: isLocalExtraction ? 240000 : 300000,
          apparelVisionSummary: specialistApparelVisionSummary,
          visualCoverageSummary: visualCoverage?.summaryText || '',
          perProductVisionSummaryMap,
        },
      );
      ensureActive();
      if (refinedProducts.length > 0) {
        products = mergeProductInventories(products, refinedProducts);
        emitLog(`Refined ${refinedProducts.length} parsed product(s) with AI evidence merging.`, 'success');
      }

      if (products.length > 0) {
        const individuallyRefinedProducts = await refineProductsIndividuallyWithLLM(
          extractionLLM,
          products,
          emitLog,
          {
            timeoutMs: isLocalExtraction ? 180000 : 240000,
            perProductVisionSummaryMap,
          },
        );
        ensureActive();
        if (individuallyRefinedProducts.length > 0) {
          products = mergeProductInventories(products, individuallyRefinedProducts);
          emitLog(`Applied per-product category refinement to ${individuallyRefinedProducts.length} style(s).`, 'success');
        }
      }
    } else {
      const modeText = isLocalExtraction ? 'local' : 'cloud';
      const extractionSource = !isLocalExtraction && hasReliableStructuredProducts(products)
        ? buildCompactExtractionSource(products, analysisSourceText, parsed, {
          apparelVisionSummary: specialistApparelVisionSummary,
          visualCoverageSummary: visualCoverage?.summaryText || '',
        })
        : analysisSourceText;
      if (!isLocalExtraction && extractionSource !== analysisSourceText) {
        emitLog('Cloud AI extraction will refine the parsed product list from compact structured context instead of the full document.', 'info');
      }
      emitLog(`Extracting products using ${modeText} LLM...`, 'info');
      const aiProducts = await extractProductsWithLLM(extractionLLM, extractionSource, emitLog, isLocalExtraction);
      ensureActive();
      if (aiProducts.length > 0) {
        const mergedProducts = mergeProductInventories(products, aiProducts);
        products = mergedProducts.length > 0 ? mergedProducts : aiProducts;
        emitLog(`Extracted ${aiProducts.length} products using ${modeText} LLM and kept ${products.length} total after merge`, 'success');
      }
    }
  }

  if (products.length === 0 && Array.isArray(visualCoverage?.syntheticProducts) && visualCoverage.syntheticProducts.length > 0) {
    products = visualCoverage.syntheticProducts;
    emitLog(
      `No structured products were extracted, so ${products.length} visually distinct style placeholder(s) will be used for counting and AI analysis.`,
      'warning',
    );
  }

  if (products.length === 0) throw new Error('No products found in the selected source');

  const template = inferTemplateType(options, products, analysisSourceText || '', sourcePath);
  let meta;
  let stats;
  let isAiEnabled = false;

  if (template === 'multi-brand') {
    const yearLine = inferCollectionLabel(options, analysisSourceText || '');
    const baseTitle = options.title && options.title.trim() ? options.title.trim() : `Best Seller ${yearLine}`;
    const reportTitle = baseTitle.toLowerCase().includes('analysis report') ? baseTitle : `${baseTitle} Analysis Report`;
    meta = {
      template,
      reportTitle,
      mainTitle: baseTitle.toUpperCase(),
      subtitle: 'By Brand & Category | Key Trends & Insights',
      confidentialLine: 'Confidential  |  For Internal Use Only',
      preparedLine: `${yearLine} Best Seller Category Analysis  |  Prepared for Internal Review`,
      yearLine: yearLine,
    };
    stats = buildMultiBrandStats(products, { totalOverride });
  } else {
    // Single-brand template (formerly menswear/womenswear merged)
    const brandTitle = inferBrandLineFromSource(options, sourcePath, analysisSourceText || '');
    const reportTitle = options.title && options.title.trim() 
      ? options.title.trim() 
      : `${brandTitle} Product Collection Report`;
    meta = {
      template,
      reportTitle,
      brandLine: brandTitle.toUpperCase(),
      collectionLabel: inferCollectionLabel(options, analysisSourceText || ''),
      sourceProfile: parsed.sourceProfile || 'apparel',
      generatedDate: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'numeric', day: 'numeric' }),
      sourceText: analysisSourceText || '',
    };
    stats = buildStats(products, template, { totalOverride });
  }

  emitProgress(60);
  const imagePaths = uniq([
    ...(Array.isArray(visualCoverage?.imagePaths) && visualCoverage.imagePaths.length > 0
      ? visualCoverage.imagePaths
      : parsedImagePaths),
    ...selectImagesForLLM(products, options.enableVision === true ? 16 : 12),
  ]).slice(0, options.enableVision === true ? 24 : 16);
  
  // Generate AI insights if LLM is available, otherwise null
  let insights = null;
  if (analysisLLM) {
    emitLog('Starting AI analysis...', 'info');
    // 默认禁用视觉分析以提高速度
    // 传递 isLocalAnalysis 以优化超时策略
    const aiOptions = {
      enableVision: options.enableVision === true,
      isLocalLLM: isLocalAnalysis,
      visualGrouping: visualCoverage?.grouping,
      visualCoverageSummary: visualCoverage?.summaryText || '',
      apparelVisionSummary: specialistApparelVisionSummary,
    };
    insights = await buildAiInsights(analysisLLM, template, meta, stats, products, analysisSourceText || '', imagePaths, emitLog, emitProgress, aiOptions);
    ensureActive();
    isAiEnabled = true;
    if (insights) {
      emitProgress(90);
    } else {
      emitLog('AI analysis did not return results, generating text-only report', 'warning');
    }
  } else {
    emitLog('Generating text-only extraction report (no AI analysis)', 'info');
  }

  emitProgress(85);
  ensureActive();
  
  // Pass whether AI was enabled to the report generator
  return await generateReportFromAnalysis({ 
    meta, 
    template, 
    products, 
    stats, 
    insights,
    isAiEnabled 
  }, outputPath);
}

// ── 兼容旧接口：直接传产品数组 ─────────────────
async function generateReport(products, outputPath, options = {}) {
  const template = inferTemplateType(options, products, '', '');
  const genderTitle = template === 'menswear' ? 'Menswear' : 'Womenswear';
  const reportTitle = options.title && options.title.trim()
    ? options.title.trim()
    : `ZARA ${genderTitle} Product Analysis Report`;
  const meta = {
    template,
    reportTitle,
    brandLine: `ZARA ${genderTitle.toUpperCase()}`,
    collectionLabel: inferCollectionLabel(options, ''),
    generatedDate: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'numeric', day: 'numeric' }),
  };
  const stats = buildStats(products, template);
  return await generateReportFromAnalysis({ meta, template, products, stats, insights: null }, outputPath);
}

module.exports = {
  generateReport,
  generateReportFromSource,
  buildVisualGroupingHints,
  buildVisualStyleCoverage,
};

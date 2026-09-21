'use strict';

// Bestseller trend-overview report generator.
//
// Reads a folder produced by the Bestseller scraper (per-style sub-folders with
// images + {sku}_info.json, plus bestseller_manifest.json), runs the configured
// LLM (local Ollama or cloud, via the app's LLM config) to:
//   1. Describe each style from its images (vision) + its info.json text.
//   2. Aggregate into a single TREND OVERVIEW (colour / silhouette / fabric
//      trends, comparison) — not a per-style catalog.
// When image-derived fabric differs from the document composition, the document
// wins; the model is told to build on the document and add design-detail /
// fabric-texture observations on top.
//
// Output: a .docx in the user's chosen language (zh or en).

const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
} = require('docx');
const LLMClient = require('./llm-client');
const llmConfigManager = require('./llm-config');
// Name-based capability table, shared with the wizard's model picker.
const { modelSupportsVision } = LLMClient;

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

// Current commercial fashion season from today's date. Northern-hemisphere
// retail convention: Mar–Aug = Spring/Summer, Sep–Feb = Autumn/Winter.
function computeSeason(now = new Date()) {
  const year = now.getFullYear();
  const m = now.getMonth() + 1; // 1-12
  const isSS = m >= 3 && m <= 8;
  return {
    year,
    isSS,
    labelEn: isSS ? 'Spring/Summer' : 'Autumn/Winter',
    labelCn: isSS ? '春夏' : '秋冬',
    codeEn: isSS ? `SS${String(year).slice(-2)}` : `AW${String(year).slice(-2)}`,
  };
}

// One level: every direct sub-folder that carries a *_info.json is a style.
function collectStyleFoldersIn(dir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const sub = path.join(dir, e.name);
    const infoFile = fs.readdirSync(sub).find((f) => /_info\.json$/i.test(f));
    if (!infoFile) continue;
    const info = readJsonSafe(path.join(sub, infoFile));
    if (!info) continue;
    const images = fs.readdirSync(sub)
      .filter((f) => /\.(?:jpe?g|png|webp)$/i.test(f))
      .map((f) => path.join(sub, f));
    out.push({ dir: sub, info, images });
  }
  return out;
}

function listStyleFolders(rootDir) {
  const direct = collectStyleFoldersIn(rootDir);
  if (direct.length) return direct;
  // Mixed-brand mode nests one extra level — <root>/<Brand>/<style>/… — so
  // nothing is found at the top level. Fall back to walking the brand folders.
  const nested = [];
  let entries = [];
  try { entries = fs.readdirSync(rootDir, { withFileTypes: true }); } catch { return nested; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    nested.push(...collectStyleFoldersIn(path.join(rootDir, e.name)));
  }
  return nested;
}

function compositionToText(composition) {
  if (!composition) return '';
  if (typeof composition === 'string') return composition;
  const parts = [composition.outerShell, composition.lining, composition.other]
    .filter(Boolean);
  return parts.join('\n');
}

function imageToBase64(p) {
  try {
    const buf = fs.readFileSync(p);
    const ext = path.extname(p).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return { data: buf.toString('base64'), mime };
  } catch {
    return null;
  }
}

// Resolve the endpoint this run will talk to. Split out from client
// construction so the vision pre-flight can build a second client against the
// very same endpoint but with a different (image-capable) model.
function resolveLlmEndpoint(llmOpts = {}, forceMode = 'default') {
  // Prefer explicit options passed from the handler (live frontend config);
  // fall back to saved config when the caller did not supply a full endpoint.
  let baseUrl = llmOpts.baseUrl;
  let model = llmOpts.model;
  let apiKey = llmOpts.apiKey;
  if (!baseUrl || !model) {
    const cfg = llmConfigManager.mergeWithDefaults(llmConfigManager.loadConfig());
    // Per-run override: 'cloud' / 'local' / 'apiCloud' force that endpoint;
    // 'default' uses the saved mode.
    const mode = (forceMode === 'cloud' || forceMode === 'local' || forceMode === 'apiCloud')
      ? forceMode
      : (cfg.mode || 'local');
    const active = mode === 'cloud'
      ? cfg.cloud
      : mode === 'apiCloud'
        ? (cfg.apiCloud?.presets || []).find((p) => p.id === cfg.apiCloud?.activePresetId) || {}
        : cfg.local;
    baseUrl = baseUrl || active?.baseUrl || 'http://localhost:11434';
    model = model || active?.model || '';
    apiKey = apiKey || active?.apiKey || '';
  }
  return { baseUrl, model, apiKey };
}

function buildLlmClient(llmOpts = {}, forceMode = 'default') {
  const { baseUrl, model, apiKey } = resolveLlmEndpoint(llmOpts, forceMode);
  return new LLMClient({ baseUrl, model, apiKey, timeoutMs: 300000 });
}

// Per-style visual+text description. Returns a short structured note.
async function describeStyle(client, style, options) {
  const { imagesPerStyle, emitLog, ensureActive, cn } = options;
  ensureActive();
  const docComposition = compositionToText(style.info?.composition);
  const name = style.info?.name || style.info?.styleNumber || 'Unknown';

  const imgPaths = (style.images || []).slice(0, Math.max(1, imagesPerStyle || 3));
  const images = imgPaths.map(imageToBase64).filter(Boolean).map((x) => ({ data: x.data, mime: x.mime }));

  const prompt = cn ? [
    '你是一名资深服装产品分析师。看图片和文档数据，用简体中文写一段简洁笔记（3-5 句）。',
    '涵盖：品类与廓形、关键设计细节、颜色/图案、以及图中可见的面料质感/工艺。',
    '重要：若下方文档成分存在，以其为准，不要与之矛盾；在其基础上补充图片揭示的信息（织法、质感、垂坠感、做工细节）。整段必须用简体中文。',
    '',
    `款式名称：${name}`,
    `文档成分（以此为准）：${docComposition || '（未提供）'}`,
    style.info?.price ? `价格：${style.info.price}` : '',
    style.info?.colorRef ? `颜色：${style.info.colorRef}` : '',
  ].filter(Boolean).join('\n') : [
    'You are a senior fashion product analyst. Look at the garment images and the document data, then write a concise English note (3-5 sentences).',
    'Cover: garment type & silhouette, key design details, colour/print, and fabric texture/finish as seen in the images.',
    'IMPORTANT: If the document composition below is present, treat it as authoritative for fibre content. Do NOT contradict it; instead build on it with what the images reveal (weave, texture, drape, finish, construction details).',
    '',
    `Style name: ${name}`,
    `Document composition (authoritative): ${docComposition || '(none provided)'}`,
    style.info?.price ? `Price: ${style.info.price}` : '',
    style.info?.colorRef ? `Colour: ${style.info.colorRef}` : '',
  ].filter(Boolean).join('\n');

  try {
    let text;
    if (images.length > 0 && typeof client.generateWithImages === 'function') {
      text = await client.generateWithImages(prompt, images, { temperature: 0.3 });
    } else {
      text = await client.generate(prompt, { temperature: 0.3 });
    }
    return {
      styleNumber: style.info?.styleNumber || '',
      name,
      colorRef: style.info?.colorRef || '',
      price: style.info?.price || '',
      composition: docComposition,
      note: String(text || '').trim(),
    };
  } catch (error) {
    const msg = String(error.message || error);
    // Fatal, non-recoverable model errors: retired model, auth failure, model
    // not found, or quota. Re-throw so the caller aborts instead of grinding
    // through every style and failing at the end.
    if (/HTTP 4(?:0[0-9]|1[0-9]|2[0-9])\b|retired|not found|does not exist|unauthor|invalid api key|insufficient|quota|model_not_found/i.test(msg)) {
      const fatal = new Error(msg);
      fatal.fatalModel = true;
      throw fatal;
    }
    emitLog(`    ⚠️ Vision note failed for ${name}: ${msg}`, 'warning');
    return {
      styleNumber: style.info?.styleNumber || '',
      name,
      colorRef: style.info?.colorRef || '',
      price: style.info?.price || '',
      composition: docComposition,
      note: '',
    };
  }
}

async function aggregateTrends(client, notes, options) {
  const { language, brandLabel, genderLabel, emitLog, ensureActive, season } = options;
  ensureActive();
  const cn = language === 'zh' || language === 'cn' || language === 'zh-CN';

  const corpus = notes.map((n, i) => {
    const lines = [`#${i + 1} ${n.name}`];
    if (n.colorRef) lines.push(`colour: ${n.colorRef}`);
    if (n.composition) lines.push(`composition: ${n.composition.replace(/\n/g, '; ')}`);
    if (n.note) lines.push(`observations: ${n.note}`);
    return lines.join('\n');
  }).join('\n\n');

  // Section headers in the target language so the model mirrors them.
  const sectionsCn = [
    '1. 总体概述',
    '2. 色彩与图案趋势',
    '3. 廓形与版型趋势',
    '4. 面料与材质趋势（以文档成分为准，并补充质感/工艺观察）',
    '5. 设计细节趋势（门襟、口袋、下摆、装饰等）',
    '6. 对比与亮点',
    '7. 建议',
  ];
  const sectionsEn = [
    '1. Executive summary',
    '2. Colour & print trends',
    '3. Silhouette & fit trends',
    '4. Fabric & material trends (respect the document composition as authoritative; add texture/finish insight)',
    '5. Design-detail trends (closures, pockets, hems, embellishment, etc.)',
    '6. Comparison & standout observations',
    '7. Recommendations',
  ];

  const prompt = cn ? [
    '【语言要求】整篇报告必须用简体中文撰写，包括所有标题、正文、要点。禁止使用英文（专有品牌名、纤维英文名除外）。',
    `你是一名时尚趋势分析师。以下是 ${brandLabel}（${genderLabel}）的 ${notes.length} 个畅销款式。`,
    `当前时间为 ${season.year} 年，季节为${season.labelCn}。报告标题和内容请使用「${season.year} ${season.labelCn}」，不要写其他年份或季节。`,
    '请撰写一份「趋势总览」报告（不是逐款罗列），跨所有款式进行归纳与对比。',
    '按以下章节组织，每节几句话，并用具体证据说明有多少款体现了该特征：',
    ...sectionsCn,
    '只输出干净的正文，章节标题清晰。不要编造款式数据中没有的信息。',
    '再次强调：全文用简体中文。',
    '',
    '=== 款式数据 ===',
    corpus,
  ].join('\n') : [
    `You are a fashion trend analyst. Below are ${notes.length} bestseller styles from ${brandLabel} (${genderLabel}).`,
    `The current time is ${season.year}, season: ${season.labelEn}. Use "${season.year} ${season.labelEn}" in the title and body — do NOT write any other year or season.`,
    'Produce a TREND OVERVIEW report (not a per-style catalog). Aggregate and compare across all styles.',
    'Structure the report with these sections, each a few sentences with concrete evidence referencing how many styles show each trait:',
    ...sectionsEn,
    'Return clean prose with clear section headers. Do not invent data not supported by the styles.',
    'Write the entire report in English.',
    '',
    '=== STYLE DATA ===',
    corpus,
  ].join('\n');

  emitLog('    🧠 Aggregating trend overview…', 'info');
  let text;
  try {
    text = await client.generate(prompt, { temperature: 0.4, maxTokens: 4000 });
  } catch (error) {
    const msg = String(error.message || error);
    if (/HTTP 4\d\d/.test(msg)) {
      throw new Error(`Trend aggregation failed (${msg}). The LLM endpoint returned an error. Please check your AI model settings — ensure the model is installed and the endpoint URL is correct.`);
    }
    throw new Error(`Trend aggregation failed: ${msg}`);
  }
  return String(text || '').trim();
}

function parseSectionsToDocx(reportText, meta) {
  const cn = meta.cn;
  const season = meta.season || computeSeason();
  const seasonLabel = cn ? `${season.year} ${season.labelCn}` : `${season.year} ${season.labelEn}`;
  const children = [];
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    heading: HeadingLevel.TITLE,
    children: [new TextRun({ text: cn ? `${seasonLabel} 热门款式趋势分析报告` : `${seasonLabel} Bestseller Trend Analysis Report`, bold: true })],
  }));
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 300 },
    children: [new TextRun({ text: `${meta.brandLabel} · ${meta.genderLabel} · ${meta.styleCount} ${cn ? '款' : 'styles'} · ${new Date().toLocaleDateString()}`, italics: true, size: 20 })],
  }));

  // Make the absence of visual input impossible to miss: the notes below would
  // otherwise read exactly like a run that did examine the photos.
  if (meta.visionFallback) {
    children.push(new Paragraph({
      spacing: { after: 260 },
      children: [new TextRun({
        text: cn
          ? '⚠️ 本次分析未读取产品图片：所选模型不支持视觉输入，以下描述仅基于文档数据（款式名称、价格、成分），不包含对图片中面料/工艺的观察。'
          : '⚠️ This run did not read the product photos: the selected model has no vision support, so everything below is based on document data only (style name, price, composition) with no observation of the garments in the images.',
        italics: true,
        size: 18,
        color: 'C0561F',
      })],
    }));
  }

  // Split the model's prose into headed sections. Lines that look like a header
  // (short, possibly numbered, optionally ending with ':') become Heading 2.
  const lines = String(reportText || '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { children.push(new Paragraph({ spacing: { after: 60 }, children: [] })); continue; }
    const isHeader = line.length <= 60
      && (/^#{1,3}\s+/.test(line)
        || /^\d+[.)、]\s*\S/.test(line)
        || /^(?:[一二三四五六七八九十]+[、.])\s*\S/.test(line)
        || /[:：]$/.test(line));
    const clean = line.replace(/^#{1,3}\s+/, '').replace(/\*\*/g, '');
    if (isHeader) {
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_2,
        spacing: { before: 220, after: 120 },
        children: [new TextRun({ text: clean, bold: true })],
      }));
    } else {
      const bullet = /^[-*•]\s+/.test(clean);
      children.push(new Paragraph({
        spacing: { after: 120 },
        ...(bullet ? { bullet: { level: 0 } } : {}),
        children: [new TextRun({ text: clean.replace(/^[-*•]\s+/, '') })],
      }));
    }
  }
  return children;
}

async function generateBestsellerReport(rootDir, outputPath, options = {}) {
  const emitLog = options.emitLog || (() => {});
  const emitProgress = options.emitProgress || (() => {});
  const ensureActive = options.ensureActive || (() => {});
  const language = options.language || 'en';
  const cn = language === 'zh' || language === 'cn' || language === 'zh-CN';
  const imagesPerStyle = Number(options.imagesPerStyle) || 3;

  const manifest = readJsonSafe(path.join(rootDir, 'bestseller_manifest.json')) || {};
  const brandLabel = options.brandLabel || manifest.brand || 'New Yorker';
  const genderLabel = options.genderLabel || manifest.gender || '';

  emitLog('Scanning scraped bestseller styles…', 'info');
  const styles = listStyleFolders(rootDir);
  if (!styles.length) throw new Error('No scraped styles found to analyze. Run the scrape + download steps first.');
  emitLog(`Found ${styles.length} styles to analyze.`, 'success');
  emitProgress(10);

  const client = buildLlmClient(options.llm || {}, options.llmMode || 'default');

  const cfg = llmConfigManager.mergeWithDefaults(llmConfigManager.loadConfig());
  const mode = (options.llmMode === 'cloud' || options.llmMode === 'local' || options.llmMode === 'apiCloud')
    ? options.llmMode
    : (cfg.mode || 'local');

  let availableModels = [];
  try {
    const test = await client.testConnection();
    if (test && test.success === false) {
      throw new Error(test.error || 'LLM connection failed');
    }
    if (test && test.success && Array.isArray(test.models) && test.models.length > 0) {
      availableModels = test.models.map((m) => String(m));
    }
  } catch (error) {
    throw new Error(`LLM not reachable: ${error.message}. Check the model settings.`);
  }

  // The wizard only carries an "AI on/off" switch — the model lives in the
  // settings page. When that is empty (LLMClient falls back to the 'llama3'
  if (!client.model || client.model === 'llama3') {
    const picked = LLMClient.pickDefaultModel(mode, availableModels);
    if (!picked) {
      throw new Error(
        cn
          ? '未配置 AI 模型，且端点上没有可用模型。请在设置中选择一个模型。'
          : 'No AI model configured and the endpoint serves no models. Please select a model in the settings.'
      );
    }
    client.model = picked;
    emitLog(
      cn
        ? `未配置模型 — 使用端点默认：${picked}`
        : `No model configured — using endpoint default: ${picked}`,
      'info'
    );
  } else {
    const modelLower = String(client.model).toLowerCase();
    const isAvailable = availableModels.some((m) => String(m).toLowerCase() === modelLower);
    if (availableModels.length > 0 && !isAvailable) {
      emitLog(`⚠️ Model "${client.model}" not found. Available: ${availableModels.slice(0, 5).join(', ')}${availableModels.length > 5 ? '...' : ''}`, 'warning');
    }
  }

  // ---- Vision pre-flight ---------------------------------------------------
  // Every step below feeds product photos to the model. A text-only model does
  // NOT error out: generateWithImages() exhausts its three image formats,
  // silently drops to a plain-text chat, and the model then happily describes
  // weave and drape it never saw. Ask the user before that happens rather than
  // shipping a report that reads as if the photos had been examined.
  const visionCapable = typeof client.supportsVision === 'function' ? client.supportsVision() : true;
  let activeClient = client;
  let visionFallback = false;
  if (!visionCapable) {
    const candidates = availableModels.filter((m) => modelSupportsVision(m));
    const decision = typeof options.requestVisionDecision === 'function'
      ? await options.requestVisionDecision({ model: client.model, candidates, cn })
      : { action: 'continue' };
    ensureActive();
    if (decision?.action === 'cancel') {
      const err = new Error(cn
        ? `已取消：模型「${client.model}」无法读取图片。`
        : `Cancelled: model "${client.model}" cannot read images.`);
      err.userCancelled = true;
      throw err;
    }
    if (decision?.action === 'switch' && decision.model) {
      const chosen = String(decision.model);
      const endpoint = resolveLlmEndpoint(options.llm || {}, options.llmMode || 'default');
      activeClient = new LLMClient({ ...endpoint, model: chosen, timeoutMs: 300000 });
      emitLog(cn ? `已切换到视觉模型：${chosen}` : `Switched to vision model: ${chosen}`, 'success');
    } else {
      visionFallback = true;
      emitLog(cn
        ? `⚠️ 模型「${client.model}」不支持读图，本次分析不会查看产品图片（报告已标注）。`
        : `⚠️ Model "${client.model}" cannot read images — this run will not look at the product photos (noted in the report).`, 'warning');
    }
  }

  // Per-style vision notes.
  const notes = [];
  for (let i = 0; i < styles.length; i += 1) {
    ensureActive();
    const style = styles[i];
    emitLog(`Analyzing style ${i + 1}/${styles.length}: ${style.info?.name || style.info?.styleNumber || ''}`, 'info');
    let note;
    try {
      note = await describeStyle(activeClient, style, { imagesPerStyle, emitLog, ensureActive, cn });
    } catch (error) {
      if (error.fatalModel) {
        throw new Error(`Vision model unavailable — ${error.message}. Open LLM settings and select a current vision model (the previously configured model appears to be retired or unreachable).`);
      }
      throw error;
    }
    notes.push(note);
    emitProgress(10 + Math.round(((i + 1) / styles.length) * 70));
  }

  // Aggregate trend overview.
  ensureActive();
  const season = computeSeason();
  const reportText = await aggregateTrends(activeClient, notes, { language, brandLabel, genderLabel, emitLog, ensureActive, season });
  emitProgress(88);

  // Build the docx.
  const children = parseSectionsToDocx(reportText, {
    cn, brandLabel, genderLabel, styleCount: styles.length, season, visionFallback,
  });
  const doc = new Document({ sections: [{ properties: {}, children }] });
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);
  emitProgress(100);
  emitLog(`Trend report saved: ${outputPath}`, 'success');

  return { success: true, outputPath, styleCount: styles.length, visionFallback };
}

module.exports = { generateBestsellerReport, listStyleFolders };

#!/usr/bin/env node
/**
 * Vision pre-flight guard.
 *
 * Three chains feed product images to an LLM: the scrape -> trend report chain
 * and PPT generation (style photos / label images / fabric swatches). A
 * text-only model does not fail on those images — the image formats are
 * exhausted, the call drops to a plain-text chat, and the output then reads as
 * if the photos had been examined.
 *
 * The guard that stops that is wired in three places, each easy to disconnect
 * by accident:
 *   1. main.js exports promptVisionDecision + listVisionCandidates and passes
 *      them into registerSlidesAnalysisHandlers (miss the dep and PPT silently
 *      loses the prompt);
 *   2. bestseller-report.js must call requestVisionDecision before the per-style
 *      notes and flag the report when the user chooses to continue;
 *   3. generate-ppt must resolve the apparel-vision slots the same way Python
 *      does (an empty slot follows the main model).
 *
 * This script exercises all of it against a fake Ollama endpoint, so no real
 * model, no Python and no Electron are involved.
 *
 * Run: npm run verify:vision-preflight
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = __dirname;
const MODELS = ['glm-4.7', 'glm-4.6v', 'qwen2.5-coder:7b', 'llava:latest'];

const results = [];
const ok = (suite, name, pass, detail) => results.push({ suite, name, pass: !!pass, detail });

function startFakeOllama(seen) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const send = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url === '/api/tags') {
        seen.tags += 1;
        return send({ models: MODELS.map((name) => ({ name })) });
      }
      if (req.url === '/api/generate') {
        const j = JSON.parse(body || '{}');
        seen.generate.push({ model: j.model, images: Array.isArray(j.images) ? j.images.length : 0 });
        return send({ response: `NOTE from ${j.model} with ${Array.isArray(j.images) ? j.images.length : 0} image(s)` });
      }
      if (req.url === '/api/chat') {
        const j = JSON.parse(body || '{}');
        seen.chat.push({ model: j.model, hasImageField: JSON.stringify(j).includes('data:image') });
        return send({ message: { content: '1. Fabric trends\nSome aggregated prose about the styles.' } });
      }
      res.writeHead(404);
      res.end('{}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

// ── Suite 1: scrape -> trend report chain (bestseller-report.js) ───────────
async function testReportChain(baseUrl, seen) {
  const S = 'report-chain';
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsbot-vision-report-'));
  const fixture = path.join(tmp, 'scrape');
  const out = path.join(tmp, 'report.docx');
  const styleDir = path.join(fixture, '12345');
  fs.mkdirSync(styleDir, { recursive: true });
  fs.writeFileSync(path.join(fixture, 'bestseller_manifest.json'), JSON.stringify({ brand: 'Zara', gender: 'Women' }));
  fs.writeFileSync(path.join(styleDir, '12345_info.json'), JSON.stringify({
    styleNumber: '12345', name: 'Test Tee', colorRef: 'Blue', price: '19.99', composition: '100% Cotton',
  }));
  fs.writeFileSync(path.join(styleDir, '1.jpg'), Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]));

  const { generateBestsellerReport } = require(path.join(ROOT, '../bestseller-report'));
  const reset = () => { seen.tags = 0; seen.generate = []; seen.chat = []; };
  const baseOpts = () => ({
    language: 'en',
    imagesPerStyle: 1,
    brandLabel: 'Zara',
    genderLabel: 'Women',
    llm: { baseUrl, model: 'glm-4.7' },
    llmMode: 'default',
    emitLog: () => {},
    emitProgress: () => {},
    ensureActive: () => {},
  });

  // switch
  reset();
  let guardArgs = null;
  let res = await generateBestsellerReport(fixture, out, {
    ...baseOpts(),
    requestVisionDecision: async (args) => { guardArgs = args; return { action: 'switch', model: args.candidates[0] }; },
  });
  ok(S, 'asks the guard with the effective model', guardArgs && guardArgs.model === 'glm-4.7', JSON.stringify(guardArgs));
  ok(S, 'candidate list contains vision models only', guardArgs && JSON.stringify(guardArgs.candidates) === JSON.stringify(['glm-4.6v', 'llava:latest']), JSON.stringify(guardArgs && guardArgs.candidates));
  ok(S, 'report still produced after switching', res.success === true, JSON.stringify(res));
  ok(S, 'switch is not flagged as a no-image run', res.visionFallback === false, String(res.visionFallback));
  ok(S, 'the switched model reaches the wire', seen.generate.length > 0 && seen.generate.every((g) => g.model === 'glm-4.6v'), JSON.stringify(seen.generate));
  ok(S, 'images are attached to the switched model', seen.generate.some((g) => g.images > 0), JSON.stringify(seen.generate));

  // continue anyway -> must be flagged in the docx
  reset();
  res = await generateBestsellerReport(fixture, out, {
    ...baseOpts(), language: 'zh',
    requestVisionDecision: async () => ({ action: 'continue' }),
  });
  ok(S, 'continuing produces a report', res.success === true, JSON.stringify(res));
  ok(S, 'continuing sets visionFallback', res.visionFallback === true, String(res.visionFallback));
  const JSZip = require(path.join(ROOT, '../node_modules/jszip'));
  const zip = await JSZip.loadAsync(fs.readFileSync(out));
  const docXml = (await zip.file('word/document.xml').async('string')).replace(/<[^>]+>/g, ' ');
  ok(S, 'docx states that images were not read', docXml.includes('本次分析未读取产品图片'), docXml.slice(0, 200));

  // cancel
  reset();
  let cancelled = null;
  try {
    await generateBestsellerReport(fixture, out, { ...baseOpts(), requestVisionDecision: async () => ({ action: 'cancel' }) });
  } catch (error) { cancelled = error; }
  ok(S, 'cancel aborts with userCancelled', cancelled && cancelled.userCancelled === true, cancelled && cancelled.message);
  ok(S, 'cancel makes no LLM call', seen.generate.length === 0 && seen.chat.length === 0, JSON.stringify(seen));

  // vision model already selected -> no prompt
  reset();
  let asked = false;
  res = await generateBestsellerReport(fixture, out, {
    ...baseOpts(),
    llm: { baseUrl, model: 'llava:latest' },
    requestVisionDecision: async () => { asked = true; return { action: 'cancel' }; },
  });
  ok(S, 'no prompt when the model can read images', asked === false, 'asked=' + asked);
  ok(S, 'vision model run is not flagged', res.visionFallback === false, String(res.visionFallback));

  // defensive: no callback wired at all
  reset();
  const logs = [];
  res = await generateBestsellerReport(fixture, out, { ...baseOpts(), emitLog: (m, t) => logs.push(`${t} ${m}`) });
  ok(S, 'completes when no guard callback is wired', res.success === true, JSON.stringify(res));
  ok(S, 'flags the run and warns in the log', res.visionFallback === true && logs.some((l) => /warning.*cannot read images/.test(l)), JSON.stringify(logs));

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── Suite 2: PPT chain (slides-analysis-handlers.js generate-ppt) ──────────
async function testPptChain(baseUrl) {
  const S = 'ppt-chain';
  const handlers = new Map();
  const prompts = [];
  let guardImpl = async () => ({ action: 'cancel' });

  const { registerSlidesAnalysisHandlers } = require(path.join(ROOT, '../slides-analysis-handlers'));
  registerSlidesAnalysisHandlers({
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) },
    dialog: { showMessageBox: async () => ({ response: 0 }) },
    app: { isPackaged: false, getLocale: () => 'zh-CN' },
    fs,
    path,
    runtimeResolver: { getPythonSpawnEnv: () => ({}) },
    // A binary that cannot exist: spawn emits 'error' and the handler resolves
    // immediately, so the guard paths run without invoking Python.
    getPythonRuntime: () => ({ command: 'definitely-not-a-real-binary-xyz', args: [] }),
    runManagedTask: (event, kind, fn) => fn({ onCancel: () => {}, throwIfCancelled: () => {}, cancelled: false }),
    updateTaskSnapshot: () => {},
    activeTaskControllers: new Map(),
    assertLicensedForFeature: () => {},
    getLicenseFailurePayload: () => null,
    listVisionCandidates: async (settings) => {
      const LLMClient = require(path.join(ROOT, '../llm-client'));
      const client = new LLMClient({ baseUrl: settings.baseUrl, model: '', timeout: 5000 });
      const res = await client.testConnection();
      return (res.models || []).map(String).filter((m) => LLMClient.modelSupportsVision(m));
    },
    promptVisionDecision: async (args) => { prompts.push(args); return guardImpl(args); },
  });

  const generatePpt = handlers.get('generate-ppt');
  ok(S, 'generate-ppt is registered', typeof generatePpt === 'function', typeof generatePpt);
  if (typeof generatePpt !== 'function') return;

  const mkEvent = () => ({ sender: { send: () => {} } });
  const mkConfig = (over = {}) => ({
    config: {
      llmConfig: { mode: 'local', baseUrl, model: 'glm-4.7', apiKey: '' },
      apparelVision: { enabled: true, garmentModel: '', fabricModel: '' },
      ...over,
    },
  });

  prompts.length = 0;
  guardImpl = async () => ({ action: 'cancel' });
  let cfg = mkConfig();
  let res = await generatePpt(mkEvent(), cfg);
  ok(S, 'prompts when the main model cannot read images', prompts.length === 1, JSON.stringify(prompts.map((p) => p.model)));
  ok(S, 'prompt names the effective model', prompts[0] && prompts[0].model === 'glm-4.7', JSON.stringify(prompts[0] && prompts[0].model));
  ok(S, 'prompt offers vision candidates', prompts[0] && JSON.stringify(prompts[0].candidates) === JSON.stringify(['glm-4.6v', 'llava:latest']), JSON.stringify(prompts[0] && prompts[0].candidates));
  ok(S, 'prompt is localised', prompts[0] && prompts[0].cn === true, JSON.stringify(prompts[0] && prompts[0].cn));
  ok(S, 'cancel resolves as cancelled', res.success === false && res.cancelled === true, JSON.stringify(res));

  prompts.length = 0;
  guardImpl = async (args) => ({ action: 'switch', model: args.candidates[0] });
  cfg = mkConfig();
  res = await generatePpt(mkEvent(), cfg);
  ok(S, 'switching writes both vision slots', cfg.config.apparelVision.garmentModel === 'glm-4.6v' && cfg.config.apparelVision.fabricModel === 'glm-4.6v', JSON.stringify(cfg.config.apparelVision));
  ok(S, 'switching keeps apparelVision enabled', cfg.config.apparelVision.enabled === true, String(cfg.config.apparelVision.enabled));
  ok(S, 'switching continues into generation', res.cancelled !== true, JSON.stringify(res));

  prompts.length = 0;
  cfg = mkConfig({ apparelVision: { enabled: true, garmentModel: 'glm-4.6v', fabricModel: 'llava:latest' } });
  await generatePpt(mkEvent(), cfg);
  ok(S, 'no prompt when every image slot uses a vision model', prompts.length === 0, JSON.stringify(prompts.map((p) => p.model)));

  prompts.length = 0;
  cfg = mkConfig({ apparelVision: { enabled: true, garmentModel: 'glm-4.6v', fabricModel: '' } });
  await generatePpt(mkEvent(), cfg);
  ok(S, 'an empty slot falling back to a text-only main model is caught', prompts.length === 1 && prompts[0].model === 'glm-4.7', JSON.stringify(prompts.map((p) => p.model)));
}

(async () => {
  const seen = { tags: 0, generate: [], chat: [] };
  const { server, baseUrl } = await startFakeOllama(seen);
  try {
    await testReportChain(baseUrl, seen);
    await testPptChain(baseUrl);
  } finally {
    server.close();
  }

  const failed = results.filter((r) => !r.pass);
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  [${r.suite}] ${r.name}${r.pass ? '' : `   <- ${r.detail}`}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} checks passed` + (failed.length ? ` — ${failed.length} FAILED` : ' — ALL PASS'));
  process.exit(failed.length ? 1 : 0);
})().catch((error) => {
  console.error('vision preflight guard crashed:', error);
  process.exit(2);
});

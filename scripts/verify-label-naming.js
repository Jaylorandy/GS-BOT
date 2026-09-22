// Temporary verification for the label-naming fixes (#1-#5).
// Run: node scripts/_tmp-verify-label-naming.cjs
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass += 1;
    console.log('  PASS  ' + name);
    return;
  }
  fail += 1;
  failures.push(name + '\n     got: ' + a + '\n     exp: ' + e);
  console.log('  FAIL  ' + name + '\n     got: ' + a + '\n     exp: ' + e);
}

function checkTrue(name, actual) {
  check(name, Boolean(actual), true);
}

function checkFalse(name, actual) {
  check(name, Boolean(actual), false);
}

function section(title) {
  console.log('\n=== ' + title + ' ===');
}

// ────────────────────────────────────────────────────────────
// Part 1: parseLabelOcrText against real label layouts
// ────────────────────────────────────────────────────────────
const { parseLabelOcrText } = require('../slides-preprocessor');
const labelDefaults = require('../src/shared/labelOcrDefaults.json');

const DICKS_TAG = [
  "Dick' s Sporting Goods Sample Tag (Circle One)",
  "Season:FA27 Dick' s Style #: DAM80",
  'PROTO FIT SIZE SET PP TOP M-X',
  'Brand Label:DSG',
  'Block / Reference:',
  'Vendor: GTGS',
  'Factory: CBK',
  'Country of Origin: Cambodia',
  'Vendor Style #:',
  'Fabric Mill:GTGS',
  'Fabric ID #:F26030082 Yarn:',
  'Fiber Content: 100%N',
  'Fabric Weight(gg) :49 Garment Weight:',
].join('\n');

const GS_SAMPLE_TAG = [
  'GS GLOBAL SAMPLE',
  'CODE GS12GD-LT24043-5 printing',
  'DESC SS27-MD622',
  'CONT 100%C',
  'SPEC 10*7 / 81*48',
  'WIDTH 62 " CUTTABLE',
  'WEIGHT 11.6 OZ/YD2 BW',
  'Brand:',
].join('\n');

const TEHOME_TAG = [
  '供应商 Supplier 常州市泰宏纺织有限公司',
  '编号 Article No. LT19024-9',
  '门幅 Width CW 52 " 3/1',
  '克重 Weight BW:12.4 OZ',
  '颜色 Color INDIGO',
  '成分 Composition C:53.5% LYOCELL:25.5% Poly:20% SP:1%',
  '数据仅供参考 The data is for reference only',
].join('\n');

section("1. Dick' s tag (default aliases, no custom profile)");
{
  const info = parseLabelOcrText(DICKS_TAG, labelDefaults, []);
  check('styleNumber = DAM80 (was empty before)', info.styleNumber, 'DAM80');
  check('fabricCode = F26030082', info.fabricCode, 'F26030082');
}

section("2. Dick' s tag with the custom alias set in Label Settings");
{
  const custom = {
    whitelist: labelDefaults.whitelist,
    fields: {
      ...labelDefaults.fields,
      styleNumber: [...labelDefaults.fields.styleNumber, "Dick' s Style"],
    },
  };
  const info = parseLabelOcrText(DICKS_TAG, custom, []);
  check('styleNumber = DAM80 with custom alias', info.styleNumber, 'DAM80');
  check('fabricCode unchanged', info.fabricCode, 'F26030082');
}

section('3. GS GLOBAL SAMPLE tag (boxed table)');
{
  const info = parseLabelOcrText(GS_SAMPLE_TAG, labelDefaults, []);
  check('fabricCode = GS12GD-LT24043-5 (trailing "printing" dropped)', info.fabricCode, 'GS12GD-LT24043-5');
  check('description = SS27-MD622', info.description, 'SS27-MD622');
  check('styleNumber stays empty (label has no style number)', info.styleNumber, '');
}

section('4. Tehome bilingual tag (no boxes)');
{
  const info = parseLabelOcrText(TEHOME_TAG, labelDefaults, []);
  check('styleNumber = LT19024-9', info.styleNumber, 'LT19024-9');
  checkFalse('styleNumber has no "Article" left', /article/i.test(info.styleNumber));
  checkFalse('styleNumber has no Chinese alias chars', /[\u4e00-\u9fff]/.test(info.styleNumber));
  checkFalse('fabricCode is not supplier text', /SUPPLIER|CHANGZHOU|TEHOME/i.test(info.fabricCode || ''));
  checkFalse('description is not supplier text', /SUPPLIER|CHANGZHOU|TEHOME/i.test(info.description || ''));
  checkTrue('composition still captured', /\d/.test(info.composition || ''));
}

section('5. Guards: plain text must never become a code');
{
  const guardTag = [
    'Supplier Changzhou Tehome Textile',
    'Vendor Style #:',
    'Fabric Mill:GTGS',
    'Brand Label:DSG',
    'Country of Origin: Cambodia',
  ].join('\n');
  const info = parseLabelOcrText(guardTag, labelDefaults, []);
  check('styleNumber empty (GTGS has no digit)', info.styleNumber, '');
  check('fabricCode empty (no code-like token)', info.fabricCode, '');
  checkFalse('styleNumber is not supplier text', /TEHOME|CHANGZHOU/i.test(info.styleNumber));
}

// ────────────────────────────────────────────────────────────
// Part 2: organizer end-to-end with a stubbed OCR engine
// ────────────────────────────────────────────────────────────
section('6. Organizer: suffix defaults + label has no suffix (stub OCR)');

const preprocessorPath = require.resolve('../slides-preprocessor');

const LABEL_STUBS = {
  's1.jpg': { rawText: '', fabricCode: '', styleNumber: '' },
  's2.jpg': { rawText: '', fabricCode: '', styleNumber: '' },
  's3.jpg': { rawText: '', fabricCode: '', styleNumber: '' },
  's4.jpg': { rawText: 'CODE F26030082', fabricCode: 'F26030082', styleNumber: 'DAM80' },
  'p1.jpg': { rawText: '', fabricCode: '', styleNumber: '' },
  'p2.jpg': { rawText: '', fabricCode: '', styleNumber: '' },
  'p3.jpg': { rawText: '', fabricCode: '', styleNumber: '' },
  'p4.jpg': { rawText: 'CODE F26030082', fabricCode: 'F26030082', styleNumber: '' },
};

require.cache[preprocessorPath].exports = {
  runLocalLabelOcr: async (imagePath) => ({ ...(LABEL_STUBS[path.basename(imagePath)] || {}) }),
};
const organizer = require('../style-organizer');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsbot-verify-'));

function makeSource(name, files) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  Object.keys(files).forEach((file, index) => {
    fs.writeFileSync(path.join(dir, file), 'payload-' + file + '-' + index);
  });
  return dir;
}

function listFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}

function readLabelFile(dir, expectedName) {
  const p = path.join(dir, expectedName);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

async function runOrganizer(sourceFolder, outputFolder, config) {
  fs.mkdirSync(outputFolder, { recursive: true });
  return organizer.organizeStyleImages(
    { sourceFolder, outputFolder, config },
    () => {},
    () => {},
    { ensureActive: () => {} },
  );
}

(async () => {
  const baseConfig = {
    namingMode: 'label',
    labelNamingTarget: 'style',
    styleNameField: 'styleNumber',
    organizeOutputMode: 'single-folder',
    organizeAction: 'copy',
    groupSize: 4,
    labelIndex: 4,
    ocrEngine: 'guten-ocr',
  };

  // A: empty suffix field -> default F, B, S and no suffix on the label image
  {
    const src = makeSource('a-src', { 's1.jpg': 1, 's2.jpg': 1, 's3.jpg': 1, 's4.jpg': 1 });
    const out = path.join(root, 'a-out');
    await runOrganizer(src, out, { ...baseConfig, imageSuffixes: '' });
    check('A empty suffixes -> F/B/S + label without suffix', listFiles(out), [
      'DAM80.jpg', 'DAM80_B.jpg', 'DAM80_F.jpg', 'DAM80_S.jpg',
    ]);
    check('A label image is s4 (no suffix)', readLabelFile(out, 'DAM80.jpg'), 'payload-s4.jpg-3');
    check('A first image got _F', readLabelFile(out, 'DAM80_F.jpg'), 'payload-s1.jpg-0');
    check('A second image got _B', readLabelFile(out, 'DAM80_B.jpg'), 'payload-s2.jpg-1');
    check('A third image got _S', readLabelFile(out, 'DAM80_S.jpg'), 'payload-s3.jpg-2');
  }

  // B: comma string from the wizard text field
  {
    const src = makeSource('b-src', { 's1.jpg': 1, 's2.jpg': 1, 's3.jpg': 1, 's4.jpg': 1 });
    const out = path.join(root, 'b-out');
    await runOrganizer(src, out, { ...baseConfig, imageSuffixes: 'F,B,S' });
    check('B string "F,B,S" is parsed as a list', listFiles(out), [
      'DAM80.jpg', 'DAM80_B.jpg', 'DAM80_F.jpg', 'DAM80_S.jpg',
    ]);
  }

  // C: partial custom list is topped up from defaults
  {
    const src = makeSource('c-src', { 's1.jpg': 1, 's2.jpg': 1, 's3.jpg': 1, 's4.jpg': 1 });
    const out = path.join(root, 'c-out');
    await runOrganizer(src, out, { ...baseConfig, imageSuffixes: ['Q', 'W'] });
    check('C partial list tops up with S (no __2 collision)', listFiles(out), [
      'DAM80.jpg', 'DAM80_Q.jpg', 'DAM80_S.jpg', 'DAM80_W.jpg',
    ]);
  }

  // D: style number missing -> named by fabric code but flagged for review
  {
    const src = makeSource('d-src', { 'p1.jpg': 1, 'p2.jpg': 1, 'p3.jpg': 1, 'p4.jpg': 1 });
    const out = path.join(root, 'd-out');
    const result = await runOrganizer(src, out, { ...baseConfig, imageSuffixes: '' });
    check('D files named by fabric code', listFiles(out), [
      'F26030082.jpg', 'F26030082_B.jpg', 'F26030082_F.jpg', 'F26030082_S.jpg',
    ]);
    const infoPath = path.join(out, '_organize_meta', 'F26030082_organize_info.json');
    const info = fs.existsSync(infoPath) ? JSON.parse(fs.readFileSync(infoPath, 'utf8')) : null;
    checkTrue('D group flagged needsReview', info && info.needsReview === true);
    checkTrue('D reason mentions fabric code', info && /fabric code/i.test(info.reviewFailureReason || ''));
    const summaryPath = result && result.summaryPath;
    const summaryJson = summaryPath && fs.existsSync(summaryPath)
      ? JSON.parse(fs.readFileSync(summaryPath, 'utf8'))
      : null;
    checkTrue('D summary records the style field', summaryJson && summaryJson.styleNameField === 'styleNumber');
    checkTrue('D summary keeps the style naming target', summaryJson && summaryJson.labelNamingTarget === 'style');
  }

  // E: fabric naming target -> suffixes must not be injected at all
  {
    const src = makeSource('e-src', { 's1.jpg': 1, 's2.jpg': 1, 's3.jpg': 1, 's4.jpg': 1 });
    const out = path.join(root, 'e-out');
    await runOrganizer(src, out, {
      ...baseConfig,
      labelNamingTarget: 'fabric',
      styleNameField: 'styleNumber',
      imageSuffixes: 'F,B,S',
    });
    const files = listFiles(out);
    checkFalse('E no suffix injected for fabric naming', files.some((name) => /_[FBS]\.jpg$/.test(name)));
    checkTrue('E fabric label produced a file', files.length >= 1);
  }

  // F: static wiring check — the wizard must forward the shared profile
  {
    const moduleHome = fs.readFileSync(path.join(__dirname, '..', 'src', 'ModuleHome.jsx'), 'utf8');
    checkTrue('F ModuleHome sends labelOcrProfile', /labelOcrProfile:\s*loadSharedLabelOcrProfile\(\)/.test(moduleHome));
  }

  console.log('\n──────────────────────────────');
  console.log('PASS ' + pass + ' / FAIL ' + fail);
  if (failures.length > 0) {
    console.log('\nFAILURES:');
    failures.forEach((item) => console.log(' - ' + item));
  }
  fs.rmSync(root, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
})().catch((error) => {
  console.error('HARNESS ERROR:', error);
  process.exit(2);
});

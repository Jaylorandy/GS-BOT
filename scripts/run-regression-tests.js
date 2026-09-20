#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildSlidesPrecomputedInfo, collectSlidesSourceEntries, parseLabelOcrText } = require('../slides-preprocessor');
const { buildVisualGroupingHints, buildVisualStyleCoverage } = require('../report-generator');
const { __private: pdfSqueezerPrivate } = require('../pdf-squeezer-handlers');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE_PNG = path.join(ROOT, 'icon.png');
const FIXTURE_JPG = path.join(ROOT, 'icon.jpg');

function ensureFixture(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing fixture: ${filePath}`);
  }
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function copyFile(sourcePath, targetPath) {
  fs.copyFileSync(sourcePath, targetPath);
  return targetPath;
}

function writeJson(targetPath, value) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(value, null, 2));
}

function getKeys(result = {}) {
  return Object.keys(result).filter((key) => !key.startsWith('__'));
}

function runPython(code) {
  const result = spawnSync('python3', ['-c', code], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PYTHONPYCACHEPREFIX: path.join(os.tmpdir(), 'pycache'),
    },
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'Python command failed');
  }

  return String(result.stdout || '').trim();
}

async function testPythonScanIgnoresOrganizeMeta() {
  const sourceDir = makeTempDir('gsbot-reg-scan-');
  fs.mkdirSync(path.join(sourceDir, '_organize_meta'), { recursive: true });
  fs.mkdirSync(path.join(sourceDir, 'STYLE_A'), { recursive: true });

  const stdout = runPython(
    `import json, generate_slides; print(json.dumps([row[0] for row in generate_slides.scan_style_entries(${JSON.stringify(sourceDir)}, {'sourceMode':'document-images'})]))`,
  );

  assert.deepStrictEqual(JSON.parse(stdout), ['STYLE_A']);
}

async function testLabelModeIgnoresUnrelatedTopLevelImages() {
  const sourceDir = makeTempDir('gsbot-reg-label-');
  copyFile(FIXTURE_PNG, path.join(sourceDir, 'STYLE_A_F.png'));
  copyFile(FIXTURE_JPG, path.join(sourceDir, 'STYLE_A_B.jpg'));
  copyFile(FIXTURE_JPG, path.join(sourceDir, 'random-reference.jpg'));
  copyFile(FIXTURE_PNG, path.join(sourceDir, 'extra-shot-01.png'));

  const entries = collectSlidesSourceEntries(sourceDir, 'label-images');

  assert.deepStrictEqual(entries.map((entry) => entry.styleKey), ['STYLE_A']);
}

async function testOrganizerMetadataSkipsStaleEntries() {
  const sourceDir = makeTempDir('gsbot-reg-meta-');
  const keepFront = copyFile(FIXTURE_PNG, path.join(sourceDir, 'KEEP_F.png'));
  const keepBack = copyFile(FIXTURE_JPG, path.join(sourceDir, 'KEEP_B.jpg'));

  writeJson(path.join(sourceDir, '_organize_meta', 'organize_summary.json'), {
    styles: [
      {
        styleNumber: 'KEEP',
        folder: sourceDir,
        files: {
          front: keepFront,
          back: keepBack,
        },
        labelInfo: {
          styleNumber: 'KEEP',
        },
      },
      {
        styleNumber: 'STALE',
        folder: sourceDir,
        files: {
          front: path.join(sourceDir, 'missing-front.png'),
          back: path.join(sourceDir, 'missing-back.jpg'),
          label: path.join(sourceDir, 'missing-label.jpg'),
        },
        labelInfo: {
          styleNumber: 'STALE',
        },
      },
    ],
  });

  const info = await buildSlidesPrecomputedInfo(sourceDir, { sourceMode: 'label-images' });
  const keys = getKeys(info);

  assert.deepStrictEqual(keys, ['KEEP']);
  assert.strictEqual(path.basename(info.KEEP.frontImagePath), 'KEEP_F.png');
  assert.strictEqual(path.basename(info.KEEP.backImagePath), 'KEEP_B.jpg');
}

async function testStyleOnlyModeUsesNamedFrontBackImages() {
  const sourceDir = makeTempDir('gsbot-reg-style-only-');
  copyFile(FIXTURE_PNG, path.join(sourceDir, 'STYLEONLY1_F.png'));
  copyFile(FIXTURE_JPG, path.join(sourceDir, 'STYLEONLY1_B.jpg'));
  copyFile(FIXTURE_JPG, path.join(sourceDir, 'STYLEONLY1.jpg'));

  const info = await buildSlidesPrecomputedInfo(sourceDir, { sourceMode: 'style-images-only' });
  const keys = getKeys(info);

  assert.deepStrictEqual(keys, ['STYLEONLY1']);
  assert.strictEqual(path.basename(info.STYLEONLY1.frontImagePath), 'STYLEONLY1_F.png');
  assert.strictEqual(path.basename(info.STYLEONLY1.backImagePath), 'STYLEONLY1_B.jpg');
  assert.strictEqual(info.STYLEONLY1.labelImagePath, '');
  assert.strictEqual(info.STYLEONLY1.styleNumber, 'STYLEONLY1');
}

async function testStyleOnlyIssuesTrackMissingBackAndSkippedFiles() {
  const sourceDir = makeTempDir('gsbot-reg-style-issues-');
  copyFile(FIXTURE_PNG, path.join(sourceDir, 'STYLEONLY2_F.png'));
  copyFile(FIXTURE_JPG, path.join(sourceDir, 'random-reference.jpg'));

  const info = await buildSlidesPrecomputedInfo(sourceDir, { sourceMode: 'style-images-only' });

  assert.deepStrictEqual(info.__issues.missingFront, []);
  assert.deepStrictEqual(info.__issues.missingBack, ['STYLEONLY2']);
  assert.deepStrictEqual(info.__issues.skippedFiles, ['random-reference.jpg']);
}

async function testOrganizerMetadataIssuesSummarizeManualReview() {
  const sourceDir = makeTempDir('gsbot-reg-meta-issues-');
  const keepFront = copyFile(FIXTURE_PNG, path.join(sourceDir, 'KEEP_F.png'));

  writeJson(path.join(sourceDir, '_organize_meta', 'organize_summary.json'), {
    styles: [
      {
        styleNumber: 'KEEP',
        folder: sourceDir,
        files: {
          front: keepFront,
        },
        labelInfo: {
          styleNumber: 'KEEP',
        },
      },
    ],
    failedStyles: [
      {
        source: path.join(sourceDir, 'blank-label.jpg'),
        reason: 'Label image did not produce a usable styleNumber.',
      },
    ],
    unmatchedImages: [
      path.join(sourceDir, 'extra-shot.jpg'),
    ],
  });

  const info = await buildSlidesPrecomputedInfo(sourceDir, { sourceMode: 'label-images' });

  assert.deepStrictEqual(info.__issues.missingFront, []);
  assert.deepStrictEqual(info.__issues.missingBack, ['KEEP']);
  assert.deepStrictEqual(info.__issues.emptyLabels, ['blank-label.jpg']);
  assert.deepStrictEqual(info.__issues.skippedFiles, ['extra-shot.jpg']);
}

async function testPythonUniqueOutputPathAddsSuffix() {
  const sourceDir = makeTempDir('gsbot-reg-output-');
  fs.writeFileSync(path.join(sourceDir, 'Deck.pptx'), '');
  fs.writeFileSync(path.join(sourceDir, 'Deck(1).pptx'), '');

  const stdout = runPython(
    `import generate_slides; print(generate_slides.ensure_unique_output_path(${JSON.stringify(path.join(sourceDir, 'Deck.pptx'))}))`,
  );

  assert.strictEqual(stdout, path.join(sourceDir, 'Deck(2).pptx'));
}

async function testLabelParsingKeepsFabricUnitsAndFixesWeightDecimal() {
  const parsed = parseLabelOcrText([
    'Supplier Changzhou Tehome Textile',
    'Article No LT19024-9',
    'CW52"3/1 209',
    'Width',
    'Weight BW:124OZ',
    'Composition C:53.5%LYOCELL:25.5%Poly:20%SP:1%',
  ].join('\n'));

  assert.strictEqual(parsed.width, "CW 52'' 1/3");
  assert.strictEqual(parsed.weight, 'BW 12.4OZ');

  const gsmParsed = parseLabelOcrText([
    'Article No GSM-TEST',
    'Width CW57/58',
    'Weight BW:1237G/M2',
  ].join('\n'));

  assert.strictEqual(gsmParsed.weight, 'BW 123.7G/M2');
}

async function testOrganizerMetadataRehydratesFabricFormattingFromRawText() {
  const sourceDir = makeTempDir('gsbot-reg-fabric-meta-');
  const labelImage = copyFile(FIXTURE_JPG, path.join(sourceDir, 'LT19024-9.jpg'));

  writeJson(path.join(sourceDir, '_organize_meta', 'organize_summary.json'), {
    styles: [
      {
        styleNumber: 'LT19024-9',
        folder: sourceDir,
        files: {
          label: labelImage,
        },
        labelInfo: {
          rawText: [
            'Supplier Changzhou Tehome Textile',
            'Article No LT19024-9',
            'CW52"3/1 209',
            'Width',
            'Weight BW:124OZ',
          ].join('\n'),
          width: '3/1',
          weight: '124OZ',
        },
      },
    ],
  });

  const info = await buildSlidesPrecomputedInfo(sourceDir, { sourceMode: 'fabric-images' });

  assert.strictEqual(info['LT19024-9'].width, "CW 52'' 1/3");
  assert.strictEqual(info['LT19024-9'].weight, 'BW 12.4OZ');
}

async function testPdfSqueezerCreatesCompressedCopy() {
  const sourceDir = makeTempDir('gsbot-reg-pdf-src-');
  const outputDir = makeTempDir('gsbot-reg-pdf-out-');
  const imagePath = copyFile(FIXTURE_JPG, path.join(sourceDir, 'sample.jpg'));
  const pdfPath = path.join(sourceDir, 'sample.pdf');

  runPython(
    `from PIL import Image; Image.open(${JSON.stringify(imagePath)}).save(${JSON.stringify(pdfPath)}, "PDF", resolution=150.0)`,
  );

  const result = spawnSync('python3', ['pdf_squeezer.py'], {
    cwd: ROOT,
    encoding: 'utf8',
    input: JSON.stringify({
      sourceFiles: [pdfPath],
      outputFolder: outputDir,
      config: {
        preset: 'strong',
        suffix: '_squeezed',
      },
    }),
    env: {
      ...process.env,
      PYTHONPYCACHEPREFIX: path.join(os.tmpdir(), 'pycache'),
    },
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'PDF Squeezer command failed');
  }

  const lines = String(result.stdout || '').trim().split('\n').filter(Boolean);
  const summary = JSON.parse(lines[lines.length - 1]);

  assert.strictEqual(summary.success, true);
  assert.strictEqual(summary.fileCount, 1);
  assert.strictEqual(summary.outputPaths.length, 1);
  assert.strictEqual(path.basename(summary.outputPaths[0]), 'sample_squeezed.pdf');
  assert.strictEqual(fs.existsSync(summary.outputPaths[0]), true);
  assert.strictEqual(summary.totalCompressedBytes <= summary.totalOriginalBytes, true);
  assert.strictEqual(fs.statSync(summary.outputPaths[0]).size <= fs.statSync(pdfPath).size, true);
}

async function testPdfSqueezerNormalizesShellEscapedDropPaths() {
  const sourceDir = makeTempDir('gsbot-reg-pdf-shell-');
  const pdfPath = path.join(sourceDir, "31st Mar. COLIN'S  MEETING NOTES.pdf");
  fs.writeFileSync(pdfPath, '%PDF-1.4\n%%EOF\n');

  const shellEscaped = pdfPath
    .replace(/ /g, '\\ ')
    .replace(/'/g, '\\\'');

  const entries = pdfSqueezerPrivate.resolvePdfSourceEntries(fs, path, [shellEscaped]);

  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].path, pdfPath);
}

async function testPythonVendorLoadsBundledFitz() {
  const stdout = runPython(
    [
      'import sys, pathlib',
      `vendor = pathlib.Path(${JSON.stringify(path.join(ROOT, 'python_vendor'))})`,
      'sys.path = [str(vendor)] + [p for p in sys.path if "site-packages" not in p]',
      'import fitz',
      'print(pathlib.Path(fitz.__file__).resolve())',
    ].join('; '),
  );

  assert.strictEqual(stdout.includes(path.join('python_vendor', 'fitz')), true);
}

async function testWindowsBundledPythonIncludesPymupdf() {
  const sitePackagesRoot = path.join(ROOT, 'vendor', 'windows', 'python', 'Lib', 'site-packages');
  const pymupdfRoot = path.join(sitePackagesRoot, 'pymupdf');
  const fitzRoot = path.join(sitePackagesRoot, 'fitz');

  assert.strictEqual(fs.existsSync(fitzRoot), true);
  assert.strictEqual(fs.existsSync(pymupdfRoot), true);
  assert.strictEqual(fs.existsSync(path.join(pymupdfRoot, '_extra.pyd')), true);
  assert.strictEqual(fs.existsSync(path.join(pymupdfRoot, '_mupdf.pyd')), true);
}

async function testWindowsOnnxruntimeIncludesAppLocalCrt() {
  const onnxruntimeBinRoot = path.join(ROOT, 'node_modules', 'onnxruntime-node', 'bin');
  const onnxruntimeRoot = fs.readdirSync(onnxruntimeBinRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^napi-v\d+$/i.test(entry.name))
    .sort((left, right) => right.name.localeCompare(left.name, undefined, { numeric: true, sensitivity: 'base' }))
    .map((entry) => path.join(onnxruntimeBinRoot, entry.name, 'win32', 'x64'))
    .find((candidate) => fs.existsSync(path.join(candidate, 'onnxruntime_binding.node')));

  assert.ok(onnxruntimeRoot, 'Expected a Windows ONNX Runtime binary directory.');
  const bundledCrtRoot = path.join(ROOT, 'vendor', 'windows', 'crt');

  for (const fileName of [
    'msvcp140.dll',
    'msvcp140_1.dll',
    'msvcp140_2.dll',
    'msvcp140_atomic_wait.dll',
    'msvcp140_codecvt_ids.dll',
    'vcruntime140.dll',
    'vcruntime140_1.dll',
  ]) {
    assert.strictEqual(
      fs.existsSync(path.join(onnxruntimeRoot, fileName)) || fs.existsSync(path.join(bundledCrtRoot, fileName)),
      true,
    );
  }
}

async function testWindowsLabelDetectorOnnxIsPrepared() {
  const onnxPath = path.join(
    ROOT,
    'label training',
    'project-1-at-2026-04-29-01-26-fa2c918e',
    'runs',
    'detect',
    'train-3',
    'weights',
    'best.onnx',
  );

  assert.strictEqual(fs.existsSync(onnxPath), true);

  const verify = spawnSync('node', ['scripts/verify-onnxruntime-model-load.js', onnxPath], {
    cwd: ROOT,
    encoding: 'utf8',
  });

  if (verify.status !== 0) {
    throw new Error(verify.stderr || verify.stdout || 'Windows label detector ONNX load check failed');
  }
  assert.strictEqual(String(verify.stdout || '').includes('LOAD_OK'), true);
}

async function testPdfSqueezerReportsUnchangedCopiesWhenSavingsAreNegligible() {
  const sourceDir = makeTempDir('gsbot-reg-pdf-nosave-src-');
  const outputDir = makeTempDir('gsbot-reg-pdf-nosave-out-');
  const imagePath = path.join(sourceDir, 'small.jpg');
  const pdfPath = path.join(sourceDir, 'small.pdf');

  runPython(
    `from PIL import Image; Image.new("RGB", (900, 600), (230, 230, 230)).save(${JSON.stringify(imagePath)}, "JPEG", quality=35); Image.open(${JSON.stringify(imagePath)}).save(${JSON.stringify(pdfPath)}, "PDF", resolution=150.0)`,
  );

  const result = spawnSync('python3', ['pdf_squeezer.py'], {
    cwd: ROOT,
    encoding: 'utf8',
    input: JSON.stringify({
      sourceFiles: [pdfPath],
      outputFolder: outputDir,
      config: {
        preset: 'light',
        suffix: '_squeezed',
      },
    }),
    env: {
      ...process.env,
      PYTHONPYCACHEPREFIX: path.join(os.tmpdir(), 'pycache'),
    },
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || 'PDF Squeezer unchanged-copy command failed');
  }

  const lines = String(result.stdout || '').trim().split('\n').filter(Boolean);
  const summary = JSON.parse(lines[lines.length - 1]);

  assert.strictEqual(summary.success, true);
  assert.strictEqual(summary.unchangedCount, 1);
  assert.deepStrictEqual(summary.issues?.unchangedFiles, ['small.pdf']);
  assert.strictEqual(summary.totalBytesSaved, 0);
  assert.strictEqual(fs.statSync(summary.outputPaths[0]).size, fs.statSync(pdfPath).size);
}

async function testVisualGroupingHintsCollapseDuplicateImages() {
  const sourceDir = makeTempDir('gsbot-reg-visual-group-');
  const first = copyFile(FIXTURE_PNG, path.join(sourceDir, 'look-1.png'));
  const duplicate = copyFile(FIXTURE_PNG, path.join(sourceDir, 'look-1-dup.png'));
  const second = copyFile(FIXTURE_JPG, path.join(sourceDir, 'look-2.jpg'));

  const grouping = await buildVisualGroupingHints([first, duplicate, second], () => {});

  assert.strictEqual(grouping.representativeImages.length <= 2, true);
  assert.strictEqual(grouping.duplicateGroups.length >= 1, true);
}

async function testVisualStyleCoverageFiltersNonProductPdfPages() {
  const sourceDir = makeTempDir('gsbot-reg-visual-coverage-');
  const first = copyFile(FIXTURE_PNG, path.join(sourceDir, 'page-002-look-a.png'));
  const duplicate = copyFile(FIXTURE_PNG, path.join(sourceDir, 'page-002-look-a-dup.png'));
  const second = path.join(sourceDir, 'page-003-look-b.jpg');
  const fabricBoard = copyFile(FIXTURE_JPG, path.join(sourceDir, 'page-038-fabric-board.jpg'));

  runPython(
    `from PIL import Image; Image.new("RGB", (900, 600), (40, 120, 220)).save(${JSON.stringify(second)}, "JPEG", quality=85)`,
  );

  const coverage = await buildVisualStyleCoverage({
    sourceType: 'pdf',
    imageRecords: [
      { path: first, name: path.basename(first), pageNumber: 2, explicitLabel: false },
      { path: duplicate, name: path.basename(duplicate), pageNumber: 2, explicitLabel: false },
      { path: second, name: path.basename(second), pageNumber: 3, explicitLabel: false },
      { path: fabricBoard, name: path.basename(fabricBoard), pageNumber: 38, explicitLabel: false },
    ],
    pageContexts: [
      { number: 2, imageCount: 4 },
      { number: 3, imageCount: 4 },
      { number: 38, imageCount: 10 },
    ],
  }, [{ code: 'STYLE-001' }], () => {});

  assert.strictEqual(coverage.imagePaths.includes(fabricBoard), false);
  assert.strictEqual(coverage.representativeCount, 2);
  assert.strictEqual(coverage.totalOverride, 2);
}

async function main() {
  ensureFixture(FIXTURE_PNG);
  ensureFixture(FIXTURE_JPG);

  const tests = [
    ['python scan ignores _organize_meta folder', testPythonScanIgnoresOrganizeMeta],
    ['label mode ignores unrelated top-level images', testLabelModeIgnoresUnrelatedTopLevelImages],
    ['organizer metadata skips stale entries', testOrganizerMetadataSkipsStaleEntries],
    ['style-only mode uses named front/back images', testStyleOnlyModeUsesNamedFrontBackImages],
    ['style-only issues track missing back and skipped files', testStyleOnlyIssuesTrackMissingBackAndSkippedFiles],
    ['organizer metadata issues summarize manual review', testOrganizerMetadataIssuesSummarizeManualReview],
    ['python output collision adds numeric suffix', testPythonUniqueOutputPathAddsSuffix],
    ['label parsing keeps CW/BW units and fixes impossible OZ weights', testLabelParsingKeepsFabricUnitsAndFixesWeightDecimal],
    ['organizer metadata rehydrates fabric formatting from raw text', testOrganizerMetadataRehydratesFabricFormattingFromRawText],
    ['pdf squeezer creates a compressed copy', testPdfSqueezerCreatesCompressedCopy],
    ['pdf squeezer normalizes shell-escaped drop paths', testPdfSqueezerNormalizesShellEscapedDropPaths],
    ['pdf squeezer reports unchanged copies when no useful savings exist', testPdfSqueezerReportsUnchangedCopiesWhenSavingsAreNegligible],
    ['python vendor loads bundled fitz', testPythonVendorLoadsBundledFitz],
    ['windows bundled python includes pymupdf binaries', testWindowsBundledPythonIncludesPymupdf],
    ['windows onnxruntime includes app-local crt', testWindowsOnnxruntimeIncludesAppLocalCrt],
    ['windows label detector onnx loads', testWindowsLabelDetectorOnnxIsPrepared],
    ['visual grouping collapses duplicate images', testVisualGroupingHintsCollapseDuplicateImages],
    ['visual style coverage ignores non-product pdf pages', testVisualStyleCoverageFiltersNonProductPdfPages],
  ];

  let passed = 0;

  for (const [name, fn] of tests) {
    await fn();
    passed += 1;
    process.stdout.write(`PASS ${name}\n`);
  }

  process.stdout.write(`\n${passed}/${tests.length} regression checks passed.\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message || String(error)}\n`);
  process.exit(1);
});

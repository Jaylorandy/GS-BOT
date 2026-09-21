'use strict';

// Guards the coupling behind start-task's returned outputPath.
//
// Every brand scraper resolves its own output folder inline:
//     const targetDir = !outputDir || outputDir === '未选择'
//       ? path.join(app.getPath('desktop'), '<Folder>') : outputDir;
// and `start-task` reproduces that decision via
// resolveScraperOutputDir() -> getScraperOutputFolderName() so the post-scrape
// AI trend analysis knows where to read from. If a scraper's literal folder
// name and getScraperOutputFolderName() ever disagree, the analysis silently
// points at an empty directory and the report comes back with 0 styles.
//
// Static analysis on purpose: main.js cannot be required (it boots Electron).
// Run: node scripts/verify-scraper-folders.js

const fs = require('fs');
const path = require('path');

const mainJsPath = path.resolve(__dirname, '..', 'main.js');
const src = fs.readFileSync(mainJsPath, 'utf8');
const lines = src.split(/\r?\n/);

// ── 1. Parse the brand -> folder table out of getScraperOutputFolderName() ──
const fallback = {};
const table = {};
let inFn = false;
for (const line of lines) {
  if (/^function getScraperOutputFolderName/.test(line)) { inFn = true; continue; }
  if (!inFn) continue;
  const m = line.match(/if \(normalizedBrand === '([a-z]+)'\) return '([^']+)';/);
  if (m) { table[m[1]] = m[2]; continue; }
  const d = line.match(/^ {2}return '([^']+)';/);
  if (d) { fallback.default = d[1]; inFn = false; }
}

// ── 2. Which scraper function belongs to which brand ──────────────────────
const fnToBrand = {
  runUniqloScraper: 'uniqlo',
  runGuScraper: 'gu',
  runStradivariusScraper: 'stradivarius',
  runPullAndBearScraper: 'pullandbear',
  runBershkaScraper: 'bershka',
  runLeftiesScraper: 'lefties',
  runMangoScraper: 'mango',
  runAbercrombieScraper: 'abercrombie',
  runReservedScraper: 'reserved',
  runSinsayScraper: 'sinsay',
  runUrbanRevivoScraper: 'urbanrevivo',
  runHmScraper: 'hm',
  runNewYorkerScraper: 'newyorker',
  runScraper: 'zara',
  // runGuScraper delegates to runSingleBrandProductScraper({defaultFolder:'GU'}).
  runSingleBrandProductScraper: 'gu',
};
// Scrapers whose Desktop folder comes from an argument rather than a literal.
const delegatedFolder = { runSingleBrandProductScraper: 'GU' };

function enclosingFunction(index) {
  for (let i = index; i >= 0; i -= 1) {
    const m = lines[i].match(/^(?:async\s+)?function\s+([A-Za-z0-9_$]+)/);
    if (m) return m[1];
  }
  return null;
}

const problems = [];
const checked = [];

lines.forEach((line, index) => {
  if (!/const targetDir\s*=.*app\.getPath\('desktop'\)/.test(line)) return;
  const fn = enclosingFunction(index);
  if (!fn) return;
  const literal = line.match(/'([^']+)'\s*\)\s*:\s*outputDir/)
    || line.match(/path\.join\(app\.getPath\('desktop'\),\s*'([^']+)'\)/);
  const folder = delegatedFolder[fn] || (literal ? literal[1] : null);
  const brand = fnToBrand[fn];
  if (!folder) { problems.push(`${fn}: could not read the Desktop fallback folder name`); return; }
  if (!brand) { problems.push(`${fn}: no brand mapping in this script — add one`); return; }
  const expected = table[brand] || fallback.default;
  checked.push({ fn, folder, expected });
  if (folder !== expected) {
    problems.push(`${fn}: Desktop fallback '${folder}' != getScraperOutputFolderName('${brand}') '${expected}'`);
  }
});

// ── 3. The GU delegation and the mixed-brand root ─────────────────────────
if (!/defaultFolder:\s*'GU'/.test(src)) {
  problems.push("runGuScraper no longer passes defaultFolder:'GU' to runSingleBrandProductScraper");
}
const mixedRoot = (src.match(/targetRoot\s*=[^?]*\?\s*path\.join\(app\.getPath\('desktop'\),\s*'([^']+)'\)/) || [])[1];
if (mixedRoot !== table.mixed) {
  problems.push(`Mixed Brands root '${mixedRoot}' != getScraperOutputFolderName('mixed') '${table.mixed}'`);
}

// ── 4. Every brand offered in the wizard must resolve to something ────────
const wizardBrands = [
  'zara', 'bershka', 'stradivarius', 'pullandbear', 'lefties', 'mango', 'reserved',
  'sinsay', 'urbanrevivo', 'newyorker', 'hm', 'uniqlo', 'gu', 'abercrombie', 'mixed',
];
for (const brand of wizardBrands) {
  const resolved = table[brand] || fallback.default;
  if (!resolved) problems.push(`wizard brand '${brand}' has no folder mapping`);
}

for (const { fn, folder, expected } of checked) {
  console.log(`ok   ${fn.padEnd(32)} '${folder}'${folder === expected ? '' : `  (expected '${expected}')`}`);
}
console.log(`\nscrapers checked: ${checked.length}`);

if (problems.length) {
  console.error('\nFAILED:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('All scraper output folders match getScraperOutputFolderName().');

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Redirect console output to stderr. The worker communicates with the parent
// process via stdout (JSON lines), so any console.log/warn/error must go to
// stderr to avoid corrupting the JSON protocol. Native OCR modules (ONNX
// Runtime) may also print warnings to stdout — those are handled on the
// parent side by skipping non-JSON lines.
const _formatArg = (a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })());
console.log = (...args) => process.stderr.write(`${args.map(_formatArg).join(' ')}\n`);
console.warn = (...args) => process.stderr.write(`${args.map(_formatArg).join(' ')}\n`);
console.error = (...args) => process.stderr.write(`${args.map(_formatArg).join(' ')}\n`);

function resolveEngineModulePath() {
  const dirname = __dirname || process.cwd();
  const resourcesPath = process.resourcesPath || '';
  const candidates = [
    path.join(dirname, 'label-ocr-engine.js'),
    path.join(dirname.replace(`${path.sep}app.asar.unpacked${path.sep}`, `${path.sep}app.asar${path.sep}`), 'label-ocr-engine.js'),
    resourcesPath ? path.join(resourcesPath, 'app.asar', 'label-ocr-engine.js') : '',
    resourcesPath ? path.join(resourcesPath, 'label-ocr-engine.js') : '',
  ].filter(Boolean);

  const found = candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  });

  if (!found) {
    throw new Error(`Unable to resolve label-ocr-engine.js. Tried: ${candidates.join(', ')}`);
  }

  return found;
}

const {
  runEnhancedLabelOcrDirect,
  runEnhancedTextOcrDirect,
} = require(resolveEngineModulePath());

function writeResponse(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function executePayload(payload = {}) {
  const mode = String(payload.mode || 'label').trim().toLowerCase();
  return mode === 'text'
    ? runEnhancedTextOcrDirect(payload.imagePath, payload.options || {})
    : runEnhancedLabelOcrDirect(payload.imagePath, payload.options || {});
}

function main() {
  process.stdin.setEncoding('utf8');

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  let queue = Promise.resolve();

  rl.on('line', (line) => {
    const rawLine = String(line || '').trim();
    if (!rawLine) {
      return;
    }

    let payload = {};
    try {
      payload = JSON.parse(rawLine);
    } catch (error) {
      writeResponse({
        id: null,
        success: false,
        error: `Invalid OCR worker payload: ${error.message}`,
      });
      return;
    }

    const requestId = payload.id || null;
    queue = queue
      .then(async () => {
        try {
          const result = await executePayload(payload);
          writeResponse({
            id: requestId,
            success: true,
            result,
          });
        } catch (error) {
          writeResponse({
            id: requestId,
            success: false,
            error: error?.stack || error?.message || String(error),
          });
        }
      })
      .catch(() => {
        // Keep the worker alive for subsequent requests.
      });
  });

  rl.on('close', () => {
    queue.finally(() => process.exit(0));
  });
}

main();

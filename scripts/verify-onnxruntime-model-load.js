const path = require('path');
const ort = require('onnxruntime-node');

async function main() {
  const modelPath = process.argv[2];
  if (!modelPath) {
    throw new Error('Usage: node scripts/verify-onnxruntime-model-load.js <model.onnx>');
  }

  const resolvedModelPath = path.resolve(modelPath);
  const session = await ort.InferenceSession.create(resolvedModelPath, {
    executionProviders: ['cpu'],
  });

  console.log('LOAD_OK');
  console.log(`model: ${resolvedModelPath}`);
  console.log(`inputs: ${session.inputNames.join(', ')}`);
  console.log(`outputs: ${session.outputNames.join(', ')}`);
}

main().catch((error) => {
  console.error('LOAD_FAIL');
  console.error(error && (error.stack || error.message) ? (error.stack || error.message) : error);
  process.exit(1);
});

const fs = require('fs');
const { processGarmentImagesWithLiteOnnx } = require('./rmbg-lite-onnx');

const EVENT_PREFIX = 'GSBOT_LITE_EVENT ';

function emit(type, payload = {}) {
  process.stdout.write(`${EVENT_PREFIX}${JSON.stringify({ type, ...payload })}\n`);
}

async function main() {
  const payloadPath = process.argv[2];
  if (!payloadPath) {
    throw new Error('Missing lite worker payload path.');
  }

  const payload = JSON.parse(await fs.promises.readFile(payloadPath, 'utf8'));
  const result = await processGarmentImagesWithLiteOnnx(payload, {
    emitLog: (message, level = 'info') => emit('log', { message, level }),
    emitProgress: (value) => emit('progress', { value }),
    throwIfCancelled: () => {
      if (fs.existsSync(`${payloadPath}.cancel`)) {
        throw new Error('Garment cleaning cancelled by user.');
      }
    },
  });

  emit('result', { result });
}

main().catch((error) => {
  emit('error', {
    error: error?.message || String(error),
    stack: error?.stack || '',
  });
  process.exit(1);
});

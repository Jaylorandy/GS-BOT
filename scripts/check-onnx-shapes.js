const ort = require('onnxruntime-node');
(async () => {
  const session = await ort.InferenceSession.create(
    '/Volumes/JaylorAndy/GS Bot-app/vendor/windows/label-detector/best.onnx',
  );
  console.log('inputNames:', session.inputNames);
  console.log('outputNames:', session.outputNames);
  // Also try the older-style accessors
  console.log('handler:', typeof session.handler);
  console.log('keys:', Object.keys(session));
  // Try a known-size probe so we can compare 1024 vs 1280 outputs
  for (const size of [1024, 1280, 640]) {
    try {
      const tensor = new ort.Tensor('float32', new Float32Array(3 * size * size), [1, 3, size, size]);
      const out = await session.run({ images: tensor });
      const t = out.output0;
      console.log(`size=${size}  output dims=${JSON.stringify(t.dims)}  data length=${t.data.length}`);
    } catch (e) {
      console.log(`size=${size}  FAILED: ${e.message}`);
    }
  }
})();

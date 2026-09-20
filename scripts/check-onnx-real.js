// End-to-end probe: feed a real label image through the bundled ONNX model
// and print the top scoring detections so we can decide whether the issue is
// preprocessing/threshold/output parsing or actually model precision.
const path = require('path');
const ort = require('onnxruntime-node');
const sharp = require('sharp');

const MODEL = '/Volumes/JaylorAndy/GS Bot-app/vendor/windows/label-detector/best.onnx';
const INPUT = 1280;

async function probeOne(imagePath) {
  const session = await ort.InferenceSession.create(MODEL);
  const image = sharp(imagePath, { failOn: 'none' }).rotate().removeAlpha();
  const meta = await image.metadata();
  const W = meta.width, H = meta.height;
  const scale = Math.min(INPUT / W, INPUT / H);
  const rW = Math.round(W * scale), rH = Math.round(H * scale);
  const padL = Math.floor((INPUT - rW) / 2), padT = Math.floor((INPUT - rH) / 2);
  const { data } = await image
    .resize(rW, rH, { fit: 'fill' })
    .extend({ top: padT, bottom: INPUT - rH - padT, left: padL, right: INPUT - rW - padL, background: { r: 114, g: 114, b: 114 } })
    .raw().toBuffer({ resolveWithObject: true });

  const px = INPUT * INPUT;
  const t = new Float32Array(px * 3);
  for (let i = 0; i < px; i++) {
    const o = i * 3;
    t[i] = data[o] / 255;
    t[px + i] = data[o + 1] / 255;
    t[px * 2 + i] = data[o + 2] / 255;
  }

  const out = await session.run({ images: new ort.Tensor('float32', t, [1, 3, INPUT, INPUT]) });
  const tensor = out.output0;
  const values = tensor.data;
  const dims = tensor.dims; // [1, rows, anchors]
  const rows = dims[1], anchors = dims[2];
  const numClasses = rows - 4;

  console.log(`\n=== ${path.basename(imagePath)} (${W}x${H}) → resized=${rW}x${rH} pad=${padL},${padT}`);
  console.log(`output dims=${JSON.stringify(dims)} numClasses=${numClasses}`);

  // Collect per-class top-3 scores
  const perClass = Array.from({ length: numClasses }, () => []);
  for (let i = 0; i < anchors; i++) {
    for (let c = 0; c < numClasses; c++) {
      const score = values[anchors * (4 + c) + i];
      if (score > 0.01) perClass[c].push({ i, score });
    }
  }
  for (let c = 0; c < numClasses; c++) {
    perClass[c].sort((a, b) => b.score - a.score);
    const top = perClass[c].slice(0, 5);
    console.log(`class ${c}: ${perClass[c].length} anchors >0.01, top5 = ${top.map(x => x.score.toFixed(3)).join(', ')}`);
  }
}

(async () => {
  const dir = process.argv[2];
  if (!dir) { console.error('usage: node check-onnx-real.js <image-or-dir>'); process.exit(1); }
  const fs = require('fs');
  const stat = fs.statSync(dir);
  const files = stat.isDirectory()
    ? fs.readdirSync(dir).filter(f => /\.(jpe?g|png)$/i.test(f)).slice(0, 5).map(f => path.join(dir, f))
    : [dir];
  for (const f of files) await probeOne(f);
})();

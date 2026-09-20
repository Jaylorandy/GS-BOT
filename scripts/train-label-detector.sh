#!/bin/bash
# Train new label detector and install resulting ONNX into vendor/.
# Run this from your own terminal (not Claude's sandbox).
set -e

PROJECT="/Volumes/JaylorAndy/GS Bot-app"
DATASET="$PROJECT/label training/v3-2026-06-02"
VENV="$HOME/.venv"

echo "=== 1/4 Verify dataset ==="
test -f "$DATASET/dataset.yaml"
echo "Dataset OK at: $DATASET"

echo
echo "=== 2/4 Install ultralytics if missing ==="
if ! "$VENV/bin/python" -c "import ultralytics" 2>/dev/null; then
  "$VENV/bin/pip" install --upgrade ultralytics
else
  echo "ultralytics already installed"
fi

echo
echo "=== 3/4 Train (yolov8n, 150 epochs, imgsz=1280, ~45 min on CPU) ==="
cd "$DATASET"
"$VENV/bin/yolo" detect train \
  data="$DATASET/dataset.yaml" \
  model=yolov8n.pt \
  epochs=150 \
  imgsz=1280 \
  project="$DATASET/runs" \
  name=train \
  exist_ok=True \
  patience=30

BEST="$DATASET/runs/train/weights/best.pt"
test -f "$BEST"
echo "Trained weights: $BEST"

echo
echo "=== 4/4 Export to ONNX and install into vendor/ ==="
"$VENV/bin/yolo" export model="$BEST" format=onnx opset=12 imgsz=1280
ONNX="$DATASET/runs/train/weights/best.onnx"
test -f "$ONNX"

# Backup old model
TARGET="$PROJECT/models/label-detector/best.onnx"
mkdir -p "$(dirname "$TARGET")"
if [ -f "$TARGET" ]; then
  cp "$TARGET" "$TARGET.bak.$(date +%s)"
fi

cp "$ONNX" "$TARGET"
ls -la "$TARGET"
echo
echo "✅ Done. New best.onnx installed at: $TARGET"
echo "   Now you can re-run: npm run dist:mac (or dist:win)"

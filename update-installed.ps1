# GS Bot 修复更新脚本 - 以管理员权限运行
# 自包含：从源码打包 asar 并部署到已安装的应用
$ErrorActionPreference = 'Stop'

Write-Host "============================================"
Write-Host " GS Bot OCR 修复更新 (自包含版)"
Write-Host "============================================"
Write-Host ""

$appSrc = "e:\GS Bot-app"
$nodeExe = "C:\Program Files\Adobe\Adobe Photoshop 2026\node.exe"
$asarJs = Join-Path $appSrc "node_modules\@electron\asar\bin\asar.js"

# --- Auto-detect installed app location ---
Write-Host "[0/5] Detecting installed GS Bot..."
$installedBase = $null
$candidatePaths = @(
  "E:\GS Bot-app\release\win-unpacked",
  "D:\新建文件夹 (2)\GS Bot",
  "D:\新建文件夹\GS Bot",
  "C:\Users\Administrator\AppData\Local\Programs\GS Bot"
)

# Search for GS Bot.exe
foreach ($candidate in $candidatePaths) {
  if (Test-Path (Join-Path $candidate "GS Bot.exe")) {
    $installedBase = $candidate
    break
  }
}

if (-not $installedBase) {
  # Broad search
  $searchRoots = @("D:\", "C:\Program Files", "C:\Users\Administrator\AppData\Local\Programs")
  foreach ($root in $searchRoots) {
    $found = Get-ChildItem $root -Filter "GS Bot.exe" -Recurse -Depth 4 -ErrorAction SilentlyContinue 2>$null | Select-Object -First 1
    if ($found) {
      $installedBase = $found.DirectoryName
      break
    }
  }
}

if (-not $installedBase) {
  Write-Host "  WARNING: GS Bot installation not found!"
  Write-Host "  Please specify the install path manually:"
  $manualPath = Read-Host "  Enter GS Bot install directory (e.g. D:\新建文件夹 (2)\GS Bot)"
  if ($manualPath -and (Test-Path $manualPath)) {
    $installedBase = $manualPath
  } else {
    Write-Host "  Path not found. Exiting."
    exit 1
  }
}

$resourcesDir = Join-Path $installedBase "resources"
$dst = Join-Path $resourcesDir "app.asar"
$unpacked = Join-Path $resourcesDir "app.asar.unpacked"

Write-Host "  Found: $installedBase"
Write-Host ""

# --- Step 1: Pack asar from source ---
Write-Host "[1/5] Packing app.asar from source..."

$tempAsar = Join-Path $env:TEMP "gsbot-app-new.asar"
$tempExtract = Join-Path $env:TEMP "gsbot-asar-extract"

# Extract current asar to temp, then replace modified packed files
if (Test-Path $tempExtract) { Remove-Item $tempExtract -Recurse -Force }
New-Item -ItemType Directory -Path $tempExtract -Force | Out-Null

if (Test-Path $dst) {
  # Extract existing asar using the asar CLI
  & $nodeExe $asarJs extract $dst $tempExtract 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Host "  FAILED to extract existing asar!"
    exit 1
  }
  Write-Host "  Extracted existing asar"
} else {
  Write-Host "  ERROR: No existing asar found at $dst"
  exit 1
}

# Replace packed files that were modified
$packedFiles = @(
  'main.js',
  'product-analysis-visual-context.js',
  'excel-engine.js',
  'po-template-utils.js',
  'po-layout-cache.js',
  'po-doc-compress.js',
  'po-validation-gate.js'
)

foreach ($f in $packedFiles) {
  $srcPath = Join-Path $appSrc $f
  $dstPath = Join-Path $tempExtract $f
  if (Test-Path $srcPath) {
    $dstDir = Split-Path $dstPath -Parent
    if (-not (Test-Path $dstDir)) { New-Item -ItemType Directory -Path $dstDir -Force | Out-Null }
    Copy-Item -Path $srcPath -Destination $dstPath -Force
    Write-Host "  Updated packed: $f"
  }
}

# Replace the entire dist/ directory (compiled frontend)
$distSrc = Join-Path $appSrc "dist"
$distDst = Join-Path $tempExtract "dist"
if (Test-Path $distSrc) {
  if (Test-Path $distDst) { Remove-Item $distDst -Recurse -Force }
  Copy-Item -Path $distSrc -Destination $distDst -Recurse -Force
  Write-Host "  Updated packed: dist/ (frontend rebuild)"
}

# Pack asar with unpack patterns
$unpackFiles = "label-ocr-worker.js,rmbg-lite-worker.js,rmbg-lite-onnx.js,label-ocr-engine.js,label-ocr-profile.js,llm-client.js,llm-config.js,apparel-vision-service.js,runtime-resolver.js,ocr-engine-config.js,processing-cache.js,src/shared/labelOcrDefaults.json,generate_slides.py,garment_cleaner.py,rmbg_python.py,pdf_squeezer.py,pdf_visual_extract.py,slides_scan_utils.py,slides_render_utils.py"

$unpackDirs = "node_modules/puppeteer-core,node_modules/puppeteer-core/node_modules,node_modules/@gutenye/ocr-node,node_modules/@gutenye/ocr-common,node_modules/@gutenye/ocr-models,node_modules/tiny-invariant,node_modules/js-clipper,node_modules/@techstark/opencv-js,node_modules/onnxruntime-node,node_modules/onnxruntime-common,node_modules/sharp,node_modules/detect-libc,node_modules/semver,node_modules/color,node_modules/color-string,node_modules/color-convert,node_modules/color-name,node_modules/simple-swizzle,node_modules/is-arrayish,node_modules/@img,node_modules/regenerator-runtime,python_vendor"

if (Test-Path $tempAsar) { Remove-Item $tempAsar -Force }
$tempUnpacked = "$tempAsar.unpacked"
if (Test-Path $tempUnpacked) { Remove-Item $tempUnpacked -Recurse -Force }

& $nodeExe $asarJs pack $tempExtract $tempAsar --unpack "{$unpackFiles}" --unpack-dir "{$unpackDirs}" 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host "  FAILED to pack asar!"
  exit 1
}

$asarSize = [math]::Round((Get-Item $tempAsar).Length / 1MB, 1)
Write-Host "  Packed asar: $asarSize MB"
Write-Host ""

# --- Step 2: Copy asar to installed location ---
Write-Host "[2/5] Copying app.asar to installed location..."
Copy-Item -Path $tempAsar -Destination $dst -Force
Write-Host "  app.asar updated: $dst"
Write-Host ""

# --- Step 3: Copy unpacked directory ---
Write-Host "[3/5] Updating unpacked directory..."
if (Test-Path $tempUnpacked) {
  # Copy unpacked directory from the pack
  Get-ChildItem $tempUnpacked -Recurse | ForEach-Object {
    $rel = $_.FullName.Substring($tempUnpacked.Length)
    $target = Join-Path $unpacked $rel
    if ($_.PSIsContainer) {
      New-Item -ItemType Directory -Path $target -Force | Out-Null
    } else {
      $targetDir = Split-Path $target -Parent
      if (-not (Test-Path $targetDir)) { New-Item -ItemType Directory -Path $targetDir -Force | Out-Null }
      Copy-Item -Path $_.FullName -Destination $target -Force
    }
  }
  Write-Host "  Unpacked directory synced from pack"
}
Write-Host ""

# --- Step 4: Direct copy of modified unpacked files ---
Write-Host "[4/5] Direct copy of modified unpacked files..."
$jsFiles = @(
  'label-ocr-engine.js',
  'label-ocr-worker.js',
  'label-ocr-profile.js',
  'llm-client.js',
  'llm-config.js',
  'apparel-vision-service.js',
  'runtime-resolver.js',
  'ocr-engine-config.js',
  'processing-cache.js',
  'rmbg-lite-onnx.js',
  'rmbg-lite-worker.js'
)

$pyFiles = @(
  'pdf_visual_extract.py',
  'garment_cleaner.py',
  'generate_slides.py',
  'pdf_squeezer.py',
  'rmbg_python.py',
  'slides_scan_utils.py',
  'slides_render_utils.py'
)

foreach ($f in $jsFiles) {
  $srcPath = Join-Path $appSrc $f
  $dstPath = Join-Path $unpacked $f
  if (Test-Path $srcPath) {
    Copy-Item -Path $srcPath -Destination $dstPath -Force
    Write-Host "  Updated: $f"
  }
}

foreach ($f in $pyFiles) {
  $srcPath = Join-Path $appSrc $f
  $dstPath = Join-Path $unpacked $f
  if (Test-Path $srcPath) {
    Copy-Item -Path $srcPath -Destination $dstPath -Force
    Write-Host "  Updated: $f"
  }
}
Write-Host ""

# --- Step 5: Verify ---
Write-Host "[5/5] Verifying..."
$content = [System.IO.File]::ReadAllText($dst)
if ($content.Contains('safeParsePythonJson')) {
  Write-Host "  OK: safeParsePythonJson found in app.asar"
} else {
  Write-Host "  WARNING: safeParsePythonJson NOT found in app.asar!"
}

$mainContent = [System.IO.File]::ReadAllText((Join-Path $tempExtract "main.js"))
if ($mainContent.Contains('jsonMatch')) {
  Write-Host "  OK: regex JSON fallback found in main.js"
} else {
  Write-Host "  WARNING: regex JSON fallback NOT found in main.js!"
}

$ocrContent = [System.IO.File]::ReadAllText((Join-Path $unpacked "label-ocr-engine.js"))
if ($ocrContent.Contains('greedyMatch')) {
  Write-Host "  OK: regex JSON fallback found in label-ocr-engine.js"
} else {
  Write-Host "  WARNING: regex JSON fallback NOT found in label-ocr-engine.js!"
}

$pyContent = [System.IO.File]::ReadAllText((Join-Path $unpacked "pdf_visual_extract.py"))
if ($pyContent.Contains('PYMUPDF_WARNINGS')) {
  Write-Host "  OK: warning suppression found in pdf_visual_extract.py"
} else {
  Write-Host "  WARNING: warning suppression NOT found in pdf_visual_extract.py!"
}

# Cleanup temp
Remove-Item $tempExtract -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $tempAsar -Force -ErrorAction SilentlyContinue
Remove-Item $tempUnpacked -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "============================================"
Write-Host " Update complete! Please restart GS Bot."
Write-Host "============================================"

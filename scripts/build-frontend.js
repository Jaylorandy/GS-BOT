const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const projectRoot = path.resolve(__dirname, '..');
const distDir = path.join(projectRoot, 'dist');
const assetsDir = path.join(distDir, 'assets');
const publicDir = path.join(projectRoot, 'public');
const htmlTemplatePath = path.join(projectRoot, 'index.html');

function toPosix(filePath) {
  return filePath.split(path.sep).join('/');
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyRecursive(sourcePath, destinationPath) {
  const stat = fs.statSync(sourcePath);
  if (stat.isDirectory()) {
    ensureDir(destinationPath);
    for (const entry of fs.readdirSync(sourcePath)) {
      copyRecursive(path.join(sourcePath, entry), path.join(destinationPath, entry));
    }
    return;
  }

  ensureDir(path.dirname(destinationPath));
  fs.copyFileSync(sourcePath, destinationPath);
}

function getOutputPath(outputKey) {
  return path.isAbsolute(outputKey)
    ? outputKey
    : path.join(projectRoot, outputKey);
}

async function buildFrontend() {
  fs.rmSync(distDir, { recursive: true, force: true });
  ensureDir(assetsDir);

  const result = await esbuild.build({
    absWorkingDir: projectRoot,
    entryPoints: ['src/main.jsx'],
    outdir: 'dist/assets',
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['chrome114', 'safari16'],
    jsx: 'automatic',
    minify: true,
    logLevel: 'info',
    metafile: true,
    sourcemap: false,
    legalComments: 'none',
    entryNames: 'index-[hash]',
    assetNames: '[name]-[hash]',
    loader: {
      '.js': 'jsx',
      '.jsx': 'jsx',
      '.css': 'css',
      '.ttf': 'file',
      '.svg': 'file',
      '.png': 'file',
      '.jpg': 'file',
      '.jpeg': 'file',
      '.webp': 'file',
    },
    define: {
      'process.env.NODE_ENV': '"production"',
    },
  });

  const outputs = result.metafile ? result.metafile.outputs : {};
  const entryOutputKey = Object.keys(outputs).find((outputKey) => {
    const output = outputs[outputKey];
    return output.entryPoint === 'src/main.jsx' && outputKey.endsWith('.js');
  });

  if (!entryOutputKey) {
    throw new Error('Frontend build did not emit a JS entry file.');
  }

  const entryOutput = outputs[entryOutputKey];
  const jsAssetPath = toPosix(path.relative(distDir, getOutputPath(entryOutputKey)));
  const cssAssetPath = entryOutput.cssBundle
    ? toPosix(path.relative(distDir, getOutputPath(entryOutput.cssBundle)))
    : '';

  const htmlTemplate = fs.readFileSync(htmlTemplatePath, 'utf8');
  const cssTag = cssAssetPath
    ? `    <link rel="stylesheet" href="./${cssAssetPath}" />\n`
    : '';

  const html = htmlTemplate
    .replace('href="/vite.svg"', 'href="./vite.svg"')
    .replace('href="/icon.png"', 'href="./icon.png"')
    .replace(
      '    <script type="module" src="/src/main.jsx"></script>',
      `${cssTag}    <script type="module" src="./${jsAssetPath}"></script>`,
    );

  fs.writeFileSync(path.join(distDir, 'index.html'), html, 'utf8');

  if (fs.existsSync(publicDir)) {
    for (const entry of fs.readdirSync(publicDir)) {
      copyRecursive(path.join(publicDir, entry), path.join(distDir, entry));
    }
  }
}

buildFrontend().catch((error) => {
  console.error(error);
  process.exit(1);
});

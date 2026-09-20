# GS Bot

GS Bot is an Electron desktop app for apparel operations workflows: web scraping, AI trend analysis, PPT deck generation, image organization, OCR rules, and PDF compression — all in a single local tool with optional local or cloud AI models.

## Main Workspaces

- `Scraper`: batch-scrape product assets and metadata from supported retail sites (Zara, Bershka, Stradivarius, and more).
- `Slides Maker`: generate style lookbook or fabric catalog PPT decks from organized image sets, with selectable themes and AI-written descriptions.
- `Bestseller Analysis`: scrape bestseller listings across brands and generate an AI trend report.
- `Image Organizer`: rename and group garment or fabric images from label photos.
- `Label OCR`: manage shared OCR label rules used by deck generation and image organization.
- `PDF Squeezer`: reduce PDF size by recompressing embedded images.

## Highlights

- **Flexible AI backends**: run fully local (Ollama) or connect cloud APIs (GLM / DeepSeek / Qwen presets). Configure once in Settings; every AI feature picks it up immediately.
- **Per-module model selection**: choose a specific model for each AI-powered module.
- **Automatic updates**: the app checks GitHub Releases on launch and offers one-click in-app updates (built on `electron-updater`).
- **Deterministic PPT layout engine**: flow-based text placement with theme support (classic / business / fashion / modern).

## Stack

- Electron main process: [main.js](main.js)
- Frontend: React 18 + esbuild bundle pipeline
- Desktop bridge: [preload.js](preload.js)
- Python utilities for slides, PDF, and garment processing
- Optional local model runtimes for RMBG, SegFormer, and OCR-related flows (onnxruntime-node)

## Scripts

- `npm run dev`: start the Vite dev server for frontend iteration.
- `npm run build`: build frontend assets into `dist/`.
- `npm run lint`: ESLint gate (undefined-reference checks).
- `npm run dist` or `npm run dist:mac`: build the macOS distribution.
- `npm run mac:local`: run the app locally on macOS.
- `npm run prepare:win-runtime`: prepare bundled Windows runtime assets.
- `npm run dist:win`: build the Windows installer and zip output.
- `npm run test:regression`: run the project regression checks.
- `npm run license:generate`: generate license keys from the CLI tool.
- `npm run license:gui`: open the Electron-based license generator.

## Project Layout

- [src/](src): React UI
- [scripts/](scripts): build and packaging scripts
- [docs/](docs): install and packaging notes
- [vendor/](vendor): bundled runtime assets (not committed)
- [python_vendor/](python_vendor): vendored Python packages for packaged flows
- `release/`: build outputs (not committed)

## Releases & Updates

Releases are published to [GitHub Releases](https://github.com/Jaylorandy/GS-BOT/releases). Each release ships the Windows installer plus `latest.yml`; installed apps poll the feed on startup and prompt to update.

## Local Requirements

- Node.js and npm
- Python 3 for Python-backed workflows in development
- Electron dependencies from `package-lock.json`
- Chrome or Chromium for scraping workflows
- Optional model files for RMBG 2.0 garment cutout, SegFormer garment-boundary refinement, and OCR runtimes

# Plan: Real liquid-glass-react, per-element, settings tabs, black-glass dark mode

## Your choices (confirmed)
- **Scope**: apply the SVG-displacement liquid glass to **all elements** (sidebar, header, module panels, nav buttons, and the card group across components).
- **Method**: `npm install liquid-glass-react` and use its real `<LiquidGlass>` component.
- **Settings**: move the glass tuning sliders out of the toolbar into a Settings page with a **tab switch: Ollama 设置 ⇄ 外观主题**.
- **Dark mode**: a black filter over all glass → "black glass" look.

## Two hard constraints you must know up front
1. **I cannot install or build/test this in my environment** — npm registry is blocked here (403). So **you run `npm install liquid-glass-react` and `npm run dist:mac` on your machine**, and report results. I write the code blind; you are the build/test loop. Expect 1–2 fix rounds.
2. **Performance**: you picked "all elements". The library puts an SVG filter + mousemove listener + ResizeObserver on every wrapped element — a busy page can hit 40+ instances. You've had low-spec Windows crashes before. So I will build in a **global on/off toggle** (in 外观主题 settings) and a CSS-only fallback, so you can dial it back without a rebuild if it stutters. Default ON per your choice.

## Implementation steps

### 1. Install (you do this)
`npm install liquid-glass-react` — adds it to package.json deps so the Windows/Mac builds bundle it.

### 2. `src/components/Glass.jsx` — thin wrapper (new)
- Wraps the library `<LiquidGlass>`; forwards `className`, `style`, `children`, `cornerRadius`.
- Reads a global enable flag from localStorage (`gsbot-glass-enabled`, default true) + listens for changes.
- Maps the existing tuning vars (blur/opacity/highlight from GlassControls) to the library props (`blurAmount`, `saturation`, `displacementScale`, `aberrationIntensity`, `elasticity`, `mode`).
- **Fallback**: if disabled (or lib mount fails), renders a plain `<div className=...>` so existing CSS glass still applies — zero visual breakage, no crash.

### 3. Wrap elements (per "all elements")
- **App.jsx shell**: sidebar, workspace-header, active module container, each nav button → `<Glass>`.
- **Card group** across components (ZaraScraper, SlidesMaker, BestsellerAnalysis, LLMConfigManager, ProductAnalysis): wrap the repeated cards. This is the large edit surface; done in passes, each pass independently buildable.
- Existing CSS `backdrop-filter`/`--glass-*` stays as the fallback layer under the wrapper.

### 4. Settings tabs (SetupGuide.jsx `renderStatusSurface`)
- Add a tab bar at the top: **Ollama 设置** | **外观主题**.
- `Ollama 设置` = current content (recommended modes, access, routing, logs).
- `外观主题` = the glass tuning sliders (the 3-layer blur/opacity/highlight panel) + global liquid-glass on/off toggle + Light/Dark theme toggle.
- Refactor `GlassControls` to add an `inline` mode (render sliders directly, no popover/trigger button) and render `<GlassControls inline />` in this tab.
- **Remove** `<GlassControls />` from the workspace toolbar (App.jsx).

### 5. Dark mode = black glass
- Add a `--glass-dark-veil` var: `0` in light theme, a black `rgba(0,0,0,~0.35)` overlay in dark theme.
- Apply it as an extra layer on the shell tint + panel/card/nav backgrounds, and pass a darker tint + lower brightness to the `<Glass>` wrapper when `data-theme` is dark.
- Wire it so toggling Light/Dark (existing mechanism) flips the glass between clear-frost and black-glass.

## Verification
- **I can't build here** (missing dep). After I write the code: you run `npm install liquid-glass-react` then `npm run dist:mac`.
- If the build errors on the import or a prop, paste the error — I fix and you rebuild.
- Watch CPU/fan on the busiest page (Bestseller + console). If it stutters, flip the 外观主题 → liquid glass OFF toggle (instant, no rebuild) and tell me; I'll trim scope to the ~8 big surfaces.

## Risk / rollback
- All glass goes through the `<Glass>` wrapper + the global toggle, so OFF instantly reverts to the current CSS glass everywhere.
- The library import is isolated to `Glass.jsx`; if it's ever removed, only that one file changes.

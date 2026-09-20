# Liquid Glass UI Conversion Plan

## Goal
Convert the whole app to an Apple "liquid glass" (Liquid Glass / visionOS-style) look:
translucent menu bar, background refraction, edge highlights, and enhanced hover
glow/sheen animations. Global scope, both dark and light themes.

## Confirmed scope (from user)
- **hover展开** = enhanced hover glow/sheen/scale animation (NOT a collapse-then-expand sidebar)
- **Apply globally** (sidebar + toolbar + all workspace panels + cards + buttons + modals)
- **Both dark and light themes**

## Key finding
The app already has a strong glass foundation in `src/App.css` (119 CSS variables,
`backdrop-filter: blur(...)` on sidebar/header/panels, animated `.app-shell::before/::after`
background glows, edge-highlight inset shadows, full dark/light theming via
`:root` / `:root[data-theme='light']`). So this is an **enhancement of the existing
variable system + a few new shared effect layers**, not a rewrite. Component CSS files
mostly already consume `var(--glass-bg)`, `var(--surface-*)`, etc., so they inherit
changes automatically — very low risk.

All work concentrates in **`src/App.css`** (the master theme file). No JSX changes
required; no component CSS rewrites required.

---

## Implementation steps (all in `src/App.css`)

### 1. Add liquid-glass design tokens to `:root` (dark) and `:root[data-theme='light']`
New variables (so everything is centralized + revertable):
- `--glass-refraction: blur(40px) saturate(180%) brightness(1.06)` (dark) /
  `blur(40px) saturate(160%) brightness(1.02)` (light) — the stronger frosted refraction
- `--glass-sheen`: top edge highlight gradient `linear-gradient(180deg, rgba(255,255,255,.22), transparent 40%)`
  (light theme uses a softer white sheen)
- `--glass-edge-highlight`: `inset 0 1px 0 rgba(255,255,255,.30), inset 0 0 0 1px rgba(255,255,255,.06)`
- `--glass-edge-shadow`: `inset 0 -1px 1px rgba(0,0,0,.18)` (gives the "lens" rounded-edge feel)
- `--glass-lift-shadow`: layered drop shadow for floating panels
- Slightly raise existing `--blur` (22→26px) and `--blur-heavy` (30→38px) for a glassier feel

### 2. Translucent menu bar (sidebar) — `.app-sidebar`
- Lower the sidebar surface opacity a touch and swap blur to `--glass-refraction`
- Add a `.app-sidebar::after` thin vertical right-edge **specular highlight** line
  (bright 1px gradient) for the "glass pane edge" effect
- Add the `--glass-sheen` top highlight overlay

### 3. Background refraction layer behind panels
- Strengthen `.app-shell::before` animated color blobs (the refraction source) — slightly
  higher opacity + slower drift so translucent panels visibly refract moving color behind them
- Add a subtle fine-grain noise/vignette via an extra cheap radial layer on `.app-shell::after`
  to read as "frosted glass over a textured backdrop"

### 4. Edge highlights + lens depth on all glass surfaces
Apply `--glass-edge-highlight` + `--glass-edge-shadow` to the shared surface classes already
present: `.app-sidebar`, `.workspace-header`, `.workspace-toolbar-cluster`, the workspace
panel containers (`.scraper-container, .slides-container, .analysis-container, .bestseller-container`,
etc.), and `.config-section/.mode-card/.stat-card` card group. These already share variables,
so this is editing a handful of rule blocks.

### 5. Enhanced hover glow / sheen animation (the "hover展开" interaction)
Add a reusable moving-sheen + lift on hover for interactive glass elements:
- `.nav-button:hover` — add a sweeping light sheen (`::after` translateX keyframe), a soft
  scale (1.0→1.015) + lift (translateY -1px), and an accent-tinted outer glow
- `.workspace-tool-button:hover`, `.theme-button:hover`, `.primary-button:hover`,
  `.nav-icon-shell` — same sheen sweep + brighter edge highlight on hover
- One shared `@keyframes glassSheen` (diagonal light sweep) reused via a helper selector group
- Respect `@media (prefers-reduced-motion: reduce)` — disable the sweep/scale, keep static glass

### 6. Modals / overlays (LicenseGate, SetupGuide, HelpManual, TaskCenter)
- Ensure overlay backdrops use the heavier `--glass-refraction` + a dimming scrim so dialogs
  read as floating glass slabs. These already use `--surface-*`; mostly verify + bump blur.

### 7. Light theme parity
Mirror every new token in `:root[data-theme='light']` with white-frost values (whiter sheen,
softer shadows, lower brightness boost) so light mode looks like frosted white glass, not gray.

---

## Verification
- `node scripts/build-frontend.js` (must compile clean — it's a Vite/esbuild CSS bundle)
- Visual check via Claude Preview MCP if a dev server is available; otherwise rebuild
  `npm run dist:mac` and eyeball: sidebar translucency, hover sheen on nav buttons, panel
  edge highlights, and toggle Light/Dark to confirm both themes.
- Confirm `prefers-reduced-motion` disables the animated sheen.

## Risk / rollback
- All changes are additive CSS variables + edits to existing rule blocks in one file.
- No JSX, no component-CSS rewrites, no logic changes.
- Revert = restore `src/App.css`. Low blast radius.

## Out of scope (not doing unless asked)
- Collapsing icon-only sidebar that expands on hover (user chose hover-glow instead)
- Rewriting individual component CSS files
- New dependencies / libraries

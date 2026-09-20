import js from '@eslint/js'
import globals from 'globals'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

// ─────────────────────────────────────────────────────────────
// Lint policy for GS Bot
//
// Rationale: this project has repeatedly shipped builds that crashed at
// runtime with "X is not defined" (setLayoutDraft, setParam, PoIconCheck,
// PoIconSave, PoIconSearch). esbuild does NOT resolve identifiers, so an
// undefined reference survives bundling and only explodes inside the packaged
// app. `no-undef` is the only rule in this config that catches that class of
// bug, so it stays an error and gates `npm run build`. Everything else is
// downgraded to warn/off so the signal stays readable.
// ─────────────────────────────────────────────────────────────

const IGNORED = [
  '**/node_modules/**',
  'dist/**',
  'release/**',
  'build-logs/**',
  '.tmp*/**',        // .tmp, .tmp-asar-inspect, .tmp-asar-verify, ...
  'tmp/**',
  'python_vendor/**',
  'vendor/**',
  '__pycache__/**',
  '**/._*',          // macOS AppleDouble junk that used to break parsing
  // Documentation/example snippet (mostly comment blocks + a stray `export {}`);
  // not referenced anywhere and not part of build.files.
  'firecrawl-integration-guide.js',
]

// Shared rules: "no undefined references, no parse errors, nothing else".
const BASE_RULES = {
  ...js.configs.recommended.rules,
  'no-undef': 'error',
  'no-unused-vars': 'warn',
  'no-empty': 'warn',
  'no-redeclare': 'warn',
  'no-irregular-whitespace': 'warn',
  'no-dupe-keys': 'warn',
  'no-useless-catch': 'warn',
  'no-useless-escape': 'off',
  'no-control-regex': 'off',
  'no-async-promise-executor': 'warn',
}

export default [
  { ignores: IGNORED },

  // ── Renderer (React) ──────────────────────────────────────
  {
    files: ['src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      globals: { ...globals.browser, ...globals.es2021 },
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    settings: { react: { version: '18.3' } },
    plugins: {
      react,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...BASE_RULES,
      ...react.configs.recommended.rules,
      ...react.configs['jsx-runtime'].rules,
      ...reactHooks.configs.recommended.rules,
      'react/prop-types': 'off',
      'react/no-unescaped-entities': 'off',
      'react/jsx-no-target-blank': 'off',
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },

  // ── Electron main process, scrapers, build scripts ────────
  // These files run in Node, but many of them embed `page.evaluate(...)`
  // callbacks whose body executes in the Chromium page (e.g. main.js alone has
  // ~400 `document`/`window` references inside such callbacks). Both global
  // sets are therefore provided. Custom identifiers are still checked, which
  // is what catches the crash-class bugs described above.
  {
    files: ['*.js', 'scripts/**/*.js', 'license-generator-app/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.browser, ...globals.es2021 },
    },
    rules: BASE_RULES,
  },

  // ── ESM config files ──────────────────────────────────────
  {
    files: ['vite.config.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node, ...globals.es2021 },
    },
    rules: BASE_RULES,
  },

  // ── Known non-module leftovers ────────────────────────────
  // `slides-ipc-handlers.js` is a "paste this into main.js" snippet: it has no
  // electron require and no module boundary, so it cannot be linted as a
  // module. main.js does not register any of its channels — it is obsolete.
  // Excluded (not deleted) until its removal is confirmed.
  {
    files: ['slides-ipc-handlers.js'],
    rules: { 'no-undef': 'off' },
  },
]

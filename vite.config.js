import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: './', // 这一行必须加，为了让 Electron 识别本地相对路径
  // src/utils/i18n.js 等 .js 文件内含 JSX。vite 6 的 esbuild 插件默认 exclude /\.js$/（JSX 只归 .jsx/.tsx），
  // plugin-react 5.x 的 babel 只做 fast-refresh 不再转 JSX → .js 里的 JSX 无人处理 → import-analysis 500。
  // 解法：把 .js 纳入 esbuild transform 范围（覆盖 include/exclude），统一用 jsx loader + automatic runtime。
  // 注意：vite 的 esbuild transform 是单 loader（字符串），map 形式 loader 会报 "loader must be a string"；
  // src 下无 .ts/.tsx，全 jsx loader 无副作用（纯 JS 原样输出）。
  esbuild: {
    include: /\.(m?[jt]sx?)$/,
    exclude: /\/node_modules\//,
    loader: 'jsx',
    jsx: 'automatic',
  },
  // 开发版「一直黑屏」的根因（2026-10-15 实测定位）：
  // 项目根堆着 10+ 个历史打包目录（release-build / release-build-207…212 等，
  // 合计 9 万+ 文件）。Vite 默认只忽略 node_modules/.git，chokidar 在 exFAT 上
  // 退化成疯狂轮询 → 主线程 100% 占用 → 连 `/` 都要 30s 才响应，Electron 等不到
  // 页面就停在 `[vite] connected.`（= 黑屏）。判据是「空闲也烧 CPU」：
  // 隔离实验 原配置 13.48s / watch:null 0.14s / 本配置 0.12s（12s 空闲窗口）。
  // 这些目录都是构建产物或参考素材，不含任何 HMR 需要的源码。
  server: {
    watch: {
      ignored: [
        '**/node_modules/**',
        '**/.git/**',
        '**/release/**',
        '**/release-build/**',
        '**/release-build-*/**',
        '**/build/**',
        '**/build-logs/**',
        '**/dist/**',
        '**/tmp/**',
        '**/docs/**',
        '**/python_vendor/**',
        '**/models/**',
        '**/vendor/**',
        '**/tools/**',
        '**/ref/**',
        '**/license-keys/**',
        '**/__pycache__/**',
      ],
    },
  },
})

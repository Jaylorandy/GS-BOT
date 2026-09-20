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
})

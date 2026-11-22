import { defineConfig } from 'electron-vite'

// Main and preload externalize node_modules by default. Everything the renderer uses
// (CodeMirror, KaTeX) is bundled by Vite, which is why those packages are devDependencies.
export default defineConfig({
  main: {},
  preload: {},
  renderer: {}
})

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  base: '/publicv3/',
  plugins: [vue(), tailwindcss()],
  build: { outDir: 'dist', emptyOutDir: true, assetsDir: 'assets' },
})

import { defineConfig } from 'vite';

// 輸出到 repo 根目錄的 play/，由 GitHub Pages 直接提供
export default defineConfig({
  base: './',
  build: { outDir: '../play', emptyOutDir: true, chunkSizeWarningLimit: 1200 },
  test: { include: ['tests/**/*.test.ts'] },
} as any);

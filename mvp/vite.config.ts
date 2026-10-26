import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// 版本號：package.json 的版本 + 建置時間（台灣時間），開始畫面與選單會顯示，用來確認手機上是不是最新版
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const t = new Date(Date.now() + 8 * 3600 * 1000).toISOString();
const build = t.slice(0, 10).replace(/-/g, '') + '.' + t.slice(11, 16).replace(':', '');

// 輸出到 repo 根目錄的 play/，由 GitHub Pages 直接提供
export default defineConfig({
  base: './',
  define: { __VERSION__: JSON.stringify('v' + pkg.version + ' · ' + build) },
  build: { outDir: '../play', emptyOutDir: true, chunkSizeWarningLimit: 1200 },
  test: { include: ['tests/**/*.test.ts'] },
} as any);

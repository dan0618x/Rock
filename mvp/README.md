# 殘域 MVP

拾荒者內戰・對電腦。用來驗證「在手機上打這款 RTS 好不好操作、好不好玩」。

- 試玩：https://dan0618x.github.io/Rock/play/
- 設計與規劃：見設計總表與開發計畫文件

## 結構

```
src/sim/     模擬核心：固定每秒 20 步、整數運算、可重現（禁止引用 client、bot）
src/bot/     電腦對手：只透過指令操作，只看得到迷霧外的東西
src/client/  畫面（PixiJS）、HUD、手勢、音效
tests/       規則、決定性、相剋、電腦互打
tools/       botmatch.ts（電腦互打統計）、symcheck.ts（鏡像對稱檢查）、ui-smoke.cjs（介面冒煙測試）
```

## 指令

```
npm install
npm run dev        # 開發
npm test           # 自動測試
npm run build      # 輸出到 ../play/
npx vite-node tools/botmatch.ts 20   # 電腦互打 20 場
```

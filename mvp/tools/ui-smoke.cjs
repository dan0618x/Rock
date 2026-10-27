// 介面冒煙測試：用手機橫屏尺寸跑一輪主要操作。先 npm run build && npx vite preview，再 node tools/ui-smoke.cjs [網址]
const { chromium } = require('playwright');
const SP = (process.env.OUT || '.');
(async () => {
  const b = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
  const ctx = await b.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto((process.argv[2] || 'http://localhost:4173/'), { waitUntil: 'networkidle' });
  await p.waitForTimeout(500);
  await p.screenshot({ path: SP + '/m6-intro.png' });
  await p.tap('[data-open="helpSheet"]');
  await p.waitForTimeout(200);
  await p.screenshot({ path: SP + '/m6-help.png' });
  await p.tap('#helpSheet [data-close="helpSheet"]');
  await p.tap('#btnGo');
  await p.evaluate(() => { window.__auto = new window.__rts.Bot(0); window.__rts.ff(240, window.__auto); });
  await p.waitForTimeout(300);
  // 全部部隊 → 攻擊 → 點地面
  await p.tap('#btnArmy');
  await p.waitForTimeout(400);
  await p.screenshot({ path: SP + '/m6-army.png' });
  await p.tap('#cmdArea .btn[aria-label="攻擊"]');
  await p.waitForTimeout(200);
  const on = await p.$eval('#cmdArea .btn[aria-label="攻擊"]', e => e.classList.contains('on'));
  console.log('attack on', on);
  await p.touchscreen.tap(600, 200);
  await p.waitForTimeout(200);
  const orders = await p.evaluate(() => { const g = window.__rts.st.g; return [...window.__rts.st.sel].map(id => g.byId.get(id)?.order.k).join(','); });
  console.log('orders after ground tap', orders);
  // 存入編隊 1
  await p.tap('#slots .slot >> nth=0');
  await p.waitForTimeout(400);
  console.log('slot1', await p.$eval('#slots .slot >> nth=0', e => e.textContent));
  // 長按圈選：先取消選取，然後在主堡附近按住
  await p.tap('#btnClear');
  const s = await p.evaluate(() => { const R = window.__rts, e = R.st.g.ents.find(e => e.team === 0 && e.type === 'worker'); R.cam.x = e.x / 16; R.cam.y = e.y / 16; return R.w2s(e.x / 16, e.y / 16); });
  const cdp = await ctx.newCDPSession(p);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: s.x, y: s.y }] });
  await p.waitForTimeout(1200);
  await p.screenshot({ path: SP + '/m6-circle.png' });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await p.waitForTimeout(200);
  console.log('circle selected', await p.evaluate(() => window.__rts.st.sel.size));
  // 選單 → 投降 → 結算
  await p.tap('#btnSet');
  await p.waitForTimeout(200);
  await p.screenshot({ path: SP + '/m6-menu.png' });
  await p.tap('#btnSurrender');
  await p.waitForTimeout(600);
  await p.screenshot({ path: SP + '/m6-end.png' });
  console.log('end visible', await p.$eval('#endSheet', e => !e.hidden));
  await p.tap('#btnAgain');
  await p.waitForTimeout(300);
  console.log('restarted tick', await p.evaluate(() => window.__rts.st.g.tick));
  console.log(errs.join('\n') || 'no errors');
  await b.close();
})();

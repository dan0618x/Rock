// 戰場繪製（PixiJS）：只讀模擬狀態，位置在兩個邏輯步之間補間。
import { Application, Assets, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import { MINE_CAP, PROD, PUMP, TY } from '../sim/data';
import { S as SUB } from '../sim/math';
import { GH, GW } from '../sim/nav';
import { builderOf, isAir, isB, isRes, minersOf, placeCheck, plannedSites, visibleAt } from '../sim/sim';
import type { Ent } from '../sim/types';
import { ME, W, H, cam, st, view, now } from './state';

export const C = {
  ally: 0x62b4ff, enemy: 0xff6e5c, scrap: 0xc9a172, gas: 0xcfe06a, accent: 0xe3a948,
  ok: 0x86d67f, bad: 0xff7b6b, fg: 0xece6d6, dim: 0xa29c8a, dark: 0x1d221b,
};
const FONT = '"Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif';

let app: Application;
const world = new Container();
const L = {
  ground: new Sprite(), res: new Container(), under: new Graphics(), bld: new Container(), gnd: new Container(),
  shots: new Graphics(), airShadow: new Graphics(), air: new Container(), fog: new Sprite(), over: new Graphics(), texts: new Container(),
};
const screen = new Graphics();

interface View { root: Container; body: Graphics; label: Text; extra?: Graphics; turn?: Container; ghost?: boolean }

/** 單位圖：朝上、錨點在身體中心；body = 身體寬佔圖寬的比例，k = 身體畫成碰撞直徑的幾倍 */
const ART: Record<string, { body: number; k: number }> = {
  worker: { body: 0.412, k: 1.56 }, // 人操作機器，畫得比槍兵大約 1.25 倍，碰撞大小不變
  rifle: { body: 0.355, k: 1.15 },
  srocket: { body: 0.362, k: 1.15 },
  heavy: { body: 0.659, k: 1.15 },
  turbo: { body: 0.318, k: 1 },
};
const tex: Record<string, Texture> = {};
const views = new Map<number, View>();
const ghostViews = new Map<number, View>();
const status = new Map<number, Text>();

let fogCanvas: HTMLCanvasElement, fogCtx: CanvasRenderingContext2D, fogImg: ImageData, fogTex: Texture, fogTick = -1;

export async function initRender(canvas: HTMLCanvasElement) {
  app = new Application();
  await app.init({
    canvas, background: 0x0c0e0b, antialias: true, autoStart: false, autoDensity: true,
    resolution: Math.min(2, window.devicePixelRatio || 1), width: window.innerWidth, height: window.innerHeight,
  });
  app.ticker.stop();
  // 單位圖載不到就照舊畫幾何圖形
  await Promise.all(Object.keys(ART).map(async k => { try { tex[k] = await Assets.load('art/units/' + k + '.webp'); } catch { /* 沿用幾何圖形 */ } }));
  app.stage.addChild(world, screen);
  world.addChild(L.ground, L.res, L.under, L.bld, L.gnd, L.shots, L.airShadow, L.air, L.fog, L.over, L.texts);
  drawGround();
  fogCanvas = document.createElement('canvas');
  fogCanvas.width = GW; fogCanvas.height = GH;
  fogCtx = fogCanvas.getContext('2d')!;
  fogImg = fogCtx.createImageData(GW, GH);
  fogTex = Texture.from(fogCanvas);
  L.fog.texture = fogTex;
  L.fog.width = GW * 40; L.fog.height = GH * 40;
}

export function resizeRender(w: number, h: number) {
  app.renderer.resize(w, h);
}

/** 地面一次畫進一張貼圖（半解析度），每幀只畫一個四邊形 */
function drawGround() {
  const k = 0.5, cv = document.createElement('canvas');
  cv.width = W * k; cv.height = H * k;
  const c = cv.getContext('2d')!;
  c.scale(k, k);
  c.fillStyle = '#343f2f';
  c.fillRect(0, 0, W, H);
  let sd = 7;
  const rnd = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 140; i++) {
    const d = rnd() < 0.55;
    c.fillStyle = d ? 'rgba(20,28,18,.28)' : 'rgba(120,130,90,.07)';
    c.beginPath(); c.arc(rnd() * W, rnd() * H, 60 + rnd() * 180, 0, 7); c.fill();
  }
  c.fillStyle = 'rgba(207,224,106,.04)';
  for (let i = 0; i < 80; i++) { c.beginPath(); c.arc((i * 397) % W, (i * 251) % H, 70, 0, 7); c.fill(); }
  c.strokeStyle = 'rgba(255,255,255,.05)';
  c.lineWidth = 2;
  c.beginPath();
  for (let x = 0; x <= W; x += 200) { c.moveTo(x, 0); c.lineTo(x, H); }
  for (let y = 0; y <= H; y += 200) { c.moveTo(0, y); c.lineTo(W, y); }
  c.stroke();
  c.strokeStyle = 'rgba(236,226,196,.3)';
  c.lineWidth = 6;
  c.strokeRect(0, 0, W, H);
  L.ground.texture = Texture.from(cv);
  L.ground.width = W;
  L.ground.height = H;
}

/** 建築外形：圓角方塊，角落不超出碰撞圓太多，相鄰建築看起來不會重疊 */
const bldShape = (g: Graphics, x: number, y: number, r: number) => { const h = r * 0.86; return g.roundRect(x - h, y - h, h * 2, h * 2, r * 0.3); };

/** 單位圖放進一個會轉向的容器；圖朝上，容器的 0 度朝右，所以圖先轉 90 度 */
function artTurn(type: string, r: number) {
  const a = ART[type], sp = new Sprite(tex[type]), turn = new Container();
  sp.anchor.set(0.5);
  sp.width = sp.height = (r * 2 * a.k) / a.body;
  sp.rotation = Math.PI / 2;
  turn.addChild(sp);
  return turn;
}

const mkLabel = (ch: string, size: number, color: number) => {
  const t = new Text({ text: ch, style: { fontFamily: FONT, fontSize: Math.round(size), fontWeight: '700', fill: color } });
  t.anchor.set(0.5);
  t.resolution = 3;
  return t;
};

function makeView(e: Ent, ghost = false): View {
  const T = TY[e.type], r = e.r / SUB;
  const root = new Container(), body = new Graphics();
  const col = e.team === ME ? C.ally : C.enemy;
  let label: Text;
  if (isRes(e)) {
    for (const [ox, oy, s, c] of [[-9, 4, 12, 0x8f7556], [6, -5, 13, C.scrap], [4, 8, 9, 0xa88a63], [-3, -9, 8, 0x7a6550]])
      body.poly([ox - s, oy, ox - s * 0.3, oy - s * 0.8, ox + s, oy - s * 0.3, ox + s * 0.6, oy + s * 0.6]).fill(c);
    label = mkLabel('', 10, 0);
    root.addChild(body);
    L.res.addChild(root);
    return { root, body, label };
  }
  if (isB(e)) {
    bldShape(body, 0, 0, r).fill(0x22261e).stroke({ width: 3, color: col });
    label = mkLabel(T.ch, r * 0.85, col);
    root.addChild(body, label);
    if (ghost) root.alpha = 0.45;
    L.bld.addChild(root);
    return { root, body, label, ghost };
  }
  if (tex[e.type] && !ghost) {
    // 隊伍色只畫在底圈，圖本身是中性色；底圈跟著圖的身體大小，才不會被圖蓋住
    body.circle(0, 0, r * ART[e.type].k * 1.05).fill({ color: col, alpha: 0.28 }).stroke({ width: 2.5, color: col });
    const turn = artTurn(e.type, r);
    label = mkLabel('', 10, 0);
    const extra = new Graphics();
    extra.circle(r * 0.7, -r * 0.7, 4).fill(C.scrap);
    extra.visible = false;
    root.addChild(body, turn, extra);
    (isAir(e) ? L.air : L.gnd).addChild(root);
    return { root, body, label, extra, turn };
  }
  if (isAir(e)) {
    const turn = new Container();
    body.poly([r * 1.25, 0, -r * 0.85, r * 0.95, -r * 0.35, 0, -r * 0.85, -r * 0.95]).fill(C.dark).stroke({ width: 2.5, color: col });
    turn.addChild(body);
    label = mkLabel(T.ch, r * 0.8, col);
    label.x = -2;
    root.addChild(turn, label);
    L.air.addChild(root);
    return { root, body, label, turn };
  }
  body.circle(0, 0, r).fill(C.dark).stroke({ width: 2.5, color: col });
  label = mkLabel(T.ch, r * 1.05, col);
  const extra = new Graphics();
  extra.circle(r * 0.7, -r * 0.7, 4).fill(C.scrap);
  extra.visible = false;
  root.addChild(body, label, extra);
  L.gnd.addChild(root);
  return { root, body, label, extra };
}

function setStatus(id: number, text: string, x: number, y: number, color: number, size = 12) {
  let t = status.get(id);
  if (!text) { if (t) t.visible = false; return; }
  if (!t) { t = mkLabel(text, size, color); L.texts.addChild(t); status.set(id, t); }
  if (t.text !== text) t.text = text;
  if (t.style.fill !== color) t.style.fill = color;
  t.visible = true;
  t.x = x; t.y = y;
}

function updateFog() {
  const g = st.g;
  if (fogTick === g.tick) return;
  fogTick = g.tick;
  const f = g.fog[ME], d = fogImg.data;
  for (let i = 0; i < GW * GH; i++) {
    const a = f.vis[i] ? 0 : f.exp[i] ? 140 : 225;
    d[i * 4] = 8; d[i * 4 + 1] = 10; d[i * 4 + 2] = 7; d[i * 4 + 3] = a;
  }
  fogCtx.putImageData(fogImg, 0, 0);
  fogTex.source.update();
}

/** 敵方建築：看得到就記住；記住的位置現在看得到但建築不在了，就忘掉 */
function updateGhosts() {
  const g = st.g;
  for (const e of g.ents) if (e.team !== ME && e.team >= 0 && isB(e) && visibleAt(g, ME, e.x, e.y)) st.ghosts.set(e.id, { type: e.type, x: e.x, y: e.y, r: e.r });
  for (const [id, gh] of st.ghosts) {
    const e = g.byId.get(id);
    if ((!e || e.dead) && visibleAt(g, ME, gh.x, gh.y)) st.ghosts.delete(id);
  }
}

export function inView(xpx: number, ypx: number) {
  const p = w2s(xpx, ypx);
  return p.x >= 0 && p.y >= 0 && p.x <= view.w && p.y <= view.h;
}
export const w2s = (x: number, y: number) => ({ x: (x - cam.x) * cam.z + view.w / 2, y: (y - cam.y) * cam.z + view.h / 2 });
export const s2w = (sx: number, sy: number) => ({ x: (sx - view.w / 2) / cam.z + cam.x, y: (sy - view.h / 2) / cam.z + cam.y });

export function draw(alpha: number, circle: { sx: number; sy: number; r: number } | null) {
  const g = st.g;
  world.scale.set(cam.z);
  world.position.set(view.w / 2 - cam.x * cam.z, view.h / 2 - cam.y * cam.z);
  updateFog();
  updateGhosts();
  const ip = (e: Ent) => ({ x: (e.px + (e.x - e.px) * alpha) / SUB, y: (e.py + (e.y - e.py) * alpha) / SUB });
  const seen = new Set<number>();
  const under = L.under.clear(), over = L.over.clear(), shots = L.shots.clear(), shadow = L.airShadow.clear();
  const t = now();
  // 實體
  for (const e of g.ents) {
    const vis = e.team === ME || isRes(e) || visibleAt(g, ME, e.x, e.y);
    if (!vis) continue;
    seen.add(e.id);
    let v = views.get(e.id);
    if (!v) { v = makeView(e); views.set(e.id, v); }
    const p = ip(e), r = e.r / SUB;
    v.root.x = p.x; v.root.y = p.y;
    if (isRes(e)) { v.root.alpha = 0.5 + (0.5 * e.amt) / 1500; continue; }
    if (isB(e)) {
      v.root.alpha = e.built ? 1 : 0.55;
      if (!e.built) {
        const paused = e.team === ME && !builderOf(g, e);
        over.arc(p.x, p.y, r + 8, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * e.prog) / (TY[e.type].bt! * 20)).stroke({ width: 4, color: paused ? C.dim : C.accent });
        setStatus(e.id, paused ? '暫停' : '', p.x, p.y - r - 14, C.dim);
      } else if (e.team === ME) {
        let s = '';
        const q = e.q[0];
        if (e.type === 'base') s = 'Lv' + g.teams[ME].baseLv + '・工 ' + minersOf(g, e) + '/' + MINE_CAP;
        if (q) {
          const name = q.kind === 'unit' ? TY[q.type!].ch : q.kind === 'upg' ? '升級' : '擴建';
          s = (s ? s + '\n' : '') + name + (e.q.length > 1 ? ' +' + (e.q.length - 1) : '') + (e.loop ? ' ∞' : '');
          const bw = r * 1.6, by = p.y + r + 8;
          over.rect(p.x - bw / 2, by, bw, 5).fill({ color: 0x000000, alpha: 0.6 });
          over.rect(p.x - bw / 2, by, (bw * q.t) / q.total, 5).fill(C.accent);
        } else if (e.loop) s = (s ? s + '\n' : '') + '∞ ' + TY[e.loop].name;
        if (e.type === 'pump') s = '+' + (e.rate / 1000).toFixed(1) + '/s';
        setStatus(e.id, s, p.x, p.y + r + (q ? 26 : 14), e.type === 'pump' ? C.gas : C.dim, 11);
      } else setStatus(e.id, '', 0, 0, 0);
    } else {
      if (isAir(e)) {
        v.root.y = p.y - 6;
        shadow.ellipse(p.x + 6, p.y + 14, r * 0.9, r * 0.45).fill({ color: 0x000000, alpha: 0.3 });
      } else if (v.extra) v.extra.visible = e.carry > 0;
      if (v.turn) v.turn.rotation = turnToward(v.turn.rotation, Math.atan2(e.fy, e.fx));
      v.body.alpha = 1;
    }
    // 彈道
    if (g.tick - e.shotAt <= 2) {
      const tg = g.byId.get(e.shotTid);
      if (tg) {
        const q = ip(tg);
        const a = 1 - (g.tick - e.shotAt + alpha) / 3;
        const heavy = e.type === 'srocket' || e.type === 'heavy';
        shots.moveTo(p.x, p.y - (isAir(e) ? 6 : 0)).lineTo(q.x, q.y - (isAir(tg) ? 6 : 0)).stroke({ width: heavy ? 3 : 1.5, color: e.team === ME ? C.ally : C.enemy, alpha: Math.max(0, a) });
      }
    }
    // 選取圈與血條
    const sel = st.sel.has(e.id);
    if (sel) {
      const oy = isB(e) ? 0 : r * 0.5 + (isAir(e) ? 10 : 0);
      under.ellipse(p.x, p.y + oy, r + 5, (r + 5) * (isB(e) ? 1 : 0.55)).stroke({ width: 2, color: C.ok });
    }
    if (sel || e.hp < e.maxHp) {
      const w = r * 2, f = Math.max(0, e.hp / e.maxHp), oy = isAir(e) ? 6 : 0;
      over.rect(p.x - w / 2, p.y - r - 12 - oy, w, 5).fill({ color: 0x000000, alpha: 0.6 });
      over.rect(p.x - w / 2, p.y - r - 12 - oy, w * f, 5).fill(f > 0.5 ? C.ok : f > 0.25 ? C.accent : C.bad);
    }
    if (sel && isB(e)) {
      if (e.type === 'turret') under.circle(p.x, p.y, TY.turret.range!).stroke({ width: 1.5, color: C.ally, alpha: 0.25 });
      if (e.rally && PROD[e.type]) {
        const rx = e.rally.x / SUB, ry = e.rally.y / SUB;
        dashed(under, p.x, p.y, rx, ry, C.accent, 2);
        under.circle(rx, ry, 5).fill(C.accent);
      }
    }
  }
  // 記住的敵方建築
  for (const [id, gh] of st.ghosts) {
    if (seen.has(id)) { const v = ghostViews.get(id); if (v) { v.root.destroy({ children: true }); ghostViews.delete(id); } continue; }
    let v = ghostViews.get(id);
    if (!v) { v = makeView({ type: gh.type, team: 1, r: gh.r } as Ent, true); ghostViews.set(id, v); }
    v.root.x = gh.x / SUB; v.root.y = gh.y / SUB;
  }
  for (const [id, v] of ghostViews) if (!st.ghosts.has(id)) { v.root.destroy({ children: true }); ghostViews.delete(id); }
  for (const [id, v] of views) if (!seen.has(id)) { v.root.destroy({ children: true }); views.delete(id); }
  for (const [id, s] of status) {
    if (id < 0) continue;
    if (!g.byId.get(id)) { s.destroy(); status.delete(id); } else if (!seen.has(id)) s.visible = false;
  }

  // 抽氣塔範圍
  const placing = st.mode && st.mode.k === 'place' ? st.mode : null;
  const showPump = (placing && placing.type === 'pump') || [...st.sel].some(id => g.byId.get(id)?.type === 'pump');
  if (showPump) for (const b of g.ents) if (b.team === ME && b.type === 'pump') under.circle(b.x / SUB, b.y / SUB, PUMP.radius).stroke({ width: 1.5, color: C.gas, alpha: 0.35 });
  // 已確認、還沒開工的建築：灰色預覽
  for (const p of plannedSites(g, ME)) {
    const r = TY[p.type].r;
    bldShape(over, p.x, p.y, r).fill({ color: 0x8a8a8a, alpha: 0.3 }).stroke({ width: 2, color: 0x9a9a9a, alpha: 0.8 });
  }
  // 放置中的半透明建築
  if (placing) {
    const T = TY[placing.type], r = T.r;
    const ck = placeCheck(g, ME, placing.type, Math.round(placing.x), Math.round(placing.y));
    const col = ck.ok ? C.ok : C.bad;
    if (placing.type === 'pump') {
      under.circle(placing.x, placing.y, PUMP.radius).stroke({ width: 1.5, color: C.gas, alpha: 0.55 });
      let n = 0;
      for (const o of g.ents) if (o.team === ME && o.type === 'pump' && (o.x / SUB - placing.x) ** 2 + (o.y / SUB - placing.y) ** 2 < (PUMP.radius * 2) ** 2) n++;
      setStatus(-1, n ? '與 ' + n + ' 座重疊：產量 -' + Math.min(80, 40 * n) + '%' : '', placing.x, placing.y - r - 26, C.bad);
    } else setStatus(-1, '', 0, 0, 0);
    bldShape(over, placing.x, placing.y, r).fill({ color: 0x22261e, alpha: 0.5 }).stroke({ width: 3, color: col });
    setStatus(-2, T.ch, placing.x, placing.y, col, Math.round(r * 0.85));
    setStatus(-3, ck.ok ? '' : ck.why, placing.x, placing.y + r + 16, C.bad);
  } else { setStatus(-1, '', 0, 0, 0); setStatus(-2, '', 0, 0, 0); setStatus(-3, '', 0, 0, 0); }
  // 特效
  st.fx = st.fx.filter(f => t - f.t0 < (f.kind === 'boom' ? 450 : 600));
  for (const f of st.fx) {
    if (f.kind === 'boom') { const k = (t - f.t0) / 450; over.circle(f.x, f.y, f.r * (0.4 + k * 0.6)).stroke({ width: 3, color: f.c, alpha: 1 - k }); }
    else { const k = (t - f.t0) / 600; over.circle(f.x, f.y, f.r + 18 * (1 - k) + 6).stroke({ width: 3, color: f.c, alpha: 1 - k }); }
  }
  screen.clear();
  if (circle) screen.circle(circle.sx, circle.sy, circle.r).fill({ color: C.ok, alpha: 0.12 }).stroke({ width: 2, color: C.ok });
  app.render();
}

/** 轉向補間：每幀往目標角度轉一部分，走最短的方向 */
function turnToward(a: number, b: number) {
  let d = b - a;
  d -= Math.round(d / (Math.PI * 2)) * Math.PI * 2;
  return Math.abs(d) < 0.01 ? b : a + d * 0.3;
}

function dashed(g: Graphics, x1: number, y1: number, x2: number, y2: number, color: number, width: number) {
  const d = Math.hypot(x2 - x1, y2 - y1), n = Math.max(1, Math.floor(d / 14));
  for (let i = 0; i < n; i += 1) {
    if (i % 2) continue;
    const a = i / n, b = Math.min(1, (i + 1) / n);
    g.moveTo(x1 + (x2 - x1) * a, y1 + (y2 - y1) * a).lineTo(x1 + (x2 - x1) * b, y1 + (y2 - y1) * b);
  }
  g.stroke({ width, color });
}


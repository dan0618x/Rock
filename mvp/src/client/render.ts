// 戰場繪製（PixiJS）：半 2D 斜俯視。只讀模擬狀態，位置在兩個邏輯步之間補間。
//
// 座標：模擬是正上方看的平面 (x, y)。畫面把地面在垂直方向壓扁成 K 倍（鏡頭斜 48 度往下看），
// 建築與單位則「站」在地面上、往上長高，越下面（越靠近鏡頭）的蓋在越上面。
//  - 地面圖層（地表、底圈、範圍、迷霧、標記）：容器 y 方向縮放 K，子物件直接用 (x, y)
//  - 物件圖層（建築、單位、血條、文字）：容器等比縮放，子物件放在 (x, y*K)，再往上畫高度
// 單位只有四個方向（右下、右上，往左的兩個用左右鏡像）：右下用「斜前方」、右上用「斜後方」。
import { Application, Assets, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import { MINE_CAP, PROD, PUMP, TY, type TypeId } from '../sim/data';
import { TERRAIN } from '../sim/map';
import { S as SUB } from '../sim/math';
import { GH, GW } from '../sim/nav';
import { builderOf, isAir, isB, isRes, minersOf, placeCheck, plannedSites, visibleAt } from '../sim/sim';
import type { Ent } from '../sim/types';
import { ME, W, H, cam, st, view, now } from './state';

/** 地面垂直壓縮比（sin 48.6°） */
export const K = 0.75;
/** 空軍離地高度（畫面像素，物件座標） */
const FLY = 34;

export const C = {
  ally: 0x62b4ff, enemy: 0xff6e5c, scrap: 0xc9a172, gas: 0xcfe06a, accent: 0xe3a948,
  ok: 0x86d67f, bad: 0xff7b6b, fg: 0xece6d6, dim: 0xa29c8a, dark: 0x1d221b,
};
const FONT = '"Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif';

let app: Application;
const groundW = new Container(), objW = new Container(), fogW = new Container(), markW = new Container(), overW = new Container();
const L = {
  ground: new Sprite(), under: new Graphics(), shadow: new Graphics(), plan: new Graphics(),
  obj: new Container(), shots: new Graphics(), air: new Container(),
  fog: new Sprite(), marks: new Graphics(), over: new Graphics(), texts: new Container(),
};
const screen = new Graphics();
/** 放置模式的半透明建築 */
const placeGhost = new Graphics();

interface View { root: Container; fig: Container; label?: Text; dx: number; front: boolean; key: string; ghost?: boolean }

/** 單位圖（之後生成）：art/units/<兵種>_front.webp（朝右下）與 _back.webp（朝右上）；往左用鏡像 */
const art: Partial<Record<TypeId, { front: Texture; back: Texture }>> = {};
/** 建築圖（之後生成）：art/buildings/<建築>.webp，斜前方一張 */
const bart: Partial<Record<TypeId, Texture>> = {};
const views = new Map<number, View>();
const ghostViews = new Map<number, View>();
const status = new Map<number, Text>();

let fogCtx: CanvasRenderingContext2D, fogImg: ImageData, fogTex: Texture, fogTick = -1;

async function tryLoad(url: string): Promise<Texture | null> {
  try { return await Assets.load(url); } catch { return null; }
}

export async function initRender(canvas: HTMLCanvasElement) {
  app = new Application();
  await app.init({
    canvas, background: 0x0c0e0b, antialias: true, autoStart: false, autoDensity: true,
    resolution: Math.min(2, window.devicePixelRatio || 1), width: window.innerWidth, height: window.innerHeight,
  });
  app.ticker.stop();
  // 有圖就用圖，沒有就畫佔位圖形
  const units: TypeId[] = ['worker', 'rifle', 'srocket', 'heavy', 'biker', 'walker', 'jetpack', 'turbo', 'glider', 'divebomber'];
  const blds: TypeId[] = ['base', 'barracks', 'airbase', 'lab', 'turret', 'pump'];
  await Promise.all([
    ...units.map(async t => {
      const [f, b] = await Promise.all([tryLoad('art/units/' + t + '_front.webp'), tryLoad('art/units/' + t + '_back.webp')]);
      if (f && b) art[t] = { front: f, back: b };
    }),
    ...blds.map(async t => { const x = await tryLoad('art/buildings/' + t + '.webp'); if (x) bart[t] = x; }),
  ]);
  L.obj.sortableChildren = true;
  L.air.sortableChildren = true;
  groundW.addChild(L.ground, L.under, L.shadow, L.plan);
  objW.addChild(L.obj, L.shots, L.air);
  fogW.addChild(L.fog);
  markW.addChild(L.marks);
  overW.addChild(L.over, placeGhost, L.texts);
  app.stage.addChild(groundW, objW, fogW, markW, overW, screen);
  drawGround();
  const fc = document.createElement('canvas');
  fc.width = GW; fc.height = GH;
  fogCtx = fc.getContext('2d')!;
  fogImg = fogCtx.createImageData(GW, GH);
  fogTex = Texture.from(fc);
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
  drawTerrain(c);
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

/**
 * 地形畫在地面貼圖上（之後整張會被壓扁成 K 倍）。
 * 岩石做出高度：先畫往下偏移的暗色側面，再畫亮色頂面；酸池是暗綠色、邊緣發光。
 */
function drawTerrain(c: CanvasRenderingContext2D) {
  let sd = 11;
  const rnd = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
  for (const t of TERRAIN) {
    if (t.kind !== 'acid') continue;
    const g = c.createRadialGradient(t.x, t.y, t.r * 0.2, t.x, t.y, t.r * 1.15);
    g.addColorStop(0, 'rgba(40,70,30,1)'); g.addColorStop(0.8, 'rgba(60,95,35,1)'); g.addColorStop(0.92, 'rgba(207,224,106,.55)'); g.addColorStop(1, 'rgba(207,224,106,0)');
    c.fillStyle = g;
    c.beginPath(); c.arc(t.x, t.y, t.r * 1.15, 0, 7); c.fill();
  }
  const rocks = TERRAIN.filter(t => t.kind === 'rock');
  const lift = 30 / K; // 岩石高約 30 像素
  c.fillStyle = 'rgba(0,0,0,.35)';
  for (const t of rocks) { c.beginPath(); c.arc(t.x + 8, t.y + 10, t.r * 1.02, 0, 7); c.fill(); }
  c.fillStyle = '#2e2a23';
  for (const t of rocks) { c.beginPath(); c.arc(t.x, t.y, t.r, 0, 7); c.fill(); }
  for (const t of rocks) {
    for (let i = 0; i < 4; i++) {
      const a = rnd() * 6.28, d = t.r * 0.25 * rnd(), rr = t.r * (0.72 + rnd() * 0.3);
      c.fillStyle = i % 2 ? '#4b4438' : '#575043';
      c.beginPath(); c.arc(t.x + Math.cos(a) * d, t.y - lift + Math.sin(a) * d, rr, 0, 7); c.fill();
    }
  }
  c.fillStyle = 'rgba(236,226,196,.10)';
  for (const t of rocks) { c.beginPath(); c.arc(t.x - t.r * 0.25, t.y - lift - t.r * 0.3, t.r * 0.45, 0, 7); c.fill(); }
}

const mkLabel = (ch: string, size: number, color: number) => {
  const t = new Text({ text: ch, style: { fontFamily: FONT, fontSize: Math.round(size), fontWeight: '700', fill: color } });
  t.anchor.set(0.5);
  t.resolution = 3;
  return t;
};

// ---------- 尺寸 ----------
/** 建築：佔地半寬、牆高 */
const bldHs = (r: number) => r * 0.86;
const bldH = (type: TypeId, r: number) => r * (type === 'base' ? 0.95 : type === 'turret' || type === 'pump' ? 1.1 : 0.7);
/** 單位：身高（腳到頭頂） */
const unitH = (type: TypeId, r: number) => r * (type === 'heavy' || type === 'walker' ? 2.0 : type === 'biker' ? 1.5 : 2.2);
/** 實體在物件座標中的畫面中心與頂端（點選、血條、彈道用） */
function bodyOf(type: TypeId, r: number, ox: number, oy: number) {
  if (TY[type].cat === 'building') { const hs = bldHs(r), h = bldH(type, r); return { cx: ox, cy: oy - h / 2, top: oy - hs * K - h, r: hs }; }
  if (TY[type].cat === 'res') return { cx: ox, cy: oy - 6, top: oy - 16, r };
  if (TY[type].cat === 'air') return { cx: ox, cy: oy - FLY, top: oy - FLY - r, r };
  const h = unitH(type, r);
  return { cx: ox, cy: oy - h * 0.5, top: oy - h, r: Math.max(r, h * 0.45) };
}

// ---------- 佔位圖形（還沒有正式美術時） ----------
/** 半 2D 建築：亮色頂面 + 暗色正面，隊伍色描邊 */
function drawBuilding(g: Graphics, type: TypeId, r: number, col: number, alpha = 1) {
  const hs = bldHs(r), h = bldH(type, r), d = hs * K;
  g.clear();
  // 正面：牆、接縫、門
  g.rect(-hs, d - h, hs * 2, h).fill({ color: 0x3a3a30, alpha }).stroke({ width: 2, color: col, alpha: alpha * 0.8 });
  for (let i = 1; i < 4; i++) g.moveTo(-hs + (hs * 2 * i) / 4, d - h).lineTo(-hs + (hs * 2 * i) / 4, d).stroke({ width: 1, color: 0x26261f, alpha });
  g.rect(-hs * 0.22, d - h * 0.62, hs * 0.44, h * 0.62).fill({ color: 0x1b1c17, alpha });
  g.rect(-hs, d - h, hs * 2, Math.max(3, h * 0.12)).fill({ color: 0xc8a13a, alpha: 0.55 * alpha });
  g.roundRect(-hs, -d - h, hs * 2, d * 2, r * 0.12).fill({ color: 0x4a4c40, alpha }).stroke({ width: 2.5, color: col, alpha });
  g.roundRect(-hs * 0.8, -d * 0.8 - h, hs * 1.6, d * 1.6, r * 0.1).fill({ color: 0x55574a, alpha });
  if (type === 'turret') g.rect(-2, -d - h - r * 0.9, 4, r * 0.9).fill({ color: 0x8a8577, alpha });
  if (type === 'pump') g.circle(0, -h, hs * 0.45).fill({ color: C.gas, alpha: 0.45 * alpha });
}
/** 半 2D 單位：身體、頭、武器；dx = 1 朝右、-1 朝左；front = 朝鏡頭（斜前方） */
function drawFigure(g: Graphics, type: TypeId, r: number, col: number, dx: number, front: boolean) {
  const h = unitH(type, r), w = r * (type === 'heavy' || type === 'walker' ? 1.5 : 1.0);
  const metal = 0x5a5446, dark = 0x2a2822, skin = 0x8a7a66;
  g.clear();
  // 腿
  if (type === 'biker') {
    g.ellipse(-r * 0.6 * dx, -r * 0.25, r * 0.35, r * 0.25).fill(dark);
    g.ellipse(r * 0.6 * dx, -r * 0.25, r * 0.35, r * 0.25).fill(dark);
    g.roundRect(-r * 0.75, -r * 0.6, r * 1.5, r * 0.35, 3).fill(metal);
  } else {
    g.rect(-w * 0.35, -h * 0.32, w * 0.25, h * 0.32).fill(dark);
    g.rect(w * 0.1, -h * 0.32, w * 0.25, h * 0.32).fill(dark);
  }
  // 身體（隊伍色胸帶）
  const by = -h * 0.75, bh = h * 0.45;
  g.roundRect(-w / 2, by, w, bh, w * 0.2).fill(metal).stroke({ width: 1.5, color: 0x1a1a16 });
  g.rect(-w / 2, by + bh * 0.35, w, bh * 0.18).fill(col);
  if (!front) g.roundRect(-w * 0.32, by + bh * 0.1, w * 0.64, bh * 0.6, 3).fill(0x4a4336); // 背包
  // 頭
  const hr = r * (type === 'heavy' || type === 'walker' ? 0.38 : 0.42);
  g.circle(0, by - hr * 0.6, hr).fill(0x6b6352).stroke({ width: 1.2, color: 0x1a1a16 });
  if (front) g.rect(-hr * 0.15 + hr * 0.35 * dx, by - hr * 0.75, hr * 0.7 * dx, hr * 0.3).fill(skin); // 面罩
  // 武器：朝面向那一側伸出；斜前方往下一點、斜後方往上一點
  const wy = by + bh * (front ? 0.45 : 0.2), tilt = front ? r * 0.25 : -r * 0.25;
  const arm = (len: number, thick: number, color: number) => {
    g.moveTo(w * 0.25 * dx, wy).lineTo((w * 0.25 + len) * dx, wy + tilt).stroke({ width: thick, color, cap: 'round' });
  };
  switch (type) {
    case 'worker': arm(r * 1.0, 3, 0x8a7a55); g.circle((w * 0.25 + r * 1.0) * dx, wy + tilt, r * 0.28).stroke({ width: 2.5, color: 0x8a7a55 }); break;
    case 'rifle': arm(r * 1.3, 2.5, 0x3a3a34); break;
    case 'srocket': g.moveTo(-w * 0.4 * dx, by + bh * 0.05).lineTo((w * 0.3 + r * 1.2) * dx, by + bh * 0.05 + tilt * 0.6).stroke({ width: r * 0.42, color: 0x5d6a4a, cap: 'round' }); break;
    case 'heavy': arm(r * 0.7, r * 0.45, 0x6e6658); break;
    case 'biker': arm(r * 0.9, 3, 0x3a3a34); break;
    case 'walker': g.roundRect(-w * 0.45, by - hr * 1.6, w * 0.9, hr * 1.1, 3).fill(0x5d6a4a); arm(r * 0.6, r * 0.3, 0x5d6a4a); break;
  }
}
/** 空軍佔位：張開的機翼，鼻子朝面向那一側 */
function drawWing(g: Graphics, type: TypeId, r: number, col: number, dx: number, front: boolean) {
  const span = r * (type === 'jetpack' ? 0.9 : 1.3), ny = front ? r * 0.3 : -r * 0.3;
  g.clear();
  g.poly([r * 1.1 * dx, ny, -r * 0.7 * dx, -span * K, -r * 0.35 * dx, 0, -r * 0.7 * dx, span * K]).fill(0x4f4a3e).stroke({ width: 2, color: col });
  g.circle(0, 0, r * 0.32).fill(0x6b6352);
}

function makeView(e: { type: TypeId; team: number; r: number }, ghost = false): View {
  const T = TY[e.type], r = e.r / SUB;
  const col = e.team === ME ? C.ally : C.enemy;
  const root = new Container(), fig = new Container();
  root.addChild(fig);
  const v: View = { root, fig, dx: e.team === ME ? 1 : -1, front: e.team === ME ? false : true, key: '', ghost };
  if (T.cat === 'res') {
    const g = new Graphics();
    for (const [ox, oy, s, c] of [[-9, 0, 12, 0x8f7556], [6, -6, 13, C.scrap], [4, 3, 9, 0xa88a63], [-3, -12, 8, 0x7a6550]])
      g.poly([ox - s, oy, ox - s * 0.3, oy - s * 0.9, ox + s, oy - s * 0.4, ox + s * 0.6, oy + s * 0.4]).fill(c);
    fig.addChild(g);
    L.obj.addChild(root);
    return v;
  }
  if (T.cat === 'building') {
    if (bart[e.type]) {
      const sp = new Sprite(bart[e.type]);
      sp.anchor.set(0.5, 0.8);
      sp.width = bldHs(r) * 2.3; sp.scale.y = sp.scale.x;
      fig.addChild(sp);
    } else {
      const g = new Graphics();
      drawBuilding(g, e.type, r, col);
      fig.addChild(g);
      const lab = mkLabel(T.ch, r * 0.7, col);
      lab.y = -bldH(e.type, r);
      fig.addChild(lab);
    }
    if (ghost) root.alpha = 0.45;
    L.obj.addChild(root);
    return v;
  }
  if (!art[e.type]) {
    v.label = mkLabel(T.ch, r * 0.6, C.fg);
    root.addChild(v.label);
  }
  (T.cat === 'air' ? L.air : L.obj).addChild(root);
  return v;
}

/** 依面向換圖：四個方向，有一點遲滯避免直上直下時左右亂跳 */
function updateFacing(v: View, e: Ent, r: number, col: number) {
  if (Math.abs(e.fx) > 300) v.dx = e.fx > 0 ? 1 : -1;
  if (Math.abs(e.fy) > 300) v.front = e.fy > 0;
  const key = v.dx + (v.front ? 'f' : 'b');
  if (key === v.key) return;
  v.key = key;
  v.fig.removeChildren().forEach(c => c.destroy());
  const a = art[e.type];
  if (a) {
    const sp = new Sprite(v.front ? a.front : a.back);
    sp.anchor.set(0.5, 0.92);
    sp.height = unitH(e.type, r) * 1.15;
    sp.scale.x = Math.abs(sp.scale.y) * v.dx;
    v.fig.addChild(sp);
    return;
  }
  const g = new Graphics();
  if (isAir(e)) drawWing(g, e.type, r, col, v.dx, v.front);
  else drawFigure(g, e.type, r, col, v.dx, v.front);
  v.fig.addChild(g);
  if (v.label) v.label.y = isAir(e) ? 0 : -unitH(e.type, r) * 0.55;
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

// ---------- 座標換算（地面點 ↔ 螢幕） ----------
export const w2s = (x: number, y: number) => ({ x: (x - cam.x) * cam.z + view.w / 2, y: (y - cam.y) * cam.z * K + view.h / 2 });
export const s2w = (sx: number, sy: number) => ({ x: (sx - view.w / 2) / cam.z + cam.x, y: (sy - view.h / 2) / (cam.z * K) + cam.y });
export function inView(xpx: number, ypx: number) {
  const p = w2s(xpx, ypx);
  return p.x >= 0 && p.y >= 0 && p.x <= view.w && p.y <= view.h;
}
/** 實體在螢幕上的身體中心與點選半徑（不是腳底） */
export function screenBody(e: Ent) {
  const b = bodyOf(e.type, e.r / SUB, e.x / SUB, (e.y / SUB) * K);
  return { x: (b.cx - cam.x) * cam.z + view.w / 2, y: (b.cy - cam.y * K) * cam.z + view.h / 2, r: b.r * cam.z };
}

export function draw(alpha: number, circle: { sx: number; sy: number; r: number } | null) {
  const g = st.g, z = cam.z;
  const px0 = view.w / 2 - cam.x * z, py0 = view.h / 2 - cam.y * z * K;
  for (const c of [groundW, fogW, markW]) { c.scale.set(z, z * K); c.position.set(px0, py0); }
  for (const c of [objW, overW]) { c.scale.set(z); c.position.set(px0, py0); }
  updateFog();
  updateGhosts();
  const ip = (e: Ent) => ({ x: (e.px + (e.x - e.px) * alpha) / SUB, y: (e.py + (e.y - e.py) * alpha) / SUB });
  const seen = new Set<number>();
  const under = L.under.clear(), shadow = L.shadow.clear(), plan = L.plan.clear(), over = L.over.clear(), shots = L.shots.clear(), marks = L.marks.clear();
  const t = now();
  for (const e of g.ents) {
    const vis = e.team === ME || isRes(e) || visibleAt(g, ME, e.x, e.y);
    if (!vis) continue;
    seen.add(e.id);
    let v = views.get(e.id);
    if (!v) { v = makeView(e); views.set(e.id, v); }
    const p = ip(e), r = e.r / SUB, ox = p.x, oy = p.y * K;
    const col = e.team === ME ? C.ally : C.enemy;
    const b = bodyOf(e.type, r, ox, oy);
    v.root.x = ox; v.root.y = oy;
    if (isRes(e)) { v.root.zIndex = oy; v.root.alpha = 0.5 + (0.5 * e.amt) / 1500; continue; }
    if (isB(e)) {
      v.root.zIndex = oy + bldHs(r) * K;
      v.root.alpha = e.built ? 1 : 0.55;
      shadow.ellipse(p.x + r * 0.15, p.y + r * 0.25, bldHs(r) * 1.15, bldHs(r) * 1.1).fill({ color: 0x000000, alpha: 0.28 });
      const below = oy + bldHs(r) * K + 12;
      if (!e.built) {
        const paused = e.team === ME && !builderOf(g, e);
        const bw = r * 1.6, f = e.prog / (TY[e.type].bt! * 20);
        over.rect(ox - bw / 2, b.top - 12, bw, 5).fill({ color: 0x000000, alpha: 0.6 });
        over.rect(ox - bw / 2, b.top - 12, bw * f, 5).fill(paused ? C.dim : C.accent);
        setStatus(e.id, paused ? '暫停' : '', ox, b.top - 24, C.dim);
      } else if (e.team === ME) {
        let s = '';
        const q = e.q[0];
        if (e.type === 'base') s = 'Lv' + g.teams[ME].baseLv + '・工 ' + minersOf(g, e) + '/' + MINE_CAP;
        if (q) {
          const name = q.kind === 'unit' ? TY[q.type!].ch : q.kind === 'upg' ? '升級' : '擴建';
          s = (s ? s + '\n' : '') + name + (e.q.length > 1 ? ' +' + (e.q.length - 1) : '') + (e.loop ? ' ∞' : '');
          const bw = r * 1.6;
          over.rect(ox - bw / 2, below - 6, bw, 5).fill({ color: 0x000000, alpha: 0.6 });
          over.rect(ox - bw / 2, below - 6, (bw * q.t) / q.total, 5).fill(C.accent);
        } else if (e.loop) s = (s ? s + '\n' : '') + '∞ ' + TY[e.loop].name;
        if (e.type === 'pump') s = '+' + (e.rate / 1000).toFixed(1) + '/s';
        setStatus(e.id, s, ox, below + (q ? 12 : 4), e.type === 'pump' ? C.gas : C.dim, 11);
      } else setStatus(e.id, '', 0, 0, 0);
    } else {
      updateFacing(v, e, r, col);
      // 底圈（隊伍色）與影子畫在地面上
      shadow.ellipse(p.x + 3, p.y + 3, r * 0.95, r * 0.95).fill({ color: 0x000000, alpha: 0.3 });
      under.circle(p.x, p.y, r).fill({ color: col, alpha: 0.2 }).stroke({ width: 2 / K, color: col, alpha: 0.9 });
      if (isAir(e)) { v.root.y = oy - FLY; v.root.zIndex = oy; }
      else {
        v.root.zIndex = oy;
        // 工兵帶廢料：背上一小塊
        if (e.carry > 0) over.circle(ox - 6 * v.dx, b.cy - 2, 4).fill(C.scrap);
      }
    }
    // 彈道：從槍口高度打到目標身體
    if (g.tick - e.shotAt <= 2) {
      const tg = g.byId.get(e.shotTid);
      if (tg) {
        const q = ip(tg), tb = bodyOf(tg.type, tg.r / SUB, q.x, q.y * K);
        const a = 1 - (g.tick - e.shotAt + alpha) / 3;
        const heavy = e.type === 'srocket' || e.type === 'heavy' || e.type === 'walker' || e.type === 'glider' || e.type === 'divebomber';
        shots.moveTo(b.cx, isB(e) ? b.top : b.cy - 2).lineTo(tb.cx, tb.cy).stroke({ width: heavy ? 3 : 1.5, color: e.team === ME ? C.ally : C.enemy, alpha: Math.max(0, a) });
      }
    }
    const sel = st.sel.has(e.id);
    if (sel) under.circle(p.x, p.y, isB(e) ? bldHs(r) * 1.25 : r + 5).stroke({ width: 2.5 / K, color: C.ok });
    if (sel || e.hp < e.maxHp) {
      const w = Math.max(r * 2, 24), f = Math.max(0, e.hp / e.maxHp), y = b.top - 9;
      over.rect(ox - w / 2, y, w, 5).fill({ color: 0x000000, alpha: 0.6 });
      over.rect(ox - w / 2, y, w * f, 5).fill(f > 0.5 ? C.ok : f > 0.25 ? C.accent : C.bad);
    }
    if (sel && isB(e)) {
      if (e.type === 'turret') under.circle(p.x, p.y, TY.turret.range!).stroke({ width: 1.5 / K, color: C.ally, alpha: 0.3 });
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
    if (!v) { v = makeView({ type: gh.type, team: 1, r: gh.r }, true); ghostViews.set(id, v); }
    v.root.x = gh.x / SUB; v.root.y = (gh.y / SUB) * K; v.root.zIndex = v.root.y + bldHs(gh.r / SUB) * K;
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
  if (showPump) for (const b of g.ents) if (b.team === ME && b.type === 'pump') under.circle(b.x / SUB, b.y / SUB, PUMP.radius).stroke({ width: 1.5 / K, color: C.gas, alpha: 0.4 });
  // 已確認、還沒開工的建築：地面上的灰色預定地
  for (const p of plannedSites(g, ME)) {
    const hs = bldHs(TY[p.type].r);
    plan.roundRect(p.x - hs, p.y - hs, hs * 2, hs * 2, hs * 0.2).fill({ color: 0x8a8a8a, alpha: 0.3 }).stroke({ width: 2 / K, color: 0x9a9a9a, alpha: 0.8 });
  }
  // 放置中的建築：地面預定地 + 半透明的建築
  if (placing) {
    const T = TY[placing.type], r = T.r, hs = bldHs(r);
    const ck = placeCheck(g, ME, placing.type, Math.round(placing.x), Math.round(placing.y));
    const col = ck.ok ? C.ok : C.bad, ox = placing.x, oy = placing.y * K;
    plan.roundRect(placing.x - hs, placing.y - hs, hs * 2, hs * 2, hs * 0.2).fill({ color: col, alpha: 0.18 }).stroke({ width: 2.5 / K, color: col });
    if (placing.type === 'pump') {
      plan.circle(placing.x, placing.y, PUMP.radius).stroke({ width: 1.5 / K, color: C.gas, alpha: 0.6 });
      let n = 0;
      for (const o of g.ents) if (o.team === ME && o.type === 'pump' && (o.x / SUB - placing.x) ** 2 + (o.y / SUB - placing.y) ** 2 < (PUMP.radius * 2) ** 2) n++;
      setStatus(-1, n ? '與 ' + n + ' 座重疊：產量 -' + Math.min(80, 40 * n) + '%' : '', ox, oy - bldH(placing.type, r) - hs * K - 22, C.bad);
    } else setStatus(-1, '', 0, 0, 0);
    drawBuilding(placeGhost, placing.type, r, col, 0.55);
    placeGhost.position.set(ox, oy);
    placeGhost.visible = true;
    setStatus(-2, T.ch, ox, oy - bldH(placing.type, r), col, Math.round(r * 0.7));
    setStatus(-3, ck.ok ? '' : ck.why, ox, oy + hs * K + 16, C.bad);
  } else { placeGhost.visible = false; setStatus(-1, '', 0, 0, 0); setStatus(-2, '', 0, 0, 0); setStatus(-3, '', 0, 0, 0); }
  // 特效：地面標記壓扁成橢圓；爆炸畫在物件高度
  st.fx = st.fx.filter(f => t - f.t0 < (f.kind === 'boom' ? 450 : 600));
  for (const f of st.fx) {
    if (f.kind === 'boom') { const k = (t - f.t0) / 450; over.circle(f.x, f.y * K - 10, f.r * (0.4 + k * 0.6)).stroke({ width: 3, color: f.c, alpha: 1 - k }); }
    else { const k = (t - f.t0) / 600; marks.circle(f.x, f.y, f.r + 18 * (1 - k) + 6).stroke({ width: 3 / K, color: f.c, alpha: 1 - k }); }
  }
  screen.clear();
  if (circle) screen.circle(circle.sx, circle.sy, circle.r).fill({ color: C.ok, alpha: 0.12 }).stroke({ width: 2, color: C.ok });
  app.render();
}

function dashed(g: Graphics, x1: number, y1: number, x2: number, y2: number, color: number, width: number) {
  const d = Math.hypot(x2 - x1, y2 - y1), n = Math.max(1, Math.floor(d / 14));
  for (let i = 0; i < n; i += 1) {
    if (i % 2) continue;
    const a = i / n, b = Math.min(1, (i + 1) / n);
    g.moveTo(x1 + (x2 - x1) * a, y1 + (y2 - y1) * a).lineTo(x1 + (x2 - x1) * b, y1 + (y2 - y1) * b);
  }
  g.stroke({ width: width / K, color });
}

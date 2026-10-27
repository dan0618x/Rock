// 模擬核心：固定每秒 20 步、整數運算、同樣的指令序列在任何裝置都得到同樣結果。
// 不碰畫面、觸控、時鐘；畫面層只讀狀態，所有操作都透過指令進來。
import {
  BASE_UP, BUILD_REQ, CARRY, EXPAND, MAP_H, MAP_W, MINE_CAP, MINE_TIME, POP_START, PROD, PUMP, QUEUE_MAX,
  SCRAP_AMT, START, TIME_LIMIT, TY, UNIT_REQ, VS, type TypeId,
} from './data';
import { S, TPS, dist, dist2, idiv, isqrt, px, speedPerTick, ticks } from './math';
import { BASE0, BASE1, FIELDS, MAIN_PILES0, TERRAIN, mirror } from './map';
import { CELL, GH, GW, findPath, insideObstacle, los, nearFree, newNav, rebuildNav, type NavGrid, type Obstacle } from './nav';
import type { BuildJob, Cmd, Ent, Form, Order, QItem, SimEvent, Team, TeamState } from './types';

export interface Fog { vis: Uint8Array; exp: Uint8Array }

export interface Game {
  tick: number;
  /** 開局種子（打散後） */
  seed: number;
  rng: number;
  ents: Ent[];
  byId: Map<number, Ent>;
  nextId: number;
  teams: [TeamState, TeamState];
  nav: NavGrid;
  fog: [Fog, Fog];
  events: SimEvent[];
  /** 這一步的命中，全部單位行動完才一起結算（雙方同時開火，不因處理順序吃虧） */
  hits: { t: Ent; d: number; src: Ent }[];
  /** -1 進行中；0/1 勝方；2 和局 */
  winner: number;
}

export const K = 1000; // 資源以千分之一儲存
const sq = (v: number) => v * v;
const HP = 10; // 血量 ×10

// ---------- 分類 ----------
export const isB = (e: Ent) => TY[e.type].cat === 'building';
export const isRes = (e: Ent) => TY[e.type].cat === 'res';
export const isUnit = (e: Ent) => { const c = TY[e.type].cat; return c === 'worker' || c === 'ground' || c === 'air'; };
export const isCombat = (e: Ent) => { const c = TY[e.type].cat; return c === 'ground' || c === 'air'; };
export const isAir = (e: Ent) => TY[e.type].cat === 'air';
export const isWorker = (e: Ent) => e.type === 'worker';

// ---------- 建立 ----------
export function spawn(g: Game, type: TypeId, team: Team | -1, xpx: number, ypx: number, built = true): Ent {
  const T = TY[type];
  const x = px(xpx), y = px(ypx);
  const e: Ent = {
    id: g.nextId++, type, team, x, y, px: x, py: y, fx: team === 1 ? -1024 : 1024, fy: 0,
    hp: T.hp * HP, maxHp: T.hp * HP, r: px(T.r), built, prog: 0, cd: 0, order: { k: 'idle' }, bq: [], q: [],
    loop: null, rally: null, carry: 0, amt: T.cat === 'res' ? SCRAP_AMT : 0, nav: null, rate: 0,
    shotAt: -99, shotTid: 0, hitAt: -99, dead: false,
  };
  if (!built) e.hp = Math.max(1, idiv(e.maxHp, 10));
  g.ents.push(e);
  g.byId.set(e.id, e);
  if (T.cat === 'building' || T.cat === 'res') g.nav.dirty = true;
  return e;
}

/** 地圖配置在 map.ts；這裡只提供查詢 */
export { mirror };
export const baseOf = (team: Team) => (team === 0 ? BASE0 : BASE1);
export const fieldSpot = (team: Team, i: number) => FIELDS[team][i].spot;
export const FIELD_COUNT = FIELDS[0].length;
/** 地形（模擬單位），id 用負數，不會跟實體重複 */
const TERR: Obstacle[] = TERRAIN.map((t, i) => ({ x: px(t.x), y: px(t.y), r: px(t.r), id: -(i + 1) }));

const newTeam = (): TeamState => ({
  scrap: START.scrap * K, gas: START.gas * K, baseLv: 1, exp: 0,
  stats: { made: 0, lost: 0, killed: 0, mined: 0, gassed: 0 },
});

/** 把小整數種子打散，避免前幾個亂數都偏小 */
function mixSeed(seed: number) {
  let x = Math.imul((seed | 0) ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x | 0 || 1;
}

export function createGame(seed = 1): Game {
  const g: Game = {
    tick: 0, seed: mixSeed(seed), rng: mixSeed(seed), ents: [], byId: new Map(), nextId: 1, teams: [newTeam(), newTeam()],
    nav: newNav(), fog: [newFog(), newFog()], events: [], hits: [], winner: -1,
  };
  for (const team of [0, 1] as Team[]) {
    const B = baseOf(team);
    spawn(g, 'base', team, B.x, B.y);
    for (const p0 of MAIN_PILES0) { const p = team === 0 ? p0 : mirror(p0.x, p0.y); spawn(g, 'scrap', -1, p.x, p.y); }
    for (const f of FIELDS[team]) for (const p of f.piles) spawn(g, 'scrap', -1, p.x, p.y);
  }
  for (const team of [0, 1] as Team[]) {
    const B = baseOf(team), sg = team === 0 ? 1 : -1;
    const ws: Ent[] = [];
    for (let i = 0; i < START.workers; i++) ws.push(spawn(g, 'worker', team, B.x + sg * (60 + i * 36), B.y - sg * 90));
    for (const w of ws) gatherOne(g, w, nearestRes(g, w), false);
  }
  rebuildNav(g.nav, obstacles(g));
  updateFog(g);
  return g;
}

// ---------- 查詢（畫面層、電腦對手、指令檢查共用） ----------
export const own = (g: Game, team: Team, f: (e: Ent) => boolean) => g.ents.filter(e => e.team === team && !e.dead && f(e));
export const hasBuilt = (g: Game, team: Team, t: TypeId) => g.ents.some(e => e.team === team && e.type === t && e.built && !e.dead);
export const techLv = (g: Game, team: Team) => (hasBuilt(g, team, 'base') ? g.teams[team].baseLv : 0);
export function popCap(g: Game, team: Team) {
  if (!hasBuilt(g, team, 'base')) return 0;
  let c = POP_START;
  for (let i = 0; i < g.teams[team].exp; i++) c += EXPAND.add[i];
  return c;
}
export function popUsed(g: Game, team: Team) {
  let u = 0;
  for (const e of g.ents) {
    if (e.team !== team || e.dead) continue;
    if (isUnit(e)) u += TY[e.type].pop || 0;
    for (const q of e.q) if (q.kind === 'unit') u += TY[q.type!].pop || 0;
  }
  return u;
}
export const afford = (g: Game, team: Team, c: [number, number]) => g.teams[team].scrap >= c[0] * K && g.teams[team].gas >= c[1] * K;
const lackMsg = (g: Game, team: Team, c: [number, number]) => (g.teams[team].scrap < c[0] * K ? '廢料不足' : '輻能氣不足');
function pay(g: Game, team: Team, c: [number, number]) { g.teams[team].scrap -= c[0] * K; g.teams[team].gas -= c[1] * K; }
function refund(g: Game, team: Team, c: [number, number], pct = 100) {
  g.teams[team].scrap += idiv(c[0] * K * pct, 100);
  g.teams[team].gas += idiv(c[1] * K * pct, 100);
}

export function unitReq(g: Game, team: Team, t: TypeId): string {
  const r = UNIT_REQ[t];
  if (!r) return '';
  if (r.lv && techLv(g, team) < r.lv) return '需主堡 Lv' + r.lv;
  if (r.b && !hasBuilt(g, team, r.b)) return '需' + TY[r.b].name;
  return '';
}
export function buildReq(g: Game, team: Team, t: TypeId): string {
  const lv = BUILD_REQ[t] || 0;
  return techLv(g, team) < lv ? '需主堡 Lv' + lv : '';
}
export function nextUp(g: Game, team: Team, kind: 'upg' | 'exp'): { max: true } | { max: false; cost: [number, number]; t: number } {
  const T = g.teams[team];
  if (kind === 'upg') { const i = T.baseLv - 1; return i >= BASE_UP.cost.length ? { max: true } : { max: false, cost: BASE_UP.cost[i], t: BASE_UP.t[i] }; }
  const i = T.exp;
  return i >= EXPAND.add.length ? { max: true } : { max: false, cost: EXPAND.cost[i], t: EXPAND.t[i] };
}
export const upInProgress = (g: Game, team: Team, kind: 'upg' | 'exp') => g.ents.some(e => e.team === team && !e.dead && e.type === 'base' && e.q.some(q => q.kind === kind));

export function minersOf(g: Game, b: Ent) {
  let n = 0;
  for (const w of g.ents) if (!w.dead && w.type === 'worker' && w.order.k === 'gather' && w.order.base === b.id) n++;
  return n;
}
export const builderOf = (g: Game, b: Ent) => g.ents.find(w => !w.dead && w.type === 'worker' && w.order.k === 'build' && w.order.bid === b.id);

/** 這個隊伍已確認、工兵還沒開工的建築位置（像素） */
export function plannedSites(g: Game, team: Team, ignoreWorker = 0): { type: TypeId; x: number; y: number; wid: number }[] {
  const out: { type: TypeId; x: number; y: number; wid: number }[] = [];
  for (const w of g.ents) {
    if (w.dead || w.team !== team || w.type !== 'worker' || w.id === ignoreWorker) continue;
    if (w.order.k === 'build' && !w.order.bid) out.push({ type: w.order.type, x: w.order.x, y: w.order.y, wid: w.id });
    for (const j of w.bq) out.push({ type: j.type, x: j.x, y: j.y, wid: w.id });
  }
  return out;
}

/** 建築放置檢查（座標為像素） */
export function placeCheck(g: Game, team: Team, type: TypeId, xpx: number, ypx: number, ignoreWorker = 0): { ok: boolean; why: string } {
  const T = TY[type];
  if (xpx < T.r || ypx < T.r || xpx > MAP_W - T.r || ypx > MAP_H - T.r) return { ok: false, why: '超出地圖' };
  const x = px(xpx), y = px(ypx);
  for (const o of g.ents) {
    if (o.dead || !(isB(o) || isRes(o))) continue;
    const m = o.r + px(T.r + 10);
    if (dist2(o.x, o.y, x, y) < m * m) return { ok: false, why: '這裡放不下，換個位置' };
  }
  for (const t of TERRAIN) {
    const m = t.r + T.r + 10;
    if ((t.x - xpx) * (t.x - xpx) + (t.y - ypx) * (t.y - ypx) < m * m) return { ok: false, why: '地形擋住了，換個位置' };
  }
  for (const p of plannedSites(g, team, ignoreWorker)) {
    const m = TY[p.type].r + T.r + 10;
    if ((p.x - xpx) * (p.x - xpx) + (p.y - ypx) * (p.y - ypx) < m * m) return { ok: false, why: '已經有建築預定在這裡' };
  }
  return { ok: true, why: '' };
}

export function canHit(e: Ent, o: Ent) {
  const T = TY[e.type];
  if (!T.dmg) return false;
  if (isRes(o)) return false;
  if (isAir(o)) return !!T.aa && VS[T.atk!].air > 0;
  return !!T.ag;
}

// ---------- 迷霧 ----------
function newFog(): Fog { return { vis: new Uint8Array(GW * GH), exp: new Uint8Array(GW * GH) }; }
export function visibleAt(g: Game, team: Team, x: number, y: number) {
  const gx = Math.floor(x / CELL), gy = Math.floor(y / CELL);
  if (gx < 0 || gy < 0 || gx >= GW || gy >= GH) return false;
  return g.fog[team].vis[gy * GW + gx] === 1;
}
export const canSee = (g: Game, team: Team, e: Ent) => e.team === team || visibleAt(g, team, e.x, e.y);
function updateFog(g: Game) {
  for (const team of [0, 1] as Team[]) {
    const f = g.fog[team];
    f.vis.fill(0);
    for (const e of g.ents) {
      if (e.team !== team || e.dead) continue;
      const sr = px(TY[e.type].sight), sr2 = sr * sr;
      const x0 = Math.max(0, Math.floor((e.x - sr) / CELL)), x1 = Math.min(GW - 1, Math.floor((e.x + sr) / CELL));
      const y0 = Math.max(0, Math.floor((e.y - sr) / CELL)), y1 = Math.min(GH - 1, Math.floor((e.y + sr) / CELL));
      for (let gy = y0; gy <= y1; gy++)
        for (let gx = x0; gx <= x1; gx++)
          if (dist2(gx * CELL + CELL / 2, gy * CELL + CELL / 2, e.x, e.y) <= sr2) { f.vis[gy * GW + gx] = 1; f.exp[gy * GW + gx] = 1; }
    }
  }
}

// ---------- 小工具 ----------
function obstacles(g: Game): Obstacle[] {
  const out: Obstacle[] = TERR.slice();
  for (const e of g.ents) if (!e.dead && (isB(e) || isRes(e))) out.push({ x: e.x, y: e.y, r: e.r, id: e.id });
  return out;
}
/** 最近的廢料堆；已經有工兵在採的堆會被當成比較遠，工兵自然分散開 */
export function nearestRes(g: Game, e: { x: number; y: number }): Ent | null {
  const busy = new Map<number, number>();
  for (const w of g.ents) if (!w.dead && w.type === 'worker' && w.order.k === 'gather' && w !== e) busy.set(w.order.res, (busy.get(w.order.res) || 0) + 1);
  let b: Ent | null = null, bd = Infinity;
  for (const r of g.ents) {
    if (r.dead || !isRes(r) || r.amt <= 0) continue;
    const d = isqrt(dist2(e.x, e.y, r.x, r.y)) + (busy.get(r.id) || 0) * px(70);
    if (d < bd) { bd = d; b = r; }
  }
  return b;
}
function nearestDrop(g: Game, e: Ent): Ent | null {
  let b: Ent | null = null, bd = Infinity;
  for (const o of g.ents) if (!o.dead && o.team === e.team && o.type === 'base' && o.built) { const d = dist2(e.x, e.y, o.x, o.y); if (d < bd) { bd = d; b = o; } }
  return b;
}
function baseFor(g: Game, team: Team | -1, r: Ent): Ent | null {
  let b: Ent | null = null, bd = Infinity;
  for (const o of g.ents) if (!o.dead && o.team === team && o.type === 'base' && o.built) { const d = dist2(o.x, o.y, r.x, r.y); if (d < bd) { bd = d; b = o; } }
  return b;
}
function event(g: Game, k: SimEvent['k'], team: Team, e: { x: number; y: number }, text: string, type?: TypeId) {
  g.events.push({ k, team, x: Math.trunc(e.x / S), y: Math.trunc(e.y / S), text, type });
}
/** 工兵換指令時，還沒開工的建築退費 */
function dropJobs(g: Game, w: Ent) {
  if (w.team < 0) return;
  const team = w.team as Team;
  if (w.order.k === 'build' && !w.order.bid) refund(g, team, TY[w.order.type].cost);
  for (const j of w.bq) refund(g, team, TY[j.type].cost);
  w.bq = [];
}
function setOrder(g: Game, e: Ent, o: Order) {
  if (e.type === 'worker') dropJobs(g, e);
  e.order = o;
  e.nav = null;
}

// ---------- 戰鬥 ----------
function acquire(g: Game, e: Ent, rad: number): Ent | null {
  let best: Ent | null = null, bs = Infinity;
  const team = e.team as Team;
  for (const o of g.ents) {
    if (o.dead || o.team < 0 || o.team === e.team) continue;
    if (!canHit(e, o)) continue;
    const d = isqrt(dist2(e.px, e.py, o.px, o.py)) - o.r;
    if (d >= rad) continue;
    if (!visibleAt(g, team, o.px, o.py)) continue;
    // 優先打會反擊的目標，其次一般建築
    const s = d + (isB(o) && o.type !== 'turret' ? px(300) : 0) + (isWorker(o) ? px(60) : 0);
    if (s < bs) { bs = s; best = o; }
  }
  return best;
}
function fire(g: Game, e: Ent, t: Ent) {
  const T = TY[e.type];
  e.cd = ticks(T.cd!);
  e.shotAt = g.tick;
  e.shotTid = t.id;
  const pct = VS[T.atk!][TY[t.type].armor];
  const d = Math.max(1, idiv(T.dmg! * HP * pct, 100));
  g.hits.push({ t, d, src: e });
}
/** 命中結算分三段：先全部扣血、再判定死亡、最後才反擊，雙方完全對稱 */
function resolveHits(g: Game) {
  for (const { t, d } of g.hits) {
    t.hp -= d;
    if (t.team >= 0 && g.tick - t.hitAt > 2 * TPS) event(g, 'attacked', t.team as Team, t, (TY[t.type].name) + ' 遭受攻擊', t.type);
    t.hitAt = g.tick;
  }
  for (const { t, src } of g.hits) {
    if (t.hp <= 0 && !t.dead) {
      t.dead = true;
      if (src.team >= 0) g.teams[src.team as Team].stats.killed++;
    }
  }
  for (const { t, src } of g.hits) react(g, t, src);
  g.hits = [];
}
function react(g: Game, t: Ent, src: Ent) {
  if (src.dead || src.team < 0 || t.team < 0) return;
  // 同伴被打：附近待命的戰鬥單位一起反擊（包括被打的是工兵或建築）
  const R = px(260);
  for (const a of g.ents) {
    if (a === t || a.dead || a.team !== t.team || !isCombat(a) || a.order.k !== 'idle' || !canHit(a, src)) continue;
    if (Math.abs(a.x - t.x) > R || Math.abs(a.y - t.y) > R || dist2(a.x, a.y, t.x, t.y) > R * R) continue;
    a.order = { k: 'attack', tid: src.id, auto: true, hx: a.x, hy: a.y };
  }
  // 被打會自動反擊：待命中的單位直接反擊；正在自動打建築或打不到自己的目標時，改打攻擊者
  if (t.dead || !isCombat(t) || !canHit(t, src)) return;
  const o = t.order;
  if (o.k === 'idle') t.order = { k: 'attack', tid: src.id, auto: true, hx: t.x, hy: t.y };
  else if (o.k === 'attack' && o.auto && o.tid !== src.id) {
    const cur = g.byId.get(o.tid);
    if (!cur || cur.dead || !threatens(cur, t)) t.order = { ...o, tid: src.id };
  }
}
/** a 會不會打 b（反擊時優先處理會打自己的目標） */
function threatens(a: Ent, b: Ent) {
  return (isUnit(a) || a.type === 'turret') && canHit(a, b);
}

// ---------- 移動 ----------
function moveStraight(e: Ent, x: number, y: number, spd: number): boolean {
  const dx = x - e.x, dy = y - e.y, d = isqrt(dx * dx + dy * dy);
  if (d <= px(3)) return true;
  if (d <= spd) { e.x = x; e.y = y; }
  else { e.x += idiv(dx * spd, d); e.y += idiv(dy * spd, d); }
  e.fx = idiv(dx * 1024, d); e.fy = idiv(dy * 1024, d);
  return false;
}
function steerMove(g: Game, e: Ent, x: number, y: number, spd: number): boolean {
  const dx = x - e.x, dy = y - e.y, d = isqrt(dx * dx + dy * dy);
  if (d <= px(3)) return true;
  let ux = idiv(dx * 1024, d), uy = idiv(dy * 1024, d);
  if (e.type !== 'worker') {
    // 前方有停住的己方單位時往側邊繞
    const nx = -uy, ny = ux;
    let ax = 0, ay = 0;
    for (const o of g.ents) {
      if (o === e || o.dead || !isUnit(o) || isAir(o) || o.type === 'worker') continue;
      if (o.order.k === 'move' && e.order.k === 'move') continue;
      const rx = o.x - e.x, ry = o.y - e.y;
      if (Math.abs(rx) > px(80) || Math.abs(ry) > px(80)) continue;
      const along = idiv(rx * ux + ry * uy, 1024), look = e.r + o.r + px(30);
      if (along <= 0 || along > look || along > d) continue;
      const perp = idiv(rx * nx + ry * ny, 1024), clr = e.r + o.r + px(4);
      if (Math.abs(perp) >= clr) continue;
      const side = perp > 0 ? -1 : 1, w = 1024 - idiv(along * 1024, look);
      ax += idiv(nx * side * w, 1024); ay += idiv(ny * side * w, 1024);
    }
    if (ax || ay) {
      ux += idiv(ax * 14, 10); uy += idiv(ay * 14, 10);
      const m = isqrt(ux * ux + uy * uy) || 1;
      ux = idiv(ux * 1024, m); uy = idiv(uy * 1024, m);
    }
  }
  const s = Math.min(d, spd);
  e.x += idiv(ux * s, 1024); e.y += idiv(uy * s, 1024);
  e.fx = ux; e.fy = uy;
  return false;
}
/** 前往目標；需要時重新尋路。回傳 true 表示到達 */
function goTo(g: Game, e: Ent, x: number, y: number, spd: number, ign?: Ent | null): boolean {
  if (isAir(e)) return moveStraight(e, x, y, spd);
  let nav = e.nav;
  if (!nav || nav.ver !== g.nav.ver || dist2(nav.tx, nav.ty, x, y) > px(40) * px(40)) {
    const ig = ign ? ign.id : 0;
    const pts = los(g.nav, e.x, e.y, x, y, e.r, ig) ? [x, y] : findPath(g.nav, e.x, e.y, x, y, e.r, ig);
    nav = e.nav = { tx: x, ty: y, pts, i: 0, ver: g.nav.ver };
  }
  const n = nav.pts.length / 2, last = nav.i >= n - 1;
  const p = last ? { x, y } : { x: nav.pts[nav.i * 2], y: nav.pts[nav.i * 2 + 1] };
  if (!last && dist2(p.x, p.y, e.x, e.y) < px(14) * px(14)) { nav.i++; return false; }
  // 目的地在障礙裡（例如點到建築上）：走到旁邊就算到了
  if (last && !ign && insideObstacle(g.nav, x, y, e.r) && dist2(x, y, e.x, e.y) < sq(CELL * 2)) { e.nav = null; return true; }
  const done = steerMove(g, e, p.x, p.y, spd);
  if (done && last) { e.nav = null; return true; }
  return false;
}
/** 打完之後回到原本的移動或巡邏，卡住計數重新開始 */
function resumeOf(o: { resume?: Order }): Order {
  const r = o.resume;
  if (r && (r.k === 'move' || r.k === 'patrol')) { r.best = undefined; r.stall = 0; return r; }
  return r || { k: 'idle' };
}
/** 卡住偵測：1.5 秒內都沒有更接近目標，就當作到了（避免擠在一起的單位一直停在「移動中」不開火） */
function stalled(e: Ent, o: { best?: number; stall?: number }, x: number, y: number) {
  const d = isqrt(dist2(e.x, e.y, x, y));
  if (o.best === undefined || d < o.best - px(1)) { o.best = d; o.stall = 0; return false; }
  o.stall = (o.stall || 0) + 1;
  return o.stall > 30;
}
/** 工兵採集往返：近距離直線走，遠距離才尋路 */
function walk(g: Game, e: Ent, t: Ent, spd: number) {
  if (dist2(e.x, e.y, t.x, t.y) > px(260) * px(260)) goTo(g, e, t.x, t.y, spd, t);
  else moveStraight(e, t.x, t.y, spd);
}

// ---------- 單位更新 ----------
function finishBuild(g: Game, b: Ent) {
  b.built = true;
  b.hp = Math.min(b.maxHp, Math.max(b.hp, 1));
  event(g, 'built', b.team as Team, b, TY[b.type].name + ' 建造完成', b.type);
}
function updUnit(g: Game, e: Ent) {
  const T = TY[e.type], team = e.team as Team;
  const spd = speedPerTick(T.speed || 0), rng = px(T.range || 0);
  const o = e.order;
  switch (o.k) {
    case 'idle': {
      if (isCombat(e)) {
        const t = acquire(g, e, rng + px(40));
        if (t) e.order = { k: 'attack', tid: t.id, auto: true, hx: e.x, hy: e.y };
      }
      break;
    }
    case 'move': {
      if (o.amove && isCombat(e)) {
        const t = acquire(g, e, rng + px(60));
        if (t) { e.order = { k: 'attack', tid: t.id, auto: true, resume: o }; break; }
      }
      if (goTo(g, e, o.x, o.y, spd) || stalled(e, o, o.x, o.y)) { e.order = { k: 'idle' }; e.nav = null; }
      break;
    }
    case 'patrol': {
      if (isCombat(e)) {
        const t = acquire(g, e, rng + px(60));
        if (t) { e.order = { k: 'attack', tid: t.id, auto: true, resume: o }; break; }
      }
      const tx = o.leg ? o.bx : o.ax, ty = o.leg ? o.by : o.ay;
      if (goTo(g, e, tx, ty, spd) || stalled(e, o, tx, ty)) { o.leg = o.leg ? 0 : 1; o.best = undefined; o.stall = 0; e.nav = null; }
      break;
    }
    case 'hold': {
      // 駐守：不追擊，只打射程內的敵人；被推開就走回原位
      if (isCombat(e)) {
        const t = acquire(g, e, rng + px(2));
        if (t) {
          const dx = t.px - e.x, dy = t.py - e.y, m = isqrt(dx * dx + dy * dy) || 1;
          e.fx = idiv(dx * 1024, m); e.fy = idiv(dy * 1024, m);
          if (e.cd <= 0) fire(g, e, t);
          break;
        }
      }
      if (dist2(e.x, e.y, o.x, o.y) > sq(px(20))) goTo(g, e, o.x, o.y, spd);
      break;
    }
    case 'attack': {
      const t = g.byId.get(o.tid);
      if (!t || t.dead || !canSee(g, team, t)) { e.order = resumeOf(o); e.nav = null; break; }
      const d = isqrt(dist2(e.x, e.y, t.px, t.py)) - t.r;
      if (d > rng) {
        if (o.auto && o.hx !== undefined && dist2(e.x, e.y, o.hx, o.hy!) > px(280) * px(280)) { e.order = { k: 'move', x: o.hx, y: o.hy!, amove: false }; break; }
        goTo(g, e, t.px, t.py, spd, t);
      } else {
        const dx = t.px - e.x, dy = t.py - e.y, m = isqrt(dx * dx + dy * dy) || 1;
        e.fx = idiv(dx * 1024, m); e.fy = idiv(dy * 1024, m);
        if (e.cd <= 0) fire(g, e, t);
      }
      break;
    }
    case 'gather': {
      let r = g.byId.get(o.res);
      if (o.st === 'to') {
        if (!r || r.dead || r.amt <= 0) {
          r = nearestRes(g, e) || undefined;
          if (!r) { e.order = { k: 'idle' }; break; }
          o.res = r.id;
        }
        if (dist2(e.x, e.y, r.x, r.y) > sq(r.r + e.r + px(2))) walk(g, e, r, spd);
        else { o.st = 'mine'; o.t = ticks(MINE_TIME); e.nav = null; }
      } else if (o.st === 'mine') {
        if (--o.t <= 0) {
          if (r && !r.dead && r.amt > 0) { const n = Math.min(r.amt, CARRY); r.amt -= n; e.carry = n; if (r.amt <= 0) r.dead = true; }
          o.st = 'back';
        }
      } else {
        const dp = nearestDrop(g, e);
        if (!dp) { e.order = { k: 'idle' }; break; }
        if (dist2(e.x, e.y, dp.x, dp.y) > sq(dp.r + e.r + px(2))) walk(g, e, dp, spd);
        else { deposit(g, e); o.st = 'to'; }
      }
      break;
    }
    case 'return': {
      const b = g.byId.get(o.bid);
      if (!b || b.dead || !b.built) { e.order = o.prev || { k: 'idle' }; break; }
      if (dist2(e.x, e.y, b.x, b.y) > sq(b.r + e.r + px(2))) walk(g, e, b, spd);
      else {
        deposit(g, e);
        e.order = o.prev && o.prev.k === 'gather' ? { ...o.prev, st: 'to' } : { k: 'idle' };
      }
      break;
    }
    case 'build': {
      const BT = TY[o.type];
      if (!o.bid) {
        if (dist2(e.x, e.y, px(o.x), px(o.y)) > sq(px(BT.r) + e.r + px(4))) goTo(g, e, px(o.x), px(o.y), spd);
        else {
          const ck = placeCheck(g, team, o.type, o.x, o.y, e.id);
          if (!ck.ok) {
            refund(g, team, BT.cost);
            event(g, 'fail', team, e, BT.name + ' 無法開工：' + ck.why);
            e.order = { k: 'idle' };
          } else {
            const b = spawn(g, o.type, team, o.x, o.y, false);
            o.bid = b.id;
          }
        }
      } else {
        const b = g.byId.get(o.bid);
        if (!b || b.dead || b.built) e.order = { k: 'idle' };
        else if (dist2(e.x, e.y, b.x, b.y) > sq(b.r + e.r + px(10))) goTo(g, e, b.x, b.y, spd, b);
        else {
          const total = ticks(BT.bt!);
          b.prog++;
          b.hp = Math.min(b.maxHp, b.hp + Math.max(1, idiv(b.maxHp * 9, 10 * total)));
          if (b.prog >= total) { finishBuild(g, b); e.order = { k: 'idle' }; }
        }
      }
      if (e.order.k === 'idle' && e.bq.length) { const j = e.bq.shift()!; e.order = { k: 'build', type: j.type, x: j.x, y: j.y, bid: 0 }; }
      // 蓋完、沒有下一棟：自動回去採廢料
      else if (e.order.k === 'idle') gatherOne(g, e, nearestRes(g, e), true);
      break;
    }
  }
}
function deposit(g: Game, e: Ent) {
  if (!e.carry || e.team < 0) return;
  const T = g.teams[e.team as Team];
  T.scrap += e.carry * K;
  T.stats.mined += e.carry;
  e.carry = 0;
}

function updBuilding(g: Game, b: Ent) {
  const team = b.team as Team;
  if (!b.built) return;
  const T = TY[b.type];
  if (b.type === 'turret') {
    const t = acquire(g, b, px(T.range!));
    if (t && b.cd <= 0) fire(g, b, t);
    return;
  }
  if (!b.q.length && b.loop && !unitReq(g, team, b.loop)) {
    const U = TY[b.loop];
    if (afford(g, team, U.cost) && popUsed(g, team) + (U.pop || 0) <= popCap(g, team)) {
      pay(g, team, U.cost);
      b.q.push({ kind: 'unit', type: b.loop, t: 0, total: ticks(U.pt!), paid: U.cost });
    }
  }
  const q = b.q[0];
  if (!q) return;
  if (++q.t < q.total) return;
  b.q.shift();
  const TS = g.teams[team];
  if (q.kind === 'upg') { TS.baseLv++; event(g, 'upgraded', team, b, '主堡升到 Lv' + TS.baseLv + '：解鎖' + BASE_UP.unlock[TS.baseLv - 2]); return; }
  if (q.kind === 'exp') { const a = EXPAND.add[TS.exp]; TS.exp++; event(g, 'upgraded', team, b, '擴建完成：人口上限 +' + a); return; }
  // 生產單位：出現在朝集結點那一側
  const tx = b.rally ? b.rally.x : b.x + px(80) * (team === 0 ? 1 : -1);
  const ty = b.rally ? b.rally.y : b.y + px(60) * (team === 0 ? -1 : 1);
  const dx = tx - b.x, dy = ty - b.y, m = isqrt(dx * dx + dy * dy) || 1;
  const off = b.r + px(16);
  const u = spawn(g, q.type!, team, 0, 0);
  u.x = u.px = b.x + idiv(dx * off, m);
  u.y = u.py = b.y + idiv(dy * off, m);
  TS.stats.made++;
  if (u.type === 'worker') {
    const rr = b.rally && b.rally.res ? g.byId.get(b.rally.res) : null;
    if (rr && !rr.dead) gatherOne(g, u, rr, false);
    else if (b.rally) u.order = { k: 'move', x: b.rally.x, y: b.rally.y, amove: false };
    else gatherOne(g, u, nearestRes(g, b), false);
  } else if (b.rally) {
    u.order = { k: 'move', x: b.rally.x, y: b.rally.y, amove: true };
  }
}

function gatherOne(g: Game, w: Ent, r: Ent | null, strict: boolean): boolean {
  if (!r) return false;
  const b = baseFor(g, w.team, r);
  if (b && w.order.k === 'gather' && w.order.base === b.id) { w.order.res = r.id; return true; }
  if (b && strict && minersOf(g, b) >= MINE_CAP) return false;
  setOrder(g, w, { k: 'gather', res: r.id, st: 'to', t: 0, base: b ? b.id : 0 });
  return true;
}

function separate(g: Game) {
  const us = g.ents.filter(e => !e.dead && isUnit(e) && e.type !== 'worker');
  for (let i = 0; i < us.length; i++) {
    const a = us[i];
    for (let j = i + 1; j < us.length; j++) {
      const b = us[j];
      if (isAir(a) !== isAir(b)) continue;
      let dx = b.x - a.x, dy = b.y - a.y;
      const m = a.r + b.r;
      if (Math.abs(dx) >= m || Math.abs(dy) >= m) continue;
      let d2 = dx * dx + dy * dy;
      if (d2 >= m * m) continue;
      if (d2 === 0) { dx = (b.id & 1) ? 1 : -1; dy = 0; d2 = 1; }
      const d = isqrt(d2) || 1, p = idiv(m - d, 2);
      const ox = idiv(dx * p, d), oy = idiv(dy * p, d);
      a.x -= ox; a.y -= oy; b.x += ox; b.y += oy;
    }
  }
  for (const u of g.ents) {
    if (u.dead || !isUnit(u) || isAir(u)) continue;
    for (const b of g.ents) {
      if (b.dead || !(isB(b) || isRes(b))) continue;
      if (u.order.k === 'build' && u.order.bid === b.id) continue;
      const dx = u.x - b.x, dy = u.y - b.y, m = b.r + u.r - (u.type === 'worker' ? px(6) : 0);
      if (Math.abs(dx) >= m || Math.abs(dy) >= m) continue;
      const d2 = dx * dx + dy * dy;
      if (d2 >= m * m) continue;
      const d = isqrt(d2) || 1;
      u.x = b.x + idiv((dx || 1) * m, d);
      u.y = b.y + idiv(dy * m, d);
    }
    for (const t of TERR) {
      const dx = u.x - t.x, dy = u.y - t.y, m = t.r + u.r;
      if (Math.abs(dx) >= m || Math.abs(dy) >= m) continue;
      const d2 = dx * dx + dy * dy;
      if (d2 >= m * m) continue;
      const d = isqrt(d2) || 1;
      u.x = t.x + idiv((dx || 1) * m, d);
      u.y = t.y + idiv(dy * m, d);
    }
    u.x = Math.max(u.r, Math.min(px(MAP_W) - u.r, u.x));
    u.y = Math.max(u.r, Math.min(px(MAP_H) - u.r, u.y));
  }
}

function gasTick(g: Game) {
  const R = px(PUMP.radius * 2);
  for (const b of g.ents) {
    if (b.dead || b.type !== 'pump' || !b.built) continue;
    let n = 0;
    for (const o of g.ents) if (o !== b && !o.dead && o.team === b.team && o.type === 'pump' && o.built && dist2(o.x, o.y, b.x, b.y) < R * R) n++;
    const pct = Math.max(PUMP.floor, 100 - PUMP.overlap * n);
    b.rate = idiv(PUMP.rate * K * pct, 100);
    const perTick = idiv(b.rate, TPS);
    const T = g.teams[b.team as Team];
    T.gas += perTick;
    T.stats.gassed += perTick;
  }
}

// ---------- 指令 ----------
const mine = (g: Game, team: Team, ids: number[], f: (e: Ent) => boolean) => {
  const out: Ent[] = [];
  for (const id of ids) { const e = g.byId.get(id); if (e && !e.dead && e.team === team && f(e)) out.push(e); }
  return out;
};

/**
 * 隊形：以「隊伍中心 → 目標」為前方，射程短、血厚的排前面，射程長的排後面；
 * 同一排依目前左右位置分配，避免互相穿過。位置在障礙裡就移到最近的空地。
 */
export function formSlots(g: Game, us: Ent[], tx: number, ty: number, form: Form): { e: Ent; x: number; y: number }[] {
  const n = us.length;
  if (!n) return [];
  // 中心不做除法（避免捨入讓兩邊不對稱）：用 n 倍的座標計算方向與左右位置
  let sx = 0, sy = 0;
  for (const e of us) { sx += e.x; sy += e.y; }
  let fx = tx * n - sx, fy = ty * n - sy;
  const fm = isqrt(fx * fx + fy * fy);
  if (fm < px(20) * n) { fx = 0; fy = -1024; } else { fx = idiv(fx * 1024, fm); fy = idiv(fy * 1024, fm); }
  const rx = -fy, ry = fx;
  let maxR = 0;
  for (const e of us) maxR = Math.max(maxR, e.r);
  const sp = idiv((maxR * 2 + px(8)) * (form === 2 ? 18 : 10), 10);
  const cols = form === 1 ? Math.min(n, 12) : Math.max(1, Math.min(n, isqrt(n * 2 - 1) + 1));
  const order = us.slice().sort((a, b) => (TY[a.type].range || 0) - (TY[b.type].range || 0) || b.maxHp - a.maxHp || a.id - b.id);
  const out: { e: Ent; x: number; y: number }[] = [];
  for (let row = 0; row * cols < n; row++) {
    const line = order.slice(row * cols, row * cols + cols);
    line.sort((a, b) => ((a.x * n - sx) * rx + (a.y * n - sy) * ry) - ((b.x * n - sx) * rx + (b.y * n - sy) * ry) || a.id - b.id);
    const k = line.length;
    line.forEach((e, col) => {
      const lat = idiv((2 * col - (k - 1)) * sp, 2), back = row * sp;
      let x = tx + idiv(rx * lat, 1024) - idiv(fx * back, 1024);
      let y = ty + idiv(ry * lat, 1024) - idiv(fy * back, 1024);
      x = Math.max(e.r, Math.min(px(MAP_W) - e.r, x));
      y = Math.max(e.r, Math.min(px(MAP_H) - e.r, y));
      if (!isAir(e) && insideObstacle(g.nav, x, y, e.r)) { const f = nearFree(g.nav, x, y); x = f.x; y = f.y; }
      out.push({ e, x, y });
    });
  }
  return out;
}

/** 檢查指令；回傳空字串表示可以執行，否則是給玩家看的原因 */
export function check(g: Game, team: Team, c: Cmd): string {
  switch (c.c) {
    case 'move': return mine(g, team, c.ids, isUnit).length ? '' : '沒有可移動的單位';
    case 'patrol': return mine(g, team, c.ids, isCombat).length ? '' : '沒有戰鬥單位';
    case 'hold': return mine(g, team, c.ids, isCombat).length ? '' : '沒有戰鬥單位';
    case 'attack': {
      const t = g.byId.get(c.tid);
      if (!t || t.dead || t.team === team || t.team < 0) return '目標不存在';
      const us = mine(g, team, c.ids, isUnit);
      if (!us.some(e => canHit(e, t))) return isAir(t) ? '選取的單位無法對空' : '選取的單位無法攻擊這個目標';
      return '';
    }
    case 'fire': return mine(g, team, c.ids, isCombat).length ? '' : '沒有戰鬥單位';
    case 'gather': {
      const r = g.byId.get(c.res);
      if (!r || r.dead || !isRes(r)) return '廢料堆不存在';
      return mine(g, team, c.ids, isWorker).length ? '' : '沒有工兵';
    }
    case 'return': return mine(g, team, c.ids, e => isWorker(e) && e.carry > 0).length ? '' : '工兵沒有帶廢料';
    case 'build': {
      if (!mine(g, team, c.ids, isWorker).length) return '沒有選取工兵';
      const T = TY[c.type];
      if (T.cat !== 'building') return '無法建造';
      const lk = buildReq(g, team, c.type);
      if (lk) return T.name + '：' + lk;
      const ck = placeCheck(g, team, c.type, c.x, c.y);
      if (!ck.ok) return ck.why;
      if (!afford(g, team, T.cost)) return lackMsg(g, team, T.cost);
      return '';
    }
    case 'resume': {
      const b = g.byId.get(c.bid);
      if (!b || b.dead || b.team !== team || b.built) return '建築不存在';
      if (builderOf(g, b)) return TY[b.type].name + ' 已經有工兵在蓋';
      return mine(g, team, c.ids, isWorker).length ? '' : '沒有工兵';
    }
    case 'produce': {
      const bs = mine(g, team, c.ids, e => isB(e) && e.built && (PROD[e.type] || []).includes(c.type));
      if (!bs.length) return '建築尚未完成';
      const T = TY[c.type];
      const lk = unitReq(g, team, c.type);
      if (lk) return T.name + '：' + lk;
      if (bs.every(b => b.q.length >= QUEUE_MAX)) return '佇列已滿（' + QUEUE_MAX + '）';
      if (popUsed(g, team) + (T.pop || 0) > popCap(g, team)) return '人口不足，請在主堡擴建';
      if (!afford(g, team, T.cost)) return lackMsg(g, team, T.cost);
      return '';
    }
    case 'loop': return mine(g, team, c.ids, e => isB(e) && e.built && (PROD[e.type] || []).includes(c.type)).length ? '' : '建築尚未完成';
    case 'up': {
      const bs = mine(g, team, c.ids, e => e.type === 'base' && e.built);
      if (!bs.length) return '主堡尚未完成';
      const n = nextUp(g, team, c.kind);
      if (n.max) return '已達上限';
      if (upInProgress(g, team, c.kind)) return (c.kind === 'upg' ? '主堡升級' : '擴建') + '進行中（所有主堡共用）';
      if (bs.every(b => b.q.length >= QUEUE_MAX)) return '佇列已滿（' + QUEUE_MAX + '）';
      if (!afford(g, team, n.cost)) return lackMsg(g, team, n.cost);
      return '';
    }
    case 'rally': return mine(g, team, c.ids, e => isB(e) && !!PROD[e.type]).length ? '' : '這個建築不生產單位，沒有集結點';
    case 'cancel': return mine(g, team, c.ids, e => isB(e) && e.q.length > 0).length ? '' : '沒有正在進行的製程';
    case 'cancelSite': return mine(g, team, c.ids, e => isB(e) && !e.built).length ? '' : '沒有未完成的建築';
    case 'recall': return '';
    case 'surrender': return '';
  }
}

export function apply(g: Game, team: Team, c: Cmd) {
  if (g.winner >= 0 || check(g, team, c)) return;
  switch (c.c) {
    case 'move': {
      const us = mine(g, team, c.ids, isUnit);
      for (const { e, x, y } of formSlots(g, us, px(c.x), px(c.y), c.form || 0)) setOrder(g, e, { k: 'move', x, y, amove: !!c.amove });
      break;
    }
    case 'patrol': {
      const us = mine(g, team, c.ids, isCombat);
      for (const { e, x, y } of formSlots(g, us, px(c.x), px(c.y), c.form || 0)) setOrder(g, e, { k: 'patrol', ax: e.x, ay: e.y, bx: x, by: y, leg: 1 });
      break;
    }
    case 'hold': {
      for (const e of mine(g, team, c.ids, isCombat)) setOrder(g, e, { k: 'hold', x: e.x, y: e.y });
      break;
    }
    case 'attack': {
      const t = g.byId.get(c.tid)!;
      for (const e of mine(g, team, c.ids, isUnit)) if (canHit(e, t)) setOrder(g, e, { k: 'attack', tid: t.id, auto: false });
      break;
    }
    case 'fire': {
      for (const e of mine(g, team, c.ids, isCombat)) {
        const t = acquire(g, e, px(TY[e.type].range!) + px(150));
        if (t) setOrder(g, e, { k: 'attack', tid: t.id, auto: true });
      }
      break;
    }
    case 'gather': {
      const r = g.byId.get(c.res)!;
      for (const w of mine(g, team, c.ids, isWorker)) gatherOne(g, w, r, true);
      break;
    }
    case 'return': {
      const b = g.byId.get(c.bid);
      for (const w of mine(g, team, c.ids, e => isWorker(e) && e.carry > 0)) {
        const prev = w.order.k === 'gather' ? w.order : null;
        dropJobs(g, w);
        w.order = { k: 'return', bid: b ? b.id : 0, prev };
        w.nav = null;
      }
      break;
    }
    case 'build': {
      const T = TY[c.type];
      const ws = mine(g, team, c.ids, isWorker);
      const load = (w: Ent) => (w.order.k === 'build' ? 1 : 0) + w.bq.length;
      ws.sort((a, b) => load(a) - load(b) || dist2(a.x, a.y, px(c.x), px(c.y)) - dist2(b.x, b.y, px(c.x), px(c.y)) || a.id - b.id);
      const w = ws[0];
      pay(g, team, T.cost);
      const job: BuildJob = { type: c.type, x: c.x, y: c.y };
      if (w.order.k === 'build') w.bq.push(job);
      else { dropJobs(g, w); w.order = { k: 'build', type: c.type, x: c.x, y: c.y, bid: 0 }; w.nav = null; }
      break;
    }
    case 'resume': {
      const b = g.byId.get(c.bid)!;
      const ws = mine(g, team, c.ids, isWorker).sort((a, z) => dist2(a.x, a.y, b.x, b.y) - dist2(z.x, z.y, b.x, b.y) || a.id - z.id);
      setOrder(g, ws[0], { k: 'build', type: b.type, x: Math.trunc(b.x / S), y: Math.trunc(b.y / S), bid: b.id });
      break;
    }
    case 'produce': {
      const T = TY[c.type];
      const bs = mine(g, team, c.ids, e => isB(e) && e.built && (PROD[e.type] || []).includes(c.type) && e.q.length < QUEUE_MAX);
      bs.sort((a, b) => a.q.length - b.q.length || a.id - b.id);
      pay(g, team, T.cost);
      bs[0].q.push({ kind: 'unit', type: c.type, t: 0, total: ticks(T.pt!), paid: T.cost });
      break;
    }
    case 'loop': {
      const bs = mine(g, team, c.ids, e => isB(e) && e.built && (PROD[e.type] || []).includes(c.type));
      const all = bs.every(b => b.loop === c.type);
      for (const b of bs) b.loop = all ? null : c.type;
      break;
    }
    case 'up': {
      const n = nextUp(g, team, c.kind);
      if (n.max) return;
      const bs = mine(g, team, c.ids, e => e.type === 'base' && e.built && e.q.length < QUEUE_MAX).sort((a, b) => a.q.length - b.q.length || a.id - b.id);
      pay(g, team, n.cost);
      const item: QItem = { kind: c.kind, t: 0, total: ticks(n.t), paid: n.cost };
      bs[0].q.push(item);
      break;
    }
    case 'rally': {
      for (const b of mine(g, team, c.ids, e => isB(e) && !!PROD[e.type])) b.rally = { x: px(c.x), y: px(c.y), res: c.res || 0 };
      break;
    }
    case 'cancel': {
      const bs = mine(g, team, c.ids, e => isB(e) && e.q.length > 0).sort((a, b) => b.q[0].t * a.q[0].total - a.q[0].t * b.q[0].total || a.id - b.id);
      const b = bs[0], q = b.q.shift()!;
      refund(g, team, q.paid);
      if (q.kind === 'unit' && b.loop === q.type) b.loop = null;
      break;
    }
    case 'cancelSite': {
      for (const b of mine(g, team, c.ids, e => isB(e) && !e.built)) {
        refund(g, team, TY[b.type].cost, 75);
        b.dead = true;
        const w = builderOf(g, b);
        if (w) w.order = { k: 'idle' };
      }
      break;
    }
    case 'recall': {
      for (const w of own(g, team, e => isWorker(e) && e.order.k === 'idle')) gatherOne(g, w, nearestRes(g, w), true);
      break;
    }
    case 'surrender': {
      g.winner = team === 0 ? 1 : 0;
      event(g, 'end', team, { x: 0, y: 0 }, '投降');
      break;
    }
  }
}

// ---------- 主迴圈 ----------
export interface TeamCmd { team: Team; cmd: Cmd }

export function step(g: Game, cmds: TeamCmd[] = []) {
  g.events = [];
  if (g.winner >= 0) return;
  for (const { team, cmd } of cmds) apply(g, team, cmd);
  if (g.nav.dirty) rebuildNav(g.nav, obstacles(g));
  // 先記下這一步開始時的位置：索敵與追擊都看這個快照，雙方不因處理順序而有差別
  for (const e of g.ents) { e.px = e.x; e.py = e.y; }
  for (const e of g.ents) {
    if (e.dead || isRes(e)) continue;
    if (e.cd > 0) e.cd--;
    if (isB(e)) updBuilding(g, e);
    else updUnit(g, e);
  }
  resolveHits(g);
  separate(g);
  gasTick(g);
  // 清除死亡
  let navChanged = false;
  const alive: Ent[] = [];
  for (const e of g.ents) {
    if (!e.dead) { alive.push(e); continue; }
    g.byId.delete(e.id);
    if (isB(e) || isRes(e)) navChanged = true;
    if (e.team >= 0) {
      const team = e.team as Team;
      g.teams[team].stats.lost++;
      if (e.type === 'worker') dropJobs(g, e);
      if (e.hp <= 0) event(g, 'died', team, e, TY[e.type].name + ' 被摧毀', e.type);
    }
  }
  g.ents = alive;
  if (navChanged) g.nav.dirty = true;
  if (g.tick % 4 === 0) updateFog(g);
  // 勝負：主堡（含未完成）全部被摧毀就輸
  const has0 = g.ents.some(e => e.team === 0 && e.type === 'base'), has1 = g.ents.some(e => e.team === 1 && e.type === 'base');
  if (!has0 || !has1) {
    g.winner = !has0 && !has1 ? 2 : has0 ? 0 : 1;
    event(g, 'end', 0, { x: 0, y: 0 }, '遊戲結束');
  } else if (g.tick >= TIME_LIMIT * TPS) {
    g.winner = 2;
    event(g, 'end', 0, { x: 0, y: 0 }, '時間到，和局');
  }
  g.tick++;
}

/** 全狀態雜湊（FNV-1a），用於同步校驗與測試 */
export function hash(g: Game): number {
  let h = 0x811c9dc5;
  const mix = (v: number) => { h ^= v & 0xffff; h = Math.imul(h, 16777619); h ^= (v >>> 16) & 0xffff; h = Math.imul(h, 16777619); };
  mix(g.tick); mix(g.rng); mix(g.nextId);
  for (const t of g.teams) { mix(t.scrap); mix(t.gas); mix(t.baseLv); mix(t.exp); }
  for (const e of g.ents) {
    mix(e.id); mix(e.x); mix(e.y); mix(e.hp); mix(e.amt); mix(e.carry); mix(e.prog); mix(e.q.length);
    mix(e.order.k.length + (e.order.k.charCodeAt(0) << 8));
  }
  return h >>> 0;
}

export { isqrt, dist };

// 電腦對手（普通難度）：只透過指令操作、只看得到迷霧外的東西，跟玩家一樣。
// 每 0.5 秒思考一次。決策完全由遊戲狀態決定，同一場重播結果相同。
import { MAP_H, MAP_W, PROD, TY, type TypeId } from '../sim/data';
import { S, dist2, px, randInt } from '../sim/math';
import {
  FIELD_COUNT, K, afford, baseOf, buildReq, canSee, check, fieldSpot, isB, isCombat, isRes, nextUp, own, placeCheck,
  plannedSites, popCap, popUsed, unitReq, upInProgress, type Game,
} from '../sim/sim';
import type { Cmd, Ent, Team } from '../sim/types';

const DIRS = [[1000, 0], [924, 383], [707, 707], [383, 924], [0, 1000], [-383, 924], [-707, 707], [-924, 383],
  [-1000, 0], [-924, -383], [-707, -707], [-383, -924], [0, -1000], [383, -924], [707, -707], [924, -383]];

export class Bot {
  team: Team;
  enemy: Team;
  /** 下次思考的步數 */
  next = 0;
  attacking = false;
  attackSize = 12;
  attackAfter = 240;
  init = false;
  attackStartPop = 0;
  /** 看過的敵方兵種數量（最近一次看到的最大值） */
  seen: Partial<Record<TypeId, number>> = {};
  constructor(team: Team) { this.team = team; this.enemy = team === 0 ? 1 : 0; }

  think(g: Game): Cmd[] {
    if (g.tick < this.next || g.winner >= 0) return [];
    this.next = g.tick + 10;
    if (!this.init) {
      // 每場的進攻時機與規模略有不同
      this.init = true;
      // 電腦自己的亂數（從遊戲種子衍生，不改動遊戲狀態，重播時結果一樣）
      const r = { rng: (g.seed ^ Math.imul(this.team + 1, 0x9e3779b9)) | 1 };
      this.attackSize = 10 + randInt(r, 5);
      this.attackAfter = 270 + randInt(r, 90);
    }
    const out: Cmd[] = [];
    const push = (c: Cmd) => { if (!check(g, this.team, c)) out.push(c); };
    this.scout(g);
    this.economy(g, push);
    this.buildings(g, push);
    this.army(g, push);
    return out;
  }

  private sec(g: Game) { return g.tick / 20; }

  private scout(g: Game) {
    const cnt: Partial<Record<TypeId, number>> = {};
    for (const e of g.ents) if (e.team === this.enemy && isCombat(e) && canSee(g, this.team, e)) cnt[e.type] = (cnt[e.type] || 0) + 1;
    for (const k of Object.keys(cnt) as TypeId[]) this.seen[k] = Math.max(this.seen[k] || 0, cnt[k]!);
  }

  private economy(g: Game, push: (c: Cmd) => void) {
    const t = this.team;
    const bases = own(g, t, e => e.type === 'base' && e.built);
    const workers = own(g, t, e => e.type === 'worker');
    const idle = workers.filter(w => w.order.k === 'idle');
    if (idle.length) push({ c: 'recall', ids: [] });
    const queued = bases.reduce((n, b) => n + b.q.filter(q => q.type === 'worker').length, 0);
    const want = Math.min(20, bases.length * 8 + 2);
    const room = popCap(g, t) - popUsed(g, t);
    for (const b of bases) {
      if (workers.length + queued < want && b.q.length === 0 && room > 0) push({ c: 'produce', ids: [b.id], type: 'worker' });
    }
    // 人口快滿就擴建
    const n = nextUp(g, t, 'exp');
    const margin = this.sec(g) < 240 ? 2 : 5;
    if (!n.max && room <= margin && !upInProgress(g, t, 'exp') && bases.length) push({ c: 'up', ids: bases.map(b => b.id), kind: 'exp' });
  }

  private count(g: Game, type: TypeId) {
    return own(g, this.team, e => e.type === type).length + plannedSites(g, this.team).filter(p => p.type === type).length;
  }

  private buildings(g: Game, push: (c: Cmd) => void) {
    const t = this.team, sec = this.sec(g);
    const T = g.teams[t];
    const workers = own(g, t, e => e.type === 'worker').length;
    const pumps = this.count(g, 'pump'), barracks = this.count(g, 'barracks'), airbase = this.count(g, 'airbase');
    const turrets = this.count(g, 'turret'), bases = this.count(g, 'base');
    const done = (ty: TypeId) => own(g, t, e => e.type === ty && e.built).length;
    const labs = this.count(g, 'lab');
    let want: TypeId | null = null;
    if (pumps < 1 && workers >= 5) want = 'pump';
    else if (barracks < 1) want = 'barracks';
    else if (pumps < 2 && done('barracks') >= 1) want = 'pump';
    else if (T.baseLv >= 2 && airbase < 1) want = 'airbase';
    else if (bases < 2 && sec > 330) want = 'base';
    else if (turrets < 1 && sec > 240) want = 'turret';
    else if (barracks < 2 && sec > 300 && T.scrap > 250 * K) want = 'barracks';
    else if (T.baseLv >= 3 && labs < 1) want = 'lab';
    else if (pumps < 4 && bases >= 2 && done('base') >= 2) want = 'pump';
    else if (barracks < 3 && sec > 540 && T.scrap > 400 * K) want = 'barracks';
    else if (airbase < 2 && sec > 600 && T.gas > 300 * K) want = 'airbase';
    else if (bases < 3 && sec > 720 && T.scrap > 500 * K) want = 'base';
    else if (barracks < 4 && T.scrap > 800 * K) want = 'barracks';
    // 主堡升級：Lv2 有兵營就升，Lv3 有空軍基地後，Lv4 有研究所後
    const bs = own(g, t, e => e.type === 'base' && e.built);
    const upOk = (T.baseLv === 1 && done('barracks') >= 1) || (T.baseLv === 2 && done('airbase') >= 1 && sec > 360) || (T.baseLv === 3 && done('lab') >= 1 && sec > 600);
    if (upOk && !upInProgress(g, t, 'upg') && bs.length) {
      const n = nextUp(g, t, 'upg');
      if (!n.max && afford(g, t, n.cost)) push({ c: 'up', ids: bs.map(b => b.id), kind: 'upg' });
    }
    if (!want || buildReq(g, t, want) || !afford(g, t, TY[want].cost)) return;
    const spot = want === 'base' ? this.expansionSpot(g) : this.findSpot(g, want);
    if (!spot) return;
    const w = this.pickWorker(g, spot);
    if (w) push({ c: 'build', ids: [w.id], type: want, x: spot.x, y: spot.y });
  }

  /** 依序找還沒蓋主堡的擴張點 */
  private expansionSpot(g: Game) {
    for (let i = 0; i < FIELD_COUNT; i++) {
      const s = fieldSpot(this.team, i);
      if (placeCheck(g, this.team, 'base', s.x, s.y).ok) return s;
    }
    return null;
  }

  /** 在主堡周圍找空地：優先朝地圖中央那一側，避開廢料堆，抽氣塔彼此分開 */
  private findSpot(g: Game, type: TypeId): { x: number; y: number } | null {
    const B = baseOf(this.team);
    const cx = MAP_W / 2 - B.x, cy = MAP_H / 2 - B.y;
    const dirs = DIRS.slice().sort((a, b) => (b[0] * cx + b[1] * cy) - (a[0] * cx + a[1] * cy));
    const R = TY[type].r;
    for (const r of [190, 250, 310, 370, 430, 500]) {
      for (const [dx, dy] of dirs) {
        const x = B.x + Math.trunc((dx * r) / 1000), y = B.y + Math.trunc((dy * r) / 1000);
        if (!placeCheck(g, this.team, type, x, y).ok) continue;
        let bad = false;
        for (const e of g.ents) {
          if (isRes(e) && dist2(e.x, e.y, px(x), px(y)) < px(R + 110) * px(R + 110)) { bad = true; break; }
          if (type === 'pump' && e.team === this.team && e.type === 'pump' && dist2(e.x, e.y, px(x), px(y)) < px(230) * px(230)) { bad = true; break; }
        }
        if (type === 'pump') for (const p of plannedSites(g, this.team)) if (p.type === 'pump' && (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y) < 230 * 230) bad = true;
        if (!bad) return { x, y };
      }
    }
    return null;
  }

  private pickWorker(g: Game, spot: { x: number; y: number }): Ent | null {
    const ws = own(g, this.team, e => e.type === 'worker' && e.order.k === 'gather' && !e.carry && !e.bq.length);
    let best: Ent | null = null, bd = Infinity;
    for (const w of ws) { const d = dist2(w.x, w.y, px(spot.x), px(spot.y)); if (d < bd) { bd = d; best = w; } }
    return best;
  }

  /** 選兵：先依看到的敵方兵種補剋制，其餘照固定比例補最缺的 */
  private pickUnit(g: Game, b: Ent): TypeId | null {
    const t = this.team;
    const list = (PROD[b.type] || []).filter(u => !unitReq(g, t, u) && afford(g, t, TY[u].cost));
    if (!list.length) return null;
    const army = own(g, t, isCombat);
    const n = (ty: TypeId) => army.filter(e => e.type === ty).length;
    const has = (u: TypeId) => list.includes(u);
    const seen = (...ts: TypeId[]) => ts.reduce((s, k) => s + (this.seen[k] || 0), 0);
    if (b.type === 'airbase') {
      if (has('jetpack') && n('jetpack') < 1) return 'jetpack';
      const aa = seen('srocket', 'walker', 'turbo', 'glider');
      const mix: [TypeId, number][] = aa > 8 ? [['divebomber', 2], ['glider', 5], ['turbo', 3]] : [['turbo', 5], ['glider', 3], ['divebomber', 2]];
      return this.byMix(mix.filter(([u]) => has(u)), n) || null;
    }
    const air = seen('turbo', 'glider', 'divebomber'), armored = seen('heavy', 'walker'), light = seen('rifle', 'srocket', 'biker');
    const anti = n('srocket') + n('walker') * 2;
    if (air > 0 && anti < air * 2 + 2) return has('walker') && n('walker') * 2 < n('srocket') ? 'walker' : has('srocket') ? 'srocket' : has('walker') ? 'walker' : list[0];
    if (armored >= 3 && has('srocket') && n('srocket') < armored * 2) return 'srocket';
    if (light >= 6 && has('heavy') && n('heavy') * 3 < light) return 'heavy';
    const mix: [TypeId, number][] = [['rifle', 7], ['srocket', 5], ['heavy', 3], ['biker', 3], ['walker', 2]];
    return this.byMix(mix.filter(([u]) => has(u)), n) || list[0];
  }
  private byMix(mix: [TypeId, number][], n: (t: TypeId) => number): TypeId | null {
    let best: TypeId | null = null, bs = Infinity;
    const total = mix.reduce((s, [, w]) => s + w, 0);
    const have = mix.reduce((s, [u]) => s + n(u), 0) + 1;
    for (const [u, w] of mix) { const sc = n(u) / have - w / total; if (sc < bs) { bs = sc; best = u; } }
    return best;
  }

  private army(g: Game, push: (c: Cmd) => void) {
    const t = this.team, sec = this.sec(g);
    // 生產
    const prods = own(g, t, e => isB(e) && e.built && (e.type === 'barracks' || e.type === 'airbase'));
    const B = baseOf(t), E = baseOf(this.enemy);
    const stage = { x: B.x + Math.trunc((MAP_W / 2 - B.x) / 4), y: B.y + Math.trunc((MAP_H / 2 - B.y) / 4) };
    for (const b of prods) {
      if (!b.rally) push({ c: 'rally', ids: [b.id], x: stage.x, y: stage.y });
      if (b.q.length >= 2) continue;
      if (b.type === 'airbase' && (this.seen.srocket || 0) > 6) continue;
      const u = this.pickUnit(g, b);
      if (u) push({ c: 'produce', ids: [b.id], type: u });
    }
    // 噴射包兵沒有攻擊力，拿來在中路與敵方擴張點之間巡邏偵察
    for (const j of own(g, t, e => e.type === 'jetpack' && e.order.k === 'idle')) {
      const s = fieldSpot(this.enemy, 0);
      push({ c: 'patrol', ids: [j.id], x: s.x, y: s.y });
    }
    const army = own(g, t, e => isCombat(e) && e.type !== 'jetpack');
    const pop = army.reduce((s, e) => s + (TY[e.type].pop || 0), 0);
    // 防守：己方建築附近有敵人
    const mine = own(g, t, isB);
    let threat: Ent | null = null;
    for (const e of g.ents) {
      if (e.team !== this.enemy || !canSee(g, t, e)) continue;
      if (mine.some(b => dist2(b.x, b.y, e.x, e.y) < px(700) * px(700))) { threat = e; break; }
    }
    if (threat && !this.attacking) {
      const ids = army.filter(e => e.order.k !== 'attack').map(e => e.id);
      if (ids.length) push({ c: 'move', ids, x: Math.trunc(threat.x / S), y: Math.trunc(threat.y / S), amove: true });
      return;
    }
    if (!this.attacking && pop >= this.attackSize && sec > this.attackAfter) {
      this.attacking = true;
      this.attackStartPop = pop;
    }
    if (this.attacking) {
      if (pop < Math.max(4, Math.trunc((this.attackStartPop * 35) / 100))) {
        // 打不過就撤退，下一波帶更多兵
        this.attacking = false;
        this.attackSize += 6;
        push({ c: 'move', ids: army.map(e => e.id), x: stage.x, y: stage.y });
        return;
      }
      // 目標：看得到的最近敵方建築，否則敵方主堡位置
      let tx = E.x, ty = E.y, bd = Infinity;
      const c = centroid(army);
      for (const e of g.ents) {
        if (e.team !== this.enemy || !isB(e) || !canSee(g, t, e)) continue;
        const d = dist2(e.x, e.y, c.x, c.y);
        if (d < bd) { bd = d; tx = Math.trunc(e.x / S); ty = Math.trunc(e.y / S); }
      }
      const ids = army.filter(e => e.order.k === 'idle' || (e.order.k === 'move' && !e.order.amove)).map(e => e.id);
      if (ids.length) push({ c: 'move', ids, x: tx, y: ty, amove: true });
      // 單位集中：落後太多的單位先等
      return;
    }
    // 平時：在集結點待命；新兵自動過去
    const strays = army.filter(e => e.order.k === 'idle' && dist2(e.x, e.y, px(stage.x), px(stage.y)) > px(400) * px(400));
    if (strays.length) push({ c: 'move', ids: strays.map(e => e.id), x: stage.x, y: stage.y });
  }
}

function centroid(list: Ent[]) {
  let x = 0, y = 0;
  for (const e of list) { x += e.x; y += e.y; }
  return { x: Math.trunc(x / Math.max(1, list.length)), y: Math.trunc(y / Math.max(1, list.length)) };
}


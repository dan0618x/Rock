// 畫面層的狀態：選取、編隊、模式、事件、鏡頭。這些都不進模擬。
import { Bot } from '../bot/bot';
import { MAP_H, MAP_W, type TypeId } from '../sim/data';
import { S as SUB } from '../sim/math';
import { check, createGame, isB, isCombat, isUnit, type Game } from '../sim/sim';
import type { Cmd, Ent, Form } from '../sim/types';

export const W = MAP_W, H = MAP_H;
export const ME = 0 as const;

export type Mode =
  | null
  | { k: 'attack' }
  | { k: 'gather' }
  | { k: 'patrol' }
  | { k: 'place'; type: TypeId; x: number; y: number };

export interface UiEvent { x: number; y: number; text: string; kind: string; t: number }
export interface Fx { x: number; y: number; t0: number; c: number; r: number; kind: 'marker' | 'boom' }

export const st = {
  g: null as unknown as Game,
  bot: null as unknown as Bot,
  sel: new Set<number>(),
  slots: [[], [], [], [], []] as number[][],
  mode: null as Mode,
  events: [] as UiEvent[],
  fx: [] as Fx[],
  pending: [] as Cmd[],
  /** 0 = 進行中；暫停原因 */
  paused: false,
  started: false,
  /** 記得的敵方建築（看過但現在看不到） */
  ghosts: new Map<number, { type: TypeId; x: number; y: number; r: number }>(),
  settings: { sound: true, haptic: true },
  /** 部隊移動的隊形：0 方陣、1 橫列、2 散開 */
  form: 0 as Form,
};

export const cam = { x: 650, y: 1800, z: 1 };
export const view = { w: 0, h: 0 };
export const PAD = { l: 0, r: 0, t: 0, b: 0 };

export function newGame() {
  st.g = createGame((Date.now() & 0x7fffffff) | 1);
  st.bot = new Bot(1);
  st.sel = new Set();
  st.slots = [[], [], [], [], []];
  st.mode = null;
  st.events = [];
  st.fx = [];
  st.pending = [];
  st.ghosts = new Map();
}

export const now = () => performance.now();
/** 實體目前位置（像素） */
export const ex = (e: Ent) => e.x / SUB;
export const ey = (e: Ent) => e.y / SUB;
export const er = (e: Ent) => e.r / SUB;

export const selEnts = () => {
  const out: Ent[] = [];
  for (const id of st.sel) { const e = st.g.byId.get(id); if (e && !e.dead && e.team === ME) out.push(e); }
  return out;
};
export const own = (f: (e: Ent) => boolean) => st.g.ents.filter(e => e.team === ME && !e.dead && f(e));

export type SelKind =
  | { k: 'none'; es: Ent[] }
  | { k: 'bld'; type: TypeId; es: Ent[] }
  | { k: 'worker'; es: Ent[] }
  | { k: 'army'; es: Ent[] };

export function selKind(): SelKind {
  const es = selEnts();
  if (!es.length) return { k: 'none', es };
  if (es.every(isB)) {
    const m = countBy(es);
    let t: TypeId = es[0].type, n = 0;
    m.forEach((v, k) => { if (v > n) { n = v; t = k; } });
    return { k: 'bld', type: t, es: es.filter(b => b.type === t) };
  }
  const us = es.filter(isUnit);
  if (us.every(e => e.type === 'worker')) return { k: 'worker', es: us };
  return { k: 'army', es: us };
}
export function countBy(list: Ent[]) {
  const m = new Map<TypeId, number>();
  for (const e of list) m.set(e.type, (m.get(e.type) || 0) + 1);
  return m;
}
export function centroid(list: Ent[]) {
  let x = 0, y = 0;
  for (const e of list) { x += ex(e); y += ey(e); }
  return { x: x / list.length, y: y / list.length };
}
export const isFiring = (es: Ent[]) => (st.mode && st.mode.k === 'attack') || es.some(e => isCombat(e) && e.order.k === 'attack');

/** 送出指令：先檢查，不行就回傳原因（給提示用） */
export function issue(c: Cmd): string {
  const err = check(st.g, ME, c);
  if (!err) st.pending.push(c);
  return err;
}

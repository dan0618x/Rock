import type { TypeId } from './data';

export type Team = 0 | 1;
/** 隊形：0 方陣、1 橫列、2 散開 */
export type Form = 0 | 1 | 2;

export interface BuildJob { type: TypeId; x: number; y: number }

export type Order =
  | { k: 'idle' }
  | { k: 'move'; x: number; y: number; amove: boolean; best?: number; stall?: number }
  | { k: 'patrol'; ax: number; ay: number; bx: number; by: number; leg: 0 | 1; best?: number; stall?: number }
  | { k: 'hold'; x: number; y: number }
  | { k: 'attack'; tid: number; auto: boolean; hx?: number; hy?: number; resume?: Order }
  | { k: 'gather'; res: number; st: 'to' | 'mine' | 'back'; t: number; base: number }
  | { k: 'return'; bid: number; prev: Order | null }
  | { k: 'build'; type: TypeId; x: number; y: number; bid: number };

export interface QItem {
  kind: 'unit' | 'upg' | 'exp';
  type?: TypeId;
  t: number;
  total: number;
  /** 付出的費用（取消時全額退回） */
  paid: [number, number];
}

export interface Nav { tx: number; ty: number; pts: number[]; i: number; ver: number }

export interface Ent {
  id: number;
  type: TypeId;
  team: Team | -1;
  /** 位置（模擬單位） */
  x: number;
  y: number;
  /** 上一步的位置，畫面補間用 */
  px: number;
  py: number;
  /** 面向（最後一次移動或瞄準的方向向量） */
  fx: number;
  fy: number;
  /** 血量（×10） */
  hp: number;
  maxHp: number;
  r: number;
  built: boolean;
  /** 建造進度（步） */
  prog: number;
  cd: number;
  order: Order;
  bq: BuildJob[];
  q: QItem[];
  loop: TypeId | null;
  rally: { x: number; y: number; res: number } | null;
  carry: number;
  amt: number;
  nav: Nav | null;
  /** 抽氣塔目前產量（每秒 ×1000） */
  rate: number;
  /** 最近一次開火的步數，畫面畫彈道用 */
  shotAt: number;
  shotTid: number;
  /** 最近一次被打的步數 */
  hitAt: number;
  dead: boolean;
}

export interface TeamState {
  /** 資源（×1000） */
  scrap: number;
  gas: number;
  baseLv: number;
  exp: number;
  /** 統計 */
  stats: { made: number; lost: number; killed: number; mined: number; gassed: number };
}

export type Cmd =
  | { c: 'move'; ids: number[]; x: number; y: number; amove?: boolean; form?: Form }
  | { c: 'patrol'; ids: number[]; x: number; y: number; form?: Form }
  | { c: 'hold'; ids: number[] }
  | { c: 'attack'; ids: number[]; tid: number }
  | { c: 'fire'; ids: number[] }
  | { c: 'gather'; ids: number[]; res: number }
  | { c: 'return'; ids: number[]; bid: number }
  | { c: 'build'; ids: number[]; type: TypeId; x: number; y: number }
  | { c: 'resume'; ids: number[]; bid: number }
  | { c: 'produce'; ids: number[]; type: TypeId }
  | { c: 'loop'; ids: number[]; type: TypeId }
  | { c: 'up'; ids: number[]; kind: 'upg' | 'exp' }
  | { c: 'rally'; ids: number[]; x: number; y: number; res?: number }
  | { c: 'cancel'; ids: number[] }
  | { c: 'cancelSite'; ids: number[] }
  | { c: 'recall'; ids: number[] }
  | { c: 'surrender' };

export interface SimEvent {
  k: 'attacked' | 'fail' | 'built' | 'upgraded' | 'died' | 'end';
  team: Team;
  x: number;
  y: number;
  type?: TypeId;
  text: string;
}

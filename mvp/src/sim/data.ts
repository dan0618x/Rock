// MVP 數值表（拾荒者內戰）。人類可讀單位：像素、秒、整數資源。
// 之後由設計總表匯出成這個檔案。

export type Cat = 'building' | 'worker' | 'ground' | 'air' | 'res';
export type Armor = 'light' | 'armored' | 'air' | 'structure';
export type AtkType = 'bullet' | 'explosive' | 'impact';

export interface TypeDef {
  cat: Cat;
  name: string;
  ch: string;
  hp: number;
  r: number;
  sight: number;
  armor: Armor;
  cost: [number, number];
  pop?: number;
  /** 生產時間（秒） */
  pt?: number;
  /** 建造時間（秒） */
  bt?: number;
  speed?: number;
  range?: number;
  dmg?: number;
  cd?: number;
  atk?: AtkType;
  ag?: boolean;
  aa?: boolean;
}

export type TypeId =
  | 'base' | 'barracks' | 'airbase' | 'turret' | 'pump'
  | 'worker' | 'rifle' | 'srocket' | 'heavy' | 'turbo'
  | 'scrap';

export const TY: Record<TypeId, TypeDef> = {
  base:     { cat: 'building', name: '主堡', ch: '堡', hp: 1500, r: 58, sight: 360, armor: 'structure', cost: [400, 0], bt: 60 },
  barracks: { cat: 'building', name: '兵營', ch: '營', hp: 900, r: 44, sight: 240, armor: 'structure', cost: [150, 0], bt: 30 },
  airbase:  { cat: 'building', name: '空軍基地', ch: '空', hp: 800, r: 44, sight: 240, armor: 'structure', cost: [150, 100], bt: 35 },
  turret:   { cat: 'building', name: '砲塔', ch: '砲', hp: 500, r: 26, sight: 300, armor: 'structure', cost: [100, 0], bt: 20, range: 210, dmg: 12, cd: 1, atk: 'bullet', ag: true, aa: true },
  pump:     { cat: 'building', name: '抽氣塔', ch: '抽', hp: 300, r: 22, sight: 200, armor: 'structure', cost: [75, 0], bt: 15 },
  worker:   { cat: 'worker', name: '工兵', ch: '工', hp: 40, r: 12, sight: 200, armor: 'light', cost: [50, 0], pop: 1, pt: 10, speed: 85, range: 24, dmg: 3, cd: 1, atk: 'bullet', ag: true },
  rifle:    { cat: 'ground', name: '槍兵', ch: '槍', hp: 55, r: 13, sight: 260, armor: 'light', cost: [50, 0], pop: 1, pt: 12, speed: 80, range: 110, dmg: 6, cd: 0.8, atk: 'bullet', ag: true },
  srocket:  { cat: 'ground', name: '火箭兵', ch: '火', hp: 55, r: 14, sight: 260, armor: 'light', cost: [75, 25], pop: 1, pt: 15, speed: 72, range: 150, dmg: 12, cd: 1.5, atk: 'explosive', ag: true, aa: true },
  heavy:    { cat: 'ground', name: '重甲兵', ch: '甲', hp: 260, r: 17, sight: 220, armor: 'armored', cost: [100, 25], pop: 2, pt: 18, speed: 60, range: 40, dmg: 16, cd: 0.9, atk: 'impact', ag: true },
  turbo:    { cat: 'air', name: '渦輪機翼兵', ch: '渦', hp: 90, r: 15, sight: 320, armor: 'air', cost: [100, 50], pop: 2, pt: 18, speed: 115, range: 120, dmg: 7, cd: 0.6, atk: 'bullet', ag: true, aa: true },
  scrap:    { cat: 'res', name: '廢料堆', ch: '', hp: 1, r: 22, sight: 0, armor: 'structure', cost: [0, 0] },
};

/** 攻擊類型 × 護甲類型（百分比） */
export const VS: Record<AtkType, Record<Armor, number>> = {
  bullet:    { light: 100, armored: 50, air: 100, structure: 50 },
  explosive: { light: 60, armored: 150, air: 150, structure: 100 },
  impact:    { light: 130, armored: 100, air: 0, structure: 120 },
};

export const PROD: Partial<Record<TypeId, TypeId[]>> = {
  base: ['worker'],
  barracks: ['rifle', 'srocket', 'heavy'],
  airbase: ['turbo'],
};
export const BUILDS: TypeId[] = ['barracks', 'airbase', 'turret', 'pump', 'base'];
/** 建築需要的主堡等級 */
export const BUILD_REQ: Partial<Record<TypeId, number>> = { airbase: 2 };
/** 兵種解鎖：lv＝主堡等級，b＝需要已完成的建築 */
export const UNIT_REQ: Partial<Record<TypeId, { lv?: number; b?: TypeId }>> = {
  srocket: { lv: 2 },
  heavy: { b: 'airbase' },
};

export const START = { scrap: 250, gas: 50, workers: 3 };
export const MINE_CAP = 8;
export const MINE_TIME = 1.6;
export const CARRY = 5;
export const SCRAP_AMT = 1500;
/** 抽氣塔：每秒產量，範圍內每多一座 -40%（最低 20%） */
export const PUMP = { rate: 1.2, radius: 110, overlap: 40, floor: 20 };

/** MVP 主堡最高到 Lv2（Lv3 研究所、Lv4 特殊單位不在 MVP 範圍） */
export const BASE_UP = { cost: [[150, 50]] as [number, number][], t: [25], unlock: ['空軍基地、火箭兵'] };
export const EXPAND = { add: [5, 10, 10, 15], cost: [[50, 0], [100, 0], [150, 50], [200, 100]] as [number, number][], t: [10, 12, 15, 18] };
export const POP_START = 10;
export const QUEUE_MAX = 5;

/** 地圖（像素） */
export const MAP_W = 3400, MAP_H = 2240;
/** 超過這個時間（秒）還沒分出勝負就判和局 */
export const TIME_LIMIT = 40 * 60;

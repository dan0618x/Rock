// 地圖：4000×4000 方形，兩邊完全點對稱（隊伍 1 的東西是隊伍 0 的點對稱）。
// 地形是一串圓形：岩脊擋地面不擋空軍；酸池一樣擋地面，只是畫法不同。
import { MAP_H, MAP_W } from './data';

export interface Terrain { x: number; y: number; r: number; kind: 'rock' | 'acid' }
export interface Field { spot: { x: number; y: number }; piles: { x: number; y: number }[] }

export const mirror = (x: number, y: number) => ({ x: MAP_W - x, y: MAP_H - y });

/** 以 spot 為中心、朝 angle 方向（度，y 向下）張開 120 度擺 5 堆廢料 */
function arc(sx: number, sy: number, angle: number, r = 195, n = 5, spread = 120): { x: number; y: number }[] {
  // 用固定的角度表（每 15 度，×1000），不在模擬裡用三角函數
  const CS = [[1000, 0], [966, 259], [866, 500], [707, 707], [500, 866], [259, 966], [0, 1000], [-259, 966], [-500, 866], [-707, 707], [-866, 500], [-966, 259],
    [-1000, 0], [-966, -259], [-866, -500], [-707, -707], [-500, -866], [-259, -966], [0, -1000], [259, -966], [500, -866], [707, -707], [866, -500], [966, -259]];
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = (((angle - spread / 2 + (spread / (n - 1)) * i) % 360) + 360) % 360;
    const [c, si] = CS[Math.round(a / 15) % 24];
    out.push({ x: sx + Math.trunc((c * r) / 1000), y: sy + Math.trunc((si * r) / 1000) });
  }
  return out;
}

/** 一段岩脊：從 a 到 b 每隔 step 放一個圓 */
function ridge(ax: number, ay: number, bx: number, by: number, r: number, kind: Terrain['kind'] = 'rock'): Terrain[] {
  const out: Terrain[] = [];
  const dx = bx - ax, dy = by - ay;
  const len = Math.max(Math.abs(dx), Math.abs(dy));
  const n = Math.max(1, Math.round(len / (r * 1.2)));
  for (let i = 0; i <= n; i++) out.push({ x: ax + Math.trunc((dx * i) / n), y: ay + Math.trunc((dy * i) / n), r, kind });
  return out;
}

/** 隊伍 0 的主堡（左下）；隊伍 1 在右上 */
export const BASE0 = { x: 560, y: 3440 };
export const BASE1 = mirror(BASE0.x, BASE0.y);

/** 主堡廢料（朝角落） */
export const MAIN_PILES0 = arc(BASE0.x, BASE0.y, 135, 210);

/** 擴張點：隊伍 0 那一側的位置；隊伍 1 取點對稱。順序就是電腦擴張的順序 */
const FIELDS0: Field[] = [
  // 自然擴張：出坡道往右，靠地圖下緣
  { spot: { x: 1760, y: 3470 }, piles: arc(1760, 3470, 90) },
  // 左側擴張：主堡北邊岩脊外
  { spot: { x: 470, y: 2230 }, piles: arc(470, 2230, 180) },
  // 爭奪點：左上角（與隊伍 1 的右下角對稱，兩邊距離相同）
  { spot: { x: 820, y: 820 }, piles: arc(820, 820, 225) },
];
export const FIELDS: [Field[], Field[]] = [
  FIELDS0,
  FIELDS0.map(f => ({ spot: mirror(f.spot.x, f.spot.y), piles: f.piles.map(p => mirror(p.x, p.y)) })),
];

const TERRAIN0: Terrain[] = [
  // 主堡高地：北邊與東邊的岩脊，中間留一個約 300 寬的坡道
  ...ridge(0, 2760, 880, 2760, 70),
  ...ridge(1240, 4000, 1240, 3120, 70),
  // 左側擴張與爭奪點之間的岩石
  ...ridge(260, 1560, 700, 1480, 80),
  // 中央偏左下的岩群與小酸池，把路分成幾條
  ...ridge(1380, 2480, 1600, 2700, 85),
  { x: 1180, y: 2050, r: 120, kind: 'acid' },
  { x: 2050, y: 3150, r: 100, kind: 'rock' },
  { x: 2200, y: 3260, r: 80, kind: 'rock' },
  { x: 2700, y: 3600, r: 130, kind: 'acid' },
];
/** 地圖正中央的酸池（自己就是點對稱，不用鏡射） */
const CENTER: Terrain[] = [{ x: MAP_W / 2, y: MAP_H / 2, r: 230, kind: 'acid' }];

export const TERRAIN: Terrain[] = [...TERRAIN0, ...TERRAIN0.map(t => ({ ...mirror(t.x, t.y), r: t.r, kind: t.kind })), ...CENTER];

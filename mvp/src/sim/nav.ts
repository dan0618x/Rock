// 尋路：建築、廢料堆、地形在格子地圖上標成障礙，地面單位用 A* 找大方向；
// 能不能直線走則用真正的圓形障礙判斷（不用格子），路徑才會貼著障礙走，不會繞大圈。
import { MAP_H, MAP_W } from './data';
import { S, dist2 } from './math';

export const CELL = 40 * S;
export const GW = Math.ceil(MAP_W / 40), GH = Math.ceil(MAP_H / 40);

export interface Obstacle { x: number; y: number; r: number; id: number }
export interface NavGrid { g: Uint8Array; obs: Obstacle[]; ver: number; dirty: boolean }

export const newNav = (): NavGrid => ({ g: new Uint8Array(GW * GH), obs: [], ver: 0, dirty: true });

/** 格子：中心點離障礙邊緣不到半格加單位寬就算擋住 */
export function rebuildNav(nav: NavGrid, obstacles: Obstacle[]) {
  const g = nav.g;
  g.fill(0);
  nav.obs = obstacles;
  const pad = 18 * S;
  for (const o of obstacles) {
    const R = o.r + pad, R2 = R * R;
    const x0 = Math.max(0, Math.floor((o.x - R) / CELL)), x1 = Math.min(GW - 1, Math.floor((o.x + R) / CELL));
    const y0 = Math.max(0, Math.floor((o.y - R) / CELL)), y1 = Math.min(GH - 1, Math.floor((o.y + R) / CELL));
    for (let gy = y0; gy <= y1; gy++)
      for (let gx = x0; gx <= x1; gx++)
        if (dist2(gx * CELL + CELL / 2, gy * CELL + CELL / 2, o.x, o.y) < R2) g[gy * GW + gx] = 1;
  }
  nav.dirty = false;
  nav.ver++;
}

export function blockedAt(nav: NavGrid, x: number, y: number) {
  const gx = Math.floor(x / CELL), gy = Math.floor(y / CELL);
  return gx < 0 || gy < 0 || gx >= GW || gy >= GH || nav.g[gy * GW + gx] === 1;
}

/** 點到線段距離的平方 */
function segDist2(ax: number, ay: number, bx: number, by: number, cx: number, cy: number) {
  const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
  const num = (cx - ax) * dx + (cy - ay) * dy;
  if (len2 === 0 || num <= 0) return dist2(ax, ay, cx, cy);
  if (num >= len2) return dist2(bx, by, cx, cy);
  const t = num / len2, px = ax + dx * t, py = ay + dy * t;
  return (cx - px) * (cx - px) + (cy - py) * (cy - py);
}

/** 半徑 rad 的單位能不能從 a 直線走到 b；ign 是目的地本身（例如要採的廢料堆），不算擋路 */
export function los(nav: NavGrid, ax: number, ay: number, bx: number, by: number, rad: number, ignId = 0) {
  const minX = Math.min(ax, bx), maxX = Math.max(ax, bx), minY = Math.min(ay, by), maxY = Math.max(ay, by);
  for (const o of nav.obs) {
    if (o.id === ignId && ignId) continue;
    const m = o.r + rad;
    if (o.x + m < minX || o.x - m > maxX || o.y + m < minY || o.y - m > maxY) continue;
    // 起點已經貼著或卡在障礙裡時，只要不是往障礙裡面走就放行
    if (dist2(ax, ay, o.x, o.y) < m * m && dist2(bx, by, o.x, o.y) >= dist2(ax, ay, o.x, o.y)) continue;
    if (segDist2(ax, ay, bx, by, o.x, o.y) < m * m) return false;
  }
  return true;
}

/** 這個點有沒有在障礙裡（給隊形位置用） */
export function insideObstacle(nav: NavGrid, x: number, y: number, rad: number) {
  for (const o of nav.obs) { const m = o.r + rad; if (dist2(x, y, o.x, o.y) < m * m) return true; }
  return x < rad || y < rad || x > MAP_W * S - rad || y > MAP_H * S - rad;
}

function nearFreeCell(nav: NavGrid, gx: number, gy: number): number {
  if (gx >= 0 && gy >= 0 && gx < GW && gy < GH && !nav.g[gy * GW + gx]) return gy * GW + gx;
  for (let r = 1; r < 14; r++) {
    let best = -1, bd = 1e9;
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = gx + dx, y = gy + dy;
        if (x < 0 || y < 0 || x >= GW || y >= GH || nav.g[y * GW + x]) continue;
        const dd = dx * dx + dy * dy;
        if (dd < bd) { bd = dd; best = y * GW + x; }
      }
    if (best >= 0) return best;
  }
  return -1;
}
/** 最近的空地（格子中心，模擬單位） */
export function nearFree(nav: NavGrid, x: number, y: number) {
  const i = nearFreeCell(nav, Math.floor(x / CELL), Math.floor(y / CELL));
  if (i < 0) return { x, y };
  return { x: (i % GW) * CELL + CELL / 2, y: Math.trunc(i / GW) * CELL + CELL / 2 };
}

const gs = new Int32Array(GW * GH), from = new Int32Array(GW * GH), closed = new Uint8Array(GW * GH);
const DIRS = [[1, 0, 10], [-1, 0, 10], [0, 1, 10], [0, -1, 10], [1, 1, 14], [1, -1, 14], [-1, 1, 14], [-1, -1, 14]];

/** 回傳拉直後的路徑點 [x0,y0,x1,y1,...]（模擬單位），最後一點是目標 */
export function findPath(nav: NavGrid, sx: number, sy: number, tx: number, ty: number, rad: number, ignId = 0): number[] {
  const si = nearFreeCell(nav, Math.floor(sx / CELL), Math.floor(sy / CELL));
  const gi = nearFreeCell(nav, Math.floor(tx / CELL), Math.floor(ty / CELL));
  if (si < 0 || gi < 0) return [tx, ty];
  gs.fill(0x3fffffff); from.fill(-1); closed.fill(0);
  const gx = gi % GW, gy = Math.trunc(gi / GW);
  const h = (i: number) => {
    const dx = Math.abs((i % GW) - gx), dy = Math.abs(Math.trunc(i / GW) - gy);
    return 10 * Math.max(dx, dy) + 4 * Math.min(dx, dy);
  };
  // 二元堆積：[f, 序號, 格子]；同分時依加入順序，確保結果固定
  const heap: number[][] = [];
  let seq = 0;
  const less = (a: number[], b: number[]) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
  const push = (i: number, f: number) => {
    heap.push([f, seq++, i]);
    let k = heap.length - 1;
    while (k > 0) { const p = (k - 1) >> 1; if (!less(heap[k], heap[p])) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1, r = l + 1;
        let m = k;
        if (l < heap.length && less(heap[l], heap[m])) m = l;
        if (r < heap.length && less(heap[r], heap[m])) m = r;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k], heap[m]];
        k = m;
      }
    }
    return top;
  };
  gs[si] = 0;
  push(si, h(si));
  let found = false;
  while (heap.length) {
    const i = pop()[2];
    if (closed[i]) continue;
    closed[i] = 1;
    if (i === gi) { found = true; break; }
    const x = i % GW, y = Math.trunc(i / GW);
    for (const [dx, dy, c] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue;
      const ni = ny * GW + nx;
      if (nav.g[ni] || closed[ni]) continue;
      if (dx && dy && (nav.g[y * GW + nx] || nav.g[ny * GW + x])) continue;
      const ng = gs[i] + c;
      if (ng < gs[ni]) { gs[ni] = ng; from[ni] = i; push(ni, ng + h(ni)); }
    }
  }
  if (!found) return [tx, ty];
  const cells: number[] = [];
  for (let i = gi; i !== -1; i = from[i]) cells.push((i % GW) * CELL + CELL / 2, Math.trunc(i / GW) * CELL + CELL / 2);
  const pts: number[] = [];
  for (let k = cells.length - 2; k >= 0; k -= 2) pts.push(cells[k], cells[k + 1]);
  pts.push(tx, ty);
  // 拉直：從目前的點一路往前看，看得到的點就跳過，看不到才在上一點轉彎
  const out: number[] = [];
  const n = pts.length / 2;
  let ax = sx, ay = sy, i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && los(nav, ax, ay, pts[(j + 1) * 2], pts[(j + 1) * 2 + 1], rad, j + 1 === n - 1 ? ignId : 0)) j++;
    out.push(pts[j * 2], pts[j * 2 + 1]);
    ax = pts[j * 2]; ay = pts[j * 2 + 1];
    i = j + 1;
  }
  return out;
}

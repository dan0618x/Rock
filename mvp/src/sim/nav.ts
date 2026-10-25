// 尋路：建築與廢料堆在格子地圖上標成障礙，地面單位用 A* 繞路，再把路徑拉直。
import { MAP_H, MAP_W } from './data';
import { S, dist2, isqrt } from './math';

export const CELL = 40 * S;
export const GW = Math.ceil(MAP_W / 40), GH = Math.ceil(MAP_H / 40);

export interface NavGrid { g: Uint8Array; ver: number; dirty: boolean }

export const newNav = (): NavGrid => ({ g: new Uint8Array(GW * GH), ver: 0, dirty: true });

export function rebuildNav(nav: NavGrid, obstacles: { x: number; y: number; r: number }[]) {
  const g = nav.g;
  g.fill(0);
  const pad = 14 * S + Math.trunc((CELL * 35) / 100);
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

/** 兩點之間直線是否暢通；ign 是目的地本身（例如要採的廢料堆），它周圍不算擋路 */
export function los(nav: NavGrid, ax: number, ay: number, bx: number, by: number, ign?: { x: number; y: number; r: number } | null) {
  const d = isqrt(dist2(ax, ay, bx, by)), step = 12 * S, n = Math.ceil(d / step);
  const ir = ign ? ign.r + 34 * S : 0;
  for (let i = 1; i < n; i++) {
    const x = ax + Math.trunc(((bx - ax) * i) / n), y = ay + Math.trunc(((by - ay) * i) / n);
    if (ign && dist2(x, y, ign.x, ign.y) < ir * ir) continue;
    if (blockedAt(nav, x, y)) return false;
  }
  return true;
}

function nearFree(nav: NavGrid, gx: number, gy: number): number {
  if (gx >= 0 && gy >= 0 && gx < GW && gy < GH && !nav.g[gy * GW + gx]) return gy * GW + gx;
  for (let r = 1; r < 10; r++) {
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

const gs = new Int32Array(GW * GH), from = new Int32Array(GW * GH), closed = new Uint8Array(GW * GH);
const DIRS = [[1, 0, 10], [-1, 0, 10], [0, 1, 10], [0, -1, 10], [1, 1, 14], [1, -1, 14], [-1, 1, 14], [-1, -1, 14]];

/** 回傳拉直後的路徑點 [x0,y0,x1,y1,...]（模擬單位），最後一點是目標 */
export function findPath(nav: NavGrid, sx: number, sy: number, tx: number, ty: number, ign?: { x: number; y: number; r: number } | null): number[] {
  const si = nearFree(nav, Math.floor(sx / CELL), Math.floor(sy / CELL));
  const gi = nearFree(nav, Math.floor(tx / CELL), Math.floor(ty / CELL));
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
  // 拉直：能直線走到的點就略過中間的格子
  const out: number[] = [];
  let cx = sx, cy = sy, k = 0;
  const n = pts.length / 2;
  while (k < n) {
    let j = n - 1;
    while (j > k && !los(nav, cx, cy, pts[j * 2], pts[j * 2 + 1], j === n - 1 ? ign : null)) j--;
    out.push(pts[j * 2], pts[j * 2 + 1]);
    cx = pts[j * 2]; cy = pts[j * 2 + 1];
    k = j + 1;
  }
  return out;
}

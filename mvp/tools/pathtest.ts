// 路徑測試：從各地點走到各地點，記錄花費時間與實際路程 / 直線距離
import { createGame, spawn, step, baseOf, fieldSpot } from '../src/sim/sim';
const pts: Record<string, { x: number; y: number }> = {
  base0: baseOf(0), base1: baseOf(1), nat0: fieldSpot(0, 0), nat1: fieldSpot(1, 0), side0: fieldSpot(0, 1), mid0: fieldSpot(0, 2), mid1: fieldSpot(1, 2),
};
const pairs = [['base0', 'base1'], ['base0', 'nat0'], ['base0', 'side0'], ['nat0', 'mid1'], ['side0', 'mid0'], ['base0', 'mid1']];
for (const [a, b] of pairs) {
  const g = createGame(1);
  const A = pts[a], B = pts[b];
  const u = spawn(g, 'rifle', 0, A.x + 120, A.y - 120);
  step(g, [{ team: 0, cmd: { c: 'move', ids: [u.id], x: B.x - 120, y: B.y + 120 } }]);
  let path = 0, lx = u.x, ly = u.y, t = 0;
  while (u.order.k === 'move' && t < 20 * 240) { step(g); path += Math.hypot(u.x - lx, u.y - ly) / 16; lx = u.x; ly = u.y; t++; }
  const direct = Math.hypot(A.x - B.x, A.y - B.y);
  const left = Math.hypot(u.x / 16 - (B.x - 120), u.y / 16 - (B.y + 120));
  console.log(`${a}→${b}: ${(t / 20).toFixed(0)}s, path ${path.toFixed(0)} / direct ${direct.toFixed(0)} = ${(path / direct).toFixed(2)}, end ${left.toFixed(0)}px from goal, order ${u.order.k}`);
}

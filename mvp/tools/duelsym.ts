// 鏡像對稱的同兵種對戰：找出第一個不對稱的步數（對稱中心 1320,1320，附近沒有地形）
import { createGame, own, spawn, step } from '../src/sim/sim';
const t = process.argv[2] || 'rifle', n = Number(process.argv[3] || 6);
const g = createGame(1);
for (let i = 0; i < n; i++) spawn(g, t as any, 0, 1020 + (i % 4) * 30, 1300 + Math.floor(i / 4) * 30);
for (let i = 0; i < n; i++) spawn(g, t as any, 1, 2640 - (1020 + (i % 4) * 30), 2640 - (1300 + Math.floor(i / 4) * 30));
const A = own(g, 0, e => e.type === t), B = own(g, 1, e => e.type === t);
const W = 2640 * 16, H = 2640 * 16;
step(g, [{ team: 0, cmd: { c: 'move', ids: A.map(e => e.id), x: 1420, y: 1310, amove: true } }, { team: 1, cmd: { c: 'move', ids: B.map(e => e.id), x: 1220, y: 1330, amove: true } }]);
for (let k = 0; k < 1200; k++) {
  const a = g.ents.filter(e => e.team === 0 && e.type === t).map(e => `${e.x},${e.y}:${e.hp}:${e.order.k}`).sort();
  const b = g.ents.filter(e => e.team === 1 && e.type === t).map(e => `${W - e.x},${H - e.y}:${e.hp}:${e.order.k}`).sort();
  if (a.join('|') !== b.join('|')) { console.log('diverge tick', g.tick); console.log(a.filter(x => !b.includes(x))); console.log(b.filter(x => !a.includes(x))); break; }
  step(g);
}
console.log('left', own(g, 0, e => e.type === t).length, own(g, 1, e => e.type === t).length);

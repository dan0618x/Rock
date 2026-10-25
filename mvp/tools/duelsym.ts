import { createGame, own, spawn, step } from '../src/sim/sim';
const g = createGame(1);
g.ents = g.ents.filter(e => e.type === 'base'); // 只留主堡，避免廢料堆影響
g.byId = new Map(g.ents.map(e => [e.id, e]));
g.nav.dirty = true;
const t = process.argv[2] || 'rifle', n = 6;
for (let i = 0; i < n; i++) spawn(g, t as any, 0, 1500 + (i % 4) * 30, 1100 + Math.floor(i / 4) * 30);
for (let i = 0; i < n; i++) spawn(g, t as any, 1, 3400 - (1500 + (i % 4) * 30), 2240 - (1100 + Math.floor(i / 4) * 30));
const A = own(g, 0, e => e.type === t), B = own(g, 1, e => e.type === t);
const W = 3400 * 16, H = 2240 * 16;
step(g, [{ team: 0, cmd: { c: 'move', ids: A.map(e => e.id), x: 1800, y: 1120, amove: true } }, { team: 1, cmd: { c: 'move', ids: B.map(e => e.id), x: 1600, y: 1120, amove: true } }]);
for (let k = 0; k < 1200; k++) {
  const a = g.ents.filter(e => e.team === 0 && e.type === t).map(e => `${e.x},${e.y}:${e.hp}:${e.order.k}`).sort();
  const b = g.ents.filter(e => e.team === 1 && e.type === t).map(e => `${W - e.x},${H - e.y}:${e.hp}:${e.order.k}`).sort();
  if (a.join('|') !== b.join('|')) { console.log('diverge tick', g.tick); console.log(a.filter(x => !b.includes(x))); console.log(b.filter(x => !a.includes(x))); break; }
  step(g);
}
console.log('left', own(g, 0, e => e.type === t).length, own(g, 1, e => e.type === t).length);

// 一群槍兵移動到建築旁（隊形位置有些在建築裡），敵方火箭兵從射程外打過來：看會不會反擊
import { createGame, spawn, step } from '../src/sim/sim';
const g = createGame(1);
const B = g.ents.find(e => e.type === 'base' && e.team === 0)!;
const bx = B.x / 16, by = B.y / 16;
const rs = Array.from({ length: 12 }, (_, i) => spawn(g, 'rifle', 0, bx + 250 + (i % 4) * 30, by - 250 + Math.floor(i / 4) * 30));
step(g, [{ team: 0, cmd: { c: 'move', ids: rs.map(r => r.id), x: bx + 70, y: by - 60 } }]);
for (let i = 0; i < 20 * 6; i++) step(g);
console.log('after move:', rs.map(r => r.order.k).join(','));
const en = Array.from({ length: 4 }, (_, i) => spawn(g, 'srocket', 1, bx + 260 + i * 25, by - 150));
step(g, [{ team: 1, cmd: { c: 'attack', ids: en.map(e => e.id), tid: rs[0].id } }]);
for (let i = 0; i < 20 * 4; i++) step(g);
console.log('under fire:', rs.filter(r => !r.dead).map(r => r.order.k).join(','), 'enemy alive', en.filter(e => !e.dead).length);

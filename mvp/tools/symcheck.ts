import { Bot } from '../src/bot/bot';
import { MAP_H, MAP_W } from '../src/sim/data';
import { createGame, step, type TeamCmd } from '../src/sim/sim';
const g = createGame(1);
const bots = [new Bot(0), new Bot(1)];
const W = MAP_W * 16, H = MAP_H * 16;
for (let i = 0; i < 20 * 60 * 6 && g.winner < 0; i++) {
  const cmds: TeamCmd[] = [];
  for (const b of bots) for (const cmd of b.think(g)) cmds.push({ team: b.team, cmd });
  step(g, cmds);
  const a = g.ents.filter(e => e.team === 0).map(e => `${e.type}:${e.x},${e.y}:${e.hp}:${e.order.k}`).sort();
  const b = g.ents.filter(e => e.team === 1).map(e => `${e.type}:${W - e.x},${H - e.y}:${e.hp}:${e.order.k}`).sort();
  const ra = g.teams[0].scrap + '/' + g.teams[0].gas, rb = g.teams[1].scrap + '/' + g.teams[1].gas;
  if (a.join('|') !== b.join('|') || ra !== rb) {
    console.log('diverge at tick', g.tick, (g.tick / 20).toFixed(1) + 's', ra, rb);
    const sa = new Set(a), sb = new Set(b);
    console.log('only A:', a.filter(x => !sb.has(x)).slice(0, 8));
    console.log('only B:', b.filter(x => !sa.has(x)).slice(0, 8));
    console.log('cmds', JSON.stringify(cmds));
    break;
  }
}

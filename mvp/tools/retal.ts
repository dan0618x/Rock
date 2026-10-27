import { createGame, spawn, step } from '../src/sim/sim';
for (const [atk, def, dist] of [['srocket', 'rifle', 140], ['rifle', 'rifle', 100], ['rifle', 'heavy', 100], ['turbo', 'srocket', 110], ['rifle', 'worker', 90]] as const) {
  const g = createGame(1);
  const d = spawn(g, def, 0, 1500, 1100);
  const a = spawn(g, atk, 1, 1500 + dist, 1100);
  step(g, [{ team: 1, cmd: { c: 'attack', ids: [a.id], tid: d.id } }]);
  const log: string[] = [];
  for (let i = 0; i < 200; i++) { step(g); if (i % 20 === 0) log.push(`${d.order.k}${d.dead ? '✝' : ''}/${a.hp}`); }
  console.log(`${atk} → ${def} @${dist}:`, log.join(' '));
}

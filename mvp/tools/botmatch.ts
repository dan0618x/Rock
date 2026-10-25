// 電腦對手互打：node 下執行，印出每場結果與時間
import { Bot } from '../src/bot/bot';
import { TY } from '../src/sim/data';
import { createGame, hash, step, type TeamCmd } from '../src/sim/sim';

const n = Number(process.argv[2] || 5);
const verbose = process.argv.includes('-v');
for (let s = 1; s <= n; s++) {
  const g = createGame(s);
  const bots = [new Bot(0), new Bot(1)];
  const t0 = Date.now();
  let lastLog = 0;
  while (g.winner < 0) {
    const cmds: TeamCmd[] = [];
    for (const b of bots) for (const cmd of b.think(g)) cmds.push({ team: b.team, cmd });
    step(g, cmds);
    if (verbose && g.tick - lastLog >= 20 * 60) {
      lastLog = g.tick;
      const sum = (t: 0 | 1) => {
        const c: Record<string, number> = {};
        for (const e of g.ents) if (e.team === t) c[TY[e.type].ch] = (c[TY[e.type].ch] || 0) + 1;
        return Object.entries(c).map(([k, v]) => k + v).join(' ') + ` 廢${Math.floor(g.teams[t].scrap / 1000)} 氣${Math.floor(g.teams[t].gas / 1000)} Lv${g.teams[t].baseLv} 擴${g.teams[t].exp}`;
      };
      console.log(`  ${Math.round(g.tick / 20 / 60)}m  A[${sum(0)}]  B[${sum(1)}]`);
    }
  }
  const min = (g.tick / 20 / 60).toFixed(1);
  console.log(`seed ${s}: winner ${g.winner} at ${min} min, hash ${hash(g).toString(16)}, ${(Date.now() - t0)} ms, kills ${g.teams[0].stats.killed}/${g.teams[1].stats.killed}`);
}

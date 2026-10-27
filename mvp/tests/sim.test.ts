import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Bot } from '../src/bot/bot';
import { TY } from '../src/sim/data';
import { S } from '../src/sim/math';
import {
  K, apply, check, createGame, hash, own, popCap, popUsed, spawn, step, type Game, type TeamCmd,
} from '../src/sim/sim';
import type { Cmd, Team } from '../src/sim/types';

const run = (g: Game, sec: number, cmds: TeamCmd[] = []) => { step(g, cmds); for (let i = 1; i < sec * 20; i++) step(g); };
const base = (g: Game, t: Team) => g.ents.find(e => e.team === t && e.type === 'base')!;
const workers = (g: Game, t: Team) => own(g, t, e => e.type === 'worker');

/** 電腦互打一場，記下所有指令 */
function botGame(seed: number, maxSec: number) {
  const g = createGame(seed);
  const bots = [new Bot(0), new Bot(1)];
  const log: { tick: number; cmds: TeamCmd[] }[] = [];
  while (g.winner < 0 && g.tick < maxSec * 20) {
    const cmds: TeamCmd[] = [];
    for (const b of bots) for (const cmd of b.think(g)) cmds.push({ team: b.team, cmd });
    if (cmds.length) log.push({ tick: g.tick, cmds });
    step(g, cmds);
  }
  return { g, log };
}

describe('決定性', () => {
  it('同一個種子跑兩次，每一步雜湊都相同', () => {
    const a = botGame(7, 240), b = botGame(7, 240);
    expect(hash(a.g)).toBe(hash(b.g));
    expect(a.g.tick).toBe(b.g.tick);
  });
  it('只用指令紀錄重播，結果與原本那場相同', () => {
    const { g, log } = botGame(11, 300);
    const r = createGame(11);
    let i = 0;
    while (r.tick < g.tick) {
      const cmds = log[i] && log[i].tick === r.tick ? log[i++].cmds : [];
      step(r, cmds);
    }
    expect(hash(r)).toBe(hash(g));
  });
  it('模擬核心不使用平台相關的 API，也不引用畫面層', () => {
    const dir = join(__dirname, '../src/sim');
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(src, f).not.toMatch(/Math\.(random|sin|cos|tan|atan2?|hypot|pow|exp|log)\b|Date\.|performance\.|\*\*/);
      expect(src, f).not.toMatch(/from '\.\.\/(client|bot)/);
    }
  });
});

describe('經濟與建造', () => {
  it('開局：1 主堡、3 工兵自動採集，人口 3/10', () => {
    const g = createGame(1);
    expect(workers(g, 0)).toHaveLength(3);
    expect(workers(g, 0).every(w => w.order.k === 'gather')).toBe(true);
    expect(popUsed(g, 0)).toBe(3);
    expect(popCap(g, 0)).toBe(10);
    run(g, 60);
    expect(g.teams[0].scrap).toBeGreaterThan(250 * K);
  });
  it('生產扣錢、佔人口；取消全額退回', () => {
    const g = createGame(1);
    const b = base(g, 0);
    apply(g, 0, { c: 'produce', ids: [b.id], type: 'worker' });
    expect(g.teams[0].scrap).toBe(200 * K);
    expect(popUsed(g, 0)).toBe(4);
    apply(g, 0, { c: 'cancel', ids: [b.id] });
    expect(g.teams[0].scrap).toBe(250 * K);
    expect(popUsed(g, 0)).toBe(3);
  });
  it('人口滿了不能生產，擴建後可以', () => {
    const g = createGame(1);
    const b = base(g, 0);
    for (let i = 0; i < 7; i++) spawn(g, 'rifle', 0, 800, 3200);
    g.teams[0].scrap = 1000 * K;
    expect(check(g, 0, { c: 'produce', ids: [b.id], type: 'worker' })).toMatch('人口不足');
    apply(g, 0, { c: 'up', ids: [b.id], kind: 'exp' });
    run(g, 11);
    expect(popCap(g, 0)).toBe(15);
    expect(check(g, 0, { c: 'produce', ids: [b.id], type: 'worker' })).toBe('');
  });
  it('擴建與升級全隊共用：第二座主堡不會多出人口，也不能同時擴建', () => {
    const g = createGame(1);
    const b2 = spawn(g, 'base', 0, 1760, 3470);
    g.teams[0].scrap = 1000 * K;
    expect(popCap(g, 0)).toBe(10);
    apply(g, 0, { c: 'up', ids: [base(g, 0).id], kind: 'exp' });
    expect(check(g, 0, { c: 'up', ids: [b2.id], kind: 'exp' })).toMatch('進行中');
  });
  it('建築要工兵在旁邊才會蓋，工兵離開就暫停，點它可以繼續', () => {
    const g = createGame(1);
    const w = workers(g, 0)[0];
    apply(g, 0, { c: 'build', ids: [w.id], type: 'pump', x: 800, y: 3220 });
    expect(g.teams[0].scrap).toBe(175 * K);
    run(g, 8);
    const site = g.ents.find(e => e.type === 'pump' && e.team === 0)!;
    expect(site).toBeTruthy();
    expect(site.built).toBe(false);
    const p0 = site.prog;
    expect(p0).toBeGreaterThan(0);
    apply(g, 0, { c: 'move', ids: [w.id], x: 300, y: 2950 });
    run(g, 5);
    const p1 = site.prog;
    run(g, 3);
    expect(site.prog).toBe(p1);
    apply(g, 0, { c: 'resume', ids: [w.id], bid: site.id });
    run(g, 20);
    expect(site.built).toBe(true);
    // 蓋完自動回去採集
    expect(w.order.k).toBe('gather');
  });
  it('每座主堡最多 8 個工兵採集', () => {
    const g = createGame(1);
    const B = base(g, 0);
    for (let i = 0; i < 8; i++) spawn(g, 'worker', 0, 700, 3300);
    const idle = own(g, 0, e => e.type === 'worker' && e.order.k === 'idle');
    const pile = g.ents.find(e => e.type === 'scrap' && Math.abs(e.x - B.x) < 300 * S)!;
    apply(g, 0, { c: 'gather', ids: idle.map(e => e.id), res: pile.id });
    expect(own(g, 0, e => e.type === 'worker' && e.order.k === 'gather').length).toBe(8);
  });
  it('建築不能疊在一起，也不能疊在預定的工地上', () => {
    const g = createGame(1);
    const [w1, w2] = workers(g, 0);
    expect(check(g, 0, { c: 'build', ids: [w1.id], type: 'barracks', x: 560, y: 3440 })).toMatch('放不下');
    apply(g, 0, { c: 'build', ids: [w1.id], type: 'pump', x: 800, y: 3220 });
    expect(check(g, 0, { c: 'build', ids: [w2.id], type: 'pump', x: 810, y: 3220 })).toMatch('預定');
  });
  it('工兵改做別的事，還沒開工的建築退費', () => {
    const g = createGame(1);
    const w = workers(g, 0)[0];
    apply(g, 0, { c: 'build', ids: [w.id], type: 'barracks', x: 900, y: 3100 });
    expect(g.teams[0].scrap).toBe(100 * K);
    apply(g, 0, { c: 'move', ids: [w.id], x: 300, y: 2950 });
    expect(g.teams[0].scrap).toBe(250 * K);
  });
});

describe('戰鬥', () => {
  const duel = (a: keyof typeof TY, na: number, b: keyof typeof TY, nb: number) => {
    const g = createGame(1);
    for (let i = 0; i < na; i++) spawn(g, a, 0, 1020 + (i % 4) * 30, 1300 + Math.floor(i / 4) * 30);
    for (let i = 0; i < nb; i++) spawn(g, b, 1, 2640 - (1020 + (i % 4) * 30), 2640 - (1300 + Math.floor(i / 4) * 30));
    const A = own(g, 0, e => e.type === a), B = own(g, 1, e => e.type === b);
    const cmds: TeamCmd[] = [
      { team: 0, cmd: { c: 'move', ids: A.map(e => e.id), x: 1420, y: 1310, amove: true } },
      { team: 1, cmd: { c: 'move', ids: B.map(e => e.id), x: 1220, y: 1330, amove: true } },
    ];
    run(g, 60, cmds);
    return { a: own(g, 0, e => e.type === a).length, b: own(g, 1, e => e.type === b).length };
  };
  it('槍兵打不到空軍', () => {
    const g = createGame(1);
    const r = spawn(g, 'rifle', 0, 1700, 1000), t = spawn(g, 'turbo', 1, 1750, 1000);
    expect(check(g, 0, { c: 'attack', ids: [r.id], tid: t.id })).toMatch('對空');
  });
  it('相剋：火箭兵勝渦輪機翼兵、渦輪機翼兵勝槍兵、重甲兵勝槍兵（同等花費）', () => {
    const r1 = duel('srocket', 6, 'turbo', 4);
    expect(r1.a).toBeGreaterThan(0); expect(r1.b).toBe(0);
    const r2 = duel('turbo', 3, 'rifle', 9);
    expect(r2.a).toBeGreaterThan(0); expect(r2.b).toBe(0);
    const r3 = duel('heavy', 4, 'rifle', 10);
    expect(r3.a).toBeGreaterThan(0); expect(r3.b).toBe(0);
  });
  it('雙方同時開火：鏡像對稱的同兵種對戰，兩邊剩下的數量最多差 1', () => {
    for (const [t, n] of [['rifle', 6], ['srocket', 5], ['heavy', 4]] as const) {
      const r = duel(t, n, t, n);
      expect(Math.abs(r.a - r.b), t).toBeLessThanOrEqual(1);
    }
  });
});

describe('指令與地形', () => {
  it('同伴被打，附近待命的單位一起反擊', () => {
    const g = createGame(1);
    const rs = Array.from({ length: 6 }, (_, i) => spawn(g, 'rifle', 0, 1700 + (i % 3) * 32, 1000 + Math.floor(i / 3) * 32));
    const en = spawn(g, 'srocket', 1, 1700, 850);
    apply(g, 1, { c: 'attack', ids: [en.id], tid: rs[0].id });
    run(g, 2);
    expect(rs.filter(r => !r.dead && r.order.k === 'attack').length).toBeGreaterThanOrEqual(4);
  });
  it('駐守：不追擊射程外的敵人；巡邏：在兩點之間來回', () => {
    const g = createGame(1);
    const h = spawn(g, 'rifle', 0, 1700, 1000);
    apply(g, 0, { c: 'hold', ids: [h.id] });
    spawn(g, 'heavy', 1, 1700, 830);
    run(g, 3);
    expect(Math.abs(h.x / S - 1700)).toBeLessThan(25);
    const p = spawn(g, 'rifle', 0, 1500, 1300);
    apply(g, 0, { c: 'patrol', ids: [p.id], x: 1900, y: 1300 });
    let far = 0, back = 0;
    for (let i = 0; i < 20 * 14; i++) { step(g); const x = p.x / S; if (x > 1850) far++; if (far && x < 1550) back++; }
    expect(far).toBeGreaterThan(0);
    expect(back).toBeGreaterThan(0);
  });
  it('隊形：射程短的排前面，射程長的排後面', () => {
    const g = createGame(1);
    const hv = Array.from({ length: 3 }, (_, i) => spawn(g, 'heavy', 0, 1700 + i * 40, 1100));
    const rk = Array.from({ length: 3 }, (_, i) => spawn(g, 'srocket', 0, 1700 + i * 40, 1050));
    apply(g, 0, { c: 'move', ids: [...hv, ...rk].map(e => e.id), x: 1760, y: 600 });
    run(g, 12);
    const avg = (l: typeof hv) => l.reduce((s, e) => s + e.y, 0) / l.length / S;
    expect(avg(hv)).toBeLessThan(avg(rk));
  });
  it('地形擋地面不擋空軍，也不能在地形上蓋建築', () => {
    const g = createGame(1);
    const w = own(g, 0, e => e.type === 'worker')[0];
    expect(check(g, 0, { c: 'build', ids: [w.id], type: 'pump', x: 2000, y: 2000 })).toMatch('地形');
    const r = spawn(g, 'rifle', 0, 1700, 2000), t = spawn(g, 'turbo', 0, 1700, 2050);
    apply(g, 0, { c: 'move', ids: [r.id], x: 2300, y: 2000 });
    apply(g, 0, { c: 'move', ids: [t.id], x: 2300, y: 2050 });
    let inLake = 0;
    for (let i = 0; i < 20 * 15; i++) { step(g); if (Math.hypot(r.x / S - 2000, r.y / S - 2000) < 230) inLake++; }
    expect(inLake).toBe(0);
    expect(Math.abs(r.x / S - 2300)).toBeLessThan(40);
    expect(Math.abs(t.x / S - 2300)).toBeLessThan(40);
  });
  it('擠在一起走不到的隊形位置不會讓單位永遠停在移動中', () => {
    const g = createGame(1);
    const B = base(g, 0);
    const rs = Array.from({ length: 16 }, (_, i) => spawn(g, 'rifle', 0, B.x / S + 260 + (i % 4) * 30, B.y / S - 260 + Math.floor(i / 4) * 30));
    apply(g, 0, { c: 'move', ids: rs.map(e => e.id), x: B.x / S, y: B.y / S });
    run(g, 12);
    expect(rs.every(r => r.order.k === 'idle')).toBe(true);
  });
});

describe('電腦對手', () => {
  it('電腦互打多場：都能分出勝負或到時限，沒有錯誤', () => {
    const wins = [0, 0, 0];
    for (let s = 1; s <= 6; s++) {
      const { g } = botGame(s, 45 * 60);
      for (const e of g.ents) { expect(Number.isFinite(e.x)).toBe(true); expect(Number.isFinite(e.y)).toBe(true); }
      wins[g.winner]++;
    }
    expect(wins[0] + wins[1] + wins[2]).toBe(6);
  }, 120000);
  it('電腦只下合法的指令', () => {
    const g = createGame(3);
    const bot = new Bot(1);
    let bad = 0;
    for (let i = 0; i < 20 * 300; i++) {
      const cmds = bot.think(g);
      for (const c of cmds) if (check(g, 1, c as Cmd)) bad++;
      step(g, cmds.map(cmd => ({ team: 1 as Team, cmd })));
    }
    expect(bad).toBe(0);
  });
});

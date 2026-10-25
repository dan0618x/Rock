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
    for (let i = 0; i < 7; i++) spawn(g, 'rifle', 0, 600, 1700);
    g.teams[0].scrap = 1000 * K;
    expect(check(g, 0, { c: 'produce', ids: [b.id], type: 'worker' })).toMatch('人口不足');
    apply(g, 0, { c: 'up', ids: [b.id], kind: 'exp' });
    run(g, 11);
    expect(popCap(g, 0)).toBe(15);
    expect(check(g, 0, { c: 'produce', ids: [b.id], type: 'worker' })).toBe('');
  });
  it('擴建與升級全隊共用：第二座主堡不會多出人口，也不能同時擴建', () => {
    const g = createGame(1);
    const b2 = spawn(g, 'base', 0, 1250, 1650);
    g.teams[0].scrap = 1000 * K;
    expect(popCap(g, 0)).toBe(10);
    apply(g, 0, { c: 'up', ids: [base(g, 0).id], kind: 'exp' });
    expect(check(g, 0, { c: 'up', ids: [b2.id], kind: 'exp' })).toMatch('進行中');
  });
  it('建築要工兵在旁邊才會蓋，工兵離開就暫停，點它可以繼續', () => {
    const g = createGame(1);
    const w = workers(g, 0)[0];
    apply(g, 0, { c: 'build', ids: [w.id], type: 'pump', x: 700, y: 1700 });
    expect(g.teams[0].scrap).toBe(175 * K);
    run(g, 8);
    const site = g.ents.find(e => e.type === 'pump' && e.team === 0)!;
    expect(site).toBeTruthy();
    expect(site.built).toBe(false);
    const p0 = site.prog;
    expect(p0).toBeGreaterThan(0);
    apply(g, 0, { c: 'move', ids: [w.id], x: 400, y: 1500 });
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
    for (let i = 0; i < 8; i++) spawn(g, 'worker', 0, 500, 1700);
    const idle = own(g, 0, e => e.type === 'worker' && e.order.k === 'idle');
    const pile = g.ents.find(e => e.type === 'scrap' && Math.abs(e.x - B.x) < 300 * S)!;
    apply(g, 0, { c: 'gather', ids: idle.map(e => e.id), res: pile.id });
    expect(own(g, 0, e => e.type === 'worker' && e.order.k === 'gather').length).toBe(8);
  });
  it('建築不能疊在一起，也不能疊在預定的工地上', () => {
    const g = createGame(1);
    const [w1, w2] = workers(g, 0);
    expect(check(g, 0, { c: 'build', ids: [w1.id], type: 'barracks', x: 420, y: 1850 })).toMatch('放不下');
    apply(g, 0, { c: 'build', ids: [w1.id], type: 'pump', x: 700, y: 1700 });
    expect(check(g, 0, { c: 'build', ids: [w2.id], type: 'pump', x: 710, y: 1700 })).toMatch('預定');
  });
  it('工兵改做別的事，還沒開工的建築退費', () => {
    const g = createGame(1);
    const w = workers(g, 0)[0];
    apply(g, 0, { c: 'build', ids: [w.id], type: 'barracks', x: 900, y: 1500 });
    expect(g.teams[0].scrap).toBe(100 * K);
    apply(g, 0, { c: 'move', ids: [w.id], x: 400, y: 1500 });
    expect(g.teams[0].scrap).toBe(250 * K);
  });
});

describe('戰鬥', () => {
  const duel = (a: keyof typeof TY, na: number, b: keyof typeof TY, nb: number) => {
    const g = createGame(1);
    for (let i = 0; i < na; i++) spawn(g, a, 0, 1500 + (i % 4) * 30, 1100 + Math.floor(i / 4) * 30);
    for (let i = 0; i < nb; i++) spawn(g, b, 1, 3400 - (1500 + (i % 4) * 30), 2240 - (1100 + Math.floor(i / 4) * 30));
    const A = own(g, 0, e => e.type === a), B = own(g, 1, e => e.type === b);
    const cmds: TeamCmd[] = [
      { team: 0, cmd: { c: 'move', ids: A.map(e => e.id), x: 1800, y: 1110, amove: true } },
      { team: 1, cmd: { c: 'move', ids: B.map(e => e.id), x: 1600, y: 1130, amove: true } },
    ];
    run(g, 60, cmds);
    return { a: own(g, 0, e => e.type === a).length, b: own(g, 1, e => e.type === b).length };
  };
  it('槍兵打不到空軍', () => {
    const g = createGame(1);
    const r = spawn(g, 'rifle', 0, 1500, 1100), t = spawn(g, 'turbo', 1, 1550, 1100);
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

// 玩家操作：選取、下指令、放置建築、鏡頭跳轉。規則沿用操作原型。
import { MINE_CAP, TY, type TypeId } from '../sim/data';
import { S as SUB } from '../sim/math';
import { canHit, isAir, isB, isCombat, isRes, isUnit, minersOf, placeCheck, visibleAt } from '../sim/sim';
import type { Cmd, Ent } from '../sim/types';
import { buzz, sfx } from './audio';
import { C, inView, s2w, w2s } from './render';
import { ME, PAD, W, H, cam, centroid, countBy, ex, ey, issue, now, own, selEnts, selKind, st, view } from './state';
import { gesture, refreshAll, refreshCmds, toast, closePop } from './hud';

// ---------- 鏡頭 ----------
export const minZ = () => Math.min(view.w / W, view.h / H);
/** 預設倍率就是最遠的視角（一個畫面約 590 高的地圖），最近可以拉到 1.2 倍 */
export const defZ = () => Math.max(minZ(), Math.min(1, view.h / 591));
export const maxZ = () => Math.max(defZ(), 1.2);
export function clampCam() {
  cam.z = Math.max(defZ(), Math.min(maxZ(), cam.z));
  const z = cam.z;
  const x0 = (view.w / 2 - PAD.l) / z, x1 = W - (view.w / 2 - PAD.r) / z;
  const y0 = (view.h / 2 - PAD.t) / z, y1 = H - (view.h / 2 - PAD.b) / z;
  cam.x = x0 > x1 ? (x0 + x1) / 2 : Math.max(x0, Math.min(x1, cam.x));
  cam.y = y0 > y1 ? (y0 + y1) / 2 : Math.max(y0, Math.min(y1, cam.y));
}
export let camAnim: { fx: number; fy: number; tx: number; ty: number; t0: number; ms: number } | null = null;
export const stopCamAnim = () => { camAnim = null; };
export function camTo(x: number, y: number, ms = 180) { camAnim = { fx: cam.x, fy: cam.y, tx: x, ty: y, t0: now(), ms }; }
export function stepCam(t: number) {
  if (!camAnim) return;
  const k = Math.min(1, (t - camAnim.t0) / camAnim.ms), e = 1 - Math.pow(1 - k, 3);
  cam.x = camAnim.fx + (camAnim.tx - camAnim.fx) * e;
  cam.y = camAnim.fy + (camAnim.ty - camAnim.fy) * e;
  clampCam();
  if (k >= 1) camAnim = null;
}
/** 選取時跳鏡頭：單位分散時依群組大小排序，重複點同一項跳下一群 */
let jumpState = { key: '', i: 0, t: 0 };
function clusters(list: Ent[]) {
  const cl: Ent[][] = [];
  for (const e of list) {
    const c = cl.find(g => g.some(o => Math.hypot(ex(o) - ex(e), ey(o) - ey(e)) < 380));
    if (c) c.push(e); else cl.push([e]);
  }
  return cl.sort((a, b) => b.length - a.length);
}
export function jumpTo(list: Ent[], key: string) {
  if (!list.length) return '';
  const cl = clusters(list);
  let i = 0;
  if (jumpState.key === key && now() - jumpState.t < 6000) i = (jumpState.i + 1) % cl.length;
  jumpState = { key, i, t: now() };
  const c = centroid(cl[i]);
  camTo(c.x, c.y, 220);
  return cl.length > 1 ? '（第 ' + (i + 1) + '/' + cl.length + ' 群，再點一次跳下一群）' : '';
}

// ---------- 選取 ----------
export const nm = (e: Ent) => TY[e.type].name;
export function setSel(list: Ent[], silent = false, keepPop = false) {
  st.sel = new Set(list.map(e => e.id));
  if (st.mode) st.mode = null;
  if (!keepPop) closePop();
  refreshAll(true);
  if (list.length) buzz(8);
  if (!silent && list.length) {
    const m = countBy(list);
    toast('已選取 ' + [...m].map(([t, n]) => TY[t].name + '×' + n).join('、'));
  }
}
let lastTap: { t: number; type: TypeId } | null = null;
export function tapSelect(hit: Ent) {
  const t = now();
  if (lastTap && t - lastTap.t < 330 && lastTap.type === hit.type) {
    const list = own(e => e.type === hit.type && inView(ex(e), ey(e)));
    setSel(list, true);
    gesture('<b>連點兩下</b> → 畫面內所有' + nm(hit) + '（' + list.length + '）');
    lastTap = null;
  } else {
    setSel([hit], true);
    gesture('<b>點一下</b> → 選取 ' + nm(hit));
    lastTap = { t, type: hit.type };
  }
}
export function selectAndJump(list: Ent[], key: string, msg: string, keepPop = false) {
  setSel(list, false, keepPop);
  gesture(msg + jumpTo(list, key));
}
/** 點到哪個實體：空軍優先、建築與廢料次之 */
export function pick(w: { x: number; y: number }): Ent | null {
  const slack = 16 / cam.z;
  let best: Ent | null = null, bs = 1e9;
  const g = st.g;
  for (const e of g.ents) {
    if (e.dead) continue;
    if (e.team !== ME && !isRes(e) && !visible(e)) continue;
    const yy = isAir(e) ? ey(e) - 6 : ey(e);
    const d = Math.hypot(w.x - ex(e), w.y - yy) - e.r / SUB;
    if (d > slack) continue;
    const s = d + (isAir(e) ? -8 : 0) + (isB(e) ? 10 : 0) + (isRes(e) ? 14 : 0);
    if (s < bs) { bs = s; best = e; }
  }
  return best;
}
const visible = (e: Ent) => visibleAt(st.g, ME, e.x, e.y);

// ---------- 指令 ----------
function send(c: Cmd, okMsg?: string): boolean {
  const err = issue(c);
  if (err) { toast(err, 'bad'); sfx('err'); return false; }
  if (okMsg) toast(okMsg);
  buzz(12);
  return true;
}
const ids = (es: Ent[]) => es.map(e => e.id);
export const marker = (x: number, y: number, c: number, r = 0) => st.fx.push({ x, y, t0: now(), c, r, kind: 'marker' });

export function moveCmd(es: Ent[], w: { x: number; y: number }) {
  if (send({ c: 'move', ids: ids(es.filter(isUnit)), x: Math.round(w.x), y: Math.round(w.y) })) marker(w.x, w.y, C.ok);
}
export function attackCmd(es: Ent[], t: Ent) {
  const can = es.filter(e => canHit(e, t));
  if (can.length && can.length < es.filter(e => TY[e.type].dmg).length) toast(isAir(t) ? '部分單位無法對空' : '部分單位無法攻擊這個目標', 'bad');
  if (send({ c: 'attack', ids: ids(es), tid: t.id })) marker(ex(t), ey(t), C.enemy, t.r / SUB);
}
export function armyAttack(es: Ent[]) {
  send({ c: 'fire', ids: ids(es) });
  st.mode = { k: 'attack' };
  toast('開火：攻擊附近敵人。點敵人可集火，點地面就移動', 'mode');
  gesture('<b>點攻擊</b> → 開火');
  refreshCmds(true);
}
export function gatherCmd(es: Ent[], r: Ent) {
  const base = st.g.ents.filter(b => b.team === ME && b.type === 'base' && b.built).sort((a, b) => Math.hypot(ex(a) - ex(r), ey(a) - ey(r)) - Math.hypot(ex(b) - ex(r), ey(b) - ey(r)))[0];
  const ws = es.filter(e => e.type === 'worker');
  if (base) {
    const already = ws.filter(w => w.order.k === 'gather' && w.order.base === base.id).length;
    const free = MINE_CAP - minersOf(st.g, base);
    const skip = Math.max(0, ws.length - already - free);
    if (skip) toast('這座主堡的採集工兵已滿（' + MINE_CAP + '），有 ' + skip + ' 個工兵沒有加入', 'bad');
  }
  if (send({ c: 'gather', ids: ids(ws), res: r.id })) marker(ex(r), ey(r), C.scrap, r.r / SUB);
}
export function setMode(m: NonNullable<typeof st.mode>, hint: string) {
  if (st.mode && st.mode.k === m.k) { clearMode(); return; }
  st.mode = m;
  toast(hint, 'mode');
  refreshCmds(true);
}
export function clearMode() {
  st.mode = null;
  const t = document.getElementById('toast')!;
  if (t.className === 'mode') { t.style.opacity = '0'; }
  refreshCmds(true);
}
export function enterPlace(type: TypeId) {
  const c = s2w(view.w / 2, view.h * 0.45);
  st.mode = { k: 'place', type, x: c.x, y: c.y };
  toast('放置 ' + TY[type].name + '：單指移動建築，雙指移動鏡頭', 'mode');
  closePop();
  refreshAll(true);
}
export function confirmPlace(cont: boolean) {
  const m = st.mode;
  if (!m || m.k !== 'place') return;
  const T = TY[m.type];
  const ws = selEnts().filter(e => e.type === 'worker');
  if (!ws.length) { toast('沒有選取工兵', 'bad'); clearMode(); return; }
  const x = Math.round(m.x), y = Math.round(m.y);
  if (!send({ c: 'build', ids: ids(ws), type: m.type, x, y })) return;
  marker(x, y, C.accent, T.r);
  gesture('<b>確認</b> → 工兵前往建造 ' + T.name);
  if (!cont) { clearMode(); refreshAll(); return; }
  m.x = Math.min(W - T.r, m.x + T.r * 2 + 24);
  toast('連續建造：再放一座 ' + T.name, 'mode');
  refreshCmds(true);
}
export function placeOk() {
  const m = st.mode;
  if (!m || m.k !== 'place') return false;
  return placeCheck(st.g, ME, m.type, Math.round(m.x), Math.round(m.y)).ok;
}
export function produce(es: Ent[], type: TypeId) {
  if (send({ c: 'produce', ids: ids(es), type })) gesture('<b>點</b> → 生產 ' + TY[type].name + '（長按可循環生產）');
}
export function toggleLoop(es: Ent[], type: TypeId) {
  const built = es.filter(b => b.built);
  const all = built.length > 0 && built.every(b => b.loop === type);
  if (send({ c: 'loop', ids: ids(es), type })) {
    toast(all ? '已關閉循環生產' : '循環生產 ' + TY[type].name + '：佇列空了就自動補');
    gesture('<b>長按</b> → 循環生產');
  }
}
export function upgrade(es: Ent[], kind: 'upg' | 'exp') {
  send({ c: 'up', ids: ids(es), kind }, kind === 'upg' ? '開始升級主堡 Lv2' : '開始擴建');
}
export function recall() {
  const idle = own(e => e.type === 'worker' && e.order.k === 'idle');
  send({ c: 'recall', ids: [] });
  toast(idle.length ? idle.length + ' 個閒置工兵回去採集' : '沒有閒置工兵');
}
export function cancelCurrent() {
  const k = selKind();
  if (k.k !== 'bld') return;
  const b = k.es.filter(x => x.q.length).sort((a, c) => c.q[0].t / c.q[0].total - a.q[0].t / a.q[0].total)[0];
  if (!b) { toast('沒有正在進行的製程'); return; }
  const q = b.q[0];
  const name = q.kind === 'unit' ? TY[q.type!].name : q.kind === 'upg' ? '主堡升級' : '擴建';
  send({ c: 'cancel', ids: [b.id] }, '已取消 ' + name + '，退回 ' + q.paid[0] + (q.paid[1] ? '／' + q.paid[1] : ''));
}
export function cancelSite(es: Ent[]) { send({ c: 'cancelSite', ids: ids(es) }, '已取消建造，退回 75%'); }
function resumeBuild(ws: Ent[], b: Ent) {
  if (send({ c: 'resume', ids: ids(ws), bid: b.id })) {
    marker(ex(b), ey(b), C.accent, b.r / SUB);
    gesture('<b>點未完成的建築</b> → 工兵前往繼續蓋 ' + nm(b));
  }
}
function setRally(bs: Ent[], p: { x: number; y: number; res?: number }) {
  if (send({ c: 'rally', ids: ids(bs), x: Math.round(p.x), y: Math.round(p.y), res: p.res })) {
    marker(p.x, p.y, C.accent);
    gesture('<b>點地圖</b> → 設定集結點' + (p.res ? '（新工兵會直接採集）' : ''));
  }
}

// ---------- 點地圖 ----------
export function handleTap(sx: number, sy: number) {
  const w = s2w(sx, sy), hit = pick(w);
  if (st.mode && st.mode.k !== 'place') {
    if (hit && hit.team === ME) clearMode();
    else { doMode(w, hit); return; }
  }
  if (!st.sel.size || !selEnts().length) {
    if (hit && hit.team === ME) tapSelect(hit);
    else if (hit && hit.team >= 0) gesture('<b>點一下</b> → 敵方 ' + nm(hit) + '（不能選取）');
    else if (hit && isRes(hit)) gesture('<b>點一下</b> → 廢料堆，剩 ' + hit.amt);
    else gesture('<b>點地面</b>（沒有選取）→ 無動作');
    return;
  }
  const k = selKind();
  if (hit && hit.team >= 0 && hit.team !== ME) {
    if (k.k === 'bld') { setRally(k.es, { x: ex(hit), y: ey(hit) }); return; }
    attackCmd(k.es, hit);
    gesture('<b>點敵人</b> → 攻擊 ' + nm(hit));
    return;
  }
  if (hit && isRes(hit)) {
    if (k.k === 'worker') { gatherCmd(k.es, hit); gesture('<b>點廢料</b> → 工兵採集'); return; }
    if (k.k === 'bld') { setRally(k.es, { x: ex(hit), y: ey(hit), res: hit.id }); return; }
  }
  if (hit && hit.team === ME && isB(hit) && !hit.built && k.k === 'worker') { resumeBuild(k.es, hit); return; }
  if (hit && hit.team === ME && hit.type === 'base' && hit.built && k.k === 'worker') {
    const carriers = k.es.filter(w => w.carry > 0);
    if (carriers.length) {
      if (send({ c: 'return', ids: ids(carriers), bid: hit.id })) {
        marker(ex(hit), ey(hit), C.scrap, hit.r / SUB);
        gesture('<b>帶著廢料點主堡</b> → ' + carriers.length + ' 個工兵把廢料存入');
      }
      return;
    }
  }
  if (hit && hit.team === ME) { tapSelect(hit); return; }
  if (k.k === 'bld') { setRally(k.es, w); return; }
  moveCmd(k.es, w);
  gesture('<b>點地面</b> → 移動（不開火）');
}
function doMode(w: { x: number; y: number }, hit: Ent | null) {
  const k = selKind(), m = st.mode!;
  if (m.k === 'attack') {
    if (hit && hit.team >= 0 && hit.team !== ME) { attackCmd(k.es, hit); gesture('<b>開火中點敵人</b> → 集火 ' + nm(hit)); return; }
    moveCmd(k.es, w);
    gesture('<b>點地面</b> → 移動（再點攻擊就開火）');
  } else if (m.k === 'gather') {
    if (hit && isRes(hit)) { gatherCmd(k.es, hit); gesture('<b>採集</b> → 廢料堆'); }
    else { toast('請點廢料堆', 'bad'); return; }
  }
  clearMode();
}
export function circleSelect(sx: number, sy: number, r: number, secs: string) {
  const inC = (e: Ent) => { const p = w2s(ex(e), ey(e)); return Math.hypot(p.x - sx, p.y - sy) <= r + (e.r / SUB) * cam.z * 0.5; };
  let list = own(e => isUnit(e) && inC(e));
  if (!list.length) {
    const bs = own(e => isB(e) && inC(e));
    if (bs.length) { const t = bs[0].type; list = bs.filter(b => b.type === t); }
  }
  if (list.length) { setSel(list); gesture('<b>圈選</b> → ' + list.length + ' 個單位（共 ' + secs + ' 秒）'); }
  else gesture('<b>圈選</b> → 圈內沒有己方單位');
}
export const armyList = () => own(isCombat);

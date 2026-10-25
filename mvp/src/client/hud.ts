// HUD：左上小地圖與三鈕、右上資源、右中事件、左下分類、中下編隊、右下指令。沿用操作原型的配置與規則。
import { BUILDS, EXPAND, MINE_CAP, PROD, TY, type TypeId } from '../sim/data';
import { S as SUB } from '../sim/math';
import { GH, GW } from '../sim/nav';
import {
  K, afford, buildReq, builderOf, isB, isCombat, minersOf, nextUp, popCap, popUsed, unitReq, upInProgress,
} from '../sim/sim';
import type { Ent } from '../sim/types';
import {
  armyAttack, camTo, cancelCurrent, cancelSite, clampCam, confirmPlace, defZ, enterPlace, jumpTo, marker, nm, placeOk,
  produce, recall, selectAndJump, setMode, setSel, stopCamAnim, toggleLoop, upgrade, clearMode,
} from './actions';
import { C } from './render';
import { ME, W, H, cam, countBy, ex, ey, isFiring, now, own, selEnts, selKind, st, view, type UiEvent } from './state';

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;

// ---------- 訊息 ----------
let toastT = 0, gestT = 0;
export function toast(t: string, kind = '', secs = 2.2) {
  const el = $('#toast');
  el.textContent = t;
  el.className = kind;
  el.style.opacity = '1';
  toastT = kind === 'mode' ? 1e9 : secs;
}
export function gesture(h: string) {
  const el = $('#gest');
  el.innerHTML = '手勢：' + h;
  el.style.opacity = '1';
  gestT = 2.6;
}
export function tickMessages(dt: number) {
  if (toastT > 0) { toastT -= dt; if (toastT <= 0) $('#toast').style.opacity = '0'; }
  if (gestT > 0) { gestT -= dt; if (gestT <= 0) $('#gest').style.opacity = '0'; }
}

// ---------- 事件：保留 5 秒；同一處持續被攻擊會刷新時間 ----------
const EV_LIFE = 5000;
export function pushEvent(x: number, y: number, text: string, kind: string) {
  const t = now();
  if (kind === 'atk') {
    const l = st.events.find(e => e.kind === 'atk' && Math.hypot(e.x - x, e.y - y) < 400);
    if (l) { l.t = t; l.x = x; l.y = y; return false; }
  }
  st.events.push({ x, y, text, kind, t });
  return true;
}
let evCur = 0, evPressT = 0;
function eventJump() {
  st.events = st.events.filter(e => now() - e.t < EV_LIFE);
  if (!st.events.length) { toast('目前沒有事件'); return; }
  const list: UiEvent[] = st.events.slice().reverse();
  evCur = now() - evPressT < 3000 ? (evCur + 1) % list.length : 0;
  evPressT = now();
  const e = list[evCur];
  camTo(e.x, e.y, 220);
  marker(e.x, e.y, C.accent, 30);
  gesture('<b>事件</b> ' + (evCur + 1) + '/' + list.length + '：' + e.text + (list.length > 1 ? '（快速連按切換）' : ''));
}

// ---------- 按鈕 ----------
export function bindPress(el: HTMLElement, tap: (el: HTMLElement) => void, long?: (el: HTMLElement) => void) {
  let t: number | undefined, fired = false, down = false, upAt = -1e9;
  el.addEventListener('pointerdown', e => {
    e.preventDefault(); down = true; fired = false; el.classList.add('down');
    if (long) t = window.setTimeout(() => { fired = true; el.classList.remove('down'); long(el); }, 450);
  });
  el.addEventListener('pointerup', () => { upAt = performance.now(); if (!down) return; down = false; el.classList.remove('down'); clearTimeout(t); if (!fired) tap(el); });
  const cancel = () => { down = false; clearTimeout(t); el.classList.remove('down'); };
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('pointerleave', cancel);
  // 鍵盤啟動（click 沒有前置的 pointerup）才走這裡；觸控合成的 click 要略過，避免觸發兩次
  el.addEventListener('click', e => { if ((e as MouseEvent).detail === 0 && performance.now() - upAt > 600) tap(el); });
  el.addEventListener('contextmenu', e => e.preventDefault());
}
const costTxt = (c?: [number, number] | null) => (c ? c[0] + (c[1] ? '/' + c[1] : '') : '');
interface Def {
  ch: string; lb: string; cls?: string; cost?: [number, number] | null;
  unit?: TypeId; up?: 'upg' | 'exp'; place?: boolean;
  on?: () => boolean; cdf?: () => number; lock?: () => string;
  onTap?: (el: HTMLElement) => void; onLong?: (el: HTMLElement) => void;
}
type Btn = HTMLButtonElement & { _d: Def };
function mkBtn(d: Def): Btn {
  const el = document.createElement('button') as Btn;
  el.className = 'btn' + (d.cls ? ' ' + d.cls : '');
  el.innerHTML = '<span class="ch">' + d.ch + '</span><span class="lb">' + d.lb + '</span>' + (d.cost ? '<span class="cost">' + costTxt(d.cost) + '</span>' : '') + '<span class="badge"></span><span class="cdov"></span>';
  el.setAttribute('aria-label', d.lb);
  bindPress(el, () => d.onTap && d.onTap(el), d.onLong ? () => d.onLong!(el) : undefined);
  el._d = d;
  return el;
}

// ---------- 彈出選單 ----------
let popAnchor: HTMLElement | null = null;
const pop = () => $('#pop');
export function openPop(anchor: HTMLElement, render: (p: HTMLElement) => void) {
  popAnchor = anchor;
  pop().hidden = false;
  render(pop());
  placePop();
  document.querySelectorAll('.cat').forEach(c => c.classList.toggle('open', c === anchor));
}
export function placePop() {
  if (!popAnchor) return;
  const r = popAnchor.getBoundingClientRect(), p = pop(), pw = p.offsetWidth, ar = $('#app').getBoundingClientRect();
  p.style.left = Math.max(8, Math.min(view.w - pw - 8, r.left - ar.left + r.width / 2 - pw / 2)) + 'px';
  p.style.bottom = ar.bottom - r.top + 8 + 'px';
  p.style.top = 'auto';
}
export function closePop() {
  if (pop().hidden) return;
  pop().hidden = true;
  popAnchor = null;
  document.querySelectorAll('.cat').forEach(c => c.classList.remove('open'));
}
export const popIsOpen = () => !pop().hidden;
export const popAnchorIsCat = () => !!popAnchor && popAnchor.classList.contains('cat');
export const popContains = (t: EventTarget | null) => pop().contains(t as Node) || (!!popAnchor && popAnchor.contains(t as Node));

// ---------- 左下分類（選取後鏡頭跳過去，選單保持開啟） ----------
const CATS: [string, string, string][] = [['building', '建', '建築'], ['worker', '工', '工兵'], ['ground', '地', '地面'], ['air', '空', '空軍']];
function buildCats() {
  const box = $('#cats');
  box.innerHTML = '';
  for (const [cat, ch, lb] of CATS)
    box.appendChild(mkBtn({ ch, lb, cls: 'cat', onTap: el => { if (popAnchor === el) { closePop(); return; } openPop(el, p => renderCat(p, cat)); } }));
}
const sameSel = (l: Ent[]) => l.length > 0 && l.length === st.sel.size && l.every(e => st.sel.has(e.id));
function renderCat(p: HTMLElement, cat: string) {
  const title = CATS.find(c => c[0] === cat)![2];
  p.innerHTML = '<div class="ptitle">' + title + '</div>';
  const g = document.createElement('div');
  g.className = 'bgrid';
  const choose = (l: Ent[], key: string, msg: string) => { selectAndJump(l, key, '<b>分類選單</b> → ' + msg, true); renderCat(p, cat); placePop(); };
  const tile = (ch: string, l: Ent[], key: string, label: string, o: { round?: boolean; note?: string } = {}) => {
    const b = document.createElement('button');
    b.className = 'btile' + (l.length ? '' : ' poor') + (sameSel(l) ? ' cur' : '');
    b.setAttribute('aria-label', label);
    b.innerHTML = '<span class="bi' + (o.round ? ' rd' : '') + '">' + ch + '</span><span class="bc">' + l.length + (o.note ? '<em>' + o.note + '</em>' : '') + '</span>';
    if (l.length) bindPress(b, () => choose(l, key, label + '×' + l.length));
    g.appendChild(b);
  };
  if (cat === 'worker') {
    const ws = own(e => e.type === 'worker');
    tile('工', ws, 'cat:w', '全部工兵', { round: true });
    tile('閒', ws.filter(e => e.order.k === 'idle'), 'cat:wi', '閒置工兵', { round: true });
  } else if (cat === 'building') {
    const list = own(isB);
    countBy(list).forEach((_n, t) => {
      const l = list.filter(e => e.type === t);
      tile(TY[t].ch, l, 'cat:' + t, TY[t].name, { note: l.some(b => b.q.length) ? '產' : '' });
    });
  } else {
    const list = own(e => TY[e.type].cat === cat);
    tile('全', list, 'cat:all' + cat, '全部' + title);
    countBy(list).forEach((_n, t) => tile(TY[t].ch, list.filter(e => e.type === t), 'cat:' + t, TY[t].name, { round: true }));
  }
  if (!g.children.length) g.innerHTML = '<div class="phint">目前沒有</div>';
  p.appendChild(g);
}

// ---------- 中下編隊 ----------
const slotEls: HTMLButtonElement[] = [];
function buildSlots() {
  const box = $('#slots');
  box.innerHTML = '';
  slotEls.length = 0;
  for (let i = 0; i < 5; i++) {
    const el = document.createElement('button');
    el.className = 'slot';
    el.setAttribute('aria-label', '編隊 ' + (i + 1));
    bindPress(el, () => slotTap(i), () => slotAdd(i));
    box.appendChild(el);
    slotEls.push(el);
  }
}
const grpOf = (e: Ent) => (isB(e) ? 'b:' + e.type : isCombat(e) ? 'army' : 'worker');
function compat(list: Ent[]): { ok: boolean; why?: string } {
  const g = new Set(list.map(grpOf));
  if (g.size <= 1) return { ok: true };
  if ([...g].every(x => x.startsWith('b:'))) return { ok: false, why: '建築只能跟同種建築編隊' };
  if (g.has('worker')) return { ok: false, why: '工兵只能跟工兵編隊' };
  return { ok: false, why: '不同類型不能編在一起' };
}
const slotEnts = (i: number) => st.slots[i].map(id => st.g.byId.get(id)).filter((e): e is Ent => !!e && !e.dead);
/** 單位只屬於一個編隊：存入新編隊時從其他編隊移出 */
function assignSlot(i: number, ids: number[]) {
  const set = new Set(ids), from: number[] = [];
  st.slots.forEach((s, k) => { if (k === i) return; const n = s.filter(id => !set.has(id)); if (n.length !== s.length) { from.push(k + 1); st.slots[k] = n; } });
  st.slots[i] = ids;
  return from.length ? '（從編隊 ' + from.join('、') + ' 移過來）' : '';
}
function flash(el: HTMLElement) { el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); }
let slotTapT = { i: -1, t: 0 };
function slotAdd(i: number) {
  const cur = selEnts(), s = slotEnts(i);
  if (!cur.length) { toast('先選取單位，再長按編隊格加入'); return; }
  const ins = new Set(st.slots[i]);
  if (cur.every(e => ins.has(e.id))) { toast('這些單位已經在編隊 ' + (i + 1)); return; }
  const uni = [...s, ...cur.filter(e => !ins.has(e.id))];
  const c = compat(uni);
  if (!c.ok) { toast('不能加入：' + c.why, 'bad'); flash(slotEls[i]); return; }
  const mv = assignSlot(i, uni.map(e => e.id));
  toast((s.length ? '已加入編隊 ' : '已存入編隊 ') + (i + 1) + '（共 ' + uni.length + '）' + mv);
  gesture('<b>長按編隊 ' + (i + 1) + '</b> → 加入目前選取');
  refreshAll();
}
function slotTap(i: number) {
  const t = now();
  if (slotTapT.i === i && t - slotTapT.t < 330) { slotTapT = { i: -1, t: 0 }; openSlotPop(i); return; }
  slotTapT = { i, t };
  const s = slotEnts(i), cur = selEnts();
  const recallSlot = () => { setSel(s, true); gesture('<b>點編隊 ' + (i + 1) + '</b> → 選取 ' + s.length + ' 個' + jumpTo(s, 'slot:' + i)); };
  if (!cur.length) {
    if (!s.length) { toast('編隊 ' + (i + 1) + ' 是空的：先選取單位，再點這格存入'); return; }
    recallSlot();
    return;
  }
  if (!s.length) {
    const c = compat(cur);
    if (!c.ok) { toast(c.why!, 'bad'); flash(slotEls[i]); return; }
    const mv = assignSlot(i, cur.map(e => e.id));
    toast('已存入編隊 ' + (i + 1) + '（' + cur.length + '）' + mv);
    gesture('<b>點空格</b> → 存入編隊');
    refreshAll();
    return;
  }
  recallSlot();
}
function openSlotPop(i: number) {
  closePop();
  gesture('<b>連點編隊 ' + (i + 1) + '</b> → 管理');
  const render = (p: HTMLElement) => {
    const s = slotEnts(i);
    p.innerHTML = '<div class="ptitle">編隊 ' + (i + 1) + '・' + s.length + ' 個</div>';
    const hint = (txt: string) => { const h = document.createElement('div'); h.className = 'phint'; h.textContent = txt; p.appendChild(h); };
    if (s.length) {
      const ch = document.createElement('div');
      ch.className = 'chips';
      for (const e of s) {
        const b = document.createElement('button');
        b.className = 'chip';
        b.setAttribute('aria-label', '移出 ' + nm(e));
        b.innerHTML = TY[e.type].ch + '<i style="right:' + (4 + 26 * (1 - e.hp / e.maxHp)) + 'px"></i>';
        bindPress(b, () => { st.slots[i] = st.slots[i].filter(id => id !== e.id); render(p); placePop(); refreshAll(); });
        ch.appendChild(b);
      }
      p.appendChild(ch);
      hint('點單位就移出這個編隊');
    } else hint('空的編隊。選取單位後點這格存入。');
    const a = document.createElement('div');
    a.className = 'prow-actions';
    a.style.marginTop = '8px';
    const mk = (t: string, f: () => void, cls?: string) => { const b = document.createElement('button'); b.className = 'pbtn' + (cls ? ' ' + cls : ''); b.textContent = t; bindPress(b, f); a.appendChild(b); };
    const cur = selEnts(), same = cur.length === s.length && cur.every(e => st.slots[i].includes(e.id));
    if (cur.length && !same && s.length)
      mk('⇄ 改成目前選取', () => { const c = compat(cur); if (!c.ok) { toast(c.why!, 'bad'); return; } const mv = assignSlot(i, cur.map(e => e.id)); toast('編隊 ' + (i + 1) + ' 改成目前選取（' + cur.length + '）' + mv); closePop(); refreshAll(); }, 'pri');
    if (i > 0) mk('◀ 左移', () => { [st.slots[i - 1], st.slots[i]] = [st.slots[i], st.slots[i - 1]]; refreshAll(); openSlotPop(i - 1); });
    if (i < 4) mk('右移 ▶', () => { [st.slots[i + 1], st.slots[i]] = [st.slots[i], st.slots[i + 1]]; refreshAll(); openSlotPop(i + 1); });
    if (s.length) mk('全部移除', () => { st.slots[i] = []; refreshAll(); closePop(); toast('編隊 ' + (i + 1) + ' 已清空'); }, 'warn');
    p.appendChild(a);
  };
  openPop(slotEls[i], render);
}
function renderSlots() {
  const cur = [...st.sel].sort().join(',');
  slotEls.forEach((el, i) => {
    st.slots[i] = st.slots[i].filter(id => { const e = st.g.byId.get(id); return !!e && !e.dead; });
    const s = slotEnts(i);
    if (!s.length) { el.className = 'slot'; el.innerHTML = '<span class="num">' + (i + 1) + '</span><span class="plus">+</span>'; return; }
    const m = countBy(s);
    let ch = '軍';
    if (m.size === 1) ch = TY[s[0].type].ch;
    else if (s.every(e => TY[e.type].cat === 'ground')) ch = '地';
    else if (s.every(e => TY[e.type].cat === 'air')) ch = '空';
    el.className = 'slot full' + (cur && cur === st.slots[i].slice().sort().join(',') ? ' active' : '');
    el.innerHTML = '<span class="num">' + (i + 1) + '</span><span class="ch">' + ch + '</span><span class="cnt">' + s.length + '</span>';
  });
}

// ---------- 右下指令 ----------
let cmdSig = '', cmdBtns: Btn[] = [];
function qRem(pred: (q: Ent['q'][number]) => boolean) {
  const k = selKind();
  if (k.k !== 'bld') return 0;
  let best = -1;
  for (const b of k.es) { const q = b.q[0]; if (q && pred(q)) best = Math.max(best, q.t / q.total); }
  return best < 0 ? 0 : 1 - best;
}
function cmdDefs(): { k: ReturnType<typeof selKind>; defs: Def[]; place?: boolean } {
  const k = selKind(), defs: Def[] = [];
  const g = st.g;
  if (st.mode && st.mode.k === 'place') {
    const T = TY[st.mode.type];
    defs.push({ ch: '✓', lb: '確認', cls: 'go', cost: T.cost, place: true, onTap: () => confirmPlace(false) });
    defs.push({ ch: '連', lb: '連續建造', place: true, onTap: () => confirmPlace(true) });
    defs.push({ ch: '✕', lb: '取消', onTap: () => { clearMode(); refreshAll(); gesture('<b>取消</b> → 離開放置模式'); } });
    return { k, defs, place: true };
  }
  if (k.k === 'none') return { k, defs: [{ ch: '－', lb: '未選取', cls: 'placeholder' }] };
  if (k.k === 'worker') {
    defs.push({ ch: '採', lb: '採集', on: () => !!st.mode && st.mode.k === 'gather', onTap: () => setMode({ k: 'gather' }, '採集：點廢料堆') });
    defs.push({ ch: '攻', lb: '攻擊', on: () => !!st.mode && st.mode.k === 'attack', onTap: () => setMode({ k: 'attack' }, '攻擊：點敵人') });
    defs.push({ ch: '建', lb: '建造', onTap: el => { if (popAnchor === el) { closePop(); return; } openPop(el, renderBuild); } });
  } else if (k.k === 'army') {
    defs.push({ ch: '攻', lb: '攻擊', on: () => isFiring(selEnts()), onTap: () => armyAttack(selEnts()) });
  } else {
    const bs = k.es, t = k.type;
    if (bs.every(b => !b.built)) { defs.push({ ch: '✕', lb: '取消建造', onTap: () => cancelSite(selKind().es) }); return { k, defs }; }
    for (const u of PROD[t] || [])
      defs.push({
        ch: TY[u].ch, lb: TY[u].name, cost: TY[u].cost, unit: u,
        cdf: () => qRem(q => q.kind === 'unit' && q.type === u),
        onTap: () => produce(selKind().es, u),
        onLong: () => toggleLoop(selKind().es, u),
      });
    if (t === 'base') {
      const upBtn = (kind: 'upg' | 'exp', ch: string, lb: string) => {
        const n = nextUp(g, ME, kind);
        defs.push({ ch, lb, cost: n.max ? null : n.cost, up: kind, cdf: () => qRem(q => q.kind === kind), onTap: () => upgrade(selKind().es, kind) });
      };
      upBtn('upg', '升', '升級');
      upBtn('exp', '擴', '擴建');
      defs.push({ ch: '召', lb: '回採', onTap: () => recall() });
    }
  }
  return { k, defs };
}
/** 次要按鈕沿大圓鈕左方（180°）到正上方（270°）的圓弧排列 */
function layoutArc(prim: HTMLElement, secs: HTMLElement[]) {
  if (!secs.length) return;
  const big = prim.offsetWidth, kk = secs[0].offsetWidth, n = secs.length;
  const step = n <= 3 ? 45 : 90 / (n - 1);
  const minR = big / 2 + kk / 2 + 8, arcR = n > 1 ? (kk + 6) / (2 * Math.sin((step * Math.PI) / 360)) : 0;
  const R = Math.max(minR, arcR);
  secs.forEach((el, i) => {
    const a = ((180 + step * i) * Math.PI) / 180;
    el.style.left = big / 2 + Math.cos(a) * R - kk / 2 + 'px';
    el.style.top = big / 2 + Math.sin(a) * R - kk / 2 + 'px';
  });
}
function renderBuild(p: HTMLElement) {
  p.innerHTML = '<div class="ptitle">建造</div>';
  const g = document.createElement('div');
  g.className = 'bgrid';
  for (const t of BUILDS) {
    const T = TY[t], lock = buildReq(st.g, ME, t);
    const b = document.createElement('button');
    b.className = 'btile' + (afford(st.g, ME, T.cost) && !lock ? '' : ' poor');
    b.setAttribute('aria-label', T.name);
    b.innerHTML = '<span class="bi">' + T.ch + '</span><span class="bc">' + (lock ? lock.replace('需主堡 ', '需 ') : '<i class="ico s"></i>' + T.cost[0] + (T.cost[1] ? '<i class="ico g"></i>' + T.cost[1] : '')) + '</span>';
    bindPress(b, () => {
      if (lock) { toast(T.name + '：' + lock, 'bad'); return; }
      if (!afford(st.g, ME, T.cost)) { toast(T.name + '：' + (st.g.teams[ME].scrap < T.cost[0] * K ? '廢料不足' : '輻能氣不足'), 'bad'); return; }
      closePop();
      st.mode = null;
      enterPlace(t);
    });
    g.appendChild(b);
  }
  p.appendChild(g);
}
export function refreshCmds(force = false) {
  const d = cmdDefs();
  const sig = (d.place ? 'place:' + (st.mode as { type: string }).type : '') + '|' + d.k.k + '|' + ('type' in d.k ? d.k.type : '') + '|' + (d.k.k === 'bld' && d.k.es.every(b => !b.built) ? 'site' : '') + '|' + d.defs.map(x => x.lb + (x.cost ? x.cost.join('/') : '')).join(',');
  if (force || sig !== cmdSig) {
    cmdSig = sig;
    const box = $('#cmdArea');
    box.innerHTML = '';
    cmdBtns = [];
    const grid = d.k.k === 'bld' && !d.place;
    box.classList.toggle('grid', grid);
    box.style.gridTemplateColumns = grid ? 'repeat(' + Math.min(3, d.defs.length) + ',var(--b))' : '';
    const all = d.defs.map((x, i) => { const b = mkBtn({ ...x, cls: (x.cls || '') + (grid ? ' cell' : i ? ' sec' : ' prim') + (x.cost ? ' hascost' : '') }); box.appendChild(b); cmdBtns.push(b); return b; });
    // 建築格狀排列：第一個在右下角，由右到左、由下到上
    if (grid) {
      const cols = Math.min(3, all.length), rows = Math.ceil(all.length / cols);
      all.forEach((b, i) => { b.style.gridColumn = String(cols - (i % cols)); b.style.gridRow = String(rows - Math.floor(i / cols)); });
    } else layoutArc(all[0], all.slice(1));
  }
  updCmds();
}
function updCmds() {
  const k = selKind(), g = st.g;
  for (const b of cmdBtns) {
    const d = b._d;
    b.classList.toggle('on', !!(d.on && d.on()));
    if (d.cost) b.classList.toggle('poor', !afford(g, ME, d.cost));
    if (d.unit) {
      const lk = unitReq(g, ME, d.unit);
      b.classList.toggle('off', !!lk);
      const c = b.querySelector('.cost');
      if (c) c.textContent = lk ? lk.replace('需主堡 ', '需 ') : costTxt(d.cost);
    }
    if (d.up) {
      const n = nextUp(g, ME, d.up);
      b.classList.toggle('off', n.max || upInProgress(g, ME, d.up));
      const c = b.querySelector('.cost');
      if (c) c.textContent = n.max ? '已滿' : costTxt(n.cost);
    }
    if (d.place) b.classList.toggle('off', !placeOk() || !afford(g, ME, TY[(st.mode as { type: TypeId }).type].cost));
    let badge = '';
    if (d.unit && k.k === 'bld') {
      const n = k.es.reduce((s, x) => s + x.q.filter(q => q.type === d.unit).length, 0);
      const lp = k.es.some(x => x.loop === d.unit);
      badge = (lp ? '∞' : '') + (n ? n : '');
    }
    if (d.up) badge = d.up === 'upg' ? 'Lv' + g.teams[ME].baseLv : g.teams[ME].exp + '/' + EXPAND.add.length;
    b.querySelector('.badge')!.textContent = badge;
    // 指針式倒數：從 12 點鐘方向順時針掃過，未完成的部分蓋暗
    const rem = d.cdf ? Math.max(0, Math.min(1, d.cdf())) : 0, ov = b.querySelector('.cdov') as HTMLElement;
    if (rem > 0) {
      const p = ((1 - rem) * 100).toFixed(1), h = Math.min(100, (1 - rem) * 100 + 1.5).toFixed(1);
      ov.style.background = 'conic-gradient(transparent 0 ' + p + '%,var(--accent) ' + p + '% ' + h + '%,rgba(0,0,0,.58) ' + h + '% 100%)';
    } else ov.style.background = 'none';
  }
}

function renderSelInfo() {
  const es = selEnts(), el = $('#selInfo'), g = st.g;
  if (st.mode && st.mode.k === 'place') { el.innerHTML = '<b>放置 ' + TY[st.mode.type].name + '</b>・單指移動建築・雙指移動鏡頭'; return; }
  if (!es.length) { el.innerHTML = '拾荒者聯盟・未選取'; return; }
  const k = selKind();
  if (k.k === 'bld') {
    const b = k.es;
    const items: { ch: string; p: number }[] = [];
    for (const x of b) x.q.forEach((q, i) => items.push({ ch: q.kind === 'unit' ? TY[q.type!].ch : q.kind === 'upg' ? '升' : '擴', p: i === 0 ? q.t / q.total : -1 }));
    items.sort((a, c) => c.p - a.p);
    const chips = items.slice(0, 8).map(it => '<span class="qc' + (it.p >= 0 ? ' run' : '') + '"' + (it.p >= 0 ? ' style="background:conic-gradient(var(--accent) 0 ' + (it.p * 100).toFixed(1) + '%,rgba(255,255,255,.1) ' + (it.p * 100).toFixed(1) + '% 100%)"' : '') + '><i>' + it.ch + '</i></span>').join('') + (items.length > 8 ? ' +' + (items.length - 8) : '');
    const site = b.find(x => !x.built);
    let s = '<b>' + TY[k.type].name + '</b> ×' + b.length;
    if (k.type === 'base' && b[0].built) s += '・採集工兵 ' + minersOf(g, b[0]) + '/' + MINE_CAP;
    if (site) {
      const paused = !builderOf(g, site);
      s += '・' + (paused ? '暫停 ' : '建造中 ') + Math.round((site.prog / (TY[site.type].bt! * 20)) * 100) + '%' + (paused ? '（選工兵點這棟繼續蓋）' : '');
    }
    s += items.length ? '・生產中' + chips : PROD[k.type] ? '・點地圖設集結點' : '';
    el.innerHTML = s;
    return;
  }
  el.innerHTML = [...countBy(es)].map(([t, n]) => '<b>' + TY[t].name + '</b>×' + n).join('・');
}

const mmss = (sec: number) => Math.floor(sec / 60) + ':' + String(Math.floor(sec % 60)).padStart(2, '0');
let lastRate = '';
export function refreshHUD() {
  const g = st.g, T = g.teams[ME];
  $('#clock').textContent = mmss(g.tick / 20);
  $('#rs').textContent = String(Math.floor(T.scrap / K));
  $('#rg').textContent = String(Math.floor(T.gas / K));
  let rate = 0;
  for (const e of g.ents) if (e.team === ME && e.type === 'pump' && e.built) rate += e.rate;
  const rs = ' +' + (rate / K).toFixed(1) + '/s';
  if (rs !== lastRate) { $('#rgr').textContent = rs; lastRate = rs; }
  const pu = popUsed(g, ME), pc = popCap(g, ME);
  $('#pu').textContent = String(pu);
  $('#pc').textContent = String(pc);
  $('#popEl').classList.toggle('full', pu >= pc);
  const idle = own(e => e.type === 'worker' && e.order.k === 'idle').length;
  $('#btnIdle').innerHTML = '閒' + (idle ? '<span class="bdg">' + idle + '</span>' : '');
  st.events = st.events.filter(e => now() - e.t < EV_LIFE);
  const un = st.events.length;
  $('#evBtn').innerHTML = '<span class="ch">!</span><span class="lb">事件</span>' + (un ? '<span class="bdg">' + un + '</span>' : '');
  $('#evBtn').classList.toggle('hot', un > 0);
  renderSelInfo();
  renderSlots();
  updCmds();
  const k = selKind();
  $('#qCancel').hidden = !(k.k === 'bld' && k.es.some(x => x.q.length));
}
export function refreshAll(force = false) { refreshCmds(force); refreshHUD(); }

// ---------- 小地圖 ----------
let mm: HTMLCanvasElement, mctx: CanvasRenderingContext2D, mmFog: HTMLCanvasElement, mmFogCtx: CanvasRenderingContext2D, mmImg: ImageData;
export function sizeMinimap() {
  const r = mm.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
  mm.width = Math.round(r.width * dpr);
  mm.height = Math.round(r.height * dpr);
}
export function drawMini() {
  const g = st.g, w = mm.width, h = mm.height, sx = w / W, sy = h / H, dpr = w / Math.max(1, mm.getBoundingClientRect().width);
  mctx.setTransform(1, 0, 0, 1, 0, 0);
  mctx.fillStyle = '#2b3427';
  mctx.fillRect(0, 0, w, h);
  const f = g.fog[ME];
  for (const e of g.ents) {
    const isRes = TY[e.type].cat === 'res';
    if (e.team !== ME && !isRes) {
      const gx = Math.floor(e.x / SUB / 40), gy = Math.floor(e.y / SUB / 40);
      if (!f.vis[gy * GW + gx]) continue;
    }
    mctx.fillStyle = isRes ? '#c9a172' : e.team === ME ? '#62b4ff' : '#ff6e5c';
    const s = (isB(e) ? 5 : isRes ? 3 : 2.2) * dpr;
    mctx.fillRect(ex(e) * sx - s / 2, ey(e) * sy - s / 2, s, s);
  }
  mctx.fillStyle = '#ff6e5c';
  for (const [id, gh] of st.ghosts) if (!g.byId.get(id) || !g.byId.get(id)!.dead) { const s = 5 * dpr; mctx.globalAlpha = 0.6; mctx.fillRect((gh.x / SUB) * sx - s / 2, (gh.y / SUB) * sy - s / 2, s, s); mctx.globalAlpha = 1; }
  // 迷霧
  const d = mmImg.data;
  for (let i = 0; i < GW * GH; i++) { d[i * 4 + 3] = f.vis[i] ? 0 : f.exp[i] ? 110 : 215; }
  mmFogCtx.putImageData(mmImg, 0, 0);
  mctx.imageSmoothingEnabled = true;
  mctx.drawImage(mmFog, 0, 0, GW * 40 * sx, GH * 40 * sy);
  if (Math.floor(now() / 333) % 2) for (const ev of st.events) {
    mctx.strokeStyle = '#e3a948'; mctx.lineWidth = 1.5 * dpr;
    mctx.beginPath(); mctx.arc(ev.x * sx, ev.y * sy, 6 * dpr, 0, 7); mctx.stroke();
  }
  const hw = view.w / 2 / cam.z, hh = view.h / 2 / cam.z;
  mctx.strokeStyle = '#ece6d6';
  mctx.lineWidth = 1.2 * dpr;
  mctx.strokeRect((cam.x - hw) * sx, (cam.y - hh) * sy, hw * 2 * sx, hh * 2 * sy);
}
function initMinimap() {
  mm = $('#mm') as HTMLCanvasElement;
  mctx = mm.getContext('2d')!;
  mmFog = document.createElement('canvas');
  mmFog.width = GW; mmFog.height = GH;
  mmFogCtx = mmFog.getContext('2d')!;
  mmImg = mmFogCtx.createImageData(GW, GH);
  for (let i = 0; i < GW * GH; i++) { mmImg.data[i * 4] = 10; mmImg.data[i * 4 + 1] = 12; mmImg.data[i * 4 + 2] = 9; }
  let MM: { sx: number; sy: number; drag: boolean } | null = null;
  const mmWorld = (ev: PointerEvent) => { const r = mm.getBoundingClientRect(); return { x: ((ev.clientX - r.left) / r.width) * W, y: ((ev.clientY - r.top) / r.height) * H }; };
  mm.addEventListener('pointerdown', ev => { ev.preventDefault(); try { mm.setPointerCapture(ev.pointerId); } catch { /* 不支援就略過 */ } MM = { sx: ev.clientX, sy: ev.clientY, drag: false }; });
  mm.addEventListener('pointermove', ev => {
    if (!MM) return;
    if (!MM.drag && Math.hypot(ev.clientX - MM.sx, ev.clientY - MM.sy) > 6) { MM.drag = true; gesture('<b>按住小地圖拖曳</b> → 移動鏡頭'); }
    if (MM.drag) { const w = mmWorld(ev); cam.x = w.x; cam.y = w.y; clampCam(); stopCamAnim(); }
  });
  const up = (ev: PointerEvent) => {
    if (!MM) return;
    const was = MM;
    MM = null;
    if (was.drag || ev.type === 'pointercancel') return;
    const w = mmWorld(ev);
    cam.z = defZ(); cam.x = w.x; cam.y = w.y; clampCam(); stopCamAnim();
    gesture('<b>點小地圖</b> → 鏡頭移到這裡');
  };
  mm.addEventListener('pointerup', up);
  mm.addEventListener('pointercancel', up);
}

/** 鏡頭可以超出地圖邊緣，超出量＝該側介面按鈕佔的寬度 */
export function measurePad(pad: { l: number; r: number; t: number; b: number }) {
  const ar = $('#app').getBoundingClientRect(), cat = $('#cats').getBoundingClientRect(), tl = $('#tl').getBoundingClientRect(), cmd = $('#cmdArea').getBoundingClientRect();
  pad.l = cat.right - ar.left + 8;
  pad.r = ar.right - cmd.left + 40;
  pad.t = tl.bottom - ar.top + 8;
  pad.b = ar.bottom - cat.top + 8;
}

export function initHud() {
  buildCats();
  buildSlots();
  initMinimap();
  bindPress($('#btnClear'), () => { setSel([], true); gesture('<b>✕</b> → 取消選取'); });
  bindPress($('#btnArmy'), () => { const l = own(isCombat); if (!l.length) { toast('沒有部隊'); return; } selectAndJump(l, 'army', '<b>全部部隊</b> → ' + l.length + ' 個（地面＋空軍，不含工兵）'); });
  bindPress($('#btnIdle'), () => { const l = own(e => e.type === 'worker' && e.order.k === 'idle'); if (!l.length) { toast('沒有閒置工兵'); return; } selectAndJump(l, 'idle', '<b>閒置工兵</b> → ' + l.length + ' 個'); });
  bindPress($('#evBtn'), eventJump);
  bindPress($('#qCancel'), cancelCurrent);
  // 點選單以外的地方關閉選單；分類選單關閉時照常執行這一點，其他選單的關閉點擊不作用
  document.addEventListener('pointerdown', ev => {
    if (!popIsOpen() || popContains(ev.target)) return;
    const wasCat = popAnchorIsCat();
    closePop();
    if (ev.target === $('#cv') && !wasCat) ev.stopPropagation();
  }, true);
}

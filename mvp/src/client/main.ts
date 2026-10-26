import './style.css';
import { Bot } from '../bot/bot';
import { TY } from '../sim/data';
import { visibleAt, step, type TeamCmd } from '../sim/sim';
import { clampCam, defZ, stepCam } from './actions';
import { buzz, sfx, unlockAudio } from './audio';
import { closePop, drawMini, initHud, measurePad, placePop, pushEvent, refreshAll, refreshCmds, refreshHUD, sizeMinimap, tickMessages, toast } from './hud';
import { resetHints, tickHints } from './hints';
import { circleState, initInput, stepInput } from './input';
import { C, draw, initRender, resizeRender, w2s } from './render';
import { ME, PAD, cam, issue, newGame, now, st, view } from './state';
import { VERSION } from './version';

const $ = (s: string) => document.querySelector(s) as HTMLElement;
const TICK_MS = 50;

function resize() {
  const r = $('#app').getBoundingClientRect();
  view.w = r.width;
  view.h = r.height;
  resizeRender(view.w, view.h);
  sizeMinimap();
  measurePad(PAD);
  clampCam();
  placePop();
  refreshCmds(true);
}

const sheetOpen = () => [...document.querySelectorAll('.sheet')].some(s => !(s as HTMLElement).hidden);
const running = () => st.started && st.g.winner < 0 && !sheetOpen() && !document.hidden;

function startGame() {
  newGame();
  resetHints();
  st.started = true;
  for (const s of document.querySelectorAll('.sheet')) (s as HTMLElement).hidden = true;
  cam.z = defZ();
  cam.x = 640;
  cam.y = 1780;
  clampCam();
  closePop();
  refreshAll(true);
  toast('拾荒者內戰：摧毀對方所有主堡就獲勝');
}

function handleEvents() {
  for (const ev of st.g.events) {
    if (ev.k === 'died') {
      if (ev.team === ME || visibleAt(st.g, ME, ev.x * 16, ev.y * 16)) {
        const r = TY[ev.type!].r;
        st.fx.push({ x: ev.x, y: ev.y, t0: now(), c: ev.team === ME ? C.ally : C.enemy, r: r * 1.6, kind: 'boom' });
      }
      continue;
    }
    if (ev.k === 'end') { showEnd(); continue; }
    if (ev.team !== ME) continue;
    if (ev.k === 'attacked') {
      if (pushEvent(ev.x, ev.y, ev.text, 'atk')) { sfx('attack'); buzz([30, 40, 30]); }
    } else if (ev.k === 'built' || ev.k === 'upgraded') {
      pushEvent(ev.x, ev.y, ev.text, 'done');
      toast(ev.text);
      sfx('done');
      refreshAll(true);
    } else if (ev.k === 'fail') {
      pushEvent(ev.x, ev.y, ev.text, 'fail');
      toast(ev.text, 'bad');
    }
  }
}

function showEnd() {
  const g = st.g, w = g.winner;
  const t = $('#endTitle');
  t.textContent = w === ME ? '勝利' : w === 2 ? '和局' : '戰敗';
  t.className = w === ME ? 'win' : w === 2 ? '' : 'lose';
  const m = Math.floor(g.tick / 20 / 60), s = Math.floor((g.tick / 20) % 60);
  $('#endSub').textContent = '對戰時間 ' + m + ' 分 ' + s + ' 秒';
  const a = g.teams[0].stats, b = g.teams[1].stats;
  const row = (k: string, x: number, y: number) => '<tr><td>' + k + '</td><td>' + x + '</td><td>' + y + '</td></tr>';
  $('#endStats').innerHTML = '<thead><tr><th></th><th>你</th><th>電腦</th></tr></thead><tbody>'
    + row('生產單位', a.made, b.made) + row('擊毀', a.killed, b.killed) + row('損失', a.lost, b.lost)
    + row('採集廢料', a.mined, b.mined) + row('輻能氣', Math.floor(a.gassed / 1000), Math.floor(b.gassed / 1000)) + '</tbody>';
  $('#endSheet').hidden = false;
  sfx(w === ME ? 'win' : 'lose');
}

function renderSettings() {
  const box = $('#setList');
  box.innerHTML = '';
  const tog = (label: string, key: 'sound' | 'haptic') => {
    const r = document.createElement('div');
    r.className = 'tog';
    r.innerHTML = '<span>' + label + '</span>';
    const b = document.createElement('button');
    const upd = () => { b.textContent = st.settings[key] ? '開' : '關'; b.className = st.settings[key] ? 'on' : ''; };
    b.addEventListener('click', () => { st.settings[key] = !st.settings[key]; saveSettings(); upd(); });
    upd();
    r.appendChild(b);
    box.appendChild(r);
  };
  tog('提示音', 'sound');
  tog('震動（Android）', 'haptic');
}
function saveSettings() { try { localStorage.setItem('rtsMvpSet', JSON.stringify(st.settings)); } catch { /* 略過 */ } }
function loadSettings() { try { Object.assign(st.settings, JSON.parse(localStorage.getItem('rtsMvpSet') || '{}')); } catch { /* 略過 */ } }

function bindSheets() {
  document.addEventListener('click', e => {
    const t = (e.target as HTMLElement).closest('[data-open],[data-close]') as HTMLElement | null;
    if (!t) return;
    if (t.dataset.open) $('#' + t.dataset.open).hidden = false;
    if (t.dataset.close) $('#' + t.dataset.close).hidden = true;
  });
  $('#btnGo').addEventListener('click', () => { unlockAudio(); startGame(); });
  $('#btnAgain').addEventListener('click', () => { unlockAudio(); startGame(); });
  $('#btnSet').addEventListener('click', () => { renderSettings(); $('#setSheet').hidden = false; });
  $('#btnSurrender').addEventListener('click', () => { $('#setSheet').hidden = true; issue({ c: 'surrender' }); });
  $('#btnFs').addEventListener('click', () => {
    const d = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
    const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
    if (d.fullscreenElement || d.webkitFullscreenElement) { (d.exitFullscreen || d.webkitExitFullscreen)!.call(d); return; }
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    const fail = () => toast('這個環境不支援全螢幕：可以用瀏覽器的「加到主畫面」', 'bad');
    if (!req) { fail(); return; }
    try {
      const r = req.call(el, { navigationUI: 'hide' } as FullscreenOptions);
      if (r && r.then) r.then(() => { try { (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape').catch(() => {}); } catch { /* 略過 */ } setTimeout(resize, 200); }).catch(fail);
    } catch { fail(); }
  });
  ['gesturestart', 'gesturechange'].forEach(t => document.addEventListener(t, e => e.preventDefault()));
  document.addEventListener('contextmenu', e => e.preventDefault());
}

let last = now(), acc = 0, hudT = 0, mmT = 0;
function frame() {
  const t = now();
  const dt = Math.min(250, t - last);
  last = t;
  if (st.started) {
    if (running()) {
      acc += dt;
      while (acc >= TICK_MS) {
        const cmds: TeamCmd[] = st.pending.map(cmd => ({ team: ME, cmd }));
        st.pending = [];
        for (const cmd of st.bot.think(st.g)) cmds.push({ team: 1, cmd });
        step(st.g, cmds);
        handleEvents();
        tickHints();
        acc -= TICK_MS;
      }
    }
    stepCam(t);
    stepInput(t);
    tickMessages(dt / 1000);
    hudT -= dt;
    if (hudT <= 0) { hudT = 120; refreshHUD(); refreshCmds(false); }
    mmT -= dt;
    if (mmT <= 0) { mmT = 200; drawMini(); }
    draw(running() ? acc / TICK_MS : 1, circleState());
  }
  requestAnimationFrame(frame);
}

async function boot() {
  for (const el of document.querySelectorAll('.ver')) el.textContent = VERSION;
  loadSettings();
  await initRender($('#cv') as HTMLCanvasElement);
  initHud();
  initInput($('#cv') as HTMLCanvasElement);
  bindSheets();
  newGame();
  resize();
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', () => { last = now(); acc = 0; });
  // 測試用
  (window as unknown as { __rts: unknown }).__rts = {
    st, cam, view, issue, w2s, start: startGame, Bot,
    ff(sec: number, auto?: Bot) { for (let i = 0; i < sec * 20 && st.g.winner < 0; i++) { const cmds: TeamCmd[] = st.pending.map(cmd => ({ team: ME, cmd })); st.pending = []; if (auto) for (const cmd of auto.think(st.g)) cmds.push({ team: ME, cmd }); for (const cmd of st.bot.think(st.g)) cmds.push({ team: 1, cmd }); step(st.g, cmds); handleEvents(); } },
  };
  requestAnimationFrame(frame);
}
boot();

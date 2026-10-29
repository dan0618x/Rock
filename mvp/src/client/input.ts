// 地圖手勢：點、連點、按住圈選、拖曳、雙指縮放、放置模式。放開手指時才判定，不加延遲。
import { circleSelect, clampCam, handleTap, stopCamAnim } from './actions';
import { unlockAudio } from './audio';
import { gesture } from './hud';
import { K, s2w } from './render';
import { W, H, cam, now, st, view } from './state';

type G =
  | { k: 'pend' | 'pan'; sx: number; sy: number; lx: number; ly: number; t0: number; lp?: number }
  | { k: 'circle'; sx: number; sy: number; t0: number; ct0: number; r: number }
  | { k: 'pinch'; d0: number; z0: number; w0: { x: number; y: number } }
  | { k: 'ghost' }
  | { k: 'dead' };

const ptrs = new Map<number, { x: number; y: number }>();
let G: G | null = null;

export const circleState = () => (G && G.k === 'circle' ? { sx: G.sx, sy: G.sy, r: G.r } : null);

/** 每幀呼叫：圈選範圍隨時間展開，再約 0.93 秒展開到最大 */
export function stepInput(t: number) {
  if (G && G.k === 'circle') {
    const maxR = Math.min(view.w, view.h) * 0.42;
    G.r = Math.min(maxR, (maxR * (t - G.ct0)) / 930);
    if (G.r >= maxR) finishCircle();
  }
}
function finishCircle() {
  if (!G || G.k !== 'circle') return;
  const secs = ((now() - G.t0) / 1000).toFixed(1);
  const { sx, sy, r } = G;
  G = { k: 'dead' };
  circleSelect(sx, sy, r, secs);
}
function setGhost(sx: number, sy: number) {
  const m = st.mode;
  if (!m || m.k !== 'place') return;
  const w = s2w(sx, sy);
  m.x = Math.max(0, Math.min(W, w.x));
  m.y = Math.max(0, Math.min(H, w.y));
}

export function initInput(cv: HTMLCanvasElement) {
  cv.addEventListener('pointerdown', ev => {
    ev.preventDefault();
    unlockAudio();
    try { cv.setPointerCapture(ev.pointerId); } catch { /* 略過 */ }
    ptrs.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (ptrs.size === 1) {
      if (st.mode && st.mode.k === 'place') { G = { k: 'ghost' }; setGhost(ev.clientX, ev.clientY); return; }
      const g: G = { k: 'pend', sx: ev.clientX, sy: ev.clientY, lx: ev.clientX, ly: ev.clientY, t0: now() };
      G = g;
      if (!st.mode || st.mode.k === 'attack')
        g.lp = window.setTimeout(() => {
          if (G === g && g.k === 'pend') {
            G = { k: 'circle', sx: g.sx, sy: g.sy, t0: g.t0, ct0: now(), r: 0 };
            gesture('<b>按住 0.5 秒</b> → 圈選展開中，放開即選取');
          }
        }, 500);
    } else if (ptrs.size === 2) {
      if (G && 'lp' in G) clearTimeout(G.lp);
      const [a, b] = [...ptrs.values()];
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      G = { k: 'pinch', d0: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), z0: cam.z, w0: s2w(m.x, m.y) };
      gesture(st.mode && st.mode.k === 'place' ? '<b>雙指</b> → 移動鏡頭／縮放（放置中）' : '<b>雙指</b> → 縮放（不會下指令）');
    }
  });
  cv.addEventListener('pointermove', ev => {
    if (!ptrs.has(ev.pointerId) || !G) return;
    ptrs.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (G.k === 'ghost') { setGhost(ev.clientX, ev.clientY); return; }
    if (G.k === 'pinch' && ptrs.size >= 2) {
      const [a, b] = [...ptrs.values()];
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      cam.z = (G.z0 * Math.hypot(a.x - b.x, a.y - b.y)) / G.d0;
      clampCam();
      cam.x = G.w0.x - (m.x - view.w / 2) / cam.z;
      cam.y = G.w0.y - (m.y - view.h / 2) / (cam.z * K);
      clampCam();
      stopCamAnim();
    } else if (G.k === 'pend' || G.k === 'pan') {
      if (G.k === 'pend' && Math.hypot(ev.clientX - G.sx, ev.clientY - G.sy) > 10) {
        G.k = 'pan';
        clearTimeout(G.lp);
        gesture('<b>單指拖曳</b> → 移動鏡頭');
      }
      if (G.k === 'pan') {
        cam.x -= (ev.clientX - G.lx) / cam.z;
        cam.y -= (ev.clientY - G.ly) / (cam.z * K);
        clampCam();
        stopCamAnim();
      }
      G.lx = ev.clientX;
      G.ly = ev.clientY;
    }
  });
  const end = (ev: PointerEvent) => {
    if (!ptrs.has(ev.pointerId)) return;
    ptrs.delete(ev.pointerId);
    if (!G) return;
    if (G.k === 'pinch' || G.k === 'dead') { if (ptrs.size === 0) G = null; else G = { k: 'dead' }; return; }
    if ('lp' in G) clearTimeout(G.lp);
    if (ev.type !== 'pointercancel') {
      if (G.k === 'circle') finishCircle();
      else if (G.k === 'pend') handleTap(ev.clientX, ev.clientY);
    }
    G = null;
  };
  cv.addEventListener('pointerup', end);
  cv.addEventListener('pointercancel', end);
  cv.addEventListener('wheel', ev => {
    ev.preventDefault();
    const w = s2w(ev.clientX, ev.clientY);
    cam.z *= Math.exp(-ev.deltaY * 0.0015);
    clampCam();
    cam.x = w.x - (ev.clientX - view.w / 2) / cam.z;
    cam.y = w.y - (ev.clientY - view.h / 2) / (cam.z * K);
    clampCam();
  }, { passive: false });
}

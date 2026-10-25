// 關鍵提示音（WebAudio 合成）與震動回饋。
import { st } from './state';

let ac: AudioContext | null = null;
/** 第一次觸控時才能建立音效環境（瀏覽器限制） */
export function unlockAudio() {
  if (ac) { if (ac.state === 'suspended') ac.resume().catch(() => {}); return; }
  try { ac = new AudioContext(); } catch { ac = null; }
}

function tone(freq: number, at: number, dur: number, type: OscillatorType = 'sine', vol = 0.12) {
  if (!ac) return;
  const t = ac.currentTime + at;
  const o = ac.createOscillator(), g = ac.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(ac.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

const last: Record<string, number> = {};
/** 同類提示音有冷卻時間，大戰時不會洗版 */
const COOL: Record<string, number> = { attack: 6000, done: 600, err: 300, unit: 400 };

export function sfx(kind: 'attack' | 'done' | 'err' | 'win' | 'lose' | 'unit') {
  if (!st.settings.sound || !ac) return;
  const t = performance.now();
  if (COOL[kind] && t - (last[kind] || 0) < COOL[kind]) return;
  last[kind] = t;
  switch (kind) {
    case 'attack': tone(660, 0, 0.16, 'square', 0.07); tone(440, 0.18, 0.22, 'square', 0.07); break;
    case 'done': tone(880, 0, 0.12); tone(1320, 0.1, 0.18); break;
    case 'unit': tone(740, 0, 0.08, 'triangle', 0.06); break;
    case 'err': tone(180, 0, 0.12, 'sawtooth', 0.05); break;
    case 'win': [523, 659, 784, 1046].forEach((f, i) => tone(f, i * 0.14, 0.3)); break;
    case 'lose': [392, 330, 262].forEach((f, i) => tone(f, i * 0.2, 0.35, 'triangle')); break;
  }
}

export function buzz(ms: number | number[]) {
  if (!st.settings.haptic) return;
  try { navigator.vibrate?.(ms); } catch { /* 不支援就略過 */ }
}

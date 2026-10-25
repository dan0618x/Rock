// 模擬核心只用整數運算，任何裝置算出的結果都一樣。
// 禁止：Math.random、Math.sin/cos/atan2/hypot/pow/exp、Date、performance。

/** 1 像素 = 16 個模擬單位 */
export const S = 16;
/** 每秒 20 步 */
export const TPS = 20;

export const idiv = (a: number, b: number) => Math.trunc(a / b);

/** 整數平方根（無條件捨去），先用浮點估計再校正，結果與平台無關 */
export function isqrt(n: number): number {
  if (n <= 0) return 0;
  let r = Math.floor(Math.sqrt(n));
  while (r * r > n) r--;
  while ((r + 1) * (r + 1) <= n) r++;
  return r;
}

export const dist2 = (ax: number, ay: number, bx: number, by: number) => {
  const dx = ax - bx, dy = ay - by;
  return dx * dx + dy * dy;
};
export const dist = (ax: number, ay: number, bx: number, by: number) => isqrt(dist2(ax, ay, bx, by));

/** 秒 → 步數 */
export const ticks = (sec: number) => Math.max(1, Math.round(sec * TPS));
/** 像素 → 模擬單位 */
export const px = (v: number) => Math.round(v * S);
/** 每秒像素 → 每步模擬單位 */
export const speedPerTick = (pxPerSec: number) => Math.max(1, Math.round((pxPerSec * S) / TPS));

/** xorshift32 亂數，狀態存在遊戲狀態裡 */
export function nextRand(st: { rng: number }): number {
  let x = st.rng | 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  st.rng = x | 0;
  return (x >>> 0) / 4294967296;
}
export const randInt = (st: { rng: number }, n: number) => Math.floor(nextRand(st) * n);

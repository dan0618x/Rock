// 新手提示：在適當時機用一句話提醒下一步，每則只出現一次。不是教學關卡，只是避免第一場卡住。
import { hasBuilt, isCombat, own, popCap, popUsed } from '../sim/sim';
import { toast } from './hud';
import { ME, st } from './state';

interface Hint { id: string; when: () => boolean; text: string }

const sec = () => st.g.tick / 20;
const count = (t: string) => own(st.g, ME, e => e.type === t).length;
const planned = (t: string) => own(st.g, ME, e => e.type === 'worker' && ((e.order.k === 'build' && e.order.type === t) || e.bq.some(j => j.type === t))).length;

const HINTS: Hint[] = [
  { id: 'worker', when: () => sec() > 6 && count('worker') <= 3 && !st.g.ents.some(e => e.team === ME && e.q.length), text: '提示：點主堡 → 右下「工」生產工兵，工兵越多廢料越多' },
  { id: 'barracks', when: () => sec() > 45 && count('barracks') + planned('barracks') === 0, text: '提示：左下「工」選工兵 → 右下「建」→ 兵營，才能生產部隊' },
  { id: 'pump', when: () => sec() > 100 && count('pump') + planned('pump') === 0, text: '提示：蓋抽氣塔採輻能氣，火箭兵、空軍都需要' },
  { id: 'pop', when: () => popCap(st.g, ME) > 0 && popUsed(st.g, ME) >= popCap(st.g, ME) - 1 && st.g.teams[ME].exp < 4, text: '提示：人口快滿了，點主堡 →「擴」擴建' },
  { id: 'upg', when: () => sec() > 180 && hasBuilt(st.g, ME, 'barracks') && st.g.teams[ME].baseLv < 2, text: '提示：主堡「升」到 Lv2 可以解鎖火箭兵和空軍基地' },
  { id: 'army', when: () => own(st.g, ME, isCombat).length >= 6, text: '提示：左上「全」選全部部隊，右下「攻」開火；點地面只移動不開火' },
  { id: 'group', when: () => own(st.g, ME, isCombat).length >= 10 && st.slots.every(s => !s.length), text: '提示：選好部隊後點下方空的編隊格存起來，之後一點就選回來' },
];

const shown = new Set<string>();
let next = 0;
export function resetHints() { shown.clear(); next = 0; }
/** 每秒檢查一次，一次只顯示一則 */
export function tickHints() {
  if (!st.started || st.g.winner >= 0 || st.mode || st.g.tick < next) return;
  next = st.g.tick + 20;
  for (const h of HINTS) {
    if (shown.has(h.id) || !h.when()) continue;
    shown.add(h.id);
    toast(h.text, 'hint', 6);
    next = st.g.tick + 20 * 8;
    return;
  }
}

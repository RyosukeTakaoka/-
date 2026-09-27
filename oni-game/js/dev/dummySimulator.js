// ダミープレイヤーの動きをまねるシミュレーター（Firebase 導入前の動作確認用）
// 他の端末の代わりに、ダミーの位置を更新し、ダミーの鬼に確保操作をさせる。
// 実際の端末の代わりなので、ゲーム側と同じアクション（updatePosition / requestCapture）だけを使う。

import { destinationPoint, distanceM, bearingDeg } from '../utils/distance.js';
import { gameStore, updatePosition, requestCapture, PHASE } from '../game/gameState.js';
import { ROLE, STATUS, activeRunners } from '../game/player.js';

const HUNTER_SPEED_MPS = 3; // 鬼の速さ（小走り）
const RUNNER_SPEED_MPS = 2; // 逃走者の速さ

/**
 * @param {{ getControlledId: () => string|null, intervalMs?: number, rng?: () => number }} options
 *   getControlledId: 人が操作しているプレイヤー（シミュレーターは動かさない）
 * @returns {() => void} 停止する関数
 */
export function startDummySimulator({ getControlledId, intervalMs = 1000, rng = Math.random }) {
  const headings = new Map();

  function step() {
    const s = gameStore.getState();
    if (s.phase !== PHASE.PLAYING) return;
    const now = Date.now();
    const dt = intervalMs / 1000;
    const dummies = s.players.filter(
      (p) => p.isDummy && p.status === STATUS.ACTIVE && p.id !== getControlledId() && s.positions[p.id],
    );

    for (const p of dummies) {
      const pos = s.positions[p.id];
      let heading;
      if (p.role === ROLE.HUNTER) {
        heading = chaseHeading(s, pos) ?? wander(p.id, pos, s.area);
      } else {
        heading = wander(p.id, pos, s.area);
      }
      const speed = p.role === ROLE.HUNTER ? HUNTER_SPEED_MPS : RUNNER_SPEED_MPS;
      updatePosition(p.id, destinationPoint(pos, speed * dt, heading), now);
    }

    for (const p of dummies) {
      if (p.role === ROLE.HUNTER) requestCapture(p.id, now);
    }
  }

  // 一番近い逃走者の方へ向かう
  function chaseHeading(s, pos) {
    let best = null;
    for (const r of activeRunners(s.players)) {
      const rp = s.positions[r.id];
      if (!rp) continue;
      const d = distanceM(pos, rp);
      if (!best || d < best.d) best = { d, rp };
    }
    return best ? bearingDeg(pos, best.rp) : null;
  }

  // ふらふら歩く。エリアの端に近づいたら中心へ戻る
  function wander(id, pos, area) {
    let h = headings.get(id) ?? rng() * 360;
    h += (rng() - 0.5) * 60;
    if (distanceM(area.center, pos) > area.radiusM * 0.85) h = bearingDeg(pos, area.center);
    headings.set(id, h);
    return h;
  }

  const timer = setInterval(step, intervalMs);
  return () => clearInterval(timer);
}

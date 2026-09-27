// ダミープレイヤーの動きをまねるシミュレーター（Firebase 導入前の動作確認用）
// 他の端末の代わりに、ダミーの位置を更新し、ダミーの鬼に確保操作をさせる。
// 実際の端末の代わりなので、ゲーム側と同じアクション（updatePosition / requestCapture）だけを使う。
// ダミーの鬼が追いかける先も、本物の鬼と同じく自分のビュー（逃走者の可能性エリア）だけから決める。

import { destinationPoint, distanceM, bearingDeg } from '../utils/distance.js';
import { gameStore, updatePosition, requestCapture, getPlayerView, PHASE } from '../game/gameState.js';
import { ROLE, STATUS } from '../game/player.js';
import { DISPLAY } from '../game/visibility.js';

const HUNTER_SPEED_MPS = 3; // 鬼の速さ（小走り）
const RUNNER_SPEED_MPS = 2; // 逃走者の速さ
const MISSION_ATTEMPT_RATE = 0.7; // ダミーの逃走者がミッションに挑戦する割合（成功・失敗の両方を確認できるように）

/**
 * @param {{ getControlledId: () => string|null, intervalMs?: number, rng?: () => number }} options
 *   getControlledId: 人が操作しているプレイヤー（シミュレーターは動かさない）
 * @returns {() => void} 停止する関数
 */
export function startDummySimulator({ getControlledId, intervalMs = 1000, rng = Math.random }) {
  const headings = new Map();
  const attempts = new Map(); // `${runnerId}:${missionIndex}` -> 挑戦するか

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
        heading = chaseHeading(p.id, pos, now) ?? wander(p.id, pos, s.area);
      } else {
        heading = missionHeading(p.id, pos, now) ?? wander(p.id, pos, s.area);
      }
      const speed = p.role === ROLE.HUNTER ? HUNTER_SPEED_MPS : RUNNER_SPEED_MPS;
      updatePosition(p.id, destinationPoint(pos, speed * dt, heading), now);
    }

    for (const p of dummies) {
      if (p.role === ROLE.HUNTER) requestCapture(p.id, now);
    }
  }

  // 一番近い可能性エリアの方へ向かう（エリアの中に入ったら、その中を探し回る）
  function chaseHeading(hunterId, pos, now) {
    let best = null;
    for (const other of getPlayerView(hunterId, now).others) {
      if (other.display.kind !== DISPLAY.AREA) continue;
      const d = distanceM(pos, other.display.center);
      if (!best || d < best.d) best = { d, area: other.display };
    }
    if (!best || best.d < best.area.radiusM * 0.5) return null;
    return bearingDeg(pos, best.area.center);
  }

  // ミッション中なら（挑戦すると決めた場合）自分の目的地へ向かう。目的地は本人のビューから読む
  function missionHeading(runnerId, pos, now) {
    const mission = getPlayerView(runnerId, now).self?.mission;
    if (!mission?.destination) return null;
    const key = `${runnerId}:${mission.index}`;
    if (!attempts.has(key)) attempts.set(key, rng() < MISSION_ATTEMPT_RATE);
    return attempts.get(key) ? bearingDeg(pos, mission.destination) : null;
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

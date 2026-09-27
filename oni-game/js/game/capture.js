// 確保のルール
//
// ルール:
// - 確保できるのは「参加中の鬼」だけ
// - 鬼の実位置から captureRadiusM 以内にいる「参加中の逃走者」だけが対象
// - 範囲内に複数人いる場合は、1回の確保操作で「最も近い1人」だけを確保する
// - 確保操作のあとは CAPTURE_COOLDOWN_MS の間は再操作できない
//   （連打して「近くに誰かいるか」を探るレーダー代わりに使えないようにするため）
// - 増え鬼ON: 捕まった逃走者は鬼になる / OFF: 脱落（status = caught）
//
// 判定には実位置を使うので、この処理は実位置を持つ側（今は端末内、Firebase導入後は
// 信頼できるサーバー側）で実行する。結果として返すのは「誰を確保したか」だけで、距離や座標は返さない。

import { distanceM } from '../utils/distance.js';
import { ROLE, STATUS, activeRunners } from './player.js';

export const CAPTURE_COOLDOWN_MS = 3000;

export const CAPTURE_FAILURE = Object.freeze({
  NOT_PLAYING: 'not_playing',
  NOT_HUNTER: 'not_hunter',
  NO_POSITION: 'no_position',
  COOLDOWN: 'cooldown',
  NO_TARGET: 'no_target',
});

export const CAPTURE_FAILURE_MESSAGE = Object.freeze({
  [CAPTURE_FAILURE.NOT_PLAYING]: 'ゲーム中ではありません',
  [CAPTURE_FAILURE.NOT_HUNTER]: '確保できるのは鬼だけです',
  [CAPTURE_FAILURE.NO_POSITION]: '位置情報を取得できていません',
  [CAPTURE_FAILURE.COOLDOWN]: '少し待ってからもう一度試してください',
  [CAPTURE_FAILURE.NO_TARGET]: '確保できる距離に逃走者はいません',
});

/** 鬼の確保範囲内にいる参加中の逃走者を、近い順に返す（内部処理用。画面には出さない） */
export function findCaptureTargets({ players, positions, settings }, hunterId) {
  const hunterPos = positions[hunterId];
  if (!hunterPos) return [];
  return activeRunners(players)
    .filter((r) => positions[r.id])
    .map((r) => ({ player: r, distance: distanceM(hunterPos, positions[r.id]) }))
    .filter((t) => t.distance <= settings.captureRadiusM)
    .sort((a, b) => a.distance - b.distance);
}

/** 捕まった逃走者に確保を反映する */
export function applyCapture(runner, hunterId, { zombieMode }, now) {
  const caught = { ...runner, caughtAt: now, caughtBy: hunterId };
  return zombieMode
    ? { ...caught, role: ROLE.HUNTER, status: STATUS.ACTIVE, blurM: null }
    : { ...caught, status: STATUS.CAUGHT };
}

/**
 * 確保を試みる。
 * @returns {{ ok: false, reason: string } | { ok: true, capturedId: string, players: object[] }}
 */
export function attemptCapture(state, hunterId, now) {
  if (state.phase !== 'playing') return { ok: false, reason: CAPTURE_FAILURE.NOT_PLAYING };
  const hunter = state.players.find((p) => p.id === hunterId);
  if (!hunter || hunter.role !== ROLE.HUNTER || hunter.status !== STATUS.ACTIVE) {
    return { ok: false, reason: CAPTURE_FAILURE.NOT_HUNTER };
  }
  if (!state.positions[hunterId]) return { ok: false, reason: CAPTURE_FAILURE.NO_POSITION };
  const last = state.captureAttempts[hunterId];
  if (last != null && now - last < CAPTURE_COOLDOWN_MS) return { ok: false, reason: CAPTURE_FAILURE.COOLDOWN };

  const [target] = findCaptureTargets(state, hunterId);
  if (!target) return { ok: false, reason: CAPTURE_FAILURE.NO_TARGET };

  const players = state.players.map((p) => {
    if (p.id === target.player.id) return applyCapture(p, hunterId, state.settings, now);
    if (p.id === hunterId) return { ...p, captures: p.captures + 1 };
    return p;
  });
  return { ok: true, capturedId: target.player.id, players };
}

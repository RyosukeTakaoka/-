// 「誰に・何を見せるか」を決める
//
// 画面（screens/・map/）はプレイヤーの実位置を直接読まず、必ず buildPlayerView() の結果だけを描画する。
// Firebase 導入後は、この処理を信頼できる側（サーバー）で実行し、各端末には自分用のビューだけを配信する。
// つまり「鬼の端末に実位置を送ってから画面で隠す」のではなく、鬼に届くデータに最初から実位置が無い。
//
// 表示ルール（ゲーム中）:
// | 見る人 ＼ 見られる人 | 鬼                         | 参加中の逃走者          | 脱落者 |
// | 鬼                   | 実位置                     | 可能性エリアだけ        | なし   |
// | 参加中の逃走者       | 実位置（設定でOFFにできる） | 実位置（仲間）          | なし   |
// | 脱落者               | 実位置（設定でOFFにできる） | なし（鬼に教えられないように） | なし |
// 自分自身は常に実位置。逃走者は「自分が鬼にどう見えているか」（自分の可能性エリア）も見られる。
// ゲーム外（ロビー・終了後）は位置を一切表示しない。

import { isInsideArea } from './gameArea.js';
import { ROLE, STATUS, activeRunners, originalRunners } from './player.js';
import { CAPTURE_COOLDOWN_MS } from './capture.js';
import { nextRevealAt } from './locationPublisher.js';

export const DISPLAY = Object.freeze({
  EXACT: 'exact', // 正確な位置
  HIDDEN: 'hidden', // 表示しない
  AREA: 'possibleArea', // 可能性エリア
});

const HIDDEN = Object.freeze({ kind: DISPLAY.HIDDEN });

const exact = (pos) => ({ kind: DISPLAY.EXACT, position: { lat: pos.lat, lng: pos.lng } });

/** 公開済みの可能性エリア → ビュー用（中心・半径・公開時刻だけ） */
const possibleArea = (playerId, published) => ({
  kind: DISPLAY.AREA,
  playerId,
  type: 'possibleArea',
  center: { lat: published.center.lat, lng: published.center.lng },
  radiusM: published.radiusM,
  publishedAt: published.publishedAt,
});

/** 相手に見せてよいプレイヤー情報（位置・履歴の詳細・ぼかし精度は含めない） */
function publicInfo(p) {
  return {
    id: p.id,
    name: p.name,
    isHost: p.isHost,
    isDummy: p.isDummy,
    role: p.role,
    originalRole: p.originalRole,
    status: p.status,
    captures: p.captures,
    caughtAt: p.caughtAt,
  };
}

const isActive = (p, role) => p?.role === role && p.status === STATUS.ACTIVE;

function displayFor(viewer, target, state) {
  if (state.phase !== 'playing' || !viewer) return HIDDEN;
  if (target.status !== STATUS.ACTIVE) return HIDDEN;

  if (target.role === ROLE.HUNTER) {
    const pos = state.positions[target.id];
    if (!pos) return HIDDEN;
    if (isActive(viewer, ROLE.HUNTER)) return exact(pos);
    return state.settings.showHuntersToRunners ? exact(pos) : HIDDEN;
  }

  // ここから先は参加中の逃走者
  if (isActive(viewer, ROLE.RUNNER)) {
    const pos = state.positions[target.id];
    return pos ? exact(pos) : HIDDEN; // 仲間
  }
  if (isActive(viewer, ROLE.HUNTER)) {
    // 鬼には実位置を一切使わず、公開済みの可能性エリアだけを渡す
    const published = state.privacy?.published[target.id];
    return published ? possibleArea(target.id, published) : HIDDEN;
  }
  return HIDDEN; // 脱落者
}

/** viewerId の人に見せてよい情報だけをまとめたビュー */
export function buildPlayerView(state, viewerId, now = Date.now()) {
  const viewer = state.players.find((p) => p.id === viewerId) ?? null;
  const playing = state.phase === 'playing';
  const ownPos = playing ? state.positions[viewerId] : null;
  const lastAttempt = state.captureAttempts?.[viewerId];
  const ownArea = playing && isActive(viewer, ROLE.RUNNER) ? state.privacy?.published[viewerId] : null;

  return {
    phase: state.phase,
    now,
    area: state.area,
    settings: state.settings,
    startedAt: state.startedAt,
    endsAt: state.endsAt,
    nextRevealAt: playing ? nextRevealAt(now, state.startedAt, state.settings) : null,
    result: state.result,
    self: viewer && {
      ...publicInfo(viewer),
      position: ownPos ? { lat: ownPos.lat, lng: ownPos.lng, accuracyM: ownPos.accuracyM ?? null } : null,
      outOfArea: Boolean(ownPos && state.area && !isInsideArea(state.area, ownPos)),
      captureReadyAt: lastAttempt != null ? lastAttempt + CAPTURE_COOLDOWN_MS : 0,
      blurM: isActive(viewer, ROLE.RUNNER) ? viewer.blurM : null,
      // 自分が鬼にどう見えているか（自分の可能性エリア）
      possibleArea: ownArea ? possibleArea(viewerId, ownArea) : null,
    },
    others: state.players
      .filter((p) => p.id !== viewerId)
      .map((p) => ({ ...publicInfo(p), display: displayFor(viewer, p, state) })),
    runnersRemaining: activeRunners(state.players).length,
    runnersTotal: originalRunners(state.players).length,
    log: state.log,
  };
}

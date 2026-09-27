// 「誰に・何を見せるか」を決める
//
// 画面（screens/・map/）はプレイヤーの実位置を直接読まず、必ず buildPlayerView() の結果だけを描画する。
// Firebase 導入後は、この処理を信頼できる側で実行し、各端末には自分用のビューだけを配信する想定。
//
// 表示ルール（ゲーム中）:
// - 自分          : 自分の実位置
// - 鬼            : 全員に表示（鬼の位置はゲーム情報として公開）
// - 参加中の逃走者 : 参加中の逃走者（仲間）には表示
//                   鬼・脱落者には実位置を渡さない → STEP 3 で可能性エリア(privacyArea)に置き換える
// - 脱落者        : 誰にも表示しない
// ゲーム外（ロビー・終了後）は位置を一切表示しない。

import { isInsideArea } from './gameArea.js';
import { ROLE, STATUS, activeRunners, originalRunners } from './player.js';
import { CAPTURE_COOLDOWN_MS } from './capture.js';

export const DISPLAY = Object.freeze({
  EXACT: 'exact', // 正確な位置
  HIDDEN: 'hidden', // 表示しない
  AREA: 'area', // 可能性エリア（STEP 3）
});

const HIDDEN = Object.freeze({ kind: DISPLAY.HIDDEN });

const exact = (pos) => ({ kind: DISPLAY.EXACT, position: { lat: pos.lat, lng: pos.lng } });

/** 相手に見せてよいプレイヤー情報（位置・履歴の詳細は含めない） */
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

function displayFor(viewer, target, state) {
  if (state.phase !== 'playing') return HIDDEN;
  const pos = state.positions[target.id];
  if (!pos || target.status !== STATUS.ACTIVE) return HIDDEN;
  if (target.role === ROLE.HUNTER) return exact(pos);
  // ここから先は逃走者
  const viewerIsActiveRunner = viewer?.role === ROLE.RUNNER && viewer.status === STATUS.ACTIVE;
  if (viewerIsActiveRunner) return exact(pos);
  // 鬼・脱落者には実位置を渡さない（STEP 3: 可能性エリアを返す）
  return HIDDEN;
}

/** viewerId の人に見せてよい情報だけをまとめたビュー */
export function buildPlayerView(state, viewerId, now = Date.now()) {
  const viewer = state.players.find((p) => p.id === viewerId) ?? null;
  const ownPos = state.phase === 'playing' ? state.positions[viewerId] : null;
  const lastAttempt = state.captureAttempts?.[viewerId];

  return {
    phase: state.phase,
    now,
    area: state.area,
    settings: state.settings,
    startedAt: state.startedAt,
    endsAt: state.endsAt,
    result: state.result,
    self: viewer && {
      ...publicInfo(viewer),
      position: ownPos ? { lat: ownPos.lat, lng: ownPos.lng, accuracyM: ownPos.accuracyM ?? null } : null,
      outOfArea: Boolean(ownPos && state.area && !isInsideArea(state.area, ownPos)),
      captureReadyAt: lastAttempt != null ? lastAttempt + CAPTURE_COOLDOWN_MS : 0,
    },
    others: state.players
      .filter((p) => p.id !== viewerId)
      .map((p) => ({ ...publicInfo(p), display: displayFor(viewer, p, state) })),
    runnersRemaining: activeRunners(state.players).length,
    runnersTotal: originalRunners(state.players).length,
    log: state.log,
  };
}

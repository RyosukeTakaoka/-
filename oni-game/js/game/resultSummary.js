// ゲーム結果のまとめ（結果画面・将来の公開用結果データ）
//
// 終了時点のゲーム状態から「ゲーム結果」だけを作る純粋な関数。画面にも Firebase にも依存しない。
// 位置情報は一切使わない（state.positions / state.privacy / 目的地を読まない）。
// gameState.finish() では、位置情報を破棄した「後」の状態からこれを作る。
//
// 含めないもの: GPS座標・移動履歴・可能性エリアの中心と半径（blurM）・秘密値・目的地・ミッション達成時刻・
//               誰が誰を確保したか・正確な確保時刻
//
// 構造:
// {
//   gameId, winner, reason, headline, durationMin, playedMs, zombieMode,
//   players:  [{ id, name, startRole, finalRole, roleChanged, caught, caughtAfterMin, captures, survived }],
//   missions: [{ index, status, success, failure, cancelled }]      … 4回分。全員に見せてよい集計
//   personal: { [playerId]: { missions: [{ index, result }] } }       … 本人にだけ見せる（resultViewFor で絞る）
// }
// Firebase 導入後: personal 以外を公開用の結果として書き込み、personal[id] は本人だけが読める場所に置く想定。

import { MISSION_COUNT } from './missionSchedule.js';
import { WINNER, FINISH_REASON } from './outcome.js';
import { ROLE, STATUS } from './player.js';

export const MISSION_SUMMARY_STATUS = Object.freeze({
  COMPLETED: 'completed', // 制限時間まで行われた
  ENDED_BY_GAME_OVER: 'ended_by_game_over', // ゲーム終了で打ち切り（結果は無効）
  NOT_HELD: 'not_held', // ゲームが先に終わって発生しなかった
  SKIPPED: 'skipped', // 大きく遅れたため無効（通常は起きない）
});

export const PERSONAL_RESULT = Object.freeze({
  SUCCESS: 'success',
  FAILURE: 'failure',
  CANCELLED: 'cancelled', // 無効（確保された・ゲーム終了・目的地なし）
  NOT_PARTICIPATED: 'not_participated', // 参加していない（鬼・すでに脱落）
});

/** 勝敗と決着理由の見出し */
export function headlineFor(winner, reason) {
  if (reason === FINISH_REASON.TIME_UP && winner === WINNER.RUNNERS) return '時間切れ！逃走者の勝利';
  if (reason === FINISH_REASON.ALL_CAUGHT && winner === WINNER.HUNTERS) return '全員確保！鬼の勝利';
  if (reason === FINISH_REASON.ABORTED) return 'ホストがゲームを終了しました（勝敗なし）';
  return 'ゲーム終了';
}

function countResults(results) {
  const counts = { success: 0, failure: 0, cancelled: 0 };
  for (const r of Object.values(results)) {
    if (r === PERSONAL_RESULT.SUCCESS) counts.success += 1;
    else if (r === PERSONAL_RESULT.FAILURE) counts.failure += 1;
    else counts.cancelled += 1;
  }
  return counts;
}

function missionStatus(entry) {
  if (!entry) return MISSION_SUMMARY_STATUS.NOT_HELD;
  if (entry.skipped) return MISSION_SUMMARY_STATUS.SKIPPED;
  if (entry.endedBy === 'game_over') return MISSION_SUMMARY_STATUS.ENDED_BY_GAME_OVER;
  return MISSION_SUMMARY_STATUS.COMPLETED;
}

/**
 * 結果データを作る。
 * @param {{ gameId, players, missions: { history }, settings, startedAt, result }} state 終了時点の状態
 */
export function buildResultSummary({ gameId, players, missions, settings, startedAt, result }) {
  const history = missions?.history ?? [];
  const entryFor = (index) => history.find((h) => h.index === index);
  const indexes = Array.from({ length: MISSION_COUNT }, (_, i) => i + 1);

  const missionSummaries = indexes.map((index) => {
    const entry = entryFor(index);
    return { index, status: missionStatus(entry), ...countResults(entry?.results ?? {}) };
  });

  const personal = {};
  for (const p of players) {
    personal[p.id] = {
      missions: indexes.map((index) => {
        const entry = entryFor(index);
        const r = entry?.results?.[p.id];
        return {
          index,
          result: r === PERSONAL_RESULT.SUCCESS || r === PERSONAL_RESULT.FAILURE
            ? r
            : r
              ? PERSONAL_RESULT.CANCELLED
              : PERSONAL_RESULT.NOT_PARTICIPATED,
        };
      }),
    };
  }

  return {
    gameId,
    winner: result.winner,
    reason: result.reason,
    headline: headlineFor(result.winner, result.reason),
    durationMin: settings.durationMin,
    playedMs: Math.max(0, result.finishedAt - startedAt),
    zombieMode: settings.zombieMode,
    players: players.map((p) => {
      const caught = p.caughtAt != null && p.originalRole === ROLE.RUNNER;
      return {
        id: p.id,
        name: p.name,
        startRole: p.originalRole,
        finalRole: p.role,
        roleChanged: p.originalRole !== p.role,
        caught,
        // 確保された時刻は「開始から何分台か」だけ（正確な時刻は出さない）
        caughtAfterMin: caught ? Math.floor((p.caughtAt - startedAt) / 60_000) : null,
        captures: p.captures,
        survived: p.originalRole === ROLE.RUNNER && p.role === ROLE.RUNNER && p.status === STATUS.ACTIVE,
      };
    }),
    missions: missionSummaries,
    personal,
  };
}

/** viewerId の人に見せる結果（他人の個人ミッション結果を除く） */
export function resultViewFor(summary, viewerId) {
  if (!summary) return null;
  const { personal, ...shared } = summary;
  return { ...shared, you: viewerId, self: personal[viewerId] ?? null };
}

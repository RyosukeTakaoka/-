// 勝敗の判定（画面から独立したルール）

import { activeRunners } from './player.js';

export const WINNER = Object.freeze({
  RUNNERS: 'runners', // 逃走者側
  HUNTERS: 'hunters', // 鬼側
});

export const FINISH_REASON = Object.freeze({
  TIME_UP: 'time_up', // 制限時間まで逃げ切った
  ALL_CAUGHT: 'all_caught', // 逃走者が全員捕まった
  ABORTED: 'aborted', // ホストが途中で終了した
});

/**
 * 決着がついていれば { winner, reason }、まだなら null。
 * 全員確保を先に判定する（時間切れと同時なら鬼の勝ち）。
 */
export function judgeOutcome({ players, endsAt }, now) {
  if (activeRunners(players).length === 0) {
    return { winner: WINNER.HUNTERS, reason: FINISH_REASON.ALL_CAUGHT };
  }
  if (now >= endsAt) {
    return { winner: WINNER.RUNNERS, reason: FINISH_REASON.TIME_UP };
  }
  return null;
}

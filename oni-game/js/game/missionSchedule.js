// ミッションの発生スケジュール
//
// ゲーム開始時に4回分の発生時刻を決める。発生時刻はゲーム内部だけで持ち、プレイヤーには知らせない。
//
// アルゴリズム（D = ゲーム時間）
//  1. 制限時間 L = D×10%（60秒〜5分、10秒単位）
//  2. 開始直後・終了直前の除外時間 B = D×8%（最低15秒）、ミッション間の最低間隔 C = D×4%（最低15秒）
//  3. 使える時間 U = D - 2B。4L + 3C が U に収まらなければ L を短くする（通常は最短45秒）
//     それでも収まらない短いゲームでは、除外時間15秒・間隔10秒・制限時間最短30秒の詰めた配置にする
//  4. 余り S = U - 4L - 3C を「最初・間3つ・最後」の5か所に配る。
//     半分は均等、半分はランダムに配るので、最低間隔を守りつつ偏りすぎない
//  5. ミッションは重ならない。最後のミッションも終了直前の除外時間より前に終わる

import { secureRandom } from '../utils/random.js';

export const MISSION_COUNT = 4;
export const MIN_LIMIT_MS = 30_000; // 詰めた配置のときの最短の制限時間
const NORMAL_MIN_LIMIT_MS = 45_000;
const MAX_LIMIT_MS = 5 * 60_000;
const MIN_PREFERRED_LIMIT_MS = 60_000;
const MIN_BUFFER_MS = 15_000;
const MIN_GAP_MS = 15_000;
const COMPACT_GAP_MS = 10_000;
const STEP_MS = 10_000;

const floorTo = (ms, step) => Math.floor(ms / step) * step;

function layout(durationMs, bufferMs, gapMs, minLimitMs) {
  const usableMs = durationMs - 2 * bufferMs;
  const preferred = Math.min(MAX_LIMIT_MS, Math.max(MIN_PREFERRED_LIMIT_MS, floorTo(durationMs * 0.1, STEP_MS)));
  // ランダムに配れる余りを 25% 以上残せる長さまで短くする
  const fitting = floorTo(((usableMs - (MISSION_COUNT - 1) * gapMs) * 0.75) / MISSION_COUNT, STEP_MS);
  const limitMs = Math.max(minLimitMs, Math.min(preferred, fitting));
  const slackMs = usableMs - MISSION_COUNT * limitMs - (MISSION_COUNT - 1) * gapMs;
  return { limitMs, bufferMs, gapMs, slackMs };
}

/** ゲーム時間から、制限時間・除外時間・最低間隔を決める（4回入らなければエラー） */
export function missionTiming(durationMs) {
  const normal = layout(
    durationMs,
    Math.max(MIN_BUFFER_MS, Math.round(durationMs * 0.08)),
    Math.max(MIN_GAP_MS, Math.round(durationMs * 0.04)),
    NORMAL_MIN_LIMIT_MS,
  );
  if (normal.slackMs >= 0) return normal;
  const compact = layout(durationMs, MIN_BUFFER_MS, COMPACT_GAP_MS, MIN_LIMIT_MS);
  if (compact.slackMs >= 0) return compact;
  throw new Error('ゲーム時間が短すぎて、ミッションを4回入れられません');
}

/**
 * 4回分のスケジュールを作る。
 * @returns {{ index: number, offsetMs: number, limitMs: number }[]} offsetMs はゲーム開始からの時間
 */
export function generateMissionSchedule(durationMs, rng = secureRandom) {
  const { limitMs, bufferMs, gapMs, slackMs } = missionTiming(durationMs);
  const parts = MISSION_COUNT + 1;
  const weights = Array.from({ length: parts }, () => -Math.log(1 - rng() * 0.999999)); // 指数分布 → 正規化で一様な分割
  const total = weights.reduce((a, b) => a + b, 0);
  const shares = weights.map((w) => slackMs * (0.5 / parts + 0.5 * (w / total)));

  const schedule = [];
  let t = bufferMs + shares[0];
  for (let i = 0; i < MISSION_COUNT; i++) {
    schedule.push({ index: i + 1, offsetMs: Math.round(t), limitMs });
    t += limitMs + gapMs + shares[i + 1];
  }
  return schedule;
}

// 逃走者の位置ぼかし精度（blurM）の段階と、ミッション結果による変更ルール
//
// blurM = 鬼に見える可能性エリアの半径。大きいほど鬼には分かりにくい。
// 値を調整するときは、このファイルの定数だけを変えればよい。
//
// ■ 段階: 50 / 100 / 150 / 200 / 300 / 400 / 500 / 750 / 1000 m
//   - 初期ぼかしの選択肢（settings.js の BLUR_OPTIONS_M）はすべてこの段階に含める
//   - 1段階の変化はおよそ 1.3〜2 倍。4回のミッションで最大 ±4 段階
//     （例: 初期 300m（9段階の真ん中）→ 全部成功で 1000m、全部失敗で 50m）
//   - 下限 50m: GPS の誤差（10〜20m）を考えると、これより小さい円は実位置に近すぎる
//   - 上限 1000m
// ■ 変更ルール: 成功 → 1段階大きく / 失敗 → 1段階小さく / それ以外（無効など） → 変えない

import { MISSION_RESULT } from './player.js';

export const BLUR_LEVELS_M = Object.freeze([50, 100, 150, 200, 300, 400, 500, 750, 1000]);
export const MIN_BLUR_M = BLUR_LEVELS_M[0];
export const MAX_BLUR_M = BLUR_LEVELS_M[BLUR_LEVELS_M.length - 1];

/** 成功・失敗で何段階動かすか（+ で大きく、- で小さく） */
export const LEVEL_CHANGE = Object.freeze({
  [MISSION_RESULT.SUCCESS]: +1,
  [MISSION_RESULT.FAILURE]: -1,
});

/** blurM がどの段階か（段階の値でなければ一番近い段階） */
export function blurLevelIndex(blurM) {
  let best = 0;
  for (let i = 1; i < BLUR_LEVELS_M.length; i++) {
    if (Math.abs(BLUR_LEVELS_M[i] - blurM) < Math.abs(BLUR_LEVELS_M[best] - blurM)) best = i;
  }
  return best;
}

/** steps 段階動かした blurM（上限・下限で止まる） */
export function shiftBlurLevel(blurM, steps) {
  const index = Math.min(BLUR_LEVELS_M.length - 1, Math.max(0, blurLevelIndex(blurM) + steps));
  return BLUR_LEVELS_M[index];
}

/** ミッション結果を反映した blurM（成功・失敗以外は変えない） */
export function blurAfterMission(blurM, result) {
  const steps = LEVEL_CHANGE[result];
  if (steps == null || !(blurM > 0)) return blurM;
  return shiftBlurLevel(blurM, steps);
}

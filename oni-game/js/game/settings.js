// ゲーム設定の選択肢・初期値・検証

export const DURATION_OPTIONS_MIN = [5, 10, 20, 30, 60];
export const RADIUS_OPTIONS_M = [100, 300, 500, 1000, 3000, 5000];
export const BLUR_OPTIONS_M = [50, 100, 300, 500, 1000];
export const CAPTURE_RADIUS_OPTIONS_M = [5, 10, 20, 30];
export const REVEAL_INTERVAL_OPTIONS_SEC = [30, 60, 120, 180, 300];
export const MIN_HUNTERS = 1;
export const MAX_HUNTERS = 10;

export const DEFAULT_SETTINGS = Object.freeze({
  durationMin: 10, // ゲーム時間（分）
  radiusM: 300, // ゲームエリア半径（m）
  initialBlurM: 300, // 初期の位置情報ぼかし精度（m）
  hunterCount: 1, // 鬼の人数
  captureRadiusM: 10, // 鬼が逃走者を確保できる距離（m）
  zombieMode: false, // 増え鬼: ON なら捕まった逃走者が鬼になる / OFF なら脱落
  revealIntervalSec: 60, // 逃走者の可能性エリアが更新・公開される間隔（秒）
  showHuntersToRunners: true, // 鬼の位置を逃走者（と脱落者）に見せるか
});

const pick = (value, options, fallback) => (options.includes(Number(value)) ? Number(value) : fallback);

/** 入力を検証して、正しい設定オブジェクトを返す（不正な値は現在値のまま） */
export function sanitizeSettings(input = {}, current = DEFAULT_SETTINGS) {
  const hunters = Math.round(Number(input.hunterCount ?? current.hunterCount));
  return {
    durationMin: pick(input.durationMin ?? current.durationMin, DURATION_OPTIONS_MIN, current.durationMin),
    radiusM: pick(input.radiusM ?? current.radiusM, RADIUS_OPTIONS_M, current.radiusM),
    initialBlurM: pick(input.initialBlurM ?? current.initialBlurM, BLUR_OPTIONS_M, current.initialBlurM),
    hunterCount: Number.isFinite(hunters)
      ? Math.min(MAX_HUNTERS, Math.max(MIN_HUNTERS, hunters))
      : current.hunterCount,
    captureRadiusM: pick(
      input.captureRadiusM ?? current.captureRadiusM,
      CAPTURE_RADIUS_OPTIONS_M,
      current.captureRadiusM,
    ),
    zombieMode: typeof input.zombieMode === 'boolean' ? input.zombieMode : current.zombieMode,
    revealIntervalSec: pick(
      input.revealIntervalSec ?? current.revealIntervalSec,
      REVEAL_INTERVAL_OPTIONS_SEC,
      current.revealIntervalSec,
    ),
    showHuntersToRunners:
      typeof input.showHuntersToRunners === 'boolean' ? input.showHuntersToRunners : current.showHuntersToRunners,
  };
}

/** ぼかし半径がエリアより大きすぎないか等、組み合わせのチェック。警告文の配列を返す */
export function settingsWarnings(settings) {
  const warnings = [];
  if (settings.initialBlurM > settings.radiusM) {
    warnings.push('ぼかし精度がゲームエリアより大きいため、鬼にはほぼ位置が分かりません');
  }
  return warnings;
}

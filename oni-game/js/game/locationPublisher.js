// 可能性エリアの公開スケジュール
//
// - 公開は「公開回数(epoch) = 経過時間 ÷ 公開間隔」が増えたときだけ行う
// - 同じ公開回数の間は、GPS が更新されても公開済みの可能性エリアを変えない
// - 公開前に位置が分かっていなかった逃走者は、最初に位置が届いたときに1回だけ公開する
//
// state.privacy（内部用。鬼の端末には渡さない）
//   secrets:   { [runnerId]: 秘密の値 }  … privacyArea.js 用
//   cells:     { [runnerId]: 前回のマス } … privacyArea.js 用
//   published: { [runnerId]: { center, radiusM, epoch, publishedAt } } … これだけがビューに出る
//   epoch:     最後に公開した公開回数

import { computePossibleArea, createPrivacySecret } from '../map/privacyArea.js';
import { activeRunners } from './player.js';
import { secureRandom } from '../utils/random.js';

export function emptyPrivacy() {
  return { secrets: {}, cells: {}, published: {}, epoch: -1 };
}

/** ゲーム開始時: 逃走者ごとの秘密の値を作る（増え鬼などで役割が変わっても使えるよう全員分） */
export function initPrivacy(players, rng = secureRandom) {
  const secrets = {};
  for (const p of players) secrets[p.id] = createPrivacySecret(rng);
  return { ...emptyPrivacy(), secrets };
}

const intervalMs = (settings) => settings.revealIntervalSec * 1000;

/** 開始からの公開回数（0, 1, 2, ...） */
export function revealEpoch(now, startedAt, settings) {
  return Math.max(0, Math.floor((now - startedAt) / intervalMs(settings)));
}

/** 次に公開される時刻 */
export function nextRevealAt(now, startedAt, settings) {
  return startedAt + (revealEpoch(now, startedAt, settings) + 1) * intervalMs(settings);
}

function publishOne(state, privacy, runner, epoch, now) {
  const position = state.positions[runner.id];
  const secret = privacy.secrets[runner.id];
  if (!position || !secret || !(runner.blurM > 0)) return privacy;
  const { center, radiusM, cell } = computePossibleArea({
    position,
    blurM: runner.blurM,
    secret,
    epoch,
    origin: state.area.center,
    previousCell: privacy.cells[runner.id] ?? null,
  });
  return {
    ...privacy,
    cells: { ...privacy.cells, [runner.id]: cell },
    published: { ...privacy.published, [runner.id]: { center, radiusM, epoch, publishedAt: now } },
  };
}

/**
 * 公開タイミングなら全逃走者の可能性エリアを作り直す。
 * @returns {{ privacy: object, revealed: boolean }}
 */
export function publishIfDue(state, now) {
  const epoch = revealEpoch(now, state.startedAt, state.settings);
  if (epoch <= state.privacy.epoch) return { privacy: state.privacy, revealed: false };
  let privacy = { ...state.privacy, published: {}, epoch };
  for (const runner of activeRunners(state.players)) privacy = publishOne(state, privacy, runner, epoch, now);
  return { privacy, revealed: true };
}

/** まだ公開されていない逃走者（開始時に位置が無かった人）を公開する */
export function publishMissing(state, now) {
  let privacy = state.privacy;
  for (const runner of activeRunners(state.players)) {
    if (!privacy.published[runner.id]) privacy = publishOne(state, privacy, runner, privacy.epoch, now);
  }
  return privacy;
}

/** 確保された逃走者の公開情報を消す（脱落・鬼になった人の円は出さない） */
export function withdraw(privacy, playerId) {
  const { [playerId]: _published, ...published } = privacy.published;
  const { [playerId]: _cell, ...cells } = privacy.cells;
  return { ...privacy, published, cells };
}
